const VIEWER_ORIGIN = 'https://your-viewer-domain.com'; // or '*' for dev
const iframe = document.getElementById('doc-viewer');

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