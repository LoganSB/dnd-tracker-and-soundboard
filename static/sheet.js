"use strict";
// =============================================================================
// sheet.js - the panels of a character sheet (the sub-menu pages of /party/<id>)
// =============================================================================
//
// party.js builds the page (header, the row of sub-menu buttons, loading the character); this file builds what is INSIDE each
// sub-menu page. Every panel is a function of the character record (GET /api/party/<id>) and returns an element:
//
//   Sheet.trackerExtras(m, patch, addCompanion)  the Tracker page, under the live tracker: Hit dice, then Conditions (chips with an Add menu and what
//                               each does), Statistics, Attacks and Creatures, each under a thin line. Built from the character's own Fight Club data.
//   Sheet.stats(m, patch)       Skills and Stats: Abilities and saving throws, and every Skill.
//                               `patch(body)` (both panels) sends a change (PATCH /api/party/<id>) and must return a promise; each panel
//                               then redraws itself.
//   Sheet.inventory(m, hooks)   every item, carried or in a bag, as one searchable table (click an item for its description) with count -/+, Equip, Give,
//                               remove and the Add buttons (hooks: see inventory below; the page decides what each does)
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
    const all = [...m.items.filter(i => !i.coin).map(i => ({ ...i, where: "Carried" })), ...m.containers.flatMap(c => c.items.map(i => ({ ...i, where: c.name })))];
    return all.map((i, n) => [i, n]).sort((a, b) => isOn(b[0]) - isOn(a[0]) || a[1] - b[1]).map(x => x[0]);
  }
  const itemStats = i => [i.ac && "AC " + i.ac, i.damage && `${i.damage}${i.damage2h ? " (" + i.damage2h + " two-handed)" : ""} ${i.damageType}`.trim(), i.property,
    i.range && "range " + i.range + (i.longRange ? "/" + i.longRange : ""), i.weight && i.weight * i.quantity + " lb"].filter(Boolean).join(" · ");

  // What is an item doing: on = worn or held (armor, shields and weapons by Fight Club's own slot, anything else by the worn kind the server keeps).
  const WORN = { head: "headwear", neck: "amulet", cloak: "cloak", hands: "gloves", wrists: "bracers", belt: "belt", feet: "footwear", ring: "ring" };
  const isOn = i => (i.fcSlot ? i.equipped : !!i.worn);
  const wornText = i => [isOn(i) ? (i.fcSlot ? "Equipped" : `Worn (${WORN[i.worn] || i.worn})`) : "", i.needsAttune ? (i.attuned ? "attuned" : "needs attunement") : ""].filter(Boolean).join(", ");

  // stepper(apply): the shared "− [ n ] +" control (items and coins use it): the box takes digits only (default 1), and − / + call apply(-n) / apply(+n).
  const stepper = (apply, title = "") => {
    const box = h("input", { type: "text", inputMode: "numeric", value: "1", className: "inum stepbox", title: "How many to take away or add", size: 4,
      oninput: () => { box.value = box.value.replace(/\D/g, "").slice(0, 6); }, onfocus: () => box.select() });
    const n = () => Math.max(1, parseInt(box.value, 10) || 1);
    return h("span", { className: "stepper", title }, h("button", { className: "tiny", textContent: "−", title: "Take this many away", onclick: () => apply(-n()) }), box,
      h("button", { className: "tiny", textContent: "+", title: "Add this many", onclick: () => apply(n()) }));
  };

  // currency(m, hooks): the coins in a little box of their own (they are items in Fight Club's file, named "Gold (gp)" ..., but they are not listed with the
  // gear). Gold, silver and copper always show; platinum and electrum only when the character has some. hooks.coin(coin, delta) changes one.
  const COIN_ORDER = [["pp", "Platinum"], ["gp", "Gold"], ["ep", "Electrum"], ["sp", "Silver"], ["cp", "Copper"]];
  function currency(m, hooks) {
    const have = Object.fromEntries(m.items.filter(i => i.coin).map(i => [i.coin, i.quantity]));
    const cell = ([c, label]) => h("div", { className: "coin" }, h("span", { className: "muted", textContent: label }), h("b", { textContent: String(have[c] || 0) }),
      hooks.coin ? stepper(d => hooks.coin(c, d), `${label} pieces`) : null);
    return h("div", { className: "currency" }, h("h3", { textContent: "Currency" }), h("div", { className: "coins" }, ...COIN_ORDER.filter(([c]) => have[c] || ["gp", "sp", "cp"].includes(c)).map(cell)));
  }

  // withAdd(adds, table): the list with its purple Add buttons above it. `adds` = [[label, fn], ...]; a button whose fn the page did not give is left out.
  const withAdd = (adds, table) => {
    const btns = adds.filter(a => a[1]).map(([label, fn]) => h("button", { className: "primary", textContent: label, onclick: fn }));
    return h("div", {}, btns.length ? h("div", { className: "row addbar" }, ...btns) : null, table);
  };

  // inventory(m, hooks): every item as one table. hooks (all optional, the page decides what they do): addLoot() and addItem() open the two Add
  // pop-ups; coin(coin, delta) changes a coin; setQty(item, n) changes the count (0 removes it); equip(item, on); attune(item, on); give(item); remove(item); ack(gift) acknowledges a gift.
  // An item another player gave this character is highlighted with "Given to you by <player>" and an Acknowledge button until it is acknowledged.
  function inventory(m, hooks = {}) {
    const gifts = new Map((m.gifts || []).map(g => [g.name, g]));   // item name -> the pending gift of that name
    const rows = flatItems(m).map(i => ({ ...i, gift: i.ref.startsWith("i") ? gifts.get(i.name) : undefined }));   // a gift always lands among the loose items
    const btn = (label, title, fn, cls = "") => h("button", { className: "tiny " + cls, textContent: label, title, onclick: fn });
    const unattuned = i => isOn(i) && i.needsAttune && !i.attuned;   // worn or held but not attuned: it gives nothing yet
    return h("div", {}, currency(m, hooks), withAdd([["+ Add loot", hooks.addLoot], ["+ Custom item", hooks.addItem]], dataTable({
      key: `sheet.${m.id}.items`, rows, empty: "No items.",
      columns: [
        { label: "Item", text: i => i.name.trim() + (i.magic ? " ✦" : ""),
          show: i => h("span", {}, i.name.trim() + (i.magic ? " ✦" : ""),
            unattuned(i) ? h("div", { className: "attunenote" }, "⚠ Not attuned: its bonuses do not count yet. ", hooks.attune ? btn("Attune", "Attune to it (3 items at most)", () => hooks.attune(i, true), "primary") : null) : null,
            i.gift ? h("div", { className: "giftnote" }, `Given to you by ${i.gift.from}`, i.gift.qty > 1 ? ` (${i.gift.qty})` : "", " ", hooks.ack ? btn("Acknowledge", "Keep it: end the highlight", () => hooks.ack(i.gift), "primary") : null) : null) },
        { label: "Count", text: i => (i.quantity > 1 ? String(i.quantity) : ""), wide: true },
        { label: "Type", text: i => i.type || i.detail, filter: true, wide: true },
        { label: "Where", text: i => i.where, filter: true, wide: true },
        { label: "Worn", text: wornText, filter: true, wide: true },
        { label: "Stats", text: itemStats, wide: true },
        { label: "Value", text: i => gp(i.value), wide: true },
      ],
      detail: i => i.text || i.detail || null, rowClass: i => [isOn(i) && i.active !== false ? "equipped" : "", unattuned(i) ? "unattuned" : "", i.gift ? "gift" : ""].filter(Boolean).join(" "),
      actions: i => [
        hooks.equip && i.canEquip ? btn(isOn(i) ? "Unequip" : "Equip", isOn(i) ? "Take it off: it stops counting" : "Wear or hold it (one belt, one pair of gloves ... the limits are checked)", () => hooks.equip(i, !isOn(i))) : null,
        hooks.attune && i.needsAttune ? btn(i.attuned ? "End attunement" : "Attune", i.attuned ? "End your attunement to it: its bonuses stop" : "Attune to it (3 items at most)", () => hooks.attune(i, !i.attuned)) : null,
        hooks.give ? btn("Give", "Give it to another player", () => hooks.give(i)) : null,
        hooks.remove ? btn("✕", "Remove it from the character", () => hooks.remove(i), "danger") : null,
        hooks.setQty ? stepper(d => hooks.setQty(i, i.quantity + d), "Take away or add this many (taking away the last one removes the item)") : null,
      ],
    })));
  }

  // ---- spells
  function spells(m, add, patch) {
    const rows = [...m.spells].sort((a, b) => a.level - b.level || b.prepared - a.prepared || a.name.localeCompare(b.name));
    // The spell slot tracker (the same pips as the Tracker page: Vitals.slots), above the list; nothing for a character with no slots.
    const slots = patch && panel(m, patch, run => { const pips = Vitals.slots(m, run); return pips.length ? h("div", { className: "spellslots" }, h("h3", { textContent: "Spell slots" }), ...pips) : h("span"); });
    return h("div", {}, slots, withAdd([["+ Add spell", add]], dataTable({
      key: `sheet.${m.id}.spells`, rows, empty: "No spells.",
      columns: [
        { label: "Spell", text: s => s.name },
        { label: "Level", text: s => (s.level === 0 ? "Cantrip" : String(s.level)), filter: true },
        { label: "School", text: s => s.school, filter: true, wide: true },
        { label: "Prepared", text: s => (s.prepared ? "Prepared" : ""), filter: true, wide: true },
        { label: "Cast", text: s => s.time, wide: true },
        { label: "Range", text: s => s.range, wide: true },
        { label: "Duration", text: s => s.duration, wide: true },
        { label: "Comp.", text: s => s.components, wide: true },
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
    return withAdd([["+ Add note", add]], dataTable({
      key: `sheet.${m.id}.features`, rows: featureRows(m), empty: "No features, feats or notes.",
      columns: [{ label: "Name", text: f => f.name }, { label: "Source", text: f => f.source, filter: true }],
      detail: f => f.text || null,
    }));
  }

  const counts = m => ({ items: m.items.filter(i => !i.coin).length + m.containers.reduce((n, c) => n + c.items.length, 0), spells: m.spells.length, features: featureRows(m).length });

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
    // The conditions change some numbers (conditions.js): speed 0 or half. A changed tile shows the new number, the old one
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
    // Disadvantage does not change the number (the dice are rolled twice), so the tile only says so.
    const percTile = () => tile("Passive Perception", s.passivePerception, s.passiveWhy || "10 + Perception",
      ...(fx.checks.length ? [h("div", { className: "why", textContent: `⚠ Disadvantage on checks (${fx.checks.join(", ")})` })] : []));
    const insp = h("div", { className: "stat", title: "Inspiration" }, h("div", { className: "muted", textContent: "Inspiration" }), h("b", { textContent: m.inspiration }),
      h("div", { className: "row" }, h("button", { className: "tiny", textContent: "−", onclick: () => run({ inspiration: m.inspiration - 1 }) }),
        h("button", { className: "tiny", textContent: "+", onclick: () => run({ inspiration: m.inspiration + 1 }) })));
    return h("div", {}, h("div", { className: "stats" },
      tile("Armor class", s.ac, s.acNote), tile("Initiative", sgn(s.initiative), `Initiative ${sgn(s.initiative)} = ${s.initiativeWhy || "Dexterity modifier"}`), speedTile(),
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

  // ---- the Skills and Stats page: Abilities and saving throws, and every Skill (the Statistics are on the Tracker page).
  function stats(m, patch) {
    return panel(m, patch, run => {
      const grid = h("div", { className: "stats" }, m.abilities.map((a, i) => {
        const sv = m.saves[i];
        return h("div", { className: "stat", title: a.why.length ? `Base ${a.base}: ` + a.why.map(w => `${w.value >= 0 ? "+" : ""}${w.value} ${w.source}`).join(", ") : "" }, h("div", { className: "muted", textContent: a.name }), h("b", { className: "hint", textContent: sgn(a.mod), title: `Modifier ${sgn(a.mod)} = (score ${a.score} − 10) ÷ 2, rounded down` }), h("div", { textContent: a.score }),
          a.score !== a.base ? h("div", { className: "muted", textContent: `base ${a.base}` }) : null,
          h("div", { className: "muted hint" + (sv.proficient ? " prof" : ""), textContent: `Save ${sgn(sv.mod)}${sv.proficient ? " ●" : ""}`, title: `Saving throw ${sgn(sv.mod)} = ${sv.why}` }));
      }));
      // The spellcasting numbers, one line per class that casts: its ability modifier, the spell attack bonus and the spell save DC (hover for where they come from).
      const casting = (m.spellcasting || []).map(c => h("div", { className: "spellcast", title: `${c.class}: ${c.why}` },
        h("b", { textContent: `${c.class} spellcasting` }), h("span", { className: "hint", title: `Spellcasting modifier = the ${c.ability} modifier`, textContent: ` ${c.ability} ${sgn(c.mod)}` }),
        h("span", { className: "hint", title: `Spell attack bonus = proficiency + ${c.ability} modifier (${c.why})`, textContent: ` · Spell attack ${sgn(c.attack)}` }),
        h("span", { className: "hint", title: `Spell save DC = 8 + proficiency + ${c.ability} modifier (8, ${c.why})`, textContent: ` · Spell save DC ${c.dc}` })));
      const abilities = card("Abilities and saving throws", grid, ...casting);
      const skills = card("Skills", dataTable({
        key: `sheet.${m.id}.skills`, rows: m.skills, empty: "No skills.",
        columns: [{ label: "Skill", text: k => k.name }, { label: "Ability", text: k => k.ability, filter: true },
          { label: "Modifier", text: k => sgn(k.mod), show: k => h("span", { className: "hint", title: `${k.name} ${sgn(k.mod)} = ${k.why}` }, sgn(k.mod)) }, { label: "Proficient", text: k => (k.proficient ? "Proficient" : ""), filter: true }],
        rowClass: k => (k.proficient ? "equipped" : ""),
      }));
      return h("div", { className: "sheetstats" }, abilities, skills);
    });
  }

  // statBlock(p, c): a companion's whole record from the Fight Club file as a stat block (p = m.companions[i], c = the creature row with its current
  // hit points). Everything the file holds is shown; formulas with % are Fight Club's own and are shown as written.
  const signed = n => (n >= 0 ? "+" : "") + n;
  function statBlock(p, c) {
    const line = (label, value) => (value ? h("div", {}, h("b", { textContent: label + " " }), value) : null);
    const rechargeText = x => (x.recharge ? ` (${x.recharge})` : "");
    return h("div", { className: "cstat" },
      h("div", { className: "muted", textContent: [p.size, p.kind, p.alignment && ", " + p.alignment].filter(Boolean).join(" ").replace(" ,", ",") }),
      line("Armor class", c.ac != null ? String(c.ac) : ""), line("Hit points", c.hp != null ? `${c.hp}/${c.hpMax}${p.hd ? " (" + p.hd + ")" : ""}` : p.hd ? `(${p.hd})` : ""),
      line("Speed", p.speed != null ? `${p.speed} ft` : ""), line("Challenge", p.cr),
      h("div", { className: "stats compact" }, p.abilities.map((v, i) => h("div", { className: "stat" }, h("div", { className: "muted", textContent: ["STR", "DEX", "CON", "INT", "WIS", "CHA"][i] }), h("b", { textContent: v }), h("div", { textContent: signed(p.mods[i]) })))),
      line("Saving throws", p.saves.map(x => `${x.ability} ${signed(x.mod)}`).join(", ")), line("Skills", p.skills.map(x => `${x.name} ${signed(x.mod)}`).join(", ")),
      line("Damage vulnerabilities", p.vulnerable), line("Damage resistances", p.resist), line("Damage immunities", p.immune), line("Condition immunities", p.conditionImmune),
      line("Senses", p.senses), line("Languages", p.languages), line("Environment", p.environment.join(", ")),
      p.text ? h("p", { textContent: p.text }) : null,
      p.sections.map(sec => h("div", {}, h("h4", { textContent: sec.title }), sec.items.map(x => h("div", { className: "sbitem" }, h("b", { textContent: x.name + rechargeText(x) + ". " }), x.text,
        x.attacks.map(a => h("div", { className: "muted", textContent: `${a.type || "Attack"}: ${a.name || "attack"} · bonus ${a.bonus || "—"} · damage ${a.damage || "—"}${a.damageType ? " (type " + a.damageType + ")" : ""}` })))))));
  }

  // creatures: the character's companions, straight from the Fight Club file (m.creatures: name, kind, hit points, AC; m.companions: the whole record).
  // The hp buttons and the Edit form write the hit points and AC back into the file's <monster>, so they show in the phone app too. Click a row for
  // the whole stat block. `addCompanion` opens the monster search (party.js); the page redraws after it. Removing one takes it out of the file.
  function creatures(m, run, addCompanion) {
    const list = m.creatures || [];
    // payload(changes, drop): the whole list as the server wants it (it removes any companion not listed): [{ i, hp, hpMax, ac }]
    const payload = (changes = {}, drop = -1) => list.filter(c => c.i !== drop).map(c => ({ i: c.i, hp: c.hp, hpMax: c.hpMax, ac: c.ac, ...(changes[c.i] || {}) }));
    const hpNow = (c, hp) => run({ creatures: payload({ [c.i]: { hp } }) });
    const edit = c => Nodes.form({
      title: `Edit ${c.name}`,
      fields: [{ key: "hp", label: "Hit points now", type: "number", min: 0, value: c.hp ?? "" }, { key: "hpMax", label: "Hit point maximum", type: "number", min: 0, value: c.hpMax ?? "" },
        { key: "ac", label: "Armor class", type: "number", min: 0, max: 99, value: c.ac ?? "" }],
      save: async v => {
        const ch = {};
        if (v.hpMax != null) ch.hpMax = v.hpMax;
        if (v.hp != null) ch.hp = v.hp;
        if (v.ac != null) ch.ac = v.ac;
        await run({ creatures: payload({ [c.i]: ch }) });
      },
    });
    return h("div", {}, dataTable({
      key: `sheet.${m.id}.creatures`, rows: list, empty: "No companions yet. Add a familiar, pet or summon from the monster list.",
      columns: [{ label: "Name", text: c => c.name }, { label: "Kind", text: c => c.kind },
        { label: "HP", text: c => (c.hp != null ? `${c.hp}/${c.hpMax}` : ""), show: c => (c.hp == null ? "—" : h("span", { className: "nowrap" },
          h("button", { className: "tiny", textContent: "−", onclick: () => hpNow(c, Math.max(0, c.hp - 1)) }), ` ${c.hp}/${c.hpMax} `,
          h("button", { className: "tiny", textContent: "+", onclick: () => hpNow(c, Math.min(c.hpMax || 1e4, c.hp + 1)) }))) },
        { label: "AC", text: c => (c.ac != null ? String(c.ac) : "") }],
      detail: c => (m.companions?.[c.i] ? statBlock(m.companions[c.i], c) : null),
      actions: c => [h("button", { className: "tiny", textContent: "✎", title: "Edit hit points and armor class", onclick: () => edit(c) }),
        h("button", { className: "tiny danger", textContent: "✕", title: "Remove", onclick: () => { if (confirm(`Remove ${c.name}?`)) run({ creatures: payload({}, c.i) }); } })],
    }), addCompanion ? h("div", { className: "row addbar" }, h("button", { className: "primary", textContent: "+ Add companion", onclick: addCompanion })) : null);
  }

  return { stats, trackerExtras, inventory, stepper, spells, features, counts };
})();
