"use strict";
// builder.js - the editor shared by the Encounters tab and the Loot tab (and the small loot editor inside the campaign
// tracker's loot pop-up). The two differ only in a configuration object; everything else is here:
//
//   [ picker: choose one ] [+ New] [Rename] [Delete]        <- hidden when `lockId` is given (the pop-up edits one table)
//   notes
//   table of entries (one row per monster / item, each with its own number boxes and a remove button)
//   summary (difficulty / chances)       action buttons       status line
//   the search panel (Finder) that adds entries
//
// Needs ui.js (UI) and finder.js (Finder) to be loaded first. Saves a moment after the last edit; the buttons that use
// the saved record call flush() first so they never act on stale data.
//
// Builder.mount(host, cfg) -> { reload, select, flush }
//   cfg.api         "/api/encounters"  (GET list, POST {name}, PUT/DELETE /<id>)       cfg.noun   "encounter"
//   cfg.list        key of the entries array in a record ("monsters" / "entries")      cfg.box    storage key prefix
//   cfg.head        column titles                                  cfg.row(entry, ctx) -> array of cells (nodes or text)
//   cfg.preview(entry)  optional: opens details for an entry (adds a 📖 button)
//   cfg.rowActions(entry, ctx)  optional: more buttons at the end of each entry's row (the Loot tab adds 🎁 Give)
//   cfg.finder(add) -> a Finder.panel whose "+" calls add(rowFromTheList)               cfg.addEntry(record, row)
//   cfg.custom      optional { placeholder, make(name) -> entry } for adding an entry by hand
//   cfg.summary(record, ctx) -> node (redrawn after every edit)           cfg.actions(record, ctx) -> array of buttons
//   cfg.attach(record, ctx) -> node shown under the buttons (optional; the Encounters tab puts the map uploads here)
//   cfg.compact     smaller layout for pop-ups                  cfg.lockId   edit only this record, no picker
//   cfg.initialId   which record to open first                  cfg.onChange(record)  called after each saved edit, create, rename or delete
// ctx = { num(entry, key, title), save, flush, msg, reload, select, refresh, record }
const Builder = (() => {
  const { h, api, box, status, libraryChanged } = UI;

  // The notes box grows with its text: at least 2 lines, up to 10 lines tall (then it scrolls), at most 100 lines of text and 8000 characters
  // (about 80 characters a line; the server keeps the same limit, NOTE_MAX_CHARS in encounters.py).
  const NOTE_MIN_LINES = 2, NOTE_AUTO_LINES = 10, NOTE_MAX_LINES = 100, NOTE_MAX_CHARS = 8000;
  function fit(t) {
    if (!t.isConnected) return;
    t.style.height = "auto";   // back to the 2-line height so scrollHeight measures the text alone
    const cs = getComputedStyle(t), line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
    const min = t.offsetHeight, chrome = t.offsetHeight - t.clientHeight, max = Math.max(min, NOTE_AUTO_LINES * line + (min - NOTE_MIN_LINES * line));
    t.style.height = Math.min(Math.max(t.scrollHeight + chrome, min), max) + "px";
    t.style.overflowY = t.scrollHeight + chrome > max ? "auto" : "hidden";
  }
  function limitLines(t) {
    const lines = t.value.split("\n");
    if (lines.length > NOTE_MAX_LINES) t.value = lines.slice(0, NOTE_MAX_LINES).join("\n");
  }

  function mount(host, cfg) {
    let items = [], current = cfg.lockId || cfg.initialId || null, timer = null;
    const msg = status();
    const editor = h("div");
    const cur = () => items.find(i => i.id === current);
    const put = () => { const r = cur(); return r ? api(`${cfg.api}/${r.id}`, "PUT", { name: r.name, notes: r.notes, [cfg.list]: r[cfg.list] }) : Promise.resolve(); };
    // changed(rec): tell this page (cfg.onChange) and every other page (libraryChanged) that the library was edited.
    const changed = rec => { cfg.onChange?.(rec); libraryChanged(); };
    const save = () => { clearTimeout(timer); timer = setTimeout(async () => { timer = null; await put(); changed(cur()); }, 400); };
    const flush = async () => { if (timer) { clearTimeout(timer); timer = null; await put(); changed(cur()); } };

    async function reload() {
      items = await api(cfg.api);
      if (!items.some(i => i.id === current)) current = cfg.lockId ? null : items[0]?.id || null;
      draw();
    }
    const select = id => { current = id; draw(); };

    function draw() {
      const rec = cur();
      const make = h("button", { textContent: `+ New ${cfg.noun}`, onclick: async () => {
        const name = prompt(`Name for the new ${cfg.noun}`, `New ${cfg.noun}`);
        if (!name) return;
        const n = await api(cfg.api, "POST", { name });
        items.push(n); current = n.id; draw(); changed(n);
      } });
      const picker = h("select", {}, items.map(x => h("option", { value: x.id, textContent: x.name })));
      picker.value = current || "";
      picker.onchange = () => select(picker.value);
      const top = cfg.lockId ? null : h("div", { className: "row" }, picker, make,
        rec ? h("button", { textContent: "Rename", onclick: async () => {
          const name = prompt("New name", rec.name);
          if (!name) return;
          rec.name = name; await put(); draw(); changed(rec);
        } }) : null,
        rec ? h("button", { className: "danger", textContent: `Delete ${cfg.noun}`, onclick: async () => {
          if (!confirm(`Delete ${cfg.noun} "${rec.name}"?`)) return;
          await api(`${cfg.api}/${rec.id}`, "DELETE");
          items = items.filter(x => x !== rec); current = items[0]?.id || null; draw(); changed();
        } }) : null);
      if (!rec) { editor.replaceChildren(...[top, h("p", { className: "muted", textContent: `No ${cfg.noun}s in this campaign yet.` })].filter(Boolean)); return; }

      const summary = h("div");
      const ctx = { save, flush, msg, reload, select, record: rec, refresh: () => summary.replaceChildren(cfg.summary(rec, ctx)),
        num: (entry, key, title) => {
          const i = h("input", { type: "number", value: entry[key] ?? "", className: "inum", title: title || key });
          i.onchange = () => { entry[key] = i.value === "" ? null : +i.value; save(); ctx.refresh(); };
          return i;
        } };
      const notes = h("textarea", { rows: 2, placeholder: "Notes", value: rec.notes || "", maxLength: NOTE_MAX_CHARS, className: "notebox", oninput: () => { limitLines(notes); rec.notes = notes.value; fit(notes); save(); } });
      const rows = rec[cfg.list].map(entry => h("tr", {},
        cfg.row(entry, ctx).map(c => h("td", { textContent: typeof c === "string" ? c : undefined }, typeof c === "string" ? null : c)),
        h("td", { className: "acts" }, ...(cfg.rowActions?.(entry, ctx) || []), cfg.preview ? h("button", { textContent: "📖", title: "Details", onclick: () => cfg.preview(entry) }) : null,
          h("button", { className: "tiny danger", textContent: "✕", onclick: () => { rec[cfg.list] = rec[cfg.list].filter(x => x !== entry); save(); draw(); } }))));
      const custom = cfg.custom && (() => {
        const name = h("input", { placeholder: cfg.custom.placeholder });
        const add = () => { if (!name.value.trim()) return; rec[cfg.list].push(cfg.custom.make(name.value.trim())); save(); draw(); };
        name.onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); add(); } };
        return h("div", { className: "row" }, name, h("button", { textContent: "Add by name", onclick: add }));
      })();
      // (replaceChildren would print a null or undefined as the word, so empty slots are filtered out)
      editor.replaceChildren(...[top, cfg.compact ? null : notes,
        h("table", { className: "loot" }, h("thead", {}, h("tr", {}, [...cfg.head, ""].map(t => h("th", { textContent: t })))),
          h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colSpan: cfg.head.length + 1, className: "muted", textContent: "Nothing yet: search below and press +." })))),
        custom, summary, h("div", { className: "row" }, ...(cfg.actions?.(rec, ctx) || [])), cfg.attach?.(rec, ctx), msg].filter(Boolean));
      ctx.refresh();
      requestAnimationFrame(() => fit(notes));   // size the notes box to its text once it is on the page
    }

    // The search panel is built once (it keeps what was typed) and added to by pressing + on a row.
    const panel = cfg.finder(async row => {
      const rec = cur();
      if (!rec) { msg.say(`Create ${cfg.noun === "encounter" ? "an" : "a"} ${cfg.noun} first`, true); return; }
      cfg.addEntry(rec, row);
      save(); draw();
    });
    const wrap = cfg.compact ? [editor, panel.el] : [box(cfg.box + "-edit", cfg.title, editor), box(cfg.box + "-search", cfg.finderTitle, panel.el)];
    host.replaceChildren(...wrap);
    reload();
    return { reload, select, flush, panel };
  }

  return { mount };
})();
