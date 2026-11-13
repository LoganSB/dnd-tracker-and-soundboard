"use strict";
// =============================================================================
// vitals.js - the small "health" controls of a character, shared by the party tracker and the character sheet
// =============================================================================
//
// The party tracker (tracker.js: the Party panel, the pop-out window and a character's Tracker tab) and the character sheet's
// Skills and Stats tab (party.js) both show a character's hit points, hit dice and conditions. They used to need their own copies;
// this file is the one copy. Each function builds an element from a character record and calls `patch(body)` when something
// changes. It never talks to the server itself: the page decides what `patch` does (send PATCH /api/party/<id>, then redraw), so the
// same controls work wherever they are put.
//
//   Vitals.hp(m, patch)          the HP row: -5 -1 [number] / max +1 +5 and a coloured bar.      patch({ hpCurrent })
//   Vitals.hitDice(m, patch)     one row per class: "Cleric d8  [-] 11 / 13 [+]" plus a long-rest button.   patch({ hitDice: [..] })
//   Vitals.conditions(m, patch)  the condition chips (click one to remove it) and an "+ Add" button that opens a menu of the 5e
//                                conditions plus a box for anything else.                        patch({ conditions: "Prone, Poisoned" })
//   Vitals.list(text) / Vitals.CONDITIONS   the stored text "Prone, Poisoned" as an array; the standard condition names.
//
// `m` is a party summary (see party.summary in party.py): hp, hpMax, hitDice [{name, hd, level, left}], conditions (one text, the names
// joined by commas). Everything is built with textContent, so a name from a file can never inject markup.
const Vitals = (() => {
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  };

  const CONDITIONS = ["Blinded", "Charmed", "Deafened", "Exhaustion", "Frightened", "Grappled", "Incapacitated", "Invisible", "Paralyzed",
    "Petrified", "Poisoned", "Prone", "Restrained", "Stunned", "Unconscious"];
  const list = text => (text || "").split(/[,;]+/).map(x => x.trim()).filter(Boolean);

  function hp(m, patch) {
    const pct = m.hpMax ? Math.max(0, Math.min(100, (m.hp / m.hpMax) * 100)) : 0;
    const color = pct > 50 ? "#3ecf8e" : pct > 25 ? "#f0b429" : "#ff5d6c";
    const bar = el("div", { className: "hpbar" }, el("div", { className: "hpfill", style: `width:${pct}%;background:${color}` }));
    const cur = el("input", { type: "number", className: "hpnum", value: m.hp, min: 0, title: "Current HP (Enter to set)" });
    cur.onchange = () => patch({ hpCurrent: +cur.value });
    const btn = (label, d) => el("button", { textContent: label, onclick: () => patch({ hpCurrent: m.hp + d }) });
    return el("div", { className: "hprow" }, el("span", { className: "lbl", textContent: "HP" }),
      btn("−5", -5), btn("−1", -1), cur, el("span", { textContent: "/ " + m.hpMax }), btn("+1", 1), btn("+5", 5), bar);
  }

  // hitDice: the character's hit dice, per class. A short rest spends some (the − button); a long rest gives back half the level (at
  // least one) of them, so the long-rest button restores that many in every class (never above the class level).
  function hitDice(m, patch) {
    const dice = m.hitDice || [];
    if (!dice.length) return el("p", { className: "muted", textContent: "No hit dice recorded." });
    const set = (i, v) => patch({ hitDice: dice.map((d, k) => (k === i ? Math.max(0, Math.min(d.level, v)) : d.left)) });
    const rows = dice.map((d, i) => el("div", { className: "resrow" },
      el("span", { className: "lbl", textContent: `${d.name} d${d.hd || "?"}` }),
      el("button", { textContent: "−", title: "Spend a hit die", onclick: () => set(i, d.left - 1) }),
      el("b", { textContent: `${d.left} / ${d.level}` }),
      el("button", { textContent: "+", title: "Regain a hit die", onclick: () => set(i, d.left + 1) })));
    rows.push(el("button", { className: "tiny", textContent: "Long rest: regain half", title: "Regain half your total hit dice (at least one), spread over your classes",
      onclick: () => {
        let back = Math.max(1, Math.floor(dice.reduce((n, d) => n + d.level, 0) / 2));
        patch({ hitDice: dice.map(d => { const add = Math.min(back, d.level - d.left); back -= add; return d.left + add; }) });
      } }));
    return el("div", {}, rows);
  }

  // conditions: chips for the conditions on the character and an Add button. The add menu lists the standard conditions that are not
  // already on the character, and a text box for a custom one ("Hexed", "Bless", ...). The stored form is one comma-separated text.
  function conditions(m, patch) {
    const have = list(m.conditions);
    const save = next => patch({ conditions: next.join(", ") });
    const chips = el("div", { className: "chips" }, have.length ? have.map(c => el("span", { className: "chip" }, c,
      el("button", { type: "button", className: "x", textContent: "✕", title: `Remove ${c}`, onclick: () => save(have.filter(x => x !== c)) }))) :
      el("span", { className: "muted", textContent: "None" }));
    const menu = el("div", { className: "addcond", hidden: true });
    const choose = el("select", { title: "Condition" }, el("option", { value: "", textContent: "Choose a condition…" }),
      CONDITIONS.filter(c => !have.some(x => x.toLowerCase() === c.toLowerCase())).map(c => el("option", { value: c, textContent: c })));
    const custom = el("input", { type: "text", placeholder: "or type your own", maxLength: 30 });
    const add = () => {
      const name = (choose.value || custom.value).trim();
      if (name && !have.some(x => x.toLowerCase() === name.toLowerCase())) save([...have, name]);
      else menu.hidden = true;
    };
    choose.onchange = () => { if (choose.value) add(); };
    custom.onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); add(); } };
    menu.append(choose, custom, el("button", { type: "button", className: "tiny primary", textContent: "Add", onclick: add }));
    const addBtn = el("button", { type: "button", className: "tiny", textContent: "+ Add", title: "Add a condition", onclick: () => { menu.hidden = !menu.hidden; if (!menu.hidden) choose.focus(); } });
    return el("div", { className: "conds" }, chips, addBtn, menu);
  }

  return { hp, hitDice, conditions, list, CONDITIONS };
})();
