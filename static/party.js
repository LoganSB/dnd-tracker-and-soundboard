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
//   GET    /api/party/<id>/export.zip[?as=gloan5e]  download one character (the DM: any; a player: their own); plain Fight Club backup unless as=gloan5e
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
  // Two downloads: this character, and ALL of them in one Fight Club backup (the server only includes the characters this user may see: the DM
  // gets every character, a player only the ones assigned to them).
  const isDM = document.body.dataset.role === "dm";
  bar.append(picker, h("button", { className: "btn", onclick: () => Creator.open({ isDM, onCreated: cid => { store("party.last", cid); location.href = "/_/party/" + cid; } }), textContent: "＋ New character" }),
    h("button", { className: "btn", onclick: () => downloadCharacters(`/api/party/${id}/export.zip`, "this character"), textContent: "⬇ Download this character" }),
    h("button", { className: "btn", onclick: () => downloadCharacters("/api/party/export.zip", isDM ? "all characters" : "all your characters"), textContent: isDM ? "⬇ Download all characters" : "⬇ Download all my characters",
      title: "One Fight Club backup file holding " + (isDM ? "every character" : "every character assigned to you") }));
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
  // The counters (hit dice, conditions ...) show at once (Vitals.predict) and are saved in the background, in order; if the server refuses, the sheet goes back
  // to what the server has and the message is shown. A change Vitals.predict does not know (a score, a creature ...) waits for the server's answer instead.
  let saving = Promise.resolve(), unsaved = 0;
  const KNOWN = ["hpCurrent", "slotsCurrent", "inspiration", "hitDice", "trackers", "deaths", "conditions", "classTrackers"];
  const send = async body => {
    const res = await fetch("/api/party/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  };
  const patch = body => {
    if (!Object.keys(body).every(k => KNOWN.includes(k))) {   // wait for the server (and for the saves already on their way)
      return saving.then(() => send(body)).then(u => { Object.assign(m, u); });
    }
    Vitals.predict(m, body);
    unsaved++;
    saving = saving.then(async () => {
      try { const u = await send(body); if (unsaved === 1) Object.assign(m, u); }
      catch (e) { Object.assign(m, await get("/api/party/" + id)); extras?.redraw(); alert(e.message); }
      finally { unsaved--; }
    });
    return Promise.resolve();
  };
  // The Edit character button (editchar.js): the form's changes are saved with one PATCH, then the page loads again with the new numbers.
  // It sits beside the name on the Tracker card (below), which scrolls with the page, not in the toolbar.
  const editButton = () => h("span", { className: "editbtn" },
    h("button", { className: "tiny", textContent: "✎ Edit", title: "Edit character: change the scores, race, class, spell slots and proficiencies",
      onclick: () => EditCharacter.open(m, async changes => { await patch(changes); location.reload(); }) }), " ",
    h("button", { className: "tiny", textContent: "⬆ Level up", title: "Take the next level: hit points, features, spell slots, ability score improvement or feat, multiclass",
      onclick: () => LevelUp.open(m, { onDone: () => extras?.redraw(), onFinish: () => location.reload(), addSpells: () => { try { sessionStorage.setItem("openAddSpell", "1"); } catch (_) { /* just reload */ } location.reload(); } }) }));
  // The Skills and Stats page is rebuilt every time it is opened (the Tracker page may have changed things meanwhile), so it loads the
  // character again first.
  const statsPanel = () => {
    const box = h("div");
    get("/api/party/" + id).then(fresh => { Object.assign(m, fresh); box.replaceChildren(Sheet.stats(m, patch)); })
      .catch(e => box.append(h("p", { className: "bad", textContent: "Error: " + e.message })));
    return box;
  };
  // The Spells page is rebuilt every time it is opened too: its slot pips may have been changed on the Tracker page meanwhile.
  const spellsPanel = () => {
    const box = h("div");
    get("/api/party/" + id).then(fresh => { Object.assign(m, fresh); box.replaceChildren(Sheet.spells(m, addSpell, patch, readySpell)); })
      .catch(e => box.append(h("p", { className: "bad", textContent: "Error: " + e.message })));
    return box;
  };
  // The Tracker page: ONE card holding the live tracker for this character (HP, death saves, spell slots, trackers: `only` limits it to
  // this character, `initiative: false` leaves out the party's Initiative tab, and `conditions` / `inspiration` are left out because the parts
  // below show them) and, under it, hit dice, conditions, statistics, attacks and creatures (sheet.js).
  const trackerPanel = () => {
    const live = h("div", { className: "trackerlist" });
    mountTracker(live, { only: id, initiative: false, conditions: false, inspiration: false, nameExtra: editButton,
      onChange: async () => { try { Object.assign(m, await get("/api/party/" + id)); extras?.redraw(); } catch (_) { /* next change tries again */ } } });
    extras = Sheet.trackerExtras(m, patch, addCompanion);
    return h("section", { className: "card sheetcard" }, live, extras);
  };
  let extras = null;   // the Tracker page's lower part, so the companion pop-up can redraw it

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
      await post("items", Give.itemBody(await api("/api/items/" + encodeURIComponent(row.slug))));
    }, "inv").add;
  };
  // ---- the Inventory page's hooks (sheet.js inventory): every change goes to the server, then the character is loaded again and the Inventory (and
  // the Tracker page's statistics and attacks, which depend on what is worn) are drawn again.
  const ITEM_TYPES = [["15", "Gear / Treasure"], ["5", "Melee Weapon"], ["6", "Ranged Weapon"], ["7", "Ammunition"], ["1", "Light Armor"], ["2", "Medium Armor"], ["3", "Heavy Armor"],
    ["4", "Shield"], ["12", "Potion"], ["13", "Scroll"], ["11", "Ring"], ["14", "Wondrous Item"], ["9", "Staff"], ["10", "Wand"], ["8", "Rod"], ["bag", "Bag / container (2 at most)"]];
  const call = async (method, path, body) => {
    const res = await fetch(`/api/party/${id}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || res.statusText);
    return out;
  };
  // The server's answer to an item change carries the whole character, so the page does not have to ask for it again.
  const changed = async out => { Object.assign(m, out?.character || await get("/api/party/" + id)); extras?.redraw(); sheet.show("inv"); };
  const itemCall = (method, ref, body) => call(method, `items/${ref}`, body).then(changed).catch(e => alert(e.message));
  // A count or coin change shows at once and is saved in the background (in order); a refusal puts the sheet back to what the server has.
  let itemSaves = Promise.resolve();
  const quick = (apply, send) => {
    apply();
    extras?.redraw(); sheet.show("inv");
    itemSaves = itemSaves.then(() => send()).catch(async e => { alert(e.message); await changed(); });
  };
  const addItem = () => Nodes.form({
    title: "Add a custom item", saveLabel: "Add item",
    note: "Adding the same item again raises its count. New items start carried, not worn: use Equip to wear or hold them (and Attune for items that need it).",
    fields: [{ key: "name", label: "Name", placeholder: "e.g. Rope (50 ft)" }, { key: "typeCode", label: "Kind", type: "select", value: "15", options: ITEM_TYPES.map(([value, label]) => ({ value, label })) },
      { key: "quantity", label: "How many", type: "number", min: 1, max: 9999, value: 1 }, { key: "weight", label: "Weight each (lb)", type: "number", min: 0, step: "any", value: 0 },
      { key: "value", label: "Value each (gp)", type: "number", min: 0, step: "any", value: 0 },
      { key: "ac", label: "Armor class (armor and shields)", type: "number", min: 0, max: 30, value: 0 },
      { key: "damage", label: "Damage dice (weapons)", placeholder: "e.g. 1d8" },
      { key: "damageType", label: "Damage type (weapons)", type: "select", value: "", options: [{ value: "", label: "(none)" }, { value: "1", label: "bludgeoning" }, { value: "2", label: "piercing" }, { value: "3", label: "slashing" }] },
      { key: "magic", label: "Magical", type: "checkbox", value: false }, { key: "text", label: "Description", type: "textarea", rows: 4, max: 6000 }],
    save: async v => {
      if (!v.name.trim()) return "Give the item a name";
      let out;
      try { out = await call("POST", "items", v.typeCode === "bag" ? { bag: true, name: v.name.trim(), weight: v.weight, value: v.value, text: v.text } : { ...v, name: v.name.trim() }); } catch (e) { return e.message; }
      await changed(out);
    },
  });
  const giveItem = async i => {
    let who;
    try { who = await api("/api/party/recipients?from=" + encodeURIComponent(id)); } catch (e) { alert(e.message); return; }
    if (!who.length) { Nodes.popup({ title: `Give ${i.name.trim()}`, body: h("p", { className: "muted", textContent: "There is nobody to give it to. You can only give to the other characters in the loaded campaign's party, and only from a character who is in it too." }) }); return; }
    Nodes.form({
      title: `Give ${i.name.trim()}`, saveLabel: "Give",
      note: "It moves to their inventory, highlighted with your name until they acknowledge it. An equipped item has to be unequipped first.",
      fields: [{ key: "to", label: "Give to", type: "select", value: who[0].id, options: who.map(w => ({ value: w.id, label: w.name + (w.owner ? ` (${w.owner})` : "") })) },
        { key: "quantity", label: `How many (you have ${i.quantity})`, type: "number", min: 1, max: i.quantity, value: 1 }],
      save: async v => {
        try { await call("POST", `items/${i.ref}/give`, { to: v.to, quantity: v.quantity || 1 }); } catch (e) { return e.message; }
        await changed();
      },
    });
  };
  const invHooks = {
    addLoot: () => addLoot(), addItem,
    setQty: (i, n) => {
      if (n <= 0) return itemCall("PATCH", i.ref, { quantity: 0 });   // removing an item waits for the server
      const it = [...m.items, ...m.containers.flatMap(c => c.items)].find(x => x.ref === i.ref);
      quick(() => { if (it) it.quantity = n; }, () => call("PATCH", `items/${i.ref}`, { quantity: n }));
    },
    // Equip: armor, shields and weapons go to Fight Club's slots. Anything else is worn as the kind its name says (a "Belt of ...", "Winged Boots"); only
    // when nothing in it says, the wearer is asked where it goes.
    equip: (i, on) => {
      if (!on || i.fcSlot || i.kind) return itemCall("PATCH", i.ref, { equip: on });
      Nodes.form({
        title: `Wear ${i.name.trim()}`, saveLabel: "Wear it",
        note: "Nothing in its name says where it is worn. Pick the place: only one belt, one pair of gloves and so on can be worn at once (up to 10 rings).",
        fields: [{ key: "kind", label: "Worn as", type: "select", value: "neck", options: [["head", "Headwear"], ["neck", "Amulet / necklace"], ["cloak", "Cloak"], ["hands", "Gloves / gauntlets"], ["wrists", "Bracers"], ["belt", "Belt"], ["feet", "Footwear"], ["ring", "Ring"]].map(([value, label]) => ({ value, label })) }],
        save: async v => {
          let out;
          try { out = await call("PATCH", `items/${i.ref}`, { equip: true, kind: v.kind }); } catch (e) { return e.message; }
          await changed(out);
        },
      });
    },
    coin: (coin, delta) => {
      const c = m.items.find(x => x.coin === coin), have = c ? c.quantity : 0;
      if (have + delta < 0) { alert(`Only ${have} ${coin} to spend`); return; }
      if (!c) return call("PATCH", "coins", { coin, delta }).then(changed).catch(e => alert(e.message));   // the first coin of a kind: the server makes the item
      quick(() => { c.quantity = have + delta; }, () => call("PATCH", "coins", { coin, delta }));
    },
    attune: (i, on) => itemCall("PATCH", i.ref, { attune: on }),
    remove: i => { if (confirm(`Remove ${i.quantity > 1 ? i.quantity + "× " : ""}${i.name.trim()} from ${m.name}?`)) itemCall("DELETE", i.ref); },
    give: giveItem,
    ack: g => call("DELETE", `gifts/${g.id}`).then(changed).catch(e => alert(e.message)),
  };
  // Ticking a spell's Ready box shows at once and is saved in the background (a refusal puts the sheet back to what the server has).
  const readySpell = (s, on) => {
    s.prepared = on;
    call("PATCH", `spells/${s.ref}`, { prepared: on }).catch(async e => { alert(e.message); Object.assign(m, await get("/api/party/" + id)); sheet.show("spells"); });
  };
  const addSpell = () => {
    let add;
    const panel = Spells.panel(row => add(row), { compact: true, defaultClass: m.classes[0]?.name });
    add = search("Add spell: search the spells", panel, async row => {
      const f = await Spells.full(row.slug);
      await post("spells", { name: f.name, level: f.level_int, school: f.school, time: f.casting_time, range: f.range, duration: f.duration, components: f.components,
        materials: f.material, ritual: f.can_be_cast_as_ritual === true || f.ritual === "yes", classes: f.dnd_class,
        text: (f.desc || "").replace(/\*\*/g, "") + (f.higher_level ? `\n\nAt higher levels. ${f.higher_level}` : "") });
    }, "spells").add;
  };
  // addCompanion: the monster search in a pop-up. A chosen monster asks what the character calls it (Nodes.form), then party.py writes it as a Fight
  // Club companion plus a creature with the monster's hit points and AC; the Creatures list is redrawn.
  const addCompanion = () => {
    const msg = UI.status();
    const panel = Monsters.panel(row => choose(row), { compact: true });
    const dlg = Nodes.popup({ title: "Add companion: search the monsters", body: h("div", {}, msg, panel.el) });
    const choose = async row => {
      try {
        const f = await Monsters.full(row.slug);
        dlg.close();
        Nodes.form({
          title: `Add ${f.name}`, saveLabel: "Add companion",
          fields: [{ key: "name", label: "Name", value: f.name, placeholder: "What does the character call it?" }],
          save: async v => {
            try {
              await post("companions", { name: v.name.trim() || f.name, kind: f.name, size: f.size, hd: f.hit_dice, hp: f.hit_points, ac: f.armor_class, speed: f.speed?.walk,
                abilities: [f.strength, f.dexterity, f.constitution, f.intelligence, f.wisdom, f.charisma] });
              Object.assign(m, await get("/api/party/" + id));
              extras?.redraw();
            } catch (e) { return e.message; }
          },
        });
      } catch (e) { msg.say(e.message, true); }
    };
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

  // ✎ on any row of the Feats, Features and Notes page: a note, a feat, a class, race or background feature (PATCH .../features/<ref>).
  const editFeature = f => Nodes.form({
    title: `Edit ${f.source === "Note" ? "note" : f.source.toLowerCase() === "feat" ? "feat" : "feature"}`, saveLabel: "Save",
    fields: [{ key: "name", label: "Title", value: f.name }, { key: "text", label: "Text", type: "textarea", rows: 10, max: 8000, value: f.text || "" }],
    save: async v => {
      if (!v.name.trim()) return "Give it a title";
      try { await call("PATCH", `features/${f.ref}`, { name: v.name.trim(), text: v.text }); } catch (e) { return e.message; }
      await refresh("feats");
    },
  });

  // The five sub-menu pages. Inventory, Spells and Feats are rebuilt every time they are shown (an Add may have changed them).
  const counts = () => Sheet.counts(m);
  const sheet = UI.tabs({ key: "sheet", first: "tracker", tabs: [
    { id: "tracker", label: "Tracker", render: trackerPanel },
    { id: "stats", label: "Skills and Stats", render: statsPanel, fresh: true },
    { id: "inv", label: () => `Inventory (${counts().items})`, render: () => Sheet.inventory(m, invHooks), fresh: true },
    { id: "spells", label: () => `Spells (${counts().spells})`, render: spellsPanel, fresh: true },
    { id: "feats", label: () => `Feats, Features and Notes (${counts().features})`, render: () => Sheet.features(m, addNote, editFeature), fresh: true },
  ] });
  view.append(sheet.el);
  try { if (sessionStorage.getItem("openAddSpell")) { sessionStorage.removeItem("openAddSpell"); sheet.show("spells"); addSpell(); } } catch (_) { /* no storage */ }   // after a level-up: straight to learning the new spells
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
