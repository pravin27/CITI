import { useState, useCallback, useRef } from 'react';
import type {
  DocumentManifest, MultiDocConfig, MultiDocState,
  DocSetItem, ResolvedCategory, ManifestDocument,
} from '../types/multiDoc';
import { totalPagesFromCategories } from '../types/multiDoc';
import { PALETTE_COLORS } from '../adapters/types';

// ── Document buffer LRU cache ────────────────────────────────────────────────
//
// Controls how many document buffers are kept in memory simultaneously.
// Each slot holds one File object (the raw document bytes).
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  CHANGE THIS VALUE to adjust the in-memory document cache size          │
// │                                                                          │
// │  DOC_LRU_CAPACITY = 10   ← default, ~50-100 MB for typical PDFs        │
// │  DOC_LRU_CAPACITY = 20   ← larger sets, ~100-200 MB                    │
// │  DOC_LRU_CAPACITY = 5    ← memory-constrained environments             │
// │                                                                          │
// │  Location: src/hooks/useMultiDoc.ts  (top of file, easy to find)        │
// └─────────────────────────────────────────────────────────────────────────┘
const DOC_LRU_CAPACITY = 10;

// ── LRU cache implementation ──────────────────────────────────────────────────
// Uses a Map whose insertion order tracks recency (Map preserves insertion order).
// On every get(), the entry is deleted and re-inserted so it becomes the newest.
// On set() when at capacity, the first (oldest) entry is evicted.
//
// T is the cached value type:
//   LRUCache<File>   — for fileCacheRef  (the File object itself)
//   LRUCache<string> — for urlCacheRef   (blob:// URL string)
class LRUCache<T> {
  private readonly cap: number;
  private readonly map = new Map<string, T>();
  private onEvict?: (key: string, val: T) => void;

  constructor(capacity: number, onEvict?: (key: string, val: T) => void) {
    this.cap     = Math.max(1, capacity);
    this.onEvict = onEvict;
  }

  has(key: string): boolean { return this.map.has(key); }

  get(key: string): T | undefined {
    if (!this.map.has(key)) return undefined;
    // Move to end (most recently used)
    const val = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: string, val: T): void {
    if (this.map.has(key)) {
      // Update existing — re-insert at end
      this.map.delete(key);
    } else if (this.map.size >= this.cap) {
      // Evict oldest (first entry in Map iteration order)
      const oldestKey = this.map.keys().next().value as string;
      const oldestVal = this.map.get(oldestKey) as T;
      this.map.delete(oldestKey);
      this.onEvict?.(oldestKey, oldestVal);
    }
    this.map.set(key, val);
  }

  delete(key: string): void {
    if (!this.map.has(key)) return;
    const val = this.map.get(key)!;
    this.map.delete(key);
    this.onEvict?.(key, val);
  }

  clear(): void {
    if (this.onEvict) this.map.forEach((val, key) => this.onEvict!(key, val));
    this.map.clear();
  }

  get size(): number { return this.map.size; }

  keys(): string[] { return [...this.map.keys()]; }
}

// ── Data resolution helpers ───────────────────────────────────────────────────

function base64ToUint8Array(b64: string): Uint8Array {
  const raw = b64.startsWith('data:') ? b64.split(',')[1] : b64;
  const bin = atob(raw);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Infer the original file extension from the manifest's src URL or doc name
function inferFileName(mDoc: ManifestDocument, fallback: string): string {
  // Try src URL first — grab the basename
  if (mDoc.src) {
    const base = mDoc.src.split('/').pop()?.split('?')[0] ?? '';
    if (base.includes('.')) return base;
  }
  // If name already has extension, use it
  if (fallback.includes('.')) return fallback;
  // Default to .pdf if we can't detect
  return fallback + '.pdf';
}

function inferMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    tif: 'image/tiff', tiff: 'image/tiff',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', bmp: 'image/bmp',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function resolveToUrl(
  doc: DocSetItem,
  manifest: ManifestDocument,
  config: MultiDocConfig,
  docMime: string,
): Promise<string> {
  // 1. src: relative path, absolute URL, or blob:
  if (manifest.src) {
    if (manifest.src.startsWith('data:')) {
      const arr = base64ToUint8Array(manifest.src);
      return URL.createObjectURL(new Blob([arr.buffer as ArrayBuffer], { type: docMime }));
    }
    return manifest.src; // blob: / http / relative — browser handles
  }
  // 2. dataUrl: "data:application/pdf;base64,..."
  if (manifest.dataUrl) {
    const arr = base64ToUint8Array(manifest.dataUrl);
    return URL.createObjectURL(new Blob([arr.buffer as ArrayBuffer], { type: docMime }));
  }
  // 3. base64: raw string, no prefix
  if (manifest.base64) {
    const arr = base64ToUint8Array(manifest.base64);
    return URL.createObjectURL(new Blob([arr.buffer as ArrayBuffer], { type: docMime }));
  }
  // 4. loadDocumentData() callback — your backend pipeline
  if (config.loadDocumentData) {
    const result = await config.loadDocumentData(doc.id);
    if (typeof result === 'string') {
      if (result.startsWith('blob:') || result.startsWith('http') || result.startsWith('/')) return result;
      const arr = base64ToUint8Array(result);
      return URL.createObjectURL(new Blob([arr.buffer as ArrayBuffer], { type: docMime }));
    }
    const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
    return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: docMime }));
  }
  // Path 5: on-demand ArrayBuffer via parent postMessage (iframe mode)
  if (config.requestBuffer) {
    const buffer = await config.requestBuffer(doc.id);
    const bytes  = new Uint8Array(buffer);
    return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: docMime }));
  }

  throw new Error(`No data source for document "${doc.id}"`);
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseMultiDocReturn {
  state: MultiDocState | null;
  loadManifest: (manifest: DocumentManifest) => void;
  selectDoc: (docId: string, page?: number) => Promise<void>;
  selectPage: (page: number) => void;
  clearMultiDoc: () => void;
  activeFile: File | null;
  activeDocLoading: boolean;
  activeDocError: string | null;
  setConfig: (cfg: MultiDocConfig) => void;
}

export function useMultiDoc(): UseMultiDocReturn {
  const [state, setState] = useState<MultiDocState | null>(null);
  const [activeFile, setActiveFile] = useState<File | null>(null);
  const [activeDocLoading, setActiveDocLoading] = useState(false);
  const [activeDocError, setActiveDocError] = useState<string | null>(null);

  const manifestRef    = useRef<DocumentManifest | null>(null);
  const configRef      = useRef<MultiDocConfig>({});
  // urlCacheRef: blob:// URLs — eviction revokes the URL so browser can GC the bytes
  const urlCacheRef  = useRef(new LRUCache<string>(DOC_LRU_CAPACITY, (_key, blobUrl) => {
    if (blobUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    }
  }));
  // fileCacheRef: File objects (hold the raw ArrayBuffer in memory)
  // Eviction just removes the reference — GC reclaims the bytes once no other ref exists
  const fileCacheRef = useRef(new LRUCache<File>(DOC_LRU_CAPACITY));
  // Stable ref to selectDoc used by loadManifest auto-select (avoids stale closure)
  const selectDocRef   = useRef<(docId: string, page?: number) => Promise<void>>(async () => {});

  const setConfig = useCallback((cfg: MultiDocConfig) => {
    configRef.current = { ...configRef.current, ...cfg };
  }, []);

  const loadManifest = useCallback((manifest: DocumentManifest) => {
    manifestRef.current = manifest;

    // Normalise legacy mode strings to new canonical values
    let mode = manifest.mode as string;
    if (mode === 'single') mode = 'MultiDoc:SinglePage';
    if (mode === 'multi')  mode = 'MultiDoc:MultiPage';
    // Expose mode so thumbnail renderer can adapt caching strategy
    if (typeof window !== 'undefined') (window as any).__doccapture_mode = mode;

    // ── Resolve categories with palette fallback ──────────────────────────────
    // manifest.categories is OPTIONAL. When absent or empty, categories are
    // auto-derived from the unique category ids referenced in documents[].category
    // and documents[].pageCategories[].category.
    //
    // Color assignment priority:
    //   1. Explicit color on the ManifestCategory entry (hex or CSS value)
    //   2. Palette color by sequential index (same as SingleDoc behaviour)
    //
    // This means callers only need to supply manifest.categories when they want
    // custom labels or specific colors. A minimal MultiDoc manifest only needs
    // mode + documents — categories are inferred automatically.

    // Collect all category ids referenced across all documents
    const referencedCatIds = new Set<string>();
    for (const d of manifest.documents ?? []) {
      if (d.category) referencedCatIds.add(d.category);
      for (const pc of d.pageCategories ?? []) referencedCatIds.add(pc.category);
    }

    // Build a base map from any explicitly-provided categories
    const explicitMap = new Map<string, { label: string; color: string }>();
    for (const c of manifest.categories ?? []) {
      explicitMap.set(c.id, { label: c.label ?? c.id, color: c.color ?? '' });
    }

    // Merge: explicit first, then auto-derive missing ones from referencedCatIds
    const mergedIds = [
      ...(manifest.categories ?? []).map(c => c.id),
      ...[...referencedCatIds].filter(id => !explicitMap.has(id)),
    ];

    let paletteIdx = 0;
    const categories: ResolvedCategory[] = mergedIds.map(id => {
      const explicit = explicitMap.get(id);
      // Assign palette color if color is missing, empty, or not provided
      const color = explicit?.color?.trim()
        ? explicit.color
        : PALETTE_COLORS[paletteIdx % PALETTE_COLORS.length];
      paletteIdx++;
      return {
        id,
        label: explicit?.label ?? id,
        color,
      };
    });

    const documents: DocSetItem[] = (manifest.documents ?? []).map(d => {
      const totalPages = d.pageCategories
        ? totalPagesFromCategories(d.pageCategories)
        : undefined;
      return {
        id: d.id,
        name: d.name,
        categoryId: d.category,
        pageCategories: d.pageCategories,
        totalPages,
      };
    });
    setState({
      mode: mode as import('../types/multiDoc').ManifestMode,
      categories,
      documents,
      activeDocId: null,
      activePage: 1,
    });
    setActiveFile(null);
    // Auto-select first document so counter shows "1/N" immediately
    if (documents.length > 0) {
      // Use setTimeout to let setState flush first
      const firstDoc = documents[0];
      const firstPage = (manifest.documents ?? [])[0]?.pageCategories?.[0]?.pages?.[0] ?? 1;
      setTimeout(() => selectDocRef.current(firstDoc.id, firstPage), 0);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectDoc = useCallback(async (docId: string, page = 1) => {
    if (!manifestRef.current) return;
    setState(s => s ? { ...s, activeDocId: docId, activePage: page } : s);
    setActiveDocError(null);

    // Cache hit — File object already resolved, zero cost
    if (fileCacheRef.current.has(docId)) {
      setActiveFile(fileCacheRef.current.get(docId)!);
      return;
    }

    setActiveDocLoading(true);
    try {
      const mDoc = (manifestRef.current.documents ?? []).find(d => d.id === docId);
      if (!mDoc) throw new Error(`Document "${docId}" not in manifest`);

      // Infer correct filename + MIME early — needed for both resolveToUrl and File creation
      const docFileName = inferFileName(mDoc, mDoc.name);
      const docMime     = inferMimeType(docFileName);

      // Resolve to URL (cached blob URLs reused)
      let blobUrl: string;
      if (urlCacheRef.current.has(docId)) {
        blobUrl = urlCacheRef.current.get(docId)!;
      } else {
        const state = { id: docId, name: mDoc.name };
        blobUrl = await resolveToUrl(state as DocSetItem, mDoc, configRef.current, docMime);
        if (blobUrl.startsWith('blob:')) urlCacheRef.current.set(docId, blobUrl);
      }
      let file: File;
      if (blobUrl.startsWith('blob:')) {
        const buf = await (await fetch(blobUrl)).arrayBuffer();
        file = new File([buf], docFileName, { type: docMime });
      } else {
        const resp = await fetch(blobUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${blobUrl}`);
        const buf = await resp.arrayBuffer();
        file = new File([buf], docFileName, { type: docMime });
        // Cache the blob for subsequent visits
        const cached = URL.createObjectURL(new Blob([buf], { type: docMime }));
        urlCacheRef.current.set(docId, cached);
      }

      // Tag with docId so capture events can reference which doc they came from
      try { Object.defineProperty(file, '__docId', { value: docId, enumerable: false, writable: false }); } catch (_) {}
      fileCacheRef.current.set(docId, file);
      setActiveFile(file);
    } catch (err) {
      setActiveDocError(String(err));
    } finally {
      setActiveDocLoading(false);
    }
  }, []);

  // Keep ref in sync with latest selectDoc
  selectDocRef.current = selectDoc;

  const selectPage = useCallback((page: number) => {
    setState(s => s ? { ...s, activePage: page } : s);
  }, []);

  const clearMultiDoc = useCallback(() => {
    if (typeof window !== 'undefined') (window as any).__doccapture_mode = null;
    // LRUCache.clear() triggers the onEvict callback for every entry,
    // revoking all blob URLs so the browser can GC the underlying bytes.
    urlCacheRef.current.clear();
    fileCacheRef.current.clear();
    manifestRef.current = null;
    setState(null);
    setActiveFile(null);
    setActiveDocLoading(false);
    setActiveDocError(null);
  }, []);

  return { state, loadManifest, selectDoc, selectPage, clearMultiDoc, activeFile, activeDocLoading, activeDocError, setConfig };
}
