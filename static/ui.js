"use strict";
// ui.js - small helpers shared by the Home and Encounters pages (loaded before their own script).
//
// Everything is inside one object, UI, so pages that already have their own `api` or `h` (the campaign page) can load
// this file too. Pages that want the short names write:  const { h, api, status, stored, store, box, dataTable } = UI;
//
//   h(tag, props, ...kids)     build a DOM element. Props such as textContent are plain text, never HTML, so a
//                              name coming from a user or a monster book can never inject markup.
//   api(url, method, body)     JSON request; resolves to the answer or throws Error(the server's message).
//   status()                   a small line of text that can show progress or an error (red when `bad`).
//   box(key, title, ...body)   a titled panel that can be collapsed; the choice is remembered per `key`.
//   dataTable(opts)            a table with a search box and a filter menu per filtered column (needs finder.js). Rows can expand.
//   tabs(opts)                 a row of buttons that shows one panel at a time (the sub-menus on a character's page, the tracker's
//                              Party / Initiative switch); the chosen tab is remembered.
//
// A filter or search never changes the data, it only hides rows. Searching uses a regular expression plus finder.js (partial
// words, small typos); load that file before any page that builds a dataTable.

const UI = (() => {
function h(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}

async function api(url, method = "GET", body) {
  const r = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

function status() {
  const p = h("p", { className: "muted" });
  p.say = (t, bad) => { p.textContent = t; p.className = bad ? "bad" : "muted"; };
  return p;
}

// stored(key, fallback) / store(key, value): per-browser memory for small settings. Storage can be blocked
// (private windows), so every access is guarded and the page works without it.
const stored = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (_) { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ } };

// box(key, title, ...body): <section> with a clickable heading. `body` is hidden while collapsed.
function box(key, title, ...body) {
  const sec = h("section", { className: "homebox" });
  const inner = h("div", { className: "boxbody" }, ...body);
  const head = h("h2", { className: "boxhead", tabIndex: 0, role: "button" });
  const set = open => {
    inner.hidden = !open;
    head.textContent = (open ? "▾ " : "▸ ") + title;
    head.setAttribute("aria-expanded", open);
    store("box." + key, open);
  };
  head.onclick = () => set(inner.hidden);
  head.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); head.click(); } };
  sec.append(head, inner);
  set(stored("box." + key, true));
  return sec;
}

// dataTable({ key, columns, rows, actions, empty }) -> element   (lists 10 rows at a time; the buttons under it choose 10 / 20 / 50 / 100)
//   columns  [{ label, text(row) -> string used for searching and filtering, show(row) -> node or text (optional;
//            defaults to the text), filter: true to give the column a menu of its distinct values,
//            tags(row) -> array: with filter, a row belongs to every value in its list (a row in two campaigns shows up under both) }]
//   actions  (row) -> array of buttons for the last column (omit for none)
//   detail   (row) -> text or a node shown under the row when it is clicked (omit, or return nothing for a row, and that row does not
//            expand). This is the "drop-down" rows: an inventory item's description, a spell's text. Open rows stay open while you search.
//   rowClass (row) -> an extra CSS class for the row (for example "equipped")
//   empty    text shown when there are no rows at all
// The search takes the whole typed text as ONE regular expression over the row's text (as it always did; invalid ones are
// matched as plain text) and, after those rows, adds what Finder.find (finder.js, the matching the monster and item searches
// use) finds: every word somewhere in the row, partial words, single-letter typos. Rows keep their order when nothing is
// typed. The count under the box reads "3 of 10". A search or filter only hides rows; it never changes the data.
function dataTable({ key, columns, rows, actions, detail, rowClass, empty = "Nothing here yet." }) {
  const wrap = h("div", { className: "dtable" });
  if (!rows.length) { wrap.append(h("p", { className: "muted", textContent: empty })); return wrap; }
  const search = h("input", { type: "search", placeholder: "Search (typos and regular expressions are fine)", className: "dsearch", title: "Partial words, small typos and regular expressions all work" });
  search.value = stored(`q.${key}`, "");
  // Each row is prepared once for matching: its columns' text joined into one searchable name.
  const prepared = rows.map(r => Finder.prep({ name: columns.map(c => c.text(r)).join("  "), ref: r }));
  const filters = columns.map((c, i) => {
    if (!c.filter) return null;
    const sel = h("select", { title: "Filter by " + c.label }, h("option", { value: "", textContent: `${c.label}: all` }),
      [...new Set(c.tags ? rows.flatMap(c.tags) : rows.map(r => c.text(r)).filter(Boolean))].sort().map(v => h("option", { value: v, textContent: v })));
    sel.value = stored(`f.${key}.${i}`, "");
    if (sel.value !== stored(`f.${key}.${i}`, "")) sel.value = "";
    return sel;
  });
  const count = h("span", { className: "muted dcount" });
  const body = h("tbody");
  // How many rows to list at a time: the same 10 / 20 / 50 / 100 choice as the monster and item searches (Finder.pageSize). The
  // buttons at the bottom left only offer sizes smaller than the list; the chosen one is highlighted.
  let shown = Finder.pageSize.get();
  const opened = new Set();   // rows whose description is open
  const more = Finder.pageSize.buttons(n => { shown = n; draw(); });
  const draw = () => {
    store(`q.${key}`, search.value);
    search.classList.toggle("badre", Finder.isBadRegex(search.value));
    // Two kinds of match, regular-expression matches first. (1) The old behaviour: the WHOLE typed text as one regular
    // expression over the row's text (case does not matter), so patterns with spaces such as "^Aria  Fighter" work; an
    // invalid expression is matched as plain text. (2) Finder's generous matching (every word somewhere, typos allowed),
    // which adds the rows the first kind missed.
    const q = search.value;
    let re = null;
    if (q) { try { re = new RegExp(q, "i"); } catch (_) { /* matched as plain text below */ } }
    const exact = !q ? [] : prepared.filter(p => (re ? re.test(p.name) : p.lname.includes(q.toLowerCase())));
    const generous = Finder.find(prepared, { q }, { keepOrder: true });
    const list = (q ? [...new Set([...exact, ...generous])] : generous)
      .map(p => p.ref).filter(r => !filters.some((f, i) => f && f.value && !(columns[i].tags ? columns[i].tags(r).includes(f.value) : columns[i].text(r) === f.value)));
    const span = columns.length + (actions ? 1 : 0);
    body.replaceChildren(...list.slice(0, shown).flatMap(r => {
      const info = detail ? detail(r) : null;
      const tr = h("tr", { className: (rowClass?.(r) || "") + (info ? " expandable" + (opened.has(r) ? " open" : "") : "") }, columns.map(c => h("td", {}, c.show ? c.show(r) : c.text(r))),
        actions ? h("td", { className: "acts" }, actions(r)) : null);
      if (!info) return [tr];
      // The description sits in its own row right under this one; clicking anywhere on the row (except its buttons) opens or closes it.
      const drow = h("tr", { className: "drow", hidden: !opened.has(r) }, h("td", { colSpan: span, className: "dtext" }, info));
      tr.onclick = ev => {
        if (ev.target.closest("button, a, input, select")) return;
        const open = drow.hidden;
        drow.hidden = !open; tr.classList.toggle("open", open);
        if (open) opened.add(r); else opened.delete(r);
      };
      return [tr, drow];
    }));
    if (!list.length) body.append(h("tr", {}, h("td", { colSpan: columns.length + 1, className: "muted", textContent: "No rows match." })));
    count.textContent = `${list.length} of ${rows.length}`;
    more.sync(list.length, Math.min(shown, list.length));
  };
  search.oninput = () => { shown = Finder.pageSize.get(); draw(); };
  filters.forEach((f, i) => f && (f.onchange = () => { store(`f.${key}.${i}`, f.value); draw(); }));
  draw();
  wrap.append(h("div", { className: "dbar" }, search, filters.filter(Boolean), count),
    h("table", { className: "loot" }, h("thead", {}, h("tr", {}, columns.map(c => h("th", { textContent: c.label })), actions ? h("th") : null)), body), more.el);
  return wrap;
}

// tabs({ key, tabs, first }) -> { el, show(id), panel(id) }
//   tabs   [{ id, label, render, fresh }]  render() -> a node, built the first time the tab is shown and kept; with `fresh` it is built
//          again every time the tab is shown (for a panel whose data may have changed meanwhile). `label` may be a function (called on
//          each change, so a tab can carry a count).
//   key    the choice is remembered under it (per browser); first = the tab shown when nothing is remembered.
// One component for every row of sub-menu buttons: the buttons are class "subtabs", the chosen one has class "on", the panels sit under.
function tabs({ key, tabs: list, first }) {
  const bar = h("div", { className: "subtabs", role: "tablist" }), body = h("div", { className: "subpanels" });
  const panels = {}, buttons = {};
  const label = t => (typeof t.label === "function" ? t.label() : t.label);
  const show = id => {
    if (!list.some(t => t.id === id)) id = first || list[0].id;
    for (const t of list) {
      let p = panels[t.id];
      if (t.id === id && (!p || t.fresh)) { const node = t.render(); if (p) p.replaceChildren(node); else { p = panels[t.id] = h("div", { className: "subpanel" }, node); body.append(p); } }
      if (p) p.hidden = t.id !== id;
      buttons[t.id].classList.toggle("on", t.id === id);
      buttons[t.id].setAttribute("aria-selected", t.id === id);
      buttons[t.id].textContent = label(t);
    }
    store("tab." + key, id);
  };
  for (const t of list) bar.append(buttons[t.id] = h("button", { type: "button", role: "tab", textContent: label(t), onclick: () => show(t.id) }));
  show(stored("tab." + key, first || list[0].id));
  return { el: h("div", { className: "tabbed" }, bar, body), show, panel: id => panels[id] };
}

// Encounters and loot tables are shared by every page and every campaign. When one changes (created, edited, renamed, deleted, or put on
// or taken off a campaign tracker), the page that changed it calls libraryChanged(); every OTHER page that registered with
// onLibraryChanged(fn) hears it and refreshes (the Browse lists on Home, for example). A BroadcastChannel reaches all frames of the site.
let channel = null;
try { channel = new BroadcastChannel("dnd-library"); } catch (_) { /* very old browser: lists refresh when their tab is shown */ }
const libraryChanged = () => channel?.postMessage("changed");
const onLibraryChanged = fn => channel?.addEventListener("message", fn);
const offLibraryChanged = fn => channel?.removeEventListener("message", fn);

return { h, api, status, stored, store, box, dataTable, tabs, libraryChanged, onLibraryChanged, offLibraryChanged };
})();
