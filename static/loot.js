"use strict";
// loot.js - the Loot tab: build loot tables from Open5e magic items, then put one on the campaign tracker as a flag that rolls
// on it. The page is the Encounters tab's twin: builder.js is the editor, finder.js the search, loottable.js says what is
// specific to loot (columns, weights and chances, the Roll button).
//
// SERVER ROUTES (all in encounters.py)
//   GET  /api/items/index                          every magic item {docs, rarities, m:[[slug,name,type,rarity,attunement,book]]}
//   GET/POST /api/loots, PUT/DELETE /api/loots/<id>   the campaign's loot tables
//   POST /api/loots/<id>/tile {tile}               put it on the campaign tracker -> {tile, item}
//   GET  /api/state                                only to list the campaign tracker's tiles
// A page can be opened on one table with  /_/loot?id=<id>.
const { h, api } = UI;
let tiles = [];
const mounted = (() => {
  document.getElementById("loot").replaceChildren(h("h1", { textContent: "🎁 Loot tables" }), h("div", { id: "lootMount" }));
  return Builder.mount(document.getElementById("lootMount"), LootTables.config({ tiles: () => tiles, initialId: new URLSearchParams(location.search).get("id") }));
})();
const loadTiles = () => api("/api/state").then(s => { tiles = s.campaign?.tiles || []; });
loadTiles().then(() => mounted.reload());
// Tables are changed from other tabs too (the campaign tracker's loot pop-up): reload when this tab is shown again.
addEventListener("message", ev => {
  if (ev.data?.type === "shown" && !document.querySelector("input:focus,textarea:focus")) loadTiles().then(() => mounted.reload());
});
