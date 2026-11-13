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
//   Sheet.inventory(m, add)     every item, carried or in a bag, as one searchable table (click an item for its description)
//   Sheet.spells(m, add, patch) the spell slots (pips, with a long-rest button) above every spell as one table (filter by level, school; click for the text)
//   Sheet.features(m, add)      race / background / class features, feats and notes as one table (filter by source)
//                               `add` (each of the three, optional): called by the + Add loot / + Add spell / + Add note button above the table;
//                               the page decides what it does (party.js opens the search pop-up or the note form)
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

  // withAdd(label, add, table): the list with its Add button above it (no button when the page gave no `add`).
  const withAdd = (label, add, table) => h("div", {}, add ? h("div", { className: "row addbar" }, h("button", { className: "primary", textContent: label, onclick: add })) : null, table);

  function inventory(m, add) {
    return withAdd("+ Add loot", add, dataTable({
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
    }));
  }

  // ---- spells
  function spells(m, add, patch) {
    const rows = [...m.spells].sort((a, b) => a.level - b.level || b.prepared - a.prepared || a.name.localeCompare(b.name));
    // The spell slot tracker (the same pips as the Tracker page: Vitals.slots), above the list; nothing for a character with no slots.
    const slots = patch && panel(m, patch, run => { const pips = Vitals.slots(m, run); return pips.length ? h("div", { className: "spellslots" }, h("h3", { textContent: "Spell slots" }), ...pips) : h("span"); });
    return h("div", {}, slots, withAdd("+ Add spell", add, dataTable({
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
    })));
  }

  // ---- features, feats and notes
  // featureRows(m): every named feature as { name, source, text }: race, background, each class, feats, and the character's notes.
  function featureRows(m) {
    return [...m.raceFeats.map(f => ({ ...f, source: "Race" })), ...(m.background.feats || []).map(f => ({ ...f, source: "Background" })),
      ...m.classes.flatMap(c => c.feats.map(f => ({ ...f, source: c.name }))), ...m.feats.map(f => ({ ...f, source: "Feat" })),
      ...m.notes.map(n => ({ ...n, source: "Note" }))];
  }
  function features(m, add) {
    return withAdd("+ Add note", add, dataTable({
      key: `sheet.${m.id}.features`, rows: featureRows(m), empty: "No features, feats or notes.",
      columns: [{ label: "Name", text: f => f.name }, { label: "Source", text: f => f.source, filter: true }],
      detail: f => f.text || null,
    }));
  }

  const counts = m => ({ items: m.items.length + m.containers.reduce((n, c) => n + c.items.length, 0), spells: m.spells.length, features: featureRows(m).length });

  // ---- shared pieces of the Tracker and Skills and Stats pages
  const tile = (label, value, title, ...extra) => h("div", { className: "stat", title: title || "" }, h("div", { className: "muted", textContent: label }), h("b", { textContent: value }), ...extra);

  // panel(m, patch, build): a panel that redraws ITSELF after every change. `build(run, note)` returns the content; `run(body)` sends one
  // change (patch must return a promise: the page's PATCH) and then redraws; a failure is printed in `note` beside the controls.
  function panel(m, patch, build) {
    const box = h("div");
    const note = h("p", { className: "muted" });
    const run = body => patch(body).then(draw).catch(e => { note.textContent = e.message; note.className = "bad"; });
    function draw() { note.textContent = ""; note.className = "muted"; box.replaceChildren(build(run, note)); }
    draw();
    box.redraw = draw;   // for a page that changes `m` itself (the companion pop-up) and wants the panel drawn again
    return box;
  }

  // statistics(m, run): the tiles AC, Initiative, Speed, Passive Perception, Proficiency and Inspiration (with - / +).
  function statistics(m, run) {
    const s = m.stats;
    // The conditions change some numbers (conditions.js): speed 0 or half, passive Perception -5. A changed tile shows the new number, the old one
    // struck through, a badge and the reason (the conditions that caused it), so it is plain WHY it differs from the sheet.
    const fx = Conditions.effects(Conditions.parse(m.conditions));
    const changed = (label, now, was, why, title) => {
      const t = tile(label, now, `${title}\nWas ${was}: ${why}`, h("div", { className: "was" }, h("s", { textContent: was }), " ", h("span", { className: "why", textContent: "⚠ " + why })));
      t.classList.add("changed");
      return t;
    };
    const speedTile = () => {
      if (!fx.speed || !s.speedFeet) return tile("Speed", s.speed || "—", s.speedNote);
      const now = Conditions.speed(s.speedFeet, fx.speed);
      return changed("Speed", `${now} ft`, s.speed, `${fx.speed.kind === "zero" ? "0" : "halved"} by ${fx.speed.why.join(", ")}`, s.speedNote);
    };
    const percTile = () => (!fx.perception ? tile("Passive Perception", s.passivePerception, "10 + Perception")
      : changed("Passive Perception", s.passivePerception + fx.perception.delta, s.passivePerception, `-5 (disadvantage on checks) from ${fx.perception.why.join(", ")}`, "10 + Perception"));
    const insp = h("div", { className: "stat", title: "Inspiration" }, h("div", { className: "muted", textContent: "Inspiration" }), h("b", { textContent: m.inspiration }),
      h("div", { className: "row" }, h("button", { className: "tiny", textContent: "−", onclick: () => run({ inspiration: m.inspiration - 1 }) }),
        h("button", { className: "tiny", textContent: "+", onclick: () => run({ inspiration: m.inspiration + 1 }) })));
    return h("div", {}, h("div", { className: "stats" },
      tile("Armor class", s.ac, s.acNote), tile("Initiative", sgn(s.initiative), "Dexterity modifier"), speedTile(),
      percTile(), tile("Proficiency", sgn(s.profBonus), "Proficiency bonus"), insp),
      // the effects that are not a single number on a tile: no actions, halved hit point maximum, disadvantage on saves
      [fx.noActions.length ? "Can't take actions or reactions" + ` (${fx.noActions.join(", ")})` : "", fx.hpMax.length ? `Hit point maximum halved (${fx.hpMax.join(", ")})` : "",
        fx.saves.length ? `Disadvantage on saving throws (${fx.saves.join(", ")})` : ""].filter(Boolean).map(t => h("p", { className: "condwarn", textContent: "⚠ " + t })),
      h("p", { className: "muted", textContent: "Armor class, initiative and proficiency are worked out from the character's ability scores, level and equipped items; bonuses from class features and spells are not included." }));
  }

  // attacks(m): the equipped weapons from the character's items, with attack bonus and damage plus type.
  const attacks = m => h("div", {}, ((why) => (why.length ? h("p", { className: "condwarn", textContent: `⚠ Disadvantage on your attack rolls (${why.join(", ")})` }) : null))(Conditions.effects(Conditions.parse(m.conditions)).attacks), dataTable({
    key: `sheet.${m.id}.attacks`, rows: m.attacks, empty: "No weapons equipped.",
    columns: [{ label: "Weapon", text: a => a.name }, { label: "Attack", text: a => sgn(a.atk) },
      { label: "Damage", text: a => a.damage + (a.damage2h ? ` (${a.damage2h} two-handed)` : "") }, { label: "Notes", text: a => a.notes }],
  }), h("p", { className: "muted", textContent: "Equipped weapons only. Attack = ability modifier + proficiency (if proficient) + the item's bonus." }));

  // ---- the Tracker page, below the live tracker: hit dice first, then Conditions, Statistics, Attacks and Creatures, each under a thin line.
  // All of it sits in the one card the live tracker is in (party.js puts the tracker widget above this). Everything is built from the
  // character's own data (the Fight Club import): hit dice from the classes, attacks from the equipped items, creatures from <monster>.
  function trackerExtras(m, patch, addCompanion) {
    return panel(m, patch, (run, note) => {
      const part = (title, ...kids) => h("div", { className: "part" }, h("hr", { className: "thin" }), h("h3", { textContent: title }), ...kids);
      return h("div", { className: "trackerextras" },
        h("h3", { textContent: "Hit dice" }), Vitals.hitDice(m, run),
        part("Conditions", Vitals.conditions(m, run)),
        part("Statistics", statistics(m, run)),
        part("Attacks", attacks(m)),
        part("Creatures", creatures(m, run, addCompanion)),
        note);
    });
  }

  // ---- the Skills and Stats page: Statistics, Abilities and saving throws, and every Skill.
  function stats(m, patch) {
    return panel(m, patch, run => {
      const abilities = card("Abilities and saving throws", h("div", { className: "stats" }, m.abilities.map((a, i) => {
        const sv = m.saves[i];
        return h("div", { className: "stat" }, h("div", { className: "muted", textContent: a.name }), h("b", { textContent: sgn(a.mod) }), h("div", { textContent: a.score }),
          h("div", { className: "muted" + (sv.proficient ? " prof" : ""), textContent: `Save ${sgn(sv.mod)}${sv.proficient ? " ●" : ""}`, title: sv.proficient ? "Proficient" : "" }));
      })));
      const skills = card("Skills", dataTable({
        key: `sheet.${m.id}.skills`, rows: m.skills, empty: "No skills.",
        columns: [{ label: "Skill", text: k => k.name }, { label: "Ability", text: k => k.ability, filter: true },
          { label: "Modifier", text: k => sgn(k.mod) }, { label: "Proficient", text: k => (k.proficient ? "Proficient" : ""), filter: true }],
        rowClass: k => (k.proficient ? "equipped" : ""),
      }));
      return h("div", { className: "sheetstats" }, card("Statistics", statistics(m, run)), abilities, skills);
    });
  }

  // creatures: companions, familiars and summons. Two kinds share one table: the creatures added with "+ Add companion" (m.creatures: name, hit
  // points, armor class, the monster it is; the hp buttons change one and the whole list is saved, because Fight Club has no hit points for them;
  // the server also wrote each as a Fight Club companion) and any companion that only exists in the imported file (m.companions: name, kind, hit
  // dice, ability scores; read-only here). `addCompanion` opens the monster search (party.js); the page redraws after it.
  function creatures(m, run, addCompanion) {
    const list = m.creatures || [];
    const have = new Set(list.map(c => c.name));
    const fromFile = (m.companions || []).filter(c => !have.has(c.name)).map(c => ({ name: c.name, hp: null, ac: "", file: true,
      notes: [c.kind, c.hd && c.hd + " hit dice", c.abilities.length && "STR/DEX/CON/INT/WIS/CHA " + c.abilities.join("/")].filter(Boolean).join(" · ") }));
    const save = next => run({ creatures: next });
    const change = (c, fields) => save(list.map(x => (x === c ? { ...x, ...fields } : x)));
    return h("div", {}, dataTable({
      key: `sheet.${m.id}.creatures`, rows: [...fromFile, ...list], empty: "No creatures yet. Add a familiar, pet or summon from the monster list.",
      columns: [{ label: "Name", text: c => c.name },
        { label: "HP", text: c => (c.file ? "" : `${c.hp}/${c.hpMax}`), show: c => c.file ? "" : h("span", { className: "nowrap" },
          h("button", { className: "tiny", textContent: "−", onclick: () => change(c, { hp: Math.max(0, c.hp - 1) }) }), ` ${c.hp}/${c.hpMax} `,
          h("button", { className: "tiny", textContent: "+", onclick: () => change(c, { hp: Math.min(c.hpMax || 1e4, c.hp + 1) }) })) },
        { label: "AC", text: c => String(c.ac || "") }, { label: "Notes", text: c => c.notes }],
      actions: c => (c.file ? [] : [h("button", { className: "tiny danger", textContent: "✕", title: "Remove", onclick: () => { if (confirm(`Remove ${c.name}?`)) save(list.filter(x => x !== c)); } })]),
    }), addCompanion ? h("div", { className: "row addbar" }, h("button", { className: "primary", textContent: "+ Add companion", onclick: addCompanion })) : null);
  }

  return { stats, trackerExtras, inventory, spells, features, counts };
})();
