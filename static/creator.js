"use strict";
// =============================================================================
// creator.js - making a new character and levelling one up, as pop-ups.
//
//   Creator.open({ onCreated(id, character), isDM })   the character creation wizard: Basics, Race, Class, Background, Abilities, Choices (class features to choose, ability score
//                                           improvements, hit points: shown only when there is something to choose), Equipment, Spells (only for a class that gets some), Review.
//   LevelUp.open(m, { onDone(character), onFinish(), addSpells() })   the level-up pop-up for the character record `m`: pick the class (a multiclass shows why it is refused), see
//                                           what the level brings, choose the features it asks for, an ability score improvement or feat, then the hit points; then it applies.
//
// THE RULE BOOK IS FIGHT CLUB'S OWN (codex.py): races, classes, backgrounds, feats, spells and items are the ones in the Fight Club compendium (GET /api/rules/...), and a character
// is made by COPYING them, as Fight Club does. All the rules are on the server (creation.py, charbuild.py); this file gathers the choices and sends them
// (POST /api/party/create, POST /api/party/<id>/levelup). It checks what it can as you go so most mistakes are caught before Create, but the server checks everything again.
// Needs ui.js and nodes.js loaded first.
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
  const load = url => (cache[url] ||= api(url).catch(e => { delete cache[url]; throw e; }));
  const label = (text, ...kids) => h("label", { className: "ef" }, h("span", { className: "muted", textContent: text }), ...kids);
  const select = (options, value, onchange) => { const s = h("select", { onchange: () => onchange?.(s.value) }, options.map(([v, t]) => h("option", { value: v, textContent: t }))); if (value != null) s.value = value; return s; };
  const abilityOptions = () => ABIL.map((a, i) => [String(i), ABIL_NAMES[i]]);
  // a text box that brings up the keyboard on a phone: sixteen pixel text (the phone does not zoom), a hint of what Enter does, and a tap on it focuses it even when the pop-up has redrawn
  const textbox = (props, onenter) => {
    const i = h("input", { enterKeyHint: "next", autocomplete: "off", autocapitalize: "words", ...props, onkeydown: ev => { if (ev.key === "Enter") { ev.preventDefault(); onenter?.(); } } });
    i.addEventListener("touchend", () => setTimeout(() => i.focus(), 0), { passive: true });
    return i;
  };

  // ---------------------------------------------------------------- the ability score improvement chooser (creation and level-up share it)
  // asiChooser(title, onChange) -> { el, get() }: get() returns the decision the server takes ({type: "asi", inc: [i, j]}, {type: "feat", id}, {type: "feat", feat: {...}}) or throws Error
  // when it is not complete.
  function asiChooser(title, onChange) {
    const kind = select([["two", "+2 to one ability"], ["one", "+1 to two abilities"], ["feat", "A feat instead"]], "two", () => draw());
    const body = h("div", { className: "stack" });
    const a = select(abilityOptions(), "0"), b = select(abilityOptions(), "1"), c = select(abilityOptions(), "0");
    let feats = [];
    const blurb = h("p", { className: "muted" });
    const featSel = select([["", "(a feat from the rule book…)"]], "", v => { const f = feats.find(x => String(x.id) === v); blurb.textContent = f ? f.text : ""; custom.hidden = !!f; });
    const name = textbox({ placeholder: "Feat name" }), text = h("textarea", { rows: 3, placeholder: "What it does (kept on the sheet)" });
    const plus = select([["", "no ability point"], ...abilityOptions()], "");
    const custom = h("div", { className: "stack" }, label("Or write your own: name", name), label("Text", text), label("It also gives +1 to", plus));
    load("/api/rules/feats").then(l => { feats = l; featSel.append(...l.map(f => h("option", { value: String(f.id), textContent: f.name }))); }).catch(() => { /* a feat can still be written */ });
    const draw = () => {
      body.replaceChildren(...(kind.value === "two" ? [label("Raise", c)] : kind.value === "one" ? [label("Raise", a), label("and", b)] : [label("From the rule book", featSel), blurb, custom]));
    };
    draw();
    const el = h("fieldset", { className: "efset" }, h("legend", { textContent: title }), label("Choose", kind), body);
    el.addEventListener("change", () => onChange?.());   // (changes bubble up from every box inside)
    el.addEventListener("input", () => onChange?.());
    return { el,
      get() {
        if (kind.value === "two") return { type: "asi", inc: [+c.value, +c.value] };
        if (kind.value === "one") { if (a.value === b.value) throw new Error("Pick two different abilities for +1 each"); return { type: "asi", inc: [+a.value, +b.value] }; }
        if (featSel.value !== "") return { type: "feat", id: +featSel.value };
        if (!name.value.trim()) throw new Error("Choose a feat, or write one");
        return { type: "feat", feat: { name: name.value.trim(), text: text.value, ability: plus.value === "" ? null : +plus.value } };
      } };
  }

  // choiceBoxes(groups, picked, onChange) -> elements: one select per pick of every choice group {key, head, picks, options [{name, label, text}]}; `picked` ({key: [names]}) is
  // filled in as they change
  function choiceBoxes(groups, picked, onChange) {
    return groups.map(g => {
      picked[g.key] = (picked[g.key] || []).slice(0, g.picks);
      const text = h("p", { className: "muted blurb" });
      const boxes = Array.from({ length: g.picks }, (_, i) => {
        const s = select([["", `(choose ${g.picks > 1 ? "#" + (i + 1) : "one"})`], ...g.options.map(o => [o.name, o.label])], picked[g.key][i] || "", () => {
          picked[g.key] = boxes.map(x => x.value).filter(Boolean);
          text.textContent = (g.options.find(o => o.name === s.value) || {}).text || "";
          onChange?.();
        });
        return s;
      });
      return h("fieldset", { className: "efset" }, h("legend", { textContent: g.head }), ...boxes, text);
    });
  }

  // ---------------------------------------------------------------- the creation wizard
  function open({ onCreated, isDM } = {}) {
    const S = { name: "", level: 1, owner: "", raceId: "", race: null, looks: {}, clsId: "", cls: null, skills: [], bgId: "", bg: null, method: "standard", abilities: [15, 14, 13, 12, 10, 8],
      hpMode: "average", hpRolls: [], asis: [], choices: {}, gold: 0, items: [], cantrips: [], spells: [] };
    const body = h("div", { className: "creator" });
    const err = h("p", { className: "bad" });
    const steps = [["Basics", basics], ["Race", race], ["Class", klass], ["Background", background], ["Abilities", abilities], ["Choices", choices], ["Equipment", equipment], ["Spells", spells], ["Review", review]];
    const groupsNow = () => (S.cls ? S.cls.groups.filter(g => g.level <= S.level).map(g => ({ ...g, key: `${g.level}:${g.head}` })) : []);
    // a step with nothing to choose is left out: Choices needs a feature to choose or a level above 1; Spells needs a class that gets spells at this level
    const needed = name => name === "Choices" ? !!S.cls && (S.level > 1 || groupsNow().length > 0) : name === "Spells" ? (() => { const a = allowance(); return !!a && (a.cantrips > 0 || a.spells > 0); })() : true;
    const visible = () => steps.filter(([n]) => needed(n));
    let at = "Basics", dlg = null, busy = false;
    const nav = h("div", { className: "row creatornav" });

    const bonus = () => { const out = [0, 0, 0, 0, 0, 0]; (S.race?.bonuses || []).forEach(b => { out[b.ability] += b.value; }); return out; };
    const finalScores = () => {
      const sc = S.abilities.map((v, i) => v + bonus()[i]);
      S.asis.forEach(x => { try { const g = x.get(); if (g.type === "asi") g.inc.forEach(i => sc[i]++); else if (g.feat?.ability != null) sc[g.feat.ability]++; } catch (_) { /* not chosen yet */ } });
      return sc;
    };
    const asiLevels = () => (S.cls ? S.cls.asiLevels.filter(l => l <= S.level) : []);
    const listOf = (url, set) => { const wrap = h("div", {}, h("p", { className: "muted", textContent: "Loading…" })); load(url).then(rows => set(wrap, rows)).catch(e => wrap.replaceChildren(h("p", { className: "bad", textContent: e.message }))); return wrap; };

    // -- Basics
    function basics() {
      const name = textbox({ value: S.name, placeholder: "Character name", className: "grow", oninput: () => (S.name = name.value) }, () => next());
      const level = h("input", { type: "number", min: 1, max: 20, value: S.level, className: "inum", onchange: () => { S.level = Math.max(1, Math.min(20, +level.value || 1)); S.asis = []; S.hpRolls = []; S.choices = {}; } });
      const owner = isDM ? textbox({ value: S.owner, placeholder: "user name (optional)", oninput: () => (S.owner = owner.value), autocapitalize: "none" }) : null;
      setTimeout(() => name.focus(), 50);   // the keyboard comes up at once on a phone
      return [h("p", { className: "muted", textContent: "Everything here is Fight Club's own rule book: the races, classes and backgrounds of the Fight Club collection you imported. Start at level 1, or higher for a character who joins a game in progress." }),
        label("Name", name), label("Starting level (1 to 20)", level), owner ? label("Belongs to", owner) : null];
    }
    // -- Race
    function race() {
      const wrap = h("div", { className: "stack" });
      const fill = async () => {
        wrap.replaceChildren();
        if (S.raceId === "") return;
        S.race = await load("/api/rules/races/" + S.raceId);
        const fixed = S.race.bonuses.map(b => `${ABIL[b.ability]} ${sgn(b.value)}`).join(", ") || "none";
        wrap.append(h("p", { textContent: `Ability bonuses: ${fixed}. Speed ${S.race.speed} ft.` }));
        wrap.append(h("fieldset", { className: "efset" }, h("legend", { textContent: "Looks (optional)" }), h("div", { className: "efgrid" },
          ...["age", "height", "weight", "eyes", "skin", "hair"].map(k => label(k[0].toUpperCase() + k.slice(1), textbox({ value: S.looks[k] || "", oninput: ev => (S.looks[k] = ev.target.value) }))))));
        wrap.append(h("details", {}, h("summary", { textContent: "Racial traits" }), ...S.race.feats.map(f => h("p", {}, h("b", { textContent: f.name + ". " }), f.text))));
      };
      const list = listOf("/api/rules/races", (w, rows) => w.replaceChildren(label("Race", select([["", "(choose)"], ...rows.map(r => [String(r.id), r.name + (r.source ? ` (${r.source})` : "")])], S.raceId, v => { S.raceId = v; S.race = null; fill(); }))));
      fill();
      return [list, wrap];
    }
    // -- Class
    function klass() {
      const wrap = h("div", { className: "stack" });
      const fill = async () => {
        wrap.replaceChildren();
        if (S.clsId === "") return;
        const c = S.cls = await load("/api/rules/classes/" + S.clsId);
        wrap.append(h("p", { textContent: `Hit die d${c.hd}. Saving throws ${c.saves.map(i => ABIL[i]).join(", ")}. Armor: ${c.armor || "none"}. Weapons: ${c.weapons || "none"}. Tools: ${c.tools || "none"}.` }));
        const info = h("p", { className: "muted" });
        const boxes = c.skills.options.map(i => {
          const cb = h("input", { type: "checkbox", checked: S.skills.includes(i), onchange: () => {
            if (cb.checked) S.skills.push(i); else S.skills = S.skills.filter(x => x !== i);
            if (S.skills.length > c.skills.count) { S.skills = S.skills.filter(x => x !== i); cb.checked = false; }
            info.textContent = `${S.skills.length} of ${c.skills.count} chosen`;
          } });
          return h("label", { className: "check" }, cb, " " + SKILLS[i]);
        });
        info.textContent = `${S.skills.length} of ${c.skills.count} chosen`;
        wrap.append(h("fieldset", { className: "efset" }, h("legend", { textContent: `Class skills: choose ${c.skills.count}` }), h("div", { className: "efgrid" }, ...boxes), info));
      };
      const list = listOf("/api/rules/classes", (w, rows) => w.replaceChildren(label("Class", select([["", "(choose)"], ...rows.map(r => [String(r.id), r.name])], S.clsId, v => {
        S.clsId = v; S.cls = null; S.skills = []; S.asis = []; S.choices = {}; S.cantrips = []; S.spells = []; fill(); }))));
      fill();
      return [list, wrap];
    }
    // -- Background
    function background() {
      const wrap = h("div", { className: "stack" });
      const fill = async () => {
        wrap.replaceChildren();
        if (S.bgId === "") return;
        const b = S.bg = await load("/api/rules/backgrounds/" + S.bgId);
        wrap.append(h("p", { textContent: `Skills: ${b.skills.map(i => SKILLS[i]).join(", ") || "none fixed"}.` }),
          h("details", { open: true }, h("summary", { textContent: "What it gives" }), ...b.feats.map(f => h("p", {}, h("b", { textContent: f.name + ". " }), f.text))));
      };
      const list = listOf("/api/rules/backgrounds", (w, rows) => w.replaceChildren(label("Background", select([["", "(choose)"], ...rows.map(r => [String(r.id), r.name + (r.source ? ` (${r.source})` : "")])], S.bgId, v => { S.bgId = v; S.bg = null; fill(); }))));
      fill();
      return [list, wrap];
    }
    // -- Abilities
    function abilities() {
      const out = h("div", {});
      const b = bonus();
      const spent = () => S.abilities.reduce((n, v) => n + ({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 }[v] ?? 99), 0);
      const draw = () => {
        const rows = ABIL.map((a, i) => {
          const base = S.abilities[i], total = base + b[i];
          let input;
          if (S.method === "standard") input = select([15, 14, 13, 12, 10, 8].map(v => [String(v), String(v)]), String(base), v => { S.abilities[i] = +v; draw(); });
          else if (S.method === "pointbuy") input = h("span", { className: "nowrap" }, h("button", { type: "button", className: "tiny", textContent: "−", onclick: () => { if (base > 8) { S.abilities[i]--; draw(); } } }), ` ${base} `,
            h("button", { type: "button", className: "tiny", textContent: "+", onclick: () => { if (base < 15 && spent() + (base >= 13 ? 2 : 1) <= 27) { S.abilities[i]++; draw(); } } }));
          else if (S.method === "roll") input = h("b", { textContent: String(base) });
          else input = h("input", { type: "number", min: 1, max: 20, value: base, className: "inum", onchange: ev => { S.abilities[i] = Math.max(1, Math.min(20, +ev.target.value || 10)); draw(); } });
          return h("tr", {}, h("td", { textContent: ABIL_NAMES[i] }), h("td", {}, input), h("td", { className: "muted", textContent: b[i] ? sgn(b[i]) + " race" : "" }), h("td", {}, h("b", { textContent: String(total) }), ` (${sgn(mod(total))})`));
        });
        out.replaceChildren(...[h("table", { className: "loot" }, h("thead", {}, h("tr", {}, ["Ability", "Base", "", "Score (modifier)"].map(t => h("th", { textContent: t })))), h("tbody", {}, rows)),
          S.method === "pointbuy" ? h("p", { className: "muted", textContent: `${27 - spent()} of 27 points left (8 to 15; 14 and 15 cost 2 each)` }) : null,
          S.method === "standard" && new Set(S.abilities).size !== 6 ? h("p", { className: "bad", textContent: "Use each of 15, 14, 13, 12, 10 and 8 once." }) : null,
          S.method === "roll" ? h("button", { type: "button", textContent: "🎲 Roll 4d6, drop the lowest, six times", onclick: () => { S.abilities = ABIL.map(() => { const r = [d(6), d(6), d(6), d(6)].sort((x, y) => x - y); return r[1] + r[2] + r[3]; }); draw(); } }) : null].filter(Boolean));
      };
      const method = select([["standard", "Standard array (15, 14, 13, 12, 10, 8)"], ["pointbuy", "Point buy (27 points)"], ["roll", "Roll 4d6, drop the lowest"], ["manual", "Enter the scores myself"]], S.method, v => {
        S.method = v; S.abilities = v === "standard" ? [15, 14, 13, 12, 10, 8] : v === "pointbuy" ? [8, 8, 8, 8, 8, 8] : [10, 10, 10, 10, 10, 10]; draw(); });
      draw();
      return [label("How to set the scores", method), out];
    }
    // -- Choices: class features to choose, ability score improvements, then hit points (after the scores they depend on)
    function choices() {
      if (!S.cls) return [h("p", { className: "muted", textContent: "Choose a class first." })];
      const hd = S.cls.hd, levels = S.level - 1;
      const kids = [];
      const total = h("p", { className: "muted" });
      const hpNow = () => {
        const con = mod(finalScores()[2]);
        let hp = hd + con;
        for (let k = 0; k < levels; k++) { const r = S.hpMode === "roll" ? (S.hpRolls[k] ?? Math.floor(hd / 2) + 1) : Math.floor(hd / 2) + 1; hp += Math.max(1, r + con); }
        total.textContent = `Hit points: ${hp} (Constitution ${finalScores()[2]}, ${sgn(mod(finalScores()[2]))} a level)`;
      };
      const gs = groupsNow().map(g => ({ ...g, options: g.options.map(o => ({ ...o, text: "" })) }));
      if (gs.length) kids.push(h("h4", { textContent: "Choose your class features" }), ...choiceBoxes(gs, S.choices, () => {}));
      const lv = asiLevels();
      if (S.asis.length !== lv.length) S.asis = lv.map(l => asiChooser(`Level ${l}: ability score improvement`, () => hpNow()));
      S.asis.forEach(a => kids.push(a.el));
      const mode = select([["average", `Average (${Math.floor(hd / 2) + 1} a level)`], ["roll", `Roll d${hd} for each level`]], S.hpMode, v => { S.hpMode = v; draw(); hpNow(); });
      const rolls = h("div", { className: "efgrid" });
      const draw = () => {
        rolls.replaceChildren();
        if (S.hpMode !== "roll") return;
        if (S.hpRolls.length !== levels) S.hpRolls = Array(levels).fill(null);
        S.hpRolls.forEach((v, i) => {
          const inp = h("input", { type: "number", min: 1, max: hd, value: v ?? "", className: "inum", onchange: () => { S.hpRolls[i] = Math.max(1, Math.min(hd, +inp.value || 1)); hpNow(); } });
          rolls.append(label(`Level ${i + 2}`, h("span", { className: "nowrap" }, inp, " ", h("button", { type: "button", className: "tiny", textContent: "🎲", onclick: () => { S.hpRolls[i] = d(hd); inp.value = S.hpRolls[i]; hpNow(); } }))));
        });
      };
      draw(); hpNow();
      kids.push(h("fieldset", { className: "efset" }, h("legend", { textContent: "Hit points (rolled after the ability scores)" }),
        h("p", { className: "muted", textContent: `Level 1 takes the whole die (${hd}) plus Constitution; each later level the average or a roll, plus Constitution (at least 1).` }),
        levels > 0 ? label("Levels 2 to " + S.level, mode) : null, rolls, total));
      return kids;
    }
    // -- Equipment: starting gold, and anything from the rule book's item list
    function equipment() {
      if (!S.cls) return [h("p", { className: "muted", textContent: "Choose a class first." })];
      const m = (S.cls.wealth || "4d4x10").match(/(\d+)d(\d+)(?:x(\d+))?/), n = +m[1], sides = +m[2], mult = +(m[3] || 1);
      const gold = h("input", { type: "number", min: 0, max: n * sides * mult, value: S.gold, className: "inum", onchange: () => (S.gold = Math.max(0, Math.min(n * sides * mult, +gold.value || 0))) });
      const have = h("div", {}), results = h("div", {});
      const drawHave = () => have.replaceChildren(...(S.items.length ? [h("h4", { textContent: "Your gear" }), ...S.items.map(it => h("div", { className: "row" }, h("span", { textContent: `${it.qty > 1 ? it.qty + " × " : ""}${it.name}` }),
        h("button", { type: "button", className: "tiny", textContent: "+", onclick: () => { it.qty++; drawHave(); } }),
        h("button", { type: "button", className: "tiny", textContent: "−", onclick: () => { it.qty--; if (it.qty < 1) S.items = S.items.filter(x => x !== it); drawHave(); } })))] : []));
      const search = async () => {
        if (!q.value.trim()) { results.replaceChildren(); return; }
        try {
          const rows = await api("/api/rules/items?q=" + encodeURIComponent(q.value.trim()));
          results.replaceChildren(rows.length ? h("table", { className: "loot" }, h("tbody", {}, rows.map(r => h("tr", { className: "addable", onclick: () => { const x = S.items.find(i => i.id === r.id); if (x) x.qty++; else S.items.push({ id: r.id, name: r.name, qty: 1 }); drawHave(); } },
            h("td", { textContent: r.name }), h("td", { className: "muted", textContent: r.detail }), h("td", { className: "muted", textContent: r.value ? r.value + " gp" : "" }))))) : h("p", { className: "muted", textContent: "Nothing matches." }));
        } catch (e) { results.replaceChildren(h("p", { className: "bad", textContent: e.message })); }
      };
      const q = textbox({ placeholder: "Search the rule book's items (sword, rope, backpack ...)", className: "grow", oninput: () => { clearTimeout(q.t); q.t = setTimeout(search, 200); } });
      drawHave();
      return [h("p", { className: "muted", textContent: `A ${S.cls.name} starts with ${S.cls.wealth.replace("x", " × ")} gold pieces to spend (Fight Club's own way). Roll or enter it below, then add the gear you want: tap an item to take one (keeping track of the cost is up to you).` }),
        label("Starting gold", h("span", { className: "nowrap" }, gold, " ", h("button", { type: "button", textContent: "🎲 Roll", onclick: () => { let t = 0; for (let i = 0; i < n; i++) t += d(sides); S.gold = t * mult; gold.value = S.gold; } }))),
        h("div", { className: "row" }, q), results, have];
    }
    // -- Spells
    function allowance() {
      const c = S.cls;
      if (!c || !c.spellKind) return null;
      const row = c.slots[S.level] || c.slots[String(S.level)] || [0], sc = finalScores();
      const cantrips = row[0] || 0, anySlots = row.slice(1).some(Boolean);
      if (!cantrips && !anySlots) return null;
      const spells = c.spellKind === "known" ? c.known[S.level - 1] : c.spellKind === "spellbook" ? 6 + 2 * (S.level - 1) : Math.max(1, mod(sc[c.spellAbility]) + (c.half ? Math.floor(S.level / 2) : S.level));
      const top = Math.max(0, ...row.slice(1).map((n, i) => (n ? i + 1 : 0)));
      return { cantrips, spells: c.spellKind === "prepared" && !anySlots ? 0 : spells, top, kind: c.spellKind };
    }
    function spells() {
      const a = allowance();
      if (!a) return [h("p", { className: "muted", textContent: S.cls ? `${S.cls.name} does not cast spells at level ${S.level}: continue.` : "Choose a class first." })];
      const summary = h("div", {}), results = h("div", {});
      const chip = (s, list) => h("span", { className: "chip" }, s.name, " ", h("button", { type: "button", className: "tiny", textContent: "✕", onclick: () => { S[list] = S[list].filter(x => x.id !== s.id); drawSummary(); } }));
      const drawSummary = () => summary.replaceChildren(h("p", {}, h("b", { textContent: `Cantrips ${S.cantrips.length} of ${a.cantrips}: ` }), ...S.cantrips.map(s => chip(s, "cantrips"))),
        h("p", {}, h("b", { textContent: `Spells ${S.spells.length} of ${a.spells}${a.kind === "prepared" ? " (prepared each day)" : a.kind === "spellbook" ? " (in your spellbook)" : ""}: ` }), ...S.spells.map(s => chip(s, "spells"))));
      drawSummary();
      let rows = [];
      const draw = () => {
        const f = q.value.trim().toLowerCase(), L = lvl.value;
        const shown = rows.filter(r => (!f || r.name.toLowerCase().includes(f)) && (L === "" || r.level === +L)).slice(0, 60);
        results.replaceChildren(...[h("table", { className: "loot" }, h("tbody", {}, shown.map(r => h("tr", { className: "addable", title: r.text, onclick: () => take(r) },
          h("td", { textContent: r.name }), h("td", { className: "muted", textContent: r.level === 0 ? "Cantrip" : "Level " + r.level }), h("td", { className: "muted", textContent: r.school }))))),
          shown.length === 60 ? h("p", { className: "muted", textContent: "Showing the first 60: type to narrow it down." }) : null].filter(Boolean));
      };
      const take = r => {
        const into = r.level === 0 ? "cantrips" : "spells", cap = r.level === 0 ? a.cantrips : a.spells;
        if (S[into].some(x => x.id === r.id)) return;
        if (S[into].length >= cap) { alert(r.level === 0 ? `You know ${a.cantrips} cantrips` : `You can have ${a.spells} spells`); return; }
        S[into].push({ id: r.id, name: r.name }); drawSummary();
      };
      const q = textbox({ placeholder: "Filter by name", className: "grow", oninput: () => draw() });
      const lvl = select([["", "Any level"], ["0", "Cantrips"], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].filter(n => n <= a.top).map(n => [String(n), "Level " + n])], "", () => draw());
      results.append(h("p", { className: "muted", textContent: "Loading the spell list…" }));
      load("/api/rules/spells?class=" + encodeURIComponent(S.cls.name)).then(r => { rows = r.filter(x => x.level <= a.top); draw(); }).catch(e => results.replaceChildren(h("p", { className: "bad", textContent: e.message })));
      return [summary, h("div", { className: "row" }, q, lvl), results];
    }
    // -- Review
    function review() {
      const sc = finalScores(), a = allowance();
      return [h("h3", { textContent: S.name || "(no name)" }), h("p", { textContent: `${S.race ? S.race.name : "?"} ${S.cls ? S.cls.name : "?"}, level ${S.level}${S.bg ? ", " + S.bg.name : ""}` }),
        h("p", { textContent: ABIL.map((x, i) => `${x} ${sc[i]} (${sgn(mod(sc[i]))})`).join("   ") }),
        h("p", { className: "muted", textContent: `Gold ${S.gold}${S.items.length ? ", " + S.items.length + " kind(s) of gear" : ""}. ${a ? `Spells: ${S.cantrips.length} cantrips, ${S.spells.length} spells.` : ""}` }),
        h("p", { className: "muted", textContent: "Create saves the character to your characters. You can edit, level up and download it like any other." })];
    }

    // -- the frame
    const pos = () => { const v = visible(); return { v, i: Math.max(0, v.findIndex(([n]) => n === at)) }; };
    const body2 = () => { err.textContent = ""; const { v, i } = pos(); body.replaceChildren(h("h3", { textContent: `${i + 1}. ${v[i][0]}` }), ...v[i][1]().filter(Boolean)); drawNav(); };
    const drawNav = () => {
      const { v, i } = pos();
      nav.replaceChildren(h("span", { className: "muted grow stepbar", textContent: v.map(([t], k) => (k === i ? `[${t}]` : t)).join(" › ") }),
        h("button", { type: "button", textContent: "Back", disabled: i === 0, onclick: () => { at = v[i - 1][0]; body2(); } }),
        i < v.length - 1 ? h("button", { type: "button", className: "primary", textContent: "Next", onclick: () => next() })
          : h("button", { type: "button", className: "primary", textContent: "Create character", disabled: busy, onclick: create }));
    };
    const problem = () => {   // what stops moving on from this step
      const t = at;
      if (t === "Basics" && !S.name.trim()) return "Give the character a name";
      if (t === "Race" && !S.race) return "Choose a race";
      if (t === "Class") { if (!S.cls) return "Choose a class"; if (S.skills.length !== S.cls.skills.count) return `Choose ${S.cls.skills.count} class skills`; }
      if (t === "Background") { if (!S.bg) return "Choose a background"; if (S.skills.some(i => S.bg.skills.includes(i))) return "A skill cannot come from both the class and the background: change one"; }
      if (t === "Abilities" && S.method === "standard" && new Set(S.abilities).size !== 6) return "Use each number of the standard array once";
      if (t === "Choices") {
        for (const g of groupsNow()) if ((S.choices[g.key] || []).length !== g.picks) return `Choose your ${g.head.toLowerCase()}`;
        for (const a of S.asis) { try { a.get(); } catch (e) { return e.message; } }
      }
      return "";
    };
    const next = () => { const p = problem(); if (p) { err.textContent = p; return; } const { v, i } = pos(); at = v[Math.min(i + 1, v.length - 1)][0]; body2(); };
    async function create() {
      busy = true; drawNav();
      try {
        const res = await api("/api/party/create", "POST", { name: S.name.trim(), level: S.level, owner: S.owner, race: +S.raceId, looks: S.looks, background: +S.bgId, class: +S.clsId, skills: S.skills,
          choices: S.choices, abilityMethod: S.method, abilities: S.abilities, hpRolls: S.hpMode === "roll" ? S.hpRolls : null, asi: S.asis.map(a => a.get()),
          equipment: { gold: S.gold, items: S.items.map(i => ({ id: i.id, qty: i.qty })) }, spells: { cantrips: S.cantrips.map(x => x.id), spells: S.spells.map(x => x.id) } });
        dlg.close();
        onCreated?.(res.id, res.character);
      } catch (e) { err.textContent = e.message; }
      busy = false; drawNav();
    }
    dlg = Nodes.popup({ title: "New character", body: h("div", {}, body, err, nav) });
    dlg.classList.add("creatordlg");
    body2();
    return dlg;
  }

  return { open, asiChooser, choiceBoxes };
})();

const LevelUp = (() => {
  const { h, api } = UI;
  const sgn = n => (n >= 0 ? "+" : "") + n;
  const d = n => 1 + Math.floor(Math.random() * n);

  // open(m, { onDone(character), onFinish(), addSpells() }): onDone is called when the level is applied (m is already updated), onFinish when the page's Done button is pressed,
  // addSpells() when Add spells is.
  function open(m, { onDone, onFinish, addSpells } = {}) {
    const body = h("div", { className: "creator" }), err = h("p", { className: "bad" });
    const dlg = Nodes.popup({ title: `Level up ${m.name}`, body: h("div", {}, body, err) });
    dlg.classList.add("creatordlg");
    const fail = e => { err.textContent = e.message; };
    async function start() {
      err.textContent = "";
      body.replaceChildren(h("p", { className: "muted", textContent: "Loading…" }));
      let info;
      try { info = await api(`/api/party/${m.id}/levelup`); } catch (e) { body.replaceChildren(); return fail(e); }
      if (!info.canLevel) { body.replaceChildren(h("p", { textContent: "This character is already level 20." })); return; }
      const pick = h("select", {}, h("optgroup", { label: "Take a level in" }, info.classes.filter(c => c.known).map(c => h("option", { value: c.name, textContent: `${c.name} (level ${c.level} → ${c.level + 1})` }))),
        h("optgroup", { label: "Multiclass (needs 13 in the abilities involved)" }, info.options.map(o => h("option", { value: o.name, textContent: `${o.name}${o.problems.length ? " — " + o.problems.join("; ") : " (new class)"}` }))));
      const xp = h("p", { className: "muted", textContent: `Level ${info.total} · ${info.xp} XP${info.xpNext ? ` (level ${info.total + 1} at ${info.xpNext})` : ""}. Levelling up raises XP to the new level's threshold if it is lower.` });
      body.replaceChildren(xp, h("label", { className: "ef" }, h("span", { className: "muted", textContent: "Class" }), pick), h("div", { className: "row" }, h("button", { className: "primary", textContent: "Continue", onclick: () => plan(pick.value) })));
    }
    async function plan(name) {
      err.textContent = "";
      let p;
      try { p = await api(`/api/party/${m.id}/levelup?class=${encodeURIComponent(name)}`); } catch (e) { return fail(e); }
      if (p.problems.length) { fail(new Error(p.problems.join("; "))); return; }
      let roll = null, asi = null;
      const picked = {};
      const hpInfo = h("p", {});
      const rollBox = h("input", { type: "number", min: 1, max: p.hd, className: "inum", placeholder: "roll", onchange: () => { roll = rollBox.value === "" ? null : Math.max(1, Math.min(p.hd, +rollBox.value)); sync(); } });
      const conScore = (m.abilities || []).find(a => a.name === "CON")?.score ?? 10;
      // hit points after the ability score improvement (a rise in Constitution counts for this level and, once the modifier steps up, for every earlier one)
      const sync = () => {
        let mod = p.conMod;
        try { const g = asi?.get(); if (g?.type === "asi") mod = Math.floor((conScore + g.inc.filter(x => x === 2).length - 10) / 2); else if (g?.feat?.ability === 2) mod = Math.floor((conScore + 1 - 10) / 2); } catch (_) { /* not chosen yet */ }
        const base = roll == null ? Math.floor(p.hd / 2) + 1 : roll, gain = Math.max(1, base + mod) + Math.max(0, mod - p.conMod) * (p.newTotal - 1);
        hpInfo.textContent = `Hit points: ${roll == null ? "average " + base : "rolled " + roll} ${sgn(mod)} Constitution${mod > p.conMod ? ` (and +${mod - p.conMod} for each earlier level)` : ""} = +${gain}`;
      };
      asi = p.asi ? Creator.asiChooser("Ability score improvement (first: it can change the hit points below)", sync) : null;
      sync();
      const choiceEls = Creator.choiceBoxes(p.groups, picked, () => {});
      body.replaceChildren(...[
        h("h3", { textContent: `${p.class.name}: level ${p.classLevel} (character level ${p.newTotal})` }),
        p.features.length ? h("div", {}, h("h4", { textContent: "New features" }), ...p.features.map(f => h("details", {}, h("summary", { textContent: f.name }), h("p", { textContent: f.text })))) : h("p", { className: "muted", textContent: "No new class features at this level." }),
        ...(choiceEls.length ? [h("h4", { textContent: "Choose" }), ...choiceEls] : []),
        asi ? asi.el : null,
        h("h4", { textContent: "Hit points (after the ability scores)" }), hpInfo,
        h("div", { className: "row" }, h("button", { type: "button", textContent: `🎲 Roll d${p.hd}`, onclick: () => { roll = d(p.hd); rollBox.value = roll; sync(); } }), rollBox, h("button", { type: "button", className: "tiny", textContent: "Use the average", onclick: () => { roll = null; rollBox.value = ""; sync(); } })),
        p.newCantrips || p.newSpells ? h("p", {}, `New spells: ${p.newCantrips ? p.newCantrips + " cantrip(s)" : ""}${p.newCantrips && p.newSpells ? " and " : ""}${p.newSpells ? p.newSpells + " spell(s)" : ""} to learn: add them from Spells after levelling.`) : null,
        h("div", { className: "row" }, h("button", { textContent: "Back", onclick: start }), h("button", { className: "primary", textContent: `Level up to ${p.newTotal}`, onclick: async ev => {
          err.textContent = "";
          let decision = null;
          try {
            if (asi) decision = asi.get();
            for (const g of p.groups) if ((picked[g.key] || []).length !== g.picks) throw new Error(`Choose your ${g.head.toLowerCase()}`);
          } catch (e) { return fail(e); }
          ev.target.disabled = true;
          try {
            const res = await api(`/api/party/${m.id}/levelup`, "POST", { class: name, roll, asi: decision, choices: picked });
            done(res, p);
          } catch (e) { fail(e); ev.target.disabled = false; }
        } }))].filter(Boolean));   // (replaceChildren would print a null as the word "null")
    }
    function done(res, p) {
      Object.assign(m, res.character);
      body.replaceChildren(...[h("h3", { textContent: `${m.name} is now level ${res.result.level}` }),
        h("p", { textContent: `+${res.result.hpGain} hit points (${res.character.hpMax} in all).${res.result.features.length ? " New: " + res.result.features.join(", ") + "." : ""}` }),
        p.newCantrips || p.newSpells ? h("p", { className: "ok", textContent: "You can learn new spells now." }) : null,
        h("div", { className: "row" }, p.newCantrips || p.newSpells ? h("button", { className: "primary", textContent: "Add spells", onclick: () => { dlg.close(); addSpells?.(); } }) : null,
          h("button", { textContent: "Done", onclick: () => { dlg.close(); onFinish?.(); } }))].filter(Boolean));
      onDone?.(res.character);
    }
    start();
    return dlg;
  }
  return { open };
})();
