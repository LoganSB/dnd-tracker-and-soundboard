"use strict";
// encounters.js - the Encounters tab: search monsters (Open5e), build an encounter, rate its difficulty for the
// party, then load it into the initiative tracker or put it on the campaign tracker as a tile.
//
// SERVER ROUTES (all in encounters.py)
//   GET  /api/monsters?q=&type=&doc=&crMin=&crMax=&page=   search Open5e: {count, page, pages, items:[summary]}
//   GET  /api/monsters/documents                            the books to filter by
//   GET/POST /api/encounters, PUT/DELETE /api/encounters/<id>   the campaign's encounters
//   POST /api/encounters/<id>/load {mode}                   add it to the initiative order
//   POST /api/encounters/<id>/tile {tile}                   put it on the campaign tracker
//   GET  /api/party?active=1                                the party (levels, for the difficulty rating)
//   GET  /api/state                                         only to list the campaign tracker's tiles
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
let search = { q: "", type: "", doc: "", crMin: "", crMax: "", page: 1 };
let results = null;           // the latest search answer
let books = [];
const sizeLvl = { size: stored("enc.size", null), level: stored("enc.level", null) };   // party size and level, when typed by hand

async function load() {
  [encounters, party, books] = await Promise.all([api("/api/encounters"), api("/api/party?active=1"), api("/api/monsters/documents").catch(() => [])]);
  tiles = (await api("/api/state")).campaign?.tiles || [];
  const want = new URLSearchParams(location.search).get("id");
  if (!current || !encounters.some(e => e.id === current)) current = encounters.find(e => e.id === want)?.id || encounters[0]?.id || null;
  draw();
}

const cur = () => encounters.find(e => e.id === current);

// save(): store the open encounter, a moment after the last edit.
function save() {
  const e = cur();
  if (!e) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api(`/api/encounters/${e.id}`, "PUT", { name: e.name, notes: e.notes, monsters: e.monsters }).catch(err => alert(err.message)), 400);
}

async function runSearch() {
  const p = new URLSearchParams(Object.entries(search).filter(([, v]) => v !== "" && v != null));
  try { results = await api("/api/monsters?" + p); } catch (e) { results = { error: e.message }; }
  drawResults();
}

const resultsBox = h("div"), editorBox = h("div");
const msg = status();

// ---------------------------------------------------------------- search side
function searchPanel() {
  const q = h("input", { type: "search", placeholder: "Monster name", value: search.q });
  const type = h("select", {}, h("option", { value: "", textContent: "Any type" }),
    ["Aberration", "Beast", "Celestial", "Construct", "Dragon", "Elemental", "Fey", "Fiend", "Giant", "Humanoid", "Monstrosity", "Ooze", "Plant", "Undead"].map(t => h("option", { value: t, textContent: t })));
  const doc = h("select", {}, h("option", { value: "", textContent: "Any book" }), books.map(b => h("option", { value: b.slug, textContent: b.title })));
  const crMin = h("input", { type: "number", min: 0, max: 30, step: "any", placeholder: "CR from", className: "inum" });
  const crMax = h("input", { type: "number", min: 0, max: 30, step: "any", placeholder: "to", className: "inum" });
  type.value = search.type; doc.value = search.doc; crMin.value = search.crMin; crMax.value = search.crMax;
  const go = () => { search = { q: q.value.trim(), type: type.value, doc: doc.value, crMin: crMin.value, crMax: crMax.value, page: 1 }; runSearch(); };
  q.onkeydown = ev => { if (ev.key === "Enter") go(); };
  return box("enc-search", "Find monsters",
    h("div", { className: "row" }, q, type, doc, crMin, crMax, h("button", { className: "primary", textContent: "Search", onclick: go })),
    h("p", { className: "muted", textContent: "Searches Open5e, which includes the Kobold Press books (Tome of Beasts and more). Add a monster to the open encounter with +." }),
    resultsBox);
}

function drawResults() {
  if (!results) { resultsBox.replaceChildren(h("p", { className: "muted", textContent: "Search to see monsters." })); return; }
  if (results.error) { resultsBox.replaceChildren(h("p", { className: "bad", textContent: results.error })); return; }
  const pager = h("div", { className: "row" },
    h("button", { textContent: "◀", disabled: results.page <= 1, onclick: () => { search.page = results.page - 1; runSearch(); } }),
    h("span", { className: "muted", textContent: `Page ${results.page} of ${results.pages || 1} · ${results.count} monsters` }),
    h("button", { textContent: "▶", disabled: results.page >= results.pages, onclick: () => { search.page = results.page + 1; runSearch(); } }));
  resultsBox.replaceChildren(
    dataTable({
      key: "monsters", rows: results.items, empty: "No monsters match.",
      columns: [
        { label: "Monster", text: m => m.name }, { label: "CR", text: m => crText(m.cr), filter: true },
        { label: "Type", text: m => m.type, filter: true }, { label: "AC / HP", text: m => `${m.ac ?? "?"} / ${m.hp ?? "?"}` },
        { label: "Book", text: m => m.docTitle || m.doc, filter: true },
      ],
      actions: m => [h("button", { className: "primary", textContent: "+", title: "Add to the open encounter", onclick: () => addMonster(m) }),
        h("button", { textContent: "📖", title: "Stat block", onclick: () => preview(m.slug) })],
    }), pager);
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
    try { await api(`/api/encounters/${e.id}/load`, "POST", { mode }); msg.say("Loaded into the initiative tracker"); } catch (err) { msg.say(err.message, true); }
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
      try { const r = await api(`/api/encounters/${e.id}/tile`, "POST", { tile: tileSel.value }); msg.say(`Added to tile "${r.tile}"`); await load(); } catch (err) { msg.say(err.message, true); }
    } }), onTracker), msg));
  refresh();
}

function draw() {
  root.replaceChildren(h("h1", { textContent: "⚔ Encounters" }), editorBox, searchPanel(), );
  drawEditor();
  drawResults();
}

// Other tabs change encounters (a tile created on the campaign tracker): reload when this tab is shown again.
addEventListener("message", ev => { if (ev.data?.type === "shown" && !document.querySelector("input:focus,textarea:focus")) load(); });
load();
