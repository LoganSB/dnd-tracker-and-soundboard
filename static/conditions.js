"use strict";
// =============================================================================
// conditions.js - what the 5th-edition conditions say and do, and what they change on a character's stats
// =============================================================================
//
// One table of the standard conditions (the SRD wording, shortened) and the rules that follow from them. Vitals.conditions (vitals.js) shows
// the descriptions under the condition chips; the character sheet's Statistics (sheet.js) uses effects() to adjust the numbers and to say
// WHY a number changed. A condition is stored on the character as plain text ("Prone, Exhaustion 2, Hexed"); anything not in the table (a custom
// condition) simply has no description and no effect.
//
//   Conditions.NAMES                  the standard names, for the Add menu (Exhaustion is added at level 1 and changed with its arrows)
//   Conditions.parse(text)            "Prone, Exhaustion 2" -> [{ text, key, level, def }]  (key null for a custom condition)
//   Conditions.describe(entry)        { text, lines } what it does, and the lines naming what it changes on the stats
//   Conditions.effects(entries)       what all the conditions together do to the numbers:
//                                       { speed: null | { kind: "zero" | "half", why: [names] },
//                                         perception: null | { delta: -5, why: [names] },       (disadvantage on ability checks)
//                                         attacks: [names],                                       (disadvantage on your attack rolls)
//                                         saves: [names],                                         (disadvantage on saving throws)
//                                         noActions: [names], hpMax: [names] }
//   Conditions.speed(base, speedEffect)  the speed once an effect is applied (halved is rounded down to a multiple of 5)
//
// What is applied to the numbers: speed 0 or half, passive Perception -5 (disadvantage on ability checks is -5 to a passive score), and flags
// for disadvantage on attack rolls and saves, no actions, and halved hit point maximum. Advantage others get against you, automatic failures
// and the like are in the description only.
const Conditions = (() => {
  const EXHAUSTION = [
    "Disadvantage on ability checks.",
    "Speed halved.",
    "Disadvantage on attack rolls and saving throws.",
    "Hit point maximum halved.",
    "Speed reduced to 0.",
    "Death.",
  ];

  // text: the rules. The other fields say what changes: speed ("zero" | "half"), checks / attacks / saves (disadvantage), noActions, and `lines`
  // for the readable effect lines.
  const DATA = {
    Blinded: { text: "You can't see and automatically fail any check that requires sight. Attack rolls against you have advantage, and your attack rolls have disadvantage.", attacks: true },
    Charmed: { text: "You can't attack the charmer or target them with harmful abilities or magical effects. The charmer has advantage on any ability check to interact with you socially." },
    Deafened: { text: "You can't hear and automatically fail any check that requires hearing." },
    Frightened: { text: "You have disadvantage on ability checks and attack rolls while the source of your fear is in line of sight. You can't willingly move closer to the source.", checks: true, attacks: true, note: "while the source of fear is in sight" },
    Grappled: { text: "Your speed becomes 0 and you can't benefit from any bonus to your speed. It ends if the grappler is incapacitated or the effect moves you out of the grappler's reach.", speed: "zero" },
    Incapacitated: { text: "You can't take actions or reactions.", noActions: true },
    Invisible: { text: "You can't be seen without magic or a special sense (you count as heavily obscured to hide). Attack rolls against you have disadvantage, and your attack rolls have advantage." },
    Paralyzed: { text: "You are incapacitated and can't move or speak. You automatically fail Strength and Dexterity saves. Attack rolls against you have advantage, and any hit from within 5 feet is a critical hit.", speed: "zero", noActions: true },
    Petrified: { text: "You are turned to solid stone (weight x10) and don't age. You are incapacitated, can't move or speak, and are unaware of your surroundings. Attack rolls against you have advantage, you fail Strength and Dexterity saves, you resist all damage and you are immune to poison and disease.", speed: "zero", noActions: true },
    Poisoned: { text: "You have disadvantage on attack rolls and ability checks.", checks: true, attacks: true },
    Prone: { text: "Your only movement option is to crawl (or spend half your movement to stand up). You have disadvantage on attack rolls. Attack rolls against you have advantage from within 5 feet, otherwise disadvantage.", speed: "half", attacks: true, note: "crawling" },
    Restrained: { text: "Your speed becomes 0 and can't increase. Attack rolls against you have advantage, and your attack rolls have disadvantage. You have disadvantage on Dexterity saving throws.", speed: "zero", attacks: true, saves: true },
    Stunned: { text: "You are incapacitated, can't move and can speak only falteringly. You automatically fail Strength and Dexterity saves. Attack rolls against you have advantage.", speed: "zero", noActions: true },
    Unconscious: { text: "You are incapacitated, can't move or speak and are unaware of your surroundings. You drop what you're holding and fall prone. You automatically fail Strength and Dexterity saves. Attack rolls against you have advantage, and any hit from within 5 feet is a critical hit.", speed: "zero", noActions: true },
    Exhaustion: { text: "Exhaustion has six levels, and each level includes the ones below it. A long rest with food and drink lowers it by one. 1: disadvantage on ability checks. 2: speed halved. 3: disadvantage on attack rolls and saving throws. 4: hit point maximum halved. 5: speed reduced to 0. 6: death." },
  };
  const NAMES = Object.keys(DATA);
  const byLower = Object.fromEntries(NAMES.map(n => [n.toLowerCase(), n]));

  // parse(text): the stored text as entries. "Exhaustion 3", "exhaustion (3)" and "Exhaustion" all give key "Exhaustion" with a level (1 when none given).
  function parse(text) {
    return (text || "").split(/[,;]+/).map(x => x.trim()).filter(Boolean).map(raw => {
      const ex = raw.match(/^exhaustion\D*(\d)?$/i);
      if (ex) { const level = Math.max(1, Math.min(6, +ex[1] || 1)); return { text: `Exhaustion ${level}`, key: "Exhaustion", level, def: DATA.Exhaustion }; }
      const key = byLower[raw.toLowerCase()] || null;
      return { text: raw, key, level: 0, def: key ? DATA[key] : null };
    });
  }

  // lines(entry): what this condition changes on the stats, in words.
  function lines(e) {
    const d = e.def, out = [];
    if (!d) return out;
    if (e.key === "Exhaustion") {
      for (let i = 0; i < e.level; i++) out.push(`Level ${i + 1}: ${EXHAUSTION[i]}`);
      return out;
    }
    if (d.speed === "zero") out.push("Speed 0");
    if (d.speed === "half") out.push("Speed halved" + (d.note ? ` (${d.note})` : ""));
    if (d.checks) out.push("Disadvantage on ability checks (passive Perception -5)" + (d.note && !d.speed ? ` ${d.note}` : ""));
    if (d.attacks) out.push("Disadvantage on your attack rolls");
    if (d.saves) out.push("Disadvantage on Dexterity saving throws");
    if (d.noActions) out.push("No actions or reactions");
    return out;
  }
  const describe = e => ({ text: e.def?.text || "", lines: lines(e) });

  // effects(entries): everything the conditions do to the numbers, with the names that cause it (for the "why" shown on the stat).
  function effects(entries) {
    const out = { speed: null, perception: null, attacks: [], saves: [], noActions: [], hpMax: [] };
    const addSpeed = (kind, why) => {
      if (!out.speed) out.speed = { kind, why: [why] };
      else if (kind === "zero" && out.speed.kind === "half") out.speed = { kind: "zero", why: [why] };   // zero beats half
      else if (kind === out.speed.kind) out.speed.why.push(why);
    };
    const addCheck = why => { (out.perception ||= { delta: -5, why: [] }).why.push(why); };
    for (const e of entries) {
      if (!e.def) continue;
      if (e.key === "Exhaustion") {
        const n = e.level;
        if (n >= 1) addCheck(e.text);
        if (n >= 5) addSpeed("zero", e.text); else if (n >= 2) addSpeed("half", e.text);
        if (n >= 3) { out.attacks.push(e.text); out.saves.push(e.text); }
        if (n >= 4) out.hpMax.push(e.text);
        continue;
      }
      const d = e.def;
      if (d.speed) addSpeed(d.speed, e.text);
      if (d.checks) addCheck(e.text);
      if (d.attacks) out.attacks.push(e.text);
      if (d.saves) out.saves.push(e.text);
      if (d.noActions) out.noActions.push(e.text);
    }
    return out;
  }

  // speed(base, effect): the speed in feet after the effect; "half" is rounded down to a multiple of 5 (35 ft becomes 15 ft).
  const speed = (base, eff) => (!eff ? base : eff.kind === "zero" ? 0 : Math.floor(base / 2 / 5) * 5);

  return { NAMES, parse, describe, effects, speed };
})();
