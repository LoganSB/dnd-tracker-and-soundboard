"use strict";
// =============================================================================
// vitals.js - the small "health" controls of a character, shared by the party tracker and the character sheet
// =============================================================================
//
// The party tracker (tracker.js: the Party panel, the pop-out window and a character's Tracker tab) and the character sheet's
// Skills and Stats tab (party.js) both show a character's hit points, hit dice and conditions. They used to need their own copies;
// this file is the one copy. (Needs conditions.js loaded first.) Each function builds an element from a character record and calls `patch(body)` when something
// changes. It never talks to the server itself: the page decides what `patch` does (send PATCH /api/party/<id>, then redraw), so the
// same controls work wherever they are put.
//
//   Vitals.hp(m, patch)          the HP row: -5 -1 [number] / max +1 +5 and a coloured bar.      patch({ hpCurrent })
//   Vitals.hitDice(m, patch)     one row per class: "Cleric d8  [-] 11 / 13 [+]" plus a long-rest button.   patch({ hitDice: [..] })
//   Vitals.conditions(m, patch)  the condition chips (✕ removes one), an "+ Add" button that opens a menu of the 5e conditions plus a box for anything
//                                else, and under them what each condition does (conditions.js).   patch({ conditions: "Prone, Poisoned" })
//   Vitals.slots(m, patch)       the spell-slot rows (one per level, a clickable pip per slot); [] for a non-caster.   patch({ slotsCurrent })
//   Vitals.rest(m, patch)        the Short rest and Long rest buttons (the tracker puts them by the character's name); Vitals.restNote[id] is the
//                                line saying what the last rest did.   patch({ hpCurrent, hitDice, slotsCurrent, conditions, trackers, deaths })
//   Vitals.CONDITIONS            the standard condition names (conditions.js has the rules; Conditions.parse reads the stored text).
//
// `m` is a party summary (see party.summary in party.py): hp, hpMax, hitDice [{name, hd, level, left}], conditions (one text, the names
// joined by commas). Everything is built with textContent, so a name from a file can never inject markup.
const Vitals = (() => {
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  };

  const CONDITIONS = Conditions.NAMES;   // the standard conditions (conditions.js)

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
    return el("div", {}, rows);
  }

  // rest(m, patch): the SHORT REST and LONG REST buttons. Rules (5e SRD):
  //   Short rest (at least an hour): you may spend hit dice, up to the number you have left. For each one spent, roll the die and add your
  //   Constitution modifier (not below 0) and regain that many hit points, never above your maximum. The popover asks how many of each class's
  //   dice to spend and rolls them for you. A Warlock also gets their Pact Magic spell slots back. (Other things that return on a short rest, such
  //   as Ki, Action Surge or Second Wind, are only handled when the character file has a class counter for them (Channel Divinity does; the file marks
  //   its reset with resetType 1, read here as a short rest) or you made a tracker for them.)
  //   Long rest (at least 8 hours): regain all lost hit points; regain spent hit dice up to half your total (at least 1), spread over your
  //   classes; all spell slots come back; exhaustion goes down by 1; death saves clear. Your own trackers (Mana, Ki, Rage ...) are set back to full.
  // Returns an element (the two buttons and the popover). The result is remembered in Vitals.restNote[m.id] for the card to show.
  const restNote = {};
  function rest(m, patch) {
    const dice = m.hitDice || [];
    const box = el("span", { className: "restbtns" });
    const pop = el("div", { className: "restpop", hidden: true });
    const con = m.mods?.[2] ?? 0, sign = n => (n >= 0 ? "+" : "") + n;

    const shortRest = () => {
      pop.replaceChildren();
      const inputs = [];
      dice.forEach((d, i) => {
        if (!d.left || !d.hd) return;
        const n = el("input", { type: "number", min: 0, max: d.left, value: 0, className: "inum", title: `Hit dice to spend (you have ${d.left})` });
        inputs[i] = n;
        pop.append(el("label", { className: "resrow" }, el("span", { className: "lbl", textContent: `${d.name} d${d.hd}` }), "spend ", n, ` of ${d.left}`));
      });
      pop.prepend(el("p", { className: "muted", textContent: `Short rest. Spend hit dice to heal: each is rolled with your Constitution modifier (${sign(con)}).` + (dice.some(d => /warlock/i.test(d.name)) ? " Your Pact Magic slots come back." : "") + ((m.classTrackers || []).some(t => t.reset === 1) ? " Class counters that recharge on a short rest are refilled." : "") }));
      pop.append(el("div", { className: "row" },
        el("button", { className: "primary tiny", textContent: "Take the short rest", onclick: () => {
          const parts = [], left = dice.map(d => d.left);
          let healed = 0;
          dice.forEach((d, i) => {
            const n = Math.max(0, Math.min(d.left, Math.floor(+inputs[i]?.value || 0)));
            for (let k = 0; k < n; k++) { const r = 1 + Math.floor(Math.random() * d.hd), got = Math.max(0, r + con); healed += got; parts.push(`d${d.hd} ${r}${sign(con)}`); }
            left[i] -= n;
          });
          const hp = Math.min(m.hpMax, m.hp + healed), body = { hitDice: left };
          if (parts.length) body.hpCurrent = hp;
          const pact = dice.some(d => /warlock/i.test(d.name)) && m.slots.some(Boolean);
          if (pact) body.slotsCurrent = m.slots;
          // the class's own counters that come back on a short rest (Channel Divinity ...): resetType 1 in the file (unconfirmed reading)
          const back = (m.classTrackers || []).filter(t => t.reset === 1 && t.max != null && t.cur < t.max);
          if (back.length) body.classTrackers = back.map(t => ({ label: t.label, cur: t.max }));
          restNote[m.id] = `Short rest: ` + (parts.length ? `spent ${parts.length} hit di${parts.length === 1 ? "e" : "ce"} (${parts.join(", ")}), healed ${hp - m.hp} HP (now ${hp}/${m.hpMax}).` : "no hit dice spent.") + (pact ? " Pact Magic slots restored." : "") + (back.length ? ` ${back.map(t => t.label).join(", ")} restored.` : "");
          pop.hidden = true;
          patch(body);
        } }),
        el("button", { className: "tiny", textContent: "Cancel", onclick: () => { pop.hidden = true; } })));
      pop.hidden = false;
    };

    const longRest = () => {
      if (!confirm(`Long rest for ${m.name}?\nRestores all hit points, spell slots and half your hit dice, lowers exhaustion by 1, clears death saves and sets your trackers back to full.`)) return;
      const total = dice.reduce((n, d) => n + d.level, 0);
      let back = Math.max(1, Math.floor(total / 2));
      const body = { hpCurrent: m.hpMax, deaths: { s: 0, f: 0 } }, notes = ["all hit points"];
      if (dice.length) { body.hitDice = dice.map(d => { const add = Math.min(back, d.level - d.left); back -= add; return d.left + add; }); notes.push("hit dice"); }
      if (m.slots.some(Boolean)) { body.slotsCurrent = m.slots; notes.push("spell slots"); }
      const have = Conditions.parse(m.conditions);
      if (have.some(e => e.key === "Exhaustion")) {
        body.conditions = have.map(e => (e.key === "Exhaustion" ? { ...e, text: `Exhaustion ${e.level - 1}`, level: e.level - 1 } : e)).filter(e => e.key !== "Exhaustion" || e.level > 0).map(e => e.text).join(", ");
        notes.push("1 level of exhaustion");
      }
      if ((m.trackers || []).length) { body.trackers = m.trackers.map(t => ({ ...t, cur: t.max })); notes.push("trackers"); }
      const counters = (m.classTrackers || []).filter(t => t.max != null);
      if (counters.length) { body.classTrackers = counters.map(t => ({ label: t.label, cur: t.max })); notes.push(counters.map(t => t.label).join(", ")); }
      restNote[m.id] = "Long rest: restored " + notes.join(", ") + ".";
      patch(body);
    };

    box.append(el("button", { className: "tiny", textContent: "Short rest", title: "Spend hit dice to heal", onclick: () => (pop.hidden ? shortRest() : (pop.hidden = true)) }),
      el("button", { className: "tiny", textContent: "Long rest", title: "Restore hit points, spell slots, hit dice and trackers", onclick: longRest }), pop);
    return box;
  }

  // conditions: chips for the conditions on the character, an Add button, and under them what each condition DOES (the 5e rules text from
  // conditions.js, and the lines naming what it changes on the stats: speed, passive Perception ... the Statistics tiles apply them). The add menu
  // lists the standard conditions that are not already on the character, and a text box for a custom one ("Hexed", "Bless", ...). Exhaustion is added
  // at level 1 and its chip has arrows to raise or lower the level (level 0 removes it). The stored form is one comma-separated text.
  function conditions(m, patch) {
    const have = Conditions.parse(m.conditions);
    const save = next => patch({ conditions: next.map(e => e.text).join(", ") });
    const without = e => have.filter(x => x !== e);
    const setLevel = (e, n) => save(n < 1 ? without(e) : have.map(x => (x === e ? { ...x, text: `Exhaustion ${Math.min(6, n)}` } : x)));
    const arrow = (label, title, fn) => el("button", { type: "button", className: "x", textContent: label, title, onclick: fn });
    const chips = el("div", { className: "chips" }, have.length ? have.map(e => el("span", { className: "chip" + (e.def ? "" : " custom") }, e.text,
      e.key === "Exhaustion" ? [arrow("▲", "Raise the exhaustion level", () => setLevel(e, e.level + 1)), arrow("▼", "Lower the exhaustion level", () => setLevel(e, e.level - 1))] : null,
      arrow("✕", `Remove ${e.text}`, () => save(without(e))))) : el("span", { className: "muted", textContent: "None" }));
    const menu = el("div", { className: "addcond", hidden: true });
    const choose = el("select", { title: "Condition" }, el("option", { value: "", textContent: "Choose a condition…" }),
      CONDITIONS.filter(c => !have.some(x => x.key ? x.key === c : x.text.toLowerCase() === c.toLowerCase())).map(c => el("option", { value: c, textContent: c })));
    const custom = el("input", { type: "text", placeholder: "or type your own", maxLength: 30 });
    const add = () => {
      const name = (choose.value || custom.value).trim();
      if (name && !have.some(x => x.text.toLowerCase() === name.toLowerCase())) save([...have, ...Conditions.parse(name)]);
      else menu.hidden = true;
    };
    choose.onchange = () => { if (choose.value) add(); };
    custom.onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); add(); } };
    menu.append(choose, custom, el("button", { type: "button", className: "tiny primary", textContent: "Add", onclick: add }));
    const addBtn = el("button", { type: "button", className: "tiny", textContent: "+ Add", title: "Add a condition", onclick: () => { menu.hidden = !menu.hidden; if (!menu.hidden) choose.focus(); } });
    // what each one does: the rules text, then the effects on the stats in a warning colour
    const info = have.filter(e => e.def).map(e => {
      const d = Conditions.describe(e);
      return el("div", { className: "condinfo" }, el("b", { textContent: e.key === "Exhaustion" ? "Exhaustion" : e.text }), " ", d.text,
        d.lines.length ? el("div", { className: "condfx", textContent: "On your stats: " + d.lines.join(" · ") }) : null);
    });
    return el("div", { className: "conds" }, chips, addBtn, menu, info.length ? el("div", { className: "condlist" }, info) : null);
  }

  // slots: one row per spell level that has slots, each with one pip per slot (filled = still available), plus a "Long rest" button. Clicking a
  // pip toggles it, and those after it follow: an available pip spends it (what is left becomes the clicked pip's number), an empty pip restores
  // up to it. m.slots[i] = most slots at level i+1; m.slotsCurrent[i] = left (missing or short: the most is assumed). Returns an ARRAY of elements.
  function slots(m, patch) {
    const rows = [];
    m.slots.forEach((max, i) => {
      if (!max) return;
      const cur = m.slotsCurrent[i] ?? max, pips = el("span", { className: "pips" });
      for (let k = 0; k < max; k++) {
        pips.append(el("button", { className: "pip" + (k < cur ? " on" : ""), title: `Level ${i + 1} slot`, onclick: () => {
          const next = m.slotsCurrent.slice();
          while (next.length < m.slots.length) next.push(0);
          next[i] = k < cur ? k : k + 1;
          patch({ slotsCurrent: next });
        } }));
      }
      rows.push(el("div", { className: "slotrow" }, el("span", { className: "lbl", textContent: "L" + (i + 1) }), pips));
    });
    return rows;
  }

  return { hp, hitDice, conditions, slots, rest, restNote, CONDITIONS };
})();
