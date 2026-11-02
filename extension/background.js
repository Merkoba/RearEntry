/*
 * Rear Entry - background script
 * Copyright (C) 2026 Merkoba
 * Licensed under the GNU General Public License v3.0
 *
 * Handles everything that must survive the popup closing:
 * talking to rentry.co and mutating the stored history.
 */

"use strict"

const RENTRY = `https://rentry.co`
const MAX_ITEMS = 100000
const MAX_TEXT = 200000
const PREVIEW_LEN = 240
const EXT_BASE = browser.runtime.getURL(``)

// Token captured from the Set-Cookie header of our own GET request
let captured_csrf = null

// Token we want injected as a Cookie header in the next API request
let inject_csrf = null

function is_ours(details) {
  return details.tabId === -1 &&
    (!details.originUrl || details.originUrl.startsWith(EXT_BASE))
}

// Capture the csrftoken cookie that rentry hands out
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!is_ours(details)) {
      return
    }

    for (let h of details.responseHeaders || []) {
      if ((h.name.toLowerCase() === `set-cookie`) && h.value) {
        let m = h.value.match(/(?:^|[\s;,])csrftoken=([^;\s,]+)/)

        if (m) {
          captured_csrf = m[1]
        }
      }
    }
  },
  {urls: [`${RENTRY}/*`]},
  [`responseHeaders`],
)

// Rentry is a Django app: POSTs need a same-origin Referer/Origin and the CSRF cookie
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!is_ours(details)) {
      return {}
    }

    let drop = [`referer`, `origin`]

    if (inject_csrf) {
      drop.push(`cookie`)
    }

    let headers = details.requestHeaders.filter((h) => !drop.includes(h.name.toLowerCase()))
    headers.push({name: `Referer`, value: `${RENTRY}/`})
    headers.push({name: `Origin`, value: RENTRY})

    if (inject_csrf) {
      headers.push({name: `Cookie`, value: `csrftoken=${inject_csrf}`})
    }

    return {requestHeaders: headers}
  },
  {urls: [`${RENTRY}/api/*`]},
  [`blocking`, `requestHeaders`],
)

// ---------- Serialized storage access ----------

let chain = Promise.resolve()

function serial(fn) {
  let p = chain.then(fn, fn)
  chain = p.catch(() => {})
  return p
}

async function get_items() {
  let data = await browser.storage.local.get([`items`])
  return Array.isArray(data.items) ? data.items : []
}

async function save_items(items) {
  if (items.length > MAX_ITEMS) {
    items.length = MAX_ITEMS
  }

  await browser.storage.local.set({items})
}

async function next_seq() {
  let data = await browser.storage.local.get([`seq`])
  let seq = (parseInt(data.seq) || 0) + 1
  await browser.storage.local.set({seq})
  return seq
}

function make_id() {
  if (crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// ---------- Rentry ----------

async function get_csrf(mode) {
  captured_csrf = null

  if (mode === `omit`) {
    // Without credentials the server always issues a fresh cookie that we can capture
    // and then inject ourselves, independent of the browser cookie jar
    let res = await fetch(`${RENTRY}/`, {credentials: `omit`, cache: `no-store`})
    await res.text()

    if (captured_csrf) {
      return {token: captured_csrf, cookie: captured_csrf, mode}
    }

    return null
  }

  // Cookie jar mode: the browser keeps the cookie, we send the form token from the page
  let res = await fetch(`${RENTRY}/`, {credentials: `include`, cache: `no-store`})
  let html = await res.text()
  let m = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/) ||
    html.match(/value=["']([^"']+)["']\s+name=["']csrfmiddlewaretoken["']/)

  if (!m) {
    throw new Error(`Could not obtain a CSRF token from rentry.co`)
  }

  return {token: m[1], cookie: null, mode}
}

async function post_new(csrf, fields) {
  let body = new URLSearchParams()
  body.set(`csrfmiddlewaretoken`, csrf.token)

  for (let [k, v] of Object.entries(fields)) {
    if (v) {
      body.set(k, v)
    }
  }

  inject_csrf = csrf.cookie

  try {
    return await fetch(`${RENTRY}/api/new`, {
      method: `POST`,
      body,
      credentials: csrf.mode,
      cache: `no-store`,
      headers: {Accept: `application/json`},
    })
  }
  finally {
    inject_csrf = null
  }
}

function clean_url(s) {
  return String(s || ``).trim().replace(/^https?:\/\/(www\.)?rentry\.(co|org)\//i, ``).replace(/^\/+|\/+$/g, ``)
}

async function upload(args) {
  let text = String(args.text || ``)
  let title = String(args.title || ``).trim().slice(0, 300)
  let password = String(args.password || ``).trim()
  let custom_url = clean_url(args.custom_url)

  if (!text.trim()) {
    throw new Error(`There is no text to upload`)
  }

  if (text.length > MAX_TEXT) {
    throw new Error(`Text is too long (${text.length.toLocaleString()} / ${MAX_TEXT.toLocaleString()} characters)`)
  }

  if (custom_url && !/^[A-Za-z0-9_-]{2,100}$/.test(custom_url)) {
    throw new Error(`Custom URL must be 2-100 characters: letters, numbers, - and _`)
  }

  let fields = {text, edit_code: password, url: custom_url}
  let res = null
  let csrf = await get_csrf(`omit`)

  if (csrf) {
    res = await post_new(csrf, fields)
  }

  // CSRF rejected (or no cookie captured): retry using the browser cookie jar
  if (!res || (res.status === 403)) {
    csrf = await get_csrf(`include`)
    res = await post_new(csrf, fields)
  }

  let raw = await res.text()
  let data

  try {
    data = JSON.parse(raw)
  }
  catch (err) {
    throw new Error(`Unexpected response from rentry.co (HTTP ${res.status})`)
  }

  if ((String(data.status) !== `200`) || !data.url) {
    let msg = data.content || `Upload failed`

    if (data.errors) {
      msg += `: ${typeof data.errors === `string` ? data.errors : JSON.stringify(data.errors)}`
    }

    throw new Error(msg)
  }

  let item = {
    id: make_id(),
    seq: 0,
    title,
    url: data.url,
    password: data.edit_code || password,
    created: Date.now(),
    chars: text.length,
    lines: text.split(`\n`).length,
    words: (text.match(/\S+/g) || []).length,
    preview: text.slice(0, PREVIEW_LEN),
  }

  await serial(async () => {
    item.seq = await next_seq()
    let items = await get_items()
    items.unshift(item)
    await save_items(items)
  })

  return item
}

// ---------- History operations ----------

function update_title(id, title) {
  return serial(async () => {
    let items = await get_items()
    let it = items.find((x) => x.id === id)

    if (!it) {
      throw new Error(`Item not found`)
    }

    it.title = String(title || ``).trim().slice(0, 300)
    await save_items(items)
    return {item: it}
  })
}

function delete_item(id) {
  return serial(async () => {
    let items = await get_items()
    await save_items(items.filter((x) => x.id !== id))
  })
}

function clear_items() {
  return serial(async () => {
    await save_items([])
  })
}

function import_items(incoming) {
  return serial(async () => {
    if (!Array.isArray(incoming)) {
      throw new Error(`Invalid file: expected a list of items`)
    }

    let items = await get_items()
    let seen = new Set(items.map((x) => x.url))
    let data = await browser.storage.local.get([`seq`])
    let seq = parseInt(data.seq) || 0
    let added = 0

    for (let raw of incoming) {
      if (!raw || (typeof raw.url !== `string`) || !/^https?:\/\//.test(raw.url)) {
        continue
      }

      if (seen.has(raw.url)) {
        continue
      }

      seen.add(raw.url)
      seq += 1
      added += 1

      items.push({
        id: make_id(),
        seq,
        title: String(raw.title || ``).slice(0, 300),
        url: raw.url,
        password: String(raw.password || ``),
        created: Number(raw.created) || Date.now(),
        chars: Number(raw.chars) || 0,
        lines: Number(raw.lines) || 0,
        words: Number(raw.words) || 0,
        preview: String(raw.preview || ``).slice(0, PREVIEW_LEN),
      })
    }

    items.sort((a, b) => b.created - a.created)
    await browser.storage.local.set({seq})
    await save_items(items)
    return {added, total: Math.min(items.length, MAX_ITEMS)}
  })
}

async function export_items() {
  let items = await get_items()

  let payload = {
    app: `Rear Entry`,
    version: browser.runtime.getManifest().version,
    exported: new Date().toISOString(),
    items,
  }

  let blob = new Blob([JSON.stringify(payload, null, 2)], {type: `application/json`})
  let url = URL.createObjectURL(blob)
  let stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, `-`)

  try {
    await browser.downloads.download({url, filename: `rear-entry-${stamp}.json`, saveAs: true})
  }
  finally {
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000)
  }

  return {count: items.length}
}

// ---------- Messaging ----------

browser.runtime.onMessage.addListener((msg) => {
  let run = async () => {
    switch (msg && msg.type) {
      case `upload`: return {item: await upload(msg)}
      case `update_title`: return await update_title(msg.id, msg.title)
      case `delete`: await delete_item(msg.id); return {}
      case `clear`: await clear_items(); return {}
      case `import`: return await import_items(msg.items)
      case `export`: return await export_items()
      default: throw new Error(`Unknown message`)
    }
  }

  return run().then(
    (data) => ({ok: true, ...data}),
    (err) => ({ok: false, error: (err && err.message) || String(err)}),
  )
})
