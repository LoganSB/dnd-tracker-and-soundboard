"use strict";
// finder.js - the search used by the Encounters tab (monsters) and the Loot tab (magic items), including the small
// version of it inside the campaign tracker's loot pop-up. One implementation, two lists.
//
// WHAT IT DOES
//   * loadIndex(url, map): downloads a catalogue list once (the server keeps it on disk and rebuilds it from Open5e at most
//     monthly) and prepares each row for matching. While the server is making its very first copy it answers 202 and this
//     asks again every few seconds.
//   * find(rows, filters, cfg): matching that is generous on purpose. Typing narrows the list live: partial words, single-
//     letter typos (a swap of two letters counts as one), regular expressions, the book/type, and a number (the CR of
//     a monster: "cr 5", "cr 1/2", "3-5", "5+") all work. Best matches first, then shorter names, then A to Z.
//   * the same matching also drives every searchable TABLE in the app (UI.dataTable in ui.js uses find with keepOrder).
//   * panel(cfg): the search box with live suggestions (each shows its CR or rarity), filter menus, and the result
//     table with a "+" button per row. With nothing typed it lists everything A to Z, 20 rows at a time; the buttons and page arrows under the list (see pageSize.pager) change that and remember your choice.
// Nothing here calls Open5e: all searching happens in the browser on the downloaded list.
const Finder = (() => {
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  };

  // pageSize: how many rows a list shows at a time, and the PAGES of every list. One of 10, 20, 50 or 100 (default 20), remembered in this
  // browser and shared by every searchable list in the app: the monster, item and spell searches (panel below) and every UI.dataTable.
  //
  // pager(onChange) -> { el, text, show(list, all), reset() } is the control under a list. One component, so no list does paging itself:
  //   show(list, all)  give it the whole (filtered) list and the size of the unfiltered list; it returns the rows of the CURRENT page and
  //                    updates its buttons. `text` is then the counter, such as "21-28 of 28" ("1-20 of 28 (filtered from 90)" when a
  //                    search or filter hides rows), for the page to show wherever it likes (el shows it between the page arrows too).
  //   reset()          back to the first page: call it when the search or a filter changes.
  //   el               up to four size buttons (10 / 20 / 50 / 100) at the bottom left, the current one highlighted, and the page arrows
  //                    « ‹ › » at the right. A size button only exists when the list is longer than the size before it (10 rows show none,
  //                    11 rows show 10 and 20, 30 rows show 10, 20 and 50, 51 or more show all four); clicking the highlighted one does
  //                    nothing. The arrows only exist when there is more than one page. onChange() is called after any click.
  //
  // showMore(onChange, step) -> { el, sync(total, shown) }: the plain "Show more (N left)" button the small pop-up lists use (they add `step` rows).
  const pageSize = {
    options: [10, 20, 50, 100],
    get() { try { const n = +localStorage.getItem("finder.pageSize"); return this.options.includes(n) ? n : 20; } catch (_) { return 20; } },
    set(n) { try { localStorage.setItem("finder.pageSize", n); } catch (_) { /* storage blocked */ } },
    // Which buttons a list of `total` rows gets: an option appears when total is more than the option before it (10 needs more than 10).
    visible(total) { return this.options.filter((n, i) => total > (i ? this.options[i - 1] : n)); },
    // The highlighted size: the saved choice, or the biggest button shown when the saved one is not offered for a short list
    // (everything already fits, so the biggest button is the true state).
    current(total) { const v = this.visible(total), n = this.get(); return v.includes(n) ? n : v[v.length - 1]; },
    // The size actually used to cut pages: the highlighted button's, or the saved size when a short list shows no buttons.
    effective(total) { return this.current(total) || this.get(); },
    pager(onChange) {
      const el0 = el("div", { className: "pagerbar" });
      let page = 0, total = 0;
      const api = { el: el0, text: "", reset() { page = 0; },
        show(list, all = list.length) {
          total = list.length;
          const size = pageSize.effective(total), pages = Math.max(1, Math.ceil(total / size));
          page = Math.min(page, pages - 1);
          const start = page * size, rows = list.slice(start, start + size), vis = pageSize.visible(total), on = pageSize.current(total);
          api.text = total ? `${start + 1}-${start + rows.length} of ${total}` : `0 of ${all}`;
          if (total && all > total) api.text += ` (filtered from ${all})`;
          const go = n => () => { page = Math.max(0, Math.min(pages - 1, n)); onChange(); };
          const arrow = (label, title, n, off) => el("button", { type: "button", className: "tiny pagebtn", textContent: label, title, disabled: off, onclick: go(n) });
          el0.hidden = !vis.length && pages < 2;
          el0.replaceChildren(
            el("div", { className: "sizebtns", role: "group", title: "Rows per page" }, vis.map(n => el("button", {
              type: "button", className: "tiny sizebtn" + (n === on ? " on" : ""), textContent: String(n), title: `Show ${n} rows per page`, "aria-pressed": n === on,
              // changing the size keeps the first row on screen: the page number is recomputed from it
              onclick: () => { if (n === pageSize.current(total)) return; pageSize.set(n); page = Math.floor(start / n); onChange(); },
            }))),
            pages > 1 ? el("div", { className: "pagenav" }, arrow("«", "First page", 0, page === 0), arrow("‹", "Previous page", page - 1, page === 0),
              el("span", { className: "muted", textContent: api.text }), arrow("›", "Next page", page + 1, page >= pages - 1), arrow("»", "Last page", pages - 1, page >= pages - 1)) : null);
          return rows;
        } };
      return api;
    },
    showMore(onChange, step) {
      const b = el("button", { className: "tiny moreBtn" });
      let shown = 0;
      b.onclick = () => onChange(shown + step);
      return { el: b, sync(total, s) { shown = s; b.hidden = total <= s; b.textContent = `Show more (${total - s} left)`; } };
    },
  };

  // prep(row): add the fields matching needs to a row object that has `name` (and optionally `extraText`, more words that
  // match at a lower rank, such as the type and the book).
  function prep(m) {
    m.lname = m.name.toLowerCase();
    m.words = m.lname.split(/[^a-z0-9']+/).filter(Boolean);
    m.extra = (m.extraText || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return m;
  }

  // loadIndex(url, map, onWait): -> Promise of { rows, d } where d is the whole answer and each row is map(arrayFromServer).
  async function loadIndex(url, map, onWait) {
    for (;;) {
      const r = await fetch(url);
      if (r.status === 202) { onWait?.(); await new Promise(res => setTimeout(res, 3000)); continue; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const d = await r.json();
      return { d, rows: d.m.map(row => prep(map(row, d))).sort((a, b) => a.name.localeCompare(b.name)) };
    }
  }

  // dist(a, b): edit distance where swapping two neighbouring letters is ONE edit ("gobiln" is one typo from "goblin").
  function dist(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 9;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }

  // numTest(text): "5" -> exactly 5, "1/2" -> one half, "3-5" -> 3 to 5, "5+" -> 5 or more; null if text is not a number.
  function numTest(text) {
    const n = "(\\d+(?:\\.\\d+)?|\\d+/\\d+)";
    const num = t => (t.includes("/") ? (+t.split("/")[0]) / (+t.split("/")[1]) : +t);
    let m;
    if ((m = text.match(new RegExp(`^${n}$`)))) { const v = num(m[1]); return c => c === v; }
    if ((m = text.match(new RegExp(`^${n}-${n}$`)))) { const lo = num(m[1]), hi = num(m[2]); return c => c >= lo && c <= hi; }
    if ((m = text.match(new RegExp(`^${n}\\+$`)))) { const lo = num(m[1]); return c => c >= lo; }
    return null;
  }

  // parseQuery(text, numeric) -> { words, num }. With `numeric` (monsters), "cr5", "cr:1/2", "cr 3-5" or a bare number is the
  // challenge rating and everything else is the name. Without it, every piece is part of the name.
  function parseQuery(text, numeric) {
    const parts = text.toLowerCase().split(/[\s,]+/).filter(Boolean), words = [];
    let num = null;
    for (let i = 0; i < parts.length; i++) {
      let t = parts[i];
      if (numeric) {
        const m = t.match(/^cr:?(.*)$/);
        if (m) { t = m[1] || parts[++i] || ""; if (!t) continue; const f = numTest(t); if (f) { num = f; continue; } t = parts[i]; }
        const f = numTest(t);
        if (f) { num = f; continue; }
      }
      words.push(t);
    }
    return { words, num };
  }

  // score(m, w): how well one typed word matches a row; lower is better, null = no match.
  //   0 a name word starts with it   1 it appears inside the name   2 it is a regular expression that matches the name
  //   3 a name word is one typo away (compared with the same number of letters, plus or minus one)   4 it matches the extra words
  function score(m, w) {
    if (m.words.some(x => x.startsWith(w))) return 0;
    if (m.lname.includes(w)) return 1;
    if (/[\\^$.*+?()[\]{}|]/.test(w)) { try { if (new RegExp(w, "i").test(m.name)) return 2; } catch (_) { /* not a valid expression: plain text below */ } }
    if (w.length >= 3) for (const x of m.words) for (const n of [w.length - 1, w.length, w.length + 1]) if (n > 0 && dist(w, x.slice(0, n)) <= 1) return 3;
    if (m.extra.some(x => x.startsWith(w))) return 4;
    return null;
  }

  // isBadRegex(text): true when a typed word looks like a regular expression but is not a valid one (the search box then
  // matches it as plain text and shows a red outline).
  function isBadRegex(text) {
    return (text || "").split(/[\s,]+/).some(w => /[\\^$.*+?()[\]{}|]/.test(w) && (() => { try { new RegExp(w, "i"); return false; } catch (_) { return true; } })());
  }

  // find(rows, f, cfg): f = { q, filters: {key: value}, numMin, numMax }; cfg = { num: row -> number (or null for lists
  // with no number), filters: [{ key, get }], keepOrder: true to leave rows in their given order when matches tie (tables) }.
  // Returns the matching rows, best first.
  function find(rows, f, cfg) {
    const q = parseQuery(f.q || "", !!cfg.num);
    const lo = f.numMin === "" || f.numMin == null ? -1 : +f.numMin, hi = f.numMax === "" || f.numMax == null ? 99 : +f.numMax;
    const out = [];
    for (const [idx, m] of rows.entries()) {
      if (cfg.filters?.some(x => f.filters?.[x.key] && x.get(m) !== f.filters[x.key])) continue;
      if (cfg.num) { const v = cfg.num(m); if (v < lo || v > hi || (q.num && !q.num(v))) continue; }
      let s = 0;
      for (const w of q.words) { const x = score(m, w); if (x == null) { s = null; break; } s += x; }
      if (s != null) out.push([s, m, idx]);
    }
    if (cfg.keepOrder) return out.sort((a, b) => a[0] - b[0] || a[2] - b[2]).map(x => x[1]);
    return out.sort((a, b) => a[0] - b[0] || (q.words.length ? a[1].name.length - b[1].name.length : 0) || a[1].name.localeCompare(b[1].name)).map(x => x[1]);
  }

  // panel(cfg) -> { el, redraw, setRows }
  //   rows      prepared rows (see prep)                 label(m)   "Goblin (CR 1/4)": what suggestions and the result list print
  //   sub(m)    the grey second part of a suggestion      columns    [{ label, text(m) }] for the result table (name first)
  //   num       { label, get(m) } for the number filter (monster CR) or omitted
  //   filters   [{ key, label, all, options: [[value, text]], get(m) }]
  //   onAdd(m)  the "+" button                            preview(m) the 📖 button (optional)
  //   note()    text to show while there are no rows yet  compact    a smaller version for pop-ups (fewer rows, no hint)
  function panel(cfg) {
    // Paging: the pop-up version shows 6 rows and a "Show more" button; the tabs use the shared pager (pageSize.pager above: sizes and pages).
    let rows = cfg.rows || [], shown = 6;
    const more = cfg.compact ? pageSize.showMore(n => { shown = n; redraw(); }, 6) : pageSize.pager(() => redraw());
    const f = { q: "", filters: {}, numMin: "", numMax: "" };
    const q = el("input", { type: "search", placeholder: cfg.placeholder, autocomplete: "off", className: "grow" });
    const sug = el("div", { className: "suggest", hidden: true });
    const byKey = {};
    const menus = (cfg.filters || []).map(x => {
      const sel = el("select", { title: x.label }, el("option", { value: "", textContent: x.all }), x.options.map(([v, t]) => el("option", { value: v, textContent: t })));
      sel.onchange = () => { f.filters[x.key] = sel.value; shown = 6; more.reset?.(); redraw(); };
      byKey[x.key] = sel;
      return sel;
    });
    const nmin = cfg.num && el("input", { type: "number", min: 0, max: 30, step: "any", placeholder: cfg.num.label + " from", className: "inum" });
    const nmax = cfg.num && el("input", { type: "number", min: 0, max: 30, step: "any", placeholder: "to", className: "inum" });
    if (cfg.num) [nmin, nmax].forEach(x => (x.onchange = () => { f.numMin = nmin.value; f.numMax = nmax.value; more.reset?.(); redraw(); }));
    const results = el("div");
    const fcfg = { num: cfg.num?.get, filters: cfg.filters };

    let pick = -1, timer = null;
    const showSug = () => {
      const best = q.value.trim() ? find(rows, { q: q.value.trim() }, fcfg).slice(0, 8) : [];
      pick = -1;
      sug.replaceChildren(...best.map(m => {
        const b = el("button", { type: "button", textContent: cfg.label(m) }, el("span", { className: "muted", textContent: "  " + cfg.sub(m) }));
        b.onmousedown = ev => { ev.preventDefault(); q.value = m.name; sug.hidden = true; f.q = m.name; shown = 6; more.reset?.(); redraw(); };
        return b;
      }));
      sug.hidden = !best.length;
    };
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { f.q = q.value.trim(); shown = 6; more.reset?.(); redraw(); showSug(); }, 60); };
    q.onblur = () => { sug.hidden = true; };
    q.onkeydown = ev => {
      const items = [...sug.children];
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); pick = (pick + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % (items.length || 1); items.forEach((b, i) => b.classList.toggle("on", i === pick)); }
      else if (ev.key === "Enter" && pick >= 0 && items[pick]) { ev.preventDefault(); items[pick].onmousedown(ev); }
      else if (ev.key === "Escape") sug.hidden = true;
    };

    function redraw() {
      if (!rows.length) { results.replaceChildren(el("p", { className: (cfg.note?.() || "").startsWith("Could") ? "bad" : "muted", textContent: cfg.note?.() || "" })); return; }
      const list = find(rows, f, fcfg);
      const visible = cfg.compact ? list.slice(0, shown) : more.show(list, rows.length);
      const body = visible.map(m => el("tr", {}, cfg.columns.map(c => el("td", { textContent: c.text(m) })),
        el("td", { className: "acts" }, el("button", { className: "primary", textContent: "+", title: "Add", onclick: () => cfg.onAdd(m) }),
          cfg.preview ? el("button", { textContent: "📖", title: "Details", onclick: () => cfg.preview(m) }) : null)));
      results.replaceChildren(
        el("p", { className: "muted", textContent: cfg.compact ? `${list.length} of ${rows.length}` + (f.q ? "" : ", A to Z") : more.text + (f.q ? "" : ", A to Z") }),
        el("table", { className: "loot" }, el("thead", {}, el("tr", {}, [...cfg.columns.map(c => c.label), ""].map(t => el("th", { textContent: t })))),
          el("tbody", {}, body.length ? body : el("tr", {}, el("td", { colSpan: cfg.columns.length + 1, className: "muted", textContent: "Nothing matches." })))),
        more.el);
      if (cfg.compact) more.sync(list.length, Math.min(shown, list.length));
    }
    const root = el("div", { className: "finder" + (cfg.compact ? " compact" : "") },
      el("div", { className: "row" }, el("div", { className: "sugwrap grow" }, q, sug), menus, nmin, nmax),
      cfg.compact ? null : el("p", { className: "muted", textContent: cfg.hint }), results);
    redraw();
    return { el: root, redraw, setRows(r) { rows = r; redraw(); },
      // setOptions(key, [[value, text]]): fill a filter menu once the list (and so its choices) is known.
      setOptions(key, options) { const sel = byKey[key]; if (sel) sel.append(...options.map(([v, t]) => el("option", { value: v, textContent: t }))); } };
  }

  return { el, prep, loadIndex, dist, find, isBadRegex, parseQuery, panel, pageSize };
})();
