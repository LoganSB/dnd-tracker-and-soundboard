"use strict";
// monsters.js - the monster search: Open5e's monster list as a Finder.panel, the same component the item search (loottable.js) and the spell search
// (spells.js) use. The Encounters tab shows it to build an encounter; the character sheet's "Add companion" pop-up shows it to pick a companion.
//
// The list is every monster from Open5e (the Kobold Press books included). It is downloaded once from the server (GET /api/monsters/index: the
// server keeps it on disk and rebuilds it from Open5e at most monthly), so typing makes no API calls.
//
// Monsters.panel(add, opts)   a search box with suggestions, filters (type, book, CR range) and a result table with a "+" button per row;
//                             add(row) gets { slug, name, type, cr, ac, hp, bonus, doc, docTitle, xp }
// Monsters.full(slug)         promise of the whole Open5e record (size, ability scores, hit dice ...)
// Monsters.crText(cr)         0.25 -> "1/4"          Monsters.preview(slug)   open the stat block page
// Needs ui.js and finder.js loaded first.
const Monsters = (() => {
  const { api } = UI;
  const crText = cr => ({ 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" }[cr] ?? String(cr));
  const preview = slug => window.open("/monster/" + slug, "dmmonster", "width=540,height=760");
  let note = "Loading the monster list…";

  function panel(add, { compact = false } = {}) {
    const panel = Finder.panel({
      compact, rows: [], note: () => note, placeholder: "Type any part of a name (typos are fine), or cr 5",
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
    }, () => { note = "Downloading the monster list from Open5e (first time only)…"; panel.redraw(); })
      .then(({ rows, d }) => {
        panel.setOptions("type", [...new Set(rows.map(m => m.type).filter(Boolean))].sort().map(t => [t, t]));
        panel.setOptions("doc", Object.entries(d.docs).sort((a, b) => a[1].localeCompare(b[1])));
        panel.setRows(rows);
      })
      .catch(e => { note = "Could not load the monster list: " + e.message; panel.redraw(); });
    return panel;
  }

  const full = slug => api("/api/monsters/" + encodeURIComponent(slug));

  return { panel, full, crText, preview };
})();
