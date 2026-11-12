"use strict";
// =============================================================================
// campaign.js - the Campaign Tracker page
// =============================================================================
//
// WHAT THIS PROGRAM IS
//   A board for tracking what the party has achieved or triggered in a campaign. It is laid out
//   exactly like the soundboard (sections that hold tiles, tiles that hold optional subsections),
//   but the clickable items are "flags" instead of sounds. Like app.js, this file runs inside the
//   browser: it registers callbacks and the browser calls them on clicks, drags and timers.
//   (See the header of app.js for a primer on the JavaScript constructs used here.)
//   Like the soundboard it lives on an infinite pan-and-zoom canvas (canvas.js), and it uses the same
//   layout code: the FLAGS are free-floating cards, each at its own x, y; tiles, subsections and sections are
//   FRAMES drawn around the cards that belong to them (they stretch and shrink as you move cards).
//
// THE DATA MODEL  (all of it lives in S.campaign, saved with the sounds)
//
//   S.campaign = {
//     sections: [ { id, name, collapsed? } ],
//     tiles: [ {
//        id, name, section,                       // section = id of the section that holds this tile
//        x, y,                                    // only used while the tile has no flags (the place of its empty frame)
//        subs: [ { id, name } ],                  // optional named subsections inside the tile
//        items: [ {                               // the flags on this tile
//           id, name,
//           group,                                // id of the subsection it is in (absent = top of the tile)
//           x, y,                                 // position of the card on the canvas (world pixels)
//           triggered, triggeredAt,               // the flag itself: has the party done/triggered this? (+ when)
//           maxWidth,                             // the tile may grow this wide (px) before its text wraps
//           sound,                                // optional id of a SOUNDBOARD sound played when triggered
//           notes,                                // free text, shown when you hover the tile
//           checklist: [ { id, text, done } ],    // optional checklist; the tile grows to fit it
//           loot: { entries: [ { id, name, weight, note } ],   // the reward table (weighted)
//                   log: [ { text, at } ] }                    // history of rolls, newest first
//        } ]
//     } ]
//   }
//
//   S.campaign.links = [ { id, from, to } ]    // cables between ANY two items (see "campaign links" below).
//     `from` and `to` are item keys: "sec:<id>" (a section), "tile:<id>", "sub:<tileId>:<id>" (a
//     subsection), "flag:<id>", "chk:<id>" (one checklist entry) or "loot:<flagId>" (a flag's loot table).
//     An item can have any number of links in and out.
//
//   S as a whole is the same state object the soundboard uses ({ tiles: [...sounds...], campaign }).
//   We load all of it (we need the sound names for the "play sound" menu) but only ever SAVE the
//   campaign part, through PUT /api/campaign, so this page can never overwrite the sounds.
//
// HOW THE PIECES FIT
//   render() rebuilds the whole board from S.campaign (the same "state -> screen" idea as the
//   soundboard). Event handlers change S.campaign and then call save() and render().
//   save() sends the campaign to the server (debounced). A poller (pollState) notices when the
//   server's state changed from somewhere else (another window, a preset load) and reloads.
//
// PLAYING SOUNDS FROM HERE
//   The audio engine lives on the soundboard page. When a flag with a linked sound is triggered, this
//   page sends a message to the soundboard through a BroadcastChannel, a browser feature that lets
//   pages of the same site talk to each other. The soundboard page must be open (in another tab or
//   window) for the sound to be heard.

// ---------------------------------------------------------------- helpers
// $(selector): first element matching a CSS selector.
const $ = (s, r = document) => r.querySelector(s);
// el(tag, props, ...kids): create a DOM element, copy `props` onto it (Object.assign), append the
// children. NB: never pass undefined/false as a child (append would print the word).
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  kids.forEach(k => n.append(k));
  return n;
};
// uid(): a short random id such as "k3j9x0ab" (random number in base 36, skipping the "0.").
const uid = () => Math.random().toString(36).slice(2, 10);
// api(url, method, body): fetch JSON from the server; rejects with the server's error message.
const api = async (url, method = "GET", body) => {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

// ----------------------------------------------------------------- state
// S: everything the server has (sounds + campaign). myRevision: the server's revision number as of
// our last load/save; if the server reports a different one, someone else changed the state.
let S = { tiles: [], campaign: null },
  myRevision = -1;

// C(): shorthand for the campaign data, S.campaign.
const C = () => S.campaign;

// normalize(): make sure S.campaign exists and every object has the fields the code expects. Older
// saves (or a brand-new install) have no campaign at all, so we start with one section and one tile.
function normalize() {
  S.tiles ||= [];
  S.campaign ||= {};
  const c = S.campaign;
  c.sections ||= [];
  c.tiles ||= [];
  c.links ||= [];
  if (!c.sections.length) c.sections.push({ id: uid(), name: "Main story" });
  if (!c.tiles.length) c.tiles.push({ id: uid(), name: "Chapter 1", section: c.sections[0].id, subs: [], items: [] });
  c.tiles.forEach(t => {
    if (!c.sections.some(s => s.id === t.section)) t.section = c.sections[0].id;   // orphaned tile -> first section
    t.subs ||= [];
    t.items ||= [];
    t.w ||= 400;   // (older saves: the tile's old width, used only to convert its flags to free positions)
    t.items.forEach(i => {
      i.checklist ||= [];
      i.loot ||= { entries: [], log: [] };
      i.loot.entries ||= [];
      i.loot.log ||= [];
    });
  });
  // Tiles with no canvas position yet are laid out in a spiral around the middle of the canvas.
  Canvas.layoutMissing(c.tiles, c.sections);
  // Flags from older saves have no position of their own (they sat in rows inside their tile): put them in a
  // tidy grid where their tile used to be, loose ones first, then each subsection's. Flags that already have
  // x, y are never touched.
  c.tiles.forEach(t => {
    const missing = t.items.filter(i => !Number.isFinite(i.x) || !Number.isFinite(i.y));
    if (!missing.length) return;
    // Some cards already have places (a card was added from outside this page, for example an encounter put on the
    // tracker from the Encounters tab): give only the new ones a free spot next to their tile's other cards.
    if (missing.length < t.items.length) {
      const box = i => ({ l: i.x, t: i.y, r: i.x + 260, b: i.y + 150 });
      const placed = c.tiles.flatMap(o => o.items).filter(i => Number.isFinite(i.x) && Number.isFinite(i.y));
      missing.forEach(i => {
        const near = t.items.filter(o => Number.isFinite(o.x) && Number.isFinite(o.y)).map(box);
        Object.assign(i, Canvas.freeSpot(placed.map(box), 240, 130, near));
        placed.push(i);
      });
      return;
    }
    const subIds = new Set(t.subs.map(x => x.id));
    const groups = [t.items.filter(i => !i.group || !subIds.has(i.group)), ...t.subs.map(x => t.items.filter(i => i.group === x.id))];
    Canvas.arrangeInGrid(t, groups, 250, 150);
  });
}

// allItems(): every flag on every tile as one flat array (flatMap = map, then flatten one level).
const allItems = () => C().tiles.flatMap(t => t.items);
// locate(id): find a flag by id. Returns { tile, item, i } (i = its index in the tile) or null.
function locate(id) {
  for (const tile of C().tiles) {
    const i = tile.items.findIndex(x => x.id === id);
    if (i >= 0) return { tile, item: tile.items[i], i };
  }
  return null;
}

// ------------------------------------------------------------ persistence
// saveTimer: handle of the pending delayed save (null = nothing pending).
let saveTimer = null;
// save(): store the campaign on the server. Debounced: every call restarts a 300 ms countdown, so
// a burst of edits (ticking several boxes) becomes one request. The server's reply carries the new
// revision number, which we remember so pollState does not mistake our own save for an outside change.
function save() {
  $("#saveState").textContent = "saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const r = await api("/api/campaign", "PUT", { campaign: C() });
      myRevision = r.revision;
      $("#saveState").textContent = "saved";
    } catch (e) {
      $("#saveState").textContent = "SAVE FAILED";
    }
  }, 300);
}

// pollState(): runs every 5 seconds. If the server's state has a different revision from ours
// (another window saved, or a preset/version was loaded on the soundboard page), reload it and
// redraw. It stays out of the way while we have an unsaved edit, a dialog open or a drag going.
async function pollState() {
  if (saveTimer || drag || document.querySelector("dialog[open]")) return;
  try {
    const st = await api("/api/state");
    if (st.revision === myRevision) return;
    S = st;
    myRevision = st.revision;
    normalize();
    render();
  } catch (_) { /* server restarting: try again next time */ }
}

// -------------------------------------------------------- sounds from here
// The soundboard page listens on this channel (see the end of app.js) and plays the sound whose
// id it is sent. `new BroadcastChannel(name)` connects to every page of this site using that name.
let channel = null;
try { channel = new BroadcastChannel("dm-soundboard"); } catch (_) { /* very old browser: sounds just will not play from here */ }

// jumpToSound(soundId): ask the app shell to switch to the Soundboard tab and centre its canvas on that
// sound (and flash it). The shell passes the request on (see "goto" in shell.html, revealSound in app.js).
function jumpToSound(soundId) {
  window.parent.postMessage({ type: "goto", page: "sound", sound: soundId }, location.origin);
}

// playLinked(item): ask the soundboard to play the sound linked to this flag or checklist entry (if any).
function playLinked(item) {
  if (item.sound && channel) channel.postMessage({ type: "play", id: item.sound });
}
// soundChoices(): the soundboard's sounds as { id, label } pairs for the menu ("Tile › Sound name").
const soundChoices = () => S.tiles.flatMap(t => t.sounds.map(s => ({ id: s.id, label: `${t.name} › ${s.name}` })));

// ----------------------------------------------------------- moving things
// Flags and frames are moved with the pointer by canvas.js (Canvas.dragItems), the same code the
// soundboard uses. There is no HTML5 drag-and-drop here any more.

// drag: non-null while a card, a frame or a new link is being dragged ({ kind }). render() is postponed
// while it is set, because rebuilding the page would destroy the element being dragged.
// pendingRender: set when a render() was requested during a drag and postponed.
let drag = null,
  pendingRender = false;

// moveTile(id, sectionId): put a tile into a section (used by the Tile settings dialog and when a tile's
// frame is dropped inside another section's frame). Only the `section` field changes; frames follow the cards.
function moveTile(id, sectionId) {
  const t = C().tiles.find(x => x.id === id);
  if (t) t.section = sectionId;
}

// ---------------------------------------------------------------- render
// Frames (sectionFrame, tileFrame, subFrame) are drawn behind the flag cards (flagEl); see canvas.js.

// timeText(ms): "Mar 3, 8:15 PM" style text for a timestamp (toLocaleString formats for the user's locale).
const timeText = ms => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// flagEl(item, tile): build the card for one flag.
//   - Click anywhere on it (except the small controls) to trigger / un-trigger the flag. Triggering
//     stamps the time and plays the linked sound, if there is one.
//   - Its checklist is shown inside; ticking a box saves immediately. The card is as narrow as its
//     content allows and grows (up to its own max width) as checklist text gets longer; past that the
//     text wraps and the card grows taller instead. The width limit is the --maxw CSS variable.
//   - Buttons: 🔊 plays the linked sound again, 🎁 opens the reward popup, ⚙ edits the flag.
function flagEl(item, tile) {
  if (item.encounter) return encounterEl(item, tile);
  const total = item.checklist.length,
    ticked = item.checklist.filter(c => c.done).length;
  const cls = ["flag", item.triggered ? "done" : "", total && ticked === total ? "complete" : ""];
  const card = el("div", { className: cls.filter(Boolean).join(" "), role: "button", tabIndex: 0 });
  card.dataset.id = item.id;
  card.dataset.iid = item.id;   // the canvas code finds cards by this attribute
  // Which section / tile / subsection the card belongs to (used by the "snap only to the same ..." option).
  card.dataset.sec = tile.section;
  card.dataset.tile = tile.id;
  card.dataset.sub = tile.id + ":" + (item.group || "");
  // Place the card on the canvas (world coordinates); hidden while its section is collapsed.
  card.style.left = item.x + "px";
  card.style.top = item.y + "px";
  if (C().sections.find(x => x.id === tile.section)?.collapsed) card.style.display = "none";
  card.style.setProperty("--maxw", (item.maxWidth || 320) + "px");   // read by the .flag CSS rule
  card.title = [item.notes, item.triggered ? "Triggered " + timeText(item.triggeredAt || Date.now()) : "Not triggered yet. Click to trigger."]
    .filter(Boolean).join("\n");

  // Title row: a status mark, the name, and the small buttons.
  const lootCount = item.loot.entries.length;
  const title = el("div", { className: "ftitle" },
    el("span", { className: "fmark", textContent: item.triggered ? "✔" : "○" }),
    el("span", { className: "fname", textContent: item.name }),
    el("span", { className: "ftools" },
      // 🎯: jump to the linked sound on the soundboard (switches to that tab and centres the canvas on it).
      item.sound ? el("button", { className: "tiny", textContent: "🎯", title: "Jump to the linked sound on the soundboard", onclick: ev => { ev.stopPropagation(); jumpToSound(item.sound); } }) : "",
      el("button", { className: "tiny lootbtn", textContent: "🎁" + (lootCount ? " " + lootCount : ""), title: "Rewards / loot table",
        onclick: ev => { ev.stopPropagation(); openLoot(item); } }),
      el("button", { className: "tiny gear", textContent: "⚙", title: "Edit flag", onclick: ev => { ev.stopPropagation(); openFlagDlg(item, tile.id); } }),
      // Delete this flag (asks first). Links to it, to its checklist entries and to its loot table are removed by pruneLinks().
      el("button", { className: "tiny fdel", textContent: "🗑", title: "Delete this flag", onclick: ev => {
        ev.stopPropagation();
        if (!confirm(`Delete flag "${item.name}"?`)) return;
        const loc = locate(item.id);
        if (loc) loc.tile.items.splice(loc.i, 1);
        save();
        render();
      } })));
  card.append(title);
  addPorts(card, "flag:" + item.id);
  // The loot button is itself linkable (the flag's reward table).
  addPorts(title.querySelector(".lootbtn"), "loot:" + item.id, true);

  // Checklist: one row per entry, a real checkbox plus its text. The label wraps long text.
  if (total) {
    const list = el("ul", { className: "checks" });
    item.checklist.forEach(c => {
      const box = el("input", { type: "checkbox", checked: !!c.done });
      // change: fires when the box is toggled. stopPropagation (on click too) so it does not also trigger the flag.
      // Ticking an entry that has a linked sound plays it (the same as triggering a flag that has one).
      box.onchange = () => { c.done = box.checked; if (c.done) playLinked(c); save(); render(); };
      box.onclick = ev => ev.stopPropagation();
      const label = el("label", { className: c.done ? "ckdone" : "" }, box, el("span", { textContent: c.text }));
      label.onclick = ev => ev.stopPropagation();
      const row = el("li", {}, label);
      // A checklist entry can have a linked sound too: 🎯 jumps to it on the soundboard, like on a flag.
      if (c.sound) row.append(el("button", { className: "tiny jumpbtn", textContent: "🎯", title: "Jump to the linked sound on the soundboard",
        onclick: ev => { ev.stopPropagation(); jumpToSound(c.sound); } }));
      addPorts(row, "chk:" + c.id, true);   // every checklist entry can be linked too (small ports, shown on hover)
      list.append(row);
    });
    // A thin progress bar under the list: width = fraction ticked.
    card.append(list, el("div", { className: "fprog" }, el("div", { style: `width:${(ticked / total) * 100}%` })));
  }

  // The drag bar along the top (same as on the soundboard's cards): press and move to drag the card.
  const bar = el("div", { className: "dragbar", textContent: "⠿⠿⠿", title: "Drag to move this flag" });
  bar.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    Canvas.dragItems(ev, [{ obj: item, el: card }], dragHooks(() => adoptFlag(item)));   // after the drop it may belong to another tile / subsection
  });
  card.prepend(bar);
  if (total) card.append(el("div", { className: "ffoot" }, el("span", { className: "muted", textContent: `${ticked}/${total}` })));

  // Click = toggle the flag. Ignore clicks that began on the small controls (their own handlers ran).
  card.addEventListener("click", ev => {
    if (ev.target.closest(".ftools,.dragbar,.checks,.lp")) return;
    item.triggered = !item.triggered;
    item.triggeredAt = item.triggered ? Date.now() : undefined;
    if (item.triggered) playLinked(item);
    save();
    render();
  });
  card.addEventListener("keydown", ev => { if (ev.key === "Enter" && ev.target === card) card.click(); });
  return card;
}


// ------------------------------------------------------------ encounter tiles
// An ENCOUNTER card is a flag-like card that points at an encounter from the Encounters tab (item.encounter = its id;
// the encounter itself lives in S.encounters, saved with the campaign). Clicking the card ADDS the encounter to the
// initiative tracker (monsters rolled, party added if missing). Buttons: 🆕 start a new combat with it instead,
// 📤 add it and pop out the tracker window, ⚙ open it in the Encounters tab, 🗑 take the card off the board.
const encounterOf = item => (S.encounters || []).find(e => e.id === item.encounter);
const POPOUT = ["/tracker", "dmtracker", "width=460,height=720"];

// loadEncounter(item, mode, popout): ask the server to put the encounter into the initiative order. The pop-out
// window is opened first (a pop-up must start from the click), then refreshed once the order is saved.
async function loadEncounter(item, mode, popout) {
  const w = popout ? window.open(...POPOUT) : null;
  try {
    await api(`/api/encounters/${item.encounter}/load`, "POST", { mode });
    item.triggered = true;
    item.triggeredAt = Date.now();
    save();
    render();
    try { w?.location.reload(); } catch (_) { /* the window was closed */ }
  } catch (e) { alert(e.message); }
}

function encounterEl(item, tile) {
  const enc = encounterOf(item);
  if (enc) item.name = enc.name;   // keep the name the links and menus use in step (saved with the next save)
  const card = el("div", { className: "flag encounter" + (item.triggered ? " done" : ""), role: "button", tabIndex: 0 });
  card.dataset.id = item.id;
  card.dataset.iid = item.id;
  card.dataset.sec = tile.section;
  card.dataset.tile = tile.id;
  card.dataset.sub = tile.id + ":" + (item.group || "");
  card.style.left = item.x + "px";
  card.style.top = item.y + "px";
  if (C().sections.find(x => x.id === tile.section)?.collapsed) card.style.display = "none";
  card.style.setProperty("--maxw", (item.maxWidth || 320) + "px");
  card.title = enc ? "Click to add this encounter to the initiative tracker" : "This encounter was deleted from the Encounters tab";
  const lines = enc ? enc.monsters.map(m => `${m.count}× ${m.name}`) : [];
  const xp = enc ? enc.monsters.reduce((s, m) => s + (m.xp || 0) * m.count, 0) : 0;
  const title = el("div", { className: "ftitle" },
    el("span", { className: "fmark", textContent: "⚔" }),
    el("span", { className: "fname", textContent: enc ? enc.name : "(deleted encounter)" }),
    el("span", { className: "ftools" },
      enc ? el("button", { className: "tiny", textContent: "🆕", title: "Start a NEW combat with this encounter", onclick: ev => { ev.stopPropagation(); loadEncounter(item, "replace", false); } }) : "",
      enc ? el("button", { className: "tiny", textContent: "📤", title: "Add to the initiative tracker and pop it out", onclick: ev => { ev.stopPropagation(); loadEncounter(item, "append", true); } }) : "",
      enc ? el("button", { className: "tiny gear", textContent: "⚙", title: "Edit in the Encounters tab", onclick: ev => {
        ev.stopPropagation();
        window.parent.postMessage({ type: "goto", page: "encounters", path: "/_/encounters?id=" + enc.id }, location.origin);
      } }) : "",
      el("button", { className: "tiny fdel", textContent: "🗑", title: "Take this card off the board (the encounter stays in the Encounters tab)", onclick: ev => {
        ev.stopPropagation();
        const loc = locate(item.id);
        if (loc) loc.tile.items.splice(loc.i, 1);
        save();
        render();
      } })));
  card.append(title);
  addPorts(card, "flag:" + item.id);
  card.append(el("ul", { className: "emons" }, ...(lines.length ? lines.map(t => el("li", { textContent: t })) : [el("li", { className: "muted", textContent: enc ? "No monsters yet" : "" })])),
    el("div", { className: "ffoot" }, el("span", { className: "muted", textContent: [enc ? `${xp.toLocaleString()} XP` : "", item.triggered ? "Loaded " + timeText(item.triggeredAt || Date.now()) : ""].filter(Boolean).join(" · ") })));
  const bar = el("div", { className: "dragbar", textContent: "⠿⠿⠿", title: "Drag to move this card" });
  bar.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    Canvas.dragItems(ev, [{ obj: item, el: card }], dragHooks(() => adoptFlag(item)));
  });
  card.prepend(bar);
  card.addEventListener("click", ev => {
    if (ev.target.closest(".ftools,.dragbar,.lp") || !enc) return;
    loadEncounter(item, "append", false);
  });
  card.addEventListener("keydown", ev => { if (ev.key === "Enter" && ev.target === card) card.click(); });
  return card;
}

// frames: the latest rectangles of all frames ({ frameId: { l, t, r, b } }, world coordinates).
let frames = {};

// frameModel(exceptFlagId, exceptTileId): describes the nesting for Canvas.layoutFrames: sections
// containing tiles containing flags and subsections. The optional arguments leave one flag (or one whole tile)
// out, to answer "where would the frames be without it?" when something is dropped.
function frameModel(exceptFlag = null, exceptTile = null) {
  const cards = (t, test) => t.items.filter(i => i.id !== exceptFlag && test(i));
  return {
    sections: C().sections.map(sec => ({
      id: sec.id,
      obj: sec,
      collapsed: !!sec.collapsed,
      tiles: C().tiles.filter(t => t.section === sec.id && t.id !== exceptTile).map(t => {
        const subIds = new Set(t.subs.map(x => x.id));   // a flag whose group is missing/unknown counts as "loose"
        return {
          id: t.id,
          obj: t,
          items: cards(t, i => !i.group || !subIds.has(i.group)),
          subs: t.subs.map(x => ({ id: x.id, obj: x, items: cards(t, i => i.group === x.id) }))
        };
      })
    }))
  };
}
// relayout(): re-fit every frame around its flags (cheap; called after any move or size change).
function relayout() { frames = Canvas.layoutFrames(frameModel()); }

// cardEl(item): the page element of a flag card.  cardsOf(items): the { obj, el } list Canvas.dragItems wants.
const cardEl = item => document.querySelector(`.flag[data-iid="${item.id}"]`);
const cardsOf = items => items.map(i => ({ obj: i, el: cardEl(i) }));

// dragHooks(after): the hooks passed to Canvas.dragItems for every drag on this page. While dragging, `drag`
// blocks render() and the frames and links are re-fitted on every step. When the drag ends, `after()` runs
// (it decides what the drop means), then everything is saved and redrawn.
function dragHooks(after) {
  return {
    onStart: () => { drag = { kind: "node" }; },
    onMove: () => { relayout(); scheduleDraw(); },
    onEnd: moved => {
      drag = null;
      if (moved) { after?.(); save(); }
      render(true);
    }
  };
}

// adoptFlag(item): after a flag is dropped, decide which tile (and subsection) it belongs to NOW. The frames
// are computed WITHOUT this flag (otherwise its own frame would have stretched to cover it wherever it was
// dropped); if the flag's centre is inside another tile's or subsection's frame it joins that one. Dropped
// inside its own tile but outside any subsection frame it becomes a "loose" flag; dropped in empty space it
// stays where it was (membership unchanged).
function adoptFlag(item) {
  const loc = locate(item.id),
    card = cardEl(item);
  if (!loc || !card) return;
  const rects = Canvas.layoutFrames(frameModel(item.id), true),   // true = just compute, change nothing
    fid = Canvas.frameAt(rects, item.x + card.offsetWidth / 2, item.y + card.offsetHeight / 2);
  if (!fid || fid.startsWith("sec:")) return;
  const [kind, tileId, subId] = fid.split(":");
  const dest = C().tiles.find(t => t.id === tileId);
  if (!dest) return;
  if (dest !== loc.tile) {
    loc.tile.items.splice(loc.i, 1);
    dest.items.push(item);
  }
  item.group = kind === "sub" ? subId : undefined;
}

// adoptTile(tile): after a tile's frame is dragged, if its centre is inside ANOTHER section's frame the tile joins that section.
function adoptTile(tile) {
  const mine = frames[`tile:${tile.id}`];
  if (!mine) return;
  const rects = Canvas.layoutFrames(frameModel(null, tile.id), true),
    cx = (mine.l + mine.r) / 2,
    cy = (mine.t + mine.b) / 2;
  for (const sec of C().sections) {
    const r = rects[`sec:${sec.id}`];
    if (sec.id !== tile.section && r && cx > r.l && cx < r.r && cy > r.t && cy < r.b) { tile.section = sec.id; return; }
  }
}

// placeFlag(item, tile): choose a free canvas position for a flag being added to `tile`: the nearest free
// spot to that tile's other flags (or to its empty frame); flags of other tiles are bigger obstacles.
function placeFlag(item, tile) {
  const mine = new Set(tile.items.filter(i => i !== item).map(i => i.id)),
    rects = Canvas.itemRects(new Set([item.id])),
    grow = (r, m) => ({ l: r.l - m, t: r.t - m, r: r.r + m, b: r.b + m });
  const obstacles = rects.map(r => (mine.has(r.id) ? r : grow(r, 70)));
  Object.entries(frames).forEach(([fid, r]) => { if (fid.startsWith("tile:") && fid !== `tile:${tile.id}`) obstacles.push(grow(r, 20)); });
  const near = rects.filter(r => mine.has(r.id)),
    own = frames[`tile:${tile.id}`];
  Object.assign(item, Canvas.freeSpot(obstacles, 240, 130, near.length ? near : own ? [own] : []));
}

// frameEl(level, fid, hue, key, head, getItems, after): builds the shell of a frame: a <div class="frame f-LEVEL">
// with its id, a header holding the `head` elements, and (when `key` is given) link ports so the frame itself can
// be linked to other items. Dragging the header moves everything inside: `getItems()` returns the { obj, el } list.
function frameEl(level, fid, hue, key, head, getItems, after) {
  const frame = el("div", { className: `frame f-${level}` });
  frame.dataset.fid = fid;
  frame.style.setProperty("--gh", hue);
  const header = el("header", {}, ...head);
  frame.append(header);
  if (key) addPorts(frame, key);
  header.addEventListener("pointerdown", ev => {
    if (ev.button !== 0 || ev.target.closest("button,input,select,a")) return;
    Canvas.dragItems(ev, getItems(), dragHooks(after));
  });
  return frame;
}

// sectionFrame(sec): the outermost frame: title bar with collapse arrow, name and tools (add tile, rename,
// delete). Dragging the title bar moves the whole section.
function sectionFrame(sec) {
  const tiles = C().tiles.filter(t => t.section === sec.id),
    all = () => tiles.flatMap(t => t.items);
  const hue = (C().sections.indexOf(sec) * 137.5 + 260) % 360;   // golden-angle steps give each section its own colour
  const head = [
    el("button", { className: "tiny", textContent: sec.collapsed ? "▸" : "▾", title: "Collapse / expand",
      onclick: () => { sec.collapsed = !sec.collapsed; save(); render(); } }),
    el("h2", { textContent: sec.name }),
    el("span", { className: "tools" },
      el("button", { textContent: "+ Tile", onclick: () => addTile(sec.id) }),
      el("button", { textContent: "✎", title: "Rename section", onclick: () => {
        const n = prompt("Section name", sec.name);
        if (n) { sec.name = n; save(); render(); }
      } }),
      el("button", { textContent: "🗑", title: "Delete section", onclick: () => {
        if (C().sections.length < 2) return alert("Keep at least one section.");
        const dest = C().sections.find(s => s !== sec);
        if (tiles.length && !confirm(`Delete section "${sec.name}"? Its ${tiles.length} tile(s) move to "${dest.name}".`)) return;
        tiles.forEach(t => (t.section = dest.id));
        C().sections = C().sections.filter(s => s !== sec);
        save();
        render();
      } }))
  ];
  return frameEl("sec", `sec:${sec.id}`, hue, "sec:" + sec.id, head,
    () => (all().length ? cardsOf(all()) : [{ obj: sec, el: document.querySelector(`.frame[data-fid="sec:${sec.id}"]`) }]));
}

// tileFrame(tile): the frame around one tile's flags and subsections: title bar with the tile's name, how many
// flags are triggered, and tools (add flag, settings, delete). Dragging it moves the tile's flags; dropping it
// inside another section's frame moves the tile to that section.
function tileFrame(tile) {
  const triggered = tile.items.filter(i => i.triggered).length;
  const head = [
    el("h2", { textContent: tile.name }),
    el("span", { className: "muted", textContent: tile.items.length ? `${triggered}/${tile.items.length} triggered` : "" }),
    el("span", { className: "tools" },
      el("button", { textContent: "+", title: "Add a flag here", onclick: () => openFlagDlg(null, tile.id) }),
      el("button", { textContent: "⚙", title: "Tile settings (rename, subsections)", onclick: () => openTileDlg(tile) }),
      el("button", { textContent: "🗑", title: "Delete tile", onclick: () => {
        if (confirm(`Delete tile "${tile.name}" and its ${tile.items.length} flags?`)) {
          C().tiles = C().tiles.filter(t => t !== tile);
          save();
          render();
        }
      } }))
  ];
  const hue = (C().sections.findIndex(x => x.id === tile.section) * 137.5 + 260) % 360;
  return frameEl("tile", `tile:${tile.id}`, hue, "tile:" + tile.id, head,
    () => (tile.items.length ? cardsOf(tile.items) : [{ obj: tile, el: document.querySelector(`.frame[data-fid="tile:${tile.id}"]`) }]),
    () => adoptTile(tile));
}

// subFrame(tile, sub): the frame around one subsection's flags: its name and tools (add flag, rename, delete).
function subFrame(tile, sub) {
  const mine = tile.items.filter(i => i.group === sub.id);
  const head = [
    el("h3", { textContent: sub.name }),
    el("span", { className: "tools" },
      el("button", { textContent: "+", title: "Add a flag to this subsection", onclick: () => openFlagDlg(null, tile.id, sub.id) }),
      el("button", { textContent: "✎", title: "Rename", onclick: () => {
        const n = prompt("Subsection name", sub.name);
        if (n) { sub.name = n; save(); render(); }
      } }),
      el("button", { textContent: "🗑", title: "Delete subsection (flags stay in the tile)", onclick: () => {
        tile.subs = tile.subs.filter(x => x !== sub);
        tile.items.forEach(i => { if (i.group === sub.id) delete i.group; });
        save();
        render();
      } }))
  ];
  return frameEl("sub", `sub:${tile.id}:${sub.id}`, 260, `sub:${tile.id}:${sub.id}`, head,
    () => (mine.length ? cardsOf(mine) : [{ obj: sub, el: document.querySelector(`.frame[data-fid="sub:${tile.id}:${sub.id}"]`) }]));
}

// addTile(sectionId): ask for a name and add an empty tile to that section (or the first one). Its (empty)
// frame goes in the free spot nearest to that section's other frames.
function addTile(sectionId) {
  const name = prompt("New tile name (e.g. 'The Sunken Temple')");
  if (!name) return;
  const sec = sectionId || C().sections[0].id;
  const tile = { id: uid(), name, section: sec, subs: [], items: [] };
  const grow = (r, m) => ({ l: r.l - m, t: r.t - m, r: r.r + m, b: r.b + m });
  const obstacles = Object.entries(frames).filter(([fid]) => fid.startsWith("tile:")).map(([, r]) => grow(r, 24));
  const near = C().tiles.filter(t => t.section === sec).map(t => frames[`tile:${t.id}`]).filter(Boolean);
  Object.assign(tile, Canvas.freeSpot(obstacles, 320, 100, near));
  C().tiles.push(tile);
  save();
  render();
}

// render(force): rebuild the whole board from S.campaign. Postponed during a drag (see `drag`).
function render(force = false) {
  if (!force && drag) { pendingRender = true; return; }   // never rebuild mid-drag (a card or frame being moved counts too)
  pendingRender = false;
  pruneLinks();   // forget links whose items were deleted, before anything uses them
  const root = $("#tiles");
  root.textContent = "";
  // Frames first (behind): sections, tiles, subsections; then every flag card; then fit the frames to the cards.
  C().sections.forEach(sec => root.append(sectionFrame(sec)));
  C().tiles.forEach(t => root.append(tileFrame(t)));
  C().tiles.forEach(t => t.subs.forEach(sub => root.append(subFrame(t, sub))));
  C().tiles.forEach(t => t.items.forEach(i => root.append(flagEl(i, t))));
  relayout();
  markLinked();   // lit-up ports and "locked" styling from the links
  // Watch every flag's size: when one grows or shrinks (a checklist item was added, text wrapped) the frames
  // and links must follow.
  cardObserver.disconnect();
  document.querySelectorAll(".flag").forEach(n => cardObserver.observe(n));
  scheduleDraw();
}
// cardObserver: a ResizeObserver (calls back when an observed element changes size). Re-fits the frames
// and redraws the links.
const cardObserver = new ResizeObserver(() => {
  relayout();
  scheduleDraw();
});

// ------------------------------------------------------------ flag dialog
// Add or edit one flag. The checklist is edited on a COPY (draftChecks) and only written to the flag
// when Save is pressed, so Cancel discards the changes.
const fdlg = $("#flagDlg"),
  fform = $("#flagForm");
// editingFlag: the flag being edited (null = adding a new one). draftChecks: working copy of its
// checklist, each { id, text, done, del? } (del = marked for removal).
let editingFlag = null,
  draftChecks = [];
document.querySelectorAll("[data-close]").forEach(b => (b.onclick = () => b.closest("dialog").close()));
fdlg.addEventListener("close", () => { newAt = null; });

// fillGroups(tileId, selected): fill the Subsection menu with the chosen tile's subsections.
function fillGroups(tileId, selected) {
  const tile = C().tiles.find(t => t.id === tileId);
  fform.group.textContent = "";
  fform.group.append(el("option", { value: "", textContent: "(none)" }));
  (tile?.subs || []).forEach(s => fform.group.append(el("option", { value: s.id, textContent: s.name })));
  fform.group.value = selected || "";
}
// Choosing a different tile in the dialog changes which subsections are offered.
fform.tile.addEventListener("change", () => fillGroups(fform.tile.value, ""));

// drawChecks(): redraw the checklist editor rows from draftChecks (skipping the ones marked deleted).
function drawChecks() {
  const box = $("#checkList");
  box.textContent = "";
  draftChecks.filter(x => !x.del).forEach(x => {
    const inp = el("input", { value: x.text });
    inp.oninput = () => (x.text = inp.value);
    // Optional soundboard sound for this entry (played when ticked; 🎯 on the entry jumps to it).
    const sel = el("select", { className: "cksound", title: "Optional soundboard sound linked to this entry" });
    sel.append(el("option", { value: "", textContent: "🎯 no sound" }));
    soundChoices().forEach(s => sel.append(el("option", { value: s.id, textContent: s.label })));
    sel.value = x.sound || "";
    sel.onchange = () => { x.sound = sel.value || undefined; };
    box.append(el("div", { className: "row subrow" }, inp, sel,
      el("button", { type: "button", className: "danger tiny", textContent: "Delete", onclick: () => { x.del = true; drawChecks(); } })));
  });
  if (!box.children.length) box.append(el("span", { className: "muted", textContent: "No checklist items yet." }));
}
// addDraftCheck(): turn the "new item" box into a draft row.
function addDraftCheck() {
  const inp = $("#newCheck"),
    text = inp.value.trim();
  if (!text) return;
  draftChecks.push({ id: uid(), text, done: false });
  inp.value = "";
  drawChecks();
}
$("#addCheckBtn").onclick = addDraftCheck;
// Enter in the "new item" box adds the item instead of submitting the whole form.
$("#newCheck").addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); addDraftCheck(); } });

// openFlagDlg(item, tileId, groupId): open the dialog to edit `item`, or to add a new flag
// (item = null) pre-selecting a tile and optionally a subsection.
function openFlagDlg(item, tileId, groupId) {
  editingFlag = item;
  if (item) newAt = null;
  fform.reset();
  $("#flagDlgTitle").textContent = item ? "Edit flag" : "New flag";
  $("#deleteFlag").hidden = !item;
  $("#flagMsg").textContent = "";
  fform.tile.textContent = "";
  C().tiles.forEach(t => fform.tile.append(el("option", { value: t.id, textContent: t.name })));
  fform.tile.value = tileId || C().tiles[0].id;
  fillGroups(fform.tile.value, item ? item.group : groupId);
  // The sound menu lists the soundboard's sounds. If the flag's sound was deleted, show "(none)".
  fform.sound.textContent = "";
  fform.sound.append(el("option", { value: "", textContent: "(none)" }));
  soundChoices().forEach(s => fform.sound.append(el("option", { value: s.id, textContent: s.label })));
  fform.sound.value = item?.sound || "";
  draftChecks = item ? item.checklist.map(c => ({ ...c })) : [];   // {...c} = shallow copy of each entry
  if (item) {
    fform.name.value = item.name;
    fform.maxWidth.value = item.maxWidth ?? "";
    fform.notes.value = item.notes || "";
  }
  drawChecks();
  fdlg.showModal();
}

// Delete button: remove the flag.
$("#deleteFlag").onclick = () => {
  const loc = locate(editingFlag.id);
  loc.tile.items.splice(loc.i, 1);
  fdlg.close();
  save();
  render();
};

// Save: copy the form onto the flag (or create it). Checklist: kept entries keep their id and ticked
// state; entries marked deleted are dropped; text is trimmed. preventDefault stops the browser's own
// form submission (a page reload).
fform.addEventListener("submit", ev => {
  ev.preventDefault();
  addDraftCheck();   // a typed-but-not-added item still counts
  const f = fform;
  const data = {
    name: f.name.value.trim(),
    maxWidth: +f.maxWidth.value > 0 ? Math.min(1200, Math.max(140, +f.maxWidth.value)) : undefined,
    sound: f.sound.value || undefined,
    notes: f.notes.value.trim() || undefined,
    group: f.group.value || undefined
  };
  const checklist = draftChecks.filter(x => !x.del && x.text.trim()).map(x => ({ id: x.id, text: x.text.trim(), done: !!x.done, sound: x.sound || undefined }));
  const dest = C().tiles.find(t => t.id === f.tile.value);
  if (editingFlag) {
    const old = locate(editingFlag.id).tile;
    Object.assign(editingFlag, data, { checklist });
    if (old !== dest) {   // moved to another tile in the dialog: put the card next to that tile's flags
      old.items.splice(old.items.indexOf(editingFlag), 1);
      placeFlag(editingFlag, dest);
      dest.items.push(editingFlag);
    }
  } else {
    const flag = { id: uid(), ...data, checklist, triggered: false, loot: { entries: [], log: [] } };
    if (newAt) { flag.x = Math.round(newAt.x - 120); flag.y = Math.round(newAt.y - 40); newAt = null; }   // where the canvas was clicked
    else placeFlag(flag, dest);   // a free spot next to the tile's other flags
    dest.items.push(flag);
  }
  fdlg.close();
  save();
  render(true);
});


// ------------------------------------------------------------ click menu
// A plain click on empty canvas (or on the empty inside of a frame) opens a small menu at that spot: new section,
// tile, flag or encounter, created where you clicked. A press that moves is a pan, not a click, and shows no menu.
// at: the world position of the click.  where(): which section / tile the spot is inside (from the frame rectangles).
const cmenu = el("div", { id: "canvasMenu", className: "cmenu", hidden: true });
document.body.append(cmenu);
const hideMenu = () => { cmenu.hidden = true; };

function where(at) {
  const fid = Canvas.frameAt(frames, at.x, at.y) || "";
  const [kind, a] = fid.split(":");
  const tile = kind === "tile" || kind === "sub" ? C().tiles.find(t => t.id === a) : null;
  const sec = kind === "sec" ? C().sections.find(x => x.id === a) : tile ? C().sections.find(x => x.id === tile.section) : null;
  return { tile, sec };
}

function showMenu(clientX, clientY) {
  const at = Canvas.toWorld(clientX, clientY), here = where(at);
  const item = (label, fn) => el("button", { textContent: label, onclick: () => { hideMenu(); fn(); } });
  cmenu.replaceChildren(
    item("New section", () => {
      const name = prompt("New section name");
      if (!name) return;
      C().sections.push({ id: uid(), name, x: Math.round(at.x), y: Math.round(at.y) });
      save(); render(true);
    }),
    item("New tile", () => {
      const name = prompt("New tile name (e.g. 'The Sunken Temple')");
      if (!name) return;
      C().tiles.push({ id: uid(), name, section: (here.sec || C().sections[0]).id, subs: [], items: [], x: Math.round(at.x), y: Math.round(at.y) });
      save(); render(true);
    }),
    item("New flag", () => { newAt = at; openFlagDlg(null, (here.tile || C().tiles[0]).id); }),
    item("New encounter", () => openEncDlg(at, (here.tile || C().tiles[0]).id)));
  cmenu.hidden = false;
  cmenu.style.left = Math.min(clientX, innerWidth - cmenu.offsetWidth - 8) + "px";
  cmenu.style.top = Math.min(clientY, innerHeight - cmenu.offsetHeight - 8) + "px";
}

// newAt: where the flag being created should go (set by the menu; null = a free spot next to its tile's cards).
let newAt = null;
let press = null;
$("#stage").addEventListener("pointerdown", ev => {
  if (!ev.target.closest("#canvasMenu")) hideMenu();
  const thing = ev.target.closest("[data-iid],.frame > header,#zoomctl,#canvasMenu,button,input,select,a,dialog");
  press = ev.button === 0 && !thing ? { x: ev.clientX, y: ev.clientY } : null;
});
$("#stage").addEventListener("pointerup", ev => {
  if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 5) showMenu(ev.clientX, ev.clientY);
  press = null;
});
addEventListener("keydown", ev => { if (ev.key === "Escape") hideMenu(); });
addEventListener("blur", hideMenu);

// ------------------------------------------------------------ encounter dialog
// "New encounter" from the menu: choose an existing encounter or make a new one, and the tile it goes in. A NEW one
// is created empty and the Encounters tab opens on it so monsters can be added.
const edlg = $("#encDlg"),
  eform = $("#encForm");
let encAt = null;
function openEncDlg(at, tileId) {
  encAt = at;
  eform.enc.textContent = "";
  eform.enc.append(el("option", { value: "", textContent: "(new encounter)" }), ...(S.encounters || []).map(e => el("option", { value: e.id, textContent: e.name })));
  eform.tile.textContent = "";
  C().tiles.forEach(t => eform.tile.append(el("option", { value: t.id, textContent: t.name })));
  eform.tile.value = tileId;
  eform.newName.value = "";
  eform.newName.hidden = false;
  edlg.showModal();
}
eform.enc.addEventListener("change", () => { eform.newName.hidden = !!eform.enc.value; });
eform.addEventListener("submit", async ev => {
  ev.preventDefault();
  let id = eform.enc.value, fresh = false;
  try {
    if (!id) {
      const n = await api("/api/encounters", "POST", { name: eform.newName.value.trim() || "New encounter" });
      (S.encounters ||= []).push(n);
      id = n.id;
      fresh = true;
    }
    const tile = C().tiles.find(t => t.id === eform.tile.value) || C().tiles[0];
    const card = { id: uid(), name: "", encounter: id, checklist: [], triggered: false, loot: { entries: [], log: [] } };
    if (encAt) { card.x = Math.round(encAt.x - 120); card.y = Math.round(encAt.y - 40); } else placeFlag(card, tile);
    tile.items.push(card);
    edlg.close();
    save();
    render(true);
    if (fresh) window.parent.postMessage({ type: "goto", page: "encounters", path: "/_/encounters?id=" + id }, location.origin);
  } catch (e) { alert(e.message); }
});

// ------------------------------------------------------------ tile dialog
// Rename a tile, move it to another section, and manage its subsections. Subsection edits are made on
// a COPY (draftSubs) and applied on Save, so Cancel discards them.
const tdlg = $("#tileDlg"),
  tform = $("#tileForm");
let editingTile = null,
  draftSubs = [];

// drawSubList(): redraw the subsection rows in the dialog (a rename box and a Delete button each).
function drawSubList() {
  const box = $("#subList");
  box.textContent = "";
  draftSubs.filter(x => !x.del).forEach(x => {
    const inp = el("input", { value: x.name });
    inp.oninput = () => (x.name = inp.value);
    box.append(el("div", { className: "row subrow" }, inp,
      el("button", { type: "button", className: "danger tiny", textContent: "Delete", title: "Flags stay in the tile",
        onclick: () => { x.del = true; drawSubList(); } })));
  });
  if (!box.children.length) box.append(el("span", { className: "muted", textContent: "No subsections yet." }));
}
// addDraftSub(): turn the "new subsection" box into a draft row.
function addDraftSub() {
  const inp = $("#newSub"),
    name = inp.value.trim();
  if (!name) return;
  draftSubs.push({ id: uid(), name });
  inp.value = "";
  drawSubList();
}
$("#addSubBtn").onclick = addDraftSub;
$("#newSub").addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); addDraftSub(); } });

// openTileDlg(tile): fill the dialog from the tile and show it.
function openTileDlg(tile) {
  editingTile = tile;
  tform.section.textContent = "";
  C().sections.forEach(s => tform.section.append(el("option", { value: s.id, textContent: s.name })));
  tform.name.value = tile.name;
  tform.section.value = tile.section;
  draftSubs = tile.subs.map(x => ({ ...x }));
  drawSubList();
  tdlg.showModal();
}
// Save: apply the name, subsections (deleted ones un-group their flags) and section.
tform.addEventListener("submit", ev => {
  ev.preventDefault();
  const t = editingTile;
  addDraftSub();
  t.name = tform.name.value.trim() || t.name;
  draftSubs.filter(x => x.del).forEach(x => t.items.forEach(i => { if (i.group === x.id) delete i.group; }));
  t.subs = draftSubs.filter(x => !x.del).map(x => ({ id: x.id, name: x.name.trim() || "Subsection" }));
  if (t.section !== tform.section.value) moveTile(t.id, tform.section.value, null);
  tdlg.close();
  save();
  render(true);
});

// ------------------------------------------------------------ loot dialog
// The reward popup for one flag. A loot table is a list of entries, each with a WEIGHT. Think of a die
// with as many faces as the total weight: an entry of weight 5 owns 5 faces. Rolling picks a face at
// random, and the entry that owns it is the reward (so heavier entries come up more often). Each
// entry's "range" column shows which faces it owns.
const ldlg = $("#lootDlg");
// lootItem: the flag whose table is open. lastRolls: the result lines of the latest Roll, shown above the history.
let lootItem = null,
  lastRolls = [];

// lootRanges(entries): add the die range to each entry: { entry, lo, hi, w } where the entry owns
// faces lo..hi (inclusive) and w is its weight (a whole number, at least 1). Also returns the total.
function lootRanges(entries) {
  let at = 0;
  const rows = entries.map(entry => {
    const w = Math.max(1, Math.floor(+entry.weight || 1));
    const row = { entry, lo: at + 1, hi: at + w, w };
    at += w;
    return row;
  });
  return { rows, total: at };
}

// drawLoot(): redraw the whole popup: the table (range, name, weight, chance, note, delete), the latest
// roll results and the saved history.
function drawLoot() {
  const { rows, total } = lootRanges(lootItem.loot.entries);
  $("#lootTitle").textContent = `Rewards: ${lootItem.name}`;
  const table = $("#lootTable");
  table.textContent = "";
  table.append(el("tr", {}, ...["Range", "Reward", "Weight", "Chance", "Note", ""].map(t => el("th", { textContent: t }))));
  rows.forEach(({ entry, lo, hi, w }) => {
    // The weight box edits the entry in place, then everything is redrawn (the ranges shift).
    const wbox = el("input", { type: "number", min: 1, step: 1, value: w, className: "inum" });
    wbox.onchange = () => { entry.weight = Math.max(1, Math.floor(+wbox.value || 1)); save(); drawLoot(); };
    table.append(el("tr", {},
      el("td", { textContent: lo === hi ? String(lo) : `${lo}–${hi}` }),
      el("td", { textContent: entry.name }),
      el("td", {}, wbox),
      el("td", { textContent: ((w / total) * 100).toFixed(w / total < 0.1 ? 1 : 0) + "%" }),
      el("td", { className: "muted", textContent: entry.note || "" }),
      el("td", {}, el("button", { className: "danger tiny", textContent: "✕", title: "Remove this reward", onclick: () => {
        lootItem.loot.entries = lootItem.loot.entries.filter(x => x !== entry);
        save();
        drawLoot();
      } }))));
  });
  if (!rows.length) table.append(el("tr", {}, el("td", { colSpan: 6, className: "muted", textContent: "No rewards yet. Add some below." })));
  $("#lootResult").textContent = "";
  lastRolls.forEach(t => $("#lootResult").append(el("div", { textContent: t })));
  const log = $("#lootLog");
  log.textContent = "";
  lootItem.loot.log.forEach(l => log.append(el("li", {}, el("span", { textContent: l.text }), el("span", { className: "muted", textContent: timeText(l.at) }))));
}

// openLoot(item): open the popup for this flag.
function openLoot(item) {
  lootItem = item;
  lastRolls = [];
  drawLoot();
  ldlg.showModal();
}

// "Add" button / Enter: append an entry from the three boxes.
function addLootEntry() {
  const name = $("#lootName").value.trim();
  if (!name) return;
  lootItem.loot.entries.push({ id: uid(), name, weight: Math.max(1, Math.floor(+$("#lootWeight").value || 1)), note: $("#lootNote").value.trim() || undefined });
  $("#lootName").value = "";
  $("#lootNote").value = "";
  $("#lootWeight").value = 1;
  save();
  drawLoot();
}
$("#addLootBtn").onclick = addLootEntry;
$("#lootName").addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); addLootEntry(); } });

// "Roll" button: roll the table `Rolls` times. Each roll picks a random whole number from 1 to the total weight
// (Math.random() is a float in [0,1); times total, floored, plus 1 gives 1..total) and finds the entry whose
// range contains it. The result lines are shown and also stored in the flag's history (newest first, last 30 kept).
$("#rollLootBtn").onclick = () => {
  const { rows, total } = lootRanges(lootItem.loot.entries);
  if (!rows.length) { lastRolls = ["Add at least one reward first."]; drawLoot(); return; }
  const count = Math.max(1, Math.min(20, Math.floor(+$("#lootCount").value || 1)));
  lastRolls = [];
  for (let k = 0; k < count; k++) {
    const r = 1 + Math.floor(Math.random() * total);
    const hit = rows.find(row => r >= row.lo && r <= row.hi);
    const text = `🎲 d${total} → ${r}: ${hit.entry.name}${hit.entry.note ? " (" + hit.entry.note + ")" : ""}`;
    lastRolls.push(text);
    lootItem.loot.log.unshift({ text, at: Date.now() });   // unshift = insert at the front
  }
  lootItem.loot.log.length = Math.min(lootItem.loot.log.length, 30);   // keep only the newest 30
  save();
  drawLoot();
};
// "Clear history": empty the saved roll history for this flag.
$("#clearLootLog").onclick = () => {
  lootItem.loot.log = [];
  lastRolls = [];
  save();
  drawLoot();
};
// When the popup closes, redraw the board so the 🎁 count on the tile is up to date.
ldlg.addEventListener("close", () => render(true));

// ------------------------------------------------------------ campaign links
// Links are cables between ANY two items on the board, to show how things depend on each other: "this
// flag unlocks that tile", "finishing this checklist entry opens that section". They are stored in
// S.campaign.links as { id, from, to } where from/to are item KEYS, a kind and an id joined by a colon:
//     sec:<id>            a section (its frame)        tile:<id>        a tile
//     sub:<tileId>:<id>   a subsection                 flag:<id>        a flag
//     chk:<id>            one checklist entry          loot:<flagId>    a flag's loot table (the 🎁 button)
// Every item has a column of INPUT squares on its left edge and OUTPUT circles on its right edge. There is
// one input per incoming link and one output per outgoing link, plus one extra EMPTY (dashed) input and
// output at the end of each column: "N + 1". So an item can have any number of links in AND out. (The
// soundboard's sounds are different on purpose: many inputs but only one output, because a sound can only
// hand over to one next sound.)
//   - Make a link: drag from an empty output (or any output) onto any other item.
//   - Remove a link: click its output circle or its input square, or click the cable itself. (Same on the soundboard.)
//   - Re-route a link: drag from its filled output or filled input to a different item.
// Links may form loops; duplicates and self-links are refused; links whose item has been deleted
// are removed automatically (pruneLinks).
//
// Meaning: an item is "done" when the party has finished it (see isDone). A cable whose source is done
// is drawn solid green; otherwise dashed. An item that has incoming links from something not done yet is
// shown as "locked" (dimmed, with a tooltip saying what it is waiting for). This is only a visual
// guide: nothing is ever blocked.

// ---- undo / redo for links
// Every change to the links (making, removing or re-routing one) can be undone and redone, with Ctrl+Z /
// Ctrl+Y (Cmd on a Mac) or the ↶ ↷ buttons in the toolbar. undo.js keeps the history; here we only say how to
// take a snapshot of the links (the whole list as JSON text) and how to put one back: the list is replaced,
// then saved and redrawn; a link to an item that has since been deleted is dropped by pruneLinks() during
// render. Deleting an item (which also removes its links) is not part of this history.
const linkHistory = Undo.create({
  snapshot: () => JSON.stringify(C().links),
  restore: text => {
    C().links = JSON.parse(text);
    save();
    render(true);
  },
  onChange: () => {   // grey out the toolbar buttons when there is nothing to undo / redo
    $("#undoBtn").disabled = !linkHistory.canUndo();
    $("#redoBtn").disabled = !linkHistory.canRedo();
  }
});
$("#undoBtn").onclick = () => Undo.toast(linkHistory.undo() ? "Undid the last link change" : "Nothing to undo");
$("#redoBtn").onclick = () => Undo.toast(linkHistory.redo() ? "Redid the link change" : "Nothing to redo");
$("#undoBtn").disabled = $("#redoBtn").disabled = true;   // an empty history to start with
Undo.bindKeys(linkHistory);

// parseKey(key): "flag:abc" -> { kind: "flag", id: "abc" } (the id is everything after the first colon).
function parseKey(key) {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
}
// lookup(key): the data behind a key ({ kind, obj, name }), or null if it no longer exists.
function lookup(key) {
  const { kind, id } = parseKey(key);
  if (kind === "sec") { const o = C().sections.find(x => x.id === id); return o && { kind, obj: o, name: o.name }; }
  if (kind === "tile") { const o = C().tiles.find(x => x.id === id); return o && { kind, obj: o, name: o.name }; }
  if (kind === "sub") {
    const [tileId, subId] = id.split(":");
    const t = C().tiles.find(x => x.id === tileId),
      o = t?.subs.find(x => x.id === subId);
    return o && { kind, obj: o, tile: t, name: o.name };
  }
  if (kind === "flag" || kind === "loot") { const loc = locate(id); return loc && { kind, obj: loc.item, name: kind === "loot" ? `${loc.item.name} (loot)` : loc.item.name }; }
  if (kind === "chk") {
    for (const t of C().tiles) for (const i of t.items) {
      const c = i.checklist.find(x => x.id === id);
      if (c) return { kind, obj: c, name: c.text };
    }
  }
  return null;
}
// isDone(key): has the party finished this item? flag = triggered; checklist entry = ticked; loot table =
// rolled at least once; subsection = it has flags and all are triggered; tile = it has flags and all are
// triggered; section = it has tiles and all are done.
function isDone(key) {
  const it = lookup(key);
  if (!it) return false;
  if (it.kind === "flag") return !!it.obj.triggered;
  if (it.kind === "chk") return !!it.obj.done;
  if (it.kind === "loot") return it.obj.loot.log.length > 0;
  if (it.kind === "sub") { const f = it.tile.items.filter(i => i.group === it.obj.id); return f.length > 0 && f.every(i => i.triggered); }
  if (it.kind === "tile") return it.obj.items.length > 0 && it.obj.items.every(i => i.triggered);
  const tiles = C().tiles.filter(t => t.section === it.obj.id);   // a section
  return tiles.length > 0 && tiles.every(t => isDone("tile:" + t.id));
}
// pruneLinks(): drop links that point at items that no longer exist, links from an item to itself, and
// duplicates. Runs on every render, so deleting anything (a flag, a tile, a checklist entry...) cleans up.
function pruneLinks() {
  const seen = new Set();
  C().links = C().links.filter(l => {
    const k = l.from + ">" + l.to;
    if (l.from === l.to || !lookup(l.from) || !lookup(l.to) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// addPorts(node, key, small): make `node` linkable under `key`: tag it (data-lid, used to find it under
// the mouse) and give it its two port columns. Ports are built from the current links: one filled input per
// incoming link, one filled output per outgoing link, and one empty ("free") port at the end of each
// column. `small` items (checklist rows, the loot button) only show their ports on hover. The ports are
// children of the item's own element, so they move with it.
function addPorts(node, key, small = false) {
  node.dataset.lid = key;
  node.classList.add("linkable");
  if (small) node.classList.add("smallports");
  const name = k => lookup(k)?.name ?? "?";
  const inCol = el("span", { className: "lports lports-in" }),
    outCol = el("span", { className: "lports lports-out" });
  C().links.filter(l => l.to === key).forEach(l => {
    const q = el("span", { className: "lp lp-in on", title: `From “${name(l.from)}”. Click to remove, drag to re-route` });
    q.dataset.link = l.id;   // data-link: lets drawLinks() find the square that belongs to this link
    q.addEventListener("pointerdown", ev => startLink(ev, l.from, l));
    inCol.append(q);
  });
  inCol.append(el("span", { className: "lp lp-in free", title: "Drop a link anywhere on this item to link into it" }));
  C().links.filter(l => l.from === key).forEach(l => {
    const o = el("span", { className: "lp lp-out on", title: `To “${name(l.to)}”. Click to remove, drag to re-route` });
    o.dataset.link = l.id;
    o.addEventListener("pointerdown", ev => startLink(ev, key, l));
    outCol.append(o);
  });
  const free = el("span", { className: "lp lp-out free", title: "Drag onto another item to link it" });
  free.addEventListener("pointerdown", ev => startLink(ev, key, null));
  outCol.append(free);
  node.append(inCol, outCol);
}

// markLinked(): after a render, give every item that waits for something the "locked" class (with a tooltip
// listing what it waits for): it has an incoming link whose source is not done yet.
function markLinked() {
  const waiting = {};   // key -> names of sources not done yet
  C().links.forEach(l => {
    if (!isDone(l.from)) (waiting[l.to] ||= []).push(lookup(l.from)?.name || "?");
  });
  Object.entries(waiting).forEach(([key, names]) => {
    const n = document.querySelector(`[data-lid="${key}"]`);
    if (n) { n.classList.add("locked"); n.dataset.waiting = "Waiting for: " + names.join(", "); n.title = n.dataset.waiting; }
  });
}

// addLink(from, to): create a link if it is valid (both items exist, not the same item, not a duplicate).
function addLink(from, to) {
  if (from === to || !lookup(from) || !lookup(to)) return;
  if (C().links.some(l => l.from === from && l.to === to)) return;
  linkHistory.record("made a link");   // remember the state first, so it can be undone
  C().links.push({ id: uid(), from, to });
  save();
  render(true);
}

// startLink(ev, from, existing): the pointer went down on a port of item `from`. `existing` is the link
// that port belongs to, or null for the empty port (a brand new link). From here:
//   - released without moving: a plain CLICK. On a filled port that removes the link (on an empty port nothing happens).
//   - dragged onto another item: a new link is made (empty port), or the existing link is re-routed to that item.
//   - dropped on nothing: no change.
// While dragging, a rubber-band cable follows the pointer, the item under it (the innermost linkable one) is
// highlighted, and `drag` is set so render() is postponed (it would destroy the element being dragged from).
// The same pointer-event approach and the same click-to-remove rule as the soundboard's connectors.
function startLink(ev, from, existing) {
  ev.preventDefault();
  ev.stopPropagation();
  // The rubber band starts at this link's output circle (for a re-route started from an input square, that is the source's circle).
  const out = existing
    ? document.querySelector(`.lp-out[data-link="${existing.id}"]`)
    : document.querySelector(`[data-lid="${from}"] > .lports-out > .lp-out.free`);
  if (!out) return;
  const p0 = Canvas.posIn(out),
    x0 = p0.x + out.offsetWidth / 2,
    y0 = p0.y + out.offsetHeight / 2;   // start of the rubber band, in world coordinates
  drag = { kind: "link" };
  document.body.classList.add("linking");
  const temp = document.createElementNS(Cables.SVGNS, "path");
  temp.setAttribute("class", "link temp");
  temp.setAttribute("marker-end", "url(#arr)");
  $("#tempLayer").append(temp);
  // under(e): the linkable item beneath the pointer. closest() walks up from the element under the pointer
  // to the nearest ancestor with a data-lid, so a checklist row wins over the flag that contains it.
  const under = e => document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-lid]");
  const clear = () => document.querySelectorAll(".linktarget").forEach(n => n.classList.remove("linktarget"));
  let moved = false;
  const move = e => {
    const w = Canvas.toWorld(e.clientX, e.clientY);   // pointer position in world coordinates (accounts for pan and zoom)
    if (Math.hypot(w.x - x0, w.y - y0) > 5) moved = true;
    temp.setAttribute("d", Cables.bezier({ x: x0, y: y0 }, { x: Math.max(w.x, x0 + 12), y: w.y }));
    clear();
    const t = under(e);
    if (t && t.dataset.lid !== from) t.classList.add("linktarget");
  };
  const end = (e, cancelled) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", cancel);
    const t = cancelled ? null : under(e);
    temp.remove();
    clear();
    document.body.classList.remove("linking");
    drag = null;
    const to = t?.dataset.lid;
    if (moved && to && to !== from) {
      if (!existing) return addLink(from, to);   // addLink records, saves and re-renders
      linkHistory.record("re-routed a link");
      // Re-route: point the existing link at the new item (or just drop it if that exact link already exists).
      if (C().links.some(l => l !== existing && l.from === from && l.to === to)) C().links = C().links.filter(l => l !== existing);
      else existing.to = to;
    } else if (!moved && !cancelled && existing) {
      linkHistory.record("removed a link");
      C().links = C().links.filter(l => l !== existing);   // a plain click on a filled port removes the link
    } else {
      return render(true);   // nothing changed
    }
    save();
    render(true);
  };
  const up = e => end(e, false),
    cancel = e => end(e, true);
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", cancel);
}

// drawLinks(): redraw every cable. Positions are world coordinates (Canvas.posIn), so cables pan and zoom
// with the board and only need redrawing when something moves or changes size. Each link is two paths: the
// visible cable (solid green if its source is done, dashed otherwise) and a wider invisible one on top
// that is easy to click; clicking it removes the link. A link is skipped while either end is hidden (for
// example inside a collapsed section).
function drawLinks() {
  const layer = $("#linkLayer");
  layer.textContent = "";
  C().links.forEach(l => {
    // This link's own output circle and input square (each link has its own, found by data-link).
    const a = document.querySelector(`.lp-out[data-link="${l.id}"]`),
      b = document.querySelector(`.lp-in[data-link="${l.id}"]`);
    if (!a?.offsetParent || !b?.offsetParent) return;
    const pa = Canvas.posIn(a),
      pb = Canvas.posIn(b),
      A = { x: pa.x + a.offsetWidth / 2, y: pa.y + a.offsetHeight / 2 },     // centre of the output circle
      B = { x: pb.x - 1, y: pb.y + b.offsetHeight / 2 };                     // left edge of the input square
    // For a target that is not to the right, use the U-turn fallback; it needs the vertical extent of both items.
    const box = port => {
      const owner = port.closest("[data-lid]"),
        p = Canvas.posIn(owner);
      return { top: p.y, bottom: p.y + owner.offsetHeight };
    };
    const d = B.x - A.x >= 20 ? Cables.bezier(A, B) : Cables.routed(A, B, box(a), box(b), Canvas.WORLD);
    const done = isDone(l.from);
    const vis = document.createElementNS(Cables.SVGNS, "path");
    vis.setAttribute("d", d);
    vis.setAttribute("class", "link " + (done ? "sat" : "wait"));
    vis.setAttribute("marker-end", "url(#arr)");
    const hit = document.createElementNS(Cables.SVGNS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "linkhit");
    hit.addEventListener("click", () => {
      linkHistory.record("removed a link");
      C().links = C().links.filter(x => x !== l);
      save();
      render(true);
    });
    // <title> inside an SVG shape is its tooltip.
    const tip = document.createElementNS(Cables.SVGNS, "title");
    tip.textContent = `${lookup(l.from)?.name} → ${lookup(l.to)?.name}  (click to remove)`;
    hit.append(tip);
    layer.append(vis, hit);
  });
}
// scheduleDraw(): redraw the cables at the next screen repaint (requestAnimationFrame also merges
// several requests in one frame into a single redraw).
function scheduleDraw() { requestAnimationFrame(drawLinks); }

// ------------------------------------------------------------ toolbar & boot
$("#addTileBtn").onclick = () => addTile(null);
$("#addSectionBtn").onclick = () => {
  const name = prompt("New section name (e.g. 'Act 2')");
  if (name) { C().sections.push({ id: uid(), name }); save(); render(); }
};
// This page runs inside a frame of the app shell (shell.html), which keeps it loaded but hidden while you
// look at other tabs. A hidden frame cannot measure layout, so when the shell shows this tab again it
// sends { type: "shown" } and we redraw the cables.
addEventListener("message", ev => {
  if (ev.data?.type === "shown") scheduleDraw();
  if (ev.data?.type === "focusNode") revealNode(ev.data.id);
});

// revealNode(id): jump to a card (asked for by the Encounters tab through the app shell, the same way the 🎯 buttons jump
// to a sound on the soundboard). The card may have been added a moment ago from another page, so load the board fresh
// first; open its section if collapsed; then Canvas.reveal centres on it and flashes it.
async function revealNode(id) {
  try {
    if (!saveTimer && !drag) {
      S = await api("/api/state");
      myRevision = S.revision;
      normalize();
      render(true);
    }
    const loc = locate(id);
    if (!loc) return;
    const sec = C().sections.find(x => x.id === loc.tile.section);
    if (sec?.collapsed) { sec.collapsed = false; save(); render(true); }
    const card = cardEl(loc.item);
    if (card) requestAnimationFrame(() => Canvas.reveal(card));
  } catch (_) { /* server restarting: the normal poll will catch up */ }
}
// A drag that ends without a drop (Esc, outside the window) must never leave rendering frozen.
// The third argument `true` registers it in the capture phase so it runs first.
addEventListener("dragend", () => { drag = null; if (pendingRender) render(true); }, true);

// Boot: runs once when the page loads. Load everything from the server, fill in any missing
// structure, draw the board, then start polling for outside changes every 5 seconds.
(async () => {
  // Turn #stage / #world into the pan-and-zoom canvas; frame all the tiles on the first visit.
  const restored = Canvas.mount($("#stage"), $("#world"), "campaign");
  S = await api("/api/state");
  myRevision = S.revision;
  normalize();
  render();
  if (!restored) Canvas.fit();
  setInterval(pollState, 5000);
})();
