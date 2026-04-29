// ─────────────────────────────────────────────────────────────────────────────
// useThumbnailRenderer  v5
//
// FIXES vs previous:
//   • inFlight deadlock removed — when render in-flight, skip scheduling entirely;
//     the in-flight render's finally block calls scheduleNext itself
//   • doRender moved ABOVE the return so it's always in scope (no hoisting ambiguity)
//   • processOne is a stable ref so setTimeout captures the correct closure
//   • kick() is idempotent: sets timer only when both !running and !timer
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../store/appStore';
import { useAppStore } from '../store/appStore';
import type { AdapterInstance } from '../store/appStore';
import type { ImageAdapter } from '../adapters/ImageAdapter';

const THUMB_W           = 96;
const PRELOAD_AHEAD     = 2;
const BG_MAX_PAGES      = 1000;
const INTERACTION_PAUSE = 800;

// ── Module-scope cache ────────────────────────────────────────────────────────
const thumbCache = new Map<string, Map<number, ImageBitmap>>();
let   currentAdapterKey = '';

export const THUMB_W_EXPORT = THUMB_W;

export function getCachedBitmap(key: string, page: number): ImageBitmap | undefined {
  return thumbCache.get(key)?.get(page);
}
export function setCachedBitmap(key: string, page: number, bm: ImageBitmap) {
  if (!thumbCache.has(key)) thumbCache.set(key, new Map());
  thumbCache.get(key)!.set(page, bm);
}
export function hasCachedBitmap(key: string, page: number): boolean {
  return thumbCache.get(key)?.has(page) ?? false;
}

function getAdapterKey(adapter: AdapterInstance | null): string {
  if (!adapter) return '';
  const s = useAppStore.getState();
  return `${adapter.constructor.name}:${s.fileName}:${s.file?.size ?? 0}:${adapter.pageCount ?? 0}`;
}

const MAX_CACHED_BITMAPS = 400;

function clearOldCaches(keepKey: string) {
  let total = 0;
  for (const bitmaps of thumbCache.values()) total += bitmaps.size;
  if (total <= MAX_CACHED_BITMAPS) return;
  for (const [k, bitmaps] of thumbCache) {
    if (k === keepKey) continue;
    bitmaps.forEach(bm => { try { bm.close(); } catch (_) {} });
    thumbCache.delete(k);
    total -= bitmaps.size;
    if (total <= MAX_CACHED_BITMAPS) break;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useThumbnailRenderer(adapter: AdapterInstance | null) {
  const canvasMap    = useRef(new Map<number, HTMLCanvasElement>());
  const adapterKey   = useRef('');
  const highSet      = useRef(new Set<number>());
  const highArr      = useRef<number[]>([]);
  const lowSet       = useRef(new Set<number>());
  const lowArr       = useRef<number[]>([]);
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running      = useRef(false);
  const inFlight     = useRef(false);
  const observer     = useRef<IntersectionObserver | null>(null);
  const lastInteract = useRef(0);
  const visiblePages = useRef(new Set<number>());
  const adapterRef   = useRef(adapter);

  // Keep adapterRef current on every render
  adapterRef.current = adapter;

  // ── Cache helpers ──────────────────────────────────────────────────────────
  const isRendered = useCallback((p: number) =>
    thumbCache.get(adapterKey.current)?.has(p) ?? false, []);

  const paintFromCache = useCallback((p: number, cv: HTMLCanvasElement): boolean => {
    const bm = thumbCache.get(adapterKey.current)?.get(p);
    if (!bm) return false;
    cv.width = bm.width; cv.height = bm.height;
    cv.getContext('2d')?.drawImage(bm, 0, 0);
    return true;
  }, []);

  const storeBitmap = useCallback((p: number, bm: ImageBitmap) => {
    const key = adapterKey.current;
    if (!thumbCache.has(key)) thumbCache.set(key, new Map());
    thumbCache.get(key)!.set(p, bm);
  }, []);

  // ── Queue ──────────────────────────────────────────────────────────────────
  const enqHigh = useCallback((p: number) => {
    if (isRendered(p) || highSet.current.has(p)) return;
    if (lowSet.current.has(p)) {
      lowSet.current.delete(p);
      const i = lowArr.current.indexOf(p);
      if (i !== -1) lowArr.current.splice(i, 1);
    }
    highSet.current.add(p); highArr.current.push(p);
  }, [isRendered]);

  const enqLow = useCallback((p: number) => {
    if (isRendered(p) || highSet.current.has(p) || lowSet.current.has(p)) return;
    lowSet.current.add(p); lowArr.current.push(p);
  }, [isRendered]);

  const clearQueues = useCallback(() => {
    highSet.current.clear(); highArr.current = [];
    lowSet.current.clear();  lowArr.current  = [];
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    running.current = false;
    inFlight.current = false;
  }, []);

  // ── Render one page to ImageBitmap ─────────────────────────────────────────
  // Defined BEFORE processOne so it's always in scope
  const doRender = useCallback(async (page: number): Promise<ImageBitmap | null> => {
    const ad = adapterRef.current;
    if (!ad) return null;

    if (ad.constructor.name === 'PDFAdapter') {
      const doc = (window as any).__tovPdfDoc;
      if (!doc) return null;
      const pdfPage = await doc.getPage(page);
      const vp0 = pdfPage.getViewport({ scale: 1 });
      const vp  = pdfPage.getViewport({ scale: THUMB_W / vp0.width });
      const offscreen = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));
      const ctx = offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D;
      await pdfPage.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
      pdfPage.cleanup();
      return offscreen.transferToImageBitmap();
    }

    if (ad.constructor.name === 'ImageAdapter') {
      const frame = await (ad as ImageAdapter).getFrameAsync(page);
      if (!frame) return null;
      const scale = THUMB_W / frame.width;
      const h = Math.round(frame.height * scale);
      const offscreen = new OffscreenCanvas(THUMB_W, h);
      (offscreen.getContext('2d') as any).drawImage(frame.bitmap, 0, 0, THUMB_W, h);
      return offscreen.transferToImageBitmap();
    }

    const src = ad.getPageCanvas?.(page);
    if (!src || src.width === 0 || src.height === 0) throw new Error(`canvas-not-ready:${page}`);
    const h = Math.round(src.height * THUMB_W / src.width);
    const offscreen = new OffscreenCanvas(THUMB_W, h);
    (offscreen.getContext('2d') as any).drawImage(src, 0, 0, THUMB_W, h);
    return offscreen.transferToImageBitmap();
  }, []); // adapterRef is a stable ref, no deps needed

  // ── Scheduler ─────────────────────────────────────────────────────────────
  // processOne is a stable function ref stored in processOneRef so setTimeout
  // always calls the latest version without re-capturing stale closures.
  const processOneRef = useRef<() => Promise<void>>(async () => {});

  const scheduleNext = useCallback(() => {
    // Only schedule if not already scheduled and not currently running
    if (timerRef.current !== null) return;
    if (inFlight.current) return; // in-flight render will schedule next itself
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      processOneRef.current();
    }, 0);
  }, []);

  const kick = useCallback(() => {
    if (running.current && timerRef.current !== null) return; // already scheduled
    if (running.current && inFlight.current) return; // in-flight, will self-schedule
    running.current = true;
    scheduleNext();
  }, [scheduleNext]);

  // Main process function — defined with useCallback so it's stable
  const processOne = useCallback(async () => {
    if (!running.current) return;

    // Pick next page
    let page: number | undefined;

    while (highArr.current.length) {
      const c = highArr.current[0];
      if (isRendered(c)) { highArr.current.shift(); highSet.current.delete(c); continue; }
      page = highArr.current.shift(); highSet.current.delete(page!); break;
    }

    if (page === undefined) {
      const sinceLast = performance.now() - lastInteract.current;
      if (sinceLast < INTERACTION_PAUSE) {
        // Pause bg renders — reschedule after pause expires
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          processOneRef.current();
        }, INTERACTION_PAUSE - sinceLast);
        return;
      }
      while (lowArr.current.length) {
        const c = lowArr.current[0];
        if (isRendered(c)) { lowArr.current.shift(); lowSet.current.delete(c); continue; }
        page = lowArr.current.shift(); lowSet.current.delete(page!); break;
      }
    }

    if (page === undefined) {
      // Queue empty — stop
      running.current = false;
      return;
    }

    // Render the page
    inFlight.current = true;
    try {
      const bm = await doRender(page);
      if (bm) {
        storeBitmap(page, bm);
        const cv = canvasMap.current.get(page);
        if (cv) { cv.width = bm.width; cv.height = bm.height; cv.getContext('2d')?.drawImage(bm, 0, 0); }
      }
    } catch (_) {
      // Skip silently — page will retry on next scroll
    } finally {
      inFlight.current = false;
    }

    // Self-schedule next — this is the only scheduling path after a render completes
    if (highArr.current.length > 0 || lowArr.current.length > 0) {
      scheduleNext();
    } else {
      running.current = false;
    }
  }, [isRendered, doRender, storeBitmap, scheduleNext]);

  // Keep the ref up to date
  processOneRef.current = processOne;

  // ── IntersectionObserver ───────────────────────────────────────────────────
  const setupObserver = useCallback((scrollRoot: Element) => {
    observer.current?.disconnect();
    const pageCount = adapterRef.current?.pageCount ?? 0;

    observer.current = new IntersectionObserver(entries => {
      let any = false;
      for (const e of entries) {
        const p = Number((e.target as HTMLElement).dataset.thumbPage);
        if (!p) continue;
        if (e.isIntersecting) {
          visiblePages.current.add(p);
          if (!isRendered(p)) { enqHigh(p); any = true; }
        } else {
          visiblePages.current.delete(p);
        }
      }

      // Preload narrow window around visible
      const vp = [...visiblePages.current].sort((a, b) => a - b);
      if (vp.length) {
        const lo = Math.max(1, vp[0] - PRELOAD_AHEAD);
        const hi = Math.min(pageCount, vp[vp.length - 1] + PRELOAD_AHEAD);
        for (let p = lo; p <= hi; p++) enqLow(p);
      }

      if (any) kick();
    }, { root: scrollRoot, threshold: 0.01 });

    canvasMap.current.forEach((cv) => {
      const el = cv.closest('[data-thumb-page]') as HTMLElement | null;
      if (el) observer.current!.observe(el);
    });
  }, [isRendered, enqHigh, enqLow, kick]);

  // ── Public API ─────────────────────────────────────────────────────────────
  const registerThumb = useCallback((
    page: number, canvas: HTMLCanvasElement | null, scrollRoot?: Element | null,
  ) => {
    if (!canvas) return;
    canvasMap.current.set(page, canvas);
    if (paintFromCache(page, canvas)) return;
    if (scrollRoot && !observer.current) setupObserver(scrollRoot);
    const el = canvas.closest('[data-thumb-page]') as HTMLElement | null;
    if (el && observer.current) observer.current.observe(el);
    // Enqueue if within estimated visible window
    const vp = [...visiblePages.current];
    const lo = (vp.length ? Math.min(...vp) : 1) - 2;
    const hi = (vp.length ? Math.max(...vp) : 1) + 2;
    if (page >= lo && page <= hi) { enqHigh(page); kick(); }
  }, [paintFromCache, setupObserver, enqHigh, kick]);

  const unregisterThumb = useCallback((page: number, canvas: HTMLCanvasElement | null) => {
    canvasMap.current.delete(page);
    visiblePages.current.delete(page);
    if (canvas) {
      const el = canvas.closest('[data-thumb-page]') as HTMLElement | null;
      if (el && observer.current) observer.current.unobserve(el);
    }
  }, []);

  // ── Effects ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!adapter) return;
    const key = getAdapterKey(adapter);
    if (key === currentAdapterKey && key === adapterKey.current) return;
    clearOldCaches(key);
    currentAdapterKey = key;
    adapterKey.current = key;
    clearQueues();
    visiblePages.current.clear();
    observer.current?.disconnect();
    observer.current = null;
    canvasMap.current.clear();
  }, [adapter, clearQueues]);

  useEffect(() => {
    if (!adapter || typeof (adapter as any).onPageRendered !== 'function') return;
    const cb = (p: number) => {
      thumbCache.get(adapterKey.current)?.delete(p);
      if (canvasMap.current.has(p)) { enqHigh(p); kick(); }
    };
    (adapter as any).onPageRendered(cb);
    return () => (adapter as any).offPageRendered?.(cb);
  }, [adapter, enqHigh, kick]);

  // Subscribe to store pageCount — re-runs sweep effect when pageCount becomes non-zero
  // Fixes timing gap in deployed env where adapter is set before pageCount is set
  const storePageCount = useAppStore(s => s.pageCount);

  useEffect(() => {
    if (!adapter) return;
    const pc = storePageCount || (adapter.pageCount ?? 0);
    if (pc === 0 || pc > BG_MAX_PAGES) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const go = () => {
      if (cancelled) return;
      const total = storePageCount || (adapter.pageCount ?? 0);
      let p = 1;
      const step = () => {
        if (cancelled) return;
        for (let i = 0; i < 5 && p <= total; i++, p++) enqLow(p);
        if (p <= total) t = setTimeout(step, 500);
        kick();
      };
      t = setTimeout(step, 4000);
    };
    if (typeof (adapter as any).onReady === 'function') {
      (adapter as any).onReady(go);
    } else {
      t = setTimeout(go, 1500);
    }
    return () => { cancelled = true; if (t) clearTimeout(t); };
  }, [adapter, storePageCount, enqLow, kick]);

  useEffect(() => {
    const mark = () => { lastInteract.current = performance.now(); };
    const o = { passive: true };
    window.addEventListener('mousedown', mark, o);
    window.addEventListener('keydown',   mark, o);
    window.addEventListener('touchstart',mark, o);
    window.addEventListener('wheel',     mark, o);
    return () => {
      window.removeEventListener('mousedown', mark);
      window.removeEventListener('keydown',   mark);
      window.removeEventListener('touchstart',mark);
      window.removeEventListener('wheel',     mark);
    };
  }, []);

  useEffect(() => () => {
    observer.current?.disconnect();
    clearQueues();
  }, [clearQueues]);

  return { registerThumb, unregisterThumb };
}
