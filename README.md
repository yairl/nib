# Inkwell

Fill and sign PDFs in the browser. Nothing is uploaded: the file is parsed with
pdf.js, annotations are placed on an overlay, and the final PDF is written with
pdf-lib entirely client-side.

- `server.js` - Node static server plus an OAuth-gated `/api/signatures` API.
  Signed-in users (Google sign-in via xhost) can store up to 20 named
  signatures in Postgres; every signature path requires a verified identity
  cookie and is scoped to the caller. Identity is read only from the
  RS256-verified `__Host-xhost_id` cookie, never from request headers.
- `public/index.html` - the whole app.
