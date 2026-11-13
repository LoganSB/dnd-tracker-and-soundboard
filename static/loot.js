"use strict";
// loot.js - the Loot tab: build loot tables from Open5e magic items, then put one on the campaign tracker as a flag that rolls
// on it. The page is the Encounters tab's twin: builder.js is the editor, finder.js the search, loottable.js says what is
// specific to loot (columns, weights and chances, the Roll button).
//
// SERVER ROUTES (all in encounters.py)
//   GET  /api/items/index                          every magic item {docs, rarities, m:[[slug,name,type,rarity,attunement,book]]}
//   GET/POST /api/loots, PUT/DELETE /api/loots/<id>   the campaign's loot tables
//   POST /api/loots/<id>/place {section}           put it on the campaign tracker -> {section, item}
//   GET  /api/state                                only to list the campaign tracker's sections
// A page can be opened on one table with  /_/loot?id=<id>.
const { h, api } = UI;
let sections = [];
document.getElementById("loot").replaceChildren(h("h1", { textContent: "🎁 Loot tables" }), h("div", { id: "lootMount" }), h("div", { id: "lootBrowse" }));
// The browse list sits below everything else; Open selects that table in the editor above and scrolls up to it.
const browse = Browse.mount(document.getElementById("lootBrowse"), "loot", r => { mounted.select(r.id); scrollTo({ top: 0 }); });
const mounted = Builder.mount(document.getElementById("lootMount"), LootTables.config({
  sections: () => sections, initialId: new URLSearchParams(location.search).get("id"), onChange: () => browse.refresh() }));
const loadSections = () => api("/api/state").then(s => { sections = s.campaign?.sections || []; });
loadSections().then(() => mounted.reload());
// Tables are changed from other tabs too (the campaign tracker's loot pop-up): reload when this tab is shown again.
addEventListener("message", ev => {
  if (ev.data?.type === "shown" && !document.querySelector("input:focus,textarea:focus")) loadSections().then(() => { mounted.reload(); browse.refresh(); });
});
