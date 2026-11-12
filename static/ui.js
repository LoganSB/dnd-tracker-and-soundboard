"use strict";
// ui.js - small helpers shared by the Home and Encounters pages (loaded before their own script).
//
//   h(tag, props, ...kids)     build a DOM element. Props such as textContent are plain text, never HTML, so a
//                              name coming from a user or a monster book can never inject markup.
//   api(url, method, body)     JSON request; resolves to the answer or throws Error(the server's message).
//   status()                   a small line of text that can show progress or an error (red when `bad`).
//   box(key, title, ...body)   a titled panel that can be collapsed; the choice is remembered per `key`.
//   dataTable(opts)            a table with a regex search box and a filter menu per filtered column.
//
// A filter or search never changes the data, it only hides rows. The search box takes a regular expression
// (ignoring upper/lower case); if what you typed is not a valid expression it is matched as plain text instead.

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

// matcher(text, input): a function (string) -> bool for the search box. Marks the box when the text is not a
// valid regular expression and falls back to a plain-text match.
function matcher(text, input) {
  if (!text) { input.classList.remove("badre"); return () => true; }
  try { const re = new RegExp(text, "i"); input.classList.remove("badre"); return s => re.test(s); }
  catch (_) { input.classList.add("badre"); const t = text.toLowerCase(); return s => s.toLowerCase().includes(t); }
}

// dataTable({ key, columns, rows, actions, empty }) -> element
//   columns  [{ label, text(row) -> string used for searching and filtering, show(row) -> node or text (optional;
//            defaults to the text), filter: true to give the column a menu of its distinct values }]
//   actions  (row) -> array of buttons for the last column (omit for none)
//   empty    text shown when there are no rows at all
// The search covers every column's text. The count under the box reads "3 of 10".
function dataTable({ key, columns, rows, actions, empty = "Nothing here yet." }) {
  const wrap = h("div", { className: "dtable" });
  if (!rows.length) { wrap.append(h("p", { className: "muted", textContent: empty })); return wrap; }
  const search = h("input", { type: "search", placeholder: "Search (regular expression)", className: "dsearch", title: "Regular expression, case does not matter" });
  search.value = stored(`q.${key}`, "");
  const filters = columns.map((c, i) => {
    if (!c.filter) return null;
    const sel = h("select", { title: "Filter by " + c.label }, h("option", { value: "", textContent: `${c.label}: all` }),
      [...new Set(rows.map(r => c.text(r)).filter(Boolean))].sort().map(v => h("option", { value: v, textContent: v })));
    sel.value = stored(`f.${key}.${i}`, "");
    if (sel.value !== stored(`f.${key}.${i}`, "")) sel.value = "";
    return sel;
  });
  const count = h("span", { className: "muted dcount" });
  const body = h("tbody");
  const draw = () => {
    const ok = matcher(search.value, search);
    store(`q.${key}`, search.value);
    let shown = 0;
    body.replaceChildren(...rows.filter(r => {
      if (filters.some((f, i) => f && f.value && columns[i].text(r) !== f.value)) return false;
      return ok(columns.map(c => c.text(r)).join("  "));
    }).map(r => {
      shown++;
      return h("tr", {}, columns.map(c => h("td", {}, c.show ? c.show(r) : c.text(r))),
        actions ? h("td", { className: "acts" }, actions(r)) : null);
    }));
    if (!shown) body.append(h("tr", {}, h("td", { colSpan: columns.length + 1, className: "muted", textContent: "No rows match." })));
    count.textContent = `${shown} of ${rows.length}`;
  };
  search.oninput = draw;
  filters.forEach((f, i) => f && (f.onchange = () => { store(`f.${key}.${i}`, f.value); draw(); }));
  draw();
  wrap.append(h("div", { className: "dbar" }, search, filters.filter(Boolean), count),
    h("table", { className: "loot" }, h("thead", {}, h("tr", {}, columns.map(c => h("th", { textContent: c.label })), actions ? h("th") : null)), body));
  return wrap;
}
