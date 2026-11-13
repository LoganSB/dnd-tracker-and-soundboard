"use strict";
// =============================================================================
// party.js - the /party pages: character list, import form, character sheet
// =============================================================================
//
// WHICH PAGES LOAD IT
//   Both /party (the list) and /party/<id> (one character's full sheet) use
//   this same script. The page HTML supplies two empty containers that this
//   code fills in:
//     <... id="view">        the main content area
//     <... id="partyBar">    a toolbar row (used only on the list page)
//   At the very bottom ("boot") the script looks at the URL path to decide
//   which of the two pages it is on.
//
// SERVER ENDPOINTS USED
//   GET    /api/party               list of character summaries:
//                                     id, name, race, class, hp, hpMax,
//                                     hasImage (bool)
//   GET    /api/party/<id>          one full character. Fields read below:
//                                     name, hasImage, hp, hpMax, xp, money,
//                                     inspiration, totalWeight, unarmed,
//                                     raceInfo{name, speed, age, height,
//                                       weight, eyes, skin, hair},
//                                     background{name, feats[]},
//                                     classes[{name, level, hd, hdCurrent,
//                                       armor, weapons, tools, feats[]}],
//                                     abilities[{name, score, mod}],
//                                     slots[], slotsCurrent[],
//                                     trackers[{id, label, cur, max}],
//                                     items[], containers[{name, weight,
//                                       value, items[]}],
//                                     spells[], raceFeats[], feats[], notes[]
//                                   An item has: name, quantity, type, detail,
//                                   ac, damage, damage2h, damageType,
//                                   property, range, weight, value, magic,
//                                   equipped, text. A spell has: name, level,
//                                   prepared, school, time, range, components,
//                                   duration, materials, text. A feat/note has
//                                   name and text.
//   GET    /api/party/<id>/portrait image, used directly as an <img src>
//   DELETE /api/party/<id>          remove a character from the party
//   POST   /api/party/preview (lists the characters in an upload) and /api/party/import (saves the chosen ones; see importer.js)
//   POST   /api/party/import        multipart file upload (Fight Club 5
//                                   .backup / .xml, or a .zip containing one)
//                                   -> {error:"..."} on failure
//   GET    /api/party/export.zip    download link (plain <a href>, no JS)
//   GET    /api/party/<id>/export.zip  download one character (the DM: any; a player: their own)
//   GET    /download/collection.zip download link (plain <a href>, no JS)
//   PATCH  /api/party/<id>          HP, hit dice, conditions, inspiration, creatures (the Skills and Stats page; tracker.js sends the same)
//
// HOW THE PIECES FIT
//   boot  -> renderList()   builds the toolbar, import form and character grid
//         -> renderDetail() fetches one character and builds the sheet: a header and five sub-menu pages (UI.tabs from ui.js).
//                           What is inside the pages comes from sheet.js (Skills and Stats, Inventory, Spells, Feats Features and
//                           Notes) and tracker.js (the live Tracker page). Every list is UI.dataTable, like every other list in the app.
//   Both are async functions (they wait on the network), and any error is
//   caught at the bottom and shown as text on the page.
//
// Unlike tracker.js there is no IIFE wrapper here: the names below (h, view,
// get, ...) are page-level globals shared with nothing else but this file's own
// functions. They are not exported on purpose; nothing else needs them.
// Everything is drawn once at load time (no polling, no redraw loop); the page
// reloads itself (location.reload()) after an import or removal.
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

// get(url) - GET a JSON document from the server.
// Returns a Promise of the parsed JSON, or throws Error(statusText) on a non-2xx
// reply. `async`/`await` make this read like blocking code while the browser
// stays responsive (a future on a single-threaded event loop).
const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(r.statusText); return r.json(); };

// section(title, ...kids) - builds a titled "card": <section><h2>title</h2>
// ...kids</section>. `...kids` collects the extra arguments into an array, and
// the `...kids` inside the h() call spreads that array back out as separate
// arguments.
const section = (title, ...kids) => h("section", { className: "card" }, h("h2", { textContent: title }), ...kids);

// ------------------------------------------------------------ list page
// renderList() - builds the /party page: toolbar links, the import form, and a
// grid of character cards (each with a Remove button). Async because it waits
// for GET /api/party. Side effects: fills `bar` and `view`; the import and
// remove buttons talk to the server and then reload the page.
async function renderList() {
  // A player (document.body.dataset.role) sees only their own characters, so the DM-only extras are left out.
  const isDM = document.body.dataset.role === "dm";
  // Three toolbar links. The first two are ordinary downloads. The third opens
  // the tracker in a small pop-up window: its onclick cancels the normal link
  // navigation (preventDefault) and calls window.open with a window name and a
  // size, so repeated clicks reuse the same pop-up. The plain href remains as a
  // fallback (e.g. if pop-ups are blocked or the link is middle-clicked).
  // Downloads are buttons, not links: safeDownload (errors.js) checks the answer first, so a "not found" is printed next to
  // the button instead of replacing this page.
  bar.append(h("button", { className: "btn", onclick: () => safeDownload("/api/party/export.zip"),
    textContent: isDM ? "⬇ Export party (Fight Club backup)" : "⬇ Export my character (Fight Club backup)" }));
  bar.append(h("button", { className: "btn", onclick: () => safeDownload("/download/collection.zip"), textContent: "⬇ Fight Club 5e collection zip" }));
  if (isDM) bar.append(
    h("a", { href: "/tracker", target: "dmtracker", className: "btn", textContent: "Open tracker window",
      onclick: e => { e.preventDefault(); window.open("/tracker", "dmtracker", "width=460,height=720"); } }));
  // Status line under the import form (used for progress and errors).
  const msg = h("p", { className: "muted" });
  // File picker limited to the accepted extensions.
  const file = h("input", { type: "file", accept: ".backup,.xml,.zip" });
  // Import button. Its click handler is an async arrow function (it awaits
  // network calls); the browser just sees a callback and ignores the Promise.
  const imp = h("button", { className: "primary", textContent: "Import", onclick: async () => {
    // file.files is the list of chosen files; [0] is the first. Undefined means nothing chosen yet.
    if (!file.files[0]) { msg.textContent = "Choose a .backup, .xml or .zip file first."; return; }
    msg.textContent = "Reading the file…";
    // Importer (importer.js) looks inside the file, asks which characters to import and imports each chosen one on its own.
    // On success reload so the list shows the new characters.
    const res = await Importer.start(file.files[0], { onDone: () => location.reload() });
    msg.textContent = res ? "" : "Nothing imported.";
  } });
  const box = section("Import characters",
    h("p", { className: "muted", textContent: "Fight Club 5 backup (.backup / .xml) or a zip containing one. You choose which characters in it to import; existing ones with the same id are updated." }),
    h("div", { className: "row" }, file, imp), msg);
  const grid = h("div", { className: "partygrid" });
  // Wait for the party list from the server (the function pauses here; the
  // browser keeps running). Throws on HTTP error; the caller's .catch shows it.
  const list = await get("/api/party");
  list.forEach(m => {
    // Remove button for this character (m is captured by the closure, so each
    // button remembers its own character). It sits inside the card's <a> link,
    // so preventDefault stops the click from also opening the character page.
    const del = h("button", { className: "danger tiny", textContent: "Remove", onclick: async e => {
      e.preventDefault();
      // Template literal (backtick string): ${m.name} is substituted in.
      // confirm() is a yes/no browser dialog returning true/false.
      if (confirm(`Remove ${m.name} from the party? (Export first if you want a copy.)`)) {
        await fetch("/api/party/" + m.id, { method: "DELETE" });
        location.reload();
      }
    } });
    // One clickable card per character: portrait (or a wizard emoji if none),
    // name, "race · class", HP, and the Remove button.
    grid.append(h("a", { className: "pcard", href: "/_/party/" + m.id },
      m.hasImage ? h("img", { src: `/api/party/${m.id}/portrait`, alt: "" }) : h("div", { className: "noimg", textContent: "🧙" }),
      h("div", {},
        h("b", { textContent: m.name }),
        // [race, class].filter(Boolean) drops empty values (Boolean() is
        // false for "" / undefined), join glues the rest with " · ".
        h("div", { className: "muted", textContent: [m.race, m.class].filter(Boolean).join(" · ") }),
        h("div", { textContent: `HP ${m.hp}/${m.hpMax}` }),
        // The download sits inside the card's <a> link, so the click is handled by hand (no nested links).
        h("button", { className: "tiny", textContent: "⬇ Download", title: "Download this character (Fight Club backup)", onclick: e => { e.preventDefault(); safeDownload(`/api/party/${m.id}/export.zip`); } }), del)));
  });
  // The live tracker (the same widget as the popup: HP, spell slots, death saves, mana, conditions and
  // the Initiative tab), built right into this page. mountTracker comes from tracker.js, which
  // party.html loads first. It polls the server itself, so it stays in sync with other windows.
  const none = h("p", { className: "muted", textContent: "No characters yet." });
  if (!isDM) { view.append(box, list.length ? grid : none); return; }   // players: no whole-party tracker
  const live = h("div", { className: "trackerlist" });
  mountTracker(live);
  view.append(section("Live tracker", live), box, list.length ? grid : none);
}

// ---------------------------------------------------------- detail page
// renderDetail(id) - builds the character sheet for character `id` (taken from the URL): the header, then FIVE sub-menu pages
// (UI.tabs, ui.js): Tracker | Skills and Stats | Inventory | Spells | Feats, Features and Notes. What is inside each page is built
// by sheet.js (Sheet.*); the live tracker is tracker.js. This function only loads the character and connects the pieces.
// Async: waits for GET /api/party/<id>. Side effects: sets the browser tab title and appends to `view`.
async function renderDetail(id) {
  // The toolbar of the detail page: a way back to the list (this page lives inside a frame, so the link
  // loads the list into the same frame).
  bar.append(h("a", { href: "/_/party", className: "btn", textContent: "← All characters" }),
    h("button", { className: "btn", onclick: () => safeDownload(`/api/party/${id}/export.zip`), textContent: "⬇ Download this character" }));
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

  // patch(body): save one change (HP, hit dice, conditions, inspiration, creatures), keep the answer in `m`, redraw the open panel.
  const patch = async body => {
    const res = await fetch("/api/party/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    Object.assign(m, await res.json());
    sheet.show("stats");
  };
  // The Skills and Stats page is rebuilt every time it is opened (HP and conditions may have been changed in the Tracker meanwhile), so it
  // loads the character again first.
  const statsPanel = () => {
    const box = h("div");
    get("/api/party/" + id).then(fresh => { Object.assign(m, fresh); box.replaceChildren(Sheet.stats(m, patch)); })
      .catch(e => box.append(h("p", { className: "bad", textContent: "Error: " + e.message })));
    return box;
  };
  // The live tracker for just this character (HP, death saves, spell slots, trackers, conditions): `only` limits it to this character,
  // `initiative: false` leaves out the Initiative tab, which is about the whole party.
  const trackerPanel = () => { const live = h("div", { className: "trackerlist" }); mountTracker(live, { only: id, initiative: false }); return live; };
  const n = Sheet.counts(m);
  const sheet = UI.tabs({ key: "sheet", first: "tracker", tabs: [
    { id: "tracker", label: "Tracker", render: trackerPanel },
    { id: "stats", label: "Skills and Stats", render: statsPanel, fresh: true },
    { id: "inv", label: `Inventory (${n.items})`, render: () => Sheet.inventory(m) },
    { id: "spells", label: `Spells (${n.spells})`, render: () => Sheet.spells(m) },
    { id: "feats", label: `Feats, Features and Notes (${n.features})`, render: () => Sheet.features(m) },
  ] });
  view.append(sheet.el);
}

// ------------------------------------------------------------------ boot
// Entry point; runs as soon as the script loads. location.pathname is the URL
// path. This page is loaded inside the app shell's third frame, so the path is
// "/_/party" or "/_/party/abc123". split("/") gives ["", "_", "party",
// "abc123"] and filter(Boolean) removes the empty first piece, so parts[0] is
// "_", parts[1] is "party" and parts[2] is the character id if there is one. With an id we show
// the detail sheet, otherwise the list. Both render functions return Promises;
// `.catch(...)` registers an error handler that prints "Error: ..." on the page
// (like checking a return code) if any await above threw (network down, 404...).
const parts = location.pathname.split("/").filter(Boolean);
(parts[2] ? renderDetail(parts[2]) : renderList()).catch(e => view.append(h("p", { textContent: "Error: " + e.message })));
