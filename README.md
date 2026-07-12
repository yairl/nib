# Inkwell

Fill and sign PDFs in the browser. Nothing is uploaded: the file is parsed with
pdf.js, annotations are placed on an overlay, and the final PDF is written with
pdf-lib entirely client-side.

- `server.js` - zero-dependency Node static server (plus a reserved `/api/*` namespace
  for future server-side features).
- `public/index.html` - the whole app.
