import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useAppStore } from './store/appStore';
import { TopBar } from './components/TopBar';
import { ResizablePanes } from './components/ResizablePanes';
import { ViewerToolbar } from './components/ViewerToolbar';
import { ViewerPane } from './components/ViewerPane';
import { FieldsPanel } from './components/FieldsPanel';
import { ThumbnailSidebar } from './components/ThumbnailSidebar';
import { useSidecarLoader } from './hooks/useSidecarLoader';
import { useMultiDoc } from './hooks/useMultiDoc';
import { MultiDocSidebar } from './components/MultiDocSidebar';
import type { DocumentManifest } from './types/multiDoc';
import { useEventBridge, isEmbedded, generateTempId } from './hooks/useEventBridge';
import { SPLIT_MERGE_URL } from './config';
import { preloadPdfResources } from './utils/pdfResourceCache';
import { parseHighlightPayload } from './utils/parseHighlightPayload';

function useGlobalShortcuts() {
  const setSearchOpen = useAppStore(s => s.setSearchOpen);
  const searchIsOpen  = useAppStore(s => s.search.isOpen);
  const file          = useAppStore(s => s.file);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && file) {
        e.preventDefault(); setSearchOpen(!searchIsOpen);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setSearchOpen, searchIsOpen, file]);
}

// ── normaliseEntry — pure helper used by applyDocMeta ────────────────────────
// Takes a raw wordIndex entry in ANY supported coord format and returns it
// with normalised { x, y, width, height } (0-1 fractions) so rebuildCaches
// can read e.x, e.y, e.width, e.height directly without further conversion.
function normaliseEntry(
  e: Record<string, unknown>,
  pg: number,
  adapter: any,
  extractRawCoords: Function,
  normaliseCoords: Function,
  getExtractedPage?: Function,
): Record<string, unknown> {
  const raw = extractRawCoords(e) as [number,number,number,number] | null;
  if (!raw) return e;

  // FORMAT 10: page was embedded in bbox[0] — use extracted page for normalisation
  const effectivePage = getExtractedPage ? getExtractedPage(e, pg) : pg;

  const [rx, ry, rw, rh] = raw;
  const isNorm = rx <= 1 && ry <= 1 && rw <= 1 && rh <= 1;
  if (isNorm) {
    return {
      ...e, x: rx, y: ry, width: rw, height: rh, _rawUnit: 'norm',
      // Store extracted page so store knows the correct page for this item
      ...(effectivePage !== pg ? { page: effectivePage } : {}),
    };
  }
  const [x, y, w, h] =
    normaliseCoords(raw, e, effectivePage, adapter, null) as [number,number,number,number];

  // Store original bbox for FORMAT 10 round-trip reconstruction
  const isFmt10 = Array.isArray(e.bbox) && (e.bbox as unknown[]).length === 5;

  return {
    ...e, x, y, width: w, height: h,
    _rawX: rx, _rawY: ry, _rawWidth: rw, _rawHeight: rh, _rawUnit: 'px',
    // FORMAT 10: preserve original [page, x, y, w, h] for CAPTURE_PREVIEW
    ...(isFmt10 ? { _rawBbox: e.bbox } : {}),
    ...(effectivePage !== pg ? { page: effectivePage } : {}),
  };
}

export default function App() {
  const sidebarOpen    = useAppStore(s => s.sidebarOpen);
  const openFile       = useAppStore(s => s.openFile);
  const setCurrentPage = useAppStore(s => s.setCurrentPage);
  const closeFile      = useAppStore(s => s.closeFile);
  const adapter               = useAppStore(s => s.adapter);
  const setWordIndex          = useAppStore(s => s.setWordIndex);
  const setCategories         = useAppStore(s => s.setCategories);
  const addCaptureWithId      = useAppStore(s => s.addCaptureWithId);
  const navigateAndHighlight  = useAppStore(s => s.navigateAndHighlight);
  const openFileBuffer        = useAppStore(s => s.openFileBuffer);
  const enableCaptureDebug    = useAppStore(s => s.enableCaptureDebug);
  const enableAnnotation      = useAppStore(s => s.enableAnnotation);
  const enableThumbnailView   = useAppStore(s => s.enableThumbnailView);
  const setEnableCaptureDebug = useAppStore(s => s.setEnableCaptureDebug);
  const showSplitMerge    = useAppStore(s => s.showSplitMerge);
  // splitMergeUrl is internal — read from env (VITE_SPLIT_MERGE_URL), not from parent
  const splitMergeUrl     = SPLIT_MERGE_URL;
  const [smActive, setSmActive] = React.useState(false);
  const smIframeRef       = React.useRef<HTMLIFrameElement>(null);
  const smIframeLoaded    = React.useRef(false);  // tracks cross-origin load state

  useSidecarLoader();
  useGlobalShortcuts();

  // ── Split & Merge integration ───────────────────────────────────────────────

  // Register the global opener so ViewerToolbar can call it without prop-drilling
  React.useEffect(() => {
    (window as any).__doccapture_openSplitMerge = () => {
      if (!splitMergeUrl) { console.warn('[SplitMerge] splitMergeUrl not configured in .env'); return; }

      // Activate SM mode — viewer hides, event bridge pauses doc-load events
      (window as any).__doccapture_sm_active = true;
      setSmActive(true);

      const st = useAppStore.getState();

      // Retrieve the complete original message that the parent sent
      // (stored by useEventBridge on LOAD_SINGLEDOC / LOAD_MANIFEST)
      const originalMsg = (window as any).__doccapture_last_parent_msg ?? {};

      // Build the SPLIT_MERGE_OPEN envelope:
      //   payload = the complete original parent message, untouched
      //   viewerState = viewer-side context added by the viewer
      const smMessage: Record<string, unknown> = {
        type:    'SPLIT_MERGE_OPEN',
        payload: { ...originalMsg },          // exact copy of what parent sent
        viewerState: {
          pageCount:   st.pageCount,
          currentPage: st.currentPage,
          format:      st.format,             // 'pdf'|'image'|'document'|'spreadsheet'
        },
      };

      // Extract buffer from payload for Transferable zero-copy transfer
      // The buffer in the payload clone is the same reference — slice it for transfer
      const payloadBuf =
        (originalMsg.buffer instanceof ArrayBuffer && originalMsg.buffer.byteLength > 0)
          ? originalMsg.buffer
          : (originalMsg.activeBuffer instanceof ArrayBuffer && originalMsg.activeBuffer.byteLength > 0)
          ? originalMsg.activeBuffer
          : null;

        // postToSM: attempts to post smMessage to the iframe.
        // contentWindow is available even for cross-origin iframes.
        // We retry every 100ms for up to 5 seconds in case the iframe
        // is still loading — this handles both first open and subsequent opens.
        const postToSM = () => {
          const win = smIframeRef.current?.contentWindow;
          if (!win) return false;
          if (payloadBuf) {
            const buf = payloadBuf.slice(0);
            if (originalMsg.buffer instanceof ArrayBuffer)
              (smMessage.payload as any).buffer = buf;
            if (originalMsg.activeBuffer instanceof ArrayBuffer)
              (smMessage.payload as any).activeBuffer = buf;
            win.postMessage(smMessage, '*', [buf]);
          } else {
            win.postMessage(smMessage, '*');
          }
          return true;
        };

        // Try immediately (works when iframe already loaded from previous open)
        if (!postToSM()) {
          // Iframe not ready yet — retry every 100ms until it is (max 5s)
          let attempts = 0;
          const retry = setInterval(() => {
            attempts++;
            if (postToSM() || attempts >= 50) clearInterval(retry);
          }, 100);
        }

      // Notify parent Angular that SM mode is now active
      if (isEmbedded) window.parent.postMessage({ type: 'SPLIT_MERGE_OPENED', fileName: st.fileName }, '*');
    };

    // Register close handler — called by useEventBridge when a new doc load
    // arrives while SM is active (parent loaded a new document)
    (window as any).__doccapture_closeSplitMerge = () => {
      setSmActive(false);
      // Notify parent that SM exited due to new document load
      if (isEmbedded) window.parent.postMessage({ type: 'SPLIT_MERGE_EXITED', reason: 'new_doc' }, '*');
    };

    return () => {
      delete (window as any).__doccapture_openSplitMerge;
      delete (window as any).__doccapture_closeSplitMerge;
      delete (window as any).__doccapture_sm_doPost;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitMergeUrl, smIframeRef]);

  // Listen for messages FROM the SM iframe (SAVE / EXIT)
  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>;
      if (!data?.type) return;

      if (data.type === 'SPLIT_MERGE_SAVE') {
        // Deactivate SM mode
        (window as any).__doccapture_sm_active = false;
        setSmActive(false);

        // If SM app sends back a new buffer, reload the document
        if (data.buffer instanceof ArrayBuffer && data.buffer.byteLength > 0) {
          const fileName = (data.fileName as string) || useAppStore.getState().fileName;
          useAppStore.getState().openFileBuffer(data.buffer, fileName);
          if (isEmbedded) window.parent.postMessage({ type: 'SPLIT_MERGE_SAVED', fileName }, '*');
        } else {
          if (isEmbedded) window.parent.postMessage({ type: 'SPLIT_MERGE_SAVED' }, '*');
        }
      }

      if (data.type === 'SPLIT_MERGE_EXIT') {
        (window as any).__doccapture_sm_active = false;
        setSmActive(false);
        if (isEmbedded) window.parent.postMessage({ type: 'SPLIT_MERGE_EXITED' }, '*');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Multi-doc state ───────────────────────────────────────────────────────
  const multiDoc = useMultiDoc();

  // ── Event bridge (only active when running inside an iframe) ─────────────
  // ── waitForAdapter ────────────────────────────────────────────────────────
  // Returns a Promise that resolves when the adapter is loaded AND ready
  // (all page dimensions available). Safe to call any time — if already
  // ready it resolves on the next microtask.
  const waitForAdapterReady = useCallback((): Promise<void> => {
    return new Promise(resolve => {
      const tryBind = () => {
        const ad = useAppStore.getState().adapter;
        if (ad && typeof (ad as any).onReady === 'function') {
          (ad as any).onReady(resolve); // fires immediately if already ready
        } else {
          // Adapter not created yet — wait for it
          const unsub = useAppStore.subscribe((state, prev) => {
            if (state.adapter && state.adapter !== prev.adapter) {
              unsub();
              if (typeof (state.adapter as any).onReady === 'function') {
                (state.adapter as any).onReady(resolve);
              } else {
                resolve();
              }
            }
          });
        }
      };
      tryBind();
    });
  }, []);

  // ── applyDocMeta ───────────────────────────────────────────────────────────
  // Applies wordIndex / categories / captures received from parent.
  //
  // wordIndex format accepted (both detected automatically):
  //   ARRAY:  [{ x, y, width, height, page, text }, ...]   ← your format
  //   OBJECT: { "1": [{ x, y, width, height, text }], "2": [...] }
  //
  // In both cases each entry is normalised through extractRawCoords so any
  // supported coord format works (x/y, left/right, bbox, etc.).
  //
  // wordIndex + captures are deferred until adapter.onReady() so page
  // dimensions are available for coordinate normalisation. Categories
  // (no coords) apply immediately.
  const applyDocMeta = useCallback((
    meta?: import('./hooks/useEventBridge').SingleDocMeta | import('./hooks/useEventBridge').DocResponseMeta
  ) => {
    if (!meta) return;

    // Categories — no coords needed but page count must be known
    // so defer to adapter.onReady same as wordIndex/captures
    // (avoids useMemo running with pageCount=0 → wrong otherPages list)

    // wordIndex + captures need page dimensions → defer to adapter ready
    // Gate: skip waitForAdapterReady if there is genuinely nothing coord-related to apply.
    // Check captures.length explicitly — an empty array [] is falsy but shouldn't block.
    const hasCaptures  = Array.isArray(meta.captures) && meta.captures.length > 0;
    const hasCategories = Array.isArray(meta.categories) && meta.categories.length > 0;
    // Gate: skip if nothing to apply (but include categories in the check)
    const hasCoordMeta = !!( (meta as any).fullPageOCR || meta.wordIndex || hasCaptures || hasCategories );
    if (!hasCoordMeta) return;

    waitForAdapterReady().then(() => {
      const ad = useAppStore.getState().adapter;

      // ── Apply initialZoom ─────────────────────────────────────────────────
      // Accepted values (case-insensitive string or numeric):
      //   'page-fit' / 'fit' / 'fit-page'       → page-fit (pdfjs: page-fit)
      //   'page-width' / 'width' / 'fit-width'  → page-width
      //   'actual' / '100%' / 'actual-size'     → actual (100%)
      //   1.5 / '1.5'                            → explicit numeric zoom
      //   undefined / null / ''                  → keep format default (page-fit for PDF/image,
      //                                            actual for XLSX/CSV)
      // initialZoom only exists on SingleDocMeta (not DocResponseMeta) — cast safely
      const initialZoom = (meta as import('./hooks/useEventBridge').SingleDocMeta).initialZoom;
      if (initialZoom !== undefined && initialZoom !== null && initialZoom !== '') {
        const raw   = String(initialZoom).trim().toLowerCase();
        const isNum = !isNaN(Number(initialZoom));
        if (isNum) {
          useAppStore.getState().setZoom(Number(initialZoom));
        } else if (raw === 'page-fit' || raw === 'fit' || raw === 'fit-page' || raw === 'fit page') {
          useAppStore.getState().setZoomMode('page-fit');
        } else if (raw === 'page-width' || raw === 'width' || raw === 'fit-width' || raw === 'fit width') {
          useAppStore.getState().setZoomMode('page-width');
        } else if (raw === 'actual' || raw === '100%' || raw === 'actual-size' || raw === 'actual size') {
          useAppStore.getState().setZoomMode('actual');
        }
      }

      // Apply categories now that pageCount is known
      if (meta.categories) {
        const PALETTE = ['blue','teal','amber','gray','purple','coral','green','red'];
        const withColors = (meta.categories as any[]).map((cat: any, i: number) => ({
          ...cat,
          color: cat.color ?? PALETTE[i % PALETTE.length],
        }));
        setCategories(withColors as any);
      }

      // After adapter is ready, force a redraw of all visible pages
      // so captured_fields grey boxes appear immediately on load.
      // We schedule after the current micro-task so state updates settle first.
      const triggerRedraw = () => {
        // Fire immediately (synchronous store subscribers will pick it up),
        // then retry at 100ms and 600ms to cover slow PDF initialisation.
        useAppStore.getState()._rebuildHighlightIndex();
        setTimeout(() => useAppStore.getState()._rebuildHighlightIndex(), 100);
        setTimeout(() => useAppStore.getState()._rebuildHighlightIndex(), 600);
      };

      // ── wordIndex ──────────────────────────────────────────────────────
      if (meta.wordIndex) {
        import('./utils/coords').then(async ({ extractRawCoords, normaliseCoords, getExtractedPage }) => {
          const normalised = new Map<number, import('./adapters/types').WordEntry[]>();
          const rawWi = meta.wordIndex as any;

          // Build page→entries map first (no processing yet)
          const byPage = new Map<number, any[]>();
          if (Array.isArray(rawWi)) {
            for (const e of rawWi) {
              const pg = Number(e.page ?? 1);
              if (!byPage.has(pg)) byPage.set(pg, []);
              byPage.get(pg)!.push(e);
            }
          } else {
            for (const [pageKey, entries] of Object.entries(rawWi)) {
              if (Array.isArray(entries)) byPage.set(Number(pageKey), entries as any[]);
            }
          }

          // ── Chunked normalisation — yields main thread every CHUNK_SIZE pages ──
          // For large documents (1000+ pages × 300 words = 300k operations),
          // processing all pages synchronously freezes the UI for seconds.
          // Processing in chunks of 50 pages yields between chunks so the browser
          // can handle scroll, paint, and input events — document stays responsive.
          const CHUNK_SIZE = 50; // pages per chunk before yielding
          const pageEntries = Array.from(byPage.entries());

          const processChunks = async () => {
            for (let i = 0; i < pageEntries.length; i += CHUNK_SIZE) {
              const chunk = pageEntries.slice(i, i + CHUNK_SIZE);
              for (const [pg, entries] of chunk) {
                normalised.set(pg, entries.map((e: any) =>
                  normaliseEntry(e, pg, ad, extractRawCoords, normaliseCoords, getExtractedPage)
                ) as any);
              }
              // Yield to browser between chunks — keeps UI responsive
              if (i + CHUNK_SIZE < pageEntries.length) {
                await new Promise<void>(r =>
                  typeof (scheduler as any)?.yield === 'function'
                    ? (scheduler as any).yield().then(r)
                    : setTimeout(r, 0)
                );
              }
            }

            console.log('[applyDocMeta] wordIndex ready. Pages:', normalised.size);
            setWordIndex(normalised);
          };

          await processChunks();

        });
      }

      // ── captures ───────────────────────────────────────────────────────
      // Normalise coordinates AND merge atomically in one store write.
      //
      // Parent may send captures in any supported format:
      //   { x, y, width, height }  as 0-1 fractions → stored as-is
      //   { x, y, width, height }  as pixel/pt values → normalised to 0-1
      //   { bbox, rectangle, coordinates }            → extracted + normalised
      //
      // After normalisation, captures + highlightIndex are written in ONE
      // setState call so PDFViewer subscription fires exactly once with
      // both already correct → all grey boxes appear immediately.
      if (meta.captures && meta.captures.length > 0) {
        import('./utils/coords').then(({ extractRawCoords, normaliseCoords, normaliseBatch }) => {
          // Use batch normalisation — detects unit ONCE from global max coordinate
          // across ALL captures, not per-item. This prevents the ambiguity where
          // coords below ~page_height_in_pts are misidentified as pts instead of px,
          // causing highlights to appear at wrong positions for absolute pixel coords.
          const rawCaps = meta.captures as any[];

          // Run batch normalisation: detects unit from max coord across all items
          console.log('[App] normaliseBatch for', rawCaps.length, 'captures:',
            rawCaps.map((c: any) => JSON.stringify({bbox: c.bbox, page: c.page})).join(' | '));
          const batchResults = normaliseBatch(
            rawCaps,
            (item: any) => {
              // FORMAT 10: page is inside bbox[0]
              const ep = (item as any).__extractedPage;
              const pg = typeof ep === 'number' ? ep : (item.page ?? 1);
              return pg;
            },
            ad,
          );
          console.log('[App] batchResults:',
            batchResults.map((r: any) => r.coords ? r.coords.map((v: number) => v.toFixed(3)).join(',') : 'null').join(' | '));

          const incoming = rawCaps.map((cap: any, i: number) => {
            const batchCoord = batchResults[i]?.coords;
            // Fall back to per-item if batch failed for this item
            const normed = batchCoord
              ? { ...cap, x: batchCoord[0], y: batchCoord[1], width: batchCoord[2], height: batchCoord[3],
                  _rawX: cap.x ?? cap.xmin, _rawY: cap.y ?? cap.ymin,
                  _rawWidth: cap.width ?? cap.w, _rawHeight: cap.height ?? cap.h,
                  _rawUnit: (batchCoord[0] === (cap.x ?? cap.xmin)) ? 'norm' : 'px' }
              : normaliseEntry(cap, cap.page ?? 1, ad, extractRawCoords, normaliseCoords);
            return {
              label:       cap.label ?? cap.text ?? cap.value ?? '',
              value:       cap.value ?? cap.text ?? cap.label ?? '',
              fromJson:    true,
              sourceFormat: cap.sourceFormat ?? 'flat',
              ...normed,
              // id must survive — normaliseEntry spreads the original object so id is kept
            } as import('./adapters/types').CaptureItem;
          });

          // Merge with existing captures (upsert by id)
          const current = useAppStore.getState().captures;
          const merged  = [...current];
          for (const cap of incoming) {
            const idx = merged.findIndex(c => c.id === (cap as any).id);
            if (idx >= 0) merged[idx] = cap;
            else          merged.push(cap);
          }

          // Build highlightIndex synchronously before setState
          type HRect = { x:number; y:number; width:number; height:number; id:string; color?:string; type?:'external' };
          const index = new Map<number, HRect[]>();
          for (const c of merged) {
            if (!index.has(c.page)) index.set(c.page, []);
            index.get(c.page)!.push({
              x: c.x, y: c.y, width: c.width, height: c.height,
              id: c.id, color: c.color, type: c.type,
            });
          }

          // One atomic write — PDFViewer subscription fires ONCE with correct index
          useAppStore.setState({ captures: merged, highlightIndex: index });

          // Trigger redraws at increasing intervals to cover all timing scenarios:
          //   T+0ms:   subscription fires from setState above — handles case where
          //            viewer is already ready (common: captures sent after doc opened)
          //   T+100ms: catches case where PDF is still initialising when captures arrive
          //   T+600ms: catches slow PDF loads or heavy documents
          // Each call touches highlightIndex to re-fire the subscription → drawAllVisible.
          // Safe to call multiple times — drawAllVisible is idempotent.
          [100, 600].forEach(delay => setTimeout(() => {
            useAppStore.getState()._rebuildHighlightIndex();
          }, delay));
        });
        return;
      }

      // Trigger one redraw pass to ensure any already-rendered pages pick up
      // the new highlightIndex (covers pages rendered before captures arrived).
      triggerRedraw();
    });
  }, [waitForAdapterReady, setWordIndex, setCategories, addCaptureWithId]);

  const bridge = useEventBridge({
    onReset: () => {
      // Called when parent sends RESET_VIEWER
      multiDoc.clearMultiDoc();
    },
    onLoadSingleDoc: (buffer, fileName, meta) => {
      openFileBuffer(buffer, fileName);
      applyDocMeta(meta);
      // Click2Pick: enable box-capture mode immediately on load if requested
      if (meta?.Click2Pick) useAppStore.getState().setBoxMode(true);
      // debugArea (alias: showFieldsPanel) — show/hide right-side Fields panel.
      // debugArea takes priority; falls back to showFieldsPanel for backwards compat.
      const showPanel1 = meta?.debugArea ?? meta?.showFieldsPanel;
      if (showPanel1 !== undefined)
        useAppStore.getState().setEnableCaptureDebug(showPanel1);
      // showAnnotation: show annotation/draw button if parent requests it
      if ((meta as any)?.showAnnotation !== undefined)
        useAppStore.getState().setEnableAnnotation(!!(meta as any).showAnnotation);
      // showThumbnailView: show/hide thumbnail icon + section (default: true)
      if ((meta as any)?.showThumbnailView !== undefined)
        useAppStore.getState().setEnableThumbnailView(!!(meta as any).showThumbnailView);
      // showSplitMerge from LOAD_SINGLEDOC — enables icon if VITE_SPLIT_MERGE_URL is set
      if ((meta as any)?.showSplitMerge !== undefined)
        useAppStore.getState().setShowSplitMerge(!!(meta as any).showSplitMerge);
    },

    onLoadManifest: (manifest, activeDocId, activeBuffer, meta) => {
      multiDoc.loadManifest(manifest);
      if (activeBuffer && activeDocId) {
        const doc = (manifest.documents ?? []).find((d: any) => d.id === activeDocId);
        const name = (doc as any)?.name ?? `${activeDocId}.pdf`;
        openFileBuffer(activeBuffer, name);
        applyDocMeta(meta);
      }
      // Click2Pick: enable box-capture mode if requested
      if (meta?.Click2Pick) useAppStore.getState().setBoxMode(true);
      // debugArea (alias: showFieldsPanel) — show/hide right-side Fields panel.
      const showPanel2 = (meta as any)?.debugArea ?? meta?.showFieldsPanel;
      if (showPanel2 !== undefined)
        useAppStore.getState().setEnableCaptureDebug(showPanel2);
      // showAnnotation: show annotation/draw button if parent requests it
      if ((meta as any)?.showAnnotation !== undefined)
        useAppStore.getState().setEnableAnnotation(!!(meta as any).showAnnotation);
      if ((meta as any)?.showThumbnailView !== undefined)
        useAppStore.getState().setEnableThumbnailView(!!(meta as any).showThumbnailView);
      // showSplitMerge from LOAD_MANIFEST
      if ((meta as any)?.showSplitMerge !== undefined)
        useAppStore.getState().setShowSplitMerge(!!(meta as any).showSplitMerge);
    },

    // Called after DOC_RESPONSE resolves — apply per-doc meta
    onDocMeta: (_docId, meta) => {
      applyDocMeta(meta);
    },

    onHighlight: async (payload) => {
      // id is mandatory — guard (also validated in bridge)
      if (!payload?.id || String(payload.id).trim() === '') {
        console.warn('[onHighlight] Ignored — id missing or empty:', payload);
        return;
      }

      // Step 1: deactivate the currently active highlight before switching
      useAppStore.getState().setActiveField(null);
      useAppStore.getState().setPreviewRect(null);

      // Step 2: MultiDoc — load the target doc first if different from active
      if (payload.docId && multiDoc.state &&
          payload.docId !== multiDoc.state.activeDocId) {
        await multiDoc.selectDoc(payload.docId);
      }

      // Step 3a: id already in captures → navigate + set YELLOW (active)
      // navigateAndHighlight sets activeFieldId + previewRect
      const found = navigateAndHighlight(payload.id);
      if (found) return;

      // Step 3b: id not in captures — coords required to add
      const result = parseHighlightPayload(payload, adapter);
      if ('error' in result) {
        console.warn('[onHighlight] No valid coords — ignored:', result.error);
        return;
      }
      if (!result.item.id || result.item.id.trim() === '') {
        console.warn('[onHighlight] Parsed item missing id — ignored');
        return;
      }
      // addCaptureWithId adds AND sets activeFieldId + navigates + sets previewRect
      addCaptureWithId(result.item);
    },

    onCaptureAck: (tempId, realId) => {
      bridge.resolveAck(tempId, realId);
    },

    onReadyConfig: (config) => {
      if (config.enableCaptureDebug !== undefined)
        setEnableCaptureDebug(config.enableCaptureDebug);
      // showSplitMerge via READY_CONFIG still supported (URL stays internal)
      if (config.showSplitMerge !== undefined)
        useAppStore.getState().setShowSplitMerge(config.showSplitMerge);
      // initialZoom from READY_CONFIG (applies before first doc loads)
      if (config.initialZoom !== undefined) {
        const raw = String(config.initialZoom).trim().toLowerCase();
        if (!isNaN(Number(config.initialZoom))) {
          useAppStore.getState().setZoom(Number(config.initialZoom));
        } else if (raw === 'page-fit' || raw === 'fit') {
          useAppStore.getState().setZoomMode('page-fit');
        } else if (raw === 'page-width' || raw === 'width') {
          useAppStore.getState().setZoomMode('page-width');
        } else if (raw === 'actual' || raw === '100%') {
          useAppStore.getState().setZoomMode('actual');
        }
      }
      if (config.Click2Pick)
        useAppStore.getState().setBoxMode(true);
    },

    onExportRequest: () => {
      // Parent sent EXPORT_CAPTURES — build JSON and respond via CAPTURES_DATA
      const { captures, fileName } = useAppStore.getState();
      const round = (n: number) => parseFloat(n.toFixed(6));

      const data = captures.map((c: import('./adapters/types').CaptureItem) => {
        const hasRaw = c._rawX !== undefined && c._rawWidth !== undefined;
        const base: import('./hooks/useEventBridge').ExportedCapture = {
          id: c.id, value: c.value, page: c.page,
        };

        if (hasRaw) {
          // Restore original raw coords — round-trip fidelity
          const rx = c._rawX!,  ry = c._rawY  ?? 0;
          const rw = c._rawWidth!, rh = c._rawHeight ?? 0;
          if      (c.sourceFormat === 'bbox')        base.bbox        = [rx, ry, rw, rh];
          else if (c.sourceFormat === 'rectangle')   base.rectangle   = [rx, ry, rw, rh];
          else if (c.sourceFormat === 'coordinates') base.coordinates = [ry, rx, ry + rh, rx + rw];
          else { base.x = rx; base.y = ry; base.width = rw; base.height = rh; }
        } else {
          // No raw values — send normalised 0-1
          if      (c.sourceFormat === 'bbox')        base.bbox        = [round(c.x), round(c.y), round(c.width), round(c.height)];
          else if (c.sourceFormat === 'rectangle')   base.rectangle   = [round(c.x), round(c.y), round(c.width), round(c.height)];
          else if (c.sourceFormat === 'coordinates') base.coordinates = [round(c.y), round(c.x), round(c.y + c.height), round(c.x + c.width)];
          else { base.x = round(c.x); base.y = round(c.y); base.width = round(c.width); base.height = round(c.height); }
        }

        if (c.color) base.color = c.color;
        return base;
      });

      bridge.respondCaptures(data);
    },

    onCaptureDelete: (id) => {
      // Parent signalled delete (empty/zero coords in ACK) — remove from captures
      useAppStore.getState().removeCapture(id);
    },

    // SET_CAPTURES — load or merge captures at any point after doc load
    onSetCaptures: (incoming, mode, _docId) => {
      import('./utils/coords').then(({ extractRawCoords, normaliseCoords, normaliseBatch }) => {
        const ad = useAppStore.getState().adapter;

        // Batch normalisation — consistent unit detection across all captures
        const incomingArr = incoming as any[];
        const batchRes = normaliseBatch(incomingArr, (item: any) => item.page ?? 1, ad);

        const normalised = incomingArr.map((cap: any, i: number) => {
          const bc = batchRes[i]?.coords;
          const normed = bc
            ? { ...cap, x: bc[0], y: bc[1], width: bc[2], height: bc[3] }
            : normaliseEntry(cap, cap.page ?? 1, ad, extractRawCoords, normaliseCoords);
          return {
            label:       cap.label ?? cap.text ?? cap.value ?? '',
            value:       cap.value ?? cap.text ?? cap.label ?? '',
            fromJson:    true,
            sourceFormat: cap.sourceFormat ?? 'flat',
            ...normed,
          } as import('./adapters/types').CaptureItem;
        });

        const current = useAppStore.getState().captures;
        let merged: import('./adapters/types').CaptureItem[];

        if (mode === 'merge') {
          // Upsert by id — update existing, append new ones
          merged = [...current];
          for (const cap of normalised) {
            const idx = merged.findIndex(c => c.id === (cap as any).id);
            if (idx >= 0) merged[idx] = cap;
            else          merged.push(cap);
          }
        } else {
          // Replace — discard all existing captures, use incoming only
          merged = normalised;
        }

        // Rebuild highlightIndex atomically
        type HRect = { x:number;y:number;width:number;height:number;id:string;color?:string;type?:'external' };
        const index = new Map<number, HRect[]>();
        for (const c of merged) {
          if (!index.has(c.page)) index.set(c.page, []);
          index.get(c.page)!.push({ x:c.x, y:c.y, width:c.width, height:c.height,
                                    id:c.id, color:c.color, type:c.type });
        }
        useAppStore.setState({ captures: merged, highlightIndex: index });

        // Retry redraws to cover timing edge cases
        setTimeout(() => useAppStore.getState()._rebuildHighlightIndex(), 100);
        setTimeout(() => useAppStore.getState()._rebuildHighlightIndex(), 600);
      });
    },
  });

  // Standalone defaults: when NOT in iframe, right panel + annotation visible by default.
  // When embedded, both start hidden — parent controls via debugArea (or showFieldsPanel) / showAnnotation.
  useEffect(() => {
    if (!isEmbedded) {
      useAppStore.getState().setEnableCaptureDebug(true);
      useAppStore.getState().setEnableAnnotation(true);
      // standalone: thumbnail icon visible, sidebar collapsed (user can expand)
      useAppStore.getState().setEnableThumbnailView(true);
    }
  }, []); // eslint-disable-line

  // Expose bridge.emitDocLoaded on window so PDFViewer can call it without prop drilling
  useEffect(() => {
    if (!isEmbedded) return;
    // emitDocLoaded is the canonical name.
    // emitPdfLoaded is the alias PDFViewer uses — both point to the same function.
    (window as any).__doccapture_bridge = {
      emitDocLoaded:    bridge.emitDocLoaded,
      emitPdfLoaded:    bridge.emitDocLoaded,     // alias for PDFViewer
      emitDocLoadError: bridge.emitDocLoadError,  // for PDFViewer + adapter errors
    };
    return () => { delete (window as any).__doccapture_bridge; };
  }, [bridge.emitDocLoaded]);

  // ── Watch store loadError → emit DOC_LOAD_ERROR to parent ──────────────────
  // openFile() sets loadError for ALL non-PDF format failures:
  //   • ImageAdapter (TIFF/PNG/JPG) — loadFile() throws
  //   • SpreadsheetAdapter (XLSX/CSV) — loadFile() throws
  //   • DocAdapter (DOCX) — loadFile() throws
  //   • Unsupported format — explicit message
  //   • openFileBuffer with empty/null buffer — explicit message
  // PDFViewer emits its own error via __doccapture_bridge directly.
  // This effect covers everything else uniformly.
  useEffect(() => {
    if (!isEmbedded) return;
    const unsub = useAppStore.subscribe((n, p) => {
      if (!n.loadError || n.loadError === p.loadError) return;
      const code: import('./hooks/useEventBridge').DocLoadErrorCode =
        n.loadError.includes('Unsupported') || n.loadError.includes('unreadable')
          ? 'UNSUPPORTED_FORMAT'
        : n.loadError.includes('Empty') || n.loadError.includes('invalid file')
          ? 'INVALID_BUFFER'
        : n.loadError.includes('corrupt') || n.loadError.includes('Corrupt')
          ? 'CORRUPT_FILE'
        : 'UNKNOWN';
      bridge.emitDocLoadError({
        code,
        reason:   n.loadError,
        fileName: n.fileName ?? undefined,
        docId:    null,
      });
    });
    return unsub;
  }, [bridge.emitDocLoadError]);

  // Pass requestBuffer into multiDoc so selectDoc can fetch via postMessage
  useEffect(() => {
    if (!isEmbedded) return;
    multiDoc.setConfig({ requestBuffer: bridge.requestDocBuffer });
  }, [bridge.requestDocBuffer]); // eslint-disable-line

  // Register manifest handler in the store — synchronous, no timing race
  const handleManifest = useCallback((manifest: DocumentManifest) => {
    multiDoc.loadManifest(manifest);
  }, [multiDoc]);

  useEffect(() => {
    useAppStore.getState().registerManifestHandler(handleManifest);
    // Also set window bridge for ViewerPane drop zone (belt-and-suspenders)
    (window as any).__onManifest = handleManifest;
    return () => {
      (window as any).__onManifest = undefined;
    };
  }, [handleManifest]);

  // Exit multi-doc mode — clear state + reset viewer
  const handleClearMultiDoc = useCallback(() => {
    multiDoc.clearMultiDoc();
    closeFile();
  }, [multiDoc, closeFile]);

  // pendingPageRef: when selectDoc resolves a new file, navigate to requested page
  // after pdfjs adapter is ready (adapter.onReady fires after page dims loaded)
  const pendingPageRef = React.useRef<number>(1);

  const handleSelectDoc = useCallback(async (docId: string, page = 1) => {
    pendingPageRef.current = page;
    await multiDoc.selectDoc(docId, page);
  }, [multiDoc]);

  // Track last loaded file name to skip re-opening on cache hits (same File object)
  const lastLoadedFileRef = React.useRef<string>('');

  // When a new activeFile is resolved → load it into the viewer
  useEffect(() => {
    if (!multiDoc.activeFile) return;
    const fileKey = multiDoc.activeFile.name + multiDoc.activeFile.size;
    if (fileKey === lastLoadedFileRef.current) {
      // Cache hit — same File object, pdfjs already loaded.
      // Just navigate to the requested page.
      const pg = pendingPageRef.current;
      if (pg >= 1) {
        setCurrentPage(pg);
        useAppStore.getState().adapter?.navigateToPage?.(pg);
      }
      return;
    }
    lastLoadedFileRef.current = fileKey;
    // Preserve user zoom across multi-doc navigation.
    // If zoomMode is 'custom' (explicit %): restore immediately after the sync reset.
    // If zoomMode is 'page-fit'/'page-width': let ViewerToolbar auto-apply recalculate
    //   for the new document's dimensions — do not restore the old doc's pixel zoom.
    const { zoom: savedZoom, zoomMode: savedZoomMode } = useAppStore.getState();
    openFile(multiDoc.activeFile).then(() => {
      if (savedZoomMode === 'custom') {
        // Restore exact zoom — this also sets zoomMode='custom' which blocks auto-apply
        useAppStore.getState().setZoom(savedZoom);
      }
      // For page-fit/page-width: openFile already reset to zoomMode='page-fit',
      // and the ViewerToolbar useEffect fires when adapter+pageCount are ready,
      // recalculating the correct zoom for the new doc size automatically.
      const adapter = useAppStore.getState().adapter as any;
      if (adapter && typeof adapter.onReady === 'function') {
        adapter.onReady(() => {
          const pg = pendingPageRef.current;
          if (pg > 1) {
            setCurrentPage(pg);
            useAppStore.getState().adapter?.navigateToPage?.(pg);
          }

          // Emit DOC_LOADED for non-PDF formats (PDF emits this from PDFViewer
          // via __doccapture_bridge when the first page renders).
          // For image/spreadsheet/doc adapters: adapter.onReady fires once
          // when page 1 is fully decoded — exactly the right moment.
          const st  = useAppStore.getState();
          const fmt = st.format;
          if (fmt !== 'pdf') {
            const bridgeEmit = (window as any).__doccapture_bridge?.emitDocLoaded;
            if (bridgeEmit) {
              bridgeEmit({
                fileName:  st.fileName,
                pageCount: st.pageCount,
                docId:     (st.file as any)?.__docId ?? null,
              });
            }
          }
        });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiDoc.activeFile]);

  // Page selection within the current document
  const handleSelectPage = useCallback((page: number) => {
    multiDoc.selectPage(page);
    setCurrentPage(page);
    useAppStore.getState().adapter?.navigateToPage?.(page);
  }, [multiDoc, setCurrentPage]);

  const showMultiSidebar   = enableThumbnailView && !!multiDoc.state && sidebarOpen;
  const showDefaultSidebar = enableThumbnailView && !multiDoc.state && sidebarOpen;

  return (
    <div className="flex flex-col h-full bg-[#060d1a] overflow-hidden">

      {/* ── Split & Merge iframe ─────────────────────────────────────────────
          Created once, shown when smActive=true. The viewer content below is
          hidden (display:none) while this iframe is visible. State is preserved.
          The iframe receives SPLIT_MERGE_OPEN with the current doc buffer.    */}
      {showSplitMerge && splitMergeUrl && (
        <iframe
          ref={smIframeRef}
          src={splitMergeUrl}
          title="Split & Merge"
          style={{ display: smActive ? 'flex' : 'none', flex: 1, border: 'none', width: '100%', height: '100%' }}
          allow="*"
          onLoad={() => {
            smIframeLoaded.current = true;
            // If SM is already active when load fires (first open), post now
            if ((window as any).__doccapture_sm_active) {
              (window as any).__doccapture_sm_doPost?.();
            }
          }}
        />
      )}

      {/* ── Viewer content — hidden (not unmounted) when SM is active ───── */}
      <div style={{ display: smActive ? 'none' : 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

      {/* When right panel hidden: viewer takes full width (no ResizablePanes overhead) */}
      {!enableCaptureDebug ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex flex-col flex-1 overflow-hidden">
            <ViewerToolbar />
            <div className="flex flex-1 overflow-hidden relative">
              {showMultiSidebar && multiDoc.state && (
                <MultiDocSidebar
                  state={multiDoc.state}
                  isLoading={multiDoc.activeDocLoading}
                  loadError={multiDoc.activeDocError}
                  adapter={adapter}
                  onSelectDoc={handleSelectDoc}
                  onSelectPage={handleSelectPage}
                  onClose={handleClearMultiDoc}
                />
              )}
              {showDefaultSidebar && (
                <div style={{ position:'absolute', top:0, left:0, bottom:0, zIndex:30, display:'flex' }}>
                  <ThumbnailSidebar />
                </div>
              )}
              <ViewerPane multiDocLoading={multiDoc.activeDocLoading && !multiDoc.activeFile} bridge={bridge} />
            </div>
          </div>
        </div>
      ) : (
      <ResizablePanes
        left={
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Toolbar spans full width above viewer+sidebar */}
            <ViewerToolbar />
            {/* Below toolbar: sidebar overlays the viewer body only */}
            <div className="flex flex-1 overflow-hidden relative">
              {showMultiSidebar && multiDoc.state && (
                <MultiDocSidebar
                  state={multiDoc.state}
                  isLoading={multiDoc.activeDocLoading}
                  loadError={multiDoc.activeDocError}
                  adapter={adapter}
                  onSelectDoc={handleSelectDoc}
                  onSelectPage={handleSelectPage}
                  onClose={handleClearMultiDoc}
                />
              )}
              {/* ThumbnailSidebar overlays viewer body — sits below toolbar, does not push viewer */}
              {showDefaultSidebar && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  bottom: 0,
                  zIndex: 30,
                  display: 'flex',
                }}>
                  <ThumbnailSidebar />
                </div>
              )}
              <ViewerPane multiDocLoading={multiDoc.activeDocLoading && !multiDoc.activeFile} bridge={bridge} />
            </div>
          </div>
        }
        right={<FieldsPanel bridge={bridge} />}
        defaultSplit={0.80}
        minLeft={320}
        minRight={200}
      />
      )}
      </div>{/* end viewer content wrapper */}
    </div>
  );
}
