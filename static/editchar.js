"use strict";
// =============================================================================
// editchar.js - the "Edit character" pop-up: change a character's numbers and details
// =============================================================================
//
// EditCharacter.open(m, save)
//   m     the character record (GET /api/party/<id>)
//   save  async (changes) => ...  called when Save is pressed with the changes in the shape PATCH /api/party/<id> takes (fcedit.edit_character in
//         the server): { name, xp, hpMax, unarmed, abilities [6 BASE scores], race {...}, background {name}, classes [{name, level, hd, armor,
//         weapons, tools}], slots [9 maximums], profs {saves, skills} }. If it throws, the message is shown in the pop-up and nothing closes.
//
// WHAT IT EDITS, and why those fields: they are the ones a Fight Club character holds and the Fight Club app lets you change (see FIGHTCLUB-FORMAT.md):
// the six ability scores are the BASE scores (the race, level-up and equipped-item bonuses are added on top, and the pop-up shows the result as you type);
// the class's level and hit die; the race's speed and looks; the maximum spell slots; and which saving throws and skills the character is proficient in.
// Things that have their own place stay there: hit points now, spell slots spent, conditions and trackers (the Tracker page), items (Inventory),
// spells (Spells), features and notes.
//
// Uses Nodes.popup (nodes.js) for the dialog. Needs nodes.js loaded first.
const EditCharacter = (() => {
  const { el } = Nodes;
  const SKILLS = ["Acrobatics", "Animal Handling", "Arcana", "Athletics", "Deception", "History", "Insight", "Intimidation", "Investigation", "Medicine", "Nature",
    "Perception", "Performance", "Persuasion", "Religion", "Sleight of Hand", "Stealth", "Survival"];   // the order Fight Club numbers them (charcalc.SKILLS)
  const ABILITY = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

  // field(label, input): a label above its input
  const field = (label, input, hint) => el("label", { className: "ef" }, el("span", { className: "muted", textContent: label }), input, hint ? el("span", { className: "muted", textContent: hint }) : null);
  const text = (value, extra = {}) => el("input", { type: "text", value: value ?? "", ...extra });
  const num = (value, min, max, extra = {}) => el("input", { type: "number", value: value ?? "", min, max, className: "inum", ...extra });
  const section = (title, ...kids) => el("fieldset", { className: "efset" }, el("legend", { textContent: title }), el("div", { className: "efgrid" }, ...kids));

  function open(m, save) {
    const msg = el("p", { className: "bad" });

    // basics
    const name = text(m.name), xp = num(m.xp || 0, 0, 10000000), hpMax = num(m.hpMax, 1, 9999), unarmed = text(m.unarmed, { placeholder: "e.g. 1d4+%1" });
    // abilities: the base score; the shown score (with bonuses) updates as you type
    const base = m.abilities.map(a => num(a.base, 1, 30));
    const shown = m.abilities.map(() => el("span", { className: "muted" }));
    const refreshShown = () => m.abilities.forEach((a, i) => { shown[i].textContent = `shows ${(+base[i].value || 0) + (a.score - a.base)}`; });
    base.forEach(b => (b.oninput = refreshShown));
    refreshShown();
    // race and looks
    const r = m.raceInfo || {};
    const race = { name: text(r.name), speed: num(r.speed ?? "", 0, 999, { placeholder: "30" }), age: text(r.age), height: text(r.height), weight: text(r.weight), eyes: text(r.eyes), skin: text(r.skin), hair: text(r.hair) };
    const background = text(m.background?.name);
    // classes
    const dieOf = c => (m.hitDice.find(h => h.name === c.name) || {}).hd || 8;
    const classes = m.classes.map(c => ({ name: text(c.name), level: num(c.level || 1, 1, 20), hd: el("select", {}, [6, 8, 10, 12].map(d => el("option", { value: d, textContent: "d" + d }))),
      armor: text(c.armor), weapons: text(c.weapons), tools: text(c.tools) }));
    classes.forEach((c, i) => (c.hd.value = dieOf(m.classes[i])));
    // spell slots: most of each level
    const slots = Array.from({ length: 9 }, (_, i) => num(m.slots[i] || 0, 0, 9));
    // proficiencies
    const box = (checked, label) => { const c = el("input", { type: "checkbox", checked }); return [c, el("label", { className: "check" }, c, " " + label)]; };
    const saves = ABILITY.map((a, i) => box(m.profs.saves.includes(i), a));
    const skills = SKILLS.map((s, i) => box(m.profs.skills.includes(100 + i), s));

    const body = el("form", { className: "editchar", onsubmit: ev => ev.preventDefault() },
      section("Character", field("Name", name), field("Experience points", xp), field("Hit point maximum", hpMax), field("Unarmed strike", unarmed, "damage formula; %1 = ability modifier")),
      section("Ability scores (base)", ...ABILITY.map((a, i) => field(a, el("span", { className: "nowrap" }, base[i], " ", shown[i])))),
      section("Race and looks", field("Race", race.name), field("Speed (ft)", race.speed, "blank = 30"), field("Age", race.age), field("Height", race.height), field("Weight (lb)", race.weight),
        field("Eyes", race.eyes), field("Skin", race.skin), field("Hair", race.hair), field("Background", background)),
      ...classes.map((c, i) => section(m.classes.length > 1 ? `Class ${i + 1}` : "Class", field("Class", c.name), field("Level", c.level), field("Hit die", c.hd), field("Armor", c.armor), field("Weapons", c.weapons), field("Tools", c.tools))),
      section("Spell slots (the most of each level)", ...slots.map((s, i) => field(`Level ${i + 1}`, s))),
      section("Saving throw proficiencies", ...saves.map(x => x[1])),
      section("Skill proficiencies", ...skills.map(x => x[1])),
      msg,
      el("div", { className: "row" }, el("button", { type: "button", className: "primary", textContent: "Save changes", onclick: async ev => {
        ev.target.disabled = true;
        msg.textContent = "";
        try {
          await save({
            name: name.value, xp: +xp.value || 0, hpMax: +hpMax.value || 1, unarmed: unarmed.value, abilities: base.map(b => +b.value || 10),
            race: Object.fromEntries(Object.entries(race).map(([k, v]) => [k, v.value])), background: { name: background.value },
            classes: classes.map(c => ({ name: c.name.value, level: +c.level.value || 1, hd: +c.hd.value, armor: c.armor.value, weapons: c.weapons.value, tools: c.tools.value })),
            slots: slots.map(s => +s.value || 0),
            profs: { saves: saves.flatMap((x, i) => (x[0].checked ? [i] : [])), skills: skills.flatMap((x, i) => (x[0].checked ? [i] : [])) },
          });
          dlg.close();
        } catch (e) { msg.textContent = e.message; ev.target.disabled = false; }
      } })));
    const dlg = Nodes.popup({ title: `Edit ${m.name}`, body, note: "The scores here are the BASE scores: bonuses from the race, level-ups and worn items are added on top." });
    return dlg;
  }

  return { open };
})();
