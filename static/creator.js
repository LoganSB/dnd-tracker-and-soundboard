"use strict";
// =============================================================================
// creator.js - making a new character and levelling one up, as pop-ups.
//
//   Creator.open({ onCreated(id), isDM })   the character creation wizard: Basics, Race, Class, Background, Abilities, Level choices (hit points and ability score
//                                           improvements, when the level is above 1), Equipment, Spells, Review. onCreated(id) is called with the new character's id.
//   LevelUp.open(m, { onDone(character), onFinish(), addSpells() })   the level-up pop-up for the character record `m`: pick the class (a multiclass shows why it is refused), see what the level
//                                           brings, choose hit points (average or roll), an ability score improvement or feat, a sub-class; then it applies.
//
// ALL THE RULES ARE ON THE SERVER (creation.py, charbuild.py, rules5e.py); this file asks for the rule book (GET /api/rules/...), gathers the choices and sends them
// (POST /api/party/create, POST /api/party/<id>/levelup). It checks what it can as you go (a standard array used once, 27 points of point buy, the right number of skills)
// so that most mistakes are caught before Create, but the server checks everything again and its message is shown.
// Needs ui.js, nodes.js, finder.js and spells.js loaded first.
// =============================================================================
const Creator = (() => {
  const { h, api } = UI;
  const ABIL = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
  const ABIL_NAMES = ["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"];
  const SKILLS = ["Acrobatics", "Animal Handling", "Arcana", "Athletics", "Deception", "History", "Insight", "Intimidation", "Investigation", "Medicine", "Nature", "Perception",
    "Performance", "Persuasion", "Religion", "Sleight of Hand", "Stealth", "Survival"];
  const mod = s => Math.floor((s - 10) / 2);
  const sgn = n => (n >= 0 ? "+" : "") + n;
  const d = n => 1 + Math.floor(Math.random() * n);
  const cache = {};
  const load = (url) => (cache[url] ||= api(url).catch(e => { delete cache[url]; throw e; }));
  const label = (text, ...kids) => h("label", { className: "ef" }, h("span", { className: "muted", textContent: text }), ...kids);
  const select = (options, value, onchange) => { const s = h("select", { onchange: () => onchange?.(s.value) }, options.map(([v, t]) => h("option", { value: v, textContent: t }))); if (value != null) s.value = value; return s; };
  const abilityOptions = (skip = []) => ABIL.map((a, i) => [String(i), ABIL_NAMES[i]]).filter(([v]) => !skip.includes(+v));

  // ---------------------------------------------------------------- the ability score improvement chooser (creation and level-up share it)
  // asiChooser(title) -> { el, get() }: get() returns the decision the server takes ({type: "asi", inc: [i, j]} or {type: "feat", feat}) or throws Error when it is not complete.
  function asiChooser(title) {
    const kind = select([["two", "+2 to one ability"], ["one", "+1 to two abilities"], ["feat", "A feat instead"]], "two", () => draw());
    const body = h("div", { className: "row" });
    const a = select(abilityOptions(), "0"), b = select(abilityOptions(), "1"), c = select(abilityOptions(), "0");
    const featSel = select([["", "(a feat from the list…)"]], "", v => {
      const f = (list.find(x => x.slug === v)); if (f) { name.value = f.name; text.value = (f.prerequisite ? f.prerequisite + "\n\n" : "") + f.text; }
    });
    const name = h("input", { placeholder: "Feat name", className: "grow" }), text = h("textarea", { rows: 4, placeholder: "What the feat does (kept on the sheet)" });
    const plus = select([["", "no ability point"], ...abilityOptions()], "");
    let list = [];
    load("/api/rules/feats").then(l => { list = l; featSel.append(...l.map(f => h("option", { value: f.slug, textContent: `${f.name}${f.prerequisite ? " (" + f.prerequisite.replace(/^Prerequisite:\s*/i, "") + ")" : ""}` }))); }).catch(() => { /* a feat can still be typed */ });
    const draw = () => {
      body.replaceChildren(...(kind.value === "two" ? [label("Raise", c)] : kind.value === "one" ? [label("Raise", a), label("and", b)]
        : [h("div", { className: "stack" }, label("From the list", featSel), label("Name", name), label("Text", text), label("It also gives +1 to", plus))]));
    };
    draw();
    return { el: h("fieldset", { className: "efset" }, h("legend", { textContent: title }), label("Choose", kind), body),
      get() {
        if (kind.value === "two") return { type: "asi", inc: [+c.value, +c.value] };
        if (kind.value === "one") { if (a.value === b.value) throw new Error("Pick two different abilities for +1 each"); return { type: "asi", inc: [+a.value, +b.value] }; }
        if (!name.value.trim()) throw new Error("Name the feat you take");
        return { type: "feat", feat: { name: name.value.trim(), text: text.value, ability: plus.value === "" ? null : +plus.value } };
      } };
  }

  // ---------------------------------------------------------------- the creation wizard
  function open({ onCreated, isDM } = {}) {
    const S = { name: "", level: 1, owner: "", race: null, raceSlug: "", subrace: "", raceChoices: [], looks: {}, cls: null, clsSlug: "", subclass: "", skills: [], bg: null, bgSlug: "", bgSkills: [],
      method: "standard", abilities: [15, 14, 13, 12, 10, 8], hpMode: "average", hpRolls: [], asis: [], equipMode: "package", picks: [], gold: 0, equip: null, cantrips: [], spells: [] };
    const body = h("div", { className: "creator" });
    const err = h("p", { className: "bad" });
    const steps = [["Basics", basics], ["Race", race], ["Class", klass], ["Background", background], ["Abilities", abilities], ["Choices", choices], ["Equipment", equipment], ["Spells", spells], ["Review", review]];
    let at = 0, dlg = null, busy = false;
    const nav = h("div", { className: "row creatornav" });

    // the ability scores as the sheet will show them (base + race + the improvements chosen so far)
    const raceBonus = () => { const out = [0, 0, 0, 0, 0, 0]; if (!S.race) return out;
      const sub = S.race.subraces.find(s => s.slug === S.subrace);
      for (const [k, v] of Object.entries(S.race.bonuses)) out[+k] += v;
      if (sub) for (const [k, v] of Object.entries(sub.bonuses)) out[+k] += v;
      S.raceChoices.forEach((ab, i) => { if (ab != null && ab !== "") out[+ab] += [...S.race.choices, ...(sub?.choices || [])][i] || 0; });
      return out; };
    const finalScores = () => { const sc = S.abilities.map((v, i) => v + raceBonus()[i]);
      S.asis.forEach(x => { try { const g = x.get(); if (g.type === "asi") g.inc.forEach(i => sc[i]++); else if (g.feat.ability != null) sc[g.feat.ability]++; } catch (_) { /* not chosen yet */ } });
      return sc; };
    const asiLevels = () => (S.cls ? S.cls.asiLevels.filter(l => l <= S.level) : []);

    // -- Basics
    function basics() {
      const name = h("input", { value: S.name, placeholder: "Character name", className: "grow", oninput: () => (S.name = name.value) });
      const level = h("input", { type: "number", min: 1, max: 20, value: S.level, className: "inum", onchange: () => { S.level = Math.max(1, Math.min(20, +level.value || 1)); S.asis = []; S.hpRolls = []; } });
      const owner = isDM ? h("input", { value: S.owner, placeholder: "user name (optional)", oninput: () => (S.owner = owner.value) }) : null;
      return [h("p", { className: "muted", textContent: "Everything here is the rule book's (Open5e): races, classes and backgrounds include the core rules and the Kobold Press / third-party books. Start at level 1, or at a higher level for a character who joins a game in progress." }),
        label("Name", name), label("Starting level (1 to 20)", level), owner ? label("Belongs to", owner) : null];
    }
    // -- Race
    function race() {
      const wrap = h("div", { className: "stack" });
      const fill = async () => {
        wrap.replaceChildren();
        if (!S.raceSlug) return;
        S.race = await load("/api/rules/races/" + S.raceSlug);
        const sub = S.race.subraces.find(s => s.slug === S.subrace);
        const picks = [...S.race.choices, ...(sub?.choices || [])];
        if (S.raceChoices.length !== picks.length) S.raceChoices = picks.map(() => "");
        const fixed = { ...S.race.bonuses }; if (sub) for (const [k, v] of Object.entries(sub.bonuses)) fixed[k] = (fixed[k] || 0) + v;
        wrap.append(h("p", { textContent: `Ability bonuses: ${Object.entries(fixed).map(([k, v]) => `${ABIL[+k]} ${sgn(v)}`).join(", ") || "none fixed"}. Speed ${S.race.speed} ft, ${S.race.size}.` }));
        if (S.race.subraces.length) wrap.append(label("Subrace", select([["", "(choose)"], ...S.race.subraces.map(s => [s.slug, s.name])], S.subrace, v => { S.subrace = v; S.raceChoices = []; fill(); })));
        picks.forEach((v, i) => wrap.append(label(`+${v} to`, select([["", "(choose an ability)"], ...abilityOptions(Object.keys(fixed).map(Number))], S.raceChoices[i], x => { S.raceChoices[i] = x; }))));
        wrap.append(h("fieldset", { className: "efset" }, h("legend", { textContent: "Looks (optional)" }), h("div", { className: "efgrid" },
          ...["age", "height", "weight", "eyes", "skin", "hair"].map(k => label(k[0].toUpperCase() + k.slice(1), h("input", { value: S.looks[k] || "", oninput: ev => (S.looks[k] = ev.target.value) }))))));
        wrap.append(h("details", {}, h("summary", { textContent: "Racial traits" }), ...[...S.race.feats, ...(sub?.feats || [])].map(f => h("p", {}, h("b", { textContent: f.name + ". " }), f.text))));
      };
      const list = h("div", {}, h("p", { className: "muted", textContent: "Loading races…" }));
      load("/api/rules/races").then(rows => { list.replaceChildren(label("Race", select([["", "(choose)"], ...rows.map(r => [r.slug, r.name + (r.source && r.source !== "5e Core Rules" ? ` (${r.source})` : "")])], S.raceSlug, v => { S.raceSlug = v; S.subrace = ""; S.raceChoices = []; fill(); }))); }).catch(e => list.replaceChildren(h("p", { className: "bad", textContent: e.message })));
      fill();
      return [list, wrap];
    }
    // -- Class
    function klass() {
      const wrap = h("div", { className: "stack" });
      const fill = async () => {
        wrap.replaceChildren();
        if (!S.clsSlug) return;
        const c = S.cls = await load("/api/rules/classes/" + S.clsSlug);
        wrap.append(h("p", { textContent: `Hit die d${c.hd}. Saving throws ${c.saves.map(i => ABIL[i]).join(", ")}. Armor: ${c.armor || "none"}. Weapons: ${c.weapons || "none"}. Tools: ${c.tools || "none"}.` }));
        if (c.subclass.options.length && S.level >= c.subclass.level) {
          wrap.append(label(c.subclass.label, select([["", "(choose)"], ...c.subclass.options.map(o => [o.slug, o.name + (o.source && o.source !== "5e Core Rules" ? ` (${o.source})` : "")])], S.subclass, v => (S.subclass = v))));
        } else if (c.subclass.options.length) wrap.append(h("p", { className: "muted", textContent: `Its ${c.subclass.label.toLowerCase()} is chosen at level ${c.subclass.level}: take it with Level up.` }));
        const left = () => S.skills.length;
        const info = h("p", { className: "muted" });
        const boxes = c.skills.options.map(i => { const cb = h("input", { type: "checkbox", checked: S.skills.includes(i), onchange: () => {
          if (cb.checked) S.skills.push(i); else S.skills = S.skills.filter(x => x !== i);
          if (left() > c.skills.count) { S.skills = S.skills.filter(x => x !== i); cb.checked = false; }
          info.textContent = `${left()} of ${c.skills.count} chosen`; } });
          return h("label", { className: "check" }, cb, " " + SKILLS[i]); });
        info.textContent = `${left()} of ${c.skills.count} chosen`;
        wrap.append(h("fieldset", { className: "efset" }, h("legend", { textContent: `Class skills: choose ${c.skills.count}` }), h("div", { className: "efgrid" }, ...boxes), info));
      };
      const list = h("div", {}, h("p", { className: "muted", textContent: "Loading classes…" }));
      load("/api/rules/classes").then(rows => { list.replaceChildren(label("Class", select([["", "(choose)"], ...rows.map(r => [r.slug, r.name])], S.clsSlug, v => { S.clsSlug = v; S.subclass = ""; S.skills = []; S.asis = []; S.picks = []; S.equip = null; S.cantrips = []; S.spells = []; fill(); }))); }).catch(e => list.replaceChildren(h("p", { className: "bad", textContent: e.message })));
      fill();
      return [list, wrap];
    }
    // -- Background
    function background() {
      const wrap = h("div", { className: "stack" });
      const fill = async () => {
        wrap.replaceChildren();
        if (!S.bgSlug) return;
        const b = S.bg = await load("/api/rules/backgrounds/" + S.bgSlug);
        if (S.bgSkills.length !== b.extraSkills) S.bgSkills = Array(b.extraSkills).fill("");
        wrap.append(h("p", { textContent: `Skills: ${b.skills.map(i => SKILLS[i]).join(", ") || "none fixed"}. Tools: ${b.tools || "none"}. Languages: ${b.languages || "none"}.` }),
          h("p", {}, h("b", { textContent: (b.feature.name || "Feature") + ". " }), b.feature.text));
        S.bgSkills.forEach((v, i) => wrap.append(label("Another skill of your choice", select([["", "(choose a skill)"], ...SKILLS.map((s, k) => [String(k), s])], S.bgSkills[i], x => { S.bgSkills[i] = x; }))));
      };
      const list = h("div", {}, h("p", { className: "muted", textContent: "Loading backgrounds…" }));
      load("/api/rules/backgrounds").then(rows => { list.replaceChildren(label("Background", select([["", "(choose)"], ...rows.map(r => [r.slug, r.name + (r.source && r.source !== "5e Core Rules" ? ` (${r.source})` : "")])], S.bgSlug, v => { S.bgSlug = v; S.bgSkills = []; S.equip = null; fill(); }))); }).catch(e => list.replaceChildren(h("p", { className: "bad", textContent: e.message })));
      fill();
      return [list, wrap];
    }
    // -- Abilities
    function abilities() {
      const out = h("div", {});
      const bonus = raceBonus();
      const draw = () => {
        const rows = ABIL.map((a, i) => {
          const base = S.abilities[i], total = base + bonus[i];
          let input;
          if (S.method === "standard") input = select([...[15, 14, 13, 12, 10, 8].map(v => [String(v), String(v)])], String(base), v => { S.abilities[i] = +v; draw(); });
          else if (S.method === "pointbuy") input = h("span", { className: "nowrap" }, h("button", { type: "button", className: "tiny", textContent: "−", onclick: () => { if (base > 8) { S.abilities[i]--; draw(); } } }), ` ${base} `,
            h("button", { type: "button", className: "tiny", textContent: "+", onclick: () => { if (base < 15 && spent() + (base >= 13 ? 2 : 1) <= 27) { S.abilities[i]++; draw(); } } }));
          else if (S.method === "roll") input = h("b", { textContent: String(base) });
          else input = h("input", { type: "number", min: 1, max: 20, value: base, className: "inum", onchange: ev => { S.abilities[i] = Math.max(1, Math.min(20, +ev.target.value || 10)); draw(); } });
          return h("tr", {}, h("td", { textContent: ABIL_NAMES[i] }), h("td", {}, input), h("td", { className: "muted", textContent: bonus[i] ? sgn(bonus[i]) + " race" : "" }), h("td", {}, h("b", { textContent: String(total) }), ` (${sgn(mod(total))})`));
        });
        out.replaceChildren(h("table", { className: "loot" }, h("thead", {}, h("tr", {}, ["Ability", "Base", "", "Score (modifier)"].map(t => h("th", { textContent: t })))), h("tbody", {}, rows)),
          S.method === "pointbuy" ? h("p", { className: "muted", textContent: `${27 - spent()} of 27 points left (8 to 15; 14 and 15 cost 2 each)` }) : null,
          S.method === "standard" && new Set(S.abilities).size !== 6 ? h("p", { className: "bad", textContent: "Use each of 15, 14, 13, 12, 10 and 8 once." }) : null,
          S.method === "roll" ? h("button", { type: "button", textContent: "🎲 Roll 4d6, drop the lowest, six times", onclick: () => { S.abilities = ABIL.map(() => { const r = [d(6), d(6), d(6), d(6)].sort((x, y) => x - y); return r[1] + r[2] + r[3]; }); draw(); } }) : null);
      };
      const spent = () => S.abilities.reduce((n, v) => n + ({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 }[v] ?? 99), 0);
      const method = select([["standard", "Standard array (15, 14, 13, 12, 10, 8)"], ["pointbuy", "Point buy (27 points)"], ["roll", "Roll 4d6, drop the lowest"], ["manual", "Enter the scores myself"]], S.method, v => {
        S.method = v; S.abilities = v === "standard" ? [15, 14, 13, 12, 10, 8] : v === "pointbuy" ? [8, 8, 8, 8, 8, 8] : v === "roll" ? [10, 10, 10, 10, 10, 10] : [10, 10, 10, 10, 10, 10]; draw(); });
      draw();
      return [label("How to set the scores", method), out];
    }
    // -- Choices: hit points and ability score improvements
    function choices() {
      if (!S.cls) return [h("p", { className: "muted", textContent: "Choose a class first." })];
      const hd = S.cls.hd, levels = S.level - 1;
      const kids = [];
      if (levels > 0) {
        const mode = select([["average", `Average (${Math.floor(hd / 2) + 1} a level)`], ["roll", `Roll d${hd} for each level`]], S.hpMode, v => { S.hpMode = v; draw(); });
        const rolls = h("div", { className: "efgrid" });
        const draw = () => {
          rolls.replaceChildren();
          if (S.hpMode !== "roll") return;
          if (S.hpRolls.length !== levels) S.hpRolls = Array(levels).fill(null);
          S.hpRolls.forEach((v, i) => { const inp = h("input", { type: "number", min: 1, max: hd, value: v ?? "", className: "inum", onchange: () => { S.hpRolls[i] = Math.max(1, Math.min(hd, +inp.value || 1)); } });
            rolls.append(label(`Level ${i + 2}`, h("span", { className: "nowrap" }, inp, " ", h("button", { type: "button", className: "tiny", textContent: "🎲", onclick: () => { S.hpRolls[i] = d(hd); inp.value = S.hpRolls[i]; } })))); });
        };
        draw();
        kids.push(h("fieldset", { className: "efset" }, h("legend", { textContent: "Hit points" }), h("p", { className: "muted", textContent: `Level 1 takes the whole die (${hd}) plus Constitution; each later level the average or a roll, plus Constitution (at least 1).` }), label("Levels 2 to " + S.level, mode), rolls));
      }
      const lv = asiLevels();
      if (S.asis.length !== lv.length) S.asis = lv.map((l) => asiChooser(`Level ${l}: ability score improvement`));
      S.asis.forEach(a => kids.push(a.el));
      if (!kids.length) kids.push(h("p", { className: "muted", textContent: "A level 1 character has no further choices: continue." }));
      return kids;
    }
    // -- Equipment
    function equipment() {
      if (!S.cls || !S.bgSlug) return [h("p", { className: "muted", textContent: "Choose a class and a background first." })];
      const wrap = h("div", { className: "stack" });
      const draw = () => {
        wrap.replaceChildren();
        const mode = select([["package", "The class's equipment and the background's"], ["gold", "Starting gold instead (buy your own)"], ["none", "None (add items later)"]], S.equipMode, v => { S.equipMode = v; draw(); });
        wrap.append(label("Starting equipment", mode));
        if (S.equipMode === "package" && S.equip) {
          S.equip.lines.forEach((line, n) => {
            if (S.picks[n] == null) S.picks[n] = 0;
            if (line.options) wrap.append(h("fieldset", { className: "efset" }, h("legend", { textContent: "Choose one" }), ...line.options.map((o, k) => h("label", { className: "check" },
              h("input", { type: "radio", name: "eq" + n, checked: S.picks[n] === k, onchange: () => (S.picks[n] = k) }), " " + o.text))));
            else wrap.append(h("p", { textContent: "• " + line.fixed.text }));
          });
          if (S.equip.background.length) wrap.append(h("p", { className: "muted", textContent: "Background: " + S.equip.background.map(i => (i.qty > 1 && i.kind !== "coin" ? i.qty + " " : "") + i.name).join(", ") }));
        }
        if (S.equipMode === "gold") {
          const m = (S.cls.wealth || "4d4x10").match(/(\d+)d(\d+)(?:x(\d+))?/), n = +m[1], sides = +m[2], mult = +(m[3] || 1);
          const gold = h("input", { type: "number", min: 0, max: n * sides * mult, value: S.gold, className: "inum", onchange: () => (S.gold = Math.max(0, +gold.value || 0)) });
          wrap.append(h("p", { className: "muted", textContent: `A ${S.cls.name} starts with ${S.cls.wealth.replace("x", " × ")} gold pieces.` }), label("Gold", h("span", { className: "nowrap" }, gold, " ",
            h("button", { type: "button", textContent: "🎲 Roll", onclick: () => { let t = 0; for (let i = 0; i < n; i++) t += d(sides); S.gold = t * mult; gold.value = S.gold; } }))));
        }
      };
      if (S.equip) draw(); else {
        wrap.append(h("p", { className: "muted", textContent: "Loading the equipment…" }));
        api(`/api/rules/equipment?class=${S.clsSlug}&background=${S.bgSlug}`).then(e => { S.equip = e; draw(); }).catch(e => wrap.replaceChildren(h("p", { className: "bad", textContent: e.message })));
      }
      return [wrap];
    }
    // -- Spells
    function allowance() {
      if (!S.cls || !S.cls.caster) return null;
      const row = S.cls.levels[S.level - 1], sc = finalScores(), ab = S.cls.spellAbility;
      if (!row) return null;
      let spells;
      if (row.spellsKnown) spells = row.spellsKnown;
      else if (S.cls.slug === "wizard") spells = 6 + 2 * (S.level - 1);
      else spells = Math.max(1, mod(sc[ab]) + (S.cls.caster === "half" ? Math.floor(S.level / 2) : S.level));
      const top = row.pact ? row.pact.level : Math.max(0, ...row.slots.map((n, i) => (n ? i + 1 : 0)));
      return { cantrips: row.cantrips, spells, top, kind: row.spellsKnown ? "known" : S.cls.slug === "wizard" ? "spellbook" : "prepared" };
    }
    function spells() {
      const a = allowance();
      if (!a) return [h("p", { className: "muted", textContent: S.cls ? `${S.cls.name} does not cast spells at level ${S.level}: continue.` : "Choose a class first." })];
      const summary = h("div", {}), panelBox = h("div", {});
      const draw = () => {
        const chip = (slug, list) => h("span", { className: "chip" }, slug.name, " ", h("button", { type: "button", className: "tiny", textContent: "✕", onclick: () => { S[list] = S[list].filter(x => x.slug !== slug.slug); draw(); } }));
        summary.replaceChildren(h("p", {}, h("b", { textContent: `Cantrips ${S.cantrips.length} of ${a.cantrips}: ` }), ...S.cantrips.map(s => chip(s, "cantrips"))),
          h("p", {}, h("b", { textContent: `Spells ${S.spells.length} of ${a.spells}${a.kind === "prepared" ? " (prepared each day from the whole list)" : a.kind === "spellbook" ? " (in your spellbook)" : ""}: ` }), ...S.spells.map(s => chip(s, "spells"))));
      };
      draw();
      const panel = Spells.panel(row => {
        const into = row.level === 0 ? "cantrips" : "spells", cap = row.level === 0 ? a.cantrips : a.spells;
        if (S[into].some(x => x.slug === row.slug)) return;
        if (row.level > a.top) { alert(`A level ${S.level} ${S.cls.name} has no spell slots of level ${row.level} yet`); return; }
        if (S[into].length >= cap) { alert(row.level === 0 ? `You know ${a.cantrips} cantrips` : `You can have ${a.spells} spells`); return; }
        S[into].push({ slug: row.slug, name: row.name }); draw();
      }, { compact: true, defaultClass: S.cls.name });
      panelBox.append(h("p", { className: "muted", textContent: "Click a spell (or its +) to take it. Cantrips and spells you leave out can be added later from the sheet." }), panel.el);
      return [summary, panelBox];
    }
    // -- Review
    function review() {
      const sc = finalScores(), a = allowance();
      return [h("h3", { textContent: S.name || "(no name)" }), h("p", { textContent: `${S.race ? (S.race.subraces.find(s => s.slug === S.subrace)?.name || S.race.name) : "?"} ${S.cls ? S.cls.name : "?"}, level ${S.level}${S.bg ? ", " + S.bg.name : ""}` }),
        h("p", { textContent: ABIL.map((x, i) => `${x} ${sc[i]} (${sgn(mod(sc[i]))})`).join("   ") }),
        h("p", { className: "muted", textContent: `Hit points: ${S.cls ? S.cls.hd + mod(sc[2]) + (S.level - 1) * ((S.hpMode === "average" ? Math.floor(S.cls.hd / 2) + 1 : S.cls.hd / 2 + 0.5) + mod(sc[2])) : "?"} (about). Equipment: ${S.equipMode}. ${a ? `Spells: ${S.cantrips.length} cantrips, ${S.spells.length} spells.` : ""}` }),
        h("p", { className: "muted", textContent: "Create saves the character to your characters. You can edit, level up and download it like any other." })];
    }

    // -- the frame
    const body2 = () => { err.textContent = ""; body.replaceChildren(h("h3", { textContent: `${at + 1}. ${steps[at][0]}` }), ...steps[at][1]().filter(Boolean)); drawNav(); };
    const drawNav = () => nav.replaceChildren(h("span", { className: "muted grow", textContent: steps.map(([t], i) => (i === at ? `[${t}]` : t)).join(" › ") }),
      h("button", { type: "button", textContent: "Back", disabled: at === 0, onclick: () => { at--; body2(); } }),
      at < steps.length - 1 ? h("button", { type: "button", className: "primary", textContent: "Next", onclick: () => next() })
        : h("button", { type: "button", className: "primary", textContent: "Create character", disabled: busy, onclick: create }));
    const problem = () => {   // what stops moving on from this step
      const t = steps[at][0];
      if (t === "Basics" && !S.name.trim()) return "Give the character a name";
      if (t === "Race") { if (!S.race) return "Choose a race"; if (S.race.subraces.length && !S.subrace) return "Choose a subrace"; if (S.raceChoices.some(x => x === "" || x == null) || new Set(S.raceChoices).size !== S.raceChoices.length) return "Choose the abilities your race raises (each a different one)"; }
      if (t === "Class") { if (!S.cls) return "Choose a class"; if (S.skills.length !== S.cls.skills.count) return `Choose ${S.cls.skills.count} class skills`; if (S.cls.subclass.options.length && S.level >= S.cls.subclass.level && !S.subclass) return `Choose a ${S.cls.subclass.label.toLowerCase()}`; }
      if (t === "Background") { if (!S.bg) return "Choose a background"; if (S.bgSkills.some(x => x === "")) return "Choose the extra skill(s)"; if (S.skills.some(i => S.bg.skills.includes(i) || S.bgSkills.map(Number).includes(i))) return "A skill cannot come from both the class and the background: change one"; }
      if (t === "Abilities") { if (S.method === "standard" && new Set(S.abilities).size !== 6) return "Use each number of the standard array once"; }
      if (t === "Choices") for (const a of S.asis) { try { a.get(); } catch (e) { return e.message; } }
      if (t === "Equipment" && S.equipMode === "gold" && !S.gold) return "Roll or enter your starting gold";
      return "";
    };
    const next = () => { const p = problem(); if (p) { err.textContent = p; return; } at++; body2(); };
    async function create() {
      busy = true; drawNav();
      try {
        const sc = S.asis.map(a => a.get());
        const res = await api("/api/party/create", "POST", { name: S.name.trim(), level: S.level, owner: S.owner, race: S.raceSlug, subrace: S.subrace, raceChoices: S.raceChoices.map(Number), looks: S.looks,
          background: S.bgSlug, bgSkills: S.bgSkills.map(Number), class: S.clsSlug, subclass: S.subclass, skills: S.skills, abilityMethod: S.method, abilities: S.abilities,
          hpRolls: S.hpMode === "roll" ? S.hpRolls : null, asi: sc, equipment: { mode: S.equipMode, picks: S.picks, gold: S.gold },
          spells: { cantrips: S.cantrips.map(x => x.slug), spells: S.spells.map(x => x.slug) } });
        dlg.close();
        onCreated?.(res.id, res.character);
      } catch (e) { err.textContent = e.message; }
      busy = false; drawNav();
    }
    dlg = Nodes.popup({ title: "New character", body: h("div", {}, body, err, nav) });
    body2();
    return dlg;
  }

  return { open, asiChooser };
})();

const LevelUp = (() => {
  const { h, api } = UI;
  const sgn = n => (n >= 0 ? "+" : "") + n;
  const d = n => 1 + Math.floor(Math.random() * n);

  // open(m, { onDone(character), onFinish(), addSpells() }): onDone is called when the level is applied (m is already updated), onFinish when the page's Done button is
  // pressed, addSpells() when Add spells is.
  function open(m, { onDone, onFinish, addSpells } = {}) {
    const body = h("div", { className: "creator" }), err = h("p", { className: "bad" });
    const dlg = Nodes.popup({ title: `Level up ${m.name}`, body: h("div", {}, body, err) });
    const fail = e => { err.textContent = e.message; };
    async function start() {
      err.textContent = "";
      body.replaceChildren(h("p", { className: "muted", textContent: "Loading…" }));
      let info;
      try { info = await api(`/api/party/${m.id}/levelup`); } catch (e) { return fail(e); }
      if (!info.canLevel) { body.replaceChildren(h("p", { textContent: "This character is already level 20." })); return; }
      const own = info.classes.map(c => [c.slug, `${c.name} (level ${c.level} → ${c.level + 1})`]);
      const multi = info.options.map(o => [o.slug, `${o.name}${o.problems.length ? " — " + o.problems.join("; ") : " (new class)"}`]);
      const pick = h("select", {}, h("optgroup", { label: "Take a level in" }, own.map(([v, t]) => h("option", { value: v, textContent: t }))),
        h("optgroup", { label: "Multiclass (needs 13 in the abilities involved)" }, multi.map(([v, t]) => h("option", { value: v, textContent: t }))));
      const xp = h("p", { className: "muted", textContent: `Level ${info.total} · ${info.xp} XP${info.xpNext ? ` (level ${info.total + 1} at ${info.xpNext})` : ""}. Levelling up raises XP to the new level's threshold if it is lower.` });
      body.replaceChildren(xp, h("label", { className: "ef" }, h("span", { className: "muted", textContent: "Class" }), pick), h("div", { className: "row" }, h("button", { className: "primary", textContent: "Continue", onclick: () => plan(pick.value) })));
    }
    async function plan(slug) {
      err.textContent = "";
      let p;
      try { p = await api(`/api/party/${m.id}/levelup?class=${encodeURIComponent(slug)}`); } catch (e) { return fail(e); }
      if (p.problems.length) { fail(new Error(p.problems.join("; "))); return; }
      let roll = null;
      const hpInfo = h("p", { textContent: `Hit points: average ${p.hpAverage} (d${p.hd} average ${Math.floor(p.hd / 2) + 1} ${sgn(p.conMod)} Constitution)` });
      const rollBox = h("input", { type: "number", min: 1, max: p.hd, className: "inum", placeholder: "roll", onchange: () => { roll = rollBox.value === "" ? null : Math.max(1, Math.min(p.hd, +rollBox.value)); sync(); } });
      const sync = () => { hpInfo.textContent = roll == null ? `Hit points: average ${p.hpAverage} (d${p.hd} average ${Math.floor(p.hd / 2) + 1} ${sgn(p.conMod)} Constitution)` : `Hit points: rolled ${roll} ${sgn(p.conMod)} Constitution = ${Math.max(1, roll + p.conMod)}`; };
      const asi = p.asi ? Creator.asiChooser("Ability score improvement") : null;
      let sub = "";
      const subSel = p.subclass ? h("select", { onchange: ev => (sub = ev.target.value) }, h("option", { value: "", textContent: "(choose)" }), p.subclass.options.map(o => h("option", { value: o.slug, textContent: o.name + (o.source && o.source !== "5e Core Rules" ? ` (${o.source})` : "") }))) : null;
      body.replaceChildren(...[
        h("h3", { textContent: `${p.class.name}: level ${p.classLevel} (character level ${p.newTotal})` }),
        hpInfo, h("div", { className: "row" }, h("button", { type: "button", textContent: `🎲 Roll d${p.hd}`, onclick: () => { roll = d(p.hd); rollBox.value = roll; sync(); } }), rollBox, h("button", { type: "button", className: "tiny", textContent: "Use the average", onclick: () => { roll = null; rollBox.value = ""; sync(); } })),
        p.features.length ? h("div", {}, h("h4", { textContent: "New features" }), ...p.features.map(f => h("details", {}, h("summary", { textContent: f.name }), h("p", { textContent: f.text || "(see the class description)" })))) : h("p", { className: "muted", textContent: "No new class features at this level." }),
        Object.keys(p.extra || {}).length ? h("p", { className: "muted", textContent: Object.entries(p.extra).map(([k, v]) => `${k}: ${v}`).join(" · ") }) : null,
        subSel ? h("label", { className: "ef" }, h("span", { className: "muted", textContent: p.subclass.label }), subSel) : null,
        asi ? asi.el : null,
        p.newCantrips || p.newSpells ? h("p", {}, `New spells: ${p.newCantrips ? p.newCantrips + " cantrip(s)" : ""}${p.newCantrips && p.newSpells ? " and " : ""}${p.newSpells ? p.newSpells + " spell(s)" : ""} to learn: add them from Spells after levelling.`) : null,
        h("div", { className: "row" }, h("button", { textContent: "Back", onclick: start }), h("button", { className: "primary", textContent: `Level up to ${p.newTotal}`, onclick: async ev => {
          err.textContent = "";
          let decision = null;
          try { if (asi) decision = asi.get(); if (subSel && !sub) throw new Error(`Choose a ${p.subclass.label.toLowerCase()}`); } catch (e) { return fail(e); }
          ev.target.disabled = true;
          try {
            const res = await api(`/api/party/${m.id}/levelup`, "POST", { class: slug, roll, asi: decision, subclass: sub });
            done(res, p);
          } catch (e) { fail(e); ev.target.disabled = false; }
        } }))].filter(Boolean));   // (replaceChildren would print a null as the word "null")
    }
    function done(res, p) {
      Object.assign(m, res.character);
      body.replaceChildren(...[h("h3", { textContent: `${m.name} is now level ${res.result.level}` }),
        h("p", { textContent: `+${res.result.hpGain} hit points (${res.character.hpMax} in all).${res.result.features.length ? " New: " + res.result.features.join(", ") + "." : ""}` }),
        p.newCantrips || p.newSpells ? h("p", { className: "ok", textContent: "You can learn new spells now." }) : null,
        h("div", { className: "row" }, p.newCantrips || p.newSpells ? h("button", { className: "primary", textContent: "Add spells", onclick: () => { dlg.close(); addSpells?.(); } }) : null, h("button", { textContent: "Done", onclick: () => { dlg.close(); onFinish?.(); } }))].filter(Boolean));
      onDone?.(res.character);
    }
    start();
    return dlg;
  }
  return { open };
})();
