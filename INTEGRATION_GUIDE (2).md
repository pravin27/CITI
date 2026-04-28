# DocCapture Viewer — Parent ↔ Viewer Integration Guide

## Overview

DocCapture Viewer runs inside an `<iframe>` in your parent application.
All communication uses `window.postMessage`. No SDK required — pure browser API.

```
Parent Application
│
│  postMessage  ──────────────────►  iframe (DocCapture Viewer)
│  window.addEventListener  ◄──────  postMessage
```

---

## Quick Setup

```html
<iframe id="doc-viewer" src="https://your-viewer-domain.com"
  style="width:100%; height:100%; border:none;"></iframe>
```

```js
const iframe = document.getElementById('doc-viewer');
const VIEWER = '*'; // use 'https://your-viewer-domain.com' in production

function sendToViewer(msg) {
  iframe.contentWindow.postMessage(msg, VIEWER);
}

window.addEventListener('message', (e) => {
  const { type, ...data } = e.data ?? {};
  switch (type) {
    case 'READY':           onViewerReady();          break;
    case 'PDF_LOADED':      onPdfLoaded(data);        break;
    case 'DOC_REQUEST':     onDocRequest(data);       break;
    case 'CAPTURE_PREVIEW': onCapturePreview(data);   break;
    case 'CAPTURES_DATA':   onCapturesData(data);     break;
  }
});
```

---

## Section 1 — Complete Event Reference

### Events: Parent → Viewer

---

#### `LOAD_SINGLEDOC`

Load a single document (PDF, TIFF, XLSX, DOCX, PNG, JPEG, CSV).

```js
const buffer = await fetch('/api/invoice.pdf').then(r => r.arrayBuffer());

sendToViewer({
  type:     'LOAD_SINGLEDOC',
  buffer,                        // ArrayBuffer — the document binary
  fileName: 'invoice.pdf',       // Extension determines format

  // Optional data:
  wordIndex:  [...],             // see Section 4
  categories: [...],             // see Section 2
  captures:   [...],             // see Section 3

  // Optional UI flags:
  Click2Pick:      true,         // enable box-draw mode on load  (default: false)
  showFieldsPanel: true,         // show right-side fields panel  (default: false)
  showAnnotation:  true,         // show annotation button        (default: false)
});

// ⚠️  Do NOT pass buffer as 3rd arg [buffer] (Transferable).
//     Use plain postMessage — structured clone keeps buffer intact.
```

---

#### `LOAD_MANIFEST`

Load a multi-document session with either `MultiDoc:SinglePage` or `MultiDoc:MultiPage` mode.

---

##### Mode: `MultiDoc:SinglePage`

Each document is a single-page file. Every document belongs to one category.

```js
sendToViewer({
  type: 'LOAD_MANIFEST',

  manifest: {
    mode: 'MultiDoc:SinglePage',

    // Top-level categories — optional [{id, label, color}]
    // Defines the display label and colour for each category shown in the
    // sidebar accordion. The `id` here must match the `category` field on
    // each document entry. If omitted, the viewer assigns colours automatically
    // from its built-in palette.
    categories: [
      { id: 'invoice',      label: 'Invoice',      color: '#1a7fd4' },
      { id: 'form15ca',     label: 'Form 15CA',    color: '#0f9e6e' },
      { id: 'bank_stmt',    label: 'Bank Statement',color: '#d97706' },
    ],

    // Documents array — each document is one page/file
    documents: [
      {
        id:       'doc1',            // unique identifier
        name:     'invoice_001.pdf', // filename — extension sets format
        category: 'invoice',         // references categories[].id above
        src:      '/files/inv1.pdf', // optional URL (omit if sending buffer separately)
      },
      {
        id:       'doc2',
        name:     'form15ca_001.pdf',
        category: 'form15ca',
        // no src — buffer sent via activeBuffer or DOC_RESPONSE
      },
      {
        id:       'doc3',
        name:     'bank_jan.pdf',
        category: 'bank_stmt',
      },
    ],
  },

  activeDocId:   'doc1',        // which document to load first
  activeBuffer,                  // ArrayBuffer for the first doc (no network round-trip)

  // Optional data for the active doc:
  wordIndex:       [...],
  captures:        [...],
  Click2Pick:      true,
  showFieldsPanel: true,
  showAnnotation:  false,
});
```

---

##### Mode: `MultiDoc:MultiPage`

Each document has multiple pages. Each page belongs to a category.
The `pageCategories` array inside each document maps categories to page ranges.

```js
sendToViewer({
  type: 'LOAD_MANIFEST',

  manifest: {
    mode: 'MultiDoc:MultiPage',

    // Top-level categories — optional [{id, label, color}]
    // The `id` must match the `category` values used in `pageCategories`.
    // If omitted, the viewer assigns colours from its built-in palette.
    categories: [
      { id: 'invoice',   label: 'Invoice',   color: '#1a7fd4' },
      { id: 'annexure',  label: 'Annexure',  color: '#9333ea' },
      { id: 'bank_stmt', label: 'Statement', color: '#d97706' },
    ],

    // Documents array — each document has multiple categorised pages
    documents: [
      {
        id:   'doc1',
        name: 'combined_filing.pdf',
        src:  '/files/combined.pdf',  // optional

        // pageCategories: array of { category, pages }
        // category references categories[].id
        // pages is 1-based page numbers within this document
        pageCategories: [
          { category: 'invoice',   pages: [1, 2, 3] },
          { category: 'annexure',  pages: [4, 5]    },
          { category: 'bank_stmt', pages: [6, 7, 8] },
        ],
      },
      {
        id:   'doc2',
        name: 'supporting_docs.pdf',
        pageCategories: [
          { category: 'invoice',  pages: [1] },
          { category: 'annexure', pages: [2, 3, 4, 5] },
        ],
      },
    ],
  },

  activeDocId:   'doc1',
  activeBuffer,

  wordIndex:   [...],
  captures:    [...],
});
```

---

##### Field reference — `documents[]` per mode

**`MultiDoc:SinglePage` — each document object:**

| Field            | Type     | Required | Notes                                        |
|------------------|----------|----------|----------------------------------------------|
| `id`             | string   | ✅        | Unique ID — used in `DOC_REQUEST`            |
| `name`           | string   | ✅        | Filename. Extension sets format (pdf/tif/…)  |
| `category`       | string   | ❌        | References `categories[].id`                 |
| `src`            | string   | ❌        | URL. Omit if buffer sent via `activeBuffer` or `DOC_RESPONSE` |
| `dataUrl`        | string   | ❌        | `data:application/pdf;base64,...`            |
| `base64`         | string   | ❌        | Raw base64 string                            |

**`MultiDoc:MultiPage` — each document object:**

| Field              | Type                 | Required | Notes                         |
|--------------------|----------------------|----------|-------------------------------|
| `id`               | string               | ✅        | Unique ID                     |
| `name`             | string               | ✅        | Filename                      |
| `pageCategories`   | `{category,pages}[]` | ✅        | Category → pages mapping      |
| `src`              | string               | ❌        | Optional URL                  |

**`pageCategories[]` entry:**

| Field      | Type     | Required | Notes                                                 |
|------------|----------|----------|-------------------------------------------------------|
| `category` | string   | ✅        | References `categories[].id`                         |
| `pages`    | number[] | ✅        | 1-based page numbers within this document            |

**Top-level `categories[]` — optional for both modes:**

Defines the label and colour for each category shown in the sidebar accordion.
The viewer matches `categories[].id` to the `category` (SinglePage) or `pageCategories[].category`
(MultiPage) values inside each document. **If omitted, the viewer automatically assigns
colours from its built-in palette** — you only need to send this when you want custom colours.

| Field   | Type   | Required | Notes                                                              |
|---------|--------|----------|--------------------------------------------------------------------|
| `id`    | string | ✅        | Must match `document.category` or `pageCategories[].category`      |
| `label` | string | ✅        | Display name shown in sidebar accordion header                     |
| `color` | string | ✅        | CSS colour (`#hex`, `rgb(…)`, named colour). Auto-assigned if omitted |

---

#### `DOC_RESPONSE`

Send a document buffer when the viewer requests it.

```js
async function onDocRequest({ docId }) {
  const buffer = await fetchFromBackend(docId);
  sendToViewer({
    type:  'DOC_RESPONSE',
    docId,   // must match what viewer requested
    buffer,  // ArrayBuffer

    // Optional meta for this specific doc:
    wordIndex:  await fetchWordIndex(docId),
    captures:   await fetchCaptures(docId),
  });
}
```

---

#### `CAPTURE_ACK`

Acknowledge a capture preview.

```js
async function onCapturePreview({ tempId, text, page, x, y, width, height, docId }) {
  const { id } = await fetch('/api/captures', {
    method: 'POST',
    body: JSON.stringify({ text, page, x, y, width, height, docId }),
    headers: { 'Content-Type': 'application/json' },
  }).then(r => r.json());

  // Confirm:
  sendToViewer({ type: 'CAPTURE_ACK', tempId, id });

  // Reject (don't save — viewer clears preview after 15s timeout):
  // → just don't send anything

  // Delete an existing capture:
  sendToViewer({ type: 'CAPTURE_ACK', tempId, id, delete: true });
  // OR with empty coords:
  sendToViewer({ type: 'CAPTURE_ACK', tempId, id, x:0, y:0, width:0, height:0 });
}
```

---

#### `HIGHLIGHT`

Navigate viewer to a field and highlight it.

```js
sendToViewer({
  type: 'HIGHLIGHT',
  payload: {
    id:     'inv_number',    // required — empty/missing = ignored
    page:    1,
    x: 0.08, y: 0.06, width: 0.14, height: 0.03,  // or raw pixels
    label:  'Invoice Number',
    value:  'INV-2024-001',
    color:  '#1a7fd4',
    docId:  'doc2',          // MultiDoc: loads this doc first if not active
  }
});
// id exists in viewer  → navigate + yellow highlight (no duplicate added)
// id not in viewer     → add to captures + navigate + highlight
// id missing/empty     → completely ignored
```

---

#### `EXPORT_CAPTURES`

Request all current captured fields.

```js
sendToViewer({ type: 'EXPORT_CAPTURES' });
// Viewer responds with CAPTURES_DATA event
```

---

### Events: Viewer → Parent

---

#### `READY`

Viewer is mounted. **Gate your data send behind this.**

```js
let viewerReady = false;
let pending     = null;

function onViewerReady() {
  viewerReady = true;
  if (pending) { sendToViewer(pending); pending = null; }
}

async function init() {
  const buffer = await fetch('/api/doc.pdf').then(r => r.arrayBuffer());
  const msg = { type: 'LOAD_SINGLEDOC', fileName: 'doc.pdf', buffer };
  if (viewerReady) sendToViewer(msg);
  else             pending = msg;
}
init();
```

---

#### `PDF_LOADED`

Document rendered — enable your UI.

```js
function onPdfLoaded({ fileName, pageCount, docId }) {
  document.getElementById('capture-btn').disabled = false;
}
```

---

#### `DOC_REQUEST`

User clicked a doc in MultiDoc sidebar — send its buffer.

```js
async function onDocRequest({ docId }) {
  const buffer = await fetch(`/api/docs/${docId}`).then(r => r.arrayBuffer());
  sendToViewer({ type: 'DOC_RESPONSE', docId, buffer });
}
```

---

#### `CAPTURE_PREVIEW`

User drew a box — fires immediately on draw, before any Submit button.

```js
function onCapturePreview({ tempId, text, page, x, y, width, height, docId, label }) {
  // Coordinates returned in the SAME FORMAT as your wordIndex/captures input.
  // If you sent pixels → you receive pixels back.
  // If no wordIndex/captures was sent → normalised 0-1 fractions.
  // Must CAPTURE_ACK within 15s or capture is discarded.
}
```

---

#### `CAPTURES_DATA`

Response to `EXPORT_CAPTURES`.

```js
function onCapturesData({ captures }) {
  // Array of capture objects — see Section 3 for shape
  saveToBackend(captures);
}
```

---

### Event Quick Reference

| Direction       | Event              | When                                        |
|-----------------|--------------------|---------------------------------------------|
| Parent → Viewer | `LOAD_SINGLEDOC`   | Load a single document                      |
| Parent → Viewer | `LOAD_MANIFEST`    | Load multi-doc session                      |
| Parent → Viewer | `DOC_RESPONSE`     | Deliver requested doc buffer                |
| Parent → Viewer | `CAPTURE_ACK`      | Confirm/reject/delete a capture             |
| Parent → Viewer | `HIGHLIGHT`        | Navigate to a field                         |
| Parent → Viewer | `EXPORT_CAPTURES`  | Request current captures                    |
| Viewer → Parent | `READY`            | Viewer mounted and listening                |
| Viewer → Parent | `PDF_LOADED`       | Document rendered, page count available     |
| Viewer → Parent | `DOC_REQUEST`      | User clicked a doc in MultiDoc sidebar      |
| Viewer → Parent | `CAPTURE_PREVIEW`  | User drew a box / double-clicked            |
| Viewer → Parent | `CAPTURES_DATA`    | Response to EXPORT_CAPTURES                 |

---

## Section 2 — Categories JSON (for `LOAD_SINGLEDOC`)

When loading a **single document**, `categories` groups pages by type and controls the thumbnail sidebar accordion.

### Format A — Bare array (recommended)

```json
[
  { "label": "Invoice",       "color": "#1a7fd4", "pages": [1, 2, 3]    },
  { "label": "Form 15CA",     "color": "#0f9e6e", "pages": [4, 5]       },
  { "label": "Bank Statement","color": "#d97706", "pages": [6, 7, 8, 9] }
]
```

### Format B — SingleDoc envelope

```json
{
  "mode": "SingleDoc",
  "categories": [
    { "label": "Invoice",   "color": "#1a7fd4", "pages": [1, 2, 3] },
    { "label": "Form 15CA", "color": "#0f9e6e", "pages": [4, 5]    }
  ]
}
```

### Field reference

| Property | Type     | Required | Notes                                                       |
|----------|----------|----------|-------------------------------------------------------------|
| `label`  | string   | ✅        | Shown in sidebar accordion header                           |
| `color`  | string   | ❌        | CSS colour. Auto-assigned from palette if omitted           |
| `pages`  | number[] | ✅        | 1-based page numbers. Pages not listed appear under "Others"|

> **Note:** The `categories` above (for `LOAD_SINGLEDOC`) use `{label, color, pages}`.
> For `LOAD_MANIFEST`, top-level categories use `{id, label, color}` — the `id` links
> to `document.category` or `pageCategories[].category`. If not sent, the viewer picks
> colours automatically from its built-in palette.

---

## Section 3 — Captured Fields JSON

Pre-existing captured fields. Appear as coloured boxes on the document (grey if no colour). Sent via `captures` property in `LOAD_SINGLEDOC`, `LOAD_MANIFEST`, or `DOC_RESPONSE`.

### Shape

```json
[
  {
    "id":     "inv_number",
    "value":  "INV-2024-001",
    "page":   1,
    "color":  "#1a7fd4",
    "x":      0.08,
    "y":      0.06,
    "width":  0.14,
    "height": 0.03
  }
]
```

### Field reference

| Property | Type   | Required | Notes                                                     |
|----------|--------|----------|-----------------------------------------------------------|
| `id`     | string | ✅        | Unique. Used for dedup and `HIGHLIGHT` navigation         |
| `value`  | string | ✅        | The captured text / field value                           |
| `page`   | number | ✅        | 1-based page number                                       |
| `color`  | string | ❌        | CSS colour for box border. Omit → grey box                |
| Coords   | —      | ✅        | Any of the 9 supported coordinate formats below           |

### Coordinate formats — all 9 supported

```jsonc
// Format 1 — flat x/y (normalised 0-1 or raw pixels — auto-detected)
{ "x": 0.08, "y": 0.06, "width": 0.14, "height": 0.03 }
{ "x": 50,   "y": 42,   "width": 88,   "height": 20   }

// Format 2 — bbox array [x, y, w, h]
{ "bbox": [0.08, 0.06, 0.14, 0.03] }
{ "bbox": [50, 42, 88, 20] }

// Format 3 — rectangle [x, y, w, h]
{ "rectangle": [0.08, 0.06, 0.14, 0.03] }

// Format 4 — rectangle corner points [x1, y1, x2, y2]
{ "rectangle": [50, 42, 138, 62] }

// Format 5 — coordinates [ymin, xmin, ymax, xmax] (Google Vision style)
{ "coordinates": [0.06, 0.08, 0.09, 0.22] }

// Format 6 — min/max flat
{ "xmin": 0.08, "ymin": 0.06, "xmax": 0.22, "ymax": 0.09 }

// Format 7 — bbox_relative polygon corners
{ "bbox_relative": [[0.08,0.06],[0.22,0.06],[0.22,0.09],[0.08,0.09]] }

// Format 8 — left/right/width/height  (left = x origin)
{ "left": 50, "right": 138, "width": 88, "height": 20 }
{ "left": 50, "right": 138, "width": 88, "height": 20, "top": 42 }

// Format 9 — four corners: left/right/top/bottom
{ "left": 50, "right": 138, "top": 42, "bottom": 62 }
```

**Auto-detection rule:** if any value > 1, treated as raw pixels and normalised using page dimensions. All values ≤ 1 treated as fractions.

### Round-trip fidelity

Coordinates you send are returned **in the same format** in `CAPTURE_PREVIEW` and `CAPTURES_DATA`. If you sent `{ x:50, y:42, width:88, height:20 }` you receive those exact pixel values back.

### Complete example

```json
[
  {
    "id": "inv_number", "value": "INV-2024-001",
    "page": 1, "color": "#1a7fd4",
    "x": 50, "y": 42, "width": 88, "height": 20
  },
  {
    "id": "inv_date", "value": "15-Jan-2024",
    "page": 1, "color": "#0f9e6e",
    "x": 0.60, "y": 0.06, "width": 0.18, "height": 0.03
  },
  {
    "id": "total_amount", "value": "₹1,25,000",
    "page": 2,
    "bbox": [320, 680, 200, 22]
  }
]
```

---

## Section 4 — word_index JSON

Maps every word/token on every page to its coordinates. Used for:
- **Click2Pick / Double-click** — detect which word was clicked
- **Search** — highlight matching words across pages
- **Duplicate detection** — light-pink boxes for duplicate captured values

### Format A — Flat array (recommended)

Each entry has a `page` field. The viewer groups by page automatically.

```json
[
  { "text": "Invoice",     "page": 1, "x": 50,  "y": 42,  "width": 88,  "height": 20 },
  { "text": "Number",      "page": 1, "x": 140, "y": 42,  "width": 66,  "height": 20 },
  { "text": "INV-001",     "page": 1, "x": 220, "y": 42,  "width": 100, "height": 20 },
  { "text": "Date",        "page": 1, "x": 50,  "y": 70,  "width": 44,  "height": 20 },
  { "text": "15-Jan-2024", "page": 1, "x": 140, "y": 70,  "width": 120, "height": 20 },
  { "text": "Total",       "page": 2, "x": 300, "y": 680, "width": 55,  "height": 20 },
  { "text": "₹1,25,000",   "page": 2, "x": 380, "y": 680, "width": 110, "height": 20 }
]
```

### Format B — Object keyed by page number

```json
{
  "1": [
    { "text": "Invoice", "x": 50,  "y": 42, "width": 88,  "height": 20 },
    { "text": "INV-001", "x": 220, "y": 42, "width": 100, "height": 20 }
  ],
  "2": [
    { "text": "Total",   "x": 300, "y": 680, "width": 55,  "height": 20 },
    { "text": "₹1,25,000","x": 380, "y": 680, "width": 110, "height": 20 }
  ]
}
```

### Field reference

| Property | Type   | Required        | Notes                                         |
|----------|--------|-----------------|-----------------------------------------------|
| `text`   | string | ✅               | The word / token text                         |
| `page`   | number | ✅ (Format A)    | 1-based. Not needed in Format B (key = page)  |
| Coords   | —      | ✅               | Any of the 9 coordinate formats from Section 3|

### Pixel vs normalised — same auto-detection as captures

```json
// Normalised:
{ "text": "Invoice", "page": 1, "x": 0.08, "y": 0.06, "width": 0.14, "height": 0.03 }

// Raw pixels:
{ "text": "Invoice", "page": 1, "x": 50, "y": 42, "width": 88, "height": 20 }
```

---

## Section 5 — Full Working Example

```js
const iframe = document.getElementById('doc-viewer');
const VIEWER = '*'; // 'https://your-viewer.com' in production

let viewerReady = false, pending = null;

window.addEventListener('message', async (e) => {
  const { type, ...data } = e.data ?? {};
  switch (type) {
    case 'READY': {
      viewerReady = true;
      if (pending) { iframe.contentWindow.postMessage(pending, VIEWER); pending = null; }
      break;
    }
    case 'PDF_LOADED': {
      document.getElementById('capture-btn').disabled = false;
      break;
    }
    case 'DOC_REQUEST': {
      const buf = await fetch(`/api/docs/${data.docId}`).then(r => r.arrayBuffer());
      iframe.contentWindow.postMessage(
        { type: 'DOC_RESPONSE', docId: data.docId, buffer: buf }, VIEWER
      );
      break;
    }
    case 'CAPTURE_PREVIEW': {
      const { tempId, text, page, x, y, width, height, docId } = data;
      const { id } = await fetch('/api/captures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, page, x, y, width, height, docId }),
      }).then(r => r.json());
      iframe.contentWindow.postMessage({ type: 'CAPTURE_ACK', tempId, id }, VIEWER);
      break;
    }
    case 'CAPTURES_DATA': {
      console.log('Exported captures:', data.captures);
      break;
    }
  }
});

async function loadSingleDoc() {
  const [buffer, wordIndex, captures] = await Promise.all([
    fetch('/api/invoice.pdf').then(r => r.arrayBuffer()),
    fetch('/api/invoice/words').then(r => r.json()),
    fetch('/api/invoice/captures').then(r => r.json()),
  ]);
  const msg = {
    type:            'LOAD_SINGLEDOC',
    fileName:        'invoice.pdf',
    buffer, wordIndex, captures,
    categories:      [{ label: 'Invoice', color: '#1a7fd4', pages: [1,2,3] }],
    Click2Pick:      true,
    showFieldsPanel: true,
  };
  if (viewerReady) iframe.contentWindow.postMessage(msg, VIEWER);
  else             pending = msg;
}

async function loadMultiPageDoc() {
  const activeBuffer = await fetch('/api/combined.pdf').then(r => r.arrayBuffer());
  const msg = {
    type: 'LOAD_MANIFEST',
    manifest: {
      mode: 'MultiDoc:MultiPage',
      categories: [
        { id: 'invoice',  label: 'Invoice',  color: '#1a7fd4' },
        { id: 'annexure', label: 'Annexure', color: '#9333ea' },
      ],
      documents: [{
        id: 'doc1', name: 'combined.pdf',
        pageCategories: [
          { category: 'invoice',  pages: [1, 2, 3] },
          { category: 'annexure', pages: [4, 5]    },
        ],
      }],
    },
    activeDocId: 'doc1',
    activeBuffer,
    showFieldsPanel: true,
  };
  if (viewerReady) iframe.contentWindow.postMessage(msg, VIEWER);
  else             pending = msg;
}

// Highlight a field
function highlight(field) {
  iframe.contentWindow.postMessage({
    type: 'HIGHLIGHT',
    payload: {
      id: field.id, label: field.label, value: field.value,
      page: field.page, x: field.x, y: field.y,
      width: field.width, height: field.height,
    },
  }, VIEWER);
}

// Request export
function exportCaptures() {
  iframe.contentWindow.postMessage({ type: 'EXPORT_CAPTURES' }, VIEWER);
}
```

---

## Environment Configuration

### Viewer `.env` (project root, same level as `package.json`)

```bash
VITE_PARENT_ORIGIN=*                           # development / standalone
VITE_PARENT_ORIGIN=https://your-parent.com    # production
```

### Production web server — cache headers

```nginx
location ~* \.(pfb|ttf|bcmap|mjs)$ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
```

Without these headers, pdfjs fetches fonts/CMaps on every page, adding 200–800 ms per page on moderate networks.
