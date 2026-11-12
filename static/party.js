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
//   POST   /api/party/import        multipart file upload (Fight Club 5
//                                   .backup / .xml, or a .zip containing one)
//                                   -> {error:"..."} on failure
//   GET    /api/party/export.zip    download link (plain <a href>, no JS)
//   GET    /api/party/<id>/export.zip  download one character (the DM: any; a player: their own)
//   GET    /download/collection.zip download link (plain <a href>, no JS)
//   (Editing HP, slots, etc. is done by tracker.js, not here: this page is
//   read-only apart from import and remove.)
//
// HOW THE PIECES FIT
//   boot  -> renderList()   builds the toolbar, import form and character grid
//         -> renderDetail() fetches one character and builds the sheet from
//                           section() cards, using fold() for expandable rows
//                           and itemRow() for inventory entries.
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

// sgn(n) - number with explicit sign, e.g. 3 -> "+3", -1 -> "-1". Used for
// ability modifiers.
const sgn = n => (n >= 0 ? "+" : "") + n;

// gp(v) - formats a gold value: "—" if zero/missing, otherwise the number plus
// " gp". Values of 1000+ use toLocaleString() for thousands separators
// ("1,250"); smaller values print as-is. `cond ? a : b` is the ternary operator.
const gp = v => (v ? (v >= 1000 ? v.toLocaleString() : v) + " gp" : "—");

// collapsible block with a (possibly long) text body
// fold(title, meta, body, open) - builds a click-to-expand row using the
// browser's built-in <details>/<summary> element (no JS needed to toggle it).
//   title : bold heading text.
//   meta  : smaller grey text after the title (may be empty/undefined).
//   body  : optional long text shown when expanded; if empty the row is just a
//           heading.
//   open  : start expanded? (default parameter `open = false`).
// Returns the <details> element.
const fold = (title, meta, body, open = false) => {
  // `{ className: "fold", open }` is shorthand for `{ className: "fold", open: open }`.
  const d = h("details", { className: "fold", open });
  // `" " + (meta || "")` guards against undefined meta printing "undefined".
  d.append(h("summary", {}, h("b", { textContent: title }), h("span", { className: "muted", textContent: " " + (meta || "") })));
  // The body is set with textContent, so newlines are kept only if the CSS
  // allows (presumably white-space: pre-wrap) and nothing is parsed as HTML.
  if (body) d.append(h("div", { className: "body", textContent: body }));
  return d;
};

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
    // file.files is the list of chosen files; [0] is the first. Undefined means
    // nothing chosen yet.
    if (!file.files[0]) { msg.textContent = "Choose a .backup, .xml or .zip file first."; return; }
    // FormData builds a multipart/form-data body (the format of an HTML file
    // upload form). The field name "file" is what the server looks for.
    const fd = new FormData(); fd.append("file", file.files[0]);
    msg.textContent = "Importing…";
    // POST the upload; no Content-Type header is set because the browser must
    // add it itself (it includes the multipart boundary string).
    const r = await fetch("/api/party/import", { method: "POST", body: fd });
    const j = await r.json();
    // On error the server sends {error: "..."}; show it and stay on the page.
    if (!r.ok) { msg.textContent = j.error; return; }
    // On success reload so the list shows the new characters.
    location.reload();
  } });
  const box = section("Import characters",
    h("p", { className: "muted", textContent: "Fight Club 5 backup (.backup / .xml) or a zip containing one. Only characters are imported; existing ones with the same id are updated." }),
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
// itemRow(i) - builds one expandable inventory row for item `i`. The heading is
// "3× Arrow" style (quantity, name, a star if magical); the grey summary line is
// a "·"-separated list of whichever stats exist (type, AC, damage, weight,
// value ...); the expanded body is the item's description text. Equipped items
// get an extra CSS class ("equipped") so they can be highlighted. Returns the
// element; no server calls.
function itemRow(i) {
  // Build a list of optional pieces, then keep only the real ones. The trick:
  // `a && b` evaluates to `a` when `a` is falsy (0, "", undefined) and to `b`
  // otherwise, so missing fields become falsy values that filter(Boolean)
  // discards.
  const bits = [
    i.type,
    i.detail,
    i.ac && "AC " + i.ac,
    // Damage text, e.g. "1d8 (1d10 two-handed) slashing". The template literal
    // nests another conditional; trim() removes a trailing space if there is no
    // damage type.
    i.damage && `${i.damage}${i.damage2h ? " (" + i.damage2h + " two-handed)" : ""} ${i.damageType}`.trim(),
    i.property,
    i.range && "range " + i.range,
    // Total weight of the stack (weight each times quantity).
    i.weight && i.weight * i.quantity + " lb",
    i.value && gp(i.value)
  ].filter(Boolean);
  const title = (i.quantity > 1 ? `${i.quantity}× ` : "") + i.name + (i.magic ? " ✦" : "");
  const d = fold(title, bits.join(" · "), i.text);
  // classList.add attaches a CSS class without disturbing the others.
  if (i.equipped) d.classList.add("equipped");
  return d;
}

// renderDetail(id) - builds the full character sheet for character `id`
// (taken from the URL). Async: waits for GET /api/party/<id>, then builds every
// card in order: header, Overview (abilities, HP, XP, slots, hit dice),
// Inventory, containers, Spells (grouped by level), Features & feats, Notes.
// Side effects: sets the browser tab title and appends to `view`. Read-only:
// it never changes data on the server.
async function renderDetail(id) {
  // The toolbar of the detail page: a way back to the list (this page lives inside a frame, so the link
  // loads the list into the same frame).
  bar.append(h("a", { href: "/_/party", className: "btn", textContent: "← All characters" }),
    h("button", { className: "btn", onclick: () => safeDownload(`/api/party/${id}/export.zip`), textContent: "⬇ Download this character" }));
  const m = await get("/api/party/" + id);
  document.title = m.name;
  const r = m.raceInfo;
  // "Wizard 5 / Fighter 2". `c.level || ""` covers a missing level; trim()
  // removes the trailing space in that case. map turns each class object into a
  // string.
  const classLine = m.classes.map(c => `${c.name} ${c.level || ""}`.trim()).join(" / ");
  // Header: portrait (if any), name, "race · classes · background", and a grey
  // line of physical details (each piece appears only if present).
  view.append(h("div", { className: "charhead" },
    m.hasImage ? h("img", { src: `/api/party/${id}/portrait`, alt: "" }) : "",
    h("div", {},
      h("h1", { textContent: m.name }),
      h("div", { textContent: [r.name, classLine, m.background.name].filter(Boolean).join(" · ") }),
      h("div", { className: "muted", textContent: [r.speed && r.speed + " ft", r.age && "age " + r.age, r.height, r.weight && r.weight + " lb", r.eyes && r.eyes + " eyes", r.skin, r.hair].filter(Boolean).join(" · ") }))));

  // Live tracker card for just this character (HP, death saves, spell slots, mana, conditions),
  // using the same widget as the popup. `only` limits it to this character; `initiative: false`
  // leaves out the Initiative tab, which is about the whole party rather than one character.
  const live = h("div", { className: "trackerlist" });
  mountTracker(live, { only: id, initiative: false });
  view.append(section("Live tracker", live));

  // Ability score boxes: for each ability, its name, signed modifier (bold) and
  // raw score.
  const stats = h("div", { className: "stats" });
  m.abilities.forEach(a => stats.append(h("div", { className: "stat" },
    h("div", { className: "muted", textContent: a.name }),
    h("b", { textContent: sgn(a.mod) }), h("div", { textContent: a.score }))));
  // Spell slot summary "L1: 3/4   L2: 2/3": levels with no slots become null
  // and are filtered out. `??` uses the max when no "current" value is stored
  // (but keeps a real 0).
  const slots = m.slots.map((max, i) => max ? `L${i + 1}: ${m.slotsCurrent[i] ?? max}/${max}` : null).filter(Boolean).join("   ");
  view.append(section("Overview", stats,
    // A row of small facts. Entries that are not applicable are "" or a falsy
    // value from &&; empty ones print nothing visible.
    h("div", { className: "kv" },
      h("span", { textContent: `HP ${m.hp}/${m.hpMax}` }), h("span", { textContent: `XP ${m.xp || 0}` }),
      h("span", { textContent: `Inspiration ${m.inspiration}` }), h("span", { textContent: `Money ${m.money || 0} gp` }),
      h("span", { textContent: `Carried ${m.totalWeight} lb` }), m.unarmed && h("span", { textContent: "Unarmed " + m.unarmed }),
      // The character's own trackers (Mana, Ki, Rage ...): only the ones this character actually has.
      ...m.trackers.map(t => h("span", { textContent: `${t.label} ${t.cur}/${t.max}` }))),
    slots && h("div", { textContent: "Spell slots — " + slots }),
    // One grey line per class: hit die, hit dice remaining, and any armor /
    // weapon / tool proficiencies. `?` is a placeholder for unknown values.
    ...m.classes.map(c => h("div", { className: "muted", textContent: `${c.name}: hit die d${c.hd || "?"} (${c.hdCurrent ?? "?"} left)${c.armor ? " · armor: " + c.armor : ""}${c.weapons ? " · weapons: " + c.weapons : ""}${c.tools ? " · tools: " + c.tools : ""}` }))));

  // inventory: equipped first
  // `[...m.items]` makes a shallow copy (spread) so sorting does not reorder the
  // original array. The comparator subtracts booleans (true = 1, false = 0), so
  // equipped items (true) sort before unequipped ones.
  const inv = [...m.items].sort((a, b) => b.equipped - a.equipped);
  // Each item becomes a row via itemRow (passed as a callback to map).
  view.append(section(`Inventory (${m.items.length})`, ...inv.map(itemRow)));
  // Bags/containers each get their own card with weight, optional value, and
  // their items.
  m.containers.forEach(c => view.append(section(`📦 ${c.name} (${c.items.length})`,
    h("div", { className: "muted", textContent: `${c.weight} lb${c.value ? " · " + gp(c.value) : ""}` }),
    ...c.items.map(itemRow))));

  if (m.spells.length) {
    const sec = section(`Spells (${m.spells.length})`);
    // Group spells by level. byLevel is a plain object used as a dictionary
    // (hash map): keys are level numbers (as strings), values are arrays.
    const byLevel = {};
    // `||=` means "if byLevel[level] is unset, assign a new empty array", and
    // the expression then yields that array so we can push onto it.
    m.spells.forEach(s => (byLevel[s.level] ||= []).push(s));
    // Object.keys gives the level keys as strings. The numeric comparator
    // (a - b) coerces them to numbers so 10 sorts after 2 (plain sort() would
    // be alphabetical).
    Object.keys(byLevel).sort((a, b) => a - b).forEach(l => {
      // `+l` converts the key string back to a number; level 0 = cantrips.
      sec.append(h("h3", { textContent: +l === 0 ? "Cantrips" : "Level " + l }));
      // Within a level: prepared spells first, then alphabetical by name
      // (localeCompare compares strings in a language-aware way).
      byLevel[l].sort((a, b) => b.prepared - a.prepared || a.name.localeCompare(b.name)).forEach(s => {
        const meta = [s.prepared ? "prepared" : "", s.school, s.time, s.range, s.components, s.duration].filter(Boolean).join(" · ");
        // Body = optional "Materials:" line, a blank line, then the spell text.
        const d = fold(s.name, meta, (s.materials ? `Materials: ${s.materials}\n\n` : "") + s.text);
        if (s.prepared) d.classList.add("equipped");
        sec.append(d);
      });
    });
    view.append(sec);
  }

  // Collect every feature/feat as a [feature, source label] pair so they can be
  // shown in one list tagged with where they came from.
  const feats = [];
  m.raceFeats.forEach(f => feats.push([f, "Race"]));
  // `?.` optional chaining: skip the loop quietly if the background has no
  // `feats` list instead of crashing.
  m.background.feats?.forEach(f => feats.push([f, "Background"]));
  m.classes.forEach(c => c.feats.forEach(f => feats.push([f, c.name])));
  m.feats.forEach(f => feats.push([f, "Feat"]));
  // `([f, src]) =>` destructures each pair back into two variables.
  if (feats.length) view.append(section(`Features & feats (${feats.length})`, ...feats.map(([f, src]) => fold(f.name, src, f.text))));
  if (m.notes.length) view.append(section("Notes", ...m.notes.map(n => fold(n.name, "", n.text))));
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
