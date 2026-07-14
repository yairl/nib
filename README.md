# Inkwell

Fill and sign PDFs in the browser. Nothing is uploaded: the file is parsed with
pdf.js, annotations are placed on an overlay, and the final PDF is written with
pdf-lib entirely client-side.

The app also detects a PDF's native interactive form fields (AcroForm) and lets
you fill them inline — text, checkbox, radio, and dropdown/list fields aligned
to their real rects. On save, values are written by field name with pdf-lib,
appearances are regenerated, and the form is flattened so it renders in every
viewer.

Four document-level tools, all 100% client-side (nothing uploaded):

- **Redact** (`R`) — drag a box to permanently black out content. Redaction is
  *destructive and non-discoverable*: any page with a redaction is rasterized
  (rendered to an image with the black boxes painted onto the pixels) and
  rebuilt as an image-only page, so the original text/vectors are gone — not
  hidden. They cannot be recovered by select-all-copy, text extraction, or
  deleting the box. Untouched pages keep their selectable text.
- **Merge** — append one or more other PDFs to the end of the current document.
- **Split** — extract a page range (e.g. `1-3, 5, 8-10`) into a new PDF; the
  current document stays open.
- **Reduce size** — *Lossless* (strip metadata and repack; text stays
  selectable) or *Strong* (rasterize every page to an image; big savings but no
  selectable text). The dialog reports the before → after size.

- `server.js` - Node static server plus login-gated `/api/signatures` and
  `/api/profile` APIs. The whole app works without an account; signing in
  (Google sign-in via xhost) just lets you store up to 50 named signatures and a
  reusable auto-fill profile (name, email, address, phone, initials, date
  preference) in Postgres. xhost provides login/identity only — not path
  protection — so the app enforces access itself: every data path requires a
  verified identity cookie and is scoped to the caller. Identity is read only
  from the RS256-verified `__Host-xhost_id` cookie, never from request headers.
- `public/index.html` - the whole app.
