/*
 * Rear Entry - background script
 * Copyright (C) 2026 Merkoba
 * Licensed under the GNU General Public License v3.0
 *
 * Handles everything that must survive the popup closing:
 * talking to rentry.co and mutating the stored history.
 */

"use strict"

const RENTRY_CO = `https://rentry.co`
const RENTRY_ORG = `https://rentry.org`
const RENTRY_DOMAINS = [RENTRY_CO, RENTRY_ORG]
const MAX_ITEMS = 5000
const MAX_TEXT = 200000
const PREVIEW_LEN = 240
const EXT_BASE = browser.runtime.getURL(``)

// Tokens captured from the Set-Cookie headers of our GET requests, keyed by origin
const captured_csrf = new Map()

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

    try {
      let origin = new URL(details.url).origin
      for (let h of details.responseHeaders || []) {
        if ((h.name.toLowerCase() === `set-cookie`) && h.value) {
          let m = h.value.match(/(?:^|[\s;,])csrftoken=([^;\s,]+)/)

          if (m) {
            captured_csrf.set(origin, m[1])
          }
        }
      }
    }
    catch (err) {}
  },
  {urls: [`https://rentry.co/*`, `https://rentry.org/*`]},
  [`responseHeaders`],
)

// Rentry is a Django app: POSTs need a same-origin Referer/Origin and the CSRF cookie
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!is_ours(details)) {
      return {}
    }

    let origin = new URL(details.url).origin
    let headers = details.requestHeaders.filter(
      (h) => ![`referer`, `origin`].includes(h.name.toLowerCase())
    )
    headers.push({name: `Referer`, value: `${origin}/`})
    headers.push({name: `Origin`, value: origin})

    if (inject_csrf) {
      let cookieHeader = headers.find((h) => h.name.toLowerCase() === `cookie`)
      if (cookieHeader) {
        // Preserve other cookies (like cf_clearance, __cf_bm, etc.) so Cloudflare clearance isn't dropped
        let cookies = cookieHeader.value
          .split(`; `)
          .filter((c) => !c.trim().toLowerCase().startsWith(`csrftoken=`))
        cookies.push(`csrftoken=${inject_csrf}`)
        cookieHeader.value = cookies.join(`; `)
      }
      else {
        headers.push({name: `Cookie`, value: `csrftoken=${inject_csrf}`})
      }
    }

    return {requestHeaders: headers}
  },
  {urls: [`https://rentry.co/api/*`, `https://rentry.org/api/*`]},
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

function is_cloudflare_challenge(status, body) {
  let s = String(body || ``)
  if (status === 403 || status === 503) {
    if (
      s.includes(`cf-chl`) ||
      s.includes(`challenge-platform`) ||
      s.includes(`Just a moment...`) ||
      s.includes(`Cloudflare`) ||
      s.includes(`Attention Required! | Cloudflare`) ||
      s.includes(`Enable JavaScript and cookies to continue`) ||
      /<html[^>]*>[\s\S]*403 Forbidden/i.test(s)
    ) {
      return true
    }
  }
  return false
}

async function get_csrf(domain, mode) {
  let origin = new URL(domain).origin

  if (mode === `omit`) {
    captured_csrf.delete(origin)
    let res = await fetch(`${origin}/`, {credentials: `omit`, cache: `no-store`})
    let html = await res.text()

    if (is_cloudflare_challenge(res.status, html)) {
      let err = new Error(`Cloudflare verification required on ${new URL(origin).host} (HTTP ${res.status})`)
      err.is_cf = true
      err.domain = origin
      throw err
    }

    let token = captured_csrf.get(origin)
    if (token) {
      return {token, cookie: token, mode, domain: origin}
    }

    return null
  }

  // Cookie jar mode: include cookies so existing clearance / sessions are preserved
  let res = await fetch(`${origin}/`, {credentials: `include`, cache: `no-store`})
  let html = await res.text()

  if (is_cloudflare_challenge(res.status, html)) {
    let err = new Error(`Cloudflare verification required on ${new URL(origin).host} (HTTP ${res.status})`)
    err.is_cf = true
    err.domain = origin
    throw err
  }

  let m = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/) ||
    html.match(/value=["']([^"']+)["']\s+name=["']csrfmiddlewaretoken["']/)

  if (!m) {
    let cookieToken = captured_csrf.get(origin)
    if (cookieToken) {
      return {token: cookieToken, cookie: cookieToken, mode: `include`, domain: origin}
    }
    return null
  }

  return {token: m[1], cookie: null, mode: `include`, domain: origin}
}

async function post_new(domain, csrf, fields) {
  let body = new URLSearchParams()
  body.set(`csrfmiddlewaretoken`, csrf.token)

  for (let [k, v] of Object.entries(fields)) {
    if (v) {
      body.set(k, v)
    }
  }

  inject_csrf = csrf.cookie

  try {
    return await fetch(`${domain}/api/new`, {
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

function clean_error_text(s) {
  let str = String(s || ``).trim()
  if (!str) return ``

  let half = Math.floor(str.length / 2)
  for (let l = half; l >= 6; l--) {
    let a = str.slice(0, l).trim()
    let b = str.slice(l).trim()
    if (a && (a === b)) {
      str = a
      break
    }
  }

  return str
}

function parse_rentry_error(data) {
  let parts = []

  let add = (val) => {
    if (!val) return
    if (typeof val === `string`) {
      let cleaned = clean_error_text(val)
      if (cleaned && !parts.includes(cleaned)) {
        parts.push(cleaned)
      }
    }
    else if (Array.isArray(val)) {
      for (let item of val) {
        add(item)
      }
    }
    else if (typeof val === `object`) {
      for (let v of Object.values(val)) {
        add(v)
      }
    }
  }

  if (data.errors) {
    add(data.errors)
  }

  if (data.content && (data.content !== `Invalid data`) && (data.content !== `Upload failed`)) {
    add(data.content)
  }

  if (!parts.length && data.content) {
    add(data.content)
  }

  return parts.length ? parts.join(`. `) : `Upload failed`
}

async function upload_to_domain(domain, fields) {
  let origin = new URL(domain).origin
  let res = null
  let csrf = null

  // Try credentials: 'include' first so that any browser cookies / cf_clearance are sent
  try {
    csrf = await get_csrf(origin, `include`)
  }
  catch (err) {
    if (err.is_cf) throw err
  }

  if (csrf) {
    res = await post_new(origin, csrf, fields)
  }

  // If include failed or got rejected, try omit mode
  if (!res || (res.status === 403)) {
    if (res) {
      let preview = await res.clone().text().catch(() => ``)
      if (is_cloudflare_challenge(res.status, preview)) {
        let err = new Error(`Cloudflare verification required on ${new URL(origin).host} (HTTP ${res.status})`)
        err.is_cf = true
        err.domain = origin
        throw err
      }
    }

    try {
      let omit_csrf = await get_csrf(origin, `omit`)
      if (omit_csrf) {
        res = await post_new(origin, omit_csrf, fields)
      }
    }
    catch (err) {
      if (err.is_cf) throw err
    }
  }

  if (!res) {
    throw new Error(`Could not obtain a CSRF token from ${new URL(origin).host}`)
  }

  let raw = await res.text()

  if (is_cloudflare_challenge(res.status, raw)) {
    let err = new Error(`Cloudflare verification required on ${new URL(origin).host} (HTTP ${res.status})`)
    err.is_cf = true
    err.domain = origin
    throw err
  }

  let data
  try {
    data = JSON.parse(raw)
  }
  catch (err) {
    throw new Error(`Unexpected response from ${new URL(origin).host} (HTTP ${res.status})`)
  }

  if ((String(data.status) !== `200`) || !data.url) {
    let msg = parse_rentry_error(data)
    throw new Error(msg)
  }

  return {data, domain: origin}
}

async function upload(args) {
  let text = String(args.text || ``)
  let title = String(args.title || ``).trim().slice(0, 300)
  let edit_code = String(args.edit_code || ``).trim()
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

  let preferred_domain = RENTRY_ORG
  if (args.domain) {
    try {
      preferred_domain = new URL(args.domain).origin
    }
    catch (e) {}
  }

  let fallback_domain = (preferred_domain === RENTRY_ORG) ? RENTRY_CO : RENTRY_ORG
  let fields = {text, edit_code, url: custom_url}
  let outcome = null
  let primary_error = null
  let fallback_used = false

  try {
    outcome = await upload_to_domain(preferred_domain, fields)
  }
  catch (err) {
    primary_error = err

    // Only attempt fallback if primary failed with Cloudflare block or network failure
    let should_fallback = err.is_cf || (err.message && err.message.includes(`HTTP 403`))
    if (should_fallback) {
      try {
        outcome = await upload_to_domain(fallback_domain, fields)
        fallback_used = true
      }
      catch (fallback_err) {
        let errToThrow = primary_error.is_cf ? primary_error : fallback_err
        if (errToThrow.is_cf) {
          errToThrow.alt_domain = fallback_domain
        }
        throw errToThrow
      }
    }
    else {
      throw err
    }
  }

  let {data, domain: used_domain} = outcome
  let final_url = data.url
  if (final_url) {
    final_url = final_url.replace(/^https?:\/\/(www\.)?rentry\.(co|org)/i, used_domain)
  }

  let item = {
    id: make_id(),
    seq: 0,
    title,
    url: final_url,
    edit_code: data.edit_code || edit_code,
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

  return {item, fallback_used, used_domain, preferred_domain}
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
        edit_code: String(raw.edit_code || ``),
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
      case `upload`: return await upload(msg)
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
    (err) => ({
      ok: false,
      error: (err && err.message) || String(err),
      is_cf: !!(err && err.is_cf),
      domain: err && err.domain,
      alt_domain: err && err.alt_domain,
    }),
  )
})
