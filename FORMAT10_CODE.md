# FORMAT 10 — Code Snippets Reference

---

## Overview — where FORMAT 10 touches the codebase

```
Parent sends JSON
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  src/utils/coords.ts                                │
│  extractRawCoords()   ← detects FORMAT 10           │
│  getExtractedPage()   ← reads __extractedPage       │
│  reconstructBbox()    ← for round-trip (unused now) │
└────────────────────┬────────────────────────────────┘
                     │ returns [x, y, w, h] + __extractedPage
                     ▼
┌─────────────────────────────────────────────────────┐
│  src/App.tsx                                        │
│  normaliseEntry()     ← uses effectivePage          │
│                       ← stores _rawBbox             │
└────────────────────┬────────────────────────────────┘
                     │ CaptureItem with _rawBbox
                     ▼
┌─────────────────────────────────────────────────────┐
│  src/components/ViewerPane.tsx                      │
│  CAPTURE_PREVIEW handler ← sends bbox back verbatim │
└─────────────────────────────────────────────────────┘
                     │
┌─────────────────────────────────────────────────────┐
│  src/hooks/useEventBridge.ts                        │
│  CapturePreviewPayload ← bbox field added to type   │
└─────────────────────────────────────────────────────┘
```

---

## 1. Detection — `src/utils/coords.ts`

### `extractRawCoords()` — FORMAT 10 block

```ts
// FORMAT 10 — page-prefixed bbox: [page, x_min, y_min, width, height]
// Identified by: bbox.length === 5 AND bbox[0] looks like a page number
// (integer ≥ 1, much smaller than the coordinate values that follow).
// We store the extracted page on the item so normaliseEntry can use it.
if (Array.isArray(item.bbox) && item.bbox.length === 5) {
  const [pg, x, y, w, h] = item.bbox as number[];

  // Page number heuristic:
  //   - Must be a whole number (no decimals)
  //   - Must be ≥ 1 and ≤ 9999
  //   - Must be significantly smaller than the coord values
  //     (e.g. page=1 and x=125 → 125 > 1*2 ✓)
  const looksLikePage = Number.isInteger(pg) && pg >= 1 && pg <= 9999 &&
    (x > pg * 2 || y > pg * 2 || w > 0 || h > 0);

  if (looksLikePage) {
    // Store page number on item as a side-channel so callers
    // can get the correct page even when item.page is absent
    (item as any).__extractedPage = pg;

    // Return the 4-element coord (page removed from array)
    return [x, y, w, h];
  }
  // If heuristic fails (e.g. bbox=[0,0,0.5,0.5,0]) → fall through to FORMAT 2
}
```

**Input → Output example:**
```
Input:  { value: "Emerald Earth", bbox: [1, 125, 157, 138, 12] }
                                        ▲   ▲    ▲    ▲    ▲
                                       page  x    y    w    h

After extractRawCoords():
  item.__extractedPage = 1       ← side-channel page storage
  returns [125, 157, 138, 12]    ← 4-element for downstream
```

---

### `getExtractedPage()` — helper to read `__extractedPage`

```ts
/**
 * If extractRawCoords found a page number embedded in bbox[0] (FORMAT 10),
 * it stores it on item.__extractedPage. Use this to get the correct page
 * number when the item's top-level .page field may be absent or wrong.
 */
export function getExtractedPage(
  item: Record<string, unknown>,
  fallback: number           // used when __extractedPage is not set
): number {
  const ep = (item as any).__extractedPage;
  return (typeof ep === 'number' && ep >= 1) ? ep : fallback;
}
```

**Usage:**
```
Item has no .page field: { value: "USD", bbox: [3, 589, 157, 87, 12] }
  getExtractedPage(item, 1) → 3   ← from __extractedPage

Item has no __extractedPage (other format): { value: "Total", page: 2, x: 0.5 }
  getExtractedPage(item, 1) → 1   ← fallback
```

---

### `reconstructBbox()` — for explicit round-trip reconstruction

```ts
/**
 * Reconstruct the original bbox format for CAPTURE_PREVIEW round-trip.
 * If the item was FORMAT 10, returns { bbox: [page, x, y, w, h] }
 * in the ORIGINAL coordinate unit (not normalised).
 * Otherwise returns null.
 */
export function reconstructBbox(
  item: Record<string, unknown>,
  normX: number, normY: number, normW: number, normH: number,
  page: number,
  adapter?: ViewerAdapter | null,
): { bbox: [number,number,number,number,number] } | null {
  // Only applies to FORMAT 10 (5-element bbox array)
  if (!Array.isArray(item.bbox) || item.bbox.length !== 5) return null;

  const [origPage, origX, origY, origW, origH] = item.bbox as number[];
  // Return original values verbatim — preserves the exact unit sent by parent
  return { bbox: [origPage, origX, origY, origW, origH] };
}
```

---

## 2. Normalisation — `src/App.tsx`

### `normaliseEntry()` — FORMAT 10 additions

```ts
function normaliseEntry(
  e: Record<string, unknown>,
  pg: number,                    // fallback page if __extractedPage not set
  adapter: any,
  extractRawCoords: Function,
  normaliseCoords: Function,
  getExtractedPage?: Function,   // ← FORMAT 10: optional helper
): Record<string, unknown> {

  const raw = extractRawCoords(e) as [number,number,number,number] | null;
  if (!raw) return e;

  // ── FORMAT 10 change: use embedded page, not fallback ──────────────────
  // For all other formats, effectivePage = pg (the fallback).
  // For FORMAT 10, __extractedPage was set by extractRawCoords → use it.
  const effectivePage = getExtractedPage ? getExtractedPage(e, pg) : pg;

  const [rx, ry, rw, rh] = raw;
  const isNorm = rx <= 1 && ry <= 1 && rw <= 1 && rh <= 1;

  // ── FORMAT 10 change: detect for _rawBbox storage ─────────────────────
  const isFmt10 = Array.isArray(e.bbox) && (e.bbox as unknown[]).length === 5 &&
    (e as any).__extractedPage !== undefined;

  if (isNorm) {
    // Already 0-1 fractions — pass through, just fix the page
    return {
      ...e,
      x: rx, y: ry, width: rw, height: rh,
      _rawUnit: 'norm',
      ...(effectivePage !== pg ? { page: effectivePage } : {}),
      ...(isFmt10 ? { _rawBbox: e.bbox } : {}),  // ← FORMAT 10: preserve
    };
  }

  // Absolute coords — normalise using adapter page dims
  const [x, y, w, h] = normaliseCoords(
    raw, e, effectivePage,  // ← FORMAT 10: uses extracted page not fallback
    adapter, null
  ) as [number,number,number,number];

  return {
    ...e,
    x, y, width: w, height: h,
    _rawX: rx, _rawY: ry, _rawWidth: rw, _rawHeight: rh,
    _rawUnit: 'px',
    ...(effectivePage !== pg ? { page: effectivePage } : {}),
    ...(isFmt10 ? { _rawBbox: e.bbox } : {}),  // ← FORMAT 10: preserve original
  };
}
```

**Before FORMAT 10 (old):**
```ts
// No getExtractedPage — always used pg (fallback = 1)
// No isFmt10 check — _rawBbox never stored
// effectivePage was always the fallback
```

**After FORMAT 10 (now):**
```ts
// effectivePage = getExtractedPage(e, pg) → reads __extractedPage from bbox[0]
// isFmt10 detected → _rawBbox stored for CAPTURE_PREVIEW round-trip
```

**Concrete example:**
```
Input item: { value: "USD", bbox: [3, 589, 157, 87, 12] }
Fallback pg = 1

extractRawCoords(item):
  → __extractedPage = 3, returns [589, 157, 87, 12]

getExtractedPage(item, pg=1):
  → 3  (not 1!)

normaliseCoords([589,157,87,12], item, page=3, adapter, null):
  adapter.getPageDimensions(3) → {width:2550, height:3299}
  effW=612, pxW=816
  589/816 = 0.722, 157/1056 = 0.149, 87/816 = 0.107, 12/1056 = 0.011

Output CaptureItem:
{
  value:    "USD",
  page:     3,           ← from bbox[0], not fallback 1
  x:        0.722,
  y:        0.149,
  width:    0.107,
  height:   0.011,
  _rawBbox: [3, 589, 157, 87, 12],  ← original preserved
  _rawUnit: 'px',
}
```

---

## 3. Where normaliseEntry is called (imports updated)

Two call sites in `App.tsx` import `getExtractedPage` and pass it through:

```ts
// LOAD_SINGLEDOC + wordIndex path
import('./utils/coords').then(async ({
  extractRawCoords,
  normaliseCoords,
  getExtractedPage,        // ← added for FORMAT 10
}) => {
  // ...
  normaliseEntry(e, pg, ad, extractRawCoords, normaliseCoords, getExtractedPage)
  //                                                            ▲ passed through
});

// captures path (normaliseBatch fallback)
import('./utils/coords').then(({
  extractRawCoords,
  normaliseCoords,
  normaliseBatch,
  getExtractedPage,        // ← added for FORMAT 10
}) => {
  // getPage function also reads __extractedPage:
  const getPage = (item: any) => {
    const ep = (item as any).__extractedPage;
    return typeof ep === 'number' ? ep : (item.page ?? 1);
  };
  // ...
  : normaliseEntry(cap, cap.page ?? 1, ad, extractRawCoords, normaliseCoords);
  // Note: fallback normaliseEntry call doesn't pass getExtractedPage —
  // this is fine because normaliseBatch already handles FORMAT 10 via getPage
});
```

---

## 4. Round-trip — `src/components/ViewerPane.tsx`

```ts
// When user clicks a captured field → send CAPTURE_PREVIEW to parent
const r = result as any;

// ── FORMAT 10: if _rawBbox is set, send original bbox back ──────────────
if ((r as any)._rawBbox) {
  // Reconstruct [page, x, y, w, h] exactly as received
  const bboxPayload = (r as any)._rawBbox as [number,number,number,number,number];

  bridge.handleCaptureResult({
    tempId: '',
    text:   result.text,
    page:   result.page,
    // x/y/width/height required by TypeScript type — overridden by bbox on parent side
    x: result.x, y: result.y, width: result.width, height: result.height,
    bbox: bboxPayload,           // ← FORMAT 10: original values verbatim
    docId: (file as any)?.__docId,
  });
  return; // skip the x/y/w/h path below
}

// All other formats (FORMAT 1-9):
if (r._rawX !== undefined) {
  sendX = r._rawX; sendY = r._rawY; sendW = r._rawWidth; sendH = r._rawHeight;
}
// ...
```

**Round-trip example:**
```
Parent sends:     { bbox: [1, 589, 157, 87, 12] }
Viewer stores:    { x:0.722, y:0.149, ..., _rawBbox:[1,589,157,87,12] }
User clicks field →
CAPTURE_PREVIEW:  { bbox: [1, 589, 157, 87, 12] }  ← exact original
                            ▲   ▲    ▲   ▲   ▲
                           page  x    y   w   h   (all unchanged)
```

---

## 5. TypeScript type — `src/hooks/useEventBridge.ts`

```ts
export interface CapturePreviewPayload {
  tempId:  string;
  text:    string;
  page:    number;
  x:       number;
  y:       number;
  width:   number;
  height:  number;
  docId?:  string;
  label?:  string;
  color?:  string;
  /** FORMAT 10 round-trip: original [page, x_min, y_min, width, height] bbox */
  bbox?: [number, number, number, number, number];  // ← FORMAT 10 addition
}
```

---

## 6. `parseCapturedFields` in `useSidecarLoader.ts`
### (standalone JSON drag-and-drop path)

FORMAT 10 items reach `parseCapturedFields` when the user drags a JSON file
into the viewer. The page extraction works via the same `__extractedPage`:

```ts
// Pass 1 — build per-page max extent
for (const item of items) {
  const raw = extractRawCoords(item);  // sets __extractedPage for FORMAT 10
  if (!raw) continue;
  const [rx, ry, rw, rh] = raw;
  if (rx <= 1 && ry <= 1 && rw <= 1 && rh <= 1) continue;  // skip fractional

  // Read page — for FORMAT 10 this comes from bbox[0] via __extractedPage
  const ep = (item as any).__extractedPage;
  const page = typeof ep === 'number' ? ep :
               typeof item.page === 'number' ? item.page : 1;

  const cur = pageMaxExtent.get(page) ?? { maxX: 0, maxY: 0 };
  pageMaxExtent.set(page, {
    maxX: Math.max(cur.maxX, rx + rw),
    maxY: Math.max(cur.maxY, ry + rh),
  });
}

// Pass 2 — normalise using resolved dims
return items.map(item => {
  const raw = extractRawCoords(item);  // re-runs, sets __extractedPage again
  const ep2 = (item as any).__extractedPage;
  const page = typeof ep2 === 'number' ? ep2 :
               typeof item.page === 'number' ? item.page : 1;

  if (raw) {
    const [rx, ry, rw, rh] = raw;
    const resolved = resolvedSizes.get(page);  // {width:816, height:1056} etc.

    if (resolved && (rx > 1 || ry > 1 || rw > 1 || rh > 1)) {
      // Direct division — bypasses normaliseCoords per-item detection
      x = Math.max(0, Math.min(1, rx / resolved.width));
      y = Math.max(0, Math.min(1, ry / resolved.height));
      w = Math.max(0, Math.min(1, rw / resolved.width));
      h = Math.max(0, Math.min(1, rh / resolved.height));
    }
    // ...
  }
});
```

---

## Quick reference — what each file does for FORMAT 10

| File | Role | FORMAT 10 specific |
|------|------|--------------------|
| `coords.ts → extractRawCoords` | Detect bbox[0]=page, strip it, store as `__extractedPage` | Core detection |
| `coords.ts → getExtractedPage` | Read `__extractedPage` with fallback | Helper |
| `coords.ts → reconstructBbox` | Rebuild original 5-element array | Round-trip helper |
| `App.tsx → normaliseEntry` | Use `effectivePage` from bbox[0], store `_rawBbox` | Normalise + preserve |
| `ViewerPane.tsx` | Send `bbox: _rawBbox` in CAPTURE_PREVIEW | Round-trip |
| `useEventBridge.ts` | `bbox?` field in `CapturePreviewPayload` type | TypeScript type |
| `useSidecarLoader.ts → parseCapturedFields` | Read `__extractedPage` in both passes | Sidecar path |
