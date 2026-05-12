import { create } from 'zustand';
import type { CaptureItem, Category, WordEntry } from '../adapters/types';
import type { DocumentManifest, MultiDocState } from '../types/multiDoc';
import { detectFormat } from '../adapters/types';

export type AdapterInstance = import('../adapters/PDFAdapter').PDFAdapter | import('../adapters/ImageAdapter').ImageAdapter | import('../adapters/SpreadsheetAdapter').SpreadsheetAdapter | import('../adapters/DocAdapter').DocAdapter;

interface HighlightRect {
  x: number; y: number; width: number; height: number;
  id: string; color?: string; type?: 'external';
}

export interface PendingCapture {
  text: string; page: number;
  x: number; y: number; width: number; height: number;
  // Which JSON key held the text in the word_index source (propagated to submit)
  _textField?: 'text' | 'label' | 'value';
  // Which coord format was used in the source JSON — preserved in draft & export
  sourceFormat?: 'flat' | 'bbox' | 'rectangle' | 'coordinates';
}

export interface SearchState {
  query: string;
  matchCase: boolean;
  matchType: 'exact' | 'contains';
  highlightAll: boolean;
  results: Array<{ page: number; x: number; y: number; width: number; height: number; text: string }>;
  currentIndex: number; // -1 = none
  isOpen: boolean;
}

interface AppState {
  // ── Document ──
  file: File | null;
  fileName: string;
  format: ReturnType<typeof detectFormat>;
  adapter: AdapterInstance | null;
  isLoading: boolean;
  loadError: string | null;

  // ── Box Mode ──
  boxMode: boolean;
  annotateMode: boolean;
  renderProgress: number;   // 0 = idle, 1–99 = rendering, 100 = done

  // ── Sidebar ──
  sidebarOpen: boolean;
  enableCaptureDebug: boolean;  // show right-side panel — set by parent
  enableAnnotation:    boolean;  // show annotation/draw button — set by parent
  enableThumbnailView: boolean;  // show thumbnail icon + sidebar — set by parent (default true)
  sidebarTab: 'thumbnails' | 'outline';

  // ── Current page ──
  currentPage: number;

  // ── Rotation (degrees: 0 | 90 | 180 | 270) ──
  rotation: 0 | 90 | 180 | 270;

  // ── Zoom ──
  zoom: number;
  zoomMode: 'custom' | 'page-fit' | 'page-width' | 'actual';

  // ── Search ──
  search: SearchState;

  pageCount: number;

  // ── Captures ──
  captures: CaptureItem[];
  activeFieldId: string | null;
  pendingCapture: PendingCapture | null;

  // ── JSON sidecar data ──
  wordIndex: Map<number, WordEntry[]>;
  categories: Category[];
  highlightIndex: Map<number, HighlightRect[]>;

  // ── Preview pulse ──
  previewRect: { page: number; x: number; y: number; width: number; height: number } | null;

  // ── Multi-doc mode ──
  multiDocState: MultiDocState | null;
  multiDocLoading: boolean;
  multiDocError: string | null;
  multiDocActiveFile: File | null;

  // ── Actions ──
  openFile(file: File): Promise<void>;
  closeFile(): void;
  setBoxMode(on: boolean): void;
  setEnableCaptureDebug(on: boolean): void;
  setEnableAnnotation(on: boolean): void;
  setEnableThumbnailView(on: boolean): void;
  setAnnotateMode(on: boolean): void;
  setRenderProgress(n: number): void;
  setSidebarOpen(open: boolean): void;
  setSidebarTab(tab: 'thumbnails' | 'outline'): void;
  setCurrentPage(page: number): void;
  setZoom(z: number): void;
  setZoomMode(mode: AppState['zoomMode'], containerW?: number, containerH?: number, pageW?: number, pageH?: number): void;
  rotateCW(): void;
  rotateCCW(): void;
  downloadFile(): void;
  printDocument(): void;

  // Search
  setSearchOpen(open: boolean): void;
  setSearchQuery(q: string): void;
  setSearchOption(key: keyof Pick<SearchState,'matchCase'|'matchType'|'highlightAll'>, value: boolean | 'exact' | 'contains'): void;
  runSearch(): void;
  searchNext(): void;
  searchPrev(): void;
  clearSearch(): void;

  setPageCount(n: number): void;
  addCapture(item: CaptureItem): void;
  replaceCapture(item: CaptureItem): void;
  removeCapture(id: string): void;
  addCaptureWithId(item: CaptureItem): void;
  addCaptureWithIdSilent(item: CaptureItem): void;
  navigateAndHighlight(id: string): boolean;
  openFileBuffer(buffer: ArrayBuffer, fileName: string): Promise<void>;
  deleteCapture(id: string): void;
  setActiveField(id: string | null): void;
  setPendingCapture(p: PendingCapture | null): void;
  clearPendingCapture(): void;
  setWordIndex(map: Map<number, WordEntry[]>): void;
  setCategories(cats: Category[]): void;
  setPreviewRect(rect: AppState['previewRect']): void;
  clearPreviewRect(): void;
  _rebuildHighlightIndex(): void;

  // Multi-doc actions
  setMultiDocState(state: MultiDocState | null): void;
  setMultiDocLoading(v: boolean): void;
  setMultiDocError(e: string | null): void;
  setMultiDocActiveFile(f: File | null): void;
  clearMultiDoc(): void;
  /**
   * Registers a callback for when a manifest JSON is dropped.
   * Called synchronously by SidecarLoader — no timing issues.
   */
  _manifestHandler: ((manifest: DocumentManifest) => void) | null;
  registerManifestHandler(fn: (manifest: DocumentManifest) => void): void;
}

const defaultSearch: SearchState = {
  query: '', matchCase: false, matchType: 'contains',
  highlightAll: true, results: [], currentIndex: -1, isOpen: false,
};

export const useAppStore = create<AppState>()((set, get) => ({
  file: null, fileName: '', format: 'unknown', adapter: null,
  isLoading: false, loadError: null,
  boxMode: false, annotateMode: false, renderProgress: 0, sidebarOpen: false, enableCaptureDebug: false, enableAnnotation: false, enableThumbnailView: true, sidebarTab: 'thumbnails',
  currentPage: 1, pageCount: 0, rotation: 0, zoom: 1.0, zoomMode: 'page-fit',
  search: defaultSearch,
  captures: [], activeFieldId: null, pendingCapture: null,
  wordIndex: new Map(), categories: [], highlightIndex: new Map(),
  previewRect: null,
  multiDocState: null, multiDocLoading: false, multiDocError: null, multiDocActiveFile: null,
  _manifestHandler: null,

  async openFile(file: File) {
    const { adapter: old } = get();
    if (old && 'dispose' in old) (old as any).dispose();
    const format = detectFormat(file.name);
    set({
      file, fileName: file.name, format, isLoading: true, loadError: null,
      captures: [], activeFieldId: null, pendingCapture: null,
      pageCount: 0,
      wordIndex: new Map(), categories: [], highlightIndex: new Map(),
      currentPage: 1, adapter: null, previewRect: null,
      rotation: 0, zoomMode: 'page-fit', zoom: 1.0,
      search: defaultSearch,
    });
    // Escape React 18 automatic batching — force the isLoading:true render to flush
    // BEFORE any heavy processing starts. Without this, React holds the state update
    // and the spinner never shows before the main thread is blocked.
    await new Promise<void>(r => setTimeout(r, 50));
    try {
      let adapter: AdapterInstance;
      if (format === 'pdf') {
        const { PDFAdapter } = await import('../adapters/PDFAdapter');
        adapter = new PDFAdapter();
      } else if (format === 'image') {
        const { ImageAdapter } = await import('../adapters/ImageAdapter');
        const ia = new ImageAdapter(); await ia.loadFile(file); adapter = ia;
      } else if (format === 'spreadsheet') {
        const { SpreadsheetAdapter } = await import('../adapters/SpreadsheetAdapter');
        const sa = new SpreadsheetAdapter(); await sa.loadFile(file);
        sa.navigateToPage = (page: number) => {
          const p = Math.max(1, Math.min(sa.pageCount, page));
          set({ currentPage: p });
        };
        adapter = sa;
        // Spreadsheet: 100% zoom by default (page-fit distorts grid)
        set({ zoom: 1.0, zoomMode: 'actual' });
      } else if (format === 'document') {
        const { DocAdapter } = await import('../adapters/DocAdapter');
        const da = new DocAdapter(); await da.loadFile(file);
        const wi = new Map<number, import('../adapters/types').WordEntry[]>();
        for (const e of da.getWordIndex()) {
          if (!wi.has(e.page)) wi.set(e.page, []);
          wi.get(e.page)!.push({ text: e.text, page: e.page, x: e.x, y: e.y, width: e.width, height: e.height });
        }
        if (wi.size > 0) set({ wordIndex: wi });
        set({ pageCount: da.pageCount });
        adapter = da;
      } else {
        const ext = file.name.split('.').pop() ?? 'unknown';
        set({ isLoading: false, loadError: `Unsupported or unreadable file format: .${ext}` });
        return;
      }
      set({ adapter, isLoading: false });
    } catch (err) { set({ isLoading: false, loadError: String(err) }); }
  },

  closeFile() {
    const { adapter } = get();
    if (adapter && 'dispose' in adapter) (adapter as any).dispose();
    set({
      file: null, fileName: '', format: 'unknown', adapter: null,
      isLoading: false, loadError: null, captures: [], activeFieldId: null,
      pageCount: 0,
      pendingCapture: null, wordIndex: new Map(), categories: [],
      highlightIndex: new Map(), currentPage: 1, previewRect: null,
      rotation: 0, zoom: 1.0,
      zoomMode: 'page-fit',
      search: defaultSearch,
    });
  },

  setBoxMode(on)       { set({ boxMode: on }); },
  setEnableCaptureDebug(on) { set({ enableCaptureDebug: on }); },
  setEnableAnnotation(on)      { set({ enableAnnotation: on }); },
  setEnableThumbnailView(on)   { set({ enableThumbnailView: on, sidebarOpen: false }); },
  setAnnotateMode(on)  { set({ annotateMode: on }); },
  setRenderProgress(n) { set({ renderProgress: n }); },
  setSidebarOpen(open) { set({ sidebarOpen: open }); },
  setSidebarTab(tab)   { set({ sidebarTab: tab }); },
  setCurrentPage(page) { set({ currentPage: page }); },

  setZoom(z) { set({ zoom: Math.max(0.1, Math.min(5, z)), zoomMode: 'custom' }); },

  setZoomMode(mode, containerW, containerH, pageW, pageH) {
    if (mode === 'actual') {
      set({ zoom: 1.0, zoomMode: 'actual' });
    } else if (mode === 'page-fit' && containerW && containerH && pageW && pageH) {
      // Subtract pdfjs page margins (5px top + 5px bottom = 10px per page gap)
      // and toolbar/padding allowance so the full page fits without any scroll.
      const effectiveH = containerH - 16;
      const z = Math.min((containerW - 20) / pageW, effectiveH / pageH);
      set({ zoom: Math.max(0.1, Math.min(5, z)), zoomMode: 'page-fit' });
    } else if (mode === 'page-width' && containerW && pageW) {
      const z = (containerW / pageW) * 0.97;
      set({ zoom: Math.max(0.1, z), zoomMode: 'page-width' });
    } else {
      set({ zoomMode: mode });
    }
  },

  rotateCW() {
    set(s => ({ rotation: ((s.rotation + 90) % 360) as 0|90|180|270 }));
  },
  rotateCCW() {
    set(s => ({ rotation: ((s.rotation + 270) % 360) as 0|90|180|270 }));
  },

  downloadFile() {
    const { file, fileName, adapter, format } = get();
    if (!file) return;

    import('../hooks/useAnnotation').then(({ hasAnyAnnotations, getAllStrokes }) => {
      const allStrokes = getAllStrokes();

      // Debug: log exact store contents
      console.log('[Download] annotationStore size:', allStrokes.size);
      allStrokes.forEach((strokes, key) => {
        console.log(`[Download]   key="${key}" strokes=${strokes.length}`);
      });

      if (!hasAnyAnnotations()) {
        console.log('[Download] No annotations — plain download');
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url; a.download = file.name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }

      import('../utils/annotationDownload').then(({ downloadWithAnnotations }) => {
        const pageCount = adapter?.pageCount ?? 1;

        // The annotation canvas covers the FULL viewer container (1536x785 etc).
        // Strokes are stored in container-relative coords.
        // The PDF baking needs BOTH:
        //   1. containerSize — to scale strokes correctly onto the page
        //   2. pageSize — the actual PDF page dimensions in the viewer
        const annotCanvas = document.querySelector<HTMLCanvasElement>('[data-annotation-canvas]');
        const containerW = annotCanvas ? (annotCanvas.clientWidth  || annotCanvas.width)  : 0;
        const containerH = annotCanvas ? (annotCanvas.clientHeight || annotCanvas.height) : 0;

        console.log('[Download] container:', `${containerW}x${containerH}`);

        // Get the pdfjs page canvas element — this is the actual rendered page area
        // Strokes outside this area are in the grey margin and won't appear on the page
        const viewer = (window as any).__tovPdfViewer;
        const getViewportSize = (page: number): { w: number; h: number; containerW: number; containerH: number } | null => {
          if (viewer) {
            try {
              const pv = viewer.getPageView(page - 1);
              if (pv?.canvas) {
                const c = pv.canvas;
                // CSS display size of the pdfjs canvas (matches stroke coordinate space)
                const pw = c.offsetWidth  || c.clientWidth  || c.width;
                const ph = c.offsetHeight || c.clientHeight || c.height;
                // Position of the page canvas within the viewer container
                const rect = c.getBoundingClientRect();
                const containerRect = annotCanvas?.getBoundingClientRect();
                const offsetX = containerRect ? rect.left - containerRect.left : 0;
                const offsetY = containerRect ? rect.top  - containerRect.top  : 0;
                console.log(`[Download] page ${page} canvas: ${pw}x${ph} offset: ${Math.round(offsetX)},${Math.round(offsetY)}`);
                return { w: pw, h: ph, containerW: containerW || pw, containerH: containerH || ph };
              }
              if (pv?.viewport) {
                const vw = Math.round(pv.viewport.width);
                const vh = Math.round(pv.viewport.height);
                return { w: vw, h: vh, containerW: containerW || vw, containerH: containerH || vh };
              }
            } catch (_) {}
          }
          if (containerW > 0) return { w: containerW, h: containerH, containerW, containerH };
          return null;
        };

        console.log('[Download] Calling downloadWithAnnotations, format:', format, 'pageCount:', pageCount);
        downloadWithAnnotations(file, format ?? 'pdf', allStrokes, pageCount, getViewportSize);
      });
    });
  },

  printDocument() {
    const { format, adapter, fileName } = get();
    import('../utils/print').then(({ printCurrentDocument }) => {
      printCurrentDocument(format, adapter, fileName);
    });
  },

  // ── Search ──────────────────────────────────────────────────────────────────
  setSearchOpen(open) { set(s => ({ search: { ...s.search, isOpen: open } })); },
  setSearchQuery(q)   {
    set(s => ({
      search: {
        ...s.search,
        query: q,
        // Clear previous results when query changes so Enter triggers fresh search
        results: q !== s.search.query ? [] : s.search.results,
        currentIndex: q !== s.search.query ? -1 : s.search.currentIndex,
      },
    }));
  },
  setSearchOption(key, value) {
    set(s => ({ search: { ...s.search, [key]: value } }));
  },

  runSearch() {
    const { search, wordIndex, adapter, format, zoom } = get();
    const q = search.matchCase ? search.query : search.query.toLowerCase();
    if (!q.trim()) { set(s => ({ search: { ...s.search, results: [], currentIndex: -1 } })); return; }

    const results: SearchState['results'] = [];

    // ── For spreadsheets: scan td[data-cell-text] ────────────────────────────
    if (format === 'spreadsheet') {
      const pageEls = document.querySelectorAll<HTMLElement>('[data-page-number]');
      for (const pageEl of pageEls) {
        const page = Number(pageEl.dataset.pageNumber);
        const table = pageEl.querySelector<HTMLTableElement>('table');
        if (!table) continue;
        const tRect = table.getBoundingClientRect();
        const naturalW = tRect.width  / zoom;
        const naturalH = tRect.height / zoom;
        const cells = table.querySelectorAll<HTMLTableCellElement>('td[data-cell-text]');
        for (const cell of cells) {
          const txt = cell.dataset.cellText ?? '';
          if (!txt) continue;
          const t = search.matchCase ? txt : txt.toLowerCase();
          const match = search.matchType === 'exact' ? t === q : t.includes(q);
          if (!match) continue;
          const cRect = cell.getBoundingClientRect();
          results.push({
            page,
            x:      ((cRect.left - tRect.left) / zoom) / naturalW,
            y:      ((cRect.top  - tRect.top)  / zoom) / naturalH,
            width:  (cRect.width  / zoom) / naturalW,
            height: (cRect.height / zoom) / naturalH,
            text: txt,
          });
        }
      }
      results.sort((a, b) => a.page !== b.page ? a.page - b.page : a.y !== b.y ? a.y - b.y : a.x - b.x);
      const currentIndex = results.length > 0 ? 0 : -1;
      set(s => ({ search: { ...s.search, results, currentIndex } }));
      if (results.length > 0) {
        const first = results[0];
        get().adapter?.navigateToPage(first.page);
        get().setPreviewRect({ page: first.page, x: first.x, y: first.y, width: first.width, height: first.height });
      }
      return;
    }

    // ── PDF / Image: word index then DOM spans ────────────────────────────────
    for (const [page, entries] of wordIndex) {
      if (!Array.isArray(entries)) continue; // guard against malformed data
      for (const e of entries) {
        const t = search.matchCase ? e.text : e.text.toLowerCase();
        const match = search.matchType === 'exact' ? t === q : t.includes(q);
        if (match) results.push({ page, x: e.x, y: e.y, width: e.width, height: e.height, text: e.text });
      }
    }

    if (!results.length && adapter) {
      const pageEls = document.querySelectorAll<HTMLElement>('[data-page-number]');
      for (const pageEl of pageEls) {
        const page = Number(pageEl.dataset.pageNumber);
        const inner = pageEl.querySelector('canvas:not([data-hl-canvas])') as HTMLElement ?? pageEl;
        const rect  = inner.getBoundingClientRect();
        const spans = pageEl.querySelectorAll<HTMLElement>('span, [data-json-word]');
        for (const sp of spans) {
          const txt = (sp.dataset.jsonWord ?? sp.textContent ?? '').trim();
          if (!txt) continue;
          const t = search.matchCase ? txt : txt.toLowerCase();
          const match = search.matchType === 'exact' ? t === q : t.includes(q);
          if (match) {
            const r = sp.getBoundingClientRect();
            results.push({
              page,
              x: (r.left - rect.left) / rect.width,
              y: (r.top  - rect.top)  / rect.height,
              width:  r.width  / rect.width,
              height: r.height / rect.height,
              text: txt,
            });
          }
        }
      }
    }

    results.sort((a, b) => a.page !== b.page ? a.page - b.page : a.y !== b.y ? a.y - b.y : a.x - b.x);
    const currentIndex = results.length > 0 ? 0 : -1;
    set(s => ({ search: { ...s.search, results, currentIndex } }));
    if (results.length > 0) {
      const first = results[0];
      get().adapter?.navigateToPage(first.page);
      get().setPreviewRect({ page: first.page, x: first.x, y: first.y, width: first.width, height: first.height });
    }
  },

  searchNext() {
    const { search, format, zoom } = get();
    if (!search.results.length) return;
    const idx = (search.currentIndex + 1) % search.results.length;
    const r = search.results[idx];
    set(s => ({ search: { ...s.search, currentIndex: idx } }));
    get().adapter?.navigateToPage(r.page);
    get().setPreviewRect({ page: r.page, x: r.x, y: r.y, width: r.width, height: r.height });
    // For spreadsheets: scroll the matched cell into view
    if (format === 'spreadsheet') {
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-page-number="${r.page}"] td[data-cell-text="${CSS.escape(r.text)}"]`);
        el?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      }, 50);
    }
  },

  searchPrev() {
    const { search, format, zoom } = get();
    if (!search.results.length) return;
    const idx = (search.currentIndex - 1 + search.results.length) % search.results.length;
    const r = search.results[idx];
    set(s => ({ search: { ...s.search, currentIndex: idx } }));
    get().adapter?.navigateToPage(r.page);
    get().setPreviewRect({ page: r.page, x: r.x, y: r.y, width: r.width, height: r.height });
    if (format === 'spreadsheet') {
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-page-number="${r.page}"] td[data-cell-text="${CSS.escape(r.text)}"]`);
        el?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      }, 50);
    }
  },

  clearSearch() {
    set(s => ({ search: { ...s.search, query: '', results: [], currentIndex: -1 } }));
    get().clearPreviewRect();
  },

  // ── Captures ────────────────────────────────────────────────────────────────
  addCapture(item) {
    set(s => ({ captures: [...s.captures, item], activeFieldId: item.id }));
    get()._rebuildHighlightIndex();
  },

  addCaptureWithId(item) {
    // Full add: upsert + set active + navigate + show previewRect
    // Used by HIGHLIGHT event (interactive navigation to a specific field)
    set(s => {
      const exists = s.captures.some(c => c.id === item.id);
      const captures = exists
        ? s.captures.map(c => c.id === item.id ? item : c)
        : [...s.captures, item];
      return { captures, activeFieldId: item.id };
    });
    get()._rebuildHighlightIndex();
    get().adapter?.navigateToPage(item.page);
    set({ previewRect: { page: item.page, x: item.x, y: item.y, width: item.width, height: item.height } });
  },

  addCaptureWithIdSilent(item) {
    // Silent add: upsert only — NO navigation, NO previewRect, NO activeFieldId change.
    // Used for batch loading (initial captures from parent) so the viewer stays on page 1.
    set(s => {
      const exists = s.captures.some(c => c.id === item.id);
      if (exists) {
        return { captures: s.captures.map(c => c.id === item.id ? item : c) };
      }
      return { captures: [...s.captures, item] };
    });
    // Defer highlight index rebuild — called once after all captures are batch-added
  },

  navigateAndHighlight(id) {
    const capture = get().captures.find(c => c.id === id);
    if (!capture) return false;
    set({ activeFieldId: id });
    get().adapter?.navigateToPage(capture.page);
    set({ previewRect: { page: capture.page, x: capture.x, y: capture.y, width: capture.width, height: capture.height } });
    return true;
  },

  async openFileBuffer(buffer, fileName) {
    const ext  = fileName.split('.').pop()?.toLowerCase() ?? '';
    const mime =
      ext === 'pdf'  ? 'application/pdf' :
      ext === 'tif' || ext === 'tiff' ? 'image/tiff' :
      ext === 'png'  ? 'image/png'  :
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
      ext === 'bmp'  ? 'image/bmp'  :
      ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
      ext === 'xls'  ? 'application/vnd.ms-excel' :
      ext === 'csv'  ? 'text/csv' :
      ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
      ext === 'doc'  ? 'application/msword' : 'application/octet-stream';

    // buffer may be detached if parent used Transferable ([buffer] as 3rd postMessage arg).
    // slice(0) creates a fresh live copy regardless of detached state.
    // For non-detached buffers this is a fast O(1) view copy in modern engines.
    if (!buffer || buffer.byteLength === 0) {
      console.warn('[openFileBuffer] Empty ArrayBuffer received for', fileName);
      set({ isLoading: false, loadError: `Empty or invalid file received: ${fileName}` });
      return;
    }
    // Convert buffer → Blob → File immediately on receipt.
    // This copies bytes into browser-managed Blob memory which:
    //   1. Is never "detached" — immune to ArrayBuffer transfer issues
    //   2. Persists across reopens — File object reusable indefinitely
    //   3. Works for all document types (PDF, TIFF, XLSX, DOCX)
    // We also attach __rawBuffer (a fresh slice) for PDFViewer's direct
    // worker transfer path — this is a secondary optimisation, not required.
    const blob    = new Blob([buffer], { type: mime });
    const safeBuf = buffer.byteLength > 0 ? buffer.slice(0) : new ArrayBuffer(0);
    const file    = new File([blob], fileName, { type: mime });
    try { Object.defineProperty(file, '__rawBuffer', { value: safeBuf, enumerable: false }); } catch (_) {}
    return get().openFile(file);
  },

  replaceCapture(item) {
    set(s => {
      const captures = s.captures.map(c => c.id === item.id ? item : c);
      if (!captures.some(c => c.id === item.id)) captures.push(item);
      // Do NOT change activeFieldId — caller sets it explicitly when needed
      return { captures };
    });
    get()._rebuildHighlightIndex();
  },

  removeCapture(id) {
    set(s => ({
      captures: s.captures.filter(c => c.id !== id),
      activeFieldId: s.activeFieldId === id ? null : s.activeFieldId,
      previewRect: s.activeFieldId === id ? null : s.previewRect,
    }));
    get()._rebuildHighlightIndex();
  },
  deleteCapture(id) {
    set(s => ({
      captures: s.captures.filter(c => c.id !== id),
      activeFieldId: s.activeFieldId === id ? null : s.activeFieldId,
    }));
    get()._rebuildHighlightIndex();
  },
  setActiveField(id)     { set({ activeFieldId: id }); },
  setPendingCapture(p)   { set({ pendingCapture: p }); },
  clearPendingCapture()  { set({ pendingCapture: null }); },
  setPageCount(n)        { set({ pageCount: n }); },
  setWordIndex(map) {
    // Validate: every value must be an array before storing
    if (map instanceof Map) {
      const invalid: number[] = [];
      map.forEach((v, k) => { if (!Array.isArray(v)) invalid.push(k as number); });
      if (invalid.length) {
        console.error('[setWordIndex] Non-array values for pages:', invalid, '— converting to arrays');
        invalid.forEach(k => {
          const v = map.get(k);
          // If it's a single object, wrap it; if null/undefined, use empty array
          map.set(k, Array.isArray(v) ? v : v ? [v] : []);
        });
      }
    }
    set({ wordIndex: map });
  },
  setCategories(cats)    { set({ categories: cats }); },
  setPreviewRect(rect)   { set({ previewRect: rect }); },
  clearPreviewRect()     { set({ previewRect: null }); },

  setMultiDocState(state)   { set({ multiDocState: state }); },
  setMultiDocLoading(v)     { set({ multiDocLoading: v }); },
  setMultiDocError(e)       { set({ multiDocError: e }); },
  setMultiDocActiveFile(f)  { set({ multiDocActiveFile: f }); },
  clearMultiDoc() {
    set({ multiDocState: null, multiDocLoading: false, multiDocError: null, multiDocActiveFile: null });
  },
  registerManifestHandler(fn) { set({ _manifestHandler: fn }); },

  _rebuildHighlightIndex() {
    const { captures } = get();
    const index = new Map<number, HighlightRect[]>();
    for (const c of captures) {
      if (!index.has(c.page)) index.set(c.page, []);
      index.get(c.page)!.push({ x: c.x, y: c.y, width: c.width, height: c.height, id: c.id, color: c.color, type: c.type });
    }
    set({ highlightIndex: index });
  },
}));

// ── Script API — expose controls for external/programmatic use ────────────────
//
// USAGE from any script (before or after app loads):
//
//   // Option A — direct call (works after app bundle has loaded)
//   window.__doccapture.setBoxMode(true);
//
//   // Option B — safe call that works at ANY time (queues if not ready yet)
//   window.__doccapture_call('setBoxMode', true);
//
//   // Option C — wait for ready then call
//   window.__doccapture_ready(function(api) {
//     api.setBoxMode(true);
//   });
//
// All three patterns work even if called before the React app has mounted.

if (typeof window !== 'undefined') {
  // Flush any queued calls that arrived before the store was ready
  const pending: Array<[string, unknown[]]> = (window as any).__doccapture_queue ?? [];

  const api = {
    setBoxMode:         (on: boolean) => useAppStore.getState().setBoxMode(on),
    setEnableAnnotation:(on: boolean) => useAppStore.getState().setEnableAnnotation(on),
    setAnnotateMode: (on: boolean) => useAppStore.getState().setAnnotateMode(on),
    openFile:        (file: File)  => useAppStore.getState().openFile(file),
    openFileBuffer:  (buf: ArrayBuffer, name: string) => useAppStore.getState().openFileBuffer(buf, name),
    navigateAndHighlight: (id: string) => useAppStore.getState().navigateAndHighlight(id),
    getState:        ()            => useAppStore.getState(),
  };

  // Assign the real API object
  (window as any).__doccapture = api;

  // Replay any queued calls
  for (const [method, args] of pending) {
    try { (api as any)[method]?.(...args); } catch (_) {}
  }
  (window as any).__doccapture_queue = null;

  // Fire any __doccapture_ready callbacks
  const readyCbs: Array<(a: any) => void> = (window as any).__doccapture_ready_cbs ?? [];
  for (const cb of readyCbs) { try { cb(api); } catch (_) {} }
  (window as any).__doccapture_ready_cbs = null;

  // Replace __doccapture_ready with immediate-invoke now that we're live
  (window as any).__doccapture_ready = (cb: (a: typeof api) => void) => {
    try { cb(api); } catch (_) {}
  };

  // Replace __doccapture_call with direct dispatch
  (window as any).__doccapture_call = (method: string, ...callArgs: unknown[]) => {
    try { (api as any)[method]?.(...callArgs); } catch (_) {}
  };
}
