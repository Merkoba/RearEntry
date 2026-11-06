/*
 * Rear Entry - popup
 * Copyright (C) 2026 Merkoba
 * Licensed under the GNU General Public License v3.0
 */

"use strict"

const PAGE_SIZE = 100
const MAX_TEXT = 200000
const DAY = 24 * 60 * 60 * 1000
const params = new URLSearchParams(location.search)
const is_tab = params.has(`tab`)

const $ = (s, root = document) => root.querySelector(s)
const $$ = (s, root = document) => [...root.querySelectorAll(s)]

const state = {
  items: [],
  filtered: [],
  tokens: [],
  page: 0,
  query: ``,
  range: `all`,
  sort: `new`,
  theme: `light`,
  domain: `https://rentry.org`,
  current: null,
  modals: [],
  fresh_id: null,
}

const hay_cache = new WeakMap()

const SUCCESS = [
  `Uploaded successfully!`,
  `Delivered! URL and edit code saved to history.`,
  `Successfully uploaded to rentry!`,
]

const COPY_MSGS = {
  url: [`URL copied to clipboard`],
  code: [`Edit code copied to clipboard`],
  all: [`URL and edit code copied`],
}

const WORDS = [
  `amber`, `beacon`, `cedar`, `cobalt`, `coral`, `delta`, `ember`, `falcon`,
  `flint`, `glacier`, `harbor`, `haven`, `horizon`, `lunar`, `meadow`, `nebula`,
  `oasis`, `orbit`, `quartz`, `ridge`, `solar`, `timber`, `valiant`, `vortex`,
]

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---------- Utils ----------

function esc(s) {
  return String(s ?? ``).replace(/[&<>"']/g, (c) => ({"&": `&amp;`, "<": `&lt;`, ">": `&gt;`, "\"": `&quot;`, "'": `&#39;`})[c])
}

function hl(text) {
  text = String(text ?? ``)

  if (!state.tokens.length || !text) {
    return esc(text)
  }

  let low = text.toLowerCase()
  let ranges = []

  for (let t of state.tokens) {
    let i = 0

    while ((i = low.indexOf(t, i)) !== -1) {
      ranges.push([i, i + t.length])
      i += t.length
    }
  }

  if (!ranges.length) {
    return esc(text)
  }

  ranges.sort((a, b) => a[0] - b[0])
  let merged = [ranges[0]]

  for (let r of ranges.slice(1)) {
    let last = merged[merged.length - 1]

    if (r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1])
    }
    else {
      merged.push(r)
    }
  }

  let out = ``
  let pos = 0

  for (let [a, b] of merged) {
    out += esc(text.slice(pos, a)) + `<mark>${esc(text.slice(a, b))}</mark>`
    pos = b
  }

  return out + esc(text.slice(pos))
}

function pad(n, len = 2) {
  return String(n).padStart(len, `0`)
}

function fmt_date(ts) {
  let d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const rtf = new Intl.RelativeTimeFormat(undefined, {numeric: `auto`, style: `short`})

function ago(ts) {
  let s = Math.round((ts - Date.now()) / 1000)
  let abs = Math.abs(s)

  if (abs < 45) {
    return `just now`
  }

  let units = [[60, `second`], [60, `minute`], [24, `hour`], [7, `day`], [4.345, `week`], [12, `month`], [Infinity, `year`]]
  let v = s
  let unit = `second`

  for (let [div, name] of units) {
    if (Math.abs(v) < div) {
      unit = name
      break
    }

    v /= div
    unit = name
  }

  return rtf.format(Math.round(v), unit)
}

function num(n) {
  return (Number(n) || 0).toLocaleString()
}

function plural_word(count, singular, plural_form = `${singular}s`) {
  return (Number(count) === 1) ? singular : plural_form
}

function plural(count, singular, plural_form = `${singular}s`) {
  let n = Number(count) || 0
  return `${num(n)} ${plural_word(n, singular, plural_form)}`
}

function url_id(url) {
  let s = String(url || ``).trim()
  try {
    let u = new URL(s.startsWith(`http`) ? s : `https://${s}`)
    let p = u.pathname.replace(/^\/+|\/+$/g, ``)
    return p || u.host
  }
  catch (err) {
    return s.replace(/^https?:\/\/(www\.)?[^\/]+\/?/, ``) || s
  }
}

function hue(item) {
  let s = item.id || item.url || ``
  let h = 0

  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) % 360
  }

  return h
}

function hay(item) {
  let h = hay_cache.get(item)

  if (!h) {
    let d = new Date(item.created)

    h = [
      item.title,
      item.url,
      item.edit_code,
      item.preview,
      `no.${item.seq}`,
      `#${item.seq}`,
      fmt_date(item.created),
      d.toLocaleString(),
      plural(item.chars, `char`),
      plural(item.words, `word`),
      plural(item.lines, `line`),
    ].join(`  `).toLowerCase()

    hay_cache.set(item, h)
  }

  return h
}

function send(msg) {
  return browser.runtime.sendMessage(msg)
}

function open_url(url, close_window = false) {
  browser.tabs.create({url})
  if (close_window && !is_tab) {
    window.close()
  }
}

// ---------- Theme ----------

function apply_theme(theme, save = true) {
  state.theme = theme === `dark` ? `dark` : `light`
  document.documentElement.dataset.theme = state.theme

  try {
    localStorage.setItem(`re-theme`, state.theme)
  }
  catch (err) {
    // Not important
  }

  if (save) {
    browser.storage.local.set({theme: state.theme})
  }
}

function apply_domain(domain, save = true) {
  state.domain = (domain === `https://rentry.org`) ? `https://rentry.org` : `https://rentry.co`
  let host = new URL(state.domain).host

  let sel = $(`#up-domain`)
  if (sel && (sel.value !== state.domain)) {
    sel.value = state.domain
  }

  let prefix = $(`#up-prefix`)
  if (prefix) {
    prefix.textContent = `${host}/`
  }

  let sub = $(`#upload-sub`)
  if (sub) {
    sub.textContent = `Paste text and upload to ${host}`
  }

  let heading = $(`#up-heading`)
  if (heading) {
    heading.textContent = `Upload to ${host}`
  }

  if (save) {
    browser.storage.local.set({domain: state.domain})
  }
}

// Paint the cached theme immediately to avoid a flash
try {
  document.documentElement.dataset.theme = localStorage.getItem(`re-theme`) ||
    (matchMedia(`(prefers-color-scheme: dark)`).matches ? `dark` : `light`)
}
catch (err) {
  document.documentElement.dataset.theme = `light`
}

// ---------- Tooltip ----------

let tip_timer = null
let tip_target = null

function setup_tooltips() {
  let tip = $(`#tooltip`)

  document.addEventListener(`mouseover`, (e) => {
    let el = e.target.closest(`[data-tip]`)

    if (el === tip_target) {
      return
    }

    hide_tip()

    if (!el || !el.dataset.tip) {
      return
    }

    tip_target = el

    tip_timer = setTimeout(() => {
      tip.textContent = el.dataset.tip
      tip.classList.add(`show`)
      let r = el.getBoundingClientRect()
      let t = tip.getBoundingClientRect()
      let x = Math.min(Math.max(6, r.left + (r.width / 2) - (t.width / 2)), window.innerWidth - t.width - 6)
      let y = r.bottom + 6

      if ((y + t.height) > (window.innerHeight - 4)) {
        y = r.top - t.height - 6
      }

      tip.style.left = `${x}px`
      tip.style.top = `${Math.max(4, y)}px`
    }, 380)
  })

  document.addEventListener(`mousedown`, hide_tip)
  document.addEventListener(`scroll`, hide_tip, true)
}

function hide_tip() {
  clearTimeout(tip_timer)
  tip_target = null
  $(`#tooltip`).classList.remove(`show`)
}

// ---------- Toast ----------

let toast_timer = null

function toast(msg, bad = false) {
  let el = $(`#toast`)
  el.textContent = msg
  el.classList.toggle(`bad`, bad)
  el.classList.add(`show`)
  clearTimeout(toast_timer)
  toast_timer = setTimeout(() => el.classList.remove(`show`), bad ? 4000 : 1900)
}

// ---------- Clipboard ----------

async function copy(text, kind, btn) {
  let ok = true

  try {
    await navigator.clipboard.writeText(text)
  }
  catch (err) {
    let ta = document.createElement(`textarea`)
    ta.value = text
    document.body.append(ta)
    ta.select()
    ok = document.execCommand(`copy`)
    ta.remove()
  }

  if (!ok) {
    toast(`Failed to copy to clipboard`, true)
    return
  }

  toast(pick(COPY_MSGS[kind]))

  if (btn) {
    btn.classList.add(`ok`)
    setTimeout(() => {
      btn.classList.remove(`ok`)
    }, 600)
  }
}


// ---------- Modals ----------

function open_modal(id) {
  hide_tip()
  close_menu()
  state.modals = state.modals.filter((x) => x !== id)
  state.modals.push(id)
  sync_modals()
}

function close_modal(id) {
  id = id || state.modals[state.modals.length - 1]
  state.modals = state.modals.filter((x) => x !== id)

  if (id === `item-modal`) {
    state.current = null
    $(`#im-petals`).innerHTML = ``
  }

  if (id === `confirm-modal` && confirm_resolve) {
    confirm_resolve(false)
    confirm_resolve = null
  }

  sync_modals()
}

function sync_modals() {
  let top = state.modals[state.modals.length - 1]
  $(`#overlay`).hidden = !top

  for (let m of $$(`.modal`)) {
    m.hidden = m.id !== top
  }
}

let confirm_resolve = null

function confirm_dialog(title, text, ok_label = `Do it`) {
  $(`#cf-title`).textContent = title
  $(`#cf-text`).textContent = text
  $(`#cf-ok`).textContent = ok_label
  open_modal(`confirm-modal`)

  return new Promise((resolve) => {
    confirm_resolve = resolve
  })
}

// ---------- Filtering & rendering ----------

function page_count() {
  return Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE))
}

function refilter(reset_page = true) {
  let q = state.query.trim().toLowerCase()
  state.tokens = q ? q.split(/\s+/).filter(Boolean) : []
  let min = 0

  if (state.range === `today`) {
    let d = new Date()
    d.setHours(0, 0, 0, 0)
    min = d.getTime()
  }
  else if (state.range === `week`) {
    min = Date.now() - (7 * DAY)
  }
  else if (state.range === `month`) {
    min = Date.now() - (30 * DAY)
  }

  let out = state.items.filter((it) => {
    return ((it.created || 0) >= min) && state.tokens.every((t) => hay(it).includes(t))
  })

  if (state.sort === `old`) {
    out.reverse()
  }
  else if (state.sort === `title`) {
    out.sort((a, b) => (a.title || `\uffff`).localeCompare(b.title || `\uffff`))
  }
  else if (state.sort === `size`) {
    out.sort((a, b) => (b.chars || 0) - (a.chars || 0))
  }

  state.filtered = out

  if (reset_page) {
    state.page = 0
  }

  state.page = Math.min(state.page, page_count() - 1)
  render()
}

const ICON_COPY = `<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>`
const ICON_KEY = `<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 7.7-7.7a1.5 1.5 0 0 1 2.1 0l1.4 1.4a1.5 1.5 0 0 1 0 2.1l-1.5 1.5M16 9l2 2"/></svg>`
const ICON_OPEN = `<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>`

function item_html(it, i) {
  let title = it.title ? hl(it.title) : `Untitled upload`
  let id = url_id(it.url)
  let first_line = String(it.preview || ``).split(`\n`).find((l) => l.trim()) || ``
  let full = fmt_date(it.created)
  let code = it.edit_code || ``

  let tip_title = [
    it.title || `Untitled upload`,
    it.url,
    `Edit code: ${code || `—`}`,
    full,
  ].join(`\n`)

  return `
    <article class="item${it.id === state.fresh_id ? ` fresh` : ``}" data-id="${esc(it.id)}" style="--hue:${hue(it)};--i:${i}">
      <div class="item-no">No.<b>${pad(it.seq || 0, 4)}</b></div>
      <div class="item-main">
        <div class="item-row">
          <span class="item-title${it.title ? `` : ` untitled`}" data-tip="${esc(tip_title)}">${title}</span>
          <span class="item-time" data-tip="${esc(full)}">${esc(ago(it.created))}</span>
        </div>
        <div class="item-row">
          <span class="pill url" data-tip="${esc(it.url)}">${hl(id)}</span>
          <span class="pill code" data-tip="${esc(`Edit code: ${code || `—`}`)}">${code ? hl(code) : `—`}</span>
        </div>
        ${first_line ? `<div class="item-preview" data-tip="${esc(it.preview)}">${hl(first_line)}</div>` : ``}
        <div class="item-meta">
          <span>📅 ${hl(full)}</span>
          <span>✎ ${plural(it.chars, `char`)}</span>
          <span>☰ ${plural(it.lines, `line`)}</span>
          <span>❝ ${plural(it.words, `word`)}</span>
        </div>
      </div>
      <div class="item-actions">
        <button class="mini" data-act="copy-url" data-tip="Copy URL">${ICON_COPY}</button>
        <button class="mini" data-act="copy-code" data-tip="Copy edit code">${ICON_KEY}</button>
        <button class="mini" data-act="open" data-tip="Open in new tab">${ICON_OPEN}</button>
      </div>
    </article>`
}

function empty_html() {
  if (state.items.length) {
    return `
      <div class="empty">
        <span class="empty-face">🔍</span>
        <b>No matching uploads.</b>
        Try searching for another keyword or clearing filters.
      </div>`
  }

  return `
    <div class="empty">
      <span class="empty-face">📋</span>
      <b>No history yet.</b>
      Click New Upload above and paste your markdown or text.
    </div>`
}

function render() {
  let list = $(`#list`)
  let total = state.filtered.length
  let start = state.page * PAGE_SIZE
  let slice = state.filtered.slice(start, start + PAGE_SIZE)

  list.innerHTML = slice.length ? slice.map(item_html).join(``) : empty_html()
  list.scrollTop = 0

  let all = state.items.length
  let noun = plural_word(all, `upload`)
  $(`#count`).textContent = total === all ? `${num(all)} ${noun}` : `${num(total)} of ${num(all)} ${noun}`

  let pages = page_count()
  $(`#pager`).hidden = pages <= 1
  $(`#pg-label`).textContent = `Page ${num(state.page + 1)} / ${num(pages)} · ${num(start + 1)}–${num(start + slice.length)}`
  $(`#pg-first`).disabled = $(`#pg-prev`).disabled = state.page === 0
  $(`#pg-last`).disabled = $(`#pg-next`).disabled = state.page >= (pages - 1)

  state.fresh_id = null
}

function go_page(p) {
  state.page = Math.max(0, Math.min(page_count() - 1, p))
  render()
}

function find_item(id) {
  return state.items.find((x) => x.id === id)
}

// ---------- Item modal ----------

function copy_all_text(it) {
  return `${it.url} - ${it.edit_code || ``}`.trim()
}

function show_item(it, celebrate = false) {
  state.current = it
  let modal = $(`#item-modal`)
  modal.style.setProperty(`--hue`, hue(it))

  $(`#im-no`).textContent = `No. ${pad(it.seq || 0, 4)}`
  $(`#im-title`).textContent = it.title || `Untitled upload`
  $(`#im-title`).classList.toggle(`untitled`, !it.title)
  $(`#im-sub`).textContent = `${fmt_date(it.created)} · ${ago(it.created)}`
  $(`#im-url`).textContent = it.url

  let code_el = $(`#im-code`)
  code_el.textContent = it.edit_code || `none saved`
  code_el.classList.toggle(`empty-val`, !it.edit_code)
  $(`#im-copy-code`).disabled = !it.edit_code

  $(`#im-stats`).innerHTML = [
    [num(it.chars), plural_word(it.chars, `char`)],
    [num(it.lines), plural_word(it.lines, `line`)],
    [num(it.words), plural_word(it.words, `word`)],
    [`#${it.seq || 0}`, `upload`],
  ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join(``)

  let prev = String(it.preview || ``)
  $(`#im-preview`).textContent = prev ? (prev + ((it.chars > prev.length) ? `…` : ``)) : `(no preview)`

  $(`#im-stamp`).hidden = !celebrate
  let cel = $(`#im-celebrate`)
  cel.hidden = !celebrate
  cel.textContent = celebrate ? pick(SUCCESS) : ``
  $(`#im-petals`).innerHTML = ``

  open_modal(`item-modal`)
  modal.scrollTop = 0

  if (celebrate) {
    petals()
  }
}

function petals() {
  let box = $(`#im-petals`)
  let colors = [`#ffb7c5`, `#ffc9d4`, `#ff9fb2`, `#ffe0e6`, `#ffd27a`]

  for (let i = 0; i < 26; i++) {
    let p = document.createElement(`span`)
    p.className = `petal`
    p.style.left = `${Math.random() * 100}%`
    p.style.background = pick(colors)
    p.style.animationDuration = `${2.4 + (Math.random() * 2.2)}s`
    p.style.animationDelay = `${Math.random() * 1.2}s`
    p.style.setProperty(`--drift`, `${(Math.random() * 120) - 60}px`)
    p.style.setProperty(`--spin`, `${(Math.random() * 720) - 360}deg`)
    let s = 0.7 + (Math.random() * 0.8)
    p.style.width = `${11 * s}px`
    p.style.height = `${9 * s}px`
    box.append(p)
  }

  setTimeout(() => {
    box.innerHTML = ``
  }, 5200)
}

async function delete_current() {
  let it = state.current

  if (!it) {
    return
  }

  let ok = await confirm_dialog(
    `Delete this item?`,
    `"${it.title || it.url}" will be removed from your history. The page will remain on rentry.co.`,
    `Delete`,
  )

  if (!ok) {
    return
  }

  let res = await send({type: `delete`, id: it.id})

  if (res && res.ok) {
    close_modal(`item-modal`)
    toast(`Item removed from history`)
  }
  else {
    toast(res ? res.error : `Delete failed`, true)
  }
}

function open_edit_title() {
  if (!state.current) {
    return
  }

  $(`#et-input`).value = state.current.title || ``
  open_modal(`edit-title-modal`)

  setTimeout(() => {
    let inp = $(`#et-input`)
    inp.focus()
    inp.select()
  }, 40)
}

async function save_title() {
  let it = state.current

  if (!it) {
    return
  }

  let input = $(`#et-input`)
  let new_title = input.value.trim().slice(0, 300)
  let save_btn = $(`#et-save`)

  save_btn.classList.add(`loading`)

  try {
    let res = await send({type: `update_title`, id: it.id, title: new_title})

    if (res && res.ok) {
      it.title = new_title
      hay_cache.delete(it)

      $(`#im-title`).textContent = it.title || `Untitled upload`
      $(`#im-title`).classList.toggle(`untitled`, !it.title)

      close_modal(`edit-title-modal`)
      refilter(false)
      toast(`Title updated ✓`)
    }
    else {
      toast((res && res.error) || `Failed to update title`, true)
    }
  }
  catch (err) {
    toast((err && err.message) || `Failed to update title`, true)
  }
  finally {
    save_btn.classList.remove(`loading`)
  }
}

// ---------- Upload modal ----------

function update_upload_meta() {
  let v = $(`#up-text`).value
  let meta = $(`#up-meta`)
  let lines = v ? v.split(`\n`).length : 0
  meta.textContent = `${num(v.length)} / ${num(MAX_TEXT)} ${plural_word(v.length, `char`)} · ${plural(lines, `line`)}`
  meta.classList.toggle(`bad`, v.length > MAX_TEXT)
}

function start_upload() {
  $(`#up-error`).hidden = true
  $(`#up-text`).value = ``
  $(`#up-title`).value = ``
  $(`#up-code`).value = ``
  $(`#up-url`).value = ``
  $(`#up-more`).open = false
  update_upload_meta()
  set_loading(false)
  open_modal(`upload-modal`)
  $(`#up-text`).focus()
}

function set_loading(on) {
  let btn = $(`#up-submit`)
  btn.classList.toggle(`loading`, on)
  $(`.btn-label`, btn).textContent = on ? `Opening the back door…` : `Submit`

  for (let el of $$(`#upload-modal input, #upload-modal textarea`)) {
    el.disabled = on
  }
}

function show_upload_error(err) {
  let box = $(`#up-error`)
  let msgEl = $(`#up-error-msg`) || box
  let actionsEl = $(`#up-error-actions`)

  box.hidden = false
  if (actionsEl) {
    actionsEl.innerHTML = ``
    actionsEl.hidden = true
  }

  let msg = typeof err === `string` ? err : (err && err.error) || `unknown error`
  msg = String(msg || `unknown error`).trim()
  if (/^upload failed[:\s]*/i.test(msg)) {
    msg = msg.replace(/^upload failed[:\s]*/i, ``)
  }
  msgEl.textContent = msg ? `Upload failed: ${msg}` : `Upload failed`

  if (err && (err.is_cf || /cloudflare/i.test(msg) || /403/i.test(msg))) {
    if (actionsEl) {
      actionsEl.hidden = false
      let targetDomain = err.domain || state.domain || `https://rentry.org`
      let host = new URL(targetDomain).host

      let btnVerify = document.createElement(`button`)
      btnVerify.type = `button`
      btnVerify.textContent = `Open ${host} in tab to verify`
      btnVerify.addEventListener(`click`, () => {
        open_url(targetDomain)
      })
      actionsEl.appendChild(btnVerify)

      if (targetDomain.includes(`rentry.co`)) {
        let btnSwitch = document.createElement(`button`)
        btnSwitch.type = `button`
        btnSwitch.textContent = `Switch to rentry.org & retry`
        btnSwitch.addEventListener(`click`, async () => {
          apply_domain(`https://rentry.org`)
          await submit_upload()
        })
        actionsEl.appendChild(btnSwitch)
      }
    }
  }

  box.style.animation = `none`
  void box.offsetWidth
  box.style.animation = ``
}

async function submit_upload() {
  let btn = $(`#up-submit`)

  if (btn.classList.contains(`loading`)) {
    return
  }

  let text = $(`#up-text`).value
  let custom_url = $(`#up-url`).value.trim()

  if (!text.trim()) {
    show_upload_error(`there is nothing to upload. Copy some text first.`)
    return
  }

  if (text.length > MAX_TEXT) {
    show_upload_error(`text is too long (max ${num(MAX_TEXT)} chars).`)
    return
  }

  if (custom_url && !/^[A-Za-z0-9_-]{2,100}$/.test(custom_url)) {
    show_upload_error(`custom URL must be 2-100 letters, numbers, - or _.`)
    return
  }

  $(`#up-error`).hidden = true
  set_loading(true)

  let res

  try {
    res = await send({
      type: `upload`,
      text,
      title: $(`#up-title`).value,
      edit_code: $(`#up-code`).value.trim(),
      custom_url,
      domain: state.domain,
    })
  }
  catch (err) {
    res = {ok: false, error: err.message || String(err)}
  }

  set_loading(false)

  if (!res || !res.ok) {
    show_upload_error(res || `unknown error`)
    return
  }

  if (res.fallback_used && res.used_domain) {
    let usedHost = new URL(res.used_domain).host
    let prefHost = new URL(res.preferred_domain).host
    toast(`Uploaded to ${usedHost} (${prefHost} was blocked)`)
  }

  // Make sure the new item is visible at the top
  state.query = ``
  $(`#search`).value = ``
  state.range = `all`
  state.sort = `new`
  $(`#sort`).value = `new`
  sync_chips()
  state.fresh_id = res.item.id

  if (!find_item(res.item.id)) {
    state.items = [res.item, ...state.items]
  }

  refilter()
  close_modal(`upload-modal`)
  show_item(find_item(res.item.id) || res.item, true)
}

function dice_edit_code() {
  let a = pick(WORDS)
  let b = pick(WORDS.filter((w) => w !== a))
  let n = Math.floor(1000 + (Math.random() * 9000))
  $(`#up-code`).value = `${a}-${b}-${n}`
}

// ---------- Menu actions ----------

function close_menu() {
  $(`#menu`).hidden = true
}

function sync_chips() {
  for (let c of $$(`#chips .chip`)) {
    c.classList.toggle(`active`, c.dataset.range === state.range)
  }
}

async function menu_action(action) {
  close_menu()

  if (action === `tab`) {
    open_url(browser.runtime.getURL(`popup/popup.html?tab=1`))
    window.close()
  }
  else if (action === `about`) {
    open_modal(`about-modal`)
  }
  else if (action === `clear`) {
    if (!state.items.length) {
      toast(`Already squeaky clean ✨`)
      return
    }

    let ok = await confirm_dialog(
      `Clear all history?`,
      `All ${plural(state.items.length, `item`)} (URLs and edit codes) will be forgotten forever. Pages stay on rentry.co.`,
      `Clear everything`,
    )

    if (ok) {
      let res = await send({type: `clear`})
      toast(res && res.ok ? `All history cleared` : `Clear failed`, !(res && res.ok))
    }
  }
}

// ---------- Events ----------

function bind() {
  $(`#upload-btn`).addEventListener(`click`, start_upload)
  $(`#theme-btn`).addEventListener(`click`, () => apply_theme(state.theme === `dark` ? `light` : `dark`))

  $(`#menu-btn`).addEventListener(`click`, (e) => {
    e.stopPropagation()
    $(`#menu`).hidden = !$(`#menu`).hidden
    hide_tip()
  })

  $(`#menu`).addEventListener(`click`, (e) => {
    let b = e.target.closest(`[data-action]`)

    if (b) {
      menu_action(b.dataset.action)
    }
  })

  document.addEventListener(`click`, (e) => {
    if (!e.target.closest(`.menu-wrap`)) {
      close_menu()
    }

    let link = e.target.closest(`a.ext-link`)

    if (link) {
      e.preventDefault()
      open_url(link.href)
    }
  })

  // Search
  let search_timer = null

  $(`#search`).addEventListener(`input`, (e) => {
    clearTimeout(search_timer)

    search_timer = setTimeout(() => {
      state.query = e.target.value
      refilter()
    }, state.items.length > 5000 ? 200 : 90)
  })

  $(`#sort`).addEventListener(`change`, (e) => {
    state.sort = e.target.value
    refilter()
  })

  $(`#chips`).addEventListener(`click`, (e) => {
    let c = e.target.closest(`.chip`)

    if (!c) {
      return
    }

    state.range = c.dataset.range
    sync_chips()
    refilter()
  })

  // List
  $(`#list`).addEventListener(`click`, (e) => {
    let card = e.target.closest(`.item`)

    if (!card) {
      return
    }

    let it = find_item(card.dataset.id)

    if (!it) {
      return
    }

    let act = e.target.closest(`[data-act]`)

    if (!act) {
      show_item(it)
      return
    }

    let a = act.dataset.act

    if (a === `copy-url`) {
      copy(it.url, `url`, act)
    }
    else if (a === `copy-code`) {
      if (!it.edit_code) {
        toast(`No edit code saved for this item`)
      }
      else {
        copy(it.edit_code, `code`, act)
      }
    }
    else if (a === `open`) {
      open_url(it.url, true)
    }
  })

  // Pager
  $(`#pg-first`).addEventListener(`click`, () => go_page(0))
  $(`#pg-prev`).addEventListener(`click`, () => go_page(state.page - 1))
  $(`#pg-next`).addEventListener(`click`, () => go_page(state.page + 1))
  $(`#pg-last`).addEventListener(`click`, () => go_page(page_count() - 1))

  // Modals
  $(`#overlay`).addEventListener(`mousedown`, (e) => {
    if (e.target.id === `overlay`) {
      let top = state.modals[state.modals.length - 1]

      // Don't lose a half-written upload by misclicking
      if (top !== `upload-modal`) {
        close_modal()
      }
    }
  })

  for (let b of $$(`[data-close]`)) {
    b.addEventListener(`click`, () => close_modal(b.closest(`.modal`).id))
  }

  // Upload modal
  $(`#up-text`).addEventListener(`input`, update_upload_meta)
  $(`#up-dice`).addEventListener(`click`, dice_edit_code)
  $(`#up-submit`).addEventListener(`click`, submit_upload)
  $(`#up-domain`).addEventListener(`change`, (e) => apply_domain(e.target.value))

  for (let el of $$(`#up-title, #up-code, #up-url`)) {
    el.addEventListener(`keydown`, (e) => {
      if (e.key === `Enter`) {
        e.preventDefault()
        submit_upload()
      }
    })
  }

  // Item modal
  $(`#im-edit-title`).addEventListener(`click`, open_edit_title)
  $(`#im-copy-url`).addEventListener(`click`, (e) => state.current && copy(state.current.url, `url`, e.currentTarget))
  $(`#im-copy-code`).addEventListener(`click`, (e) => state.current && copy(state.current.edit_code, `code`, e.currentTarget))
  $(`#im-copy-all`).addEventListener(`click`, (e) => state.current && copy(copy_all_text(state.current), `all`, e.currentTarget))
  $(`#im-open`).addEventListener(`click`, () => state.current && open_url(state.current.url, true))
  $(`#im-edit`).addEventListener(`click`, () => state.current && open_url(`${state.current.url.replace(/\/+$/, ``)}/edit`, true))
  $(`#im-delete`).addEventListener(`click`, delete_current)

  // Edit title modal
  $(`#et-save`).addEventListener(`click`, save_title)
  $(`#et-input`).addEventListener(`keydown`, (e) => {
    if (e.key === `Enter`) {
      e.preventDefault()
      save_title()
    }
  })

  // Confirm
  $(`#cf-ok`).addEventListener(`click`, () => {
    let r = confirm_resolve
    confirm_resolve = null
    close_modal(`confirm-modal`)

    if (r) {
      r(true)
    }
  })

  $(`#cf-cancel`).addEventListener(`click`, () => close_modal(`confirm-modal`))


  // Keyboard
  document.addEventListener(`keydown`, (e) => {
    let typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)

    if (e.key === `Escape`) {
      if (!$(`#menu`).hidden) {
        close_menu()
        e.preventDefault()
        return
      }

      if (state.modals.length) {
        close_modal()
        e.preventDefault()
        return
      }
    }

    if ((e.key === `Enter`) && (e.ctrlKey || e.metaKey) && (state.modals.at(-1) === `upload-modal`)) {
      e.preventDefault()
      submit_upload()
      return
    }

    if (typing || state.modals.length || e.ctrlKey || e.metaKey || e.altKey) {
      return
    }

    if (e.key === `/`) {
      e.preventDefault()
      $(`#search`).focus()
    }
    else if (e.key.toLowerCase() === `u`) {
      e.preventDefault()
      start_upload()
    }
    else if (e.key === `ArrowRight`) {
      go_page(state.page + 1)
    }
    else if (e.key === `ArrowLeft`) {
      go_page(state.page - 1)
    }
  })

  // Keep in sync with background changes
  browser.storage.onChanged.addListener((changes, area) => {
    if ((area !== `local`) || !changes.items) {
      return
    }

    state.items = changes.items.newValue || []

    if (state.current) {
      let updated = find_item(state.current.id)

      if (updated) {
        state.current = updated
        hay_cache.delete(updated)
        $(`#im-title`).textContent = updated.title || `Untitled upload`
        $(`#im-title`).classList.toggle(`untitled`, !updated.title)
      }
      else if (state.modals.includes(`item-modal`)) {
        close_modal(`item-modal`)
      }
    }

    refilter(false)
  })
}

// ---------- Init ----------

async function init() {
  if (is_tab) {
    document.documentElement.classList.add(`tab-mode`)
    $(`#menu-tab`).hidden = true
  }

  let data = await browser.storage.local.get([`items`, `theme`, `domain`])
  let theme = data.theme || document.documentElement.dataset.theme || `light`
  apply_theme(theme, false)
  apply_domain(data.domain || `https://rentry.org`, false)
  state.items = Array.isArray(data.items) ? data.items : []

  $(`#ab-ver`).textContent = `v${browser.runtime.getManifest().version}`

  setup_tooltips()
  bind()
  refilter()

}

init()
