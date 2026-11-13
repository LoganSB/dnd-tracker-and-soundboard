"use strict";
// encounters.js - the Encounters tab: search monsters (Open5e), build an encounter, rate its difficulty for the
// party, then load it into the initiative tracker or put it on the campaign tracker as a card.
//
// The editor, the save logic and the search panel are shared with the Loot tab: builder.js (the editor) and finder.js
// (the search). This file only says what is specific to encounters: the columns, the difficulty rating, and the buttons.
//
// MONSTER SEARCH makes no API calls while you type (see finder.js): the page downloads one list of every monster, which
// the server keeps on disk and rebuilds from Open5e at most monthly.
//
// SERVER ROUTES (all in encounters.py)
//   GET  /api/monsters/index                               the list of all monsters {docs, xp, m:[[slug,name,type,cr,ac,hp,dex,book]]}
//   GET/POST /api/encounters, PUT/DELETE /api/encounters/<id>   the campaign's encounters
//   POST /api/encounters/<id>/load {mode, again}           add it to the initiative order -> {initiative, added}
//   POST /api/encounters/<id>/place {section}              put it on the campaign tracker -> {section, item}
//   GET/POST/DELETE /api/encounters/<id>/maps[/<map id>]   the encounter's maps (pictures, PDFs): see maps.js
//   GET  /api/party?active=1                               the party (levels, for the difficulty rating)
//   GET  /api/state                                        only to list the campaign tracker's sections
// A page can be opened on one encounter with  /_/encounters?id=<id>  (the campaign cards' edit button does this).

const { h, api, stored, store } = UI;
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

let party = [], sections = [];
const sizeLvl = { size: stored("enc.size", null), level: stored("enc.level", null) };   // party size and level, when typed by hand

function partyInfo() {
  const lv = party.map(p => p.level).filter(Boolean);
  return { size: sizeLvl.size ?? (party.length || 4), level: sizeLvl.level ?? (lv.length ? Math.round(lv.reduce((a, b) => a + b, 0) / lv.length) : 1), fromParty: !!party.length };
}

const preview = slug => window.open("/monster/" + slug, "dmmonster", "width=540,height=760");
let monsterNote = "Loading the monster list…";

// monsterPanel(add): the monster search (Finder.panel) filled from the downloaded list. `add(row)` is called by the + buttons.
function monsterPanel(add) {
  const panel = Finder.panel({
    rows: [], note: () => monsterNote, placeholder: "Type any part of a name (typos are fine), or cr 5",
    hint: "Matches while you type, with or without typos, from the Open5e monster list (includes the Kobold Press books). Try: gobln, drag, undead cr 5+, cr 1/2.",
    label: m => `${m.name} (CR ${crText(m.cr)})`, sub: m => `${m.type} · ${m.docTitle}`,
    num: { label: "CR", get: m => m.cr },
    columns: [{ label: "Monster", text: m => m.name }, { label: "CR", text: m => crText(m.cr) }, { label: "Type", text: m => m.type },
      { label: "AC / HP", text: m => `${m.ac ?? "?"} / ${m.hp ?? "?"}` }, { label: "Book", text: m => m.docTitle }],
    onAdd: add, preview: m => preview(m.slug),
    // The type and book menus need the list to know their choices, so the panel is told them when the list arrives.
    filters: [{ key: "type", label: "Type", all: "Any type", options: [], get: m => m.type }, { key: "doc", label: "Book", all: "Any book", options: [], get: m => m.doc }],
  });
  Finder.loadIndex("/api/monsters/index", ([slug, name, type, cr, ac, hp, bonus, doc], d) => {
    const t = type ? type[0].toUpperCase() + type.slice(1).toLowerCase() : "";
    return { slug, name, type: t, cr, ac, hp, bonus, doc, docTitle: d.docs[doc] || doc, xp: d.xp[cr] || 0, extraText: `${t} ${d.docs[doc] || ""}` };
  }, () => { monsterNote = "Downloading the monster list from Open5e (first time only)…"; panel.redraw(); })
    .then(({ rows, d }) => {
      panel.setOptions("type", [...new Set(rows.map(m => m.type).filter(Boolean))].sort().map(t => [t, t]));
      panel.setOptions("doc", Object.entries(d.docs).sort((a, b) => a[1].localeCompare(b[1])));
      panel.setRows(rows);
    })
    .catch(e => { monsterNote = "Could not load the monster list: " + e.message; panel.redraw(); });
  return panel;
}

const config = {
  api: "/api/encounters", noun: "encounter", list: "monsters", box: "enc", title: "Encounter", finderTitle: "Find monsters",
  head: ["How many", "Monster", "CR", "AC", "HP", "Init +"],
  row: (l, ctx) => [ctx.num(l, "count"), l.name, crText(l.cr), ctx.num(l, "ac"), ctx.num(l, "hp"), ctx.num(l, "bonus")],
  preview: l => (l.slug ? preview(l.slug) : null),
  finder: monsterPanel,
  // Maps (pictures and PDFs) attached to the encounter: upload, view, download, delete (maps.js, shared with the campaign tracker).
  attach: rec => Maps.panel(rec),
  addEntry: (rec, m) => {
    const line = rec.monsters.find(l => l.slug === m.slug);
    if (line) line.count = Math.min(50, line.count + 1);
    else rec.monsters.push({ slug: m.slug, name: m.name, count: 1, hp: m.hp, ac: m.ac, cr: m.cr, xp: m.xp, bonus: m.bonus, doc: m.doc });
  },
  // The rating: party size and level (from the campaign's party, or typed) against the DMG thresholds.
  summary: e => {
    const info = partyInfo();
    const size = h("input", { type: "number", min: 1, max: 12, value: info.size, className: "inum", title: "Party size" });
    const level = h("input", { type: "number", min: 1, max: 20, value: info.level, className: "inum", title: "Party level" });
    const verdict = h("div", { className: "verdict" });
    const show = () => {
      const s = Math.max(1, +size.value || 1), l = Math.max(1, Math.min(20, +level.value || 1)), r = rate(e.monsters, s, l);
      verdict.className = "verdict " + r.label.toLowerCase();
      verdict.replaceChildren(h("b", { textContent: r.label }),
        h("span", { textContent: ` · ${r.xp.toLocaleString()} XP, ${r.adjusted.toLocaleString()} adjusted for ${r.n} monster${r.n === 1 ? "" : "s"}` }),
        h("div", { className: "muted", textContent: `Party of ${s} at level ${l}: easy ${r.thresholds[0]}, medium ${r.thresholds[1]}, hard ${r.thresholds[2]}, deadly ${r.thresholds[3]}` }));
    };
    size.onchange = level.onchange = () => { sizeLvl.size = +size.value; sizeLvl.level = +level.value; store("enc.size", sizeLvl.size); store("enc.level", sizeLvl.level); show(); };
    show();
    return h("div", {}, h("div", { className: "row" }, h("span", { textContent: "Party of" }), size, h("span", { textContent: "at level" }), level,
      h("span", { className: "muted", textContent: info.fromParty ? "(from the campaign's party; change to try other sizes)" : "(no party in this campaign: set it by hand)" })), verdict);
  },
  actions: (e, ctx) => {
    const secSel = h("select", {}, Nodes.options(sections).map(o => h("option", { value: o.value, textContent: o.label })));
    // Loading: the server refuses to add the same encounter twice unless told "again" (see load_encounter in encounters.py).
    const load = async (mode, again) => {
      await ctx.flush();
      const r = await api(`/api/encounters/${e.id}/load`, "POST", { mode, again });
      if (!r.added && mode !== "replace") {
        if (confirm(`"${e.name}" is already in the combat. Add another set of its monsters?`)) return load(mode, true);
        ctx.msg.say("Already in the combat: nothing added");
        return r;
      }
      ctx.msg.say("Loaded into the initiative tracker");
      return r;
    };
    const popOut = async () => {
      const w = window.open("/tracker", "dmtracker", "width=460,height=720");   // opened first: a pop-up must start from the click
      const r = await load("append");
      try { w?.location.reload(); } catch (_) { /* window closed */ }
      return r;
    };
    return [
      h("button", { className: "primary", textContent: "Start new combat", title: "Replace the initiative order with this encounter and the party", onclick: () => load("replace") }),
      h("button", { textContent: "Add to current combat", onclick: () => load("append") }),
      h("button", { textContent: "Load & pop out tracker", onclick: popOut }),
      secSel,
      h("button", { textContent: "Put on campaign tracker", onclick: async () => {
        await ctx.flush();
        const r = await api(`/api/encounters/${e.id}/place`, "POST", { section: secSel.value });
        // Same hop as the campaign page's 🎯 buttons use for the soundboard: show the tab and highlight the card.
        parent.postMessage({ type: "goto", page: "campaign", node: r.item }, location.origin);
        await ctx.reload();
      } }),
      e.onTracker?.length ? h("span", { className: "ok", textContent: "On this campaign's tracker: " + e.onTracker.join(", ") }) : h("span", { className: "muted", textContent: "Not on this campaign's tracker" }),
      e.campaigns?.length ? h("span", { className: "muted", textContent: "Used in: " + e.campaigns.join(", ") }) : null,
    ];
  },
};

root.replaceChildren(h("h1", { textContent: "⚔ Encounters" }), h("div", { id: "encMount" }), h("div", { id: "encBrowse" }));
// The browse list sits below everything else; Open selects that encounter in the editor above and scrolls up to it.
const browse = Browse.mount(document.getElementById("encBrowse"), "encounter", r => { mounted.select(r.id); scrollTo({ top: 0 }); });
const mounted = Builder.mount(document.getElementById("encMount"), { ...config, initialId: new URLSearchParams(location.search).get("id"), onChange: () => browse.refresh() });

// The party and the campaign's sections are only needed for the rating and the section menu.
async function loadContext() {
  [party, sections] = await Promise.all([api("/api/party?active=1"), api("/api/state").then(s => s.campaign?.sections || [])]);
}
loadContext().then(() => mounted.reload());

// Other tabs change encounters (a card created on the campaign tracker): reload when this tab is shown again.
addEventListener("message", ev => {
  if (ev.data?.type === "shown" && !document.querySelector("input:focus,textarea:focus")) loadContext().then(() => { mounted.reload(); browse.refresh(); });
});
