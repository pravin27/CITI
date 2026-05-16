# FORMAT 10 — Page-Prefixed BBox: Complete Guide

## What is FORMAT 10?

FORMAT 10 is a coordinate format where the **page number is embedded
inside the `bbox` array as its first element**, followed by the four
coordinate values.

```
{ bbox: [page, x_min, y_min, width, height] }
```

All other formats either put page on a separate `page` field, or don't
include it at all. FORMAT 10 bundles everything into a single array.

---

## Input structure

```json
[
  {
    "id": 1,
    "value": "Emerald Earth Enterprises",
    "bbox": [1, 125, 157, 138, 12]
  },
  {
    "id": 2,
    "value": "S1007 - Advertising",
    "bbox": [1, 318, 157, 106, 20]
  },
  {
    "id": 3,
    "value": "USD",
    "bbox": [1, 589, 157, 87, 12]
  },
  {
    "id": 4,
    "value": "PALMS RESOURCES PTE LTD",
    "bbox": [2, 133, 729, 184, 24]
  }
]
```

`bbox` array positions:
| Index | Meaning  | Example |
|-------|----------|---------|
| [0]   | Page number (1-based) | `1` |
| [1]   | x_min (left edge)     | `125` |
| [2]   | y_min (top edge)      | `157` |
| [3]   | width                 | `138` |
| [4]   | height                | `12`  |

---

## Step-by-step normalisation pipeline

### Step 1 — Detection (`extractRawCoords`)

```
Input item: { value: "Emerald Earth", bbox: [1, 125, 157, 138, 12] }

Check: Array.isArray(item.bbox) && item.bbox.length === 5 → TRUE

Extract:
  pg = bbox[0] = 1
  x  = bbox[1] = 125
  y  = bbox[2] = 157
  w  = bbox[3] = 138
  h  = bbox[4] = 12

Page heuristic check:
  Number.isInteger(1)  → true
  1 >= 1 && 1 <= 9999 → true
  x=125 > pg*2=2      → true  (coordinate is much larger than page number)

Result:
  item.__extractedPage = 1   ← page stored on item for later use
  returns [125, 157, 138, 12] ← 4-element coord (page removed)
```

### Step 2 — Unit detection (`detectUnitScaleBatch`)

The batch processes ALL items together to detect the coordinate unit
consistently. Uses the **global maximum** across all items.

```
All items on page 1: maxRawX = max(125+138, 318+106, 589+87) = 676
                     maxRawY = max(157+12,  157+20,  157+12)  = 177

PDF page dimensions (from adapter): 612 × 792 pts (Letter)
  [if UserUnit-scaled: 2550 × 3299 → stripped back to 612 × 792]

px dims at 96dpi: 612 × 96/72 = 816px wide
                  792 × 96/72 = 1056px tall

Rule: maxRawX=676 > effW=612 → coords cannot be pts (would be off-page)
      676 fits within pxW=816 × 1.15 = 938 → TRUE
      → Unit = pixels @ 96dpi
      → resolvedDims = { width: 816, height: 1056 }
```

### Step 3 — Normalisation to 0–1 fractions

```
For each item, divide raw coords by resolvedDims:

Emerald Earth Enterprises [1, 125, 157, 138, 12]:
  x = 125 / 816 = 0.153
  y = 157 / 1056 = 0.149
  w = 138 / 816 = 0.169
  h =  12 / 1056 = 0.011
  page = __extractedPage = 1

S1007 [1, 318, 157, 106, 20]:
  x = 318 / 816 = 0.390
  y = 157 / 1056 = 0.149
  w = 106 / 816 = 0.130
  h =  20 / 1056 = 0.019
  page = 1

USD [1, 589, 157, 87, 12]:
  x = 589 / 816 = 0.722
  y = 157 / 1056 = 0.149
  w =  87 / 816 = 0.107
  h =  12 / 1056 = 0.011
  page = 1
```

### Step 4 — Canvas drawing

```
At Page Fit zoom, canvas = 820 × 1060px (example):

Emerald Earth:
  fillRect(0.153 × 820, 0.149 × 1060, 0.169 × 820, 0.011 × 1060)
  fillRect(125px, 158px, 139px, 12px)   ← auto-scales with zoom

At 150% zoom, canvas = 1230 × 1590px:
  fillRect(0.153 × 1230, 0.149 × 1590, ...)
  fillRect(188px, 237px, 208px, 17px)   ← bigger but same fraction
```

Page dims are used **only during normalisation** (Steps 2–3).
Canvas drawing uses `canvas.width/height` — zoom handled automatically.

---

## CAPTURE_PREVIEW round-trip

When the user clicks a captured field, the viewer sends the coordinates
back to the parent. For FORMAT 10, the **original bbox is preserved verbatim**:

```
Viewer receives:  { bbox: [1, 125, 157, 138, 12] }
Internally stores: { x:0.153, y:0.149, w:0.169, h:0.011, _rawBbox:[1,125,157,138,12] }

User clicks field → CAPTURE_PREVIEW sent to parent:
  { type:'CAPTURE_PREVIEW', bbox:[1, 125, 157, 138, 12] }
  ← exact original values, original unit, original format
```

`_rawBbox` is stored at normalisation time and used for reconstruction.
The parent always receives the same format it sent.

---

## Expected output (internal CaptureItem)

```ts
// Input
{ id: 1, value: "Emerald Earth Enterprises", bbox: [1, 125, 157, 138, 12] }

// Internal CaptureItem after normalisation
{
  id:          "1",
  label:       "Emerald Earth Enterprises",
  value:       "Emerald Earth Enterprises",
  page:        1,          // extracted from bbox[0]
  x:           0.153,      // 125 / 816
  y:           0.149,      // 157 / 1056
  width:       0.169,      // 138 / 816
  height:      0.011,      // 12  / 1056
  sourceFormat: "bbox",
  fromJson:    true,
  _rawBbox:    [1, 125, 157, 138, 12],  // preserved for round-trip
}
```

---

## Coordinate unit auto-detection rules

| Condition | Detected unit | Reference dims |
|-----------|--------------|----------------|
| All values ≤ 1.0 | Already normalised (0–1) | None needed |
| maxRawX > pts page width AND fits in px@96 | Pixels @ 96dpi | px dims (816×1056 for Letter) |
| maxRawX ≤ pts page width | Points (72dpi) | pts dims (612×792 for Letter) |
| PDF has UserUnit (e.g. 2550×3299) | Strip to real pts first, then above rules | 612×792 effective |

Detection is done **once per page across all items** (batch) —
not per-item — so all items on the same page use the same unit.

---

## What happens for normalised coordinates

If the external system sends 0–1 fractions instead of pixel/pt values:

```json
{ "value": "Total", "bbox": [2, 0.65, 0.80, 0.20, 0.03] }
```

Detection: all values ≤ 1.0 → already normalised → stored as-is:
```ts
{ page: 2, x: 0.65, y: 0.80, width: 0.20, height: 0.03 }
```

No division needed. Works identically to other formats.

---

## Files changed for FORMAT 10 support

| File | Change |
|------|--------|
| `src/utils/coords.ts` | FORMAT 10 detection in `extractRawCoords()`. `getExtractedPage()` and `reconstructBbox()` helpers exported. |
| `src/App.tsx` | `normaliseEntry()` reads `__extractedPage` for correct page. Stores `_rawBbox` on CaptureItem. |
| `src/components/ViewerPane.tsx` | CAPTURE_PREVIEW sends `bbox: _rawBbox` when FORMAT 10. |
| `src/hooks/useEventBridge.ts` | `CapturePreviewPayload` interface includes `bbox?: [number,number,number,number,number]`. |
