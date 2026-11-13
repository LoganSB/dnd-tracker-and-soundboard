"use strict";
// =============================================================================
// timers.js - TIMER objects, shared by the soundboard and the campaign tracker
// =============================================================================
//
// A timer is a card like any other (it sits in a section, can be dragged, deleted, undone). Its data, on both pages:
//   card.timer = { secs, endsAt?, left?, done?, doneAt? }     card.sound = id of a sound to play when it finishes (optional)
//     secs     the duration to count down from
//     endsAt   while RUNNING: the clock time (ms since 1970) when it finishes. A clock time, not a counter, so the timer keeps true time
//              while the page is closed or in the background, and finishes the moment the page is opened again.
//     left     while PAUSED: the seconds that were left
//     done     true once it has finished (until it is reset); doneAt is when
// When a timer finishes the page is told (onComplete): the card flashes for a few seconds and stays marked "done", the TAB it is on
// flashes in the app's top bar until you open it, and the linked sound, if there is one, plays: on the soundboard it plays right
// away, on the campaign tracker it asks the soundboard to play it (the same way a flag's linked sound works).
//
//   Timers.state(t)        "idle" | "running" | "paused" | "done"        Timers.remaining(t)   seconds left
//   Timers.start / pause / reset(t)        change the data (the page then saves and redraws)
//   Timers.body(card, redraw)              the countdown and the Start / Pause / Reset buttons, as elements (the same on both pages)
//   Timers.alarming(card)                  true for the first few seconds after it finished (the page adds a flashing class)
//   Timers.watch({ cards, onComplete, redraw })   start the clock: every quarter second it updates the countdowns and finishes timers
//   Timers.fields(card, { sounds, sections }) / Timers.apply(card, values)    the settings form (use with Nodes.form)
//   Timers.flashTab(page)                  ask the app shell to make that tab's link flash
const Timers = (() => {
  const ALARM_MS = 10000;   // how long a card flashes after finishing
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  };

  const state = t => (t.done ? "done" : t.endsAt ? "running" : t.left != null ? "paused" : "idle");
  const remaining = (t, at = Date.now()) => (t.done ? 0 : t.endsAt ? Math.max(0, (t.endsAt - at) / 1000) : t.left ?? t.secs);
  function start(t) {
    if (t.done) reset(t);
    if (t.endsAt) return;
    t.endsAt = Date.now() + remaining(t) * 1000;
    delete t.left;
  }
  function pause(t) {
    if (!t.endsAt) return;
    t.left = remaining(t);
    delete t.endsAt;
  }
  function reset(t) { delete t.endsAt; delete t.left; delete t.done; delete t.doneAt; }
  // fmt(secs): "1:05:09" for an hour or more, "5:09" below.
  function fmt(secs) {
    const n = Math.ceil(secs), h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60, p = v => String(v).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }
  const alarming = card => !!card.timer?.done && Date.now() - (card.timer.doneAt || 0) < ALARM_MS;

  // body(card, redraw): the countdown (updated by watch) and the buttons. `redraw()` is called after a button changes the data; the
  // page's own redraw saves and rebuilds.
  function body(card, redraw) {
    const t = card.timer, st = state(t);
    const count = el("div", { className: "tcount " + st, textContent: st === "done" ? "Done" : fmt(remaining(t)) });
    count.dataset.tid = card.id;
    const btn = (text, title, fn) => el("button", { type: "button", className: "tiny", textContent: text, title, onclick: ev => { ev.stopPropagation(); fn(t); redraw(); } });
    return [count, el("div", { className: "tbtns" },
      st === "running" ? btn("⏸ Pause", "Pause the timer", pause) : btn(st === "done" ? "▶ Again" : st === "paused" ? "▶ Resume" : "▶ Start", "Start the timer", start),
      btn("↺ Reset", "Back to the full time", reset))];
  }

  // watch({ cards, onComplete, redraw }): the clock for one page. cards() returns every timer card of the page. Each quarter second the
  // countdowns on screen are updated, a running timer whose time has come is finished (done = true) and reported through onComplete(card,
  // late), and when a flashing card's few seconds are over the page is redrawn so the flash stops. A timer that ran out while the page was
  // closed is finished at once with late = true (the page then flashes the tab but does not play the sound, which would be hours late).
  function watch({ cards, onComplete, redraw }) {
    const check = firstTime => {
      const list = cards();
      let changed = false;
      list.forEach(c => {
        const t = c.timer;
        if (t.endsAt && t.endsAt <= Date.now()) {
          const late = firstTime || Date.now() - t.endsAt > 5000;   // finished while we were not looking
          t.doneAt = late ? Date.now() : t.endsAt;   // a late one flashes from now, however long ago it ended
          t.done = true;
          delete t.endsAt;
          delete t.left;
          onComplete(c, late);
          changed = true;
        } else if (t.done && t.doneAt && Date.now() - t.doneAt >= ALARM_MS && Date.now() - t.doneAt < ALARM_MS + 500) changed = true;   // flash over
      });
      document.querySelectorAll("[data-tid]").forEach(n => {
        const c = list.find(x => x.id === n.dataset.tid);
        if (c && state(c.timer) === "running") n.textContent = fmt(remaining(c.timer));
      });
      if (changed) redraw();
    };
    check(true);
    setInterval(() => check(false), 250);
  }

  // fields / apply: the settings form. fields(card, { sounds: [{value,label}], sections: [{value,label}] }) -> fields for Nodes.form;
  // apply(card, values) writes the form's values back (the duration is kept in seconds; changing it resets a timer that is not running).
  function fields(card, { sounds, sections }) {
    const s = card.timer.secs;
    return [
      { key: "name", label: "Name", value: card.name, placeholder: "e.g. Ritual finishes" },
      { key: "h", label: "Hours", type: "number", min: 0, max: 99, step: 1, value: Math.floor(s / 3600) },
      { key: "m", label: "Minutes", type: "number", min: 0, max: 59, step: 1, value: Math.floor((s % 3600) / 60) },
      { key: "s", label: "Seconds", type: "number", min: 0, max: 59, step: 1, value: s % 60 },
      { key: "sound", label: "Sound when it finishes", type: "select", value: card.sound || "", options: [{ value: "", label: "(none)" }, ...sounds] },
      { key: "section", label: "Section", type: "select", value: card.section || "", options: sections },
    ];
  }
  function apply(card, v) {
    const secs = Math.max(1, Math.floor((v.h || 0) * 3600 + (v.m || 0) * 60 + (v.s || 0)));
    card.name = v.name.trim() || card.name;
    if (secs !== card.timer.secs) { card.timer.secs = secs; if (!card.timer.endsAt) { delete card.timer.left; delete card.timer.done; delete card.timer.doneAt; } }
    if (v.sound) card.sound = v.sound; else delete card.sound;
    card.section = v.section || "";
  }

  // flashTab(page): ask the app shell (the page that holds this one in a frame) to make that tab's link flash until it is opened.
  function flashTab(page) {
    if (window.parent !== window) window.parent.postMessage({ type: "flashTab", page }, location.origin);
  }

  return { state, remaining, start, pause, reset, fmt, alarming, body, watch, fields, apply, flashTab };
})();
