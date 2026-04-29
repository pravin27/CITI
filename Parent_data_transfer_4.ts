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

//updated
iframe.contentWindow.postMessage({
  type:           'LOAD_SINGLEDOC',
  fileName:       'invoice.pdf',
  buffer,
  showFieldsPanel: true,   // show right panel
  showAnnotation:  true,   // show annotation button
  Click2Pick:      true,   // enable box mode on load
}, '*');


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


location ~* \.(mjs|js|css|png|svg|ico|woff2?)$ {
        root /usr/share/nginx/html;    # ← same dist folder
        try_files $uri =404;           # return 404 if not found, NOT index.html
        add_header Content-Type "application/javascript";
        add_header Cache-Control "public, max-age=31536000, immutable";
}
