// Sidecar JSON loading hook + manual injection functions.
//
// FIELD NAME ALIASES (all treated identically):
//   text / label / value  →  the display text of a word or field
//   id                    →  field identifier (optional for word_index, required for captured)
//
// PAGE DIMENSIONS (used for coordinate normalisation):
//   pageWidth / page_width / pageHeight / page_height  → ignored if coords are fractional
//   When absolute coords received: pageWidth/pageHeight used for normalisation then discarded.
//
// COORDINATE FORMATS SUPPORTED (via extractRawCoords):
//   FORMAT 8: { left, top, width, height }   ← CSS-style (NEW)
//   FORMAT 9: { left, top, right, bottom }   ← corner-point CSS-style (NEW)
//   flat:        {x, y, width, height} or {x, y, w, h}
//   bbox:        {bbox: [x, y, w, h]}
//   rectangle:   {rectangle: [x1,y1,x2,y2]} or [x,y,w,h]
//   coordinates: {coordinates: [ymin,xmin,ymax,xmax]}

import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { extractRawCoords, normaliseBatch, normaliseCoords, detectUnitScale, detectUnitScaleBatch } from '../utils/coords';
import type { WordEntry, Category, CaptureItem } from '../adapters/types';
import { PALETTE_COLORS } from '../adapters/types';
import type { ViewerAdapter } from '../adapters/types';

// ── Text field resolution ──────────────────────────────────────────────────────
// "text", "label", "value", "t" are all accepted as the display text.
// Priority: text > label > value > t
// Returns both the text value AND which key held it.
function resolveText(item: Record<string, unknown>): string {
  // Use || not ?? so empty string ("") falls through to the next key.
  // Priority: text > value > label > t
  // e.g. {text:"", value:"The"} → "The"  (not "")
  // e.g. {label:"", value:"The"} → "The" (not "")
  return String(item.text || item.value || item.label || item.t || '');
}

function resolveTextField(item: Record<string, unknown>): 'text' | 'label' | 'value' {
  if (item.text  !== undefined) return 'text';
  // label key treated same as value — only text/value drive capture text
  return 'value';
}

// ── ID resolution ──────────────────────────────────────────────────────────────
// id is optional for word_index entries, required for captured fields.
function resolveId(item: Record<string, unknown>, fallback = ''): string {
  return item.id ? String(item.id) : fallback;
}

// ── Page dimension extraction ─────────────────────────────────────────────────
// Accepts pageWidth, page_width, pageHeight, page_height — all normalised.
// These are only used for coordinate normalisation and then discarded from output.
function resolvePageDims(item: Record<string, unknown>): { pw?: number; ph?: number } {
  const pw = (item.pageWidth  ?? item.page_width  ?? undefined) as number | undefined;
  const ph = (item.pageHeight ?? item.page_height ?? undefined) as number | undefined;
  return { pw: typeof pw === 'number' ? pw : undefined,
           ph: typeof ph === 'number' ? ph : undefined };
}

// ── Color resolution ──────────────────────────────────────────────────────────
function resolveColor(raw: string): string {
  if (!raw) return '';
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return '#' + raw;
  if (/^[0-9a-fA-F]{3}$/.test(raw)) return '#' + raw;
  return raw;
}

// ── Normalise one set of raw coords ───────────────────────────────────────────
// normaliseOne: single-item normalisation using adapter real dimensions + dynamic unit detection.
function normaliseOne(
  raw: [number, number, number, number],
  item: Record<string, unknown>,
  page: number,
  adapter: ViewerAdapter | null,
  batchPageDims?: { width: number; height: number } | null,
): [number, number, number, number] {
  return normaliseCoords(raw, item, page, adapter, batchPageDims ?? null);
}

// ── Word index parsing ─────────────────────────────────────────────────────────
// id is NOT required — word_index entries are drawn as text overlays only.
// text/label/value/t are all accepted as the word text.
// page_width/page_height ignored after coordinate normalisation.
function parseWordIndex(
  json: unknown,
  adapter: ViewerAdapter | null
): Map<number, WordEntry[]> {
  const result = new Map<number, WordEntry[]>();
  if (!json || typeof json !== 'object') return result;

  const processEntries = (entries: Record<string, unknown>[], page: number) => {
    const items: WordEntry[] = [];
    for (const e of entries) {
      const raw = extractRawCoords(e);
      if (!raw) continue;
      const coords = normaliseOne(raw, e, page, adapter);
      const text      = resolveText(e);
      const _textField = resolveTextField(e);
      if (!text) continue;
      const sourceFormat: import('../adapters/types').CoordSourceFormat =
        'bbox_relative' in e ? 'bbox_relative' :
        'bbox'          in e ? 'bbox'          :
        'rectangle'     in e ? 'rectangle'     :
        'coordinates'   in e ? 'coordinates'   : 'flat';
      items.push({ text, page, x: coords[0], y: coords[1], width: coords[2], height: coords[3], _textField, sourceFormat });
    }
    return items;
  };

  // Format A: { pages: { "1": [...], "2": [...] } }
  if ('pages' in (json as object)) {
    const pages = (json as Record<string, unknown>).pages as Record<string, unknown[]>;

    // Two-pass for each page: first compute max extent for abs-coord normalisation
    // (handles inch/cm/pixel coordinate systems like bbox_relative with values > 1)
    for (const [pageStr, entries] of Object.entries(pages)) {
      const page = parseInt(pageStr);
      if (isNaN(page)) continue;

      // Pass 1: compute per-page max extent, then use adapter real dimensions
      // for dynamic unit detection (no static tables — physical constants only).
      let maxX = 0, maxY = 0;
      for (const e of entries as Record<string, unknown>[]) {
        const raw = extractRawCoords(e);
        if (!raw) continue;
        const [x, y, w, h] = raw;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && w <= 1 && h <= 1) continue;
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
      }
      console.log('[sidecar] Format A page='+page+' maxX='+maxX.toFixed(1)+' maxY='+maxY.toFixed(1));
      // Use adapter real page dims (pts for PDF) to detect unit scale
      let directInferred: { width: number; height: number } | null = null;
      if (maxX > 1 || maxY > 1) {
        const adapterDims = adapter?.getPageDimensions(page);
        if (adapterDims?.width && adapterDims?.height) {
          // detectUnitScaleBatch finds the physical unit (pts/inches/cm/px@dpi)
          // by matching max extent against page dims using physical constants
          const scale = detectUnitScaleBatch(maxX, maxY, adapterDims.width, adapterDims.height);
          console.log('[sidecar] detectUnitScaleBatch RETURNED:', scale, typeof scale);
          if (scale === null) {
            // null sentinel: coords are pixels — use 96dpi px dims.
            // Normalise away UserUnit inflation first (e.g. 2550 → 638 pts).
            const STD_LETTER_W = 612;
            const STD_A4_W = 595;
            let effW = adapterDims.width, effH = adapterDims.height;
            if (adapterDims.width > 1000) {
              const dL = Math.abs((adapterDims.width/STD_LETTER_W)-Math.round(adapterDims.width/STD_LETTER_W));
              const dA = Math.abs((adapterDims.width/STD_A4_W)-Math.round(adapterDims.width/STD_A4_W));
              const std = dL <= dA ? STD_LETTER_W : STD_A4_W;
              effW = std;                                          // exact: 612 or 595
              effH = adapterDims.height / (adapterDims.width / std); // proportional
            }
            const pxW = effW * (96 / 72);
            const pxH = effH * (96 / 72);
            console.log('[sidecar] Format A page='+page+' using px dims: '+pxW.toFixed(0)+'×'+pxH.toFixed(0));
            directInferred = { width: pxW, height: pxH };
          } else if (scale !== null) {
            // Store pageDims with scale baked in — normaliseOne will apply it
            directInferred = {
              width:  adapterDims.width  / scale,
              height: adapterDims.height / scale,
            };
          } else {
            directInferred = adapterDims;
          }
        } else {
          // No adapter dims yet — use max extent as fallback
          directInferred = { width: maxX, height: maxY };
        }
      }

      // Pass 2: normalise with inferred page dims if needed
      const items: WordEntry[] = [];
      for (const e of entries as Record<string, unknown>[]) {
        const raw = extractRawCoords(e);
        if (!raw) continue;
        // Use standard inference first, fall back to per-page max extent
        let coords = normaliseOne(raw, e, page, adapter);
        // normaliseOne with directInferred handles unit-scale conversion
        if (coords[0] > 1 || coords[1] > 1 || coords[2] > 1 || coords[3] > 1) {
          if (directInferred) {
            const [x, y, w, h] = raw;
            coords = [
              Math.max(0, Math.min(1, x / directInferred.width)),
              Math.max(0, Math.min(1, y / directInferred.height)),
              Math.max(0, Math.min(1, w / directInferred.width)),
              Math.max(0, Math.min(1, h / directInferred.height)),
            ];
          }
        }
        const text       = resolveText(e);
        const _textField = resolveTextField(e);
        if (!text) continue;
        const sourceFormat: import('../adapters/types').CoordSourceFormat =
          'bbox_relative' in e ? 'bbox_relative' :
          'bbox'          in e ? 'bbox'          :
          'rectangle'     in e ? 'rectangle'     :
          'coordinates'   in e ? 'coordinates'   : 'flat';
        items.push({ text, page, x: coords[0], y: coords[1], width: coords[2], height: coords[3], _textField, sourceFormat });
      }
      if (items.length) result.set(page, items);
    }
    return result;
  }

  // Format B: flat array [ { text, page, x, y, ... }, ... ]
  if (Array.isArray(json)) {
    const getPage = (item: Record<string, unknown>) => {
      const ep = (item as any).__extractedPage;
      return typeof ep === 'number' ? ep :
             typeof item.page === 'number' ? item.page : 1;
    };

    console.log('[sidecar] Format B flat array, items=', (json as any[]).length,
      'sample:', JSON.stringify((json as any[])[0]).slice(0, 100));
    const normalised = normaliseBatch(json as Record<string, unknown>[], getPage, adapter as any);
    for (const { raw, coords } of normalised) {
      if (!coords) continue;
      const text      = resolveText(raw);
      const _textField = resolveTextField(raw);
      if (!text) continue;
      const page = getPage(raw);
      const sourceFormat: import('../adapters/types').CoordSourceFormat =
        'bbox_relative' in raw ? 'bbox_relative' :
        'bbox'          in raw ? 'bbox'          :
        'rectangle'     in raw ? 'rectangle'     :
        'coordinates'   in raw ? 'coordinates'   : 'flat';
      if (!result.has(page)) result.set(page, []);
      result.get(page)!.push({ text, page, x: coords[0], y: coords[1], width: coords[2], height: coords[3], _textField, sourceFormat });
    }
    return result;
  }

  return result;
}

// ── Captured fields parsing ────────────────────────────────────────────────────
// Accepts any of: label, value, text as the field display text.
// id is required — auto-generated if missing.
// page_width/page_height/pageWidth/pageHeight used only for coord normalisation.
function parseCapturedFields(
  json: unknown,
  adapter: ViewerAdapter | null
): CaptureItem[] {
  if (!Array.isArray(json)) return [];
  const items = json as Record<string, unknown>[];

  // Two-pass: compute per-page max extent, then resolve page dims via adapter.
  // Uses physical unit detection (pts/inches/cm/px) — no static lookup tables.
  const pageMaxExtent = new Map<number, { maxX: number; maxY: number }>();
  for (const item of items) {
    const raw = extractRawCoords(item);
    if (!raw) continue;
    const [rx, ry, rw, rh] = raw;
    if (rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1 && rw <= 1 && rh <= 1) continue;
    const raw0 = extractRawCoords(item); // sets __extractedPage for FORMAT 10
    const ep = (item as any).__extractedPage;
    const page = typeof ep === 'number' ? ep :
                 typeof item.page === 'number' ? item.page : 1;
    const cur = pageMaxExtent.get(page) ?? { maxX: 0, maxY: 0 };
    pageMaxExtent.set(page, {
      maxX: Math.max(cur.maxX, rx + rw),
      maxY: Math.max(cur.maxY, ry + rh),
    });
  }
  const resolvedSizes = new Map<number, { width: number; height: number } | null>();
  for (const [pg, { maxX, maxY }] of pageMaxExtent) {
    const adapterDims = adapter?.getPageDimensions(pg);
    if (adapterDims?.width && adapterDims?.height) {
      // Always derive effective pts dims first (removes UserUnit inflation)
      const STD_LETTER_W = 612;
      const STD_A4_W = 595;
      let effW = adapterDims.width, effH = adapterDims.height;
      if (adapterDims.width > 1000) {
        const dL = Math.abs((adapterDims.width/STD_LETTER_W)-Math.round(adapterDims.width/STD_LETTER_W));
        const dA = Math.abs((adapterDims.width/STD_A4_W)-Math.round(adapterDims.width/STD_A4_W));
        const std = dL <= dA ? STD_LETTER_W : STD_A4_W;
        effW = std;
        effH = adapterDims.height / (adapterDims.width / std);
      }

      const scale = detectUnitScaleBatch(maxX, maxY, effW, effH);
      console.log('[parseCapturedFields] page='+pg+' maxX='+maxX.toFixed(1)
        +' effW='+effW.toFixed(1)+' scale='+scale);

      if (scale === null) {
        // Pixels: derive px dims from effective pts
        const pxW = effW * (96 / 72);
        const pxH = effH * (96 / 72);
        console.log('[parseCapturedFields] → px dims: '+pxW.toFixed(0)+'×'+pxH.toFixed(0));
        resolvedSizes.set(pg, { width: pxW, height: pxH });
      } else {
        // Pts (or other unit): divide by effW/effH (NOT adapterDims which is inflated)
        console.log('[parseCapturedFields] → pts dims: '+effW.toFixed(1)+'×'+effH.toFixed(1));
        resolvedSizes.set(pg, { width: effW / scale, height: effH / scale });
      }
    } else {
      resolvedSizes.set(pg, maxX > 1 || maxY > 1 ? { width: maxX, height: maxY } : null);
    }
  }

  return items.map(item => {
    const raw  = extractRawCoords(item); // sets __extractedPage for FORMAT 10
    const ep2  = (item as any).__extractedPage;
    const page = typeof ep2 === 'number' ? ep2 :
                 typeof item.page === 'number' ? item.page : 1;
    let x = 0, y = 0, w = 0, h = 0;

    if (raw) {
      const [rx, ry, rw, rh] = raw;
      const resolved = resolvedSizes.get(page);
      if (resolved && (rx > 1 || ry > 1 || rw > 1 || rh > 1)) {
        // Use pre-resolved px dims directly — bypass normaliseCoords step 3
        // which would re-run unit detection per-item and pick wrong scale
        x = Math.max(0, Math.min(1, rx / resolved.width));
        y = Math.max(0, Math.min(1, ry / resolved.height));
        w = Math.max(0, Math.min(1, rw / resolved.width));
        h = Math.max(0, Math.min(1, rh / resolved.height));
      } else if (rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1) {
        // Already normalised
        x = rx; y = ry; w = rw; h = rh;
      } else {
        // Fallback
        const normalised = normaliseCoords(raw, item, page, adapter, resolved ?? null);
        [x, y, w, h] = normalised;
      }
    }

    let sourceFormat: CaptureItem['sourceFormat'] = 'flat';
    if      ('bbox_relative' in item) sourceFormat = 'bbox_relative';
    else if ('bbox'          in item) sourceFormat = 'bbox';
    else if ('rectangle'     in item) sourceFormat = 'rectangle';
    else if ('coordinates'   in item) sourceFormat = 'coordinates';

    const displayText  = resolveText(item);
    const usedField    = resolveTextField(item);

    return {
      id:         resolveId(item, Math.random().toString(36).slice(2)),
      label:      displayText,   // label always equals value — only value drives logic
      value:      displayText,
      _textField: usedField,
      page,
      x, y, width: w, height: h,
      sourceFormat,
      fromJson: true,
      color: typeof item.color === 'string' ? resolveColor(item.color) : undefined,
    } as CaptureItem;
  });
}

// ── Categories ────────────────────────────────────────────────────────────────
function parseCategories(json: unknown): Category[] {
  // Accept formats:
  //   Format A (bare array):       [{ pages, label, color }, ...]
  //   Format B (any mode envelope): { mode: any, categories: [...] }
  //   Format C (MultiDoc manifest): { mode: "MultiDoc:...", documents: [...] } — derive categories from documents
  let items: Record<string, unknown>[];
  if (Array.isArray(json)) {
    items = json as Record<string, unknown>[];
  } else if (json && typeof json === 'object') {
    const j = json as Record<string, unknown>;
    if (Array.isArray(j.categories)) {
      items = j.categories as Record<string, unknown>[];
    } else {
      return [];
    }
  } else {
    return [];
  }

  let paletteIdx = 0;
  return items.map(item => {
    // Only apply palette key when color is absent/empty — preserve explicit colors from parent
    const rawColor = typeof item.color === 'string' ? item.color.trim() : '';
    const color = rawColor || PALETTE_COLORS[paletteIdx++ % PALETTE_COLORS.length];
    return {
      pages: Array.isArray(item.pages) ? (item.pages as number[]) : [],
      label: String(item.label ?? item.text ?? item.value ?? ''),
      color,
    };
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useSidecarLoader() {
  const file    = useAppStore(s => s.file);
  const adapter = useAppStore(s => s.adapter);

  useEffect(() => {
    if (!file || !adapter) return;
    let cancelled = false;
    adapter.onReady(() => { if (!cancelled) { /* auto-load reserved for future */ } });
    return () => { cancelled = true; };
  }, [file, adapter]);
}

// ── Manual injection (called from SidecarLoader UI) ────────────────────────────
export function injectWordIndex(json: unknown, adapter: ViewerAdapter | null) {
  return parseWordIndex(json, adapter);
}

export function injectCapturedFields(json: unknown, adapter: ViewerAdapter | null) {
  return parseCapturedFields(json, adapter);
}

export function injectCategories(json: unknown) {
  return parseCategories(json);
}
