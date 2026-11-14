"use strict";
// =============================================================================
// tracker.js - the quick party tracker + initiative tracker widget
// =============================================================================
//
// WHAT IT IS
//   A small self-contained widget with two tabs:
//     "Party"      - one card per character: HP bar with +/- buttons, spell-slot
//                    "pips" (click to spend/restore), the character's own trackers
//                    (Mana / Ki / Rage ... only on characters that have them), inspiration,
//                    and a conditions box.
//     "Initiative" - the combat turn order: add the party and monsters, roll
//                    d20 + bonus, step through turns, and count rounds.
//
// WHICH PAGES LOAD IT
//   - The floating panel on the soundboard page.
//   - The stand-alone /tracker window (opened from the /party page).
//   Both pages include this file (after ui.js and vitals.js) with a <script> tag and then call
//   window.mountTracker(someElement) to build the widget inside that element.
//
// HOW IT RUNS (the 30-second mental model for a C programmer)
//   JavaScript in a browser is single-threaded and event driven. There is no
//   main loop of our own: the browser owns the loop, and we register callbacks
//   (onclick, onchange, setInterval, ...) that it calls when something happens.
//   The page itself is the "DOM": a tree of heap objects (one per HTML element)
//   that the browser draws. We build that tree from code, and "redraw" simply
//   means: empty a container and rebuild its children from the current data.
//   There is no framework; the data lives in a few plain variables below
//   (members, init) and the draw functions render them.
//
// SERVER ENDPOINTS USED (all JSON over HTTP, relative to the current site)
//   GET   /api/party?active=1 -> array of character summaries: ONLY the loaded campaign's party (empty when
//                               it has none). Fields used here:
//                                 id, name, class, hp, hpMax,
//                                 slots[]         max slots per spell level
//                                                 (index 0 = level 1),
//                                 slotsCurrent[]  slots remaining (may be
//                                                 shorter than slots[]),
//                                 trackers [{id, label, cur, max}],
//                                 inspiration, conditions (string),
//                                 mods[6]  ability modifiers STR..CHA
//   PATCH /api/party/<id>    -> body holds just the fields being changed, e.g.
//                                 {hpCurrent: 12}, {slotsCurrent: [...]},
//                                 {trackers: [{id, label, cur, max}, ...]},
//                                 {inspiration: 2}, {conditions: "prone"}.
//                               The reply is the updated character (same shape
//                               as one element of GET /api/party).
//   GET   /api/initiative    -> {round, active, order[]}   the LOADED CAMPAIGN's combat (each campaign has its
//                               own; the encounter builder and campaign cards can fill it too)
//   PUT   /api/initiative    -> same shape, replaces the stored state.
//                               "active" is the id of whose turn it is (or
//                               null). Each entry of order[] is:
//                                 PC:  {id, kind:"pc",  pc:<party id>, name,
//                                       bonus, init}
//                                 NPC: {id, kind:"npc", name, bonus, init,
//                                       hp, hpMax, ac, mid?}   mid = Open5e slug (from an encounter)
//                               init is the rolled total, bonus the modifier.
//
// HOW THE PIECES FIT
//   mountTracker(host)
//     |- builds the tab buttons and two containers (root = Party, initRoot =
//     |  Initiative)
//     |- refresh()    polls the server every 4 s and redraws if data changed
//     |- patch()      sends one edit for a character, merges the reply, redraws
//     |- drawParty()  -> hpBar(), trackerRows(), slotRows() for each character
//     '- drawInit()   -> initRow() for each combatant, plus step(), addParty(),
//                        addNpc(), saveInit() for the logic behind the buttons
// =============================================================================

// The whole file is wrapped in an "IIFE" (Immediately Invoked Function
// Expression): `(function () { ... })()` defines an anonymous function and calls
// it right away. Its only purpose is scoping: everything declared inside (h,
// call, uid, ...) stays private to this file instead of becoming a global that
// could collide with names in other scripts. Think of it as file-level `static`
// in C. The one thing deliberately exposed is window.mountTracker below.
(function () {
  // h(tag, props, ...kids) - tiny helper that creates one DOM element.
  //   tag   : HTML tag name, e.g. "div", "button", "input".
  //   props : an object of properties to copy onto the new element, e.g.
  //           { className: "pc", textContent: "Hi", onclick: fn, value: 3 }.
  //           Default parameter `props = {}` means "no props" if omitted.
  //   kids  : any number of children (the `...kids` "rest" parameter collects
  //           all remaining arguments into an array, like C varargs but safe).
  //           Each child may be a DOM element or a string (strings become text
  //           nodes). Gotcha: append(null) would add the literal text "null", so
  //           callers pass a real element or a string, never null.
  // Returns the new element. No side effects until the caller attaches it to
  // the page.
  // Safety note: callers set `textContent` (plain text) rather than innerHTML
  // (parsed as HTML), so a character named "<script>..." is shown literally
  // instead of being executed. That is the standard defence against injection.
  // `=>` defines an arrow function: a compact anonymous function, much like a
  // lambda / function pointer.
  const h = (tag, props = {}, ...kids) => {
    // Object.assign(target, source) copies every property of `source` onto
    // `target`. Setting onclick etc. this way registers event callbacks.
    const n = Object.assign(document.createElement(tag), props);
    // For each child, append it to the element (a string becomes a text node).
    kids.forEach(k => n.append(k));
    return n;
  };

  // call(url, method, body) - the one place that talks to the server.
  //   url    : endpoint path, e.g. "/api/party".
  //   method : HTTP verb, default "GET" (default parameter value).
  //   body   : optional JS object; if given it is sent as JSON.
  // Returns a Promise that resolves to the parsed JSON reply, or rejects
  // (throws) with an Error whose message is the server's {error:"..."} text if
  // the HTTP status was not 2xx.
  // `async` + `await`: an async function returns a Promise (like a future).
  // `await x` pauses THIS function until the Promise x completes, while the
  // browser keeps running other events; no thread blocks. It reads like
  // blocking code but is really cooperative scheduling on one thread.
  const call = async (url, method = "GET", body) => {
    // fetch() starts an HTTP request and returns a Promise of the response.
    // The object literal is the options: HTTP method, headers, and body. The
    // `cond ? a : b` ternary adds a Content-Type header only when sending a
    // body, and JSON.stringify turns the object into JSON text.
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    // r.ok is true for HTTP 200-299. On failure try to read {error: "..."} from
    // the body; `.catch(() => ({}))` supplies an empty object if the body is
    // not valid JSON, and `||` falls back to the HTTP status text.
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  };

  // uid() - makes a short random id (8 chars of base-36) for initiative rows.
  // Math.random() gives a float in [0,1); toString(36) renders it with digits
  // and letters; slice(2, 10) drops the leading "0." and keeps 8 characters.
  // Not cryptographic, just unique enough for a handful of combatants.
  const uid = () => Math.random().toString(36).slice(2, 10);

  // openParty(ev, id): the click handler for the tracker's links to the Characters page. Inside the app
  // shell this widget runs in a frame, and opening /party there would load the whole shell (a second
  // soundboard!) inside the frame. Instead we ask the shell to switch to its Characters tab and load
  // that character's page ("goto" message, see shell.html). In the stand-alone pop-out window there is
  // no shell to ask (window.parent is the window itself), so the link keeps its normal behaviour.
  function openParty(ev, id) {
    // Running directly in the app shell (the party panel lives there): switch its tab ourselves.
    if (window.shellGoto) {
      ev.preventDefault();
      window.shellGoto("party", id ? "/_/party/" + id : "/_/party");
      return;
    }
    if (window.parent === window) return;
    ev.preventDefault();
    window.parent.postMessage({ type: "goto", page: "party", path: id ? "/_/party/" + id : "/_/party" }, location.origin);
  }

  // window.mountTracker(host, opts) - the public entry point.
  //   opts.only       : a character id. Show just that one character (used on a character's page).
  //   opts.initiative : false = leave out the Initiative tab and its tab bar (default: show both tabs).
  //   opts.conditions : false = leave out the conditions chips;  opts.inspiration : false = leave out the Insp counter (a page that shows them elsewhere).
  // Assigning to `window` creates a global, which is how the HTML page (outside this IIFE) can call
  // it. Builds the whole widget inside the DOM element `host`, loads data, and
  // starts polling. Every function below is nested inside it, so they all share
  // its local variables (members, init, root, ...). That is a "closure": each
  // inner function is like a function pointer plus a captured pointer to the
  // enclosing variables, which stay alive as long as something still refers to
  // those functions (garbage collected, no free() needed).
  window.mountTracker = function (host, opts = {}) {
    // members  : latest list of characters from the server (shared state).
    // lastJson : JSON text of `members` at the last sync. Comparing strings is
    //            a cheap "did anything change?" test for the poller.
    // (`let a = x, b = y;` declares two variables in one statement.)
    let members = [], lastJson = "";
    // two tabs: the quick party tracker and the initiative order
    // root = container for the Party tab; initRoot = container for Initiative. The tab buttons are the shared UI.tabs (ui.js), the same
    // component the character sheet's sub-menus use; it remembers the last tab in this browser. Without the Initiative tab there is
    // nothing to switch between, so only the party list is added.
    const root = h("div"), initRoot = h("div", { className: "init" });
    if (opts.initiative === false) host.append(root);
    else host.append(UI.tabs({ key: "tracker", first: "party", tabs: [
      { id: "party", label: "Party", render: () => root }, { id: "init", label: "Initiative", render: () => initRoot }] }).el);

    // patch(m, body) - sends one edit for character `m` to the server.
    //   m    : the member object from `members` (modified in place).
    //   body : only the fields to change, e.g. { hpCurrent: 14 }.
    // Side effects: HTTP PATCH, mutates `m`, updates lastJson, redraws. On
    // failure shows an alert box with the server's message.
    // The server's reply is the authoritative, recomputed character (it may
    // clamp HP to 0..max, for instance). Object.assign(m, u) copies the reply's
    // fields onto the existing object so every part of the UI that holds a
    // reference to `m` (objects are references, like pointers) sees fresh data.
    // lastJson is then re-snapshotted so the next poll does not see our own
    // edit as an outside change and needlessly redraw.
    // One extra rule: raising a character from 0 HP to above 0 also clears their death saves
    // (a character who is conscious again starts fresh next time they fall).
    async function patch(m, body) {
      if (body.hpCurrent > 0 && m.hp === 0 && m.deaths && (m.deaths.s || m.deaths.f)) body.deaths = { s: 0, f: 0 };
      try {
        const u = await call("/api/party/" + m.id, "PATCH", body);
        Object.assign(m, u);
        lastJson = JSON.stringify(members);
        draw();
      } catch (e) { alert(e.message); }
    }

    // hpBar(m) - the HP row for character `m`: the shared Vitals.hp (vitals.js, also used on the character sheet), with every change
    // sent through patch().
    const hpBar = m => Vitals.hp(m, body => patch(m, body));

    // slotRows(m) - the spell-slot rows: the shared Vitals.slots (vitals.js, also on the character sheet's Spells page), changes sent through patch().
    const slotRows = m => Vitals.slots(m, body => patch(m, body));

    // classTrackerRows(m) - one row per COUNTER OF THE CLASS in the Fight Club file (Channel Divinity ...): name, - / + around "left / most", the same
    // look as the personal trackers. A change is saved into the class's <tracker> (PATCH classTrackers). A counter whose maximum the file does not
    // give as a plain number has no upper limit here.
    const classTrackerRows = m => (m.classTrackers || []).map(t => h("div", { className: "resrow" },
      h("span", { className: "lbl", textContent: t.label, title: `${t.cls} counter` }),
      h("button", { textContent: "−", onclick: () => patch(m, { classTrackers: [{ label: t.label, cur: t.cur - 1 }] }) }),
      h("b", { textContent: t.max != null ? `${t.cur} / ${t.max}` : String(t.cur) }),
      h("button", { textContent: "+", onclick: () => patch(m, { classTrackers: [{ label: t.label, cur: t.cur + 1 }] }) })));

    // setTrackers(m, list) - saves a new list of personal trackers for character `m` (the server
    // replaces the whole list, see PATCH /api/party/<id>).
    const setTrackers = (m, list) => patch(m, { trackers: list });

    // trackerRows(m) - one row per PERSONAL tracker of character `m` (Mana, Ki, Rage, Bardic
    // Inspiration ... whatever was added with "+ Tracker"). A character with no trackers gets no rows
    // at all; nothing is shown by default. Each row: the name (click it to rename or change the
    // maximum), - and + buttons around "current / max", and an X to remove the tracker.
    // Returns an ARRAY of row elements (possibly empty); the caller spreads it into the card.
    // Data: m.trackers = [{ id, label, cur, max }, ...].
    function trackerRows(m) {
      // change(t, fields): a copy of the list with tracker `t` updated. `{ ...t, ...fields }` builds a new
      // object holding t's fields overridden by `fields`; the count is clamped to 0..max
      // (`max || 1e6` means "no limit" when the maximum is 0).
      const change = (t, fields) => m.trackers.map(x => {
        if (x !== t) return x;
        const n = { ...t, ...fields };
        return { ...n, cur: Math.max(0, Math.min(n.cur, n.max || 1e6)) };
      });
      return m.trackers.map(t => h("div", { className: "resrow" },
        h("button", { className: "lbl linkish", textContent: t.label, title: "Click to rename or change the maximum", onclick: () => {
          // prompt() is a browser dialog; it returns null if cancelled, so we bail out on cancel.
          const label = prompt("Tracker name", t.label); if (label === null) return;
          const max = prompt("Maximum", t.max); if (max === null) return;
          setTrackers(m, change(t, { label: label.trim() || t.label, max: Math.max(0, +max || 0) }));
        } }),
        h("button", { textContent: "−", onclick: () => setTrackers(m, change(t, { cur: t.cur - 1 })) }),
        h("b", { textContent: `${t.cur} / ${t.max}` }),
        h("button", { textContent: "+", onclick: () => setTrackers(m, change(t, { cur: t.cur + 1 })) }),
        h("button", { className: "tiny danger", textContent: "✕", title: "Remove this tracker", onclick: () => {
          if (confirm(`Remove the ${t.label} tracker from ${m.name}?`)) setTrackers(m, m.trackers.filter(x => x !== t));
        } })));
    }

    // addTrackerRow(m) - the small "+ Tracker" button at the bottom of a character's card. Asks for a
    // name and a maximum, then adds a new tracker (starting full) to THIS character only.
    function addTrackerRow(m) {
      return h("button", { className: "tiny", textContent: "+ Tracker", title: "Add a personal tracker to this character (Mana, Ki, Rage ...)", onclick: () => {
        const label = prompt("Tracker name (e.g. Mana, Ki, Rage)"); if (!label || !label.trim()) return;
        const max = prompt("Maximum", "10"); if (max === null) return;
        const n = Math.max(0, +max || 0);
        setTrackers(m, [...m.trackers, { id: uid(), label: label.trim(), cur: n, max: n }]);
      } });
    }

    // inspiration(m) - the inspiration counter row (a real Fight Club field, shown for everyone).
    function inspiration(m) {
      return h("div", { className: "resrow" },
        h("span", { className: "lbl", textContent: "Insp" }),
        h("button", { textContent: "−", onclick: () => patch(m, { inspiration: m.inspiration - 1 }) }),
        h("b", { textContent: m.inspiration }),
        h("button", { textContent: "+", onclick: () => patch(m, { inspiration: m.inspiration + 1 }) }));
    }

    // lastDeathRoll: character id -> text describing their most recent death-save roll. Only kept in
    // this page (it is a short-lived message, not character data, so it is not saved anywhere).
    const lastDeathRoll = {};

    // rollDeathSave(m) - makes one death saving throw for `m` using the 5th-edition rules:
    //   natural 20 -> regains 1 HP and the saves are cleared;  natural 1 -> two failures;
    //   10 to 19 -> one success;  2 to 9 -> one failure.
    // Three successes = stable, three failures = dead (shown by deathSaves). Saves the result with
    // patch(), so the pips and the message appear on every device showing the tracker.
    function rollDeathSave(m) {
      const d = m.deaths || { s: 0, f: 0 },
        r = d20();
      let s = d.s, f = d.f, msg;
      if (r === 20) {
        msg = "🎲 20! Natural 20: back up with 1 HP.";
        lastDeathRoll[m.id] = msg;
        patch(m, { hpCurrent: 1, deaths: { s: 0, f: 0 } });
        return;
      }
      if (r === 1) { f = Math.min(3, f + 2); msg = "🎲 1: natural 1, two failures."; }
      else if (r >= 10) { s = Math.min(3, s + 1); msg = `🎲 ${r}: success.`; }
      else { f = Math.min(3, f + 1); msg = `🎲 ${r}: failure.`; }
      lastDeathRoll[m.id] = msg;
      patch(m, { deaths: { s, f } });
    }

    // deathSaves(m) - builds the death-saving-throw row for a character at 0 HP: three green
    // success pips, three red failure pips (click a pip to set the count by hand), a Roll button,
    // a Reset button, the status ("Dying", "Stable" or "Dead") and the last roll's message.
    // Data: m.deaths = { s, f } (successes and failures, each 0 to 3).
    function deathSaves(m) {
      const d = m.deaths || { s: 0, f: 0 };
      const status = d.s >= 3 ? "Stable" : d.f >= 3 ? "Dead" : "Dying";
      // pips(kind, n): three pip buttons, the first n filled. Clicking pip k sets the count to k
      // (if it was filled) or k+1 (if it was empty), the same toggle behaviour as the slot pips.
      const pips = (kind, n) => {
        const box = h("span", { className: "pips" });
        for (let k = 0; k < 3; k++) {
          box.append(h("button", {
            className: `pip death-${kind}` + (k < n ? " on" : ""),
            title: kind === "s" ? "Death save success" : "Death save failure",
            onclick: () => patch(m, { deaths: { ...d, [kind]: k < n ? k : k + 1 } })   // [kind] = computed key name
          }));
        }
        return box;
      };
      return h("div", { className: "deathrow" },
        h("span", { className: "lbl", textContent: "Death" }),
        h("span", { className: "lbl", textContent: "✓" }), pips("s", d.s),
        h("span", { className: "lbl", textContent: "✗" }), pips("f", d.f),
        h("button", { className: "tiny", textContent: "🎲 Roll save", title: "Roll a d20 death saving throw", onclick: () => rollDeathSave(m) }),
        h("button", { className: "tiny", textContent: "Reset", onclick: () => { lastDeathRoll[m.id] = ""; patch(m, { deaths: { s: 0, f: 0 } }); } }),
        h("b", { className: "death-" + status.toLowerCase(), textContent: status }),
        h("span", { className: "muted", textContent: lastDeathRoll[m.id] || "" }));
    }

    // draw() - redraws both tabs from the current data. Called after any
    // change (our own edit, or newer data from the poller). Declared as a
    // `const` arrow function, but only ever invoked after the whole mount
    // function has finished defining it, so the order is fine.
    const draw = () => { drawParty(); if (opts.initiative !== false) drawInit(); };

    // drawParty() - rebuilds the Party tab from `members`. Skips entirely if
    // the user is typing in one of our text/number boxes: a rebuild would
    // destroy that input and throw away half-typed text and the cursor. The
    // next poll (4 s later) or edit will redraw instead.
    function drawParty() {
      // document.activeElement = the element that currently has keyboard focus.
      const active = document.activeElement;
      if (active && host.contains(active) && active.tagName === "INPUT") return; // don't clobber typing
      // Setting textContent to "" removes all children (a quick "clear").
      root.textContent = "";
      // opts.only narrows the list to a single character (the per-character page).
      const shown = opts.only ? members.filter(m => m.id === opts.only) : members;
      if (!shown.length) {
        root.append(h("p", { className: "muted" }, opts.only ? "Character not found. " : "No one is in this campaign's party yet. Add characters from the Home tab. ",
          h("a", { href: "/party", textContent: "Characters →", onclick: ev => openParty(ev, "") })));
        return;
      }
      shown.forEach(m => {
        // Conditions: chips plus an Add menu (the shared Vitals.conditions); saved to the server when changed.
        const cond = Vitals.conditions(m, body => patch(m, body));
        // One <article> card per character. `...slotRows(m)` is the spread
        // operator: it expands the returned array into separate arguments.
        root.append(h("article", { className: "pc" },
          h("header", {},
            h("a", { href: "/party/" + m.id, target: "_blank", textContent: m.name, title: "Open full character page", onclick: ev => openParty(ev, m.id) }),
            // the class, and the Short rest / Long rest buttons inline on the right (Vitals.rest, vitals.js)
            h("span", { className: "right" }, h("span", { className: "muted", textContent: m.class }), Vitals.rest(m, body => patch(m, body)))),
          ...(Vitals.restNote[m.id] ? [h("div", { className: "muted restnote", textContent: Vitals.restNote[m.id] })] : []),
          // The death-save row only appears while the character is at 0 HP.
          hpBar(m), ...(m.hp === 0 ? [deathSaves(m)] : []), ...trackerRows(m), ...classTrackerRows(m), ...(opts.inspiration === false ? [] : [inspiration(m)]), ...slotRows(m), addTrackerRow(m), ...(opts.conditions === false ? [] : [cond])));
      });
    }

    // ------------------------------------------------------------ initiative
    // Initiative state, mirrored to the server (see /api/initiative above):
    //   round  : combat round number (starts at 1)
    //   active : id of the combatant whose turn it is, or null
    //   order  : array of combatants (kept sorted highest initiative first)
    // initJson : JSON snapshot used to detect outside changes (like lastJson).
    // initTimer: handle of a pending delayed save (see saveInit).
    let init = { round: 1, active: null, order: [] }, initJson = "", initTimer = null;

    // d20() - rolls a twenty-sided die: random float in [0,1) times 20, floored
    // to 0..19, plus 1 = 1..20.
    const d20 = () => 1 + Math.floor(Math.random() * 20);

    // sgn(n) - formats a number with an explicit sign: 3 -> "+3", -1 -> "-1".
    // (A negative number already carries its own "-" when turned into text.)
    const sgn = n => (n >= 0 ? "+" : "") + n;

    // sortOrder() - sorts init.order IN PLACE so the highest initiative acts
    // first. The comparator returns negative/zero/positive like C qsort:
    // (b - a) means descending. A missing initiative (null/undefined, `??`)
    // counts as -99 so blank rows sink to the bottom. If initiatives tie, `||`
    // moves on to the second comparison, higher bonus first (the usual D&D
    // tie-break by Dexterity modifier). `|| 0` treats a missing bonus as 0.
    const sortOrder = () => init.order.sort((a, b) =>
      (b.init ?? -99) - (a.init ?? -99) ||
      (b.bonus || 0) - (a.bonus || 0));

    // saveInit() - records the new state locally and schedules an upload.
    // The upload is debounced: every call cancels any pending timer and starts
    // a fresh 300 ms one, so rapid edits (clicking Next several times) produce
    // a single PUT with the final state. initJson is updated immediately so the
    // poller does not mistake our own edit for someone else's. A failed upload
    // is ignored (`.catch(() => {})`); the next change will try again.
    function saveInit() {
      initJson = JSON.stringify(init);
      clearTimeout(initTimer);
      initTimer = setTimeout(() => call("/api/initiative", "PUT", init).catch(() => {}), 300);
    }

    // changed() - the standard "I modified the order" routine: re-sort, save,
    // and force a redraw (force = true, see drawInit).
    const changed = () => { sortOrder(); saveInit(); drawInit(true); };

    // step(dir) - moves the turn marker: dir = +1 for next turn, -1 for
    // previous. Wraps around the list (modular arithmetic), counts rounds, and
    // saves/redraws. Does nothing if the order is empty.
    function step(dir) {
      const o = init.order;
      if (!o.length) return;
      // i = index of the current active combatant (-1 if none is active);
      // n = the new index. Adding o.length before % keeps the result
      // non-negative when stepping backwards from index 0 (C's % can go
      // negative, and so can JavaScript's).
      const i = o.findIndex(c => c.id === init.active),
        n = (i + dir + o.length) % o.length;
      // Wrapping from the last combatant back to the first starts a new round.
      if (dir > 0 && n === 0) init.round++;
      // Stepping back from the first combatant returns to the previous round,
      // but never below round 1.
      if (dir < 0 && i === 0) init.round = Math.max(1, init.round - 1);
      init.active = o[n].id; saveInit(); drawInit(true);
    }

    // addParty() - adds every party member not already in the order, rolling
    // each one's initiative (d20 + Dexterity modifier). Existing entries are
    // left alone. The first entry becomes active if nobody is yet.
    function addParty() {
      members.forEach(m => {
        // `some` = "is there any element for which this is true?"; skip PCs
        // already present.
        if (init.order.some(c => c.pc === m.id)) return;
        // m.mods is [STR, DEX, CON, INT, WIS, CHA]; index 1 is DEX. `?.` is
        // optional chaining: if m.mods is missing it yields undefined instead
        // of throwing, and `?? 0` then supplies 0.
        const bonus = m.mods?.[1] ?? 0;
        init.order.push({ id: uid(), kind: "pc", pc: m.id, name: m.name, bonus, init: d20() + bonus });
      });
      if (!init.active && init.order.length) init.active = init.order[0].id;
      changed();
    }

    // addNpc(f) - adds one or more monsters from the form `f` (a <form>
    // element; f.name, f.count ... are its named inputs). Several copies get
    // numbered names ("Goblin 1", "Goblin 2") and each rolls initiative
    // separately. Resets the form afterwards.
    function addNpc(f) {
      // `.trim()` strips spaces; empty name -> "Monster". Count is at least 1
      // (`+x || 1` turns blank/NaN into 1). Blank bonus -> 0.
      const name = f.name.value.trim() || "Monster", n = Math.max(1, +f.count.value || 1), bonus = +f.bonus.value || 0;
      // Blank HP/AC means "not tracked" (null) rather than 0.
      const hp = f.hp.value === "" ? null : +f.hp.value, ac = f.ac.value === "" ? null : +f.ac.value;
      for (let i = 0; i < n; i++)
        init.order.push({ id: uid(), kind: "npc", name: n > 1 ? `${name} ${i + 1}` : name, bonus, init: d20() + bonus, hp, hpMax: hp, ac });
      if (!init.active && init.order.length) init.active = init.order[0].id;
      f.reset(); changed();
    }

    // numInput(val, cls, title, onset) - builds a small number box.
    //   val   : starting value (null/undefined shows blank, via `?? ""`).
    //   cls   : CSS class; title: tooltip text.
    //   onset : callback given the new value (a number, or null if blank); the
    //           caller uses it to store the value in the right field.
    // After the edit it saves and redraws (forced, so the row re-sorts).
    const numInput = (val, cls, title, onset) => {
      const i = h("input", { type: "number", className: cls, value: val ?? "", title });
      i.onchange = () => { onset(i.value === "" ? null : +i.value); saveInit(); drawInit(true); };
      return i;
    };

    // initRow(c) - builds the display row for one combatant `c` (an entry of
    // init.order): initiative box, re-roll button, name (click = make active),
    // AC box, remove button, and a second line of stats. For party members the
    // second line shows live HP buttons, ability mods and resources taken from
    // the party data; for monsters with HP it shows a local HP counter.
    function initRow(c) {
      // For a PC entry, find the matching live character record (null for
      // monsters or if that character was removed from the party).
      const m = c.kind === "pc" ? members.find(x => x.id === c.pc) : null;
      // Highlight classes: "active" for whose turn it is, "pc" for characters.
      const row = h("div", { className: "irow" + (c.id === init.active ? " active" : "") + (m ? " pc" : "") });
      const head = h("div", { className: "ihead" },
        // Editing the initiative stores it and re-sorts the list.
        numInput(c.init, "inum", "Initiative", v => { c.init = v; sortOrder(); }),
        h("button", { className: "tiny", textContent: "🎲", title: "Re-roll d20 + bonus", onclick: () => { c.init = d20() + (c.bonus || 0); changed(); } }),
        h("b", { className: "iname", textContent: c.name, title: "Click to make this the active turn", onclick: () => { init.active = c.id; saveInit(); drawInit(true); } }),
        h("span", { className: "muted", textContent: m ? m.class : "" }),
        // Empty flexible spacer that pushes the AC/remove controls right.
        h("span", { className: "grow" }),
        // Monsters from the encounter builder carry their Open5e id (c.mid): the book button opens the stat block.
        c.mid ? h("button", { className: "tiny", textContent: "📖", title: "Stat block", onclick: () => window.open("/monster/" + c.mid, "dmmonster", "width=540,height=760") }) : "",
        h("span", { className: "lbl", textContent: "AC" }), numInput(c.ac, "inum", "Armor class", v => { c.ac = v; }),
        h("button", { className: "tiny danger", textContent: "✕", title: "Remove", onclick: () => {
          // filter() builds a new array without this combatant. If the removed
          // one was active, hand the turn to the new first entry (`?.id ?? null`
          // is safe when the list is now empty).
          init.order = init.order.filter(x => x !== c);
          if (init.active === c.id) init.active = init.order[0]?.id ?? null;
          changed();
        } }));
      row.append(head);
      if (m) {
        // Party member: HP buttons write through to the real character via
        // patch() (the same data as the Party tab), not to the initiative list.
        const hpb = (label, d) => h("button", { className: "tiny", textContent: label, onclick: () => patch(m, { hpCurrent: m.hp + d }) });
        row.append(h("div", { className: "istats" },
          h("span", { className: "lbl", textContent: "HP" }), hpb("−5", -5), hpb("−1", -1),
          h("b", { textContent: `${m.hp}/${m.hpMax}` }), hpb("+1", 1), hpb("+5", 5),
          // map with (name, index) builds "STR +2", "DEX -1", ... and join
          // glues the six strings together with two spaces.
          h("span", { className: "mods", textContent: ["STR", "DEX", "CON", "INT", "WIS", "CHA"].map((n, i) => `${n} ${sgn(m.mods?.[i] ?? 0)}`).join("  ") })));
        if (m.hp === 0) row.append(deathSaves(m));   // dying characters get their death saves right in the turn order
        // Compact slot summary like "L1 3/4  L2 2/3". Levels with no slots
        // map to "" and `.filter(Boolean)` drops empty (falsy) strings.
        const slots = m.slots.map((mx, i) => (mx ? `L${i + 1} ${m.slotsCurrent[i] ?? mx}/${mx}` : "")).filter(Boolean).join("  ");
        // Gather optional extra info. `slots && "Slots: " + slots` yields ""
        // when slots is empty (short-circuit &&), and filter(Boolean) removes
        // all the empty pieces before joining with " · ".
        const extra = [
          slots && "Slots: " + slots,
          ...m.trackers.map(t => `${t.label} ${t.cur}/${t.max}`),
          m.conditions
        ].filter(Boolean).join(" · ");
        if (extra) row.append(h("div", { className: "muted", textContent: extra }));
      } else if (c.hpMax != null) {
        // Monster with tracked HP (`!= null` is true for both null and
        // undefined). adj(d) changes HP by d, floored at 0, and saves.
        const adj = d => { c.hp = Math.max(0, (c.hp ?? 0) + d); saveInit(); drawInit(true); };
        row.append(h("div", { className: "istats" },
          h("span", { className: "lbl", textContent: "HP" }),
          h("button", { className: "tiny", textContent: "−5", onclick: () => adj(-5) }),
          h("button", { className: "tiny", textContent: "−1", onclick: () => adj(-1) }),
          numInput(c.hp, "inum", "Current HP", v => { c.hp = v ?? 0; }),
          h("span", { textContent: "/ " + c.hpMax }),
          h("button", { className: "tiny", textContent: "+1", onclick: () => adj(1) }),
          h("button", { className: "tiny", textContent: "+5", onclick: () => adj(5) })));
      }
      return row;
    }

    // drawInit(force) - rebuilds the Initiative tab from `init`.
    //   force : true when the user just clicked something in this tab (we know
    //           a rebuild is wanted and safe); omitted (undefined/falsy) when
    //           called from the passive draw() path.
    // Without force, it skips while an input inside this tab has focus, for the
    // same reason as drawParty: don't destroy a box the user is typing in.
    function drawInit(force) {
      const a = document.activeElement;
      if (!force && a && initRoot.contains(a) && a.tagName === "INPUT") return;
      initRoot.textContent = "";
      // The "add monster" form: name, how many, initiative bonus, HP, AC.
      const npc = h("form", { className: "npcform" },
        h("input", { name: "name", placeholder: "Monster" }),
        h("input", { name: "count", type: "number", min: 1, value: 1, title: "How many", className: "inum" }),
        h("input", { name: "bonus", type: "number", placeholder: "init +", title: "Initiative bonus", className: "inum" }),
        h("input", { name: "hp", type: "number", placeholder: "HP", className: "inum" }),
        h("input", { name: "ac", type: "number", placeholder: "AC", className: "inum" }),
        h("button", { className: "primary tiny", textContent: "Add monster(s)", type: "submit" }));
      // preventDefault stops the browser's normal form submit (which would
      // navigate/reload the page); we handle it ourselves in JS.
      npc.onsubmit = ev => { ev.preventDefault(); addNpc(npc); };
      initRoot.append(
        // Control bar: round label, previous/next turn, add party, roll all,
        // clear.
        h("div", { className: "ictl" }, h("b", { textContent: "Round " + init.round }),
          h("button", { textContent: "◀", title: "Previous turn", onclick: () => step(-1) }),
          h("button", { className: "primary", textContent: "Next turn ▶", onclick: () => step(1) }),
          h("button", { textContent: "Add party", onclick: addParty }),
          // "Roll all" re-rolls everyone and restarts at round 1.
          h("button", { textContent: "Roll all", onclick: () => { init.order.forEach(c => (c.init = d20() + (c.bonus || 0))); init.round = 1; changed(); } }),
          // "Clear" asks for confirmation, then replaces the state with a
          // fresh empty one (the old object is simply garbage collected).
          h("button", { className: "danger", textContent: "Clear", onclick: () => { if (confirm("Clear the initiative order?")) { init = { round: 1, active: null, order: [] }; changed(); } } })),
        npc,
        // One row per combatant, or a hint if the list is empty. `...(cond ?
        // list : [fallback])` spreads whichever array was chosen into the
        // arguments. `init.order.map(initRow)` passes each combatant to initRow.
        ...(init.order.length ? init.order.map(initRow) : [h("p", { className: "muted", textContent: "Empty. Add the party and/or monsters, then press Next turn." })]));
    }

    // refresh() - the poller body: fetches the party and the initiative state
    // and redraws only if something changed. Called once at start and then
    // every 4 seconds (setInterval below), so edits made from another browser
    // or window (a DM tablet, the /tracker pop-out) show up without a reload.
    // 4 s is a compromise: fresh enough for a game table, light on the server.
    async function refresh() {
      try {
        // Promise.all starts both requests at once and waits for both (like
        // launching two async I/O operations and joining them). The result is
        // an array, unpacked by destructuring into `next` and `ini`.
        // The initiative order is the DM's, so a page without the Initiative tab does not ask for it (a player
        // would be refused). "?active=1" narrows the DM's list to the campaign's party, but a single
        // character's page needs that character even when it is not in the party.
        const [next, ini] = await Promise.all([call(opts.only ? "/api/party" : "/api/party?active=1"),
          opts.initiative === false ? init : call("/api/initiative")]);
        // Compare by JSON text; the server returns the same field order each
        // time, so equal data gives equal strings.
        const j = JSON.stringify(next), ij = JSON.stringify(ini);
        const a = document.activeElement;
        // Redraw if the party changed, or if initiative changed AND the user is
        // not currently focused inside the initiative tab (we must not replace
        // data under a half-typed number). The skipped initiative update is
        // picked up on a later tick because initJson is not updated yet.
        if (j !== lastJson || (ij !== initJson && !(a && initRoot.contains(a)))) {
          members = next; lastJson = j; init = ini; initJson = ij; draw();
        }
      } catch (_) { /* server restarting; try again next tick */ }
    }
    refresh();
    // setInterval registers a callback the browser runs every 4000 ms.
    setInterval(refresh, 4000);
  };
})();
