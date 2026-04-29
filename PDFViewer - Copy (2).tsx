// ─────────────────────────────────────────────────────────────────────────────
// PDFViewer — native pdfjs-dist engine
//
// HIGHLIGHT STRATEGY (final, correct approach):
//   Highlights are drawn INSIDE the pdfjs 'pagerendered' event handler.
//   At that moment we have:
//     • pv.div       — the page DOM element (guaranteed live)
//     • pv.viewport  — real CSS pixel dimensions (no clientWidth needed)
//     • pv.canvas    — the rendered pdfjs canvas (guaranteed painted)
//   We create one overlay <canvas> per page div and draw into it immediately.
//   When pdfjs re-renders a page (zoom, scroll-back), pagerendered fires again
//   and we re-draw — highlights always match the current page state.
//
//   Store changes (new capture, active field change) → drawAllVisible()
//   which re-draws all currently rendered pages by iterating pdfjs page views.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  EventBus, PDFViewer as PdfjsPDFViewer,
  PDFLinkService, PDFFindController,
  GenericL10n,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import { useAppStore } from '../store/appStore';
import type { PDFAdapter } from '../adapters/PDFAdapter';
import { colorToRgba, stripPunct } from '../utils/color';
import { clearPdfTextCache } from '../hooks/useBoxCapture';
import { InMemoryCMapReaderFactory, InMemoryStandardFontDataFactory } from '../utils/pdfResourceCache';
import type { CaptureItem, WordEntry } from '../adapters/types';

// ── pdfjs setup ───────────────────────────────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('pdfjs-viewer-css')) {
  const link = document.createElement('link');
  link.id = 'pdfjs-viewer-css'; link.rel = 'stylesheet'; link.href = '/pdf_viewer.css';
  document.head.appendChild(link);
}
// ── PDF worker setup ─────────────────────────────────────────────────────────
// ECS/OpenShift blocks ES-module dynamic import() inside blob: URLs.
// Fix: fetch the worker script once, wrap as a classic-script blob,
// set workerSrc synchronously so the first getDocument() call can use it.
// Falls back to the direct URL if fetch fails.
const _workerSrc = '/pdf.worker.min.mjs';

// Set workerSrc to the direct absolute URL.
// The "fake worker" warning in ECS is cosmetic — pdfjs still creates the worker
// correctly because the file returns 200. The warning occurs because pdfjs
// tries module worker creation which may log a warning in strict CSP, but
// falls back successfully to the working URL.
const _workerAbsUrl = new URL(_workerSrc, document.baseURI).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = _workerAbsUrl;

export const workerReadyPromise: Promise<void> = Promise.resolve();
// Canvas pixel cap — balance between quality and render speed.
// At DPR=2, page-fit A4 ≈ 0.9MP, page-width ≈ 3.6MP, 150% zoom ≈ 5.5MP.
// 10MP covers page-width + moderate zoom on retina without excessive GPU cost.
const MAX_CANVAS_PIXELS = 10_485_760; // 10MP

// Cap devicePixelRatio at 2 to avoid 4x render cost on high-DPI displays.
// DPR=3 gives marginal sharpness improvement but 2.25x more pixels to render.
if (typeof window !== 'undefined' && window.devicePixelRatio > 2) {
  try { Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true }); } catch (_) {}
}

// ── CSS pulse animation ───────────────────────────────────────────────────────
let _cssInjected = false;
function injectPulseCSS() {
  if (_cssInjected || typeof document === 'undefined') return;
  _cssInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    @keyframes tov-pulse{0%,100%{opacity:.3;box-shadow:0 0 6px 2px rgba(6,182,212,.4);}50%{opacity:.6;box-shadow:0 0 14px 5px rgba(6,182,212,.7);}}
    .tov-pulse-box{position:absolute;border-radius:3px;pointer-events:none;z-index:20;
      border:2px solid rgba(6,182,212,.9);background:rgba(6,182,212,.12);
      animation:tov-pulse 1.2s ease-in-out infinite;}
  `;
  document.head.appendChild(s);
}

// ── Core drawing ──────────────────────────────────────────────────────────────
const RADIUS = 2.5;
type Ctx2D = CanvasRenderingContext2D;

function rr(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  if (w < 1 || h < 1) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); ctx.closePath();
}

interface DrawState {
  captures:       CaptureItem[];
  activeFieldId:  string | null;
  highlightIndex: Map<number, Array<{x:number;y:number;width:number;height:number;id:string;color?:string;type?:'external'}>>;
  wordIndex:      Map<number, WordEntry[]>;
  previewRect:    {page:number;x:number;y:number;width:number;height:number} | null;
  searchResults:  Array<{page:number;x:number;y:number;width:number;height:number}>;
  searchCurrent:  number;
  searchHighAll:  boolean;
}

interface DrawCaches {
  fwc:    Map<string,string>;          // fieldId → stripped word
  cgc:    Array<{fill:string;stroke:string;ids:string[]}>;
  l3c:    Map<number,Map<string,Array<{x:number;y:number;w:number;h:number}>>>;
  awt:    string;                      // active field word text
  l3Key:  string;
}

function rebuildCaches(ds: DrawState, caches: DrawCaches) {
  // Use object identity — captures array is replaced on every addCapture/delete
  // so reference check is O(1) and avoids the O(n log n) sort+join
  // Fast key: concatenate id:value pairs without sort — order is stable (Zustand append-only)
  // Cache key includes wordIndex size so l3c is rebuilt when wordIndex
  // loads after captures are already set (the common real-world flow:
  // user opens PDF → drops captured_fields JSON → drops word_index JSON).
  const capturesRef = ds.captures.map(c=>`${c.id}:${c.value}`).join(',')
                    + '|wi:' + ds.wordIndex.size;
  if (capturesRef !== caches.l3Key) {
    caches.l3Key = capturesRef;
    caches.fwc.clear();
    // Use exact lowercase for capture-vs-capture duplicate detection.
    // stripPunct would make "LEADTOOLS" === "LEADTOOLS®" — wrong.
    for (const c of ds.captures) caches.fwc.set(c.id, c.value.toLowerCase().trim());
    caches.l3c.clear();
    if (ds.wordIndex.size > 0) {
      const watch = new Set<string>();
      for (const wt of caches.fwc.values()) if (wt) watch.add(wt);
      for (const [pg, entries] of ds.wordIndex) {
        const pm = new Map<string,Array<{x:number;y:number;w:number;h:number}>>();
        // Guard: entries must be an array — if not, the wordIndex was built incorrectly
        if (!Array.isArray(entries)) {
          console.error('[rebuildCaches] wordIndex page', pg, 'has non-array entries:', typeof entries, entries);
          continue; // skip this page rather than crash
        }
        for (const e of entries) {
          const wt = stripPunct(e.text); if (!watch.has(wt)) continue;
          if (!pm.has(wt)) pm.set(wt, []);
          pm.get(wt)!.push({x:e.x,y:e.y,w:e.width,h:e.height});
        }
        if (pm.size) caches.l3c.set(pg, pm);
      }
    }
  }
  // Always rebuild color groups (active field changes need this)
  const groups = new Map<string,{fill:string;stroke:string;ids:string[]}>();
  for (const c of ds.captures) {
    if (c.id === ds.activeFieldId) continue;
    const key = c.color ?? '__default__';
    if (!groups.has(key)) groups.set(key, {
      fill:   c.color ? colorToRgba(c.color, .10) : 'rgba(150,150,150,.10)',
      stroke: c.color ? colorToRgba(c.color, .90) : 'rgba(100,100,100,.85)', ids: [],
    });
    groups.get(key)!.ids.push(c.id);
  }
  caches.cgc = Array.from(groups.values());
  caches.awt = ds.activeFieldId ? (caches.fwc.get(ds.activeFieldId) ?? '') : '';
}

// Draw highlights onto a canvas.
// W, H = CSS display pixels (from pdfjs viewport — correct coordinate space)
// pageDiv: the page DOM element — used to scan text layer for word occurrences
//          when no word_index is loaded (PDF with native text layer).
function paintPage(ctx: Ctx2D, W: number, H: number, page: number,
  ds: DrawState, caches: DrawCaches, pageDiv?: HTMLElement) {
  ctx.clearRect(0, 0, W, H);

  const rects  = ds.highlightIndex.get(page) ?? [];
  const aid    = ds.activeFieldId;
  const aTxt   = aid ? (caches.fwc.get(aid) ?? '') : '';
  const hasWI  = ds.wordIndex.size > 0;

  // Search highlights
  const sr = ds.searchResults.filter(r => r.page === page);
  for (let i = 0; i < sr.length; i++) {
    const r = sr[i];
    const isCur = ds.searchResults.indexOf(r) === ds.searchCurrent;
    ctx.save();
    if (isCur) {
      ctx.fillStyle='rgba(255,140,0,.45)'; ctx.strokeStyle='rgba(255,100,0,.95)';
      ctx.lineWidth=2; ctx.shadowColor='rgba(255,140,0,.5)'; ctx.shadowBlur=6;
    } else if (ds.searchHighAll) {
      ctx.fillStyle='rgba(255,220,50,.28)'; ctx.strokeStyle='rgba(200,160,0,.65)'; ctx.lineWidth=1;
    } else { ctx.restore(); continue; }
    rr(ctx, r.x*W, r.y*H, r.width*W, r.height*H, RADIUS);
    ctx.fill(); ctx.stroke(); ctx.restore();
  }

  // Captured boxes
  for (const rect of rects) {
    const isAct = rect.id === aid;
    const isDup = !isAct && !!aTxt && (caches.fwc.get(rect.id)??'') === aTxt;
    ctx.save();
    if (isAct) {
      ctx.shadowColor='rgba(220,180,0,.5)'; ctx.shadowBlur=8;
      ctx.fillStyle='rgba(255,230,0,.35)'; ctx.strokeStyle='rgb(200,160,0)'; ctx.lineWidth=2.5;
    } else if (isDup) {
      ctx.fillStyle='rgba(255,182,193,.4)'; ctx.strokeStyle='rgba(220,80,120,.85)'; ctx.lineWidth=2;
    } else if (rect.type==='external') {
      ctx.fillStyle='rgba(139,92,246,.22)'; ctx.strokeStyle='rgba(139,92,246,.85)'; ctx.lineWidth=1.5;
    } else if (rect.color) {
      // Low fill opacity so text inside is fully readable; bold border shows the color clearly
      ctx.fillStyle=colorToRgba(rect.color,.07); ctx.strokeStyle=colorToRgba(rect.color,.95); ctx.lineWidth=2.5;
    } else {
      ctx.fillStyle='rgba(150,150,150,.10)'; ctx.strokeStyle='rgba(80,80,80,.90)'; ctx.lineWidth=2.0;
    }
    rr(ctx, rect.x*W, rect.y*H, rect.width*W, rect.height*H, RADIUS);
    ctx.fill(); ctx.stroke(); ctx.restore();
  }

  // ── Word occurrences ──────────────────────────────────────────────────────
  // Show word occurrence highlights for ALL captures (grey when inactive, pink for active word)
  // Build skip set from already-drawn confirmed capture rects (avoid double-drawing)
  const skip = new Set<number>();
  for (const r of rects) skip.add(Math.round(r.x*1000)*10000+Math.round(r.y*1000));

  if (hasWI) {
    // PATH A: word_index loaded — use pre-built position cache (fast, no DOM)
    const pl3 = caches.l3c.get(page);
    const occ = (wt:string, fill:string, stroke:string, lw:number) => {
      const es = pl3?.get(wt); if (!es?.length) return;
      ctx.fillStyle=fill; ctx.strokeStyle=stroke; ctx.lineWidth=lw;
      for (const e of es) {
        const k = Math.round(e.x*1000)*10000+Math.round(e.y*1000);
        if (skip.has(k)) continue; skip.add(k);
        rr(ctx, e.x*W, e.y*H, e.w*W, e.h*H, RADIUS); ctx.fill(); ctx.stroke();
      }
    };
    for (const g of caches.cgc) for (const id of g.ids) {
      const wt = caches.fwc.get(id) ?? ''; if (wt) occ(wt, g.fill, g.stroke, 1.2);
    }
    if (caches.awt) occ(caches.awt,'rgba(255,182,193,.4)','rgba(220,80,120,.8)',1.5);

  } else if (pageDiv) {
    // PATH B: no word_index — scan pdfjs text layer spans.
    // Draws grey for other captures' words and pink for the active word.
    const textLayer = pageDiv.querySelector<HTMLElement>('.textLayer');
    if (!textLayer) return;
    const pageRect = pageDiv.getBoundingClientRect();
    const pW = pageRect.width  || W;
    const pH = pageRect.height || H;
    const spans = textLayer.querySelectorAll<HTMLElement>('span');

    // Build lookup: word → {fill, stroke, lw} — other captures in grey, active in pink
    const needles = new Map<string, {fill:string; stroke:string; lw:number}>();
    for (const g of caches.cgc) {
      for (const id of g.ids) {
        const wt = caches.fwc.get(id) ?? ''; if (!wt) continue;
        if (!needles.has(wt)) needles.set(wt, {fill:g.fill, stroke:g.stroke, lw:1.2});
      }
    }
    if (caches.awt) needles.set(caches.awt, {fill:'rgba(255,182,193,.35)', stroke:'rgba(220,80,120,.75)', lw:1.5});

    if (!needles.size) return;

    for (const span of spans) {
      const txt = span.textContent?.trim().toLowerCase() ?? '';
      if (!txt) continue;
      const match = needles.get(txt);
      if (!match) continue;

      const sr2 = span.getBoundingClientRect();
      if (sr2.width < 1 || sr2.height < 1) continue;

      const fx = (sr2.left - pageRect.left) / pW;
      const fy = (sr2.top  - pageRect.top)  / pH;
      const fw = sr2.width  / pW;
      const fh = sr2.height / pH;

      const k = Math.round(fx*1000)*10000+Math.round(fy*1000);
      if (skip.has(k)) continue; skip.add(k);

      ctx.fillStyle=match.fill; ctx.strokeStyle=match.stroke; ctx.lineWidth=match.lw;
      rr(ctx, fx*W, fy*H, fw*W, fh*H, RADIUS);
      ctx.fill(); ctx.stroke();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export function PDFViewer({
  file, adapter, zoom,
}: { file: File; adapter: PDFAdapter; zoom: number }) {
  injectPulseCSS();

  const setCurrentPage = useAppStore(s => s.setCurrentPage);
  const rotation       = useAppStore(s => s.rotation);
  const wordIndex      = useAppStore(s => s.wordIndex);
  const hasWordIndex   = wordIndex.size > 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerDivRef = useRef<HTMLDivElement>(null);
  const viewerRef    = useRef<PdfjsPDFViewer | null>(null);
  const eventBusRef  = useRef<EventBus | null>(null);
  const blobUrlRef   = useRef<string | null>(null);
  const didInit      = useRef(false);
  const zoomRef      = useRef(zoom);

  // Highlight state — kept in a ref so the pagerendered handler always has latest
  const dsRef     = useRef<DrawState>({
    captures: [], activeFieldId: null,
    highlightIndex: new Map(), wordIndex: new Map(),
    previewRect: null, searchResults: [], searchCurrent: 0, searchHighAll: false,
  });
  const cachesRef = useRef<DrawCaches>({
    fwc: new Map(), cgc: [], l3c: new Map(), awt: '', l3Key: '',
  });
  // Overlay canvases keyed by page number
  const overlayMap = useRef(new Map<number, HTMLCanvasElement>());
  // Pulse div
  const pulseRef   = useRef<HTMLDivElement | null>(null);
  // Stable refs for draw functions — ensures subscription always calls latest
  const drawAllRef  = useRef<() => void>(() => {});
  const snapRef     = useRef<() => void>(() => {});

  // ── Snap store → dsRef ────────────────────────────────────────────────────
  function snapStore() {
    const s = useAppStore.getState();
    const prev = dsRef.current;
    const capturesChanged  = s.captures    !== prev.captures;
    const wordIndexChanged = s.wordIndex   !== prev.wordIndex;

    dsRef.current = {
      captures:      s.captures,
      activeFieldId: s.activeFieldId,
      highlightIndex:s.highlightIndex,
      wordIndex:     s.wordIndex,
      previewRect:   s.previewRect,
      searchResults: s.search.results,
      searchCurrent: s.search.currentIndex,
      searchHighAll: s.search.highlightAll,
    };
    // rebuildCaches does expensive l3c iteration over all wordIndex pages.
    // Only call it when captures or wordIndex actually changed.
    // previewRect, activeFieldId, search changes only need a redraw, not a cache rebuild.
    if (capturesChanged || wordIndexChanged) {
      rebuildCaches(dsRef.current, cachesRef.current);
    } else {
      // Fast path: just update awt (active word text) for highlight colour changes
      const aid = s.activeFieldId;
      cachesRef.current.awt = aid ? (cachesRef.current.fwc.get(aid) ?? '') : '';
    }
  }

  // ── Draw one page overlay ─────────────────────────────────────────────────
  // pageDiv: the pdfjs .page div
  // W, H:   CSS display pixels from pdfjs viewport (accurate, no clientWidth)
  function drawPageOverlay(pageNum: number, pageDiv: HTMLElement, W: number, H: number) {
    const ds = dsRef.current;
    const hasCap  = (ds.highlightIndex.get(pageNum)?.length ?? 0) > 0;
    const hasSrch = ds.searchResults.some(r => r.page === pageNum);
    const hasWI   = ds.wordIndex.size > 0; // word index present — show word occurrences

    // Remove overlay if nothing to draw
    if (!hasCap && !hasSrch && !hasWI) {
      const ex = overlayMap.current.get(pageNum);
      if (ex) { ex.remove(); overlayMap.current.delete(pageNum); }
      updatePulse();
      return;
    }

    // Get or create overlay canvas
    let oc = overlayMap.current.get(pageNum);
    if (oc && !oc.isConnected) {
      // pdfjs destroyed and re-created the page div — our canvas is orphaned
      oc.remove();
      overlayMap.current.delete(pageNum);
      oc = undefined;
    }
    if (!oc) {
      oc = document.createElement('canvas');
      oc.dataset.hlCanvas = '1';
      oc.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:11;';
      pageDiv.style.position = 'relative';
      pageDiv.appendChild(oc);
      overlayMap.current.set(pageNum, oc);
    }

    const iW = Math.round(W), iH = Math.round(H);
    if (oc.width !== iW || oc.height !== iH) {
      oc.width = iW; oc.height = iH;
    }

    paintPage(oc.getContext('2d')!, iW, iH, pageNum, ds, cachesRef.current, pageDiv);
    updatePulse();
  }

  // ── Redraw all currently rendered pages ───────────────────────────────────
  // Iterates ALL pdfjs page views that have a div in the DOM.
  // pv.canvas can be null for virtualized pages (pdfjs evicts it when off-screen).
  // We use pv.div + pv.viewport — div persists, viewport always has dimensions.
  function drawAllVisible() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const n = viewer.pagesCount || 0;
    for (let i = 0; i < n; i++) {
      const pv = viewer.getPageView(i);
      // pv.div exists for all pages; pv.canvas only for rendered ones.
      // We can draw on any page that has a div — the overlay canvas persists
      // independently of the pdfjs canvas.
      if (!pv?.div || !pv.viewport) continue;
      const vp = pv.viewport;
      drawPageOverlay(i + 1, pv.div, vp.width, vp.height);
    }
    updatePulse();
  }

  // ── CSS pulse overlay ─────────────────────────────────────────────────────
  function updatePulse() {
    const pr = dsRef.current.previewRect;
    if (!pr) { pulseRef.current?.remove(); pulseRef.current = null; return; }

    const viewer = viewerRef.current;
    if (!viewer) return;
    const pv = viewer.getPageView(pr.page - 1);
    if (!pv?.div) return;
    const vp = pv.viewport;
    const W = vp.width, H = vp.height;

    if (!pulseRef.current) {
      pulseRef.current = document.createElement('div');
      pulseRef.current.className = 'tov-pulse-box';
    }
    if (pulseRef.current.parentElement !== pv.div) {
      pv.div.style.position = 'relative';
      pv.div.appendChild(pulseRef.current);
    }
    const d = pulseRef.current;
    d.style.left   = (pr.x * W).toFixed(1) + 'px';
    d.style.top    = (pr.y * H).toFixed(1) + 'px';
    d.style.width  = (pr.width  * W).toFixed(1) + 'px';
    d.style.height = (pr.height * H).toFixed(1) + 'px';
  }

  // ── pdfjs init (runs once per file) ──────────────────────────────────────
  useEffect(() => {
    if (didInit.current) return;
    const container = containerRef.current;
    const viewerDiv = viewerDivRef.current;
    if (!container || !viewerDiv) return;
    didInit.current = true;

    const eventBus = new EventBus();
    eventBusRef.current = eventBus;
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 });
    const findController = new PDFFindController({ linkService, eventBus });

    // Read zoomMode at viewer creation time to set pdfjs default
    const initialZoomMode = useAppStore.getState().zoomMode;
    const defaultZoomValue =
      initialZoomMode === 'page-fit'   ? 'page-fit'   :
      initialZoomMode === 'page-width' ? 'page-width' :
      initialZoomMode === 'actual'     ? 'page-actual':
      String(useAppStore.getState().zoom);

    const pdfViewer = new PdfjsPDFViewer({
      container, viewer: viewerDiv, eventBus, linkService, findController,
      textLayerMode:     0,                // disabled — box capture uses pdfjs getTextContent directly
                                            // text layer adds 40-80% render overhead per page
      annotationMode:    0,                // disabled — saves memory
      removePageBorders: true,
      maxCanvasPixels:   MAX_CANVAS_PIXELS,
      l10n:              new (GenericL10n as any)('en'),
      ...({ defaultZoomValue } as any),  // pdfjs runtime option, not in TS types
    });
    // Page rendering cache — larger = fewer re-renders.
    // Heavy PDFs with images/fonts take longest to render first time;
    // caching ensures back-navigation is always instant.
    // 60 pages × ~3MB = ~180MB — acceptable for heavy document use.
    try { (pdfViewer as any)._buffer?.resize(60); } catch {}
    viewerRef.current = pdfViewer;
    linkService.setViewer(pdfViewer);

    // pagechanging fires during setDocument init and during user navigation.
    // We suppress spinner during initial load (before pagesloaded fires) using
    // a flag — only user-initiated navigation after load should trigger spinner.
    let docFullyLoaded = false;

    eventBus.on('pagechanging', (evt: any) => {
      if (!viewerRef.current?.pagesCount) return;
      const newPage = evt.pageNumber;
      // Always update the page counter
      setCurrentPage(newPage);
      // Only show/hide spinner after initial load is complete
      if (!docFullyLoaded) return;
      if (!renderedPages.has(newPage)) {
        useAppStore.getState().setRenderProgress(1);
      } else {
        // Already rendered — clear spinner immediately
        useAppStore.getState().setRenderProgress(0);
      }
    });

    // ── PAGE RENDERED — draw highlights immediately ────────────────────────
    // renderedPages tracks which pages have been rendered in the CURRENT load.
    // Declared here (outside getDocument promise) so pagechanging handler
    // can read it before the promise resolves.
    const renderedPages = new Set<number>();

    eventBus.on('pagerendered', (evt: any) => {
      const pageNum = evt.pageNumber as number;
      renderedPages.add(pageNum);
      // Only clear spinner if THIS is the current page being waited on
      const state = useAppStore.getState();
      if (pageNum === state.currentPage && state.renderProgress > 0) {
        useAppStore.getState().setRenderProgress(100);
        setTimeout(() => useAppStore.getState().setRenderProgress(0), 500);
      }
      const pv = pdfViewer.getPageView(pageNum - 1);
      if (!pv?.div) return;

      // Tag the page div for box capture and adapter
      pv.div.dataset.pageNumber = String(pageNum);
      adapter.registerPageElement(pageNum, pv.div);
      adapter.onPageRenderSuccess(pageNum);

      // Hide text layer when word_index is loaded
      if (hasWordIndex) {
        const tl = pv.div.querySelector('.textLayer') as HTMLElement | null;
        if (tl) { tl.style.pointerEvents = 'none'; tl.style.opacity = '0'; }
      }

      // Draw highlights — deferred 1 rAF so pdfjs finishes painting first
      const vp = pv.viewport;
      snapStore(); // ensure latest state (fast path — no l3c rebuild if unchanged)
      // requestAnimationFrame defers overlay drawing until pdfjs canvas paint completes
      requestAnimationFrame(() => {
        drawPageOverlay(pageNum, pv.div, vp.width, vp.height);
      });
    });

    // Find results — only update store from pdfjs when word_index is NOT loaded.
    // When word_index IS loaded, our runSearch() populates results with correct
    // fractional coords from the word_index Map. pdfjs find count is irrelevant.
    eventBus.on('updatefindmatchescount', (evt: any) => {
      if (useAppStore.getState().wordIndex.size > 0) return; // word_index takes over
      const total   = evt.matchesCount?.total   ?? 0;
      const current = evt.matchesCount?.current ?? 1;
      useAppStore.setState(s => ({
        search: { ...s.search,
          results: Array.from({length: total}, ()=>({page:1,x:0,y:0,width:0,height:0,text:''})),
          currentIndex: Math.max(0, current - 1) },
      }));
    });

    eventBus.on('updatefindcontrolstate', (evt: any) => {
      if (useAppStore.getState().wordIndex.size > 0) return;
      if (evt.state === 1) {
        useAppStore.setState(s => ({ search: { ...s.search, results: [], currentIndex: -1 } }));
      }
    });

    // Load document
    // If file has __rawBuffer (loaded via openFileBuffer from parent postMessage),
    // pass the ArrayBuffer directly to pdfjs — avoids blob URL creation and
    // an extra file read. Falls back to blob URL for normally opened files.
    const rawBuf = (file as any).__rawBuffer as ArrayBuffer | undefined;
    let url: string | null = null;
    let loadCancelled = false;

    const pdfjsSource = rawBuf && rawBuf.byteLength > 0
      ? { data: rawBuf.slice(0),
          // Custom in-memory factories — serve fonts/cmaps from RAM, zero network fetches
          CMapReaderFactory:        InMemoryCMapReaderFactory,
          StandardFontDataFactory:  InMemoryStandardFontDataFactory,
          cMapPacked: true,
          // PDF data is fully in memory — disable all network fetching
          disableAutoFetch: true,
          disableStream:    true,
          isEvalSupported:  true,   // JIT font programs — faster rendering
          useSystemFonts:   false,  // embedded fonts only — no system font mixing
          stopAtErrors:     false,
        }
      : (() => {
          url = URL.createObjectURL(file);
          blobUrlRef.current = url;
          return { url, cMapUrl: '/cmaps/', cMapPacked: true, standardFontDataUrl: '/standard_fonts/' };
        })();

    // Wait for worker blob to be ready before opening any document
    workerReadyPromise.then(() => {
    pdfjsLib.getDocument(pdfjsSource)
      .promise.then(async doc => {
        if (loadCancelled) { doc.destroy(); return; }
        // Set pageCount immediately so toolbar shows correct page count.
        // Do NOT call adapter.onDocumentLoad() here — that sets _isReady=true
        // and fires readyCallbacks, but page dimensions aren't loaded yet.
        // We call onDocumentLoad AFTER await Promise.all below.
        useAppStore.getState().setPageCount(doc.numPages);
        renderedPages.clear(); // fresh render tracking for this document
        adapter.pageCount = doc.numPages;

        // Wire navigateToPage BEFORE setDocument so it's available immediately
        adapter.navigateToPage = (page: number) => {
          const v = viewerRef.current;
          if (!v || !v.pagesCount) return;
          const pageNum = Math.round(Number(page));
          if (!Number.isFinite(pageNum) || pageNum < 1) return;
          const clamped = Math.max(1, Math.min(pageNum, v.pagesCount));
          v.currentPageNumber = clamped;
          setCurrentPage(clamped);
        };

        // pagesloaded is the ONLY reliable place to set scale and navigate.
        // It fires after pdfjs has fully laid out all page placeholders with
        // the correct container dimensions — so scale and scroll are accurate.
        const onPagesLoaded = () => {
          eventBus.off('pagesloaded', onPagesLoaded);

          // 1. Reset store page to 1 BEFORE applying scale so no spurious
          //    pagechanging events fire for in-between pages
          setCurrentPage(1);

          // 2. Apply scale now — container is fully laid out, dimensions are stable
          const zm2 = useAppStore.getState().zoomMode;
          if (zm2 === 'page-fit')        pdfViewer.currentScaleValue = 'page-fit';
          else if (zm2 === 'page-width') pdfViewer.currentScaleValue = 'page-width';
          else if (zm2 === 'actual')     pdfViewer.currentScaleValue = 'page-actual';
          else                           pdfViewer.currentScaleValue = String(zoomRef.current);

          // 3. Scroll to page 1 explicitly — clears any cached scroll position
          //    from a previous document load
          pdfViewer.currentPageNumber = 1;

          // 4. Spinner: only show if page 1 hasn't rendered yet
          if (!renderedPages.has(1)) {
            useAppStore.getState().setRenderProgress(1);
          }

          // 5. Mark load complete — pagechanging can now trigger spinners
          docFullyLoaded = true;

          // 6. Notify parent PDF is loaded
          const bridgeEmit = (window as any).__doccapture_bridge?.emitPdfLoaded;
          if (bridgeEmit) {
            const st = useAppStore.getState();
            bridgeEmit({ fileName: st.fileName, pageCount: st.pageCount, docId: (st.file as any)?.__docId ?? null });
          }
        };
        eventBus.on('pagesloaded', onPagesLoaded);

        pdfViewer.setDocument(doc);
        linkService.setDocument(doc);

        // Expose pdfjs doc globally for getTextContent fallback in box capture
        (window as any).__tovPdfDoc = doc;
        (window as any).__tovPdfViewer = pdfViewer;

        // Open a second lightweight document for thumbnail rendering.
        // Thumbnails use a separate pdfjs doc so their render tasks don't
        // compete with the main viewer's render queue (fixes pages 3+ showing blank).
        clearPdfTextCache(); // invalidate per-page text item cache

        // Load ALL page dimensions BEFORE marking document ready.
        // This is critical: if we load dims lazily (one page at a time), the
        // adapter returns null for getPageDimensions() when the word_index JSON
        // is dropped immediately after the PDF loads — causing wrong normalisation.
        // We use Promise.all so every page's pts dimensions are stored synchronously
        // before the adapter fires _readyCallbacks and before the sidecar loader runs.
        //
        // page.view = [x0, y0, x1, y1] in PDF user units (pts for standard PDFs)
        // page.userUnit = points per user unit (1.0 for nearly all real-world PDFs)
        // width_pts = (x1 - x0) * userUnit  — the authoritative page width in points
        // Load page dimensions in batches of 4 — smaller batches reduce
        // pdfjs worker memory pressure during initial parse of large PDFs.
        // Sequential batching is faster than Promise.all for large docs because
        // the pdfjs worker processes one request at a time anyway.
        const BATCH = 4;
        for (let start = 1; start <= doc.numPages; start += BATCH) {
          const end = Math.min(start + BATCH - 1, doc.numPages);
          await Promise.all(
            Array.from({ length: end - start + 1 }, (_, i) => {
              const pg = start + i;
              return doc.getPage(pg).then((page: any) => {
                const v = page.view as [number, number, number, number];
                const u = (page.userUnit as number) ?? 1;
                adapter.onPageLoad(pg, {
                  width:  (v[2] - v[0]) * u,
                  height: (v[3] - v[1]) * u,
                });
              }).catch(() => {});
            })
          );
        }
        // NOW the adapter is truly ready: page dims + page count both loaded.
        // onDocumentLoad sets _isReady=true and fires all queued callbacks.
        adapter.onDocumentLoad(doc.numPages);
      }).catch(err => {
        if (!loadCancelled) console.error('PDF load failed:', err);
      });
    }); // end workerReadyPromise.then

    return () => {
      (window as any).__tovPdfDoc = null;
      (window as any).__tovPdfViewer = null;

      loadCancelled = true;
      viewerRef.current = null; eventBusRef.current = null;
      // Delay revoke so any in-flight pdfjs fetch can complete
      if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000);
      blobUrlRef.current = null;
      overlayMap.current.forEach(c => c.remove()); overlayMap.current.clear();
      pulseRef.current?.remove(); pulseRef.current = null;
      didInit.current = false;
    };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Zoom ──────────────────────────────────────────────────────────────────
  const zoomMode = useAppStore(s => s.zoomMode);
  const isLoading = useAppStore(s => s.isLoading);
  useEffect(() => {
    zoomRef.current = zoom;
    // Skip during file load — pagesloaded handler applies the correct scale
    // once pdfjs has finished layout. Pushing scale here before pagesloaded
    // is a no-op and causes confusion.
    if (isLoading) return;
    if (!viewerRef.current) return;
    const zm = useAppStore.getState().zoomMode;
    if (zm === 'page-fit')        viewerRef.current.currentScaleValue = 'page-fit';
    else if (zm === 'page-width') viewerRef.current.currentScaleValue = 'page-width';
    else if (zm === 'actual')     viewerRef.current.currentScaleValue = 'page-actual';
    else                          viewerRef.current.currentScaleValue = String(zoom);
  }, [zoom, zoomMode]);

  // ── Rotation ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (viewerRef.current) viewerRef.current.pagesRotation = rotation;
  }, [rotation]);

  // ── Keep draw function refs current every render ─────────────────────────
  // Plain functions defined in the component body are recreated each render.
  // The subscription effect runs once with [] and would capture stale closures.
  // Using refs avoids this — the subscription always calls the current function.
  useEffect(() => {
    drawAllRef.current = drawAllVisible;
    snapRef.current    = snapStore;
  });

  // ── Store subscription → redraw all visible pages ─────────────────────────
  useEffect(() => {
    snapRef.current();  // seed with initial state
    let drawTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useAppStore.subscribe((n, p) => {
      const changed =
        n.captures       !== p.captures       ||
        n.activeFieldId  !== p.activeFieldId  ||
        n.highlightIndex !== p.highlightIndex ||
        n.wordIndex      !== p.wordIndex      ||
        n.previewRect    !== p.previewRect    ||
        n.search.results !== p.search.results ||
        n.search.currentIndex !== p.search.currentIndex ||
        n.search.highlightAll !== p.search.highlightAll;
      if (!changed) return;
      // Snap immediately so dsRef is always current
      snapRef.current();
      // Debounce the actual canvas redraw — prevents multiple rapid redraws
      // when several state fields change in the same tick (e.g. new capture)
      if (drawTimer) clearTimeout(drawTimer);
      drawTimer = setTimeout(() => { drawTimer = null; drawAllRef.current(); }, 16);
    });
    return unsub;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search ────────────────────────────────────────────────────────────────
  // STRATEGY:
  //   • word_index loaded  → use our own runSearch() (fractional coords from
  //     word_index Map). pdfjs find controller is DISABLED — it uses the PDF
  //     text layer which may differ from word_index content and draws its own
  //     conflicting highlights on .textLayer .highlight elements.
  //   • no word_index      → delegate to pdfjs PDFFindController (searches
  //     all pages via worker, works across virtual-scroll pages).
  const search = useAppStore(s => s.search);

  useEffect(() => {
    const eb = eventBusRef.current; if (!eb) return;
    const wi = useAppStore.getState().wordIndex;

    if (wi.size > 0) {
      // word_index mode: always close pdfjs find so it draws NO highlights
      eb.dispatch('findbarclose', { source: window });
      return;
    }

    // pdfjs find mode (no word_index)
    if (!search.isOpen || !search.query.trim()) {
      eb.dispatch('findbarclose', { source: window }); return;
    }
    eb.dispatch('find', {
      source: window, type: '', query: search.query,
      caseSensitive: search.matchCase, entireWord: search.matchType === 'exact',
      highlightAll: search.highlightAll, findPrevious: false,
    });
  }, [search.query, search.matchCase, search.matchType, search.highlightAll, search.isOpen, hasWordIndex]);

  // Bridge searchNext/searchPrev toolbar buttons
  useEffect(() => {
    const wi = useAppStore.getState().wordIndex;

    if (wi.size > 0) {
      // word_index mode: next/prev already work correctly in appStore
      // (they update currentIndex and call navigateToPage + setPreviewRect)
      // Nothing to override here — store handles it.
      return;
    }

    // pdfjs find mode: override next/prev to call pdfjs find controller
    const go = (prev: boolean) => {
      const s = useAppStore.getState().search;
      if (!s.query.trim() || !eventBusRef.current) return;
      eventBusRef.current.dispatch('find', {
        source: window, type: 'again',
        query: s.query, caseSensitive: s.matchCase,
        entireWord: s.matchType === 'exact',
        highlightAll: s.highlightAll, findPrevious: prev,
      });
    };
    const on = useAppStore.getState().searchNext;
    const op = useAppStore.getState().searchPrev;
    useAppStore.setState({ searchNext: () => go(false), searchPrev: () => go(true) });
    return () => useAppStore.setState({ searchNext: on, searchPrev: op });
  }, [hasWordIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Text layer + pdfjs find highlight visibility ─────────────────────────
  // When word_index is loaded:
  //   - text layer: hidden (we use word_index for hit-test, not DOM spans)
  //   - .textLayer .highlight: hidden (pdfjs find controller highlights — we
  //     draw our own search highlights on the overlay canvas)
  // Inject a style tag to suppress pdfjs highlights globally when word_index active.
  useEffect(() => {
    const styleId = 'tov-suppress-pdfjs-find';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (hasWordIndex) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
      }
      // Hide pdfjs find highlights AND selection highlights
      styleEl.textContent = `.textLayer .highlight,.textLayer .selected{display:none!important;}`;
    } else {
      styleEl?.remove();
    }
  }, [hasWordIndex]);

  useEffect(() => {
    const c = containerRef.current; if (!c) return;
    c.querySelectorAll<HTMLElement>('.textLayer').forEach(el => {
      // word_index mode: hide text layer entirely (we use word_index for hit-test)
      // no word_index:   text layer visible and hittable for box capture DOM fallback
      el.style.pointerEvents = hasWordIndex ? 'none' : 'auto';
      el.style.opacity       = hasWordIndex ? '0'    : '';
      // Ensure spans are individually hittable for elementsFromPoint
      if (!hasWordIndex) {
        el.querySelectorAll<HTMLElement>('span').forEach(sp => {
          sp.style.pointerEvents = 'auto';
        });
      }
    });
  }, [hasWordIndex]);

  // Also re-apply on every page render (new pages mount after effect runs)
  // by hooking into the pagerendered event
  useEffect(() => {
    if (!eventBusRef.current) return;
    const eb = eventBusRef.current;
    const handler = () => {
      const c = containerRef.current; if (!c) return;
      c.querySelectorAll<HTMLElement>('.textLayer').forEach(el => {
        el.style.pointerEvents = hasWordIndex ? 'none' : 'auto';
        el.style.opacity       = hasWordIndex ? '0' : '';
        if (!hasWordIndex) {
          el.querySelectorAll<HTMLElement>('span').forEach(sp => {
            sp.style.pointerEvents = 'auto';
          });
        }
      });
    };
    eb.on('pagerendered', handler);
    return () => eb.off('pagerendered', handler);
  }, [hasWordIndex]);

  return (
    <div ref={containerRef} data-viewer-scroll="1"
      className="flex-1 bg-[#e8e8e8]"
      style={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
      <div ref={viewerDivRef} className="pdfViewer" />
    </div>
  );
}
