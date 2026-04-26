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
  // if (e.origin !== VIEWER_ORIGIN) return; // enable in production
  
  if (e.data.type === 'READY') {
    viewerReady = true;
    trySendToViewer(); // attempt — may be no-op if API not done yet
  }

  if (e.data.type === 'PDF_LOADED') {
    // Viewer finished rendering — enable your UI buttons
    console.log('PDF loaded:', e.data.fileName, e.data.pageCount, 'pages');
    document.getElementById('action-btn').disabled = false;
  }

  if (e.data.type === 'DOC_REQUEST') {
    // MultiDoc: user clicked a doc — fetch and respond
    handleDocRequest(e.data.docId);
  }

  if (e.data.type === 'CAPTURE_PREVIEW') {
    handleCapturePreview(e.data);
  }
});

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




------------------------
-- For MultiDoc — same gate pattern:


  let viewerReady = false;
let manifestReady = false;
let pendingManifest = null;

function trySendManifest() {
  if (!viewerReady || !manifestReady || !pendingManifest) return;
  
  const { activeBuffer, ...rest } = pendingManifest;
  iframe.contentWindow.postMessage(
    { type: 'LOAD_MANIFEST', ...rest, activeBuffer },
    VIEWER_ORIGIN,
    activeBuffer ? [activeBuffer] : []
  );
  pendingManifest = null;
}

// API load
async function loadManifestFromAPI() {
  const [manifestRes, firstDocRes] = await Promise.all([
    fetch('/api/manifest/batch-001'),
    fetch('/api/document/doc1'),       // preload first doc
  ]);

  const manifest     = await manifestRes.json();
  const activeBuffer = await firstDocRes.arrayBuffer();

  pendingManifest = {
    manifest,
    activeDocId: manifest.documents[0].id,
    activeBuffer,
  };
  manifestReady = true;
  trySendManifest();
}

// Handle subsequent DOC_REQUEST (on-demand click)
async function handleDocRequest(docId) {
  try {
    const res    = await fetch(`/api/document/${docId}`);
    const buffer = await res.arrayBuffer();
    iframe.contentWindow.postMessage(
      { type: 'DOC_RESPONSE', docId, buffer },
      VIEWER_ORIGIN,
      [buffer]    // Transferable
    );
  } catch (err) {
    // Viewer will timeout after 15s and show NoPreview
    console.error('Failed to fetch doc:', docId, err);
  }
}




--------------------


-- For CAPTURE_PREVIEW → save to backend → send ACK:


async function handleCapturePreview(data) {
  const { tempId, text, page, x, y, width, height, docId, label } = data;
  try {
    const res    = await fetch('/api/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, page, x, y, width, height, docId, label }),
    });
    const { id } = await res.json();   // backend returns the real ID

    iframe.contentWindow.postMessage(
      { type: 'CAPTURE_ACK', tempId, id },
      VIEWER_ORIGIN
    );
  } catch (err) {
    // Don't send ACK — viewer will timeout and show error
    // Viewer will NOT add the capture to its list (by design)
    console.error('Capture save failed:', err);
  }
}


----------------

  t=0   Parent starts:  loadFromAPI() called immediately
t=0   Viewer mounts:  READY fires
t=0   trySendToViewer(): viewerReady=true, apiDataReady=false → no-op

t=1.2s  API responds:  pendingPayload set, apiDataReady=true
t=1.2s  trySendToViewer(): BOTH ready → sends LOAD_SINGLEDOC ✓

--- OR if API is faster than viewer mount ---

t=0   Parent starts:  loadFromAPI() called
t=0.3s  API responds:  pendingPayload set, apiDataReady=true
t=0.3s  trySendToViewer(): viewerReady=false → no-op

t=0.8s  Viewer mounts:  READY fires, viewerReady=true
t=0.8s  trySendToViewer(): BOTH ready → sends LOAD_SINGLEDOC ✓
