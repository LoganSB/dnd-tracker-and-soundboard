"use strict";
// =============================================================================
// campaign.js - the Campaign Tracker page
// =============================================================================
//
// WHAT THIS PROGRAM IS
//   A board for tracking what the party has achieved or triggered in a campaign. It is laid out
//   exactly like the soundboard (sections that nest inside sections, holding cards),
//   but the clickable items are "flags" instead of sounds. Like app.js, this file runs inside the
//   browser: it registers callbacks and the browser calls them on clicks, drags and timers.
//   (See the header of app.js for a primer on the JavaScript constructs used here.)
//   Like the soundboard it lives on an infinite pan-and-zoom canvas (canvas.js), and it uses the same
//   layout code: the cards are free-floating, each at its own x, y; SECTIONS are FRAMES drawn around the
//   cards (and child sections) that belong to them (they stretch and shrink as you move cards).
//
// THE DATA MODEL  (all of it lives in S.campaign, saved with the sounds; see board.py)
//
//   S.campaign = {
//     sections: [ { id, name, parent, collapsed?, x?, y? } ],  // a TREE: parent = another section's id, "" = top level
//     items: [ {                                // the cards: flags, encounter cards, loot flags, conditions, timers
//        id, name,
//        section,                               // the id of the section it sits in ("" = none)
//        x, y,                                  // position of the card on the canvas (world pixels)
//        triggered, triggeredAt,                // the flag itself: has the party done/triggered this? (+ when)
//        maxWidth,                              // the card may grow this wide (px) before its text wraps
//        sound,                                 // optional id of a SOUNDBOARD sound played when triggered (or when a timer ends)
//        notes,                                 // free text, shown when you hover the card
//        checklist: [ { id, text, done } ],     // optional checklist; the card grows to fit it
//        loot: { entries: [ { id, name, weight, note } ],   // the flag's own reward list (weighted)
//                source,                                    // optional: "table:<id>" (a loot table) or "rarity:<r>" (random item)
//                log: [ { text, at } ] }                    // history of rolls, newest first
//        encounter,                             // set on an ENCOUNTER card: the encounter's id
//        condition,                             // set on a CONDITION card: { groups: [ { id, name, tiers: [ { id, need, label } ] } ] }
//        timer,                                 // set on a TIMER card: { secs, endsAt?, left?, done?, doneAt? } (see timers.js)
//     } ],
//     links: [ { id, from, to, group?, when? } ]   // cables between ANY two things (see "campaign links" below)
//   }
//   A link's `from` and `to` are keys: "sec:<id>" (a section), "flag:<id>" (any card), or "chk:<id>" (one checklist entry).
//   An item can have any number of links in and out.
//
//   S as a whole is the same state object the soundboard uses ({ sections, sounds, campaign }).
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
let S = { sounds: [], campaign: null },
  myRevision = -1;

// C(): shorthand for the campaign data, S.campaign.
const C = () => S.campaign;

// ---- the model: a tree of sections holding cards (see board.py; the tree helpers are in nodes.js)
// S.campaign = { sections: [ { id, name, parent, collapsed?, x?, y? } ], items: [ cards ], links: [ ... ] }. A section's `parent` is another
// section's id or "" for none; a card's `section` is the id of the section it sits in or "" for none. Sections nest to any depth and
// every object stands on its own: deleting a section hands its contents to its own parent (Nodes.remove).
// secs(): the section list. sectionOptions(opts): the sections as drop-down choices, indented by depth ("(no section)" first).
const secs = () => C().sections;
const sectionOptions = opts => Nodes.options(C().sections, opts);
// firstSection(): the default home for something created from the toolbar: the first top-level section (or none).
const firstSection = () => Nodes.roots(C().sections)[0]?.id || "";

// normalize(): make sure S.campaign exists and every object has the fields the code expects: sound parent links, positions and defaults.
function normalize() {
  S.sounds ||= [];
  S.campaign ||= {};
  const c = S.campaign;
  c.sections ||= [];
  c.items ||= [];
  c.links ||= [];
  // A brand-new campaign starts with one section holding one section. After that nothing forces any of them to exist.
  if (!c.sections.length && !c.items.length) {
    const main = { id: uid(), name: "Main story", parent: "" };
    c.sections.push(main, { id: uid(), name: "Chapter 1", parent: main.id });
  }
  Nodes.fix(c.sections);
  c.items.forEach(i => {
    if (!i.section || !Nodes.byId(c.sections, i.section)) i.section = "";   // its section is gone: it simply has no parent
    if (i.condition) {   // a condition card: make sure every group and tier has an id
      i.condition.groups ||= [];
      i.condition.groups.forEach(g => { g.id ||= uid(); g.tiers ||= []; g.tiers.forEach(x => (x.id ||= uid())); });
    }
    i.checklist ||= [];
    i.loot ||= { entries: [], log: [] };
    i.loot.entries ||= [];
    i.loot.log ||= [];
  });
  // Sections with no canvas position yet are placed around the middle of the canvas.
  Canvas.layoutMissing(c.sections);
  // Cards with no position of their own (a card added from outside this page, for example an encounter put on the tracker from the
  // Encounters tab, or an older save): a section whose cards ALL lack positions gets them in a tidy grid where it is; otherwise each gets
  // the nearest free spot next to the other cards of its section. Cards that already have x, y are never touched.
  const has = i => Number.isFinite(i.x) && Number.isFinite(i.y);
  const bySection = new Map();
  c.items.forEach(i => { if (!bySection.has(i.section)) bySection.set(i.section, []); bySection.get(i.section).push(i); });
  bySection.forEach((list, id) => {
    const missing = list.filter(i => !has(i));
    if (!missing.length) return;
    const origin = Nodes.byId(c.sections, id);
    if (missing.length === list.length && origin) { Canvas.arrangeInGrid(origin, [list], 250, 150); return; }
    const box = i => ({ l: i.x, t: i.y, r: i.x + 260, b: i.y + 150 });
    const placed = c.items.filter(has);
    missing.forEach(i => {
      Object.assign(i, Canvas.freeSpot(placed.map(box), 240, 130, list.filter(has).map(box)));
      placed.push(i);
    });
  });
}

// allItems(): every card as one flat array.
const allItems = () => C().items;
// locate(id): find a card by id. Returns { item, i, section } (i = its index in C().items, section = the section object it sits in, or null) or null.
function locate(id) {
  const i = C().items.findIndex(x => x.id === id);
  return i < 0 ? null : { item: C().items[i], i, section: Nodes.byId(C().sections, C().items[i].section) || null };
}

// ------------------------------------------------------------ persistence
// saveTimer: handle of the pending delayed save (null = nothing pending).
let saveTimer = null;
// save(): store the campaign on the server. Debounced: every call restarts a 300 ms countdown, so
// a burst of edits (ticking several boxes) becomes one request. The server's reply carries the new
// revision number, which we remember so pollState does not mistake our own save for an outside change.
function save() {
  edits.commit();   // register this change as an undoable command (undo.js); a no-op while an undo or redo is restoring
  $("#saveState").textContent = "saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const r = await api("/api/campaign", "PUT", { campaign: C() });
      myRevision = r.revision;
      $("#saveState").textContent = "saved";
      UI.libraryChanged();   // which campaigns hold which encounters and loot tables may have changed (Browse lists)
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
    await addLibrary(st);
    S = st;
    myRevision = st.revision;
    normalize();
    edits.reset();   // the page changed from outside: this is the new baseline, not a command
    render();
  } catch (_) { /* server restarting: try again next time */ }
}

// addLibrary(st): the encounters and loot tables are not part of the campaign (they live in their own files and every
// campaign can use them), so they are fetched separately and put on the state object as st.encounters and st.loots.
async function addLibrary(st) {
  [st.encounters, st.loots] = await Promise.all([api("/api/encounters"), api("/api/loots")]);
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
// soundChoices(): the soundboard's sounds as { id, label } pairs for the menu ("Section › Sound name").
const soundChoices = () => S.sounds.map(s => ({ id: s.id, label: (s.section ? Nodes.path(S.sections || [], s.section) + " › " : "") + s.name }));

// ----------------------------------------------------------- moving things
// Cards and frames are moved with the pointer by canvas.js (Canvas.dragItems), the same code the
// soundboard uses. There is no HTML5 drag-and-drop here any more.

// drag: non-null while a card, a frame or a new link is being dragged ({ kind }). render() is postponed
// while it is set, because rebuilding the page would destroy the element being dragged.
// pendingRender: set when a render() was requested during a drag and postponed.
let drag = null,
  pendingRender = false;

// ---------------------------------------------------------------- cards
// Every kind of card (flag, encounter, condition, timer) is built on cardShell and removed with removeCard, so they all sit, hide,
// drag and delete the same way. The row of small buttons on a card is Nodes.tools (nodes.js), the same code as a section's title bar.

// timeText(ms): "Mar 3, 8:15 PM" style text for a timestamp (toLocaleString formats for the user's locale).
const timeText = ms => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// cardShell(item, className, dragTitle): the bare card: its position, its section (data-sec, used by the "snap only to the same section"
// option), hidden while its section or one above it is collapsed, the width limit, and the drag bar along the top. The caller adds the rest.
function cardShell(item, className, dragTitle = "Drag to move this card") {
  const card = el("div", { className: "flag " + className, role: "button", tabIndex: 0 });
  card.dataset.id = item.id;
  card.dataset.iid = item.id;   // the canvas code finds cards by this attribute
  card.dataset.sec = item.section || "";
  card.style.left = item.x + "px";
  card.style.top = item.y + "px";
  if (Nodes.hidden(C().sections, item.section)) card.style.display = "none";
  card.style.setProperty("--maxw", (item.maxWidth || 320) + "px");   // read by the .flag CSS rule
  const bar = el("div", { className: "dragbar", textContent: "⠿⠿⠿", title: dragTitle });
  bar.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    Canvas.dragItems(ev, [{ obj: item, el: card }], dragHooks(() => adoptCard(item)));   // after the drop it may belong to another section
  });
  card.prepend(bar);
  return card;
}
// removeCard(item, label): delete a card (links to it go with it, see pruneLinks), as one undoable step.
function removeCard(item, label) {
  edits.record(label);
  const loc = locate(item.id);
  if (loc) C().items.splice(loc.i, 1);
  save();
  render();
}
// playOnClick: a card's click handler that ignores clicks which began on its small controls (their own handlers ran).
const onCardClick = (card, fn) => {
  card.addEventListener("click", ev => { if (!ev.target.closest(".ftools,.dragbar,.checks,.lp,.tbtns")) fn(ev); });
  card.addEventListener("keydown", ev => { if (ev.key === "Enter" && ev.target === card) card.click(); });
};

// flagEl(item): build the card for one flag (or hand over to the encounter / condition / timer builders).
//   - Click anywhere on it (except the small controls) to trigger / un-trigger the flag. Triggering
//     stamps the time and plays the linked sound, if there is one.
//   - Its checklist is shown inside; ticking a box saves immediately. The card is as narrow as its
//     content allows and grows (up to its own max width) as checklist text gets longer; past that the
//     text wraps and the card grows taller instead. The width limit is the --maxw CSS variable.
//   - Buttons: 🎯 jumps to the linked sound, 🎁 opens the reward popup, ⚙ edits the flag.
function flagEl(item) {
  if (item.encounter) return encounterEl(item);
  if (item.condition) return condEl(item);
  if (item.timer) return timerEl(item);
  const total = item.checklist.length,
    ticked = item.checklist.filter(c => c.done).length;
  const card = cardShell(item, ["", item.triggered ? "done" : "", total && ticked === total ? "complete" : ""].filter(Boolean).join(" "), "Drag to move this flag");
  card.title = [item.notes, item.triggered ? "Triggered " + timeText(item.triggeredAt || Date.now()) : "Not triggered yet. Click to trigger."]
    .filter(Boolean).join("\n");

  // Title row: a status mark, the name, and the small buttons.
  const lootCount = lootEntries(item).length;
  card.append(el("div", { className: "ftitle" },
    el("span", { className: "fmark", textContent: item.triggered ? "✔" : "○" }),
    el("span", { className: "fname", textContent: item.name }),
    Nodes.tools([
      { icon: "🎯", title: "Jump to the linked sound on the soundboard", hidden: !item.sound, run: () => jumpToSound(item.sound) },
      { icon: "🎁" + (lootCount ? " " + lootCount : ""), title: "Rewards / loot table", run: () => openLoot(item) },
      { icon: "⚙", title: "Edit flag", cls: "gear", run: () => openFlagDlg(item) },
      // Delete this flag (asks first). Links to it and to its checklist entries are removed by pruneLinks().
      { icon: "🗑", title: "Delete this flag", cls: "fdel", run: () => { if (confirm(`Delete flag "${item.name}"?`)) removeCard(item, "deleted a flag"); } },
    ], "ftools")));
  addPorts(card, "flag:" + item.id);

  // Checklist: one row per entry, a real checkbox plus its text. The label wraps long text.
  if (total) {
    const list = el("ul", { className: "checks" });
    item.checklist.forEach(c => {
      const box = el("input", { type: "checkbox", checked: !!c.done });
      // change: fires when the box is toggled. stopPropagation (on click too) so it does not also trigger the flag.
      // Ticking an entry that has a linked sound plays it (the same as triggering a flag that has one).
      box.onchange = () => { edits.record(box.checked ? "ticked a checklist item" : "unticked a checklist item"); c.done = box.checked; if (c.done) playLinked(c); save(); render(); };
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
    card.append(el("div", { className: "ffoot" }, el("span", { className: "muted", textContent: `${ticked}/${total}` })));
  }

  // Click = toggle the flag.
  onCardClick(card, () => {
    edits.record(item.triggered ? "reset a flag" : "triggered a flag");
    item.triggered = !item.triggered;
    item.triggeredAt = item.triggered ? Date.now() : undefined;
    if (item.triggered) playLinked(item);
    save();
    render();
  });
  return card;
}

// ------------------------------------------------------------ encounter cards
// An ENCOUNTER card is a flag-like card that points at an encounter from the Encounters tab (item.encounter = its id;
// the encounter itself lives in S.encounters, the shared library fetched by addLibrary: it belongs to no campaign). Clicking the card ADDS the encounter to the
// initiative tracker (monsters rolled, party added if missing). Buttons: 🆕 start a new combat with it instead,
// 📤 add it and pop out the tracker window, ⚙ open it in the Encounters tab, 🗑 take the card off the board.
const encounterOf = item => (S.encounters || []).find(e => e.id === item.encounter);
// loadingNow: cards whose load request is in flight. tempNote: a short message to show on a card until the next click (not saved).
const loadingNow = new Set(), tempNote = new Map();
const POPOUT = ["/tracker", "dmtracker", "width=460,height=720"];

// loadEncounter(item, mode, popout): ask the server to put the encounter into the initiative order. The pop-out
// window is opened first (a pop-up must start from the click), then refreshed once the order is saved.
async function loadEncounter(item, mode, popout) {
  const w = popout ? window.open(...POPOUT) : null;
  if (loadingNow.has(item.id)) return;   // a second click while the first is still being sent does nothing
  loadingNow.add(item.id);
  try {
    // The server skips an "append" of an encounter that is already in the combat (added = 0), so clicking a card twice cannot
    // double its monsters. 🆕 (replace) starts a fresh combat, so it always loads.
    const r = await api(`/api/encounters/${item.encounter}/load`, "POST", { mode });
    item.triggered = true;
    item.triggeredAt = Date.now();
    if (r.added || mode === "replace") tempNote.delete(item.id); else tempNote.set(item.id, "Already in the tracker");
    save();
    render();
    try { w?.location.reload(); } catch (_) { /* the window was closed */ }
  } catch (e) {
    alert(e.message);
  } finally { loadingNow.delete(item.id); }
}

function encounterEl(item) {
  const enc = encounterOf(item);
  if (enc) item.name = enc.name;   // keep the name the links and menus use in step (saved with the next save)
  const card = cardShell(item, "encounter" + (item.triggered ? " done" : ""));
  card.title = enc ? "Click to add this encounter to the initiative tracker" : "This encounter was deleted from the Encounters tab";
  const lines = enc ? enc.monsters.map(m => `${m.count}× ${m.name}`) : [];
  const xp = enc ? enc.monsters.reduce((s, m) => s + (m.xp || 0) * m.count, 0) : 0;
  card.append(el("div", { className: "ftitle" },
    el("span", { className: "fmark", textContent: "⚔" }),
    el("span", { className: "fname", textContent: enc ? enc.name : "(deleted encounter)" }),
    Nodes.tools([
      { icon: "🆕", title: "Start a NEW combat with this encounter", hidden: !enc, run: () => loadEncounter(item, "replace", false) },
      { icon: "📤", title: "Add to the initiative tracker and pop it out", hidden: !enc, run: () => loadEncounter(item, "append", true) },
      { icon: "⚙", title: "Edit in the Encounters tab", cls: "gear", hidden: !enc,
        run: () => window.parent.postMessage({ type: "goto", page: "encounters", path: "/_/encounters?id=" + enc.id }, location.origin) },
      { icon: "🗑", title: "Take this card off the board (the encounter stays in the Encounters tab)", cls: "fdel", run: () => removeCard(item, "removed an encounter card") },
    ], "ftools")));
  addPorts(card, "flag:" + item.id);
  card.append(el("ul", { className: "emons" }, ...(lines.length ? lines.map(t => el("li", { textContent: t })) : [el("li", { className: "muted", textContent: enc ? "No monsters yet" : "" })])),
    el("div", { className: "ffoot" }, el("span", { className: "muted", textContent: [enc ? `${xp.toLocaleString()} XP` : "", tempNote.get(item.id) || (item.triggered ? "Loaded " + timeText(item.triggeredAt || Date.now()) : "")].filter(Boolean).join(" · ") })));
  onCardClick(card, () => { if (enc) loadEncounter(item, "append", false); });
  return card;
}

// ------------------------------------------------------------ timer cards
// A TIMER card counts down (timers.js holds everything the soundboard's timers share). When it finishes the card flashes, the Campaign tab
// flashes in the top bar until it is opened, and its linked sound (if any) is played through the soundboard, the same way a flag's is.
// The card counts as done for the links: a finished timer can feed a condition or unlock another card.
function timerEl(item) {
  const card = cardShell(item, "timer " + Timers.state(item.timer) + (Timers.alarming(item) ? " alarm" : ""), "Drag to move this timer");
  card.title = "A timer. Start it, pause it or reset it with the buttons.";
  card.append(el("div", { className: "ftitle" },
    el("span", { className: "fmark", textContent: "⏱" }),
    el("span", { className: "fname", textContent: item.name }),
    Nodes.tools([
      { icon: "🎯", title: "Jump to the linked sound on the soundboard", hidden: !item.sound, run: () => jumpToSound(item.sound) },
      { icon: "⚙", title: "Timer settings", cls: "gear", run: () => openTimerDlg(item) },
      { icon: "🗑", title: "Delete this timer", cls: "fdel", run: () => { if (confirm(`Delete timer "${item.name}"?`)) removeCard(item, "deleted a timer"); } },
    ], "ftools")));
  addPorts(card, "flag:" + item.id);
  card.append(...Timers.body(item, () => { edits.record("changed a timer"); save(); render(); }));
  return card;
}
// timerDone(card, late): called by Timers.watch when a timer finishes: save it, redraw (the card flashes), flash this page's tab in the top
// bar and play the linked sound (not when it finished while the page was closed: that would be long after the fact).
function timerDone(card, late) {
  save();
  render(true);
  Timers.flashTab("campaign");
  if (!late) playLinked(card);
}
function openTimerDlg(item) {
  Nodes.form({
    title: "Timer",
    fields: Timers.fields(item, { sounds: soundChoices().map(s => ({ value: s.id, label: s.label })), sections: sectionOptions() }),
    save: v => { edits.record("edited a timer"); Timers.apply(item, v); save(); render(true); },
  });
}
// newTimer(at, secId): ask for a name, add a timer card (five minutes to start from) in that section and open its settings.
function newTimer(at, secId) {
  const name = prompt("Timer name (e.g. 'The ritual completes')");
  if (!name) return;
  const card = { id: uid(), name, section: secId || "", checklist: [], triggered: false, loot: { entries: [], log: [] }, timer: { secs: 300 } };
  if (at) { card.x = Math.round(at.x - 120); card.y = Math.round(at.y - 40); } else placeCard(card, secId);
  edits.record("added a timer");
  C().items.push(card);
  save();
  render(true);
  openTimerDlg(card);
}

// ---------------------------------------------------------------- frames
// frames: the latest rectangles of all frames ({ "sec:<id>": { l, t, r, b } }, world coordinates).
let frames = {};

// frameModel(exceptCardId, exceptSectionId): the nested description Canvas.layoutFrames wants (Nodes.model); the optional arguments leave one card
// (or one whole section) out, to answer "where would the frames be without it?" when something is dropped.
const frameModel = (exceptCard = null, exceptSection = null) => Nodes.model(C().sections, C().items, { exceptCard, exceptSection });
// relayout(): re-fit every frame around its cards (cheap; called after any move or size change).
function relayout() { frames = Canvas.layoutFrames(frameModel()); }

// cardEl(item): the page element of a card.  cardsOf(items): the { obj, el } list Canvas.dragItems wants.
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
      if (moved) { edits.record("moved something"); after?.(); save(); }
      render(true);
    }
  };
}

// adoptCard(item): after a card is dropped, decide which section it belongs to NOW. The frames are computed WITHOUT this card (otherwise its own
// frame would have stretched to cover it wherever it was dropped); if the card's centre is inside a frame it joins the innermost one. Dropped in
// empty space it stays where it was (membership unchanged).
function adoptCard(item) {
  const card = cardEl(item);
  if (!card) return;
  const rects = Canvas.layoutFrames(frameModel(item.id), true),   // true = just compute, change nothing
    fid = Canvas.frameAt(rects, item.x + card.offsetWidth / 2, item.y + card.offsetHeight / 2);
  if (fid) item.section = fid.slice(4);
}
// adoptSection(sec): after a section's frame is dragged, if its centre is inside ANOTHER section's frame (not one of its own descendants) it joins that section.
function adoptSection(sec) {
  const mine = frames[`sec:${sec.id}`];
  if (!mine) return;
  const rects = Canvas.layoutFrames(frameModel(null, sec.id), true),
    fid = Canvas.frameAt(rects, (mine.l + mine.r) / 2, (mine.t + mine.b) / 2);
  if (fid) Nodes.reparent(C().sections, sec.id, fid.slice(4));
}

// placeCard(item, secId): choose a free canvas position for a card being added to section `secId`: the nearest free spot to that section's
// other cards (or to its empty frame); cards of other sections are bigger obstacles, and so are other frames.
function placeCard(item, secId) {
  const mine = new Set(C().items.filter(i => i !== item && (i.section || "") === (secId || "")).map(i => i.id)),
    rects = Canvas.itemRects(new Set([item.id])),
    grow = (r, m) => ({ l: r.l - m, t: r.t - m, r: r.r + m, b: r.b + m });
  const obstacles = rects.map(r => (mine.has(r.id) ? r : grow(r, 70)));
  Object.entries(frames).forEach(([fid, r]) => { const id = fid.slice(4); if (id !== secId && !Nodes.inside(C().sections, secId, id)) obstacles.push(grow(r, 20)); });
  const near = rects.filter(r => mine.has(r.id)),
    own = secId ? frames[`sec:${secId}`] : null;
  Object.assign(item, Canvas.freeSpot(obstacles, 240, 130, near.length ? near : own ? [own] : []));
}

// frameEl(fid, level, hue, head, getItems, after, key): builds the shell of a frame: a <div class="frame f-LEVEL"> with its id, a header holding the
// `head` elements, and link ports so the frame itself can be linked to other things. Dragging the header moves everything inside:
// `getItems()` returns the { obj, el } list.
function frameEl(fid, level, hue, head, getItems, after, key) {
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

// ---- the create menu. ONE list of "new ..." entries serves the click menu on empty canvas, a section's + button, and (with no position) the
// toolbar: createEntries(secId, at) -> [[label, function]]. `secId` is the section the new thing goes in ("" = none), `at` the world
// position it should appear at (null = a free spot).
function createEntries(secId, at) {
  return [
    ["New section", () => addSection(secId, at)],
    ["New flag", () => { newAt = at; openFlagDlg(null, secId); }],
    ["New encounter", () => openLibDlg("encounter", at, secId)],
    ["New loot table", () => openLibDlg("loot", at, secId)],
    ["New condition", () => newCondition(at, secId)],
    ["New timer", () => newTimer(at, secId)],
  ];
}

// addSection(parentId, at): ask for a name and add an empty section inside `parentId` (or at the top level). Its (empty) frame goes where the canvas
// was clicked (`at`), or in the free spot nearest to its siblings.
function addSection(parentId, at) {
  const name = prompt(parentId ? "New section name (it goes inside this one)" : "New section name (e.g. 'The Sunken Temple')");
  if (!name) return;
  const sec = { id: uid(), name, parent: parentId || "" };
  const grow = (r, m) => ({ l: r.l - m, t: r.t - m, r: r.r + m, b: r.b + m });
  const obstacles = Object.values(frames).map(r => grow(r, 24));
  const near = C().sections.filter(s => s.parent === sec.parent).map(s => frames[`sec:${s.id}`]).filter(Boolean);
  Object.assign(sec, at ? { x: Math.round(at.x), y: Math.round(at.y) } : Canvas.freeSpot(obstacles, 340, 120, near));
  edits.record("added a section");
  C().sections.push(sec);
  save();
  render();
}

// deleteSection(sec): delete a section WITHOUT deleting anything in it: its child sections and its cards move up to its own parent.
function deleteSection(sec) {
  const kids = Nodes.kids(C().sections, sec.id).length, cards = C().items.filter(c => c.section === sec.id).length;
  const up = Nodes.byId(C().sections, sec.parent)?.name;
  if ((kids || cards) && !confirm(`Delete section "${sec.name}"? Its ${[kids && kids + " section(s)", cards && cards + " card(s)"].filter(Boolean).join(" and ")} stay on the board${up ? `, inside "${up}"` : ", without a section"}.`)) return;
  edits.record("deleted a section");
  C().sections = Nodes.remove(C().sections, C().items, sec.id);
  save();
  render();
}

// openSectionDlg(sec): the section's settings (the shared Nodes.form dialog): its name and the section it sits in.
function openSectionDlg(sec) {
  Nodes.form({
    title: "Section settings",
    fields: [
      { key: "name", label: "Name", value: sec.name },
      { key: "parent", label: "Inside", type: "select", value: sec.parent || "", options: sectionOptions({ except: sec.id }), hint: "(a section can sit inside another)" },
    ],
    save: v => {
      edits.record("edited a section");
      sec.name = v.name.trim() || sec.name;
      Nodes.reparent(C().sections, sec.id, v.parent);
      save();
      render(true);
    },
  });
}

// sectionFrame(sec): the frame around everything in one section (its cards and child sections): title bar with a collapse arrow, the name, how many
// of the flags inside are triggered, and tools (+ add something here, ⚙ settings, 🗑 delete). Dragging the title bar moves everything inside; dropping
// it inside another section's frame moves the section into that one.
function sectionFrame(sec) {
  const below = C().items.filter(i => Nodes.inside(C().sections, i.section, sec.id));   // every card in this section or any section inside it
  const flags = below.filter(i => !i.encounter && !i.condition && !i.timer), triggered = flags.filter(i => i.triggered).length;
  const d = Nodes.depth(C().sections, sec.id), hue = Nodes.hue(C().sections, sec.id) ?? 260;
  const head = [
    el("button", { className: "tiny", textContent: sec.collapsed ? "▸" : "▾", title: "Collapse / expand",
      onclick: () => { edits.record(sec.collapsed ? "expanded a section" : "collapsed a section"); sec.collapsed = !sec.collapsed; save(); render(); } }),
    el(d < 2 ? "h2" : "h3", { textContent: sec.name }),
    el("span", { className: "muted", textContent: flags.length ? `${triggered}/${flags.length} triggered` : "" }),
    Nodes.tools([
      { icon: "+", title: "Add a section, flag, encounter, loot table, condition or timer here", run: ev => Canvas.popupMenu(createEntries(sec.id, null), ev.clientX, ev.clientY) },
      { icon: "⚙", title: "Section settings (rename, move inside another section)", run: () => openSectionDlg(sec) },
      { icon: "🗑", title: "Delete section (what is inside stays on the board)", run: () => deleteSection(sec) },
    ]),
  ];
  // What dragging the title bar moves: every card below, plus the empty sections below (they have no cards to carry their frame along).
  const moveSet = () => {
    const ids = [sec.id, ...Nodes.descendants(C().sections, sec.id)], out = cardsOf(below);
    ids.forEach(id => { if (!C().items.some(i => Nodes.inside(C().sections, i.section, id))) out.push({ obj: Nodes.byId(C().sections, id), el: document.querySelector(`.frame[data-fid="sec:${id}"]`) }); });
    return out;
  };
  return frameEl(`sec:${sec.id}`, ["sec", "tile", "sub"][Math.min(d, 2)], hue, head, moveSet, () => adoptSection(sec), "sec:" + sec.id);
}

// render(force): rebuild the whole board from S.campaign. Postponed during a drag (see `drag`).
function render(force = false) {
  if (!force && drag) { pendingRender = true; return; }   // never rebuild mid-drag (a card or frame being moved counts too)
  pendingRender = false;
  pruneLinks();   // forget links whose items were deleted, before anything uses them
  const root = $("#tiles");
  root.textContent = "";
  // Frames first (behind), outer ones before the ones inside them; then every card; then fit the frames to the cards.
  [...C().sections].sort((a, b) => Nodes.depth(C().sections, a.id) - Nodes.depth(C().sections, b.id)).forEach(sec => root.append(sectionFrame(sec)));
  C().items.forEach(i => root.append(flagEl(i)));
  relayout();
  markLinked();   // lit-up ports and "locked" styling from the links
  trackUnlocks();
  // Watch every card's size: when one grows or shrinks (a checklist item was added, text wrapped) the frames
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

// openFlagDlg(item, secId): open the dialog to edit `item`, or to add a new flag
// (item = null) pre-selecting a section.
function openFlagDlg(item, secId) {
  editingFlag = item;
  if (item) newAt = null;
  fform.reset();
  $("#flagDlgTitle").textContent = item ? "Edit flag" : "New flag";
  $("#deleteFlag").hidden = !item;
  $("#flagMsg").textContent = "";
  fform.section.textContent = "";
  sectionOptions().forEach(o => fform.section.append(el("option", { value: o.value, textContent: o.label })));
  fform.section.value = item ? item.section || "" : secId ?? firstSection();
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
  edits.record("deleted a flag");
  const loc = locate(editingFlag.id);
  C().items.splice(loc.i, 1);
  fdlg.close();
  save();
  render();
};

// Save: copy the form onto the flag (or create it). Checklist: kept entries keep their id and ticked
// state; entries marked deleted are dropped; text is trimmed. preventDefault stops the browser's own
// form submission (a page reload).
fform.addEventListener("submit", ev => {
  ev.preventDefault();
  edits.record(editingFlag ? "edited a flag" : "added a flag");
  addDraftCheck();   // a typed-but-not-added item still counts
  const f = fform;
  const data = {
    name: f.name.value.trim(),
    maxWidth: +f.maxWidth.value > 0 ? Math.min(1200, Math.max(140, +f.maxWidth.value)) : undefined,
    sound: f.sound.value || undefined,
    notes: f.notes.value.trim() || undefined,
    section: f.section.value || ""
  };
  const checklist = draftChecks.filter(x => !x.del && x.text.trim()).map(x => ({ id: x.id, text: x.text.trim(), done: !!x.done, sound: x.sound || undefined }));
  if (editingFlag) {
    const moved = (editingFlag.section || "") !== data.section;
    Object.assign(editingFlag, data, { checklist });
    if (moved) placeCard(editingFlag, data.section);   // moved to another section in the dialog: put the card next to that section's cards
  } else {
    const flag = { id: uid(), ...data, checklist, triggered: false, loot: { entries: [], log: [] } };
    if (newAt) { flag.x = Math.round(newAt.x - 120); flag.y = Math.round(newAt.y - 40); newAt = null; }   // where the canvas was clicked
    else placeCard(flag, data.section);   // a free spot next to the section's other cards
    C().items.push(flag);
  }
  fdlg.close();
  save();
  render(true);
});


// ------------------------------------------------------------ click menu
// A plain click on empty canvas (or on the empty inside of a frame) opens a small menu at that spot (Canvas.clickMenu in
// canvas.js, the same menu the soundboard uses): new section, flag, encounter, loot table, condition or timer, created where you clicked, inside
// the innermost section the click landed in (or in none when it landed in empty space). `createEntries` (above) builds the entries; a section's
// + button shows the same list.
Canvas.clickMenu($("#stage"), () => frames, (at, here) => createEntries(here.kind === "sec" ? here.id : "", at));

// newAt: where the flag being created should go (set by the menu; null = a free spot next to its section's cards).
let newAt = null;

// ------------------------------------------------------------ library dialog (encounters and loot tables)
// "New encounter" / "New loot table" from the menu: choose one that already exists (they are shared by every campaign) or
// make a new one, and the section it goes in. A NEW one is created empty and its tab opens on it so it can be filled in.
// An encounter becomes an encounter card; a loot table becomes a flag that rolls on the table (loot.source = "table:<id>").
const LIB = {
  encounter: { title: "Encounter", noun: "encounter", list: () => S.encounters || [], api: "/api/encounters", page: "encounters",
    card: r => ({ id: uid(), name: "", encounter: r.id, checklist: [], triggered: false, loot: { entries: [], log: [] } }) },
  loot: { title: "Loot table", noun: "loot table", list: () => S.loots || [], api: "/api/loots", page: "loot",
    card: r => ({ id: uid(), name: r.name, checklist: [], triggered: false, loot: { entries: [], log: [], source: "table:" + r.id } }) },
};
const edlg = $("#encDlg"),
  eform = $("#encForm");
let encAt = null, encKind = "encounter";
function openLibDlg(kind, at, secId) {
  encKind = kind;
  encAt = at;
  const k = LIB[kind];
  $("#encDlgTitle").textContent = k.title;
  $("#encPickLabel").textContent = k.title;
  eform.enc.textContent = "";
  eform.enc.append(el("option", { value: "", textContent: `(new ${k.noun})` }), ...k.list().map(e => el("option", { value: e.id, textContent: e.name })));
  eform.section.textContent = "";
  sectionOptions().forEach(o => eform.section.append(el("option", { value: o.value, textContent: o.label })));
  eform.section.value = secId || "";
  eform.newName.value = "";
  eform.newName.hidden = false;
  edlg.showModal();
}
eform.enc.addEventListener("change", () => { eform.newName.hidden = !!eform.enc.value; });
eform.addEventListener("submit", async ev => {
  ev.preventDefault();
  const k = LIB[encKind];
  let id = eform.enc.value, fresh = false;
  try {
    if (!id) {
      const n = await api(k.api, "POST", { name: eform.newName.value.trim() || `New ${k.noun}` });
      k.list().push(n);
      id = n.id;
      fresh = true;
      UI.libraryChanged();   // the Browse lists on the other pages show it at once
    }
    const card = k.card(k.list().find(r => r.id === id));
    card.section = eform.section.value || "";
    if (encAt) { card.x = Math.round(encAt.x - 120); card.y = Math.round(encAt.y - 40); } else placeCard(card, card.section);
    edits.record(`added ${encKind === "encounter" ? "an encounter" : "a loot table"} card`);
    C().items.push(card);
    edlg.close();
    save();
    render(true);
    if (fresh) window.parent.postMessage({ type: "goto", page: k.page, path: `/_/${k.page}?id=${id}` }, location.origin);
  } catch (e) { alert(e.message); }
});

// ------------------------------------------------------------ loot dialog
// The reward popup for one flag. Where its rewards come from is the flag's loot.source:
//   (none)         the flag's OWN list of entries, edited right here;
//   "table:<id>"   a loot table made on the Loot tab (or with "New loot table…" here), rolled by weight; the table is shared,
//                  so editing it changes every flag that uses it;
//   "rarity:<r>"   a random magic item of that rarity from the Open5e item list (each item equally likely).
// A table (or own list) is a list of entries, each with a WEIGHT. Think of a die with as many faces as the total weight:
// an entry of weight 5 owns 5 faces. Rolling picks a face at random, and the entry that owns it is the reward (so
// heavier entries come up more often). Each entry's "range" column shows which faces it owns.
const ldlg = $("#lootDlg");
// lootItem: the flag whose table is open. lastRolls: the result lines of the latest Roll, shown above the history.
let lootItem = null,
  lastRolls = [];

const sourceOf = item => item.loot.source || "";
const tableOf = item => (S.loots || []).find(t => "table:" + t.id === sourceOf(item));
// lootEntries(item): the entries this flag rolls on (its own, or the chosen table's), in the shape the dialog draws.
function lootEntries(item) {
  const src = sourceOf(item);
  if (src.startsWith("table:")) return (tableOf(item)?.entries || []).map(e => ({ ...e, name: LootTables.label(e), readonly: true }));
  if (src.startsWith("rarity:")) return [];
  return item.loot.entries;
}

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

// refreshLoots(): fetch the campaign's loot tables again (they can be changed on the Loot tab or in the pop-up below).
async function refreshLoots() { S.loots = await api("/api/loots"); }

// fillSources(): the "Rewards from" menu: own list, each loot table, and a random item of each rarity.
function fillSources() {
  const sel = $("#lootSource");
  sel.textContent = "";
  sel.append(el("option", { value: "", textContent: "This flag's own list" }),
    ...(S.loots || []).map(t => el("option", { value: "table:" + t.id, textContent: "Loot table: " + t.name })),
    ...["common", "uncommon", "rare", "very rare", "legendary", "artifact"].map(r => el("option", { value: "rarity:" + r, textContent: "Random " + r + " magic item" })));
  const src = sourceOf(lootItem);
  if (src.startsWith("table:") && !tableOf(lootItem)) sel.append(el("option", { value: src, textContent: "(deleted loot table)" }));
  sel.value = src;
}

// drawLoot(): redraw the whole popup: the table (range, name, weight, chance, note, delete), the latest
// roll results and the saved history.
function drawLoot() {
  const src = sourceOf(lootItem), own = !src, byRarity = src.startsWith("rarity:");
  const { rows, total } = lootRanges(lootEntries(lootItem));
  $("#lootTitle").textContent = `Rewards: ${lootItem.name}`;
  $("#lootAddRow").hidden = !own;
  $("#lootTable").hidden = byRarity;
  $("#editLootBtn").hidden = !src.startsWith("table:") || !tableOf(lootItem);
  $("#lootHelp").textContent = byRarity ? `Rolling picks one ${src.slice(7)} magic item at random from the Open5e list (every item equally likely).`
    : own ? "Each entry's weight is how many faces of the die it owns. The table is rolled as a d{total}."
      : "This flag rolls on a shared loot table. Use Edit table… to change it; the weights are how many faces of the die each entry owns.";
  const table = $("#lootTable");
  table.textContent = "";
  table.append(el("tr", {}, ...["Range", "Reward", "Weight", "Chance", "Note", ""].map(t => el("th", { textContent: t }))));
  rows.forEach(({ entry, lo, hi, w }) => {
    // The weight box edits the entry in place, then everything is redrawn (the ranges shift).
    const wbox = el("input", { type: "number", min: 1, step: 1, value: w, className: "inum", disabled: !!entry.readonly });
    wbox.onchange = () => { entry.weight = Math.max(1, Math.floor(+wbox.value || 1)); save(); drawLoot(); };
    table.append(el("tr", {},
      el("td", { textContent: lo === hi ? String(lo) : `${lo}–${hi}` }),
      el("td", { textContent: entry.name }),
      el("td", {}, wbox),
      el("td", { textContent: ((w / total) * 100).toFixed(w / total < 0.1 ? 1 : 0) + "%" }),
      el("td", { className: "muted", textContent: entry.note || "" }),
      el("td", {}, entry.readonly ? "" : el("button", { className: "danger tiny", textContent: "✕", title: "Remove this reward", onclick: () => {
        lootItem.loot.entries = lootItem.loot.entries.filter(x => x !== entry);
        save();
        drawLoot();
      } }))));
  });
  if (!rows.length) table.append(el("tr", {}, el("td", { colSpan: 6, className: "muted", textContent: own ? "No rewards yet. Add some below." : "This table has no entries yet." })));
  $("#lootResult").textContent = "";
  lastRolls.forEach(t => $("#lootResult").append(el("div", { textContent: t })));
  const log = $("#lootLog");
  log.textContent = "";
  lootItem.loot.log.forEach(l => log.append(el("li", {}, el("span", { textContent: l.text }), el("span", { className: "muted", textContent: timeText(l.at) }))));
}

// openLoot(item): open the popup for this flag.
async function openLoot(item) {
  lootItem = item;
  lastRolls = [];
  try { await refreshLoots(); } catch (_) { /* keep the copy we have */ }
  fillSources();
  drawLoot();
  ldlg.showModal();
}

// Choosing where the rewards come from.
$("#lootSource").onchange = () => {
  const v = $("#lootSource").value;
  if (v) lootItem.loot.source = v; else delete lootItem.loot.source;
  lastRolls = [];
  save();
  drawLoot();
};

// "Add" button / Enter: append an entry from the three boxes (the flag's own list).
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

// "Roll" button: roll `Rolls` times. For an own list or a table, each roll picks a random whole number from 1 to the total
// weight and finds the entry whose range contains it. For a rarity, each roll picks a random item of that rarity from the
// Open5e list. The result lines are shown and also stored in the flag's history (newest first, last 30 kept).
$("#rollLootBtn").onclick = async () => {
  const src = sourceOf(lootItem);
  const count = Math.max(1, Math.min(20, Math.floor(+$("#lootCount").value || 1)));
  lastRolls = [];
  const note = text => { lastRolls.push(text); lootItem.loot.log.unshift({ text, at: Date.now() }); };   // unshift = insert at the front
  if (src.startsWith("rarity:")) {
    const rarity = src.slice(7), { rows } = await LootTables.items();
    for (let k = 0; k < count; k++) {
      const m = LootTables.pickRarity(rows, rarity);
      if (!m) { lastRolls = [`No ${rarity} items in the list.`]; break; }
      note(`🎲 ${rarity}: ${m.name} (${m.type})`);
    }
  } else {
    const { rows, total } = lootRanges(lootEntries(lootItem));
    if (!rows.length) { lastRolls = ["Add at least one reward first."]; drawLoot(); return; }
    for (let k = 0; k < count; k++) {
      const r = 1 + Math.floor(Math.random() * total);
      const hit = rows.find(row => r >= row.lo && r <= row.hi);
      note(`🎲 d${total} → ${r}: ${hit.entry.name}${hit.entry.note ? " (" + hit.entry.note + ")" : ""}`);
    }
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
// When the popup closes, redraw the board so the 🎁 count on the card is up to date.
ldlg.addEventListener("close", () => render(true));

// ---- a loot table made or edited right here: the Loot tab's editor in its small form (builder.js + loottable.js).
const nldlg = $("#lootNewDlg");
// editLootTable(id): show the small editor on table `id`; "Use this table" points the open flag at it.
function editLootTable(id, title) {
  $("#lootNewTitle").textContent = title;
  $("#lootNewName").hidden = true;
  $("#useLootBtn").hidden = false;
  $("#useLootBtn").onclick = () => { nldlg.close(); };
  const host = $("#lootNewHost");
  host.textContent = "";
  Builder.mount(host, LootTables.config({ compact: true, lockId: id }));
  nldlg.dataset.id = id;
  nldlg.showModal();
}
$("#newLootBtn").onclick = () => {
  $("#lootNewTitle").textContent = "New loot table";
  $("#lootNewName").hidden = false;
  $("#useLootBtn").hidden = true;
  $("#lootNewHost").textContent = "";
  $("#newLootName").value = "";
  nldlg.dataset.id = "";
  nldlg.showModal();
};
$("#createLootBtn").onclick = async () => {
  const t = await api("/api/loots", "POST", { name: $("#newLootName").value.trim() || "New loot table" });
  editLootTable(t.id, `Loot table: ${t.name}`);
  nldlg.dataset.id = t.id;
};
$("#editLootBtn").onclick = () => { const t = tableOf(lootItem); if (t) editLootTable(t.id, `Loot table: ${t.name}`); };
// Closing the small editor (Close or Use this table): remember the new/edited table and, for a new one or "Use", point the flag at it.
nldlg.addEventListener("close", async () => {
  const id = nldlg.dataset.id;
  await refreshLoots();
  if (id && lootItem && (!$("#useLootBtn").hidden)) { lootItem.loot.source = "table:" + id; save(); }
  fillSources();
  drawLoot();
});

// ------------------------------------------------------------ conditions and triggers
// A CONDITION card gathers the nodes linked INTO it and unlocks the nodes linked OUT of it once enough of them are done.
//   item.condition = { groups: [ { id, name, tiers: [ { id, need, label } ] } ] }
// Each group counts the incoming links assigned to it (link.group = the group's id; none = the first group); a link counts when its
// source is done. A tier is reached when the count is at least its `need` ("3 of 8 = marginal success, 5 of 8 = full success"). So
// one card can hold several separate condition groupings, each with its own tiers.
// A link OUT of a condition card carries link.when = { group, tier } (none = the first group's highest tier): it is satisfied, and
// its target unlocked, once that tier is reached. When that first happens the target card and the wire flash, the same
// highlight used when a jump from the Encounters tab lands on a card.
const isCond = item => !!item?.condition;
const condKey = item => "flag:" + item.id;
const topTier = g => [...g.tiers].sort((a, b) => b.need - a.need)[0];
// visiting: condition cards being evaluated right now, so a loop of conditions (A feeds B feeds A) counts as not met instead of
// recursing forever.
const visiting = new Set();

// groupOf(item, link): the group an incoming link counts toward (its own choice, else the first group).
const groupOf = (item, l) => item.condition.groups.find(g => g.id === l.group) || item.condition.groups[0];

// linkSatisfied(link): is the thing this link waits for done? An ordinary source: isDone. A condition card: the chosen tier is reached.
function linkSatisfied(l) {
  const src = lookup(l.from)?.obj;
  if (!isCond(src)) return isDone(l.from);
  const g = src.condition.groups.find(x => x.id === l.when?.group) || src.condition.groups[0];
  const tier = g && (g.tiers.find(t => t.id === l.when?.tier) || topTier(g));
  return !!tier && groupState(src, g).done >= tier.need;
}

// groupState(item, group) -> { done, total, best }: links counted, links in the group, and the highest tier reached (or null).
function groupState(item, g) {
  if (visiting.has(item.id)) return { done: 0, total: 0, best: null };
  visiting.add(item.id);
  try {
    const mine = C().links.filter(l => l.to === condKey(item) && groupOf(item, l) === g);
    const done = mine.filter(linkSatisfied).length;
    const best = [...g.tiers].filter(t => done >= t.need).sort((a, b) => b.need - a.need)[0] || null;
    return { done, total: mine.length, best };
  } finally { visiting.delete(item.id); }
}

// condDone(item): every group (that has tiers) has reached its highest tier. This is what isDone() says for a condition card.
function condDone(item) {
  const gs = item.condition.groups.filter(g => g.tiers.length);
  return gs.length > 0 && gs.every(g => groupState(item, g).done >= topTier(g).need);
}

// ---- the unlock highlight. After every render, links out of condition cards that are satisfied NOW but were not at the previous
// render are "newly unlocked": they go in `flashing` (link id -> time it stops) and drawLinks() makes the wire and the target card
// flash until then. lastSat is null on the first render, so opening the page flashes nothing.
let lastSat = null;
const flashing = new Map();
function trackUnlocks() {
  const sat = new Set(C().links.filter(linkSatisfied).map(l => l.id));
  if (lastSat) C().links.forEach(l => { if (sat.has(l.id) && !lastSat.has(l.id) && isCond(lookup(l.from)?.obj)) flashing.set(l.id, Date.now() + 2200); });
  lastSat = sat;
}

// newCondition(at, secId): ask for a name, add a condition card (one group with two tiers to start from) and open its settings.
function newCondition(at, secId) {
  const name = prompt("Condition name (e.g. 'Defeat the guardians')");
  if (!name) return;
  const card = { id: uid(), name, section: secId || "", checklist: [], triggered: false, loot: { entries: [], log: [] },
    condition: { groups: [{ id: uid(), name: "Conditions", tiers: [{ id: uid(), need: 1, label: "Marginal success" }, { id: uid(), need: 2, label: "Full success" }] }] } };
  if (at) { card.x = Math.round(at.x - 130); card.y = Math.round(at.y - 40); } else placeCard(card, secId);
  edits.record("added a condition");
  C().items.push(card);
  save();
  render(true);
  openCondDlg(card);
}

// condEl(item): the card. Per group: its name, how many conditions are met out of how many are linked, a progress bar and
// its tiers (reached ones lit, the best one in bold). Click the card (or ⚙) for the settings; 🗑 removes it (links to it go too).
function condEl(item) {
  const card = cardShell(item, "cond" + (condDone(item) ? " done" : ""));
  card.title = "A condition: link nodes into it, and link nodes out of it to unlock them. Click for its settings.";
  card.append(el("div", { className: "ftitle" },
    el("span", { className: "fmark", textContent: "⚖" }),
    el("span", { className: "fname", textContent: item.name }),
    Nodes.tools([
      { icon: "⚙", title: "Condition settings: groups, tiers and what each link is for", cls: "gear", run: () => openCondDlg(item) },
      { icon: "🗑", title: "Delete this condition", cls: "fdel", run: () => { if (confirm(`Delete condition "${item.name}"?`)) removeCard(item, "deleted a condition"); } },
    ], "ftools")));
  addPorts(card, condKey(item));
  item.condition.groups.forEach(g => {
    const st = groupState(item, g);
    card.append(el("div", { className: "cgroup" },
      el("div", { className: "cghead" }, el("span", { textContent: g.name }), el("b", { textContent: `${st.done}/${st.total}` })),
      el("div", { className: "fprog" }, el("div", { style: `width:${st.total ? (st.done / st.total) * 100 : 0}%` })),
      el("div", { className: "ctiers" }, ...[...g.tiers].sort((a, b) => a.need - b.need).map(t =>
        el("span", { className: "ctier" + (st.done >= t.need ? " on" : "") + (st.best === t ? " best" : ""), textContent: `${t.label} · ${t.need}`, title: `Reached when ${t.need} of the linked conditions are met` })))));
  });
  if (!item.condition.groups.length) card.append(el("div", { className: "muted", textContent: "No groups yet: open the settings." }));
  onCardClick(card, () => openCondDlg(item));
  return card;
}

// ---- the condition settings dialog. Everything is edited on a COPY (draft) and written back by Save, so Cancel discards it.
//   Groups: name, and tiers (how many conditions must be met, and what to call it).
//   Inputs: every node linked INTO this card, and which group it counts toward.
//   Outputs: every node linked OUT of this card, and which group and tier unlocks it.
const cdlg = $("#condDlg");
let condItem = null, draft = null;
function openCondDlg(item) {
  condItem = item;
  const key = condKey(item);
  draft = {
    name: item.name,
    groups: item.condition.groups.map(g => ({ id: g.id, name: g.name, tiers: g.tiers.map(t => ({ ...t })) })),
    ins: Object.fromEntries(C().links.filter(l => l.to === key).map(l => [l.id, groupOf(item, l)?.id || ""])),
    outs: Object.fromEntries(C().links.filter(l => l.from === key).map(l => {
      const g = item.condition.groups.find(x => x.id === l.when?.group) || item.condition.groups[0];
      const t = g && (g.tiers.find(x => x.id === l.when?.tier) || topTier(g));
      return [l.id, g && t ? g.id + ":" + t.id : ""];
    })),
  };
  drawCond();
  cdlg.showModal();
}
function drawCond() {
  const body = $("#condBody");
  body.textContent = "";
  const name = el("input", { value: draft.name, placeholder: "Condition name" });
  name.oninput = () => (draft.name = name.value);
  body.append(el("label", {}, "Name ", name));
  body.append(el("h3", { textContent: "Groups and tiers" }),
    el("p", { className: "muted", textContent: "A group counts the nodes linked into this card. A tier is reached when that many of them are done (for example 3 for marginal success, 5 for full success)." }));
  draft.groups.forEach(g => {
    const gname = el("input", { value: g.name, placeholder: "Group name" });
    gname.oninput = () => (g.name = gname.value);
    const tiers = el("div", { className: "tiers" });
    g.tiers.forEach(t => {
      const need = el("input", { type: "number", min: 1, step: 1, value: t.need, className: "inum", title: "How many conditions must be met" });
      need.onchange = () => (t.need = Math.max(1, Math.floor(+need.value || 1)));
      const label = el("input", { value: t.label, placeholder: "e.g. Full success" });
      label.oninput = () => (t.label = label.value);
      tiers.append(el("div", { className: "row subrow" }, need, label,
        el("button", { type: "button", className: "danger tiny", textContent: "✕", onclick: () => { g.tiers = g.tiers.filter(x => x !== t); drawCond(); } })));
    });
    body.append(el("fieldset", { className: "subsfield" }, el("legend", { textContent: "Group" }),
      el("div", { className: "row" }, gname, el("button", { type: "button", className: "danger tiny", textContent: "Remove group", onclick: () => { draft.groups = draft.groups.filter(x => x !== g); drawCond(); } })),
      tiers, el("button", { type: "button", className: "tiny", textContent: "+ Tier", onclick: () => { g.tiers.push({ id: uid(), need: (g.tiers.at(-1)?.need || 0) + 1, label: "" }); drawCond(); } })));
  });
  body.append(el("button", { type: "button", textContent: "+ Group", onclick: () => { draft.groups.push({ id: uid(), name: "Conditions", tiers: [{ id: uid(), need: 1, label: "Success" }] }); drawCond(); } }));

  const key = condKey(condItem);
  const gopts = () => draft.groups.map(g => el("option", { value: g.id, textContent: g.name || "(unnamed group)" }));
  const ins = C().links.filter(l => l.to === key);
  body.append(el("h3", { textContent: "Inputs: what each linked node counts toward" }));
  if (!ins.length) body.append(el("p", { className: "muted", textContent: "Nothing is linked into this card yet. Drag from a node's output circle onto it." }));
  ins.forEach(l => {
    const sel = el("select", {}, ...gopts());
    sel.value = draft.ins[l.id] || draft.groups[0]?.id || "";
    sel.onchange = () => (draft.ins[l.id] = sel.value);
    body.append(el("div", { className: "row subrow" }, el("span", { className: "grow", textContent: lookup(l.from)?.name || "?" }), sel));
  });
  const outs = C().links.filter(l => l.from === key);
  body.append(el("h3", { textContent: "Outputs: what unlocks each linked node" }));
  if (!outs.length) body.append(el("p", { className: "muted", textContent: "Nothing is linked out of this card yet. Drag from its output circle onto a node to unlock it." }));
  outs.forEach(l => {
    const sel = el("select", {});
    draft.groups.forEach(g => g.tiers.forEach(t => sel.append(el("option", { value: g.id + ":" + t.id, textContent: `${g.name || "group"}: ${t.label || "tier"} (${t.need})` }))));
    sel.value = draft.outs[l.id];
    if (sel.value !== draft.outs[l.id]) sel.selectedIndex = 0;
    sel.onchange = () => (draft.outs[l.id] = sel.value);
    draft.outs[l.id] = sel.value;
    body.append(el("div", { className: "row subrow" }, el("span", { className: "grow", textContent: lookup(l.to)?.name || "?" }), sel));
  });
}
$("#condForm").addEventListener("submit", ev => {
  ev.preventDefault();
  const item = condItem;
  edits.record("changed a condition");   // so Undo can put the links' group and tier choices back
  item.name = draft.name.trim() || item.name;
  // Tiers need a label; a group with no tiers could never be reached, so it is dropped with a warning in the card's text.
  item.condition.groups = draft.groups.map(g => ({ id: g.id, name: g.name.trim() || "Conditions", tiers: g.tiers.map(t => ({ id: t.id, need: Math.max(1, Math.floor(+t.need || 1)), label: t.label.trim() || `${t.need} met` })) }));
  C().links.forEach(l => {
    if (l.id in draft.ins) l.group = draft.ins[l.id];
    if (l.id in draft.outs && draft.outs[l.id]) { const [group, tier] = draft.outs[l.id].split(":"); l.when = { group, tier }; }
  });
  cdlg.close();
  save();
  render(true);
});

// ------------------------------------------------------------ campaign links
// Links are cables between ANY two items on the board, to show how things depend on each other: "this
// flag unlocks that section", "finishing this checklist entry opens that section". They are stored in
// S.campaign.links as { id, from, to } where from/to are item KEYS, a kind and an id joined by a colon:
//     sec:<id>            a section (its frame)        flag:<id>        a card (flag, encounter, condition, timer)
//     chk:<id>            one checklist entry
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

// ---- undo / redo for everything on this page
// EVERY change can be undone and redone, with Ctrl+Z / Ctrl+Y (Cmd on a Mac) or the ↶ ↷ buttons in the toolbar: creating or
// deleting a section or card, renaming, moving, editing in a dialog, ticking a checklist, making or removing a link ...
// undo.js keeps the command stack (see its header). save() reports every change to it (edits.commit()), so nothing needs its own
// undo code; the code that makes a change may name it first with edits.record("deleted a section") to get a good message. Here we
// only say how to take a snapshot of the page (the whole campaign as JSON text) and how to put one back: the campaign is
// replaced, tidied by normalize(), saved and redrawn (a link to an item that no longer exists is dropped by pruneLinks()).
const edits = Undo.create({
  snapshot: () => JSON.stringify(C()),   // the whole campaign: sections, cards and links
  restore: text => {
    S.campaign = JSON.parse(text);
    normalize();
    save();          // (edits ignores the commit this makes while it is restoring)
    render(true);
  },
  onChange: () => {   // grey out the toolbar buttons when there is nothing to undo / redo
    $("#undoBtn").disabled = !edits.canUndo();
    $("#redoBtn").disabled = !edits.canRedo();
  }
});
$("#undoBtn").onclick = () => { const l = edits.undo(); Undo.toast(l ? "Undid: " + l : "Nothing to undo"); };
$("#redoBtn").onclick = () => { const l = edits.redo(); Undo.toast(l ? "Redid: " + l : "Nothing to redo"); };
$("#undoBtn").disabled = $("#redoBtn").disabled = true;   // an empty history to start with
Undo.bindKeys(edits);

// parseKey(key): "flag:abc" -> { kind: "flag", id: "abc" } (the id is everything after the first colon).
function parseKey(key) {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
}
// lookup(key): the data behind a key ({ kind, obj, name }), or null if it no longer exists.
function lookup(key) {
  const { kind, id } = parseKey(key);
  if (kind === "sec") { const o = C().sections.find(x => x.id === id); return o && { kind, obj: o, name: o.name }; }
  if (kind === "flag") { const loc = locate(id); return loc && { kind, obj: loc.item, name: loc.item.name }; }
  if (kind === "chk") {
    for (const i of C().items) {
      const c = i.checklist.find(x => x.id === id);
      if (c) return { kind, obj: c, name: c.text };
    }
  }
  return null;
}
// isDone(key): has the party finished this item? flag = triggered (a condition card: every group at its top tier; a timer: it has finished);
// checklist entry = ticked; section = it holds cards (anywhere inside it) and every one of them is done.
function isDone(key) {
  const it = lookup(key);
  if (!it) return false;
  if (it.kind === "flag") return isCond(it.obj) ? condDone(it.obj) : it.obj.timer ? !!it.obj.timer.done : !!it.obj.triggered;
  if (it.kind === "chk") return !!it.obj.done;
  const below = C().items.filter(i => Nodes.inside(C().sections, i.section, it.obj.id));   // a section
  return below.length > 0 && below.every(i => isDone("flag:" + i.id));
}
// pruneLinks(): drop links that point at items that no longer exist, links from an item to itself, and
// duplicates. Runs on every render, so deleting anything (a flag, a section, a checklist entry...) cleans up.
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
    if (isCond(lookup(l.to)?.obj)) return;   // links INTO a condition card are its conditions, not things it waits for
    if (!linkSatisfied(l)) (waiting[l.to] ||= []).push(lookup(l.from)?.name || "?");
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
  edits.record("made a link");   // remember the state first, so it can be undone
  C().links.push({ id: uid(), from, to });
  save();
  render(true);
  // Linking into a condition card that has several groups, or out of one that has several tiers, needs a choice (which group
  // does this node count toward? which tier unlocks this output?): open its settings so it can be made right away.
  const t = lookup(to)?.obj, f = lookup(from)?.obj;
  const ask = (isCond(t) && t.condition.groups.length > 1 && t) || (isCond(f) && f.condition.groups.reduce((n, g) => n + g.tiers.length, 0) > 1 && f);
  if (ask) openCondDlg(ask);
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
  const temp = Cables.tempPath($("#tempLayer"));
  // under(e): the linkable item beneath the pointer. closest() walks up from the element under the pointer
  // to the nearest ancestor with a data-lid, so a checklist row wins over the flag that contains it.
  const under = e => document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-lid]");
  const clear = () => document.querySelectorAll(".linktarget").forEach(n => n.classList.remove("linktarget"));
  let moved = false;
  const move = e => {
    const w = Canvas.toWorld(e.clientX, e.clientY);   // pointer position in world coordinates (accounts for pan and zoom)
    if (Math.hypot(w.x - x0, w.y - y0) > 5) moved = true;
    temp.setAttribute("d", Cables.live({ x: x0, y: y0 }, w));   // follows the pointer even behind the start
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
      edits.record("re-routed a link");
      // Re-route: point the existing link at the new item (or just drop it if that exact link already exists).
      if (C().links.some(l => l !== existing && l.from === from && l.to === to)) C().links = C().links.filter(l => l !== existing);
      else { existing.to = to; delete existing.group; }   // (a new target: the old group choice no longer applies)
    } else if (!moved && !cancelled && existing) {
      edits.record("removed a link");
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

// sectionHue(key): the colour (hue) of the top-level section an item belongs to, the same hue its frame uses; null when it has no section.
// Cables take the colour of the section they START in, so you can tell at a glance where a cable comes from.
function sectionHue(key) {
  const { kind, id } = parseKey(key);
  const secId = kind === "sec" ? id : kind === "flag" ? locate(id)?.item.section : kind === "chk" ? C().items.find(i => i.checklist.some(c => c.id === id))?.section : null;
  return secId ? Nodes.hue(C().sections, secId) : null;
}

// drawLinks(): redraw every cable. Positions are world coordinates (Canvas.posIn), so cables pan and zoom
// with the board and only need redrawing when something moves or changes size. Each link is two paths: the
// visible cable (solid green if its source is done, dashed otherwise) and a wider invisible one on top
// that is easy to click; clicking it removes the link. A link is skipped while either end is hidden (for
// example inside a collapsed section).
function drawLinks() {
  const layer = $("#linkLayer");
  layer.textContent = "";
  // `shell(port)`: the rectangle a cable must leave from / arrive at: the flag card (or frame) the port belongs to. A port on a
  // checklist row belongs to the whole flag card, so the cable starts outside the card.
  const rect = n => { const p = Canvas.posIn(n); return { l: p.x, r: p.x + n.offsetWidth, t: p.y, b: p.y + n.offsetHeight }; };
  const shell = port => { const o = port.closest("[data-lid]"); return rect(o.closest(".flag") || o); };
  const links = [];
  C().links.forEach(l => {
    // This link's own output circle and input square (each link has its own, found by data-link).
    const a = document.querySelector(`.lp-out[data-link="${l.id}"]`),
      b = document.querySelector(`.lp-in[data-link="${l.id}"]`);
    if (!a?.offsetParent || !b?.offsetParent) return;   // either end hidden (a collapsed section): draw nothing
    const pa = Canvas.posIn(a),
      pb = Canvas.posIn(b),
      cs = shell(a),
      ct = shell(b);
    links.push({
      l,
      a: { x: pa.x + a.offsetWidth / 2, y: pa.y + a.offsetHeight / 2 },   // centre of the output circle
      b: { x: pb.x - 1, y: pb.y + b.offsetHeight / 2 },                   // left edge of the input square
      sx: cs.r + 12, ex: ct.l - 12, cs, ct,
    });
  });
  // Obstacles: the flag cards. All cables are routed together (Cables.paths, the same code as the soundboard's chains), so
  // cables that share a road run side by side as lanes instead of stacking on top of each other.
  const cards = [...document.querySelectorAll(".flag")].filter(n => n.offsetParent).map(rect);
  const ds = Cables.paths(links, cards, Canvas.WORLD, Canvas.WORLD);
  links.forEach(({ l }, n) => {
    // Cables.pair adds the visible cable (solid green if its source is done, dashed otherwise) and a wider invisible one on top
    // that is easy to click; clicking it removes the link.
    const hue = sectionHue(l.from);
    const vis = Cables.pair(layer, ds[n], {
      cls: "link " + (linkSatisfied(l) ? "sat" : "wait"),
      stroke: hue == null ? undefined : `hsl(${hue} 70% 62%)`,   // the colour of the section the cable starts in (solid = satisfied, dashed = waiting)
      title: `${lookup(l.from)?.name} → ${lookup(l.to)?.name}  (click to remove)`,
      onRemove: () => {
        edits.record("removed a link");
        C().links = C().links.filter(x => x !== l);
        save();
        render(true);
      },
    });
    // A link out of a condition card that was JUST unlocked: its wire and its target card flash (the same flash that marks a card
    // reached from another tab) until `until`. The page is redrawn often, so the flash is re-applied on every draw until it ends.
    const until = flashing.get(l.id) || 0;
    if (until > Date.now()) {
      const target = document.querySelector(`[data-lid="${l.to}"]`);
      vis.classList.add("flash");
      target?.classList.add("flash");
      setTimeout(() => { vis.classList.remove("flash"); target?.classList.remove("flash"); }, until - Date.now());
    }
  });
}
// scheduleDraw(): redraw the cables at the next screen repaint (requestAnimationFrame also merges
// several requests in one frame into a single redraw).
function scheduleDraw() { requestAnimationFrame(drawLinks); }

// ------------------------------------------------------------ toolbar & boot
$("#addSectionBtn").onclick = () => addSection("", null);
// The toolbar offers the same things as the click menu on the canvas; with no click position, a new card goes into the first section
// and finds a free spot.
// (the toolbar and the menus share createEntries, above)
$("#addFlagBtn").onclick = () => { newAt = null; openFlagDlg(null, firstSection()); };
$("#addEncounterBtn").onclick = () => openLibDlg("encounter", null, firstSection());
$("#addLootTableBtn").onclick = () => openLibDlg("loot", null, firstSection());
$("#addConditionBtn").onclick = () => newCondition(null, firstSection());
$("#addTimerBtn").onclick = () => newTimer(null, firstSection());
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
      await addLibrary(S);
      myRevision = S.revision;
      normalize();
      edits.reset();
      render(true);
    }
    const loc = locate(id);
    if (!loc) return;
    const closed = Nodes.chain(C().sections, loc.item.section).filter(x => x.collapsed);
    if (closed.length) { closed.forEach(x => (x.collapsed = false)); save(); render(true); }
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
  // Turn #stage / #world into the pan-and-zoom canvas; frame all the sections on the first visit.
  const restored = Canvas.mount($("#stage"), $("#world"), "campaign");
  S = await api("/api/state");
  await addLibrary(S);
  myRevision = S.revision;
  normalize();
  edits.reset();   // the loaded campaign is where the history starts
  render();
  if (!restored) Canvas.fit();
  // The clock for timer cards: counts down, finishes them (flash, tab flash, sound) even if they ran out while the page was closed.
  Timers.watch({ cards: () => C().items.filter(i => i.timer), onComplete: timerDone, redraw: () => { save(); render(true); } });
  setInterval(pollState, 5000);
})();
