// ── Parent application ──────────────────────────────────────────────────────

const VIEWER_ORIGIN = '*'; // or 'https://your-viewer-domain.com'
const iframe = document.getElementById('doc-viewer');

// State flags
let viewerReady = false;
let apiDataReady = false;
let pendingPayload = null;

// Called when BOTH viewer is ready AND API data is loaded
function trySendToViewer() {
  if (!viewerReady || !apiDataReady || !pendingPayload) return;
  
  // Transfer the buffer (zero-copy)
  const { buffer, ...rest } = pendingPayload;
  iframe.contentWindow.postMessage(
    { type: 'LOAD_SINGLEDOC', ...rest, buffer },
    VIEWER_ORIGIN,
    buffer ? [buffer] : []   // Transferable
  );
  
  pendingPayload = null; // sent — clear
}

// ── Gate 1: Viewer fires READY ──────────────────────────────────────────────
window.addEventListener('message', (e) => {
  // Origin check on parent side too
  // if (e.origin !== VIEWER_ORIGIN) return;

  if (e.data.type === 'READY') {
    // SingleDoc:
    const buffer = await fetchPdf('invoice.pdf');
    iframe.contentWindow.postMessage(
      { type: 'LOAD_SINGLEDOC',
        fileName: 'invoice.pdf',
        buffer,                      // ArrayBuffer
        wordIndex: [...],            // optional
        categories: [...],           // optional
        captures: [...]              // optional pre-existing captures
      },
      VIEWER_ORIGIN,
      [buffer]                       // ← Transferable: zero-copy
    );

    // OR MultiDoc:
    const firstBuf = await fetchPdf('doc1.pdf');
    iframe.contentWindow.postMessage(
      { type: 'LOAD_MANIFEST',
        manifest: { mode: 'MultiDoc:MultiPage', documents: [...] },
        activeDocId: 'doc1',
        activeBuffer: firstBuf
      },
      VIEWER_ORIGIN,
      [firstBuf]                     // ← Transferable
    );
  }

  if (e.data.type === 'PDF_LOADED') {
    // Viewer finished rendering — enable your action buttons
    const { fileName, pageCount, docId } = e.data;
    enableActionButtons();
  }

  if (e.data.type === 'DOC_REQUEST') {
    // User clicked a doc in MultiDoc sidebar
    const { docId } = e.data;
    const buffer = await fetchPdfFromBackend(docId);
    iframe.contentWindow.postMessage(
      { type: 'DOC_RESPONSE', docId, buffer },
      VIEWER_ORIGIN,
      [buffer]                       // ← Transferable
    );
  }

  if (e.data.type === 'CAPTURE_PREVIEW') {
    // User drew a box and submitted — save to backend
    const { tempId, text, page, x, y, width, height, docId, label } = e.data;
    const { id } = await saveFieldToBackend({ text, page, x, y, width, height, docId, label });
    // ACK back with real ID
    iframe.contentWindow.postMessage(
      { type: 'CAPTURE_ACK', tempId, id },
      VIEWER_ORIGIN
    );
  }
});

// Send highlight to navigate viewer:
function highlightField(field) {
  iframe.contentWindow.postMessage(
    { type: 'HIGHLIGHT',
      payload: {
        id: field.id,           // if exists in viewer → navigate + highlight
        label: field.label,     // if not exists → add to captures
        value: field.value,
        page: field.page,
        x: field.x, y: field.y,
        width: field.width, height: field.height,
        docId: field.docId      // for MultiDoc
      }
    },
    VIEWER_ORIGIN
  );
}

// ── Gate 2: Your API calls complete ─────────────────────────────────────────
async function loadFromAPI() {
  try {
    // Your existing API calls — run independently of viewer
    const [docResponse, metaResponse] = await Promise.all([
      fetch('/api/document/invoice-001'),
      fetch('/api/document/invoice-001/meta'),
    ]);

    const buffer     = await docResponse.arrayBuffer();
    const meta       = await metaResponse.json();

    // Store payload — ready to send whenever viewer is ready
    pendingPayload = {
      fileName:   'invoice-001.pdf',
      buffer,
      wordIndex:  meta.wordIndex,   // optional
      categories: meta.categories,  // optional
      captures:   meta.captures,    // optional pre-existing captures
    };

    apiDataReady = true;
    trySendToViewer(); // attempt — may be no-op if viewer not ready yet
    
  } catch (err) {
    console.error('API failed:', err);
    // Optionally send an error to viewer:
    // iframe.contentWindow.postMessage({ type: 'LOAD_ERROR', message: err.message }, VIEWER_ORIGIN);
  }
}

// Start API calls immediately — don't wait for viewer
loadFromAPI();


// LOAD_MANIFEST (initial load) — with optional meta for first doc:

const [manifestRes, firstDocRes, metaRes] = await Promise.all([
  fetch('/api/manifest/batch-001'),
  fetch('/api/document/doc1'),
  fetch('/api/document/doc1/meta'),  // wordIndex, categories, captures
]);

const manifest     = await manifestRes.json();
const activeBuffer = await firstDocRes.arrayBuffer();
const meta         = await metaRes.json();

iframe.contentWindow.postMessage(
  {
    type:        'LOAD_MANIFEST',
    manifest,
    activeDocId: 'doc1',
    activeBuffer,
    // Optional — only for the first/active doc
    wordIndex:   meta.wordIndex,    // { 1: [...], 2: [...] }
    categories:  meta.categories,   // [{ label, color, pages }]
    captures:    meta.captures,     // pre-existing captures with real IDs
  },
  VIEWER_ORIGIN,
  [activeBuffer]   // Transferable — zero copy
);


// DOC_RESPONSE (on-demand click) — with optional meta for that doc:

async function handleDocRequest(docId) {
  // Fetch doc + its meta in parallel
  const [docRes, metaRes] = await Promise.all([
    fetch(`/api/document/${docId}`),
    fetch(`/api/document/${docId}/meta`),  // optional — skip if no meta needed
  ]);

  const buffer = await docRes.arrayBuffer();
  const meta   = metaRes.ok ? await metaRes.json() : {};

  iframe.contentWindow.postMessage(
    {
      type:   'DOC_RESPONSE',
      docId,
      buffer,
      // Optional — applies to this doc when it loads
      wordIndex:  meta.wordIndex  ?? undefined,
      categories: meta.categories ?? undefined,
      captures:   meta.captures   ?? undefined,
    },
    VIEWER_ORIGIN,
    [buffer]   // Transferable
  );
}

The applyDocMeta helper in App.tsx is shared between all three flows (SingleDoc, Manifest first-doc, and per-doc response) so the logic is in one place. When wordIndex arrives it replaces the current one — this is correct because in MultiDoc each document has its own word index.