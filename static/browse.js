"use strict";
// browse.js - a searchable, filterable list of the campaign's ENCOUNTERS or LOOT TABLES, with an Open button on each row.
// It is a UI.dataTable (so it searches exactly like every other list: partial words, typos, regular expressions) filled with
// text that includes what is INSIDE each one, so searching "goblin" finds every encounter that has goblins and "boots" every
// table that can drop boots.
//
// Browse.mount(host, kind, onOpen) -> { refresh }
//   host     an element to fill            kind    "encounter" or "loot"
//   onOpen   function(record) called by the Open button
//   refresh  fetch the list again and redraw (call it after an edit)
// Encounters and loot tables belong to no campaign: the "Campaigns" column (and its filter) shows which saved campaigns have them on
// their tracker, and "In this campaign" whether the loaded one does.
// Used at the bottom of the Home tab (both lists), the Encounters tab (encounters) and the Loot tab (loot tables).
// Needs ui.js and finder.js loaded first.
const Browse = (() => {
  const { h, api, box, dataTable } = UI;
  const crText = cr => ({ 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" }[cr] ?? String(cr));
  const onTracker = r => (r.onTracker?.length ? "yes" : "no");
  // "Campaigns": the saved campaigns that have this on their tracker (filterable), so a record can be found by where it is used.
  const campaigns = { label: "Campaigns", text: r => (r.campaigns || []).join(", ") || "(none)", tags: r => (r.campaigns?.length ? r.campaigns : ["(none)"]), filter: true };

  const KINDS = {
    encounter: {
      api: "/api/encounters", key: "browse-encounters", title: "Browse encounters", empty: "No encounters in this campaign yet.",
      columns: [
        { label: "Encounter", text: r => r.name },
        { label: "Monsters", text: r => r.monsters.map(m => `${m.count}× ${m.name} (CR ${crText(m.cr)})`).join(", ") || "(empty)" },
        { label: "XP", text: r => String(r.monsters.reduce((s, m) => s + (m.xp || 0) * m.count, 0)) },
        campaigns,
        { label: "In this campaign", text: onTracker, filter: true },
      ],
    },
    loot: {
      api: "/api/loots", key: "browse-loot", title: "Browse loot tables", empty: "No loot tables in this campaign yet.",
      columns: [
        { label: "Loot table", text: r => r.name },
        { label: "Items", text: r => r.entries.map(e => e.name + (e.rarity ? ` (${e.rarity})` : "")).join(", ") || "(empty)" },
        { label: "Entries", text: r => String(r.entries.length) },
        campaigns,
        { label: "In this campaign", text: onTracker, filter: true },
      ],
    },
  };

  function mount(host, kind, onOpen) {
    const k = KINDS[kind];
    async function refresh() {
      let rows;
      try { rows = await api(k.api); } catch (e) { host.replaceChildren(h("p", { className: "bad", textContent: e.message })); return; }
      host.replaceChildren(box(k.key, k.title, dataTable({
        key: k.key, rows, columns: k.columns, empty: k.empty,
        actions: r => [h("button", { textContent: "Open", onclick: () => onOpen(r) })],
      })));
    }
    refresh();
    return { refresh };
  }

  return { mount };
})();
