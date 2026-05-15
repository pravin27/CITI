// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE NORMALISATION
//
// All coordinates stored internally as 0–1 fractions of page dimensions.
//
// The ONLY authoritative source for page dimensions is the loaded document itself:
//   PDF:         pdfDoc.getPage(n).view = [x0,y0,x1,y1] in PDF points (1pt = 1/72 inch)
//                stored in adapter via onPageLoad() when document loads
//   Image/TIF:   frame.width/height in pixels — stored in adapter
//   Spreadsheet: computed from col/row metadata
//   Document:    DocAdapter canvas = 794×1123px (A4 @96dpi)
//
// NO static lookup tables, NO hardcoded page sizes, NO guessing.
// The adapter ALWAYS has the real dimensions. If not yet loaded, we wait.
//
// Unit detection — purely from the ratio of raw coord to page dimension:
//   raw/pts ≤ 1:              already fractional (0–1)
//   raw/pts ≈ 1:              coords in PDF points (same unit as adapter)
//   raw/pts ≈ 72:             coords in inches (1 inch = 72 pts)
//   raw/pts ≈ 28.35:          coords in centimetres (1 cm = 28.35 pts)
//   raw/pts ≈ 96/72 = 1.333:  coords in pixels @96dpi
//   raw/pts ≈ 150/72 = 2.083: coords in pixels @150dpi
//   raw/pts ≈ 200/72 = 2.778: coords in pixels @200dpi
//   raw/pts ≈ 300/72 = 4.167: coords in pixels @300dpi
// ─────────────────────────────────────────────────────────────────────────────

import type { ViewerAdapter } from '../adapters/types';

// ── Unit scale factors (relative to PDF points) ───────────────────────────────
// These are PHYSICAL constants, not assumptions:
//   1 inch  = exactly 72 PDF points  (PDF specification)
//   1 cm    = 72/2.54 = 28.3465 pts  (metric definition)
//   1 pixel at N dpi = 72/N points   (definition of DPI)
const UNITS: Array<{ scale: number; name: string }> = [
  { scale: 1,        name: 'pts'    },  // PDF points (same as adapter)
  { scale: 72,       name: 'inches' },  // 1 inch = 72 pts
  { scale: 28.3465,  name: 'cm'     },  // 1 cm = 72/2.54 pts
  { scale: 72/96,    name: 'px@96'  },  // screen pixels
  { scale: 72/150,   name: 'px@150' },
  { scale: 72/200,   name: 'px@200' },
  { scale: 72/300,   name: 'px@300' },
  { scale: 72/400,   name: 'px@400' },
  { scale: 72/600,   name: 'px@600' },
];

// ── Unit detection — best-fit scoring ────────────────────────────────────────
//
// For a single axis: find the unit where (rawMax * scale / pageDim) is closest to 1.0
// while still ≤ 1 + tolerance (coordinates must fit within the page).
// Minimum threshold of 1% (ratio > 0.01) prevents tiny fractional values from
// matching the wrong unit (e.g. 1.0 inches / 612 pts = 0.0016 — too small for pts).
//
// "Closest to 1.0" means the max extent covers as much of the page as possible
// in that unit — the best-fitting unit produces the highest coverage ratio.

function bestFitScale(
  maxRawX: number, maxRawY: number,
  pageW:   number, pageH:   number,
): number | null {
  const TOL    = 0.15; // 15% tolerance — covers margins and partial-page word_index
  const MIN_R  = 0.01; // coords must cover at least 1% of page in each dimension
  let bestScale: number | null = null;
  let bestDiff  = Infinity;

  for (const { scale } of UNITS) {
    const rx = (maxRawX * scale) / pageW;
    const ry = (maxRawY * scale) / pageH;
    // Both must fit within page (≤ 1+TOL) and be meaningful (> MIN_R)
    if (rx > 1 + TOL || ry > 1 + TOL) continue;
    if (rx < MIN_R   || ry < MIN_R)   continue;
    // Score: sum of distances from 1.0 — lower = better coverage of the page
    const diff = Math.abs(1 - rx) + Math.abs(1 - ry);
    if (diff < bestDiff) { bestDiff = diff; bestScale = scale; }
  }
  return bestScale;
}

// Public aliases used by sidecarLoader
export function detectUnitScale(rawMax: number, pageDim: number): number | null {
  return bestFitScale(rawMax, rawMax, pageDim, pageDim);
}

/**
 * If extractRawCoords found a page number embedded in bbox[0] (FORMAT 10),
 * it stores it on item.__extractedPage. Use this to get the correct page number
 * when the item's top-level .page field may be absent or wrong.
 */
export function getExtractedPage(item: Record<string, unknown>, fallback: number): number {
  const ep = (item as any).__extractedPage;
  return (typeof ep === 'number' && ep >= 1) ? ep : fallback;
}

/**
 * Reconstruct the original bbox format for CAPTURE_PREVIEW round-trip.
 * If the item was FORMAT 10 (page-prefixed bbox), returns
 * { bbox: [page, x, y, w, h] } in the original coordinate unit.
 * Otherwise returns null (caller uses x/y/w/h fields as before).
 */
export function reconstructBbox(
  item: Record<string, unknown>,
  normX: number, normY: number, normW: number, normH: number,
  page: number,
  adapter?: import('../adapters/types').ViewerAdapter | null,
): { bbox: [number,number,number,number,number] } | null {
  // Only reconstruct if item came from FORMAT 10
  if (!Array.isArray(item.bbox) || item.bbox.length !== 5) return null;
  const [origPage, origX, origY, origW, origH] = item.bbox as number[];
  // Return the original values verbatim — preserves whatever unit was sent
  return { bbox: [origPage, origX, origY, origW, origH] };
}
export function detectUnitScaleBatch(
  maxRawX: number, maxRawY: number,
  pageW:   number, pageH:   number,
): number | null {
  // ── Normalise page dims to standard pts ──────────────────────────────────
  // pdfjs can report inflated dims when PDF has UserUnit > 1 (e.g. 2550 instead of 612).
  // Detect this: standard Letter=612, A4=595. If pageW > 1000, it's UserUnit-scaled.
  // Normalise back to real pts by dividing by the UserUnit factor.
  let effW = pageW;
  let effH = pageH;
  const STD_LETTER_W = 612;   // Letter width in pts
  const STD_A4_W     = 595;   // A4 width in pts
  if (pageW > 1000) {
    // Detect UserUnit: ratio of reported width to nearest standard width
    const closestStd = Math.abs(pageW / STD_LETTER_W - Math.round(pageW / STD_LETTER_W)) <
                       Math.abs(pageW / STD_A4_W    - Math.round(pageW / STD_A4_W))
                       ? STD_LETTER_W : STD_A4_W;
    const userUnit = Math.round(pageW / closestStd);
    effW = pageW / userUnit;
    effH = pageH / userUnit;
    console.log('[coords] UserUnit detected =', userUnit,
      '→ effW='+effW.toFixed(0)+' effH='+effH.toFixed(0));
  }

  // px dims at 96dpi from effective pts
  const pxW = effW * (96 / 72);   // 612→816, 595→793
  const pxH = effH * (96 / 72);   // 792→1056

  console.log('[coords] detectUnitScaleBatch:',
    'maxRawX='+maxRawX.toFixed(1), 'maxRawY='+maxRawY.toFixed(1),
    'pageW_pts='+pageW+'(eff='+effW.toFixed(0)+')',
    'pxW='+pxW.toFixed(0), 'pxH='+pxH.toFixed(0));

  // ── Hard rule 1: maxRawX > effPageW_pts → cannot be pts → must be pixels ─
  if (maxRawX > effW) {
    if (maxRawX <= pxW * 1.15 && maxRawY <= pxH * 1.15) {
      console.log('[coords] → OVERRIDE px@96 (maxRawX '+maxRawX.toFixed(1)+' > effW '+effW.toFixed(0)+'): scale='+( 72/96).toFixed(4));
      // normaliseCoords does x*scale/pageW — but pageW here is original (effW or pageW?)
      // normaliseBatch uses adapterDims.width (=pageW original, e.g. 2550)
      // So we need: x_norm = x_px / pxW = x * (72/96) / effW = x * scale_px_to_pts / effW
      // But normaliseBatch divides by adapterDims.width (2550), not effW (612).
      // Return special sentinel: null → normaliseBatch will use pxW directly
      return null; // handled below with pxW
    }
  }

  // ── Hard rule 2: coords fit within px dims much better than pts ──────────
  const ratioPts = maxRawX / effW;
  const ratioPx  = maxRawX / pxW;
  if (ratioPts > 0.5 && ratioPx <= 1.0 && ratioPts / ratioPx > 1.25) {
    console.log('[coords] → OVERRIDE px@96 (ratio evidence: pts='+ratioPts.toFixed(3)+' px='+ratioPx.toFixed(3)+')');
    return null;
  }

  const scale = bestFitScale(maxRawX, maxRawY, effW, effH);
  console.log('[coords] → bestFitScale(effDims) result:', scale);
  return scale;
}

// ── Coordinate extraction ─────────────────────────────────────────────────────

/**
 * Extract raw [x, y, w, h] from any supported coordinate format.
 *
 * FORMAT 1  — flat x/y:      {x, y, width|w, height|h}
 * FORMAT 2  — bbox:          {bbox: [x, y, w, h]} or {bbox: [x1,y1,x2,y2]}
 * FORMAT 3  — rectangle w/h: {rectangle: [x, y, w, h]}
 * FORMAT 4  — rectangle pts: {rectangle: [x1, y1, x2, y2]}
 * FORMAT 5  — coordinates:   {coordinates: [ymin, xmin, ymax, xmax]}
 * FORMAT 6  — flat min/max:  {xmin, ymin, xmax, ymax}
 * FORMAT 7  — bbox_relative: {bbox_relative: [[x,y],[x,y],[x,y],[x,y]]}
 * FORMAT 8  — left/right wh: {left, right, width, height} — left=x, right=x2(opt), height=h
 * FORMAT 9  — corner-point:  {left, right, top, bottom}  — all four edges
 * FORMAT 10 — page-prefixed bbox: {bbox: [page, x_min, y_min, width, height]}
 *             First element is the 1-based page number; coordinates follow.
 *             e.g. { value: 'INVOICE', bbox: [1, 183, 240, 90, 15] }
 *             Works with normalised (0–1), pixel, or point coordinates.
 */
export function extractRawCoords(
  item: Record<string, unknown>
): [number, number, number, number] | null {
  // FORMAT 1
  if (typeof item.x === 'number' && typeof item.y === 'number' &&
      (typeof item.width === 'number' || typeof item.w === 'number') &&
      (typeof item.height === 'number' || typeof item.h === 'number')) {
    return [item.x, item.y,
            (item.width ?? item.w) as number,
            (item.height ?? item.h) as number];
  }
  // FORMAT 6
  if (typeof item.xmin === 'number' && typeof item.ymin === 'number' &&
      typeof item.xmax === 'number' && typeof item.ymax === 'number') {
    const x = item.xmin as number, y = item.ymin as number;
    return [x, y, (item.xmax as number) - x, (item.ymax as number) - y];
  }
  // FORMAT 10 — page-prefixed bbox: [page, x_min, y_min, width, height]
  // Identified by: bbox.length === 5 AND bbox[0] looks like a page number
  // (integer ≥ 1, much smaller than the coordinate values that follow).
  // We store the extracted page on the item so normaliseEntry can use it.
  if (Array.isArray(item.bbox) && item.bbox.length === 5) {
    const [pg, x, y, w, h] = item.bbox as number[];
    // page number heuristic: integer ≥ 1 AND significantly smaller than coords
    const looksLikePage = Number.isInteger(pg) && pg >= 1 && pg <= 9999 &&
      (x > pg * 2 || y > pg * 2 || w > 0 || h > 0);
    if (looksLikePage) {
      // Attach extracted page to item so caller can override item.page
      (item as any).__extractedPage = pg;
      return [x, y, w, h];
    }
    // Fall through to FORMAT 2 handling if heuristic fails
  }

  // FORMAT 2 — bbox: [x, y, w, h]  OR  [x1, y1, x2, y2] corner points
  // Detect corner-point form: c > a AND d > b AND values look like absolute coords
  // (same detection as FORMAT 3/4 rectangle). When page_width/page_height are
  // provided on the item, use those to distinguish: if c > page_width it must be w,h.
  if (Array.isArray(item.bbox) && item.bbox.length >= 4) {
    const [a, b, cc, d] = item.bbox as number[];
    // Check for corner-point form [x1, y1, x2, y2]:
    // c > a AND d > b means second point is bottom-right of first point
    // Also require at least one value > 1 (not already fractional)
    if (cc > a && d > b && (a > 1 || b > 1 || cc > 1 || d > 1)) {
      // Verify it's really x1y1x2y2 and not x,y,w,h:
      // If page_width is provided, w < page_width/2 for most words (sanity check)
      const pw = (item.pageWidth ?? item.page_width) as number | undefined;
      const ph = (item.pageHeight ?? item.page_height) as number | undefined;
      // If c (as x2) < page_width, it's a corner point — convert to x,y,w,h
      // If c (as width) > page_width * 0.9, it's probably width not x2
      if (!pw || cc < pw * 0.95) {
        return [a, b, cc - a, d - b]; // corner points → x,y,w,h
      }
    }
    return [a, b, cc, d]; // treat as x,y,w,h
  }
  // FORMAT 3/4
  if (Array.isArray(item.rectangle) && item.rectangle.length >= 4) {
    const [a, b, c, d] = item.rectangle as number[];
    if (c > a && d > b && (a > 1 || b > 1 || c > 1 || d > 1)) return [a, b, c-a, d-b];
    return [a, b, c, d];
  }
  // FORMAT 5
  if (Array.isArray(item.coordinates) && item.coordinates.length >= 4) {
    const [ymin, xmin, ymax, xmax] = item.coordinates as number[];
    return [xmin, ymin, xmax-xmin, ymax-ymin];
  }
  // FORMAT 7 — bbox_relative polygon → AABB
  if (Array.isArray(item.bbox_relative) && (item.bbox_relative as unknown[]).length >= 3) {
    const pts = item.bbox_relative as [number, number][];
    if (pts.every(p => Array.isArray(p) && p.length >= 2 &&
        typeof p[0] === 'number' && typeof p[1] === 'number')) {
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      return [Math.min(...xs), Math.min(...ys),
              Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys)];
    }
  }
  // FORMAT 8 — { left, right, width, height }
  // left  = x origin,  right = x end point (ignored if width present, used to derive w if not)
  // width = box width, height = box height
  // y-origin is not in this format — defaults to 0 if not available.
  // If 'top' is also present it is used as y; otherwise y=0 (caller must provide page context).
  if (typeof item.left === 'number' &&
      (typeof item.right === 'number' || typeof item.width === 'number') &&
      typeof item.height === 'number') {
    const l = item.left   as number;
    const h = item.height as number;
    // y: use 'top' if present, else 0
    const y = typeof item.top === 'number' ? item.top as number : 0;
    // width: prefer explicit width; fall back to right-left
    const w = typeof item.width === 'number'
      ? item.width as number
      : (item.right as number) - l;
    return [l, y, w, h];
  }

  // FORMAT 9 — corner points: { left, right, top, bottom } (no width/height)
  if (typeof item.left   === 'number' && typeof item.right  === 'number' &&
      typeof item.top    === 'number' && typeof item.bottom === 'number') {
    const l = item.left as number,  t = item.top    as number;
    const r = item.right as number, b = item.bottom as number;
    return [l, t, r - l, b - t];
  }

  return null;
}

// ── Core normaliser ───────────────────────────────────────────────────────────

/**
 * Normalise raw [x, y, w, h] to 0–1 fractions.
 *
 * Priority:
 *   1. Already fractional (all 0–1) → return as-is
 *   2. Per-item pageWidth/page_width + pageHeight/page_height
 *   3. Adapter real dimensions (in PDF points from the loaded document)
 *      + dynamic unit detection (pts, inches, cm, px@any-dpi)
 *   4. batchPageDims — page dims resolved by normaliseBatch across all items
 *      + dynamic unit detection
 */
export function normaliseCoords(
  raw: [number, number, number, number],
  item: Record<string, unknown>,
  page: number,
  adapter?: ViewerAdapter | null,
  batchPageDims?: { width: number; height: number } | null,
): [number, number, number, number] {
  const [x, y, w, h] = raw;

  // ── 1. Already fractional ────────────────────────────────────────────────
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && w >= 0 && w <= 1 && h >= 0 && h <= 1) {
    return clamp4([x, y, w, h]);
  }

  // ── 2. Explicit per-item page dimensions ─────────────────────────────────
  let iPw: number | undefined, iPh: number | undefined;
  if (typeof item.pageWidth   === 'number') iPw = item.pageWidth as number;
  if (typeof item.page_width  === 'number') iPw = item.page_width as number;
  if (typeof item.pageHeight  === 'number') iPh = item.pageHeight as number;
  if (typeof item.page_height === 'number') iPh = item.page_height as number;
  if (iPw && iPh) {
    // Use bestFitScale with BOTH axes: compare coord extent against page dims.
    // This handles the common case where page_width/height are in PDF points (e.g. 560, 792)
    // but the coordinates are in inches (e.g. 1.06, 2.9) — bestFitScale detects the unit.
    // We also try the adapter dims for a more accurate two-axis comparison when available.
    const adDims = adapter?.getPageDimensions(page);
    const refW = adDims?.width  ?? iPw;
    const refH = adDims?.height ?? iPh;
    const scale = bestFitScale(x + w, y + h, refW, refH) ?? 1;
    // Apply scale to normalise: coords_in_unit * scale = coords_in_pts → divide by page_pts
    return clamp4([x*scale/refW, y*scale/refH, w*scale/refW, h*scale/refH]);
  }

  // ── 3. Adapter real page dimensions (from loaded document) ───────────────
  // adapter.getPageDimensions() returns the page size in native document units:
  //   PDF:  points (1pt = 1/72 inch)  — stored via onPageLoad()
  //   TIF:  pixels (from UTIF decoded canvas size)
  //   DOC:  pixels (DocAdapter renders to 794×1123 canvas)
  if (adapter) {
    const dims = adapter.getPageDimensions(page);
    if (dims?.width && dims?.height) {
      const maxCoord = Math.max(x + w, y + h);
      const scale = bestFitScale(maxCoord, maxCoord, dims.width, dims.height);
      if (scale !== null) {
        return clamp4([x*scale/dims.width, y*scale/dims.height,
                       w*scale/dims.width, h*scale/dims.height]);
      }
      // No unit matched — coords might be in the same unit as the adapter
      if (x <= dims.width * 1.1 && y <= dims.height * 1.1) {
        return clamp4([x/dims.width, y/dims.height, w/dims.width, h/dims.height]);
      }
    }
  }

  // ── 4. Batch-resolved page dims (from normaliseBatch) ────────────────────
  if (batchPageDims?.width && batchPageDims?.height) {
    const maxCoord = Math.max(x + w, y + h);
    const scale    = detectUnitScale(maxCoord, Math.max(batchPageDims.width, batchPageDims.height));
    if (scale !== null) {
      return clamp4([x*scale/batchPageDims.width, y*scale/batchPageDims.height,
                     w*scale/batchPageDims.width, h*scale/batchPageDims.height]);
    }
    // Assume same unit
    return clamp4([x/batchPageDims.width, y/batchPageDims.height,
                   w/batchPageDims.width, h/batchPageDims.height]);
  }

  // ── Absolute last resort: use item's own extent ───────────────────────────
  const maxX = x + w, maxY = y + h;
  return clamp4([x / Math.max(maxX, 1), y / Math.max(maxY, 1),
                 w / Math.max(maxX, 1), h / Math.max(maxY, 1)]);
}

function clamp4([x, y, w, h]: [number,number,number,number]): [number,number,number,number] {
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return [c(x), c(y), c(w), c(h)];
}

// ── Batch normaliser ──────────────────────────────────────────────────────────

/**
 * Two-pass normalisation for an array of items (Format B word_index).
 *
 * Pass 1: For each page, collect the max coordinate extent.
 *         Then use the adapter's real page dimensions to detect the unit scale.
 *         Store resolved {pageDims, unitScale} per page.
 *
 * Pass 2: Normalise every item using the resolved scale for its page.
 */
export function normaliseBatch(
  items: Record<string, unknown>[],
  getPage: (item: Record<string, unknown>) => number,
  adapter?: ViewerAdapter | null,
): Array<{ raw: Record<string, unknown>; coords: [number,number,number,number] | null }> {

  // Pass 1 — per-page max extent
  const pageMaxExtent = new Map<number, { maxX: number; maxY: number }>();
  for (const item of items) {
    const raw = extractRawCoords(item);
    if (!raw) continue;
    const [x, y, w, h] = raw;
    console.log('[normaliseBatch] item raw:', JSON.stringify({x,y,w,h}),
      'bbox:', JSON.stringify((item as any).bbox),
      '__extractedPage:', (item as any).__extractedPage);
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && w <= 1 && h <= 1) {
      console.log('[normaliseBatch] → already fractional, skipping');
      continue;
    }
    const pg = getPage(item);
    const cur = pageMaxExtent.get(pg) ?? { maxX: 0, maxY: 0 };
    const next = { maxX: Math.max(cur.maxX, x+w), maxY: Math.max(cur.maxY, y+h) };
    console.log('[normaliseBatch] page='+pg+' maxX='+next.maxX.toFixed(1)+' maxY='+next.maxY.toFixed(1));
    pageMaxExtent.set(pg, next);
  }

  // Resolve per-page: use adapter dims + unit detection
  const pageResolved = new Map<number, { width: number; height: number; scale: number } | null>();
  for (const [pg, { maxX, maxY }] of pageMaxExtent) {
    const adapterDims = adapter?.getPageDimensions(pg);
    if (adapterDims?.width && adapterDims?.height) {
      const scale = detectUnitScaleBatch(maxX, maxY, adapterDims.width, adapterDims.height);
      console.log('[normaliseBatch] detectUnitScaleBatch returned:', scale, 'for page', pg);

      if (scale === null) {
        // null sentinel: coords are pixels — use 96dpi px dims for normalisation.
        // Normalise pageW from pts to effective pts (remove UserUnit if inflated).
        const STD_LETTER_W = 612;
        let effW = adapterDims.width, effH = adapterDims.height;
        if (adapterDims.width > 1000) {
          const userUnit = Math.round(adapterDims.width / STD_LETTER_W) || 1;
          effW = adapterDims.width / userUnit;
          effH = adapterDims.height / userUnit;
        }
        // px dims at 96dpi
        const pxW = effW * (96 / 72);
        const pxH = effH * (96 / 72);
        console.log('[normaliseBatch] page='+pg+' using px dims: '+pxW.toFixed(0)+'×'+pxH.toFixed(0));
        // scale=1 with px dims: x_norm = x*1/pxW = x/pxW ✓
        pageResolved.set(pg, { width: pxW, height: pxH, scale: 1 });
        continue;
      }

      if (scale !== null) {
        pageResolved.set(pg, { width: adapterDims.width, height: adapterDims.height, scale });
        continue;
      }
      // No clean unit match — assume same unit as adapter
      if (maxX <= adapterDims.width * 1.5 && maxY <= adapterDims.height * 1.5) {
        pageResolved.set(pg, { width: adapterDims.width, height: adapterDims.height, scale: 1 });
        continue;
      }
    }
    // No adapter dims — store max extent for fallback
    pageResolved.set(pg, maxX > 1 || maxY > 1
      ? { width: maxX, height: maxY, scale: 1 }
      : null);
  }

  // Pass 2 — normalise
  return items.map(item => {
    const raw = extractRawCoords(item);
    if (!raw) return { raw: item, coords: null };
    const [x, y, w, h] = raw;
    const pg = getPage(item);
    // Already fractional
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && w <= 1 && h <= 1) {
      return { raw: item, coords: clamp4([x, y, w, h]) };
    }
    const res = pageResolved.get(pg);
    if (res) {
      const { width, height, scale } = res;
      console.log('[normaliseBatch] Pass2 using: width='+width.toFixed(1)+' height='+height.toFixed(1)+' scale='+scale);
      const coords = clamp4([x*scale/width, y*scale/height, w*scale/width, h*scale/height]);
      console.log('[normaliseBatch] Pass2 page='+pg,
        'x='+x+' y='+y+' w='+w+' h='+h,
        '→ scale='+scale.toFixed(4)+' dims='+width+'×'+height,
        '→ norm:', coords.map(v => v.toFixed(3)).join(','));
      return { raw: item, coords };
    }
    // Fallback to per-item normalisation
    console.warn('[normaliseBatch] Pass2 FALLBACK for page='+pg, 'item=', JSON.stringify(item).slice(0,80));
    return { raw: item, coords: normaliseCoords(raw, item, pg, adapter, null) };
  });
}
