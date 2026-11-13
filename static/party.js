"use strict";
// =============================================================================
// party.js - the Characters tab: one character's sheet, with a picker for the others
// =============================================================================
//
// THE PAGE
//   /party (the Characters tab) and /party/<id> use this one script. There is no character LIST here any more: Home lists the party and
//   the other characters, and uploads / exports them (home.js). This page always shows one character's sheet: the one in the address, or
//   else the one used last, or the party's first. A picker in the toolbar switches character.
//   The page HTML supplies two empty containers:  <... id="view"> the sheet,  <... id="partyBar"> the toolbar (picker + download).
//
// SERVER ENDPOINTS USED
//   GET    /api/party               the characters you may see (DM: all; player: yours): id, name, class, ...   (fills the picker)
//   GET    /api/active-party        (DM) which of them are in the loaded campaign's party: listed first in the picker
//   GET    /api/party/<id>          one full character (sheet.js reads the fields: see party.detail in party.py)
//   GET    /api/party/<id>/portrait image, used directly as an <img src>
//   GET    /api/party/<id>/export.zip  download one character (the DM: any; a player: their own)
//   PATCH  /api/party/<id>          HP, hit dice, conditions, inspiration, creatures (sheet.js; tracker.js sends the same)
//
// HOW THE PIECES FIT
//   boot  -> renderDetail() fetches one character and builds the sheet: a header and five sub-menu pages (UI.tabs from ui.js).
//            What is inside the pages comes from sheet.js (Tracker extras, Skills and Stats, Inventory, Spells, Feats Features and
//            Notes) and tracker.js (the live tracker). Every list is UI.dataTable, like every other list in the app.
//   Everything is async (it waits on the network); any error is shown as text on the page.
//
// Unlike tracker.js there is no IIFE wrapper here: the names below (h, view, get, ...) are page-level globals shared with nothing else.
// =============================================================================

// h(tag, props, ...kids) - builds one DOM element (a heap object the browser
// draws). Same helper as in tracker.js, repeated because this file is loaded
// by itself.
//   tag   : HTML tag name, e.g. "div".
//   props : object of properties copied onto the element (className,
//           textContent, onclick, href, ...). Default `{}` = none.
//   kids  : the `...kids` rest parameter gathers all remaining arguments into
//           an array (like safe varargs). Each child is an element or a string.
// Returns the new element; nothing is shown until it is appended to the page.
// Properties such as textContent are plain text, not HTML, so imported
// character data (names, notes) cannot inject markup or scripts. Gotcha:
// append(false/undefined) writes the literal text "false"/"undefined", which is
// why callers below pass "" instead of a falsy placeholder where it matters.
const h = (tag, props = {}, ...kids) => {
  // Object.assign(target, source) copies source's properties onto target.
  const n = Object.assign(document.createElement(tag), props);
  kids.forEach(k => n.append(k));
  return n;
};

// view = the main content container; bar = the toolbar container. The page
// HTML defines both ids. (`const a = x, b = y;` declares two constants.)
const view = document.getElementById("view"), bar = document.getElementById("partyBar");
const { stored, store, api } = UI;   // (ui.js is loaded first)

// get(url) - GET a JSON document from the server.
// Returns a Promise of the parsed JSON, or throws Error(statusText) on a non-2xx
// reply. `async`/`await` make this read like blocking code while the browser
// stays responsive (a future on a single-threaded event loop).
const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(r.statusText); return r.json(); };

// ---------------------------------------------------------- detail page
// renderDetail(id) - builds the character sheet for character `id` (taken from the URL): the header, then FIVE sub-menu pages
// (UI.tabs, ui.js): Tracker | Skills and Stats | Inventory | Spells | Feats, Features and Notes. What is inside each page is built
// by sheet.js (Sheet.*); the live tracker is tracker.js. This function only loads the character and connects the pieces.
// Async: waits for GET /api/party/<id>. Side effects: sets the browser tab title and appends to `view`.
async function renderDetail(id) {
  // The toolbar: a picker to switch to another character (this page IS the Characters tab; Home lists, imports and exports characters)
  // and the download of this one. Which character was open is remembered, so the tab comes back to it.
  const picker = h("select", { title: "Choose a character", onchange: () => { store("party.last", picker.value); location.href = "/_/party/" + picker.value; } });
  bar.append(picker, h("button", { className: "btn", onclick: () => safeDownload(`/api/party/${id}/export.zip`), textContent: "⬇ Download this character" }));
  fillPicker(picker, id);
  const m = await get("/api/party/" + id);
  document.title = m.name;
  const r = m.raceInfo;
  // "Wizard 5 / Fighter 2". `c.level || ""` covers a missing level; trim() removes the trailing space in that case.
  const classLine = m.classes.map(c => `${c.name} ${c.level || ""}`.trim()).join(" / ");
  // Header: portrait (if any), name, "race · classes · background", and a grey line of physical details.
  view.append(h("div", { className: "charhead" },
    m.hasImage ? h("img", { src: `/api/party/${id}/portrait`, alt: "" }) : "",
    h("div", {},
      h("h1", { textContent: m.name }),
      h("div", { textContent: [r.name, classLine, m.background.name].filter(Boolean).join(" · ") }),
      h("div", { className: "muted", textContent: [r.speed && r.speed + " ft", r.age && "age " + r.age, r.height, r.weight && r.weight + " lb", r.eyes && r.eyes + " eyes", r.skin, r.hair].filter(Boolean).join(" · ") }))));

  // patch(body): save one change (hit dice, conditions, inspiration, creatures), keep the answer in `m`. The panel that asked redraws itself.
  const patch = async body => {
    const res = await fetch("/api/party/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    Object.assign(m, await res.json());
  };
  // The Skills and Stats page is rebuilt every time it is opened (the Tracker page may have changed things meanwhile), so it loads the
  // character again first.
  const statsPanel = () => {
    const box = h("div");
    get("/api/party/" + id).then(fresh => { Object.assign(m, fresh); box.replaceChildren(Sheet.stats(m, patch)); })
      .catch(e => box.append(h("p", { className: "bad", textContent: "Error: " + e.message })));
    return box;
  };
  // The Tracker page: ONE card holding the live tracker for this character (HP, death saves, spell slots, trackers: `only` limits it to
  // this character, `initiative: false` leaves out the party's Initiative tab, and `conditions` / `inspiration` are left out because the parts
  // below show them) and, under it, hit dice, conditions, statistics, attacks and creatures (sheet.js).
  const trackerPanel = () => {
    const live = h("div", { className: "trackerlist" });
    mountTracker(live, { only: id, initiative: false, conditions: false, inspiration: false });
    return h("section", { className: "card sheetcard" }, live, Sheet.trackerExtras(m, patch));
  };

  // ---- the Add buttons (inventory, spells, notes). Each saves into the character's Fight Club file (party.py: add_item / add_spell / add_note), then
  // loads the character again and redraws that page. The two search pop-ups reuse the searches the other tabs have (LootTables.itemPanel, Spells.panel)
  // inside Nodes.popup; the note uses Nodes.form, the same dialog as every settings form.
  const post = async (path, body) => {
    const res = await fetch(`/api/party/${id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  };
  const refresh = async tab => { Object.assign(m, await get("/api/party/" + id)); sheet.show(tab); };
  // search(title, panel, addRow, tab): the pop-up. `addRow(row)` saves the chosen row; a failure is printed above the list.
  function search(title, panel, addRow, tab) {
    const msg = UI.status();
    const dlg = Nodes.popup({ title, body: h("div", {}, msg, panel.el) });
    panel.add = async row => { try { await addRow(row); dlg.close(); await refresh(tab); } catch (e) { msg.say(e.message, true); } };
    return panel;
  }
  const addLoot = () => {
    let add;
    const panel = LootTables.itemPanel(row => add(row), true);
    add = search("Add loot: search the magic items", panel, async row => {
      const f = await api("/api/items/" + encodeURIComponent(row.slug));
      await post("items", { name: f.name, type: f.type, rarity: f.rarity, text: (f.desc || "").replace(/\*\*/g, ""), attunement: !!(f.requires_attunement || "").trim() });
    }, "inv").add;
  };
  const addSpell = () => {
    let add;
    const panel = Spells.panel(row => add(row), true);
    add = search("Add spell: search the spells", panel, async row => {
      const f = await Spells.full(row.slug);
      await post("spells", { name: f.name, level: f.level_int, school: f.school, time: f.casting_time, range: f.range, duration: f.duration, components: f.components,
        materials: f.material, ritual: f.can_be_cast_as_ritual === true || f.ritual === "yes", classes: f.dnd_class,
        text: (f.desc || "").replace(/\*\*/g, "") + (f.higher_level ? `\n\nAt higher levels. ${f.higher_level}` : "") });
    }, "spells").add;
  };
  const addNote = () => Nodes.form({
    title: "Add a note", saveLabel: "Add note",
    fields: [{ key: "name", label: "Title", placeholder: "e.g. The Duke's riddle" }, { key: "text", label: "Note", type: "textarea", rows: 8, max: 8000 }],
    save: async v => {
      if (!v.name.trim()) return "Give the note a title";
      try { await post("notes", { name: v.name.trim(), text: v.text }); } catch (e) { return e.message; }
      await refresh("feats");
    },
  });

  // The five sub-menu pages. Inventory, Spells and Feats are rebuilt every time they are shown (an Add may have changed them).
  const counts = () => Sheet.counts(m);
  const sheet = UI.tabs({ key: "sheet", first: "tracker", tabs: [
    { id: "tracker", label: "Tracker", render: trackerPanel },
    { id: "stats", label: "Skills and Stats", render: statsPanel, fresh: true },
    { id: "inv", label: () => `Inventory (${counts().items})`, render: () => Sheet.inventory(m, addLoot), fresh: true },
    { id: "spells", label: () => `Spells (${counts().spells})`, render: () => Sheet.spells(m, addSpell), fresh: true },
    { id: "feats", label: () => `Feats, Features and Notes (${counts().features})`, render: () => Sheet.features(m, addNote), fresh: true },
  ] });
  view.append(sheet.el);
}

// ------------------------------------------------------------------ boot
// fillPicker(select, current): fill the character picker. The DM sees the loaded campaign's party first, then everyone else; a player only
// has their own characters (the server only lists those). Async: it fills the box when the lists arrive.
async function fillPicker(select, current) {
  const [all, party] = await Promise.all([get("/api/party"), get("/api/active-party").catch(() => ({ party: [] }))]);
  const inParty = new Set(party.party.map(p => p.id));
  const opt = c => h("option", { value: c.id, textContent: `${c.name}${c.class ? " · " + c.class : ""}` });
  const mine = all.filter(c => inParty.has(c.id)), rest = all.filter(c => !inParty.has(c.id));
  select.append(...(mine.length && rest.length ? [h("optgroup", { label: "In the party" }, ...mine.map(opt)), h("optgroup", { label: "Other characters" }, ...rest.map(opt))] : all.map(opt)));
  select.value = current;
}

// Entry point. This page is the Characters tab, loaded inside the app shell's frame: "/_/party" or "/_/party/<id>". With an id it shows
// that character; without one it opens the one used last (or the first of the party, or the first character) so the tab always lands on a sheet.
async function boot() {
  let id = location.pathname.split("/").filter(Boolean)[2];
  if (!id) {
    const [all, party] = await Promise.all([get("/api/party"), get("/api/active-party").catch(() => ({ party: [] }))]);
    const last = stored("party.last", "");
    const first = all.find(c => c.id === last) || all.find(c => party.party.some(p => p.id === c.id)) || all[0];
    if (!first) { view.append(h("p", { className: "muted" }, "No characters yet. Upload a Fight Club file from the ", h("a", { href: "/", textContent: "Home tab", onclick: ev => { ev.preventDefault(); parent.postMessage({ type: "goto", page: "home" }, location.origin); } }), ".")); return; }
    id = first.id;
  }
  store("party.last", id);
  await renderDetail(id);
}
boot().catch(e => view.append(h("p", { textContent: "Error: " + e.message })));
