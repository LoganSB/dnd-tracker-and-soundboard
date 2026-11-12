"use strict";
// encounters.js - the Encounters tab: search monsters (Open5e), build an encounter, rate its difficulty for the
// party, then load it into the initiative tracker or put it on the campaign tracker as a tile.
//
// MONSTER SEARCH makes no API calls while you type. The page downloads one list of every monster (the server keeps
// it on disk and rebuilds it from Open5e at most monthly) and matches it here, generously: single-letter typos and
// partial words work, a regular expression works, and so does the challenge rating ("cr 5", "cr 1/2", "3-5", "5+").
//
// SERVER ROUTES (all in encounters.py)
//   GET  /api/monsters/index                               the list of all monsters {docs, xp, m:[[slug,name,type,cr,ac,hp,dex,book]]}
//   POST /api/monsters/index/refresh                       fetch the list again (the server refuses more than once a day)
//   GET/POST /api/encounters, PUT/DELETE /api/encounters/<id>   the campaign's encounters
//   POST /api/encounters/<id>/load {mode}                  add it to the initiative order
//   POST /api/encounters/<id>/tile {tile}                  put it on the campaign tracker -> {tile, item}
//   GET  /api/party?active=1                               the party (levels, for the difficulty rating)
//   GET  /api/state                                        only to list the campaign tracker's tiles
// A page can be opened on one encounter with  /_/encounters?id=<id>  (the campaign tiles' edit button does this).

const root = document.getElementById("enc");

// Experience thresholds per character level: [easy, medium, hard, deadly] (Dungeon Master's Guide).
const THRESH = [null, [25, 50, 75, 100], [50, 100, 150, 200], [75, 150, 225, 400], [125, 250, 375, 500], [250, 500, 750, 1100],
  [300, 600, 900, 1400], [350, 750, 1100, 1700], [450, 900, 1400, 2100], [550, 1100, 1600, 2400], [600, 1200, 1900, 2800],
  [800, 1600, 2400, 3600], [1000, 2000, 3000, 4500], [1100, 2200, 3400, 5100], [1250, 2500, 3800, 5700], [1400, 2800, 4300, 6400],
  [1600, 3200, 4800, 7200], [2000, 3900, 5900, 8800], [2100, 4200, 6300, 9500], [2400, 4900, 7300, 10900], [2800, 5700, 8500, 12700]];
const MULT = [1, 1.5, 2, 2.5, 3, 4];           // the DMG's multiplier steps, by number of monsters
const crText = cr => ({ 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" }[cr] ?? String(cr));

// rate(lines, size, level) -> { xp, adjusted, label, thresholds } for a party of `size` characters all of `level`.
function rate(lines, size, level) {
  const n = lines.reduce((s, l) => s + l.count, 0),
    xp = lines.reduce((s, l) => s + (l.xp || 0) * l.count, 0);
  let step = n <= 1 ? 0 : n === 2 ? 1 : n <= 6 ? 2 : n <= 10 ? 3 : n <= 14 ? 4 : 5;
  if (size < 3) step = Math.min(5, step + 1); else if (size > 5) step = Math.max(0, step - 1);   // small / large parties
  const adjusted = Math.round(xp * MULT[step]);
  const t = (THRESH[Math.max(1, Math.min(20, level))] || THRESH[1]).map(v => v * size);
  const label = !n ? "empty" : adjusted >= t[3] ? "Deadly" : adjusted >= t[2] ? "Hard" : adjusted >= t[1] ? "Medium" : adjusted >= t[0] ? "Easy" : "Trivial";
  return { xp, adjusted, label, thresholds: t, n };
}

let encounters = [], current = null, tiles = [], party = [], saveTimer = null;
let mons = [];                // every monster, from /api/monsters/index (see loadIndex)
let books = {};               // book slug -> title
let xpTable = {};
let indexNote = "Loading the monster list…";
let filt = { q: "", type: "", doc: "", crMin: "", crMax: "" }, shown = 100;
const sizeLvl = { size: stored("enc.size", null), level: stored("enc.level", null) };   // party size and level, when typed by hand

async function load() {
  [encounters, party] = await Promise.all([api("/api/encounters"), api("/api/party?active=1")]);
  tiles = (await api("/api/state")).campaign?.tiles || [];
  const want = new URLSearchParams(location.search).get("id");
  if (!current || !encounters.some(e => e.id === current)) current = encounters.find(e => e.id === want)?.id || encounters[0]?.id || null;
  draw();
  if (!mons.length) loadIndex();
}

const cur = () => encounters.find(e => e.id === current);

// save(): store the open encounter, a moment after the last edit. flush() stores it right now if an edit is waiting; the
// buttons that use the saved encounter (load into the tracker, put on the campaign tracker) call it first.
function put() {
  const e = cur();
  return e ? api(`/api/encounters/${e.id}`, "PUT", { name: e.name, notes: e.notes, monsters: e.monsters }) : Promise.resolve();
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; put().catch(err => alert(err.message)); }, 400);
}
async function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await put();
}

// loadIndex(): fetch the monster list once. The server answers 202 while it is still downloading it for the very first
// time (two Open5e calls); ask again every few seconds until it is there.
async function loadIndex() {
  try {
    const r = await fetch("/api/monsters/index");
    if (r.status === 202) { indexNote = "Downloading the monster list from Open5e (first time only)…"; drawResults(); setTimeout(loadIndex, 3000); return; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const d = await r.json();
    books = d.docs; xpTable = d.xp;
    mons = d.m.map(([slug, name, type, cr, ac, hp, bonus, doc]) => {
      const t = type ? type[0].toUpperCase() + type.slice(1).toLowerCase() : "";
      const words = name.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
      return { slug, name, type: t, cr, ac, hp, bonus, doc, docTitle: books[doc] || doc, xp: xpTable[cr] || 0, lname: name.toLowerCase(), words,
        extra: (t + " " + (books[doc] || "")).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    indexNote = "";
    draw();
  } catch (e) { indexNote = "Could not load the monster list: " + e.message; drawResults(); }
}

// ---- matching -------------------------------------------------------------------------------------------------
// dist(a, b): edit distance counting a swap of two neighbouring letters as ONE edit (so "gobiln" is one typo from "goblin").
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

// crTest(text): "5" -> exactly 5, "1/2" -> one half, "3-5" -> 3 to 5, "5+" -> 5 or more; null when text is not a CR.
function crTest(text) {
  const num = t => (t.includes("/") ? (+t.split("/")[0]) / (+t.split("/")[1]) : +t);
  let m;
  if ((m = text.match(/^(\d+(?:\.\d+)?|\d+\/\d+)$/))) { const v = num(m[1]); return c => c === v; }
  if ((m = text.match(/^(\d+(?:\.\d+)?|\d+\/\d+)-(\d+(?:\.\d+)?|\d+\/\d+)$/))) { const lo = num(m[1]), hi = num(m[2]); return c => c >= lo && c <= hi; }
  if ((m = text.match(/^(\d+(?:\.\d+)?|\d+\/\d+)\+$/))) { const lo = num(m[1]); return c => c >= lo; }
  return null;
}

// parseQuery(text) -> { words: [name pieces], cr: function or null }. A word like "cr5", "cr:1/2" or "cr 3-5" (cr then a
// value), or a bare number, is the challenge rating; everything else is part of the name.
function parseQuery(text) {
  const parts = text.toLowerCase().split(/[\s,]+/).filter(Boolean), words = [];
  let cr = null;
  for (let i = 0; i < parts.length; i++) {
    let t = parts[i];
    const m = t.match(/^cr:?(.*)$/);
    if (m) { t = m[1] || parts[++i] || ""; if (!t) continue; const f = crTest(t); if (f) { cr = f; continue; } t = parts[i]; }
    const f = crTest(t);
    if (f) cr = f; else words.push(t);
  }
  return { words, cr };
}

// score(m, word): how well one typed word matches a monster; lower is better, null = no match.
//   0 a name word starts with it   1 it appears inside the name   2 it is a regular expression that matches the name
//   3 a name word is one typo away (compared with the same number of letters, plus or minus one)
//   4 it matches the monster's type or book
function score(m, w) {
  if (m.words.some(x => x.startsWith(w))) return 0;
  if (m.lname.includes(w)) return 1;
  if (/[\\^$.*+?()[\]{}|]/.test(w)) { try { if (new RegExp(w, "i").test(m.name)) return 2; } catch (_) { /* not a valid expression: plain text below */ } }
  if (w.length >= 3) {
    for (const x of m.words) for (const n of [w.length - 1, w.length, w.length + 1]) if (n > 0 && dist(w, x.slice(0, n)) <= 1) return 3;
  }
  if (m.extra.some(x => x.startsWith(w))) return 4;
  return null;
}

// find(filters) -> monsters matching the typed text and the menus, best matches first (alphabetical when tied or when
// nothing is typed, which is the default list: every monster, A to Z).
function find(f) {
  const q = parseQuery(f.q), lo = f.crMin === "" ? -1 : +f.crMin, hi = f.crMax === "" ? 99 : +f.crMax;
  const out = [];
  for (const m of mons) {
    if ((f.type && m.type !== f.type) || (f.doc && m.doc !== f.doc) || m.cr < lo || m.cr > hi || (q.cr && !q.cr(m.cr))) continue;
    let s = 0;
    for (const w of q.words) { const x = score(m, w); if (x == null) { s = null; break; } s += x; }
    if (s != null) out.push([s, m]);
  }
  // Typed text: best match first, then shorter names ("Goblin" before "Chaos-Spawn Goblin"), then A to Z.
  return out.sort((a, b) => a[0] - b[0] || (q.words.length ? a[1].name.length - b[1].name.length : 0) || a[1].name.localeCompare(b[1].name)).map(x => x[1]);
}

const resultsBox = h("div"), editorBox = h("div");
const msg = status();
const label = m => `${m.name} (CR ${crText(m.cr)})`;

// ---------------------------------------------------------------- search side
function searchPanel() {
  const q = h("input", { type: "search", placeholder: "Type any part of a name (typos are fine), or cr 5", value: filt.q, autocomplete: "off", className: "grow" });
  const sug = h("div", { className: "suggest", hidden: true });
  const types = [...new Set(mons.map(m => m.type).filter(Boolean))].sort();
  const type = h("select", {}, h("option", { value: "", textContent: "Any type" }), types.map(t => h("option", { value: t, textContent: t })));
  const doc = h("select", {}, h("option", { value: "", textContent: "Any book" }),
    Object.entries(books).sort((a, b) => a[1].localeCompare(b[1])).map(([slug, title]) => h("option", { value: slug, textContent: title })));
  const crMin = h("input", { type: "number", min: 0, max: 30, step: "any", placeholder: "CR from", className: "inum" });
  const crMax = h("input", { type: "number", min: 0, max: 30, step: "any", placeholder: "to", className: "inum" });
  type.value = filt.type; doc.value = filt.doc; crMin.value = filt.crMin; crMax.value = filt.crMax;
  let pick = -1, timer = null;
  const update = () => { filt = { q: q.value.trim(), type: type.value, doc: doc.value, crMin: crMin.value, crMax: crMax.value }; shown = 100; drawResults(); };
  // Suggestions: the best few names for what is typed so far, each with its CR. Click (or arrows + Enter) fills the box.
  const showSug = () => {
    const best = q.value.trim() ? find({ ...filt, q: q.value.trim(), type: "", doc: "", crMin: "", crMax: "" }).slice(0, 8) : [];
    pick = -1;
    sug.replaceChildren(...best.map((m, i) => { const b = h("button", { type: "button", textContent: label(m) }, h("span", { className: "muted", textContent: `  ${m.type} · ${m.docTitle}` })); b.onmousedown = ev => { ev.preventDefault(); q.value = m.name; sug.hidden = true; update(); }; return b; }));
    sug.hidden = !best.length;
  };
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { update(); showSug(); }, 60); };
  q.onblur = () => { sug.hidden = true; };
  q.onkeydown = ev => {
    const items = [...sug.children];
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); pick = (pick + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % (items.length || 1); items.forEach((b, i) => b.classList.toggle("on", i === pick)); }
    else if (ev.key === "Enter" && pick >= 0 && items[pick]) { ev.preventDefault(); items[pick].onmousedown(ev); }
    else if (ev.key === "Escape") sug.hidden = true;
  };
  [type, doc, crMin, crMax].forEach(x => (x.onchange = update));
  return box("enc-search", "Find monsters",
    h("div", { className: "row" }, h("div", { className: "sugwrap grow" }, q, sug), type, doc, crMin, crMax),
    h("p", { className: "muted", textContent: "Matches while you type, with or without typos, from the Open5e monster list (includes the Kobold Press books). Try: gobln, drag, undead cr 5+, cr 1/2." }),
    resultsBox);
}

function drawResults() {
  if (!mons.length) { resultsBox.replaceChildren(h("p", { className: indexNote.startsWith("Could") ? "bad" : "muted", textContent: indexNote })); return; }
  const list = find(filt);
  const rows = list.slice(0, shown).map(m => h("tr", {},
    h("td", { textContent: m.name }), h("td", { textContent: crText(m.cr) }), h("td", { textContent: m.type }),
    h("td", { textContent: `${m.ac ?? "?"} / ${m.hp ?? "?"}` }), h("td", { textContent: m.docTitle }),
    h("td", { className: "acts" }, h("button", { className: "primary", textContent: "+", title: "Add to the open encounter", onclick: () => addMonster(m) }),
      h("button", { textContent: "📖", title: "Stat block", onclick: () => preview(m.slug) }))));
  resultsBox.replaceChildren(
    h("p", { className: "muted", textContent: `${list.length} of ${mons.length} monsters` + (filt.q ? "" : ", A to Z") }),
    h("table", { className: "loot" }, h("thead", {}, h("tr", {}, ["Monster", "CR", "Type", "AC / HP", "Book", ""].map(t => h("th", { textContent: t })))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colSpan: 6, className: "muted", textContent: "No monsters match." })))),
    list.length > shown ? h("button", { textContent: `Show more (${list.length - shown} left)`, onclick: () => { shown += 200; drawResults(); } }) : null);
}

function preview(slug) { window.open("/monster/" + slug, "dmmonster", "width=540,height=760"); }

function addMonster(m) {
  const e = cur();
  if (!e) return msg.say("Create an encounter first", true);
  const line = e.monsters.find(l => l.slug === m.slug);
  if (line) line.count = Math.min(50, line.count + 1);
  else e.monsters.push({ slug: m.slug, name: m.name, count: 1, hp: m.hp, ac: m.ac, cr: m.cr, xp: m.xp, bonus: m.bonus, doc: m.doc });
  save(); drawEditor();
}

// ---------------------------------------------------------------- encounter side
function partyInfo() {
  const lv = party.map(p => p.level).filter(Boolean);
  return { size: sizeLvl.size ?? (party.length || 4), level: sizeLvl.level ?? (lv.length ? Math.round(lv.reduce((a, b) => a + b, 0) / lv.length) : 1), fromParty: !!party.length };
}

function drawEditor() {
  const e = cur();
  const picker = h("select", {}, encounters.map(x => h("option", { value: x.id, textContent: x.name })));
  picker.value = current || "";
  picker.onchange = () => { current = picker.value; drawEditor(); };
  const make = h("button", { textContent: "+ New encounter", onclick: async () => {
    const name = prompt("Encounter name", "New encounter");
    if (!name) return;
    const n = await api("/api/encounters", "POST", { name });
    encounters.push(n); current = n.id; drawEditor();
  } });
  if (!e) { editorBox.replaceChildren(box("enc-edit", "Encounter", h("div", { className: "row" }, make), h("p", { className: "muted", textContent: "No encounters in this campaign yet." }))); return; }

  const name = h("input", { value: e.name, className: "grow", oninput: () => { e.name = name.value; save(); } });
  const notes = h("textarea", { rows: 2, placeholder: "Notes (tactics, terrain, treasure)", value: e.notes || "", oninput: () => { e.notes = notes.value; save(); } });
  const info = partyInfo();
  const size = h("input", { type: "number", min: 1, max: 12, value: info.size, className: "inum", title: "Party size" });
  const level = h("input", { type: "number", min: 1, max: 20, value: info.level, className: "inum", title: "Party level" });
  const verdict = h("div", { className: "verdict" });
  const refresh = () => {
    const s = Math.max(1, +size.value || 1), l = Math.max(1, Math.min(20, +level.value || 1)), r = rate(e.monsters, s, l);
    verdict.className = "verdict " + r.label.toLowerCase();
    verdict.replaceChildren(h("b", { textContent: r.label }),
      h("span", { textContent: ` · ${r.xp.toLocaleString()} XP, ${r.adjusted.toLocaleString()} adjusted for ${r.n} monster${r.n === 1 ? "" : "s"}` }),
      h("div", { className: "muted", textContent: `Party of ${s} at level ${l}: easy ${r.thresholds[0]}, medium ${r.thresholds[1]}, hard ${r.thresholds[2]}, deadly ${r.thresholds[3]}` }));
  };
  size.onchange = level.onchange = () => { sizeLvl.size = +size.value; sizeLvl.level = +level.value; store("enc.size", sizeLvl.size); store("enc.level", sizeLvl.level); refresh(); };

  const num = (line, key, w) => { const i = h("input", { type: "number", value: line[key] ?? "", className: "inum", title: key }); i.onchange = () => { line[key] = i.value === "" ? null : +i.value; save(); refresh(); }; return i; };
  const rows = e.monsters.map(l => h("tr", {},
    h("td", {}, num(l, "count")), h("td", { textContent: l.name }), h("td", { textContent: crText(l.cr) }),
    h("td", {}, num(l, "ac")), h("td", {}, num(l, "hp")), h("td", {}, num(l, "bonus")),
    h("td", { className: "acts" }, l.slug ? h("button", { textContent: "📖", title: "Stat block", onclick: () => preview(l.slug) }) : null,
      h("button", { className: "tiny danger", textContent: "✕", onclick: () => { e.monsters = e.monsters.filter(x => x !== l); save(); drawEditor(); } }))));
  const table = h("table", { className: "loot" }, h("thead", {}, h("tr", {}, ["How many", "Monster", "CR", "AC", "HP", "Init +", ""].map(t => h("th", { textContent: t })))),
    h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colSpan: 7, className: "muted", textContent: "No monsters yet: search on the left and press +." }))));

  const tileSel = h("select", {}, tiles.length ? tiles.map(t => h("option", { value: t.id, textContent: t.name })) : h("option", { value: "", textContent: "(first tile)" }));
  const onTracker = e.onTracker?.length ? h("span", { className: "ok", textContent: "On the campaign tracker: " + e.onTracker.join(", ") }) : h("span", { className: "muted", textContent: "Not on the campaign tracker yet" });
  const run = mode => async () => {
    try { await flush(); await api(`/api/encounters/${e.id}/load`, "POST", { mode }); msg.say("Loaded into the initiative tracker"); } catch (err) { msg.say(err.message, true); }
  };
  const popOut = async () => {
    const w = window.open("/tracker", "dmtracker", "width=460,height=720");   // opened first: a pop-up must start from the click
    await run("replace")();
    try { w?.location.reload(); } catch (_) { /* window closed */ }
  };
  editorBox.replaceChildren(box("enc-edit", "Encounter",
    h("div", { className: "row" }, picker, make),
    h("div", { className: "row" }, name, h("button", { className: "danger", textContent: "Delete", onclick: async () => {
      if (!confirm(`Delete encounter "${e.name}"?`)) return;
      await api(`/api/encounters/${e.id}`, "DELETE"); encounters = encounters.filter(x => x !== e); current = encounters[0]?.id || null; drawEditor();
    } })),
    notes, table,
    h("div", { className: "row" }, h("span", { textContent: "Party of" }), size, h("span", { textContent: "at level" }), level,
      h("span", { className: "muted", textContent: info.fromParty ? "(from the campaign's party; change to try other sizes)" : "(no party in this campaign: set it by hand)" })),
    verdict,
    h("div", { className: "row" },
      h("button", { className: "primary", textContent: "Load into initiative", title: "Start a new combat with this encounter and the party", onclick: run("replace") }),
      h("button", { textContent: "Add to current combat", onclick: run("append") }),
      h("button", { textContent: "Load & pop out tracker", onclick: popOut })),
    h("div", { className: "row" }, tileSel, h("button", { textContent: "Put on campaign tracker", onclick: async () => {
      try {
      await flush();
      const r = await api(`/api/encounters/${e.id}/tile`, "POST", { tile: tileSel.value });
      // Same hop as the campaign page's 🎯 buttons use for the soundboard: ask the shell to show the tab and highlight the card.
      parent.postMessage({ type: "goto", page: "campaign", node: r.item }, location.origin);
      await load();
    } catch (err) { msg.say(err.message, true); }
    } }), onTracker), msg));
  refresh();
}

function draw() {
  root.replaceChildren(h("h1", { textContent: "⚔ Encounters" }), editorBox, searchPanel());
  drawEditor();
  drawResults();
}

// Other tabs change encounters (a tile created on the campaign tracker): reload when this tab is shown again.
addEventListener("message", ev => { if (ev.data?.type === "shown" && !document.querySelector("input:focus,textarea:focus")) load(); });
load();
