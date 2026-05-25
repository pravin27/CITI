# How 0-1 Coordinates Are Processed — Step by Step

Input example:
  { value:'Invoice Total', page:1, x:0.40, y:0.50, width:0.20, height:0.06 }

---

## Step 1 — extractRawCoords() reads the values

File: src/utils/coords.ts

```ts
// FORMAT 1 check — all four fields present as numbers?
if (typeof item.x === 'number' &&
    typeof item.y === 'number' &&
    typeof item.width === 'number' &&
    typeof item.height === 'number') {

  return [item.x, item.y, item.width, item.height];
  //      [0.40,  0.50,  0.20,        0.06]
}
// page = item.page = 1  (read separately by caller)
```

Output: raw = [0.40, 0.50, 0.20, 0.06],  page = 1


---

## Step 2 — normaliseBatch() Pass 1: are all values already 0-1?

File: src/utils/coords.ts → normaliseBatch()

```ts
const [x, y, w, h] = raw;  // [0.40, 0.50, 0.20, 0.06]

// Check: all between 0 and 1?
if (x >= 0 && x <= 1 &&   // 0.40 ✓
    y >= 0 && y <= 1 &&   // 0.50 ✓
    w <= 1 &&              // 0.20 ✓
    h <= 1) {              // 0.06 ✓

  continue;  // ← skip this item from max-extent tracking
  //            no unit detection, no adapter lookup needed
}
```

Result: pageMaxExtent map is empty for this item.
        pageResolved has no entry for page 1.


---

## Step 3 — normaliseBatch() Pass 2: already fractional → pass through

File: src/utils/coords.ts → normaliseBatch()

```ts
// Pass 2 — for every item:
const [x, y, w, h] = raw;  // [0.40, 0.50, 0.20, 0.06]

// Already fractional check (same condition):
if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && w <= 1 && h <= 1) {
  return { raw: item, coords: clamp4([x, y, w, h]) };
  //                           clamp4: Math.max(0, Math.min(1, v)) each
}

// clamp4 output (no change — all already within range):
coords = [0.400, 0.500, 0.200, 0.060]
```

Zero division, zero multiplication, zero adapter dimension lookup.
The values pass through untouched (just clamped for safety).


---

## Step 4 — paintPage() multiplies by canvas size

File: src/components/PDFViewer.tsx → paintPage()

```ts
// W, H = pdfjs viewport pixel size at current zoom
// At Page Fit on Letter (612×792 pts):
//   W = 612 × (96/72) = 816px,  H = 792 × (96/72) = 1056px
// At 125% zoom:
//   W = 1020px,  H = 1320px

const W = viewport.width;   // e.g. 816 at 100%
const H = viewport.height;  // e.g. 1056 at 100%

// For each capture in highlightIndex[pageNum]:
drawBox(ctx,
  r.x      * W,   // 0.40 × 816 = 326px  ← left edge
  r.y      * H,   // 0.50 × 1056 = 528px  ← top edge
  r.width  * W,   // 0.20 × 816 = 163px  ← width
  r.height * H,   // 0.06 × 1056 = 63px  ← height
)
```

The 0-1 values become pixel positions on the canvas.
The same 0-1 values at 125% zoom → 408, 660, 204, 79 px.
The box always lands at the same proportional position — zoom-independent.


---

## Step 5 — drawBox() adds proportional padding and draws

File: src/components/PDFViewer.tsx → drawBox()

```ts
function drawBox(ctx, x, y, w, h) {
  // x=326, y=528, w=163, h=63 (at 100% zoom, Letter page)

  const PAD_TOP = h * 0.08;   // 63 × 0.08 = 5px  above text
  const PAD_BOT = h * 0.05;   // 63 × 0.05 = 3px  below text
  const PAD_W   = h * 0.10;   // 63 × 0.10 = 6px  each side

  rr(ctx,
    x  - PAD_W,           // 326 - 6   = 320px  ← actual left
    y  - PAD_TOP,         // 528 - 5   = 523px  ← actual top
    w  + PAD_W * 2,       // 163 + 12  = 175px  ← actual width
    h  + PAD_TOP + PAD_BOT, // 63 + 8  = 71px   ← actual height
    RADIUS                // border-radius
  )
}
```

Padding is proportional to box height — not fixed pixels.
At 50% zoom (h=31px): PAD_TOP=2px, PAD_W=3px — scales with content.
At 200% zoom (h=126px): PAD_TOP=10px, PAD_W=13px — scales with content.


---

## Step 6 — What each 0-1 value means visually

```
Page dimensions: 816 × 1056 px (at 100% zoom, Letter)

x = 0.40 → 40% from LEFT edge   = 326px from left
y = 0.50 → 50% from TOP edge    = 528px from top

x,y marks the TOP-LEFT corner of the box.
y increases DOWNWARD (y=0 = top, y=1 = bottom).

width  = 0.20 → box spans 20% of page width  = 163px
height = 0.06 → box spans 6% of page height  = 63px

So the box occupies:
  Left:   326px  →  Right:  489px
  Top:    528px  →  Bottom: 591px
  (before padding)

After drawBox padding:
  Left:   320px  →  Right:  495px
  Top:    523px  →  Bottom: 594px
```


---

## Complete trace — one item, every line

```
Parent sends:
  { value:'Invoice Total', page:1, x:0.40, y:0.50, width:0.20, height:0.06 }

Step 1  extractRawCoords()
          → FORMAT 1 detected
          → raw = [0.40, 0.50, 0.20, 0.06]
          → page = 1

Step 2  normaliseBatch Pass 1
          → all values ≤ 1 → skip (no unit detection)
          → pageMaxExtent: not updated for page 1

Step 3  normaliseBatch Pass 2
          → all values ≤ 1 → pass through
          → coords = clamp4([0.40, 0.50, 0.20, 0.06])
          → coords = [0.400, 0.500, 0.200, 0.060]   ← stored in highlightIndex

Step 4  paintPage() at 100% zoom (W=816, H=1056)
          → draw_x = 0.400 × 816  = 326px
          → draw_y = 0.500 × 1056 = 528px
          → draw_w = 0.200 × 816  = 163px
          → draw_h = 0.060 × 1056 =  63px

Step 5  drawBox()
          → PAD_TOP = 63 × 0.08 =  5px
          → PAD_BOT = 63 × 0.05 =  3px
          → PAD_W   = 63 × 0.10 =  6px
          → rr(ctx, 320, 523, 175, 71)   ← final filled+stroked box

Step 6  Canvas renders box:
          → 40% from left, 50% from top, 20% wide, 6% tall
          → Position is zoom-independent — same fraction at any zoom
```


---

## What changes at different zoom levels

| Zoom | Canvas W | Canvas H | draw_x | draw_y | draw_w | draw_h |
|------|----------|----------|--------|--------|--------|--------|
| 50%  | 408      | 528      | 163px  | 264px  | 82px   | 32px   |
| 100% | 816      | 1056     | 326px  | 528px  | 163px  | 63px   |
| 125% | 1020     | 1320     | 408px  | 660px  | 204px  | 79px   |
| 150% | 1224     | 1584     | 490px  | 792px  | 245px  | 95px   |
| 200% | 1632     | 2112     | 653px  | 1056px | 326px  | 127px  |

The 0-1 fractions × canvas size — proportional position is preserved exactly.



-----------------Fraction ---------
What Gemini's OCR returns
Gemini returns bounding box coordinates in this format:
[y_min, x_min, y_max, x_max]  →  e.g. [234, 123, 45, 13]
These values are in a fixed scale of 0–1000 (not pixels, not 0–1).

Why divide by 1000 specifically?
Gemini normalizes all coordinates to a 1000×1000 grid regardless of the actual image size. So:
234 / 1000 = 0.234  →  means 23.4% from the top
123 / 1000 = 0.123  →  means 12.3% from the left
This is just Gemini's internal convention — they chose 1000 as the scale so coordinates are integers (easier to handle) while still being resolution-independent. It's essentially a fixed-point representation of a 0.0–1.0 ratio.

What is the main purpose of normalizing?
Normalization makes coordinates resolution-independent. Here's why that matters:
ProblemWithout normalizationWith normalizationImage is 800×600 but viewport is 1440×900Coordinates are wrongMultiply by viewport size → correctPDF rendered at 150 DPI vs 300 DPIPixel positions differSame normalized value works for bothDisplay on mobile vs desktopBreaksScale to any screen size
So the full pipeline is:
Gemini raw:   [234, 123, 45, 13]   ← 0–1000 scale
÷ 1000:       [0.234, 0.123, 0.045, 0.013]   ← normalized 0.0–1.0
× viewport:   0.234 × 900 = 210.6px (y),  0.123 × 1440 = 177.1px (x)

Contrast with what we did in your PDFs
In your earlier extractions we divided by page pixel dimensions directly (e.g. 1900px wide), which achieves the same goal — just a different path to 0.0–1.0:
Tesseract/PyMuPDF:   x=437px  ÷  page_width=1900px  =  0.23
Gemini:              x=230    ÷  1000                =  0.23
Both land at the same normalized value. The normalization approach differs, but the purpose is identical: make coordinates portable across any resolution or viewport.
