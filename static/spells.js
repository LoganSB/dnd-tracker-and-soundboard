"use strict";
// spells.js - the spell search: Open5e's spell list as a Finder.panel, the same component the monster search (encounters.js) and the magic item
// search (loottable.js) use. The character sheet's "Add spell" pop-up shows it.
//
// The list is every spell from Open5e (the SRD and the Kobold Press / Deep Magic books). Like the monster and item lists it is downloaded once from
// the server (GET /api/spells/index: the server keeps it on disk and rebuilds it from Open5e at most monthly), so searching makes no API calls.
//
// Spells.panel(add, opts)     a search box with suggestions, filters (class, level, school, book) and a result table with a "+" button per row;
//                             add(row) is called with { slug, name, level, school, classes, time, range, duration, components, doc, docTitle };
//                             opts.defaultClass: start with the Class filter on this class (the character sheet passes the character's class);
//                             opts.compact: the smaller pop-up layout
// Spells.full(slug)           promise of the whole Open5e record (description, materials ...), for what the "+" button adds
// Needs ui.js and finder.js loaded first.
const Spells = (() => {
  const { api } = UI;
  let promise = null;
  const note = { text: "Loading the spell list…" };

  const list = () => (promise ||= Finder.loadIndex("/api/spells/index", ([slug, name, level, school, classes, time, range, duration, components, doc], d) => ({
    slug, name, level, school, classes, time, range, duration, components, doc, docTitle: d.docs[doc] || doc,
    levelText: level === 0 ? "Cantrip" : String(level), extraText: `${school} ${classes} ${level === 0 ? "cantrip" : "level " + level} ${d.docs[doc] || ""}`,
  }), () => { note.text = "Downloading the spell list from Open5e (first time only)…"; }).catch(e => { promise = null; throw e; }));

  const preview = slug => window.open("/spell/" + slug, "dmspell", "width=540,height=640");

  const classList = m => (m.classes || "").split(/\s*,\s*/).filter(Boolean);

  function panel(add, { compact = false, defaultClass = "" } = {}) {
    const panel = Finder.panel({
      compact, rows: [], note: () => note.text, placeholder: "Type any part of a spell name (typos are fine), a class or a school",
      hint: "Matches while you type, with or without typos, from the Open5e spell list. Try: fireball, cure wou, wizard evocation, cantrip.",
      label: m => `${m.name} (${m.levelText})`, sub: m => `${m.school} · ${m.classes}`, num: null,
      columns: [{ label: "Spell", text: m => m.name }, { label: "Level", text: m => m.levelText }, { label: "School", text: m => m.school },
        { label: "Class", text: m => m.classes }, { label: "Book", text: m => m.docTitle }],
      onAdd: add, preview: m => preview(m.slug),
      filters: [{ key: "class", label: "Class", all: "Any class", options: [], tags: classList }, { key: "level", label: "Level", all: "Any level", options: [], get: m => m.levelText }, { key: "school", label: "School", all: "Any school", options: [], get: m => m.school },
        { key: "doc", label: "Book", all: "Any book", options: [], get: m => m.doc }],
    });
    list().then(({ rows, d }) => {
      panel.setOptions("class", [...new Set(rows.flatMap(classList))].sort().map(c => [c, c]));
      panel.setOptions("level", [["Cantrip", "Cantrip"], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [String(n), "Level " + n])]);
      panel.setOptions("school", [...new Set(rows.map(m => m.school).filter(Boolean))].sort().map(t => [t, t]));
      panel.setOptions("doc", Object.entries(d.docs).sort((a, b) => a[1].localeCompare(b[1])));
      panel.setRows(rows);
      if (defaultClass) panel.setFilter("class", defaultClass);   // start on the character's own class (they can choose Any class)
    }).catch(e => { note.text = "Could not load the spell list: " + e.message; panel.redraw(); });
    return panel;
  }

  const full = slug => api("/api/spells/" + encodeURIComponent(slug));

  return { panel, full, list };
})();
