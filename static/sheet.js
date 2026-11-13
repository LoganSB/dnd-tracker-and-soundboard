"use strict";
// =============================================================================
// sheet.js - the panels of a character sheet (the sub-menu pages of /party/<id>)
// =============================================================================
//
// party.js builds the page (header, the row of sub-menu buttons, loading the character); this file builds what is INSIDE each
// sub-menu page. Every panel is a function of the character record (GET /api/party/<id>) and returns an element:
//
//   Sheet.stats(m, patch)       Skills and Stats: Health (HP, hit dice, conditions), Statistics, Abilities and saves, Attacks, Skills,
//                               Creatures. `patch(body)` sends a change (PATCH /api/party/<id>) and must return a promise; the page
//                               then redraws the panel.
//   Sheet.inventory(m)          every item, carried or in a bag, as one searchable table (click an item for its description)
//   Sheet.spells(m)             every spell as one table (filter by level, school; click for the text)
//   Sheet.features(m)           race / background / class features, feats and notes as one table (filter by source)
//   Sheet.counts(m)             {items, spells, features}: the numbers the sub-menu buttons show
//
// ALL the lists are UI.dataTable (ui.js): the same table, search box (typos and regular expressions), filters, expanding rows and
// 10 / 20 / 50 / 100 row buttons as every other list in the app. Nothing here makes its own table. The little health controls are
// Vitals (vitals.js), shared with the party tracker. Needs ui.js, finder.js and vitals.js loaded first.
const Sheet = (() => {
  const { h, dataTable } = UI;
  const sgn = n => (n >= 0 ? "+" : "") + n;
  const gp = v => (v ? (v >= 1000 ? v.toLocaleString() : v) + " gp" : "");
  const card = (title, ...kids) => h("section", { className: "card" }, h("h2", { textContent: title }), ...kids);

  // ---- inventory
  // flatItems(m): the loose items and every container's items as one list, each marked with where it is. Equipped first.
  function flatItems(m) {
    const all = [...m.items.map(i => ({ ...i, where: "Carried" })), ...m.containers.flatMap(c => c.items.map(i => ({ ...i, where: c.name })))];
    return all.map((i, n) => [i, n]).sort((a, b) => b[0].equipped - a[0].equipped || a[1] - b[1]).map(x => x[0]);
  }
  const itemStats = i => [i.ac && "AC " + i.ac, i.damage && `${i.damage}${i.damage2h ? " (" + i.damage2h + " two-handed)" : ""} ${i.damageType}`.trim(), i.property,
    i.range && "range " + i.range + (i.longRange ? "/" + i.longRange : ""), i.weight && i.weight * i.quantity + " lb"].filter(Boolean).join(" · ");

  function inventory(m) {
    return dataTable({
      key: `sheet.${m.id}.items`, rows: flatItems(m), empty: "No items.",
      columns: [
        { label: "Item", text: i => (i.quantity > 1 ? `${i.quantity}× ` : "") + i.name.trim() + (i.magic ? " ✦" : "") },
        { label: "Type", text: i => i.type || i.detail, filter: true },
        { label: "Where", text: i => i.where, filter: true },
        { label: "Worn", text: i => (i.equipped ? "Equipped" : ""), filter: true },
        { label: "Stats", text: itemStats },
        { label: "Value", text: i => gp(i.value) },
      ],
      detail: i => i.text || i.detail || null, rowClass: i => (i.equipped ? "equipped" : ""),
    });
  }

  // ---- spells
  function spells(m) {
    const rows = [...m.spells].sort((a, b) => a.level - b.level || b.prepared - a.prepared || a.name.localeCompare(b.name));
    return dataTable({
      key: `sheet.${m.id}.spells`, rows, empty: "No spells.",
      columns: [
        { label: "Spell", text: s => s.name },
        { label: "Level", text: s => (s.level === 0 ? "Cantrip" : String(s.level)), filter: true },
        { label: "School", text: s => s.school, filter: true },
        { label: "Prepared", text: s => (s.prepared ? "Prepared" : ""), filter: true },
        { label: "Cast", text: s => s.time },
        { label: "Range", text: s => s.range },
        { label: "Duration", text: s => s.duration },
        { label: "Comp.", text: s => s.components },
      ],
      detail: s => ((s.materials ? `Materials: ${s.materials}\n\n` : "") + s.text) || null, rowClass: s => (s.prepared ? "equipped" : ""),
    });
  }

  // ---- features, feats and notes
  // featureRows(m): every named feature as { name, source, text }: race, background, each class, feats, and the character's notes.
  function featureRows(m) {
    return [...m.raceFeats.map(f => ({ ...f, source: "Race" })), ...(m.background.feats || []).map(f => ({ ...f, source: "Background" })),
      ...m.classes.flatMap(c => c.feats.map(f => ({ ...f, source: c.name }))), ...m.feats.map(f => ({ ...f, source: "Feat" })),
      ...m.notes.map(n => ({ ...n, source: "Note" }))];
  }
  function features(m) {
    return dataTable({
      key: `sheet.${m.id}.features`, rows: featureRows(m), empty: "No features, feats or notes.",
      columns: [{ label: "Name", text: f => f.name }, { label: "Source", text: f => f.source, filter: true }],
      detail: f => f.text || null,
    });
  }

  const counts = m => ({ items: m.items.length + m.containers.reduce((n, c) => n + c.items.length, 0), spells: m.spells.length, features: featureRows(m).length });

  // ---- skills and stats
  const tile = (label, value, title, ...extra) => h("div", { className: "stat", title: title || "" }, h("div", { className: "muted", textContent: label }), h("b", { textContent: value }), ...extra);

  function stats(m, patch) {
    const note = h("p", { className: "muted" });
    const run = body => patch(body).catch(e => { note.textContent = e.message; note.className = "bad"; });
    const s = m.stats;

    const health = card("Health", Vitals.hp(m, run), h("h3", { textContent: "Hit dice" }), Vitals.hitDice(m, run),
      h("h3", { textContent: "Conditions" }), Vitals.conditions(m, run), note);

    const insp = h("div", { className: "stat", title: "Inspiration" }, h("div", { className: "muted", textContent: "Inspiration" }), h("b", { textContent: m.inspiration }),
      h("div", { className: "row" }, h("button", { className: "tiny", textContent: "−", onclick: () => run({ inspiration: m.inspiration - 1 }) }),
        h("button", { className: "tiny", textContent: "+", onclick: () => run({ inspiration: m.inspiration + 1 }) })));
    const statistics = card("Statistics", h("div", { className: "stats" },
      tile("Armor class", s.ac, s.acNote), tile("Initiative", sgn(s.initiative), "Dexterity modifier"), tile("Speed", s.speed || "—"),
      tile("Passive Perception", s.passivePerception, "10 + Perception"), tile("Proficiency", sgn(s.profBonus), "Proficiency bonus"), insp),
      h("p", { className: "muted", textContent: "Armor class, initiative and proficiency are worked out from the character's ability scores, level and equipped items; bonuses from class features and spells are not included." }));

    const abilities = card("Abilities and saving throws", h("div", { className: "stats" }, m.abilities.map((a, i) => {
      const sv = m.saves[i];
      return h("div", { className: "stat" }, h("div", { className: "muted", textContent: a.name }), h("b", { textContent: sgn(a.mod) }), h("div", { textContent: a.score }),
        h("div", { className: "muted" + (sv.proficient ? " prof" : ""), textContent: `Save ${sgn(sv.mod)}${sv.proficient ? " ●" : ""}`, title: sv.proficient ? "Proficient" : "" }));
    })));

    const attacks = card("Attacks", dataTable({
      key: `sheet.${m.id}.attacks`, rows: m.attacks, empty: "No weapons equipped.",
      columns: [{ label: "Weapon", text: a => a.name }, { label: "Attack", text: a => sgn(a.atk) },
        { label: "Damage", text: a => a.damage + (a.damage2h ? ` (${a.damage2h} two-handed)` : "") }, { label: "Notes", text: a => a.notes }],
    }), h("p", { className: "muted", textContent: "Equipped weapons only. Attack = ability modifier + proficiency (if proficient) + the item's bonus." }));

    const skills = card("Skills", dataTable({
      key: `sheet.${m.id}.skills`, rows: m.skills, empty: "No skills.",
      columns: [{ label: "Skill", text: k => k.name }, { label: "Ability", text: k => k.ability, filter: true },
        { label: "Modifier", text: k => sgn(k.mod) }, { label: "Proficient", text: k => (k.proficient ? "Proficient" : ""), filter: true }],
      rowClass: k => (k.proficient ? "equipped" : ""),
    }));

    return h("div", { className: "sheetstats" }, health, statistics, abilities, attacks, skills, card("Creatures", creatures(m, run)));
  }

  // creatures: companions, familiars and summons. Two kinds share one table: the companions Fight Club has on the character (m.companions:
  // name, kind, hit dice, ability scores; read-only here) and creatures added on this page (m.creatures: name, hit points, armor class,
  // a note; the hp buttons change one and the whole list is saved, because Fight Club has no hit points for them).
  function creatures(m, run) {
    const list = m.creatures || [];
    const fromFile = (m.companions || []).map(c => ({ name: c.name, hp: null, ac: "", file: true,
      notes: [c.kind, c.hd && c.hd + " hit dice", c.abilities.length && "STR/DEX/CON/INT/WIS/CHA " + c.abilities.join("/")].filter(Boolean).join(" · ") }));
    const save = next => run({ creatures: next });
    const change = (c, fields) => save(list.map(x => (x === c ? { ...x, ...fields } : x)));
    const name = h("input", { placeholder: "Name (e.g. Owl familiar)", className: "grow", maxLength: 40 });
    const hp = h("input", { type: "number", min: 0, placeholder: "HP", className: "inum" });
    const ac = h("input", { type: "number", min: 0, placeholder: "AC", className: "inum" });
    const notes = h("input", { placeholder: "Notes", className: "grow", maxLength: 200 });
    const add = () => {
      if (!name.value.trim()) { name.focus(); return; }
      save([...list, { name: name.value.trim(), hp: +hp.value || 0, hpMax: +hp.value || 0, ac: +ac.value || 0, notes: notes.value.trim() }]);
    };
    [name, hp, ac, notes].forEach(i => (i.onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); add(); } }));
    return h("div", {}, dataTable({
      key: `sheet.${m.id}.creatures`, rows: [...fromFile, ...list], empty: "No creatures yet. Add a familiar, pet or summon below.",
      columns: [{ label: "Name", text: c => c.name },
        { label: "HP", text: c => (c.file ? "" : `${c.hp}/${c.hpMax}`), show: c => c.file ? "" : h("span", { className: "nowrap" },
          h("button", { className: "tiny", textContent: "−", onclick: () => change(c, { hp: Math.max(0, c.hp - 1) }) }), ` ${c.hp}/${c.hpMax} `,
          h("button", { className: "tiny", textContent: "+", onclick: () => change(c, { hp: Math.min(c.hpMax || 1e4, c.hp + 1) }) })) },
        { label: "AC", text: c => String(c.ac || "") }, { label: "Notes", text: c => c.notes }],
      actions: c => (c.file ? [] : [h("button", { className: "tiny danger", textContent: "✕", title: "Remove", onclick: () => save(list.filter(x => x !== c)) })]),
    }), h("div", { className: "row addrow" }, name, hp, ac, notes, h("button", { className: "primary tiny", textContent: "Add creature", onclick: add })));
  }

  return { stats, inventory, spells, features, counts };
})();
