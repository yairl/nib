# Inkwell

Fill and sign PDFs in the browser. Nothing is uploaded: the file is parsed with
pdf.js, annotations are placed on an overlay, and the final PDF is written with
pdf-lib entirely client-side.

The app also detects a PDF's native interactive form fields (AcroForm) and lets
you fill them inline — text, checkbox, radio, and dropdown/list fields aligned
to their real rects. On save, values are written by field name with pdf-lib,
appearances are regenerated, and the form is flattened so it renders in every
viewer.

- `server.js` - Node static server plus login-gated `/api/signatures` and
  `/api/profile` APIs. The whole app works without an account; signing in
  (Google sign-in via xhost) just lets you store up to 20 named signatures and a
  reusable auto-fill profile (name, email, address, phone, initials, date
  preference) in Postgres. xhost provides login/identity only — not path
  protection — so the app enforces access itself: every data path requires a
  verified identity cookie and is scoped to the caller. Identity is read only
  from the RS256-verified `__Host-xhost_id` cookie, never from request headers.
- `public/index.html` - the whole app.
