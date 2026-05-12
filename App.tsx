import React, { useEffect, useCallback } from 'react';
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
): Record<string, unknown> {
  const raw = extractRawCoords(e) as [number,number,number,number] | null;
  if (!raw) return e;
  const [rx, ry, rw, rh] = raw;
  const isNorm = rx <= 1 && ry <= 1 && rw <= 1 && rh <= 1;
  if (isNorm) {
    // Already 0-1 fractions — no raw storage needed
    return { ...e, x: rx, y: ry, width: rw, height: rh, _rawUnit: 'norm' };
  }
  // Raw pixel/pt values — normalise AND store originals for CAPTURE_PREVIEW round-trip
  const [x, y, w, h] =
    normaliseCoords(raw, e, pg, adapter, null) as [number,number,number,number];
  return {
    ...e, x, y, width: w, height: h,
    _rawX: rx, _rawY: ry, _rawWidth: rw, _rawHeight: rh, _rawUnit: 'px',
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

  useSidecarLoader();
  useGlobalShortcuts();

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
      if (meta.categories) setCategories(meta.categories as any);

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
        import('./utils/coords').then(async ({ extractRawCoords, normaliseCoords }) => {
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
                  normaliseEntry(e, pg, ad, extractRawCoords, normaliseCoords)
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
          const batchResults = normaliseBatch(
            rawCaps,
            (item: any) => item.page ?? 1,
            ad,
          );

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
      // showThumbnailView: show/hide thumbnail icon + section (default: true)
      if ((meta as any)?.showThumbnailView !== undefined)
        useAppStore.getState().setEnableThumbnailView(!!(meta as any).showThumbnailView);
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
      {/* <TopBar /> */}{/* TOP HEADER — commented out, not needed in embedded mode */}
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
    </div>
  );
}
