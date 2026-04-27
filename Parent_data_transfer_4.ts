Parent-side code samples
1 — Send Click2Pick on READY:
jswindow.addEventListener('message', (e) => {
  if (e.data.type !== 'READY') return;

  // SingleDoc with Click2Pick enabled
  iframe.contentWindow.postMessage({
    type:       'LOAD_SINGLEDOC',
    fileName:   'invoice.pdf',
    buffer,
    Click2Pick: true,   // ← viewer enables box-capture mode immediately on load
  }, '*');

  // OR MultiDoc with Click2Pick
  iframe.contentWindow.postMessage({
    type:        'LOAD_MANIFEST',
    manifest:    { ... },
    activeDocId: 'doc1',
    activeBuffer: buf1,
    Click2Pick:  true,   // ← same property, same behaviour
  }, '*');
});


// 1. Trigger — ask viewer for current captures
function requestCaptures() {
  iframe.contentWindow.postMessage(
    { type: 'EXPORT_CAPTURES' },
    VIEWER_ORIGIN
  );
}

// 2. Listen — viewer responds with data
window.addEventListener('message', (e) => {
  if (e.data.type !== 'CAPTURES_DATA') return;

  const captures = e.data.captures;
  // Each item: { id, value, page, color?, x?, y?, width?, height?, bbox?, ... }
  console.log('Received captures:', captures);

  // Save to backend, update your UI, etc.
});
