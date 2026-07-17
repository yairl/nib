# CLAUDE.md

## Cache-busting & the service worker

When bumping the `?v=N` query param on `app.css` / `app.js` in
`public/index.html`, you MUST also update `public/sw.js`:

- Bump `ASSET_VERSION` (renames the caches so old ones are dropped on activate).
- Update the matching `?v=N` entries in the `PRECACHE` list.

If these fall out of sync, installed PWA clients can serve stale assets from
the old precache. `index.html` itself is served `no-cache`, so navigations
always fetch fresh, but precached assets are keyed by the versioned URL.
