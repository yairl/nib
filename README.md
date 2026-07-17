# Nib

Fill and sign PDFs in the browser. Nothing is uploaded: the file is parsed with
pdf.js, annotations are placed on an overlay, and the final PDF is written with
pdf-lib entirely client-side.

## Opening files

Open a file with the toolbar button, by dropping it anywhere on the window, or
(when installed) by opening it from your operating system.

- **PDFs** are parsed and rendered directly.
- **Images** (PNG, JPEG, WebP, GIF, BMP) are wrapped into a single-page PDF
  sized to the image and then handled like any other document, so you can fill,
  sign, annotate, print, and save them. PNG/JPEG are embedded directly; other
  formats are rasterized to PNG through a canvas first. All of this happens in
  the browser — nothing is uploaded.

The app also detects a PDF's native interactive form fields (AcroForm) and lets
you fill them inline — text, checkbox, radio, and dropdown/list fields aligned
to their real rects. On save, values are written by field name with pdf-lib,
appearances are regenerated, and the form is flattened so it renders in every
viewer.

## Document tools

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

## Install & offline (PWA)

Nib is a Progressive Web App and can be installed as a standalone app on
desktop and mobile.

- **Install** — an "Install app" action (in the gear menu and on the landing
  screen) triggers the browser's native install prompt on Chromium; on iOS it
  shows the Add-to-Home-Screen steps. Once installed it launches in its own
  window.
- **Offline** — a service worker (`public/sw.js`) precaches the app shell and
  the pdf.js / pdf-lib vendor scripts, so the app keeps working with no network.
  Navigations are network-first (deploys show up immediately) and the manifest
  is fetched network-first so install/registration is never stale. API and auth
  routes are never cached.
- **Open PDFs with Nib** — the manifest registers Nib as an OS file handler for
  `application/pdf`, so on a supporting platform (Chromium desktop) you can open
  a `.pdf` straight into the installed app. A "Set as default PDF app" helper
  shows the OS-specific steps to make Nib the default, since the operating
  system — not the web app — controls the default handler.

Bump `ASSET_VERSION` in `public/sw.js` and the matching `?v=N` query params in
`public/index.html` together whenever the precached shell changes, or installed
clients can serve stale assets. See `CLAUDE.md`.

## Layout

- `server.js` - Node static server plus login-gated `/api/signatures` and
  `/api/profile` APIs, and anonymous usage counters behind `/api/hit`,
  `/api/event`, and `/api/stats` (surfaced in-app as "Stats for nerds"). The
  whole app works without an account; signing in (Google sign-in via xhost)
  just lets you store up to 50 named signatures and a reusable auto-fill profile
  (name, email, address, phone, initials, date preference) in Postgres. xhost
  provides login/identity only — not path protection — so the app enforces
  access itself: every data path requires a verified identity cookie and is
  scoped to the caller. Identity is read only from the RS256-verified
  `__Host-xhost_id` cookie, never from request headers.
- `public/index.html`, `public/app.js`, `public/app.css` - the client app.
- `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` - PWA service
  worker, manifest, and app icons.

## License & open source

Nib is open source under the [MIT License](LICENSE) and the source lives at
<https://github.com/yairl/nib>.

It relies on a few permissive, MIT-compatible libraries: **pdf.js** (Apache-2.0,
Mozilla) and **pdf-lib** (MIT) on the client, and **pg**, **jsonwebtoken**, and
**jwks-rsa** (all MIT) on the server. The signature fonts are under the SIL Open
Font License 1.1. Full attributions are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
