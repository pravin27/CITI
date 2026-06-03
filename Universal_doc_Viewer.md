# DocCapture Viewer — Integration Guide

> **Scope:** Every postMessage event (parent → viewer and viewer → parent), all coordinate formats, and every property accepted on `LOAD_SINGLEDOC` / `LOAD_MANIFEST`.  
> All events use `window.postMessage` over the iframe boundary.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Parent → Viewer Events](#2-parent--viewer-events)
   - 2.1 LOAD_SINGLEDOC
   - 2.2 LOAD_MANIFEST
   - 2.3 DOC_RESPONSE
   - 2.4 HIGHLIGHT
   - 2.5 CAPTURE_ACK
   - 2.6 DELETE_CAPTURE
   - 2.7 SET_CAPTURES
   - 2.8 EXPORT_CAPTURES
   - 2.9 RESET_VIEWER
   - 2.10 READY_CONFIG
3. [Viewer → Parent Events](#3-viewer--parent-events)
   - 3.1 READY
   - 3.2 DOC_LOADED
   - 3.3 DOC_LOAD_ERROR
   - 3.4 DOC_REQUEST
   - 3.5 CAPTURE_PREVIEW
   - 3.6 CAPTURES_DATA
   - 3.7 VIEWER_STATE_CHANGED
   - 3.8 RETRIGGER_CLICKED
   - 3.9 DISCARD_CLICKED
4. [Coordinate Formats](#4-coordinate-formats)
5. [Initial Load Properties Reference](#5-initial-load-properties-reference)

---

## 1. Quick Start

```js
const iframe = document.querySelector('iframe#docviewer');

// Listen for all viewer → parent events
window.addEventListener('message', (e) => {
  const { type, ...data } = e.data;
  switch (type) {
    case 'READY':       loadDocument(); break;
    case 'DOC_LOADED':  console.log('Loaded:', data.fileName, data.pageCount, 'pages'); break;
    case 'DOC_REQUEST': respondWithBuffer(data.docId); break;
  }
});

function loadDocument() {
  iframe.contentWindow.postMessage({
    type:     'LOAD_SINGLEDOC',
    buffer:   myArrayBuffer,   // or url: 'blob:...'
    fileName: 'invoice.pdf',
  }, '*');
}
```

---

## 2. Parent → Viewer Events

### 2.1 `LOAD_SINGLEDOC`

Loads a single document into the viewer. Clears any existing document and resets all state.  
Send `buffer` (raw bytes) or `url` (blob/HTTPS) — the viewer fetches URLs itself to avoid transfer-detach issues.

```js
iframe.contentWindow.postMessage({
  type:     'LOAD_SINGLEDOC',
  buffer:   arrayBuffer,       // Required (pick one): raw file bytes
  // url:   'blob:https://…', // Or a blob:/https: URL — viewer fetches it
  fileName: 'invoice.pdf',

  // ── Optional metadata ──
  fullPageOCR:       { 1: [...], 2: [...] },  // OCR data for Click2Pick / search
  categories:        [...],                    // Pre-load category definitions
  captures:          [...],                    // Pre-load existing captured fields
  Click2Pick:        true,                     // Enable box-capture mode on load
  persistHighlights: false,                    // false = transient yellow; true = grey boxes persist
  initialZoom:       'page-fit',               // Zoom on load — see §5 for all values
  coordinateSpace:   'norm',                   // Override coord auto-detection: 'px'|'pt'|'norm'
  showThumbnailView: true,                     // Show/hide thumbnail sidebar icon
  openThumbnail:     false,                    // Auto-open thumbnail panel on load
  showAnnotation:    false,                    // Show/hide the Annotate toolbar button
  showSplitMerge:    false,                    // Show/hide the Split & Merge toolbar button
  isSplitScreen:     false,                    // Show Retrigger/Discard bar in sidebar
  debugArea:         false,                    // Show/hide the right-side fields debug panel
}, '*');
```

**Buffer delivery options (in priority order):**

| Option | Field | Notes |
|--------|-------|-------|
| 1st choice | `url: 'blob:...'` | Viewer fetches itself — no transfer/detach risk |
| 2nd choice | `buffer: ArrayBuffer` | Do NOT include in transfer list — use `structuredClone()` |
| Fallback | _(neither)_ | Viewer attempts internal cache; emits `DOC_LOAD_ERROR` if empty |

---

### 2.2 `LOAD_MANIFEST`

Loads a multi-document session in either `MultiDoc:SinglePage` or `MultiDoc:MultiPage` mode. Resets all state.  
Each document entry can carry its own data source; documents without one trigger a `DOC_REQUEST` on navigation.

```js
iframe.contentWindow.postMessage({
  type:         'LOAD_MANIFEST',
  activeDocId:  'doc-001',           // Which document to show first
  activeBuffer: arrayBuffer,         // Buffer for the first doc (optional, avoids DOC_REQUEST)

  manifest: {
    mode: 'MultiDoc:SinglePage',     // or 'MultiDoc:MultiPage'

    // Optional — omit to auto-derive from documents[].category values
    categories: [
      { id: 'invoice',  label: 'Invoice',  color: '#1D9E75' },
      { id: 'contract', label: 'Contract', color: '#378ADD' },
    ],

    documents: [
      // ── MultiDoc:SinglePage ──────────────────────────────────────────────
      { id: 'doc-001', name: 'Invoice Jan.pdf', category: 'invoice',
        src: 'https://cdn.example.com/inv-jan.pdf' },

      // ── MultiDoc:MultiPage ───────────────────────────────────────────────
      { id: 'doc-002', name: 'Mixed Doc.pdf',
        pageCategories: [
          { category: 'invoice',  pages: [1, 2, 3] },
          { category: 'contract', pages: [4, 5]    },
        ]
      },
    ],
  },

  // Same optional meta as LOAD_SINGLEDOC
  fullPageOCR:       { 1: [...] },
  persistHighlights: false,
  initialZoom:       'page-fit',
  showThumbnailView: true,
  openThumbnail:     true,
  isSplitScreen:     false,
}, '*');
```

**Document data sources — pick exactly one per document entry:**

| Field | Type | Description |
|-------|------|-------------|
| `src` | `string` | HTTP/HTTPS URL or `blob:` URL — viewer fetches on demand |
| `dataUrl` | `string` | `data:application/pdf;base64,…` — decoded by viewer |
| `base64` | `string` | Raw base64 string, no prefix |
| _(none)_ | — | Viewer fires `DOC_REQUEST` for this docId; parent responds with `DOC_RESPONSE` |

---

### 2.3 `DOC_RESPONSE`

Response to the viewer's `DOC_REQUEST`. Must arrive within **60 seconds** or the viewer emits `DOC_LOAD_ERROR { code: 'DOC_REQUEST_TIMEOUT' }`.  
Optionally includes OCR data, categories, or captures that apply only to this specific document.

```js
window.addEventListener('message', async (e) => {
  if (e.data.type !== 'DOC_REQUEST') return;
  const { docId } = e.data;
  const buffer = await fetchDocumentBuffer(docId);

  iframe.contentWindow.postMessage({
    type:  'DOC_RESPONSE',
    docId,                           // Required — must echo the requested docId

    // Document data — pick one:
    buffer,                          // ArrayBuffer (do NOT use transfer list)
    // url: 'blob:https://…',        // Preferred for large files

    // Optional metadata for this specific document:
    fullPageOCR: { 1: [...] },       // OCR data applied to this doc only
    categories:  [...],              // Categories for this doc only
    captures:    [...],              // Pre-existing captures for this doc
  }, '*');
});
```

---

### 2.4 `HIGHLIGHT`

Draws a highlight box on a specific page and optionally adds it to the captures panel. The viewer navigates to the target page automatically.  
Coordinates can be in any supported format (see §4) — unit is auto-detected.

```js
iframe.contentWindow.postMessage({
  type: 'HIGHLIGHT',
  payload: {
    id:    'field-001',              // Required — unique identifier for deduplication
    page:  2,                        // 1-based page number
    x:     0.12, y: 0.34,           // Top-left origin (0–1 normalised)
    width: 0.40, height: 0.05,      // Box dimensions (0–1 normalised)

    // Optional
    label:  'Invoice Number',        // Display label in captures panel
    value:  'INV-2024-001',          // Captured text value
    color:  '#1D9E75',               // Box colour (CSS colour string)
    docId:  'doc-001',               // MultiDoc: target a specific document
  }
}, '*');
```

---

### 2.5 `CAPTURE_ACK`

Acknowledges a `CAPTURE_PREVIEW` from the viewer — confirms the capture was saved with a permanent ID, or signals deletion.  
Must be sent within 25 seconds of receiving `CAPTURE_PREVIEW` or the viewer clears the pending preview.

```js
// Normal ACK — confirm and assign real ID
iframe.contentWindow.postMessage({
  type:   'CAPTURE_ACK',
  tempId: e.data.tempId,            // Echo back the tempId from CAPTURE_PREVIEW
  id:     'saved-uuid-123',         // Permanent ID from your backend
  x: 0.12, y: 0.34, width: 0.40, height: 0.05,  // Confirmed coords
}, '*');

// Delete ACK — remove an existing confirmed capture
iframe.contentWindow.postMessage({
  type:   'CAPTURE_ACK',
  id:     'saved-uuid-123',         // The real ID to delete
  delete: true,
}, '*');
```

---

### 2.6 `DELETE_CAPTURE`

Removes a confirmed capture by its permanent ID. Simpler alternative to `CAPTURE_ACK + delete: true`.  
No `tempId` required — works on any capture that was previously saved.

```js
iframe.contentWindow.postMessage({
  type: 'DELETE_CAPTURE',
  id:   'saved-uuid-123',           // Required — permanent capture ID
}, '*');
```

---

### 2.7 `SET_CAPTURES`

Loads or merges captures at any time after the document is already showing — no document reload needed.  
Use `mode: 'merge'` to upsert by ID while keeping existing captures; `'replace'` (default) replaces all.

```js
iframe.contentWindow.postMessage({
  type:     'SET_CAPTURES',
  mode:     'replace',              // 'replace' (default) or 'merge' (upsert by id)
  docId:    'doc-001',              // MultiDoc only — target a specific document
  captures: [
    { id: 'f1', label: 'Invoice No', value: 'INV-001',
      page: 1, x: 0.1, y: 0.12, width: 0.25, height: 0.03 }
  ],
}, '*');
```

---

### 2.8 `EXPORT_CAPTURES`

Requests the viewer to return all current captured fields. Viewer responds synchronously with `CAPTURES_DATA`.  
No payload needed — the response includes every capture currently in the viewer for all documents.

```js
iframe.contentWindow.postMessage({ type: 'EXPORT_CAPTURES' }, '*');

window.addEventListener('message', (e) => {
  if (e.data.type === 'CAPTURES_DATA') {
    console.log(e.data.captures);   // Array of ExportedCapture objects
  }
});
```

---

### 2.9 `RESET_VIEWER`

Clears everything and returns the viewer to a blank "no document" state. Also clears the internal buffer cache.  
Send this before loading a completely new document set, or when navigating away from the viewer.

```js
iframe.contentWindow.postMessage({ type: 'RESET_VIEWER' }, '*');
```

---

### 2.10 `READY_CONFIG`

Sent in response to the viewer's `READY` event to supply initial configuration before the first document loads.  
Use this to pass flags that should apply globally rather than per-document.

```js
window.addEventListener('message', (e) => {
  if (e.data.type !== 'READY') return;
  iframe.contentWindow.postMessage({
    type:               'READY_CONFIG',
    enableCaptureDebug: false,       // Show/hide the right-side fields debug panel
    Click2Pick:         false,       // Enable box-capture mode
    showSplitMerge:     false,       // Show Split & Merge toolbar icon
    initialZoom:        'page-fit',
  }, '*');
});
```

---

## 3. Viewer → Parent Events

### 3.1 `READY`

Fired once when the viewer mounts and its postMessage listener is active. Parent should load the document in response.  
No payload — receipt of this event is the signal to send `LOAD_SINGLEDOC` or `LOAD_MANIFEST`.

```js
{ type: 'READY' }
```

---

### 3.2 `DOC_LOADED`

Fired once per document after the first page has rendered successfully. Use this to hide loading spinners or unlock UI.  
`docId` is `undefined` in SingleDoc mode; present in MultiDoc for every document that loads.

```js
{ type: 'DOC_LOADED', fileName: 'invoice.pdf', pageCount: 12, docId: 'doc-001' }
```

---

### 3.3 `DOC_LOAD_ERROR`

Fired whenever a document fails to load at any stage. Includes a machine-readable `code` for programmatic handling.  
`docId` is included for MultiDoc failures so the parent can identify which document in the set failed.

```js
{
  type:     'DOC_LOAD_ERROR',
  code:     'INVALID_BUFFER',        // See error codes below
  reason:   'Human-readable explanation string',
  fileName: 'invoice.pdf',           // When available
  docId:    'doc-001',               // MultiDoc only
}
```

**Error codes:**

| Code | Triggered by |
|------|-------------|
| `INVALID_BUFFER` | Buffer null/empty/detached, URL fetch failed, malformed manifest |
| `CORRUPT_FILE` | File parsed but content unreadable (e.g. corrupt PDF bytes) |
| `UNSUPPORTED_FORMAT` | File extension not supported by the viewer |
| `DOC_REQUEST_TIMEOUT` | Parent did not respond to `DOC_REQUEST` within 60 s |
| `RENDER_FAILED` | File loaded but page rendering failed |
| `UNKNOWN` | Unexpected error not matching the above |

---

### 3.4 `DOC_REQUEST`

Fired when the viewer needs the binary for a MultiDoc document that has no inline data source in the manifest.  
Parent must respond with `DOC_RESPONSE` within 60 seconds; after that the viewer emits `DOC_LOAD_ERROR`.

```js
{ type: 'DOC_REQUEST', docId: 'doc-003' }
```

---

### 3.5 `CAPTURE_PREVIEW`

Fired when the user draws a box (Click2Pick mode) or double-clicks a word. Parent must respond with `CAPTURE_ACK`.  
`tempId` is the correlation ID — echo it in the ACK. Coordinates are always 0–1 normalised in the outbound direction.

```js
{
  type:    'CAPTURE_PREVIEW',
  tempId:  'tmp_1719000000000_1',   // Echo in CAPTURE_ACK
  text:    'INV-2024-001',           // Captured text
  page:    2,
  x: 0.12, y: 0.34, width: 0.40, height: 0.05,  // 0–1 normalised
  docId:   'doc-001',                // MultiDoc only
  label:   'Invoice Number',         // If pre-assigned
  color:   '#1D9E75',
  bbox:    [2, 0.12, 0.34, 0.40, 0.05],  // Present when original was FORMAT 10
}
```

---

### 3.6 `CAPTURES_DATA`

Response to `EXPORT_CAPTURES`. Contains all currently captured fields across all documents.  
Coordinate keys (`x/y/width/height`, `bbox`, `rectangle`, `coordinates`) match the format the parent originally sent.

```js
{
  type:     'CAPTURES_DATA',
  captures: [
    { id: 'f1', value: 'INV-001', page: 1,
      x: 0.1, y: 0.12, width: 0.25, height: 0.03, color: '#1D9E75' }
  ]
}
```

---

### 3.7 `VIEWER_STATE_CHANGED`

Fired whenever the user navigates to a different page or switches documents. Deduplicated — only fires on real changes.  
Covers all navigation paths: toolbar arrows, thumbnail clicks, PDF scroll, keyboard, and MultiDoc document switches.

```js
{
  type:      'VIEWER_STATE_CHANGED',
  page:      3,                       // Current 1-based page number
  pageCount: 12,
  fileName:  'invoice.pdf',
  docId:     'doc-001',               // undefined in SingleDoc mode
  docLabel:  'Invoice Jan.pdf',       // Human-readable name from manifest
  mode:      'MultiDoc:SinglePage',   // undefined in SingleDoc mode
  totalDocs: 5,                       // undefined in SingleDoc mode
}
```

---

### 3.8 `RETRIGGER_CLICKED`

Fired when the user confirms the Retrigger action in the split-screen sidebar (visible when `isSplitScreen: true`).  
Parent uses this to re-run classification; the `categories` array reflects the current state at time of click.

```js
{
  type:       'RETRIGGER_CLICKED',
  mode:       'retrigger',
  fileName:   'invoice.pdf',
  page:       3,
  pageCount:  12,
  categories: [...],                  // Current category assignments at time of click
}
```

---

### 3.9 `DISCARD_CLICKED`

Fired when the user confirms Discard in the split-screen sidebar. Reverts the viewer to the original category state.  
`categories` contains the original values before any Split & Merge reclassification was applied.

```js
{
  type:       'DISCARD_CLICKED',
  fileName:   'invoice.pdf',
  page:       3,
  pageCount:  12,
  categories: [...],                  // Original categories (before SM changes)
}
```

---

## 4. Coordinate Formats

All coordinates are stored internally as **0–1 fractions** of the page dimensions. The viewer auto-detects the unit from raw values unless `coordinateSpace` is set explicitly on the load event.

### Supported input formats

| Format | Fields | Example |
|--------|--------|---------|
| **FORMAT 1** — flat x/y | `x, y, width, height` | `{ x:0.1, y:0.2, width:0.3, height:0.05 }` |
| **FORMAT 2** — bbox array | `bbox: [x, y, w, h]` | `{ bbox: [0.1, 0.2, 0.3, 0.05] }` |
| **FORMAT 3** — rectangle w/h | `rectangle: [x, y, w, h]` | `{ rectangle: [72, 144, 216, 36] }` |
| **FORMAT 4** — rectangle corners | `rectangle: [x1, y1, x2, y2]` | `{ rectangle: [72, 144, 288, 180] }` |
| **FORMAT 5** — coordinates | `coordinates: [ymin, xmin, ymax, xmax]` | `{ coordinates: [0.2, 0.1, 0.25, 0.4] }` |
| **FORMAT 6** — min/max flat | `xmin, ymin, xmax, ymax` | `{ xmin:72, ymin:144, xmax:288, ymax:180 }` |
| **FORMAT 7** — bbox_relative polygon | `bbox_relative: [[x,y],…]` | `{ bbox_relative: [[0.1,0.2],[0.4,0.2],…] }` |
| **FORMAT 8** — left/right/width/height | `left, right, width, height` | `{ left:72, right:288, width:216, height:36 }` |
| **FORMAT 9** — four edges | `left, right, top, bottom` | `{ left:72, right:288, top:144, bottom:180 }` |
| **FORMAT 10** — page-prefixed bbox (Gemini) | `bbox: [page, x, y, w, h]` | `{ bbox: [2, 183, 240, 90, 15] }` |

### Unit auto-detection

The viewer compares raw coordinate extents against actual page dimensions loaded from the document:

| Detected unit | Condition |
|---------------|-----------|
| **0–1 normalised** | All values ≤ 1 — used as-is, no conversion |
| **PDF points** | Values ≈ page size in pts (Letter = 612 × 792, A4 = 595 × 842) |
| **Pixels @ 96 dpi** | Values ≈ page × 1.333 (96/72 scale factor) |
| **Pixels @ 150 / 200 / 300 dpi** | Values match higher-DPI page extents |
| **Inches** | Values ≈ page / 72 |
| **Centimetres** | Values ≈ page / 28.35 |

### Explicit coordinate space override

Add `coordinateSpace` to the load event to bypass auto-detection entirely:

```js
coordinateSpace: 'px'    // Force pixel interpretation
coordinateSpace: 'pt'    // Force PDF points interpretation
coordinateSpace: 'norm'  // Force 0–1 normalised (no conversion)
```

### FORMAT 10 (Gemini grid) special behaviour

`bbox[0]` is the **1-based page number** and is extracted automatically as the page for that capture.  
`bbox[1..4]` are coordinates in the 0–1000 Gemini grid — divided by 1000 to produce 0–1 fractions. The original `bbox` array is preserved and round-tripped verbatim in `CAPTURE_PREVIEW`.

---

## 5. Initial Load Properties Reference

All properties below apply to both `LOAD_SINGLEDOC` and `LOAD_MANIFEST` as top-level fields. Properties marked **MANIFEST ONLY** are exclusive to `LOAD_MANIFEST`.

### Document data

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `buffer` | `ArrayBuffer` | One of these two | — | Raw document bytes. Do not pass in the transfer list — the buffer detaches and the viewer receives empty bytes. |
| `url` | `string` | One of these two | — | Blob or HTTPS URL. Viewer fetches it internally, avoiding any transfer or detach risk. Preferred for large files. |
| `fileName` | `string` | Yes | `'document.pdf'` | File name including extension. Used for format detection, the download button label, and error reporting. |

### Content

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `fullPageOCR` | `Record<number, WordEntry[]>` | — | Page-indexed OCR/text data powering Click2Pick word selection and in-viewer search. Preferred over the deprecated `wordIndex` alias. |
| `wordIndex` | `Record<number, WordEntry[]>` | — | Deprecated alias for `fullPageOCR`. Still accepted; if both are present, `fullPageOCR` takes priority. |
| `categories` | `Category[]` | — | Category definitions with label and colour, applied to the sidebar and thumbnail grouping panels. |
| `captures` | `CaptureItem[]` | — | Pre-existing captured fields displayed in the fields panel immediately on load, before any user interaction. |

### Viewer behaviour

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `Click2Pick` | `boolean` | `false` | Immediately activates box-capture / click-to-pick mode when the document finishes loading. |
| `persistHighlights` | `boolean` | `false` | When `false`, highlight boxes are transient (yellow flash only). When `true`, grey boxes persist in position after each `HIGHLIGHT` event. |
| `initialZoom` | `string \| number` | `'page-fit'` | Zoom level applied on load. Accepted strings: `'page-fit'`, `'page-width'`, `'actual'` (aliases: `'fit'`, `'width'`, `'100%'`). Numeric values like `1.5` set an explicit zoom level (1.0 = 100%). |
| `coordinateSpace` | `'px' \| 'pt' \| 'norm'` | auto-detect | Forces the coordinate unit for all captures in this load event, bypassing the auto-detection logic entirely. |

### UI toggles

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `showThumbnailView` | `boolean` | `true` | Shows or hides the thumbnail sidebar icon and the entire thumbnail panel. |
| `openThumbnail` | `boolean` | `false` | Auto-opens the thumbnail sidebar on load; the icon remains visible and the user can close it manually. |
| `showAnnotation` | `boolean` | `false` | Shows the Annotate / Draw button in the toolbar. Hidden by default to keep the toolbar minimal. |
| `showSplitMerge` | `boolean` | `false` | Shows the Split & Merge scissors icon in the toolbar. Requires `VITE_SPLIT_MERGE_URL` set in the viewer's `.env`. |
| `isSplitScreen` | `boolean` | `false` | Enables the Retrigger / Discard action bar at the bottom of the thumbnail sidebar, used in split-screen classification workflows. |
| `debugArea` | `boolean` | `false` | Shows or hides the right-side fields debug panel (capture details, coordinate display, legends). Alias: `showFieldsPanel`. |

### LOAD_MANIFEST-only

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `manifest.mode` | `'MultiDoc:SinglePage' \| 'MultiDoc:MultiPage'` | Yes | SinglePage assigns one category per document; MultiPage assigns categories per page-range within each document. |
| `manifest.categories` | `ManifestCategory[]` | No | Category definitions with `id`, `label`, and optional `color`. If omitted, categories are auto-derived from documents and assigned palette colours automatically. |
| `manifest.documents` | `ManifestDocument[]` | Yes | Ordered list of documents with their data source and category assignments. |
| `activeDocId` | `string` | No | ID of the document to display first. If omitted, the first entry in `manifest.documents` is selected. |
| `activeBuffer` | `ArrayBuffer` | No | Buffer for the first document. Providing it prevents a `DOC_REQUEST` round-trip on initial load. |

---

*Generated from source: `useEventBridge.ts` · `App.tsx` · `PDFViewer.tsx` · `appStore.ts` · `coords.ts` · `types/multiDoc.ts`*
