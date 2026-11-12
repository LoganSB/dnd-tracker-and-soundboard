"use strict";
// loottable.js - what is specific to LOOT TABLES, shared by the Loot tab and the loot pop-up on the campaign tracker.
// The editor itself (picker, entries table, saving, search panel) is builder.js and the search is finder.js, exactly as
// for encounters; this file supplies the configuration: item columns, weights, chances and a Roll button.
//
// The item list is every magic item from Open5e (Kobold Press books included). Like the monster list, it is downloaded
// once from the server, which keeps it on disk and rebuilds it from Open5e at most monthly, so searching makes no API calls.
//
// LootTables.items()                promise of { rows, d } the prepared item list (downloaded once, then remembered)
// LootTables.config(opts)           the Builder configuration: opts.tiles() -> campaign tiles (for "Put on campaign tracker"),
//                                   opts.compact, opts.lockId, opts.onChange, opts.extraActions(record, ctx)
// LootTables.pick(entries)          weighted random choice: { entry, roll, total }
// LootTables.pickRarity(rows, r)    random item of that rarity (every item equally likely)
// A loot table record: { id, name, notes, entries: [{ slug, name, type, rarity, weight, note }] }
const LootTables = (() => {
  const { h, api } = UI;
  let promise = null;
  const note = { text: "Loading the item list…" };

  const items = () => (promise ||= Finder.loadIndex("/api/items/index", ([slug, name, type, rarity, attune, doc], d) => ({
    slug, name, type, rarity, attune: !!attune, doc, docTitle: d.docs[doc] || doc, extraText: `${type} ${rarity} ${d.docs[doc] || ""}`,
  }), () => { note.text = "Downloading the item list from Open5e (first time only)…"; }).catch(e => { promise = null; throw e; }));

  const preview = slug => window.open("/item/" + slug, "dmitem", "width=540,height=640");
  const rarityText = r => r || "";

  // itemPanel(add, compact): the item search (Finder.panel), the same component the monster search uses.
  function itemPanel(add, compact) {
    const panel = Finder.panel({
      compact, rows: [], note: () => note.text, placeholder: "Type any part of an item name (typos are fine), or a rarity",
      hint: "Matches while you type, with or without typos, from the Open5e magic item list. Try: boots, cloak of prot, rare ring, legendary.",
      label: m => `${m.name} (${m.rarity})`, sub: m => `${m.type} · ${m.docTitle}`, num: null,
      columns: [{ label: "Item", text: m => m.name }, { label: "Type", text: m => m.type }, { label: "Rarity", text: m => m.rarity },
        { label: "Book", text: m => m.docTitle }],
      onAdd: add, preview: m => preview(m.slug),
      filters: [{ key: "rarity", label: "Rarity", all: "Any rarity", options: [], get: m => m.rarity }, { key: "type", label: "Type", all: "Any type", options: [], get: m => m.type },
        { key: "doc", label: "Book", all: "Any book", options: [], get: m => m.doc }],
    });
    items().then(({ rows, d }) => {
      panel.setOptions("rarity", (d.rarities || []).map(r => [r, r]));
      panel.setOptions("type", [...new Set(rows.map(m => m.type).filter(Boolean))].sort().map(t => [t, t]));
      panel.setOptions("doc", Object.entries(d.docs).sort((a, b) => a[1].localeCompare(b[1])));
      panel.setRows(rows);
    }).catch(e => { note.text = "Could not load the item list: " + e.message; panel.redraw(); });
    return panel;
  }

  // pick(entries): weighted choice. Think of a die with as many faces as the total weight; an entry of weight 5 owns 5 faces.
  function pick(entries) {
    const w = e => Math.max(1, Math.floor(+e.weight || 1));
    const total = entries.reduce((s, e) => s + w(e), 0);
    let roll = 1 + Math.floor(Math.random() * total), at = roll;
    for (const entry of entries) { if (at <= w(entry)) return { entry, roll, total }; at -= w(entry); }
    return null;
  }
  const pickRarity = (rows, rarity) => { const pool = rows.filter(m => m.rarity === rarity); return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null; };
  const label = e => `${e.name}${e.rarity ? " (" + e.rarity + ")" : ""}`;

  function config(opts = {}) {
    return {
      api: "/api/loots", noun: "loot table", list: "entries", box: "loot", title: "Loot table", finderTitle: "Find magic items",
      compact: opts.compact, lockId: opts.lockId, initialId: opts.initialId, onChange: opts.onChange,
      head: ["Item", "Type", "Rarity", "Weight"],
      row: (e, ctx) => [e.name, e.type || "", rarityText(e.rarity), ctx.num(e, "weight")],
      preview: e => (e.slug ? preview(e.slug) : null),
      finder: add => itemPanel(add, opts.compact),
      addEntry: (rec, m) => {
        const line = rec.entries.find(e => e.slug === m.slug);
        if (line) line.weight = Math.min(1000, line.weight + 1);
        else rec.entries.push({ slug: m.slug, name: m.name, type: m.type, rarity: m.rarity, weight: 1, note: "" });
      },
      custom: { placeholder: "Something not in the list (e.g. 50 gold pieces)", make: name => ({ slug: "", name, type: "", rarity: "", weight: 1, note: "" }) },
      // Summary: the die the table is rolled as, each entry's chance, and a Roll button.
      summary: (rec, ctx) => {
        const total = rec.entries.reduce((s, e) => s + Math.max(1, Math.floor(+e.weight || 1)), 0);
        const result = h("div", { className: "lootresult" });
        const box = h("div", {}, h("p", { className: "muted", textContent: total
          ? `Rolled as a d${total}. ` + rec.entries.map(e => `${e.name} ${((Math.max(1, e.weight) / total) * 100).toFixed(Math.max(1, e.weight) / total < 0.1 ? 1 : 0)}%`).join(" · ")
          : "No entries yet." }),
        h("div", { className: "row" }, h("button", { textContent: "🎲 Roll", onclick: () => {
          const r = pick(rec.entries);
          result.textContent = r ? `🎲 d${r.total} → ${r.roll}: ${label(r.entry)}` : "Add at least one entry first.";
        } }), result));
        return box;
      },
      actions: (rec, ctx) => [
        ...(opts.tiles ? (() => {
          const tiles = opts.tiles();
          const sel = h("select", {}, tiles.length ? tiles.map(t => h("option", { value: t.id, textContent: t.name })) : h("option", { value: "", textContent: "(first tile)" }));
          return [sel, h("button", { textContent: "Put on campaign tracker", onclick: async () => {
            await ctx.flush();
            const r = await api(`/api/loots/${rec.id}/tile`, "POST", { tile: sel.value });
            parent.postMessage({ type: "goto", page: "campaign", node: r.item }, location.origin);
            await ctx.reload();
          } }), rec.onTracker?.length ? h("span", { className: "ok", textContent: "On the campaign tracker: " + rec.onTracker.join(", ") }) : h("span", { className: "muted", textContent: "Not on the campaign tracker yet" })];
        })() : []),
        ...(opts.extraActions?.(rec, ctx) || []),
      ],
    };
  }

  return { items, config, pick, pickRarity, label };
})();
