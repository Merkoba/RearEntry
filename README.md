# Rear Entry

A Firefox extension that uploads your clipboard to [rentry.co](https://rentry.co)
and keeps a searchable history of every URL and edit code.

Made by **Merkoba** in 2026 · GPLv3 · https://github.com/Merkoba/RearEntry

## Features

- Big **Upload clipboard** button (or press `U`)
- Optional **title** (kept in your history), **edit code**, and **custom URL**
- 🎲 edit code generator
- History of up to 5,000 items, 100 per page
- Search by title, URL, edit code, date, number or text preview (`/` to focus)
- Date filters (today / 7 days / 30 days) and sorting
- Item details: copy URL, copy edit code, **Copy All** (`url - edit code`), open, edit page
- New uploads appear at the top and open automatically
- Light / dark theme, saved in `browser.storage.local`
- Export / import history as JSON

## Install (development)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Pick `extension/manifest.json` (or the built `rear-entry.xpi`)

## Build

```sh
cd extension && zip -r -FS ../rear-entry.xpi . -x '*.DS_Store' 'icons/icon-master.png'
```

## How the upload works

rentry.co is a Django app, so `POST /api/new` needs a CSRF token plus a same-origin
`Referer`/`Origin`. The background script fetches a fresh `csrftoken`, then uses
`webRequest` to set those headers on its own API requests only. If that gets rejected,
it retries using the browser's cookie jar.

## License

GNU General Public License v3.0, see [LICENSE](LICENSE).
