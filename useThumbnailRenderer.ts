// ─────────────────────────────────────────────────────────────────────────────
// useThumbnailRenderer — scroll-aware background thumbnail rendering
//
// PERFORMANCE CONTRACT:
//   • Visible pages: render immediately via rAF (1 per frame, main thread yield)
//   • Off-screen pages: render ONLY during genuine browser idle time
//   • User interactions (click, scroll, type, wheel): pause ALL bg renders 1.5s
//   • Large docs (>300 pages): NO background sweep — only visible±AHEAD render
//   • pdfPage.cleanup() called after every render to free GPU/memory
//   • O(1) Set-based queue membership — no O(n) array scans
//   • inFlight NEVER blocks enqueue — visible pages always enter the queue
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import type { AdapterInstance } from '../store/appStore';
import type { ImageAdapter } from '../adapters/ImageAdapter';

const THUMB_W            = 120;  // smaller = faster render, still clear in sidebar
const PRELOAD_AHEAD      = 3;    // pages beyond visible to preload (reduced from 8)
const INTERACTION_PAUSE  = 1500; // ms to pause bg renders after any user action
const BG_SWEEP_MAX_PAGES = 300;  // docs larger than this: no full bg sweep

// ── Module-scope pixel cache ──────────────────────────────────────────────────
const thumbCache = new Map<string, Map<number, ImageBitmap>>();
let   currentAdapterKey = '';

function getAdapterKey(adapter: AdapterInstance | null): string {
  if (!adapter) return '';
  const pc   = adapter.pageCount ?? 0;
  const s    = useAppStore.getState();
  const name = s.fileName || '';
  const size = s.file?.size ?? 0;
  return `${adapter.constructor.name}:${name}:${size}:${pc}`;
}

function getPageCache(key: string): Map<number, ImageBitmap> {
  if (!thumbCache.has(key)) thumbCache.set(key, new Map());
  return thumbCache.get(key)!;
}

function clearOldCache(newKey: string) {
  for (const [key, bitmaps] of thumbCache) {
    if (key !== newKey) {
      bitmaps.forEach(bm => { try { bm.close(); } catch (_) {} });
      thumbCache.delete(key);
    }
  }
}

function getPdfDoc(): any | null { return (window as any).__tovPdfDoc ?? null; }

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useThumbnailRenderer(adapter: AdapterInstance | null) {
  const canvasMap     = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const inFlight      = useRef(false);
  // Separate Set + Array for O(1) membership + ordered drain
  const qHighSet      = useRef<Set<number>>(new Set());
  const qHighArr      = useRef<number[]>([]);
  const qLowSet       = useRef<Set<number>>(new Set());
  const qLowArr       = useRef<number[]>([]);
  const rafHandle     = useRef(0);
  const idleHandle    = useRef<number>(0);
  const observer      = useRef<IntersectionObserver | null>(null);
  const visibleRange  = useRef<[number, number]>([1, 1]);
  const adapterKeyRef = useRef('');
  const running       = useRef(false);
  const lastInteract  = useRef(0);

  // ── Cache helpers ──────────────────────────────────────────────────────────

  function isRendered(p: number) {
    return thumbCache.get(adapterKeyRef.current)?.has(p) ?? false;
  }
  function getCached(p: number) {
    return thumbCache.get(adapterKeyRef.current)?.get(p);
  }
  function store(p: number, bm: ImageBitmap) {
    getPageCache(adapterKeyRef.current).set(p, bm);
  }
  function paintFromCache(p: number, canvas: HTMLCanvasElement): boolean {
    const bm = getCached(p);
    if (!bm) return false;
    canvas.width = bm.width; canvas.height = bm.height;
    canvas.getContext('2d')?.drawImage(bm, 0, 0);
    return true;
  }

  // ── Queue — O(1) ──────────────────────────────────────────────────────────

  // NOTE: inFlight does NOT block enqueue here — visible pages must always queue
  function enqueueHigh(p: number) {
    if (isRendered(p)) return;
    if (qHighSet.current.has(p)) return;
    // Remove from low if it was there (promote to high)
    if (qLowSet.current.has(p)) {
      qLowSet.current.delete(p);
      const i = qLowArr.current.indexOf(p);
      if (i !== -1) qLowArr.current.splice(i, 1);
    }
    qHighSet.current.add(p);
    qHighArr.current.push(p);
  }

  function enqueueLow(p: number) {
    if (isRendered(p)) return;
    if (qHighSet.current.has(p) || qLowSet.current.has(p)) return;
    qLowSet.current.add(p);
    qLowArr.current.push(p);
  }

  function enqueueRange(first: number, last: number, priority: 'high' | 'low') {
    for (let p = first; p <= last; p++) {
      priority === 'high' ? enqueueHigh(p) : enqueueLow(p);
    }
  }

  function clearQueues() {
    qHighSet.current.clear(); qHighArr.current = [];
    qLowSet.current.clear();  qLowArr.current  = [];
  }

  function kick() {
    if (!running.current) {
      running.current = true;
      rafHandle.current = requestAnimationFrame(runOne);
    }
  }

  // ── Core: render ONE page then yield ──────────────────────────────────────

  async function runOne() {
    if (!running.current) return;

    // Pick next page: high first, then low
    let page: number | undefined;

    // Drain stale high entries
    while (qHighArr.current.length) {
      const c = qHighArr.current[0];
      if (isRendered(c)) { qHighArr.current.shift(); qHighSet.current.delete(c); continue; }
      page = qHighArr.current.shift(); qHighSet.current.delete(page!); break;
    }

    // If no high-priority, check interaction pause before draining low
    if (page === undefined) {
      const idle = performance.now() - lastInteract.current > INTERACTION_PAUSE;
      if (!idle) {
        // User recently interacted — reschedule check after pause expires
        const wait = INTERACTION_PAUSE - (performance.now() - lastInteract.current);
        idleHandle.current = setTimeout(() => {
          if (running.current) rafHandle.current = requestAnimationFrame(runOne);
        }, wait) as unknown as number;
        return;
      }
      // Drain low priority during idle
      while (qLowArr.current.length) {
        const c = qLowArr.current[0];
        if (isRendered(c)) { qLowArr.current.shift(); qLowSet.current.delete(c); continue; }
        page = qLowArr.current.shift(); qLowSet.current.delete(page!); break;
      }
    }

    if (page === undefined) { running.current = false; return; }

    // Skip if already in-flight
    if (inFlight.current) {
      // Put back at front of appropriate queue and retry next frame
      qHighArr.current.unshift(page); qHighSet.current.add(page);
      rafHandle.current = requestAnimationFrame(runOne);
      return;
    }

    inFlight.current = true;
    try {
      const bm = await renderToBitmap(page, adapter);
      if (bm) {
        store(page, bm);
        const cv = canvasMap.current.get(page);
        if (cv) { cv.width = bm.width; cv.height = bm.height; cv.getContext('2d')?.drawImage(bm, 0, 0); }
      }
    } catch (_) {
      // Will retry on next scroll or onPageRendered
    } finally {
      inFlight.current = false;
    }

    // Schedule next — always yield a full frame between renders
    const hasMore = qHighArr.current.length > 0 || qLowArr.current.length > 0;
    if (hasMore) {
      rafHandle.current = requestAnimationFrame(runOne);
    } else {
      running.current = false;
    }
  }

  // ── IntersectionObserver ───────────────────────────────────────────────────

  function setupObserver(scrollRoot: Element) {
    observer.current?.disconnect();
    const pageCount = adapter?.pageCount ?? 0;

    observer.current = new IntersectionObserver(entries => {
      let anyNew = false;
      const visible: number[] = [];

      for (const e of entries) {
        const p = Number((e.target as HTMLElement).dataset.thumbPage);
        if (!p) continue;
        if (e.isIntersecting) {
          visible.push(p);
          if (!isRendered(p)) { enqueueHigh(p); anyNew = true; }
        }
      }
      if (!visible.length) return;

      const sorted = visible.sort((a, b) => a - b);
      const first = sorted[0], last = sorted[sorted.length - 1];
      visibleRange.current = [first, last];

      // Preload a narrow window around visible — reduced from 8 to 3
      const f = Math.max(1, first - PRELOAD_AHEAD);
      const l = Math.min(pageCount, last + PRELOAD_AHEAD);
      for (let p = f; p <= l; p++) {
        if (!isRendered(p) && !qHighSet.current.has(p)) enqueueLow(p);
      }

      if (anyNew || qHighArr.current.length > 0) kick();
    }, { root: scrollRoot, threshold: 0.01 });

    canvasMap.current.forEach(canvas => {
      const w = canvas.closest('[data-thumb-page]') as HTMLElement | null;
      if (w) observer.current!.observe(w);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  const registerThumb = (
    page: number, canvas: HTMLCanvasElement | null, scrollRoot?: Element | null,
  ) => {
    if (!canvas) return;
    canvasMap.current.set(page, canvas);
    if (paintFromCache(page, canvas)) return;
    if (scrollRoot && !observer.current) setupObserver(scrollRoot);
    const w = canvas.closest('[data-thumb-page]') as HTMLElement | null;
    if (w && observer.current) observer.current.observe(w);
    const [vf, vl] = visibleRange.current;
    if (page >= vf - 2 && page <= vl + 2) { enqueueHigh(page); kick(); }
  };

  const unregisterThumb = (page: number, canvas: HTMLCanvasElement | null) => {
    canvasMap.current.delete(page);
    if (canvas) {
      const w = canvas.closest('[data-thumb-page]') as HTMLElement | null;
      if (w && observer.current) observer.current.unobserve(w);
    }
  };

  // ── Lifecycle effects ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!adapter) return;
    const key = getAdapterKey(adapter);
    if (key === currentAdapterKey && key === adapterKeyRef.current) return;
    clearOldCache(key);
    currentAdapterKey = key;
    adapterKeyRef.current = key;
    inFlight.current = false;
    clearQueues();
    running.current = false;
    cancelAnimationFrame(rafHandle.current);
    clearTimeout(idleHandle.current);
    observer.current?.disconnect();
    observer.current = null;
    canvasMap.current.clear();
  }, [adapter]);

  useEffect(() => {
    if (!adapter || typeof (adapter as any).onPageRendered !== 'function') return;
    const cb = (page: number) => {
      if (!canvasMap.current.has(page)) return;
      thumbCache.get(adapterKeyRef.current)?.delete(page);
      enqueueHigh(page);
      kick();
    };
    (adapter as any).onPageRendered(cb);
    return () => { (adapter as any).offPageRendered?.(cb); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  // Background sweep — only for small docs, long initial delay
  useEffect(() => {
    if (!adapter) return;
    const pageCount = adapter.pageCount ?? 0;
    if (pageCount === 0 || pageCount > BG_SWEEP_MAX_PAGES) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const go = () => {
      if (cancelled) return;
      let p = 1;
      const step = () => {
        if (cancelled) return;
        for (let i = 0; i < 3 && p <= pageCount; i++, p++) {
          if (!isRendered(p)) enqueueLow(p);
        }
        if (p <= pageCount) timer = setTimeout(step, 400);
        if (qLowArr.current.length > 0 && !running.current) kick();
      };
      timer = setTimeout(step, 3000); // 3s initial delay — visible pages first
    };

    if (typeof (adapter as any).onReady === 'function') {
      (adapter as any).onReady(go);
    } else {
      timer = setTimeout(go, 1000);
    }

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  // Track interactions to pause bg renders
  useEffect(() => {
    const mark = () => { lastInteract.current = performance.now(); };
    const opts = { passive: true };
    window.addEventListener('mousedown', mark, opts);
    window.addEventListener('keydown',   mark, opts);
    window.addEventListener('touchstart',mark, opts);
    window.addEventListener('wheel',     mark, opts);
    return () => {
      window.removeEventListener('mousedown', mark);
      window.removeEventListener('keydown',   mark);
      window.removeEventListener('touchstart',mark);
      window.removeEventListener('wheel',     mark);
    };
  }, []);

  useEffect(() => {
    return () => {
      observer.current?.disconnect();
      cancelAnimationFrame(rafHandle.current);
      clearTimeout(idleHandle.current);
      running.current = false;
    };
  }, []);

  return { registerThumb, unregisterThumb };
}

// ── renderToBitmap ────────────────────────────────────────────────────────────

async function renderToBitmap(
  page: number, adapter: AdapterInstance | null,
): Promise<ImageBitmap | null> {
  if (!adapter) return null;

  // ── PDF ──────────────────────────────────────────────────────────────────
  if (adapter.constructor.name === 'PDFAdapter') {
    // Wait briefly for pdfDoc to be available if not ready yet
    // This handles the timing gap between workerReady and document load in ECS
    let pdfDoc = getPdfDoc();
    if (!pdfDoc) {
      await new Promise(r => setTimeout(r, 500));
      pdfDoc = getPdfDoc();
    }
    if (!pdfDoc) return null;

    const pdfPage  = await pdfDoc.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const scale    = THUMB_W / viewport.width;
    const vp       = pdfPage.getViewport({ scale });
    const w        = Math.round(vp.width);
    const h        = Math.round(vp.height);

    const offscreen = new OffscreenCanvas(w, h);
    const ctx = offscreen.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    // 'print' intent uses a separate render queue from the main viewer's 'display' queue
    // so thumbnails never compete with or block the main page render in ECS/OpenShift
    await pdfPage.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    // Critical: release pdfjs page resources immediately — prevents memory leak
    pdfPage.cleanup();
    return offscreen.transferToImageBitmap();
  }

  // ── TIF / Image ──────────────────────────────────────────────────────────
  if (adapter.constructor.name === 'ImageAdapter') {
    const frame = await (adapter as ImageAdapter).getFrameAsync(page);
    if (!frame) return null;
    const scale = THUMB_W / frame.width;
    const w = THUMB_W, h = Math.round(frame.height * scale);
    const offscreen = new OffscreenCanvas(w, h);
    (offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D)
      .drawImage(frame.bitmap, 0, 0, w, h);
    return offscreen.transferToImageBitmap();
  }

  // ── Doc / Spreadsheet ────────────────────────────────────────────────────
  const src = adapter.getPageCanvas?.(page);
  if (!src || src.width === 0 || src.height === 0) throw new Error(`canvas-not-ready:${page}`);
  const scale = THUMB_W / src.width;
  const w = THUMB_W, h = Math.round(src.height * scale);
  const offscreen = new OffscreenCanvas(w, h);
  (offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D)
    .drawImage(src, 0, 0, w, h);
  return offscreen.transferToImageBitmap();
}
