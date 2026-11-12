"use strict";
// =============================================================================
// app.js  -  browser-side code for the D&D soundboard
// =============================================================================
//
// WHAT THIS PROGRAM IS
//   A web page (served by a small Flask server written in Python) that lets a
//   game master trigger sound effects and background music during a tabletop
//   session. Sounds live on "tiles"; tiles live in "sections". Sounds can be
//   wired together with on-screen "cables" into chains, so that when one sound
//   ends (or is told to advance) the next one crossfades in.
//
//   This file is the entire front end logic. It runs inside the browser, in a
//   single thread, and reacts to events (clicks, key presses, timers, network
//   replies). There is no main() loop you write: you register callbacks and
//   the browser calls them. Think of it as an interrupt-driven program where
//   the "interrupts" are user input and timers.
//
// A QUICK TOUR OF THE JAVASCRIPT YOU WILL SEE (C analogies)
//   - `const x = ...` is a constant binding; `let x = ...` is a variable.
//     There are no declared types; a variable can hold a number, string,
//     object, function, etc.
//   - Objects ({ a: 1, b: 2 }) behave like heap-allocated structs/hash tables.
//     An "object variable" is a REFERENCE (like a pointer): copying it does not
//     copy the object. There is no free(); a garbage collector reclaims
//     objects nothing points to any more.
//   - Arrays are growable heap arrays with built-in helpers (map, filter, ...).
//   - A function can be written as an "arrow function": `x => x + 1` is the
//     same as a tiny function taking x and returning x + 1. Functions are
//     values: you can store them, pass them around, and register them as
//     callbacks.
//   - A "closure" is a function that remembers the local variables of the
//     place where it was created (roughly: a function pointer bundled with a
//     struct holding the captured variables). Most callbacks below are closures.
//   - `async` / `await` / Promise: network and timer operations never block the
//     single thread. A Promise is like a future/handle for a result that
//     arrives later; `await p` pauses ONLY the current async function until the
//     result is ready, while the browser keeps running other events.
//   - The DOM ("Document Object Model") is a tree of heap objects, one per
//     HTML element. The browser draws whatever the tree currently describes.
//     Changing an object's properties changes what is on screen.
//
// THE DATA MODEL  (everything the user can save lives in one object, `S`)
//
//   S = {
//     sections: [ { id, name, collapsed? } ],        // named groups of tiles, e.g. "Act 2"
//     tiles: [ {                                      // one flat list; each tile points at its section
//        id, name, section,                           //   section = the id of the owning section
//        x, y, w,                                     //   position and width on the canvas, in world pixels (see canvas.js)
//        pinned,                                      //   pinned tiles cannot be deleted (and stay visible on mobile)
//        volume,                                      //   0..1, the tile's volume bus
//        fade: { on, secs },                          //   fade-out when stopping a sound by hand
//        linkFade,                                    //   crossfade seconds when a chain advances
//        subs: [ { id, name } ],                      //   optional named subsections inside the tile
//        sounds: [ {                                  //   the sounds on this tile
//           id, name, url,                            //   url = where to fetch it from (e.g. a YouTube/myinstants link)
//           type,                                     //   "music" | "instant" | "clip"
//           key,                                      //   optional keyboard shortcut (one lowercase letter)
//           group,                                    //   id of the subsection it is in (absent = top of tile)
//           volume,                                   //   0..1 per-sound volume
//           start, end,                               //   optional trim points in seconds
//           loop, restart,                            //   loop forever / always restart instead of resuming
//           repeatDelay,                              //   optional timer: seconds to wait after it finishes, then
//                                                     //   play it again (e.g. 600 = a bell every 10 minutes)
//           next, nextAt,                             //   chain link: id of the sound that plays next, and the
//                                                     //   Date.now() timestamp of when the link was made
//           autoName                                  //   true while the name should be filled in from the media title
//        } ]
//     } ]
//   }
//
//   Chains: a sound has at most ONE output (`next`) but can have MANY inputs
//   (any number of other sounds may point their `next` at it). So a chain is
//   really a directed graph; it can fork-in (merge) and even loop.
//
//   Two pieces of state are NOT in S (they are not saved to the server):
//     engines   Map: sound id -> runtime audio object (see "audio" section)
//     cameFrom  Map: sound id -> which input we most recently entered it from
//   A Map is a hash table with arbitrary keys; here the keys are id strings.
//
// HOW THE PIECES FIT TOGETHER
//   1. STATE -> SCREEN.  render() throws away the tile/section DOM and rebuilds
//      it from S every time something changes. (Simple and robust; the page is
//      small enough that rebuilding is fast.) The builder functions
//      groupEl / tileEl / soundEl create the DOM elements. Tiles are boxes placed at their own x, y on
//      an infinite pan-and-zoom canvas (canvas.js, ComfyUI style); each section is drawn as a frame
//      around its tiles.
//   2. SCREEN -> STATE.  Event handlers attached while building the DOM modify
//      S (or call the audio engine), then call save() and/or render().
//   3. SAVING.  save() sends all of S to the Flask server (PUT /api/state),
//      debounced so a burst of changes becomes one request.
//   4. AUDIO.  Sounds are downloaded/decoded by loadSound(), played by
//      startSound() and stopped by stopSound(). The audio signal path is
//          sound source -> per-sound GainNode -> per-tile bus -> master -> speakers
//      where each GainNode is a volume knob in the browser's Web Audio graph.
//   5. CHAINS.  advance() crossfades from a sound to its `next`; activePath()
//      computes the highlighted chain around whatever is playing; chainInfo()
//      works out colours / position numbers for the chain badges.
//   6. CABLES.  After every render, drawLinks() measures where the sound cards
//      ended up on screen and draws SVG lines between linked cards.
//      routeCables() is a small path-finding engine that keeps the cables
//      from crossing over cards. startLink() handles dragging a new cable.
//   7. DIALOGS.  Add/edit-sound, tile settings and presets use HTML <dialog>
//      elements defined in the HTML page (which this file looks up by id).
//
// ORDER OF EXECUTION AT PAGE LOAD
//   The browser loads the HTML, then runs this file from top to bottom ONCE:
//     a. helper functions and the empty state S are defined;
//     b. the audio context and master volume are created, and "click anywhere
//        to unlock audio" listeners are registered;
//     c. all functions are defined and all buttons get their click handlers;
//     d. the last block (at the bottom, "boot") asks the server for the saved
//        state, normalises it, calls render(), then loadAll() to preload audio.
//   After that nothing "runs" on its own: only event handlers and timers.
//
// NOTE ON "$", "el", ETC.
//   Several very short helper names are defined first (`$`, `el`, `uid`, `api`).
//   `$` is not special syntax here; it is just an ordinary function name.

// ---------------------------------------------------------------- helpers
// Small utilities used everywhere else.

// $(selector, root): find the first DOM element matching a CSS selector
// (e.g. "#master" = the element whose id is "master"). `root` defaults to the
// whole page; `r = document` is a default parameter value. Returns null if
// nothing matches. Arrow function: `(params) => expression-to-return`.
const $ = (s, r = document) => r.querySelector(s);

// el(tag, props, ...kids): create a DOM element in one expression.
//   tag   - HTML tag name, e.g. "div" or "button".
//   props - an object whose fields are copied onto the new element
//           (e.g. { className: "x", textContent: "hi", onclick: fn }).
//   kids  - any number of children to append (`...kids` is a "rest" parameter:
//           it collects the extra arguments into an array).
// NB: never pass undefined/false as a child (append would print it)
const el = (tag, props = {}, ...kids) => {
  // Object.assign(target, source) copies source's fields onto target, like memcpy for named fields.
  const n = Object.assign(document.createElement(tag), props);
  kids.forEach(k => n.append(k));   // forEach calls the arrow function once per array item
  return n;
};

// uid(): a short random id string such as "k3j9x0ab". Math.random() gives a
// float in [0,1); toString(36) writes it in base 36 (digits+letters);
// slice(2, 10) drops the leading "0." and keeps 8 characters. Not
// cryptographic, just unique enough for ids in one soundboard.
const uid = () => Math.random().toString(36).slice(2, 10);

// api(url, method, body): talk to the Flask server and return its JSON reply.
//   `async` means this function returns a Promise (a future); callers either
//   `await` it or attach .then()/.catch(). It never blocks the browser.
//   body (optional) is a JS object sent as JSON.
// Throws an Error if the server answers with an error status, so callers can
// use try/catch.
const api = async (url, method = "GET", body) => {
  // fetch() is the browser's HTTP client; `await` suspends this function until the reply headers arrive.
  const r = await fetch(url, {
    method,                                   // shorthand for `method: method`
    headers: body ? { "Content-Type": "application/json" } : {},
    // JSON.stringify turns the object into text. The 2nd argument is a filter function:
    // any key starting with "_" is dropped (returning undefined omits it), so runtime-only
    // fields prefixed with an underscore never get saved to the server.
    body: body ? JSON.stringify(body, (k, v) => (k[0] === "_" ? undefined : v)) : undefined,
  });
  // r.json() parses the reply body; .catch(() => ({})) substitutes an empty object if it is not valid JSON.
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);   // `a || b` = a unless a is empty/falsy, then b
  return j;
};

// S is the whole saved state (see the data model in the file header). It starts
// empty and is replaced with the server's copy by the boot block at the bottom.
let S = { sections: [], tiles: [] };

// The server renders a different HTML page for phones; it marks <body> with class "mobile".
// MOBILE changes layout rules below (no cables, tabbed tiles).
const MOBILE = document.body.classList.contains("mobile");

// pref(key, default): read a true/false setting from localStorage (a tiny
// key/value store the browser keeps per site, like a settings file). Values
// are stored as the strings "1"/"0". The try/catch is there because browsers
// can forbid localStorage (private mode); then we just use the default.
// `catch (_)` ignores the error object.
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch (_) { return d; } };

// setPref(key, bool): the writing counterpart of pref(); failures are ignored on purpose.
const setPref = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch (_) {} };

// stopToggle: when true, pressing a sound that is already playing stops it
// ("press to stop"). When false, pressing it again restarts it instead.
let stopToggle = pref("pressToStop", true);

// syncToggles(): make the "Press to stop" button's label and highlight match stopToggle.
function syncToggles() {
  $("#toggleBtn").textContent = "Press to stop: " + (stopToggle ? "ON" : "OFF");
  $("#toggleBtn").classList.toggle("on-state", stopToggle);   // toggle(name, bool): add the CSS class if bool is true, else remove it
}
// Assigning a function to `.onclick` registers it as the button's click callback.
$("#toggleBtn").onclick = () => {
  stopToggle = !stopToggle;
  setPref("pressToStop", stopToggle);
  syncToggles();
};
syncToggles();

// activeTile: on mobile only, the id of the tile currently shown (remembered across visits).
// `(() => { ... })()` defines an anonymous function and calls it immediately, a
// way to run several statements in a place where only an expression is allowed.
let activeTile = (() => { try { return localStorage.getItem("mTile"); } catch (_) { return null; } })();

// ---------------------------------------------------------- state helpers
// Tiny queries over S, plus normalize() which upgrades old saved data.

// allSounds(): every sound on every tile as one flat array.
// flatMap maps each tile to its sounds array and then concatenates all those arrays.
const allSounds = () => S.tiles.flatMap(t => t.sounds);

// locate(id): find a sound by id. Returns { tile, snd, i } (the owning tile, the
// sound object itself, and its index within tile.sounds), or null if it does not exist.
// `{ tile, snd: ..., i }` is object-literal shorthand: `tile` means `tile: tile`.
function locate(id) {
  for (const tile of S.tiles) {   // for...of walks the values of an array
    const i = tile.sounds.findIndex(s => s.id === id);   // index of the first match, or -1
    if (i >= 0) return { tile, snd: tile.sounds[i], i };
  }
  return null;
}

// byId(id): the sound object with that id, or undefined if id is empty/unknown.
// `?.` is optional chaining: if locate() returned null, the whole expression
// becomes undefined instead of crashing on null.snd.
const byId = id => (id ? locate(id)?.snd : undefined);

// prevOf(snd): some sound whose output points at snd (first one found), or undefined. (find = first match)
const prevOf = snd => allSounds().find(s => s.next === snd.id);

// stopSecs(tile): how many seconds a manual stop should fade out on this tile.
// If fading is on: tile.fade.secs (default 1). If fading is off: a very short 0.05 s fade
// that just avoids an audible click.
//   `x ?? y` ("nullish coalescing") means y only when x is null/undefined (unlike `||`, a 0 survives).
const stopSecs = tile => ((tile.fade?.on ?? true) ? tile.fade?.secs ?? 1 : 0.05);

// linkSecs(tile): crossfade length (seconds) when a chain advances to the next sound.
const linkSecs = tile => tile.linkFade ?? 2;

// normalize(): bring freshly loaded state up to the current format.
// Older saves had only a flat list of tiles (some "pinned"); this invents
// sections for them, and fills in default values for any per-tile setting that
// older saves lack. Safe to call repeatedly. Mutates S in place.
// Older saves are flat tiles; add sections and per-tile defaults.
function normalize() {
  S.tiles ||= [];   // `a ||= b` means: if a is empty/falsy, assign b
  if (!Array.isArray(S.sections) || !S.sections.length) {
    const pinned = S.tiles.some(t => t.pinned);   // some = true if any element passes the test
    S.sections = pinned
      ? [{ id: "persistent", name: "Persistent" }, { id: "encounters", name: "Encounters" }]
      : [{ id: "all", name: "Soundboard" }];
    // Assign every tile to a section: pinned ones to "persistent", the rest to
    // "encounters" (or "all" when nothing was pinned). The extra parentheses
    // make the arrow function return the assignment's value.
    S.tiles.forEach(t => (t.section = t.pinned ? "persistent" : pinned ? "encounters" : "all"));
  }
  S.tiles.forEach(t => {
    // A tile pointing at a section that no longer exists is moved to the first section.
    if (!S.sections.some(s => s.id === t.section)) t.section = S.sections[0].id;
    t.volume ??= 1;                          // `a ??= b`: assign b only if a is null/undefined
    t.fade ||= { on: true, secs: 1 };
    t.linkFade ??= 2;
    t.subs ||= [];
    t.w ||= 400;                             // width on the canvas (px); height follows the content
  });
  // Tiles from older saves have no canvas position yet: lay them out in a spiral around the middle.
  Canvas.layoutMissing(S.tiles, S.sections);
  // Sounds from older saves have no position of their own (they sat in a grid inside their tile): put them
  // in a tidy grid where their tile used to be, loose ones first, then each subsection's, so nothing moves
  // much and the frames simply appear around them. A sound that already has x, y is never touched.
  S.tiles.forEach(t => {
    if (!t.sounds.some(s => !Number.isFinite(s.x) || !Number.isFinite(s.y))) return;
    const subIds = new Set(t.subs.map(x => x.id));
    const groups = [t.sounds.filter(s => !s.group || !subIds.has(s.group)), ...t.subs.map(x => t.sounds.filter(s => s.group === x.id))];
    Canvas.arrangeInGrid(t, groups, Canvas.CARD_W, 175);   // 175 = room for a card whose name wraps to three lines
  });
}

// ------------------------------------------------------------- persistence
// Saving the state to the Flask server.

// saveTimer holds the id of the pending timer so a new save() can cancel it (debouncing).
let saveTimer = null;

// save(): schedule an upload of the whole state S to the server.
// Why a timer? The volume sliders call save() dozens of times per second while
// dragged. Each call cancels the previous timer and starts a new 300 ms one, so
// only the last call in a burst actually sends a request. The "saving…/saved"
// label next to the button shows the progress.
// Side effects: network request; updates the #saveState label. Does NOT re-render.
function save() {
  $("#saveState").textContent = "saving…";
  clearTimeout(saveTimer);
  // setTimeout(fn, ms): ask the browser to call fn once after ms milliseconds, without blocking.
  saveTimer = setTimeout(async () => {
    try { await api("/api/state", "PUT", S); $("#saveState").textContent = "saved"; }
    catch (e) { $("#saveState").textContent = "SAVE FAILED"; }
  }, 300);
}

// ------------------------------------------------------------------ audio
// The audio engine, built on the browser's "Web Audio API": a graph of audio
// nodes (sources, volume knobs, ...) that the browser mixes on its own audio
// thread. We build the graph; the browser pushes samples to the speakers.
//
//   [sound source] -> [per-sound gain] -> [tile bus gain] -> [master gain] -> speakers
//
// A GainNode is just a multiply-by-a-number node (a volume knob).

// Some older browsers expose the constructor under a "webkit" prefix.
const AC = window.AudioContext || window.webkitAudioContext;

// ctx: the audio context, i.e. the whole audio graph plus its clock (ctx.currentTime, in seconds).
// "interactive" asks for low output latency so button presses feel instant.
const ctx = new AC({ latencyHint: "interactive" });

// master: the final volume knob; everything is routed through it to the speakers (ctx.destination).
const master = ctx.createGain();
master.connect(ctx.destination);
master.gain.value = +$("#master").value;   // unary + converts the slider's text value to a number
// oninput fires continuously while a slider is dragged. `e.target` is the element that fired the event.
$("#master").oninput = e => (master.gain.value = +e.target.value);

// one volume bus per tile
// buses: Map from tile id -> that tile's GainNode.
const buses = new Map();

// busFor(tile): get (creating on first use) the tile's volume bus and make sure
// its gain matches tile.volume. Sounds on the tile connect to this node, which
// feeds master. Called whenever a sound starts and whenever the tile slider moves.
function busFor(tile) {
  let b = buses.get(tile.id);
  if (!b) {
    b = ctx.createGain();
    b.connect(master);
    buses.set(tile.id, b);
  }
  b.gain.value = tile.volume ?? 1;
  return b;
}

// Browsers refuse to make sound until the user has interacted with the page
// (autoplay policy). The context starts "suspended"; we show a banner telling
// the user to click, and resume the context on the first click or key press.
const banner = $("#audioBanner");
// ctx.resume() returns a Promise; .then(fn) runs fn when it completes. Here: hide the banner.
const unlock = () => ctx.resume().then(() => (banner.style.display = "none"));
if (ctx.state !== "running") banner.style.display = "block";
// addEventListener (with no element in front) attaches to the window itself.
// pointerdown = mouse press / touch / pen, all in one event type.
addEventListener("pointerdown", unlock);
addEventListener("keydown", unlock);

// engines: sound.id -> { url, status, error, buffer?, audio?, gain?, sources:Set, playing, resumeAt }
//   url      the URL this engine was built for (to notice when the user edits it)
//   status   "loading" | "ready" | "error"
//   buffer   decoded PCM audio held in memory (short clips)   -- OR --
//   audio    an <audio> element that streams from the server (long files), with `gain` as its volume node
//   sources  Set of currently sounding BufferSource nodes (a Set is a collection with no duplicates)
//   playing  true while something is audibly playing for this sound
//   resumeAt seconds into the file where a stopped sound will resume (null = start fresh)
//   advTimer / endTimer  timers that trigger the chain's next sound (see startBuffer / startStream)
//   repeatAt Date.now() time (ms) at which a waiting repeat timer will play the sound again (0 = none pending)
// This is runtime-only state; it is never saved (it is rebuilt by loadAll() after every page load).
const engines = new Map();

// loadSound(snd): make the sound ready to play. Idempotent: if an engine for
// this URL already exists it is returned immediately.
//   1. Ask the server to fetch/convert the media (POST /api/media -> a job "key").
//   2. Poll (GET /api/media/<key>) every 1.2 s until the server says ready or error.
//   3. Either build a streaming <audio> element, or download and decode the
//      whole file into memory.
// Returns a Promise of the engine object `e` (always resolves; failures are
// recorded in e.status / e.error instead of throwing).
// Side effects: creates engines entry; may set snd.name (and call save()) when
// the name was auto-filled from the media title; calls render() so cards show
// "loading…" / "failed" / ready.
async function loadSound(snd) {
  let e = engines.get(snd.id);
  if (e && e.url === snd.url) return e;
  e = { url: snd.url, status: "loading", sources: new Set(), playing: false };
  engines.set(snd.id, e);
  render();
  try {
    // `const { key } = obj` is destructuring: pull the field named `key` out of the reply object.
    const { key } = await api("/api/media", "POST", { url: snd.url });
    let info;
    for (;;) {   // `for (;;)` is an infinite loop (like while(1)); we break out when done
      info = await api("/api/media/" + key);
      if (info.status === "ready") break;
      if (info.status === "error") throw new Error(info.error);
      // A sleep: new Promise(resolver => ...) makes a future that completes when we call the
      // `r` function; here setTimeout calls r after 1.2 s. `await` pauses only this function.
      await new Promise(r => setTimeout(r, 1200));
    }
    if (snd.autoName && info.title) {
      snd.name = info.title;       // fill in the display name from the media's own title
      delete snd.autoName;         // `delete` removes a field from an object
      save();
    }
    // Long files are streamed, not decoded (an hour of audio needs >1 GB of RAM); short ones are decoded
    // so playback is instant.
    const stream = snd.type === "music" || (info.duration || 0) > 120 || info.size > 6e6;
    if (stream) {
      // Streaming path: a normal <audio> element, wired INTO the Web Audio graph so that
      // volume and fades still work. Its gain starts at 0 (silent) until playback starts.
      const a = new Audio(info.src);
      a.preload = "auto";
      a.crossOrigin = "anonymous";   // required, or Web Audio would refuse to read the stream's samples
      const g = ctx.createGain();
      g.gain.value = 0;
      ctx.createMediaElementSource(a).connect(g);   // audio element -> gain node
      // onended: callback the browser invokes when the file plays to the end.
      // It is a closure: it keeps using `e` and `snd` from this call of loadSound.
      a.onended = () => {
        const was = e.playing;
        e.playing = false;
        e.resumeAt = null;
        clearInterval(e.endTimer);
        // If it was playing and has a chain link (and is not looping), move on to the next sound;
        // otherwise, if it has a repeat delay, start that wait (see scheduleRepeat).
        if (was && snd.next && !snd.loop) advance(snd, "auto");
        else if (was) scheduleRepeat(snd, e);
        render();
      };
      // onerror: the browser calls this if the file cannot be loaded or played (for example it was
      // deleted from the MP3 folder while the page was open). Record it as a normal error so the
      // card shows "failed" instead of silently never playing.
      a.onerror = () => {
        e.status = "error";
        e.error = "The audio file could not be loaded or played. Was it moved or deleted?";
        e.playing = false;
        render();
      };
      a.load();
      e.audio = a;
      e.gain = g;
    } else {
      // Buffered path: download the whole file, then decode it to raw samples in RAM.
      // Three steps: fetch() the file, check the server really sent it, then read its bytes.
      const resp = await fetch(info.src);   // fetch() does not throw on a 404; check resp.ok ourselves
      if (!resp.ok) throw new Error(`The audio file could not be loaded (HTTP ${resp.status}). Was it moved or deleted?`);
      const buf = await resp.arrayBuffer();   // the raw bytes of the file
      e.buffer = await ctx.decodeAudioData(buf);
    }
    e.status = "ready";
  } catch (err) {
    e.status = "error";
    e.error = err.message;
  }
  render();
  return e;
}

// startOf(snd): trim start in seconds (0 if unset or not a number). Unary + converts to a number.
const startOf = snd => +snd.start || 0;

// endOf(snd, e): trim end in seconds. If the user gave a valid end after the start, use it;
// otherwise play to the end of the decoded buffer. (Only valid for buffered sounds, which have e.buffer.)
const endOf = (snd, e) => (+snd.end > startOf(snd) ? +snd.end : e.buffer.duration);

// fade(g, to, secs): smoothly move a GainNode's volume from where it is now to `to` over `secs`.
// Web Audio schedules parameter changes on the audio clock, so the ramp is
// glitch-free and runs without our code. We first cancel any ramp still
// scheduled, pin the current value as the start, then ramp linearly.
function fade(g, to, secs) {
  const t = ctx.currentTime;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(g.gain.value, t);
  g.gain.linearRampToValueAtTime(to, t + secs);
}

// startBuffer(snd, e, tile, from, fadeIn): play a decoded (in-memory) sound.
//   from   - position in the file (seconds) to start at
//   fadeIn - seconds of fade-in (0 = start at full volume immediately)
// A BufferSource node plays a buffer ONCE and cannot be restarted, so every
// play creates a fresh one (cheap). Graph built here: src -> g -> tile bus.
// Also arms a timer that starts the chain's next sound early so the two overlap.
// Side effects: adds to e.sources, sets e.playing, calls render().
function startBuffer(snd, e, tile, from, fadeIn) {
  const src = ctx.createBufferSource();
  src.buffer = e.buffer;
  // `const a = 1, b = 2` declares several constants in one statement.
  const g = ctx.createGain(),
    vol = snd.volume ?? 1,
    now = ctx.currentTime;
  g.gain.setValueAtTime(fadeIn > 0 ? 0 : vol, now);
  if (fadeIn > 0) g.gain.linearRampToValueAtTime(vol, now + fadeIn);
  src.connect(g);
  g.connect(busFor(tile));
  const start = startOf(snd),
    end = endOf(snd, e);
  // Invalid or out-of-range resume point -> fall back to the trim start.
  if (from >= end - 0.05 || from < start) from = start;
  if (snd.loop) {
    // Looping: the browser itself wraps playback between loopStart and loopEnd.
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = end;
    src.start(0, from);   // start(when=now, offset into buffer)
  }
  else src.start(0, from, end - from);   // start(when, offset, duration): play just that slice
  // A custom end time would cut the sound off abruptly, so follow the tile's fade-out setting:
  // hold full volume, then ramp down so the sound reaches silence exactly at the end time.
  // Not done for loops, chained sounds (they crossfade instead), or when the sound simply
  // plays to the natural end of the file.
  if (!snd.loop && !snd.next && +snd.end > start) {
    const fadeLen = Math.min(stopSecs(tile), end - from),   // never longer than the time that is left
      endAt = now + (end - from);                            // audio-clock time the slice finishes
    if (fadeLen > 0.1) {   // "fade off" means a tiny 0.05 s value; not worth scheduling
      g.gain.setValueAtTime(vol, endAt - fadeLen);   // stay at full volume until the fade begins
      g.gain.linearRampToValueAtTime(0, endAt);
    }
  }
  // JavaScript lets us hang our own fields on any object; we stash bookkeeping on the node itself.
  src.t0 = now;             // ctx time when playback began (used to compute position on stop)
  src.from = from;          // file position it began at
  src.manual = false;       // becomes true if WE stopped it (vs. it finishing naturally)
  src.g = g;                // its private volume node, for fades
  e.sources.add(src);
  // Callback fired by the browser when this source stops (naturally or via stop()).
  // If it finished by itself (not stopped by us), a repeat timer may now start counting down.
  src.onended = () => {
    e.sources.delete(src);
    if (!src.manual) e.resumeAt = null; // finished naturally: next press starts fresh
    e.playing = e.sources.size > 0;
    if (!src.manual && !e.playing) scheduleRepeat(snd, e);
    render();
  };
  clearTimeout(e.advTimer);
  // Crossfade timing: instead of waiting for this sound to END, start the next link
  // `linkSecs` before the end, so the next sound fades in while this one fades out.
  // (Note: the `if` below has no braces; its body is the single statement that follows.)
  if (snd.next && !snd.loop) // start the next link early so the two crossfade
    e.advTimer = setTimeout(
      () => advance(snd, "auto"),
      Math.max(0, end - from - linkSecs(tile)) * 1000   // delay in milliseconds, never negative
    );
  e.playing = true;
  render();
}

// startStream(snd, e, tile, from, fadeIn): play a streamed (<audio> element) sound.
// Same job as startBuffer, but the <audio> element can be seeked and looped by
// the browser, and there is no "ended" callback until the file's real end, so a
// 100 ms polling timer (endTimer) watches the playback position to implement
// custom end points, looping within a trimmed range, and early crossfades.
// Graph: audio element -> e.gain -> tile bus (the gain node is re-attached each play).
function startStream(snd, e, tile, from, fadeIn) {
  const a = e.audio,
    start = startOf(snd);
  a.loop = !!snd.loop;   // `!!x` forces any value to a true/false boolean
  try { a.currentTime = from; } catch (_) {}   // seeking can throw if not ready; ignore it
  e.gain.disconnect();                         // detach from any previous tile bus
  e.gain.connect(busFor(tile));
  fade(e.gain, snd.volume ?? 1, fadeIn ?? 0.8);
  // play() returns a Promise that may be rejected (e.g. blocked by autoplay policy); log instead of crashing.
  a.play().catch(err => console.error("play failed", err));
  e.playing = true;
  render();
  clearInterval(e.endTimer);
  // setInterval(fn, ms): call fn repeatedly every ms until clearInterval is called.
  e.endTimer = setInterval(() => {
    const hasEnd = +snd.end > start,
      end = hasEnd ? +snd.end : a.duration || 1e9;   // 1e9 = "effectively never" when the length is unknown
    if (snd.loop) {
      // The browser can only loop a whole file; a trimmed loop is done by jumping back manually.
      if (hasEnd && a.currentTime >= snd.end) a.currentTime = start;
      return;
    }
    if (snd.next) {
      // Reached the crossfade point: hand over to the next sound.
      if (a.currentTime >= end - linkSecs(tile)) {
        clearInterval(e.endTimer);
        advance(snd, "auto");
      }
    }
    else if (hasEnd && a.currentTime >= snd.end - stopSecs(tile)) {
      // Custom end point approaching: stopSound fades out over the tile's fade length, so start it
      // that much early and the sound reaches silence at the end time instead of after it.
      stopSound(snd, false, { reset: true });
      scheduleRepeat(snd, e);                   // stopSound cancels repeats, so arm the timer afterwards
    }
  }, 100);
}

// lastStarted: id of the sound most recently started. currentSound() uses it to decide what the
// arrow keys / chain buttons act on.
let lastStarted = null;

// startSound(snd, options): begin playing a sound from the beginning or from a position.
// Always (re)starts the sound. from=null -> its start time.
//   options is destructured right in the parameter list: `{ from = null, fadeIn } = {}` means
//   "take fields from/fadeIn out of the 2nd argument; from defaults to null; the whole argument
//   defaults to an empty object so the caller may omit it".
//   from   - file position in seconds, or null for the trim start
//   fadeIn - fade-in seconds (undefined = engine's default)
//   background - true when a repeat timer (not the user) started it; the sound then does NOT become
//                `lastStarted`, so a bell ringing in the background never steals the arrow keys
//                or the highlighted chain from whatever you are actually playing
// Does nothing if the sound is not loaded yet or has been deleted. Dispatches to the
// stream or buffer player depending on how loadSound() prepared it.
function startSound(snd, { from = null, fadeIn, background = false } = {}) {
  const e = engines.get(snd.id),
    loc = locate(snd.id);
  if (!e || e.status !== "ready" || !loc) return;
  if (!background) lastStarted = snd.id;
  e.startedAt = performance.now();   // when it began (used to pick the newest playing sound of a chain, see activeChains)
  const f = from ?? startOf(snd);
  if (e.audio) startStream(snd, e, loc.tile, f, fadeIn);
  else startBuffer(snd, e, loc.tile, f, fadeIn ?? 0);
}

// stopSound(snd, fast, options): stop a sound, usually with a fade-out, and remember where it
// stopped so a later press can resume.
//   fast           - true = near-instant stop (50 ms)
//   options.secs   - explicit fade length (overrides the tile's setting)
//   options.reset  - true = forget the resume position (next start is from the beginning)
// Gotcha: the stream is paused only AFTER the fade has finished (timer), and only
// if nothing restarted it in the meantime.
// Also cancels a pending repeat timer, even when the sound is silent right now and only
// waiting for its next repeat (so "Stop all" and tile stop buttons disarm waiting timers too).
// Side effects: clears timers, sets e.playing = false, e.resumeAt, calls render().
function stopSound(snd, fast = false, { secs, reset = false } = {}) {
  cancelRepeat(snd);   // any manual stop ends the repeating, whether or not it is playing right now
  const e = engines.get(snd.id),
    loc = locate(snd.id);
  if (!e || !e.playing) return;
  secs ??= fast || !loc ? 0.05 : stopSecs(loc.tile);   // only fill in secs if the caller did not pass one
  clearTimeout(e.advTimer);
  clearInterval(e.endTimer);
  if (e.audio) {
    // Remember the position (null if it was within 0.5 s of the end, or reset requested).
    e.resumeAt = reset || e.audio.currentTime >= e.audio.duration - 0.5 ? null : e.audio.currentTime;
    fade(e.gain, 0, secs);
    const a = e.audio;
    setTimeout(() => { if (!e.playing) a.pause(); }, secs * 1000 + 50);
  }
  e.sources.forEach(s => {
    const start = startOf(snd),
      end = endOf(snd, e);
    // Current position = where it began + elapsed audio-clock time.
    let p = s.from + (ctx.currentTime - s.t0);
    if (s.loop) p = start + ((p - start) % (end - start));   // % is remainder: wrap into the loop range
    e.resumeAt = reset || p >= end - 0.05 ? null : p;
    s.manual = true;   // so onended knows we stopped it and keeps resumeAt
    try {
      if (secs > 0.1) {
        fade(s.g, 0, secs);
        s.stop(ctx.currentTime + secs + 0.02);   // schedule the hard stop just after the fade ends
      }
      else s.stop();
    } catch (_) {}   // stop() throws if the node already ended; harmless
  });
  e.sources.clear();
  e.playing = false;
  render();
}

// applyVolume(snd): apply snd.volume to whatever is playing right now (called while the
// per-sound slider is dragged). Cancels any fade in progress and sets the level immediately.
function applyVolume(snd) {
  const e = engines.get(snd.id),
    v = snd.volume ?? 1;
  if (!e) return;
  const t = ctx.currentTime;
  if (e.audio && e.playing) {
    e.gain.gain.cancelScheduledValues(t);
    e.gain.gain.setValueAtTime(v, t);
  }
  e.sources.forEach(x => {
    x.g.gain.cancelScheduledValues(t);
    x.g.gain.setValueAtTime(v, t);
  });
}

// ---- repeat timers ("a bell tolls every 10 minutes", "a crash every 30 minutes")
// A sound with a repeat delay (snd.repeatDelay, in seconds) plays when you press it. Once it has
// finished BY ITSELF it waits that many seconds and plays again, over and over, until you stop it.
//   - Pressing it again, while it plays OR while it waits for the next repeat, cancels the timer.
//     ("Stop all" and the tile stop buttons cancel it too.)
//   - The wait is stored as a deadline (engines entry .repeatAt = a Date.now() time in milliseconds,
//     0 = nothing pending). A deadline stays correct even if the browser runs our code late.
//   - A sound that loops, or that has a chain link (`next`), never repeats: a loop never ends, and a
//     chained sound hands over to the next link instead.
//   - Timers exist only in this browser tab. They are not saved, so reloading the page clears them.

// scheduleRepeat(snd, e): called when `snd` has just finished playing on its own. If it has a repeat
// delay, record the deadline for its next play and redraw so the card shows the countdown.
function scheduleRepeat(snd, e) {
  const delay = +snd.repeatDelay;   // unary + converts to a number; a missing field becomes NaN
  if (!(delay > 0) || snd.loop || snd.next) return;   // NaN > 0 is false, so "no delay" also returns here
  e.repeatAt = Date.now() + delay * 1000;             // seconds -> milliseconds
  render();
}

// cancelRepeat(snd): forget any pending repeat for `snd` (does nothing if none is pending).
function cancelRepeat(snd) {
  const e = engines.get(snd.id);
  if (e && e.repeatAt) {
    e.repeatAt = 0;
    render();
  }
}

// repeatLabel(e): the text shown on a waiting card, e.g. "⏱ next in 9:41".
function repeatLabel(e) {
  const total = Math.max(0, Math.ceil((e.repeatAt - Date.now()) / 1000)),   // whole seconds left
    h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    pad = n => String(n).padStart(2, "0");   // 5 -> "05"
  return "⏱ next in " + (h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`);
}

// repeatTick(): runs once a second (see startRepeatClock). For every sound waiting on a repeat:
// if its deadline has passed, play it again; otherwise just refresh its countdown text in place
// (changing one label is much cheaper than rebuilding the whole page with render()).
function repeatTick() {
  const now = Date.now();
  // Looping over a Map gives [key, value] pairs; `[id, e]` unpacks each pair into two variables.
  for (const [id, e] of engines) {
    if (!e.repeatAt) continue;
    const snd = byId(id);
    if (!snd || e.status !== "ready") {   // the sound was deleted or its audio was replaced: drop the timer
      e.repeatAt = 0;
      continue;
    }
    if (now >= e.repeatAt) {
      e.repeatAt = 0;
      startSound(snd, { background: true });   // startSound redraws, which clears the countdown label
    } else {
      const label = document.querySelector(`.snd[data-id="${id}"] .tp`);
      if (label) label.textContent = repeatLabel(e);
    }
  }
}

// startRepeatClock(): start the once-a-second heartbeat that drives repeatTick().
// Browsers throttle ordinary timers in background tabs (sometimes to about once a minute), which
// would make a "bell every 10 minutes" drift. A Web Worker is a separate thread with its own
// timers that are throttled far less, so a tiny worker sends us a "tick" message every second.
// If workers are unavailable we fall back to an ordinary setInterval.
function startRepeatClock() {
  try {
    const program = "setInterval(() => postMessage(0), 1000);";   // the worker's whole program, as text
    // A Blob is an in-memory file; createObjectURL gives it a temporary URL the Worker can load from.
    const worker = new Worker(URL.createObjectURL(new Blob([program], { type: "text/javascript" })));
    worker.onmessage = repeatTick;   // called for every message the worker posts
  } catch (_) {
    setInterval(repeatTick, 1000);
  }
}

// ---- chain navigation. A sound can have many inputs but one output (snd.next).
// Chain links are stored only as `next` on the source sound. "Inputs" of a
// sound are found by searching all sounds for those whose `next` is this one.
// sound id -> the input it was most recently entered from (or chosen with up/down). "Left" always follows this, so
// a loop (2 > 3 > 2 ...) is walked backwards forever; only entering a sound a new way, or up/down, changes it.
const cameFrom = new Map();

// predsOf(snd): the sounds that feed into snd ("predecessors"), oldest link first. Sorting by
// nextAt (a Date.now() millisecond timestamp stamped when each link was made) gives a stable
// order that matches the input squares drawn on the card, top to bottom, because new links
// are appended last. sort() takes a comparison function returning negative/zero/positive, as in C's qsort.
const predsOf = snd => allSounds().filter(x => x.next === snd.id).sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0)); // same order as the input squares, top to bottom

// backPred(s): which predecessor "back" (left arrow) should go to: the remembered cameFrom
// choice if it is still valid, otherwise the first input. null if s has no inputs.
function backPred(s) {
  const preds = predsOf(s);
  if (!preds.length) return null;
  const c = cameFrom.get(s.id);
  return preds.find(p => p.id === c) || preds[0];
}

// clearPathMemory(snd): forget the remembered "came from" choices of the chain that `snd` belongs to
// (used when you start a sound by hand: its chain begins a fresh path). Other chains keep theirs, so
// pressing a sound in one chain no longer resets the path memory of another chain playing at the same time.
function clearPathMemory(snd) {
  const info = chainInfo(null),
    comp = info.get(snd.id)?.comp;
  if (comp === undefined) return;   // not in a chain: nothing to forget
  for (const id of [...cameFrom.keys()]) if (info.get(id)?.comp === comp) cameFrom.delete(id);
}

// setFocus(snd): put `snd`'s chain in focus WITHOUT starting or stopping anything. Focus is simply "the
// last started sound" (lastStarted), so this just points it at a sound that is already playing.
// Everything that follows the focus (arrow keys, chain buttons, path highlight, the dimming of other
// chains) updates on the redraw.
function setFocus(snd) {
  if (!engines.get(snd.id)?.playing) return;
  lastStarted = snd.id;
  render();
}

// activeChains(info): one entry per chain that currently has a sound playing: { comp, snd } where snd is
// the NEWEST playing sound of that chain (a chain can briefly have two while crossfading). Sorted by chain
// id so the "now playing" dock keeps a stable order. Chains of one sound are not chains; unlinked sounds are ignored.
function activeChains(info) {
  const best = new Map();
  allSounds().forEach(x => {
    const e = engines.get(x.id),
      ci = info.get(x.id);
    if (!e?.playing || !ci) return;
    const cur = best.get(ci.comp);
    if (!cur || e.startedAt > engines.get(cur.id).startedAt) best.set(ci.comp, x);
  });
  return [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([comp, snd]) => ({ comp, snd }));
}

// cycleFocus(dir): move the focus to the next (dir = 1) or previous (dir = -1) active chain. Bound to the
// [ and ] keys. Does nothing unless at least two chains are playing.
function cycleFocus(dir) {
  const chains = activeChains(chainInfo(null)),
    cur = currentSound(),
    ci = cur && chainInfo(null).get(cur.id);
  if (chains.length < 2) return;
  const i = chains.findIndex(c => c.comp === ci?.comp);
  setFocus(chains[(i + dir + chains.length) % chains.length].snd);
}

// drawDock(info): the "now playing" dock, a small bar at the bottom of the page that appears only while
// TWO OR MORE chains are playing. One chip per active chain shows its colour, the name of the sound
// playing in it and a stop button. The chip of the chain in focus is outlined. Clicking a chip moves the
// focus there (and pans the canvas to it if it is off screen) without touching the audio; the ■ on a chip
// stops that sound (with the tile's fade) without changing the focus. This is the quick, explicit way back
// to a chain that is playing in the background; a click on a playing sound itself still just stops it.
function drawDock(info) {
  const dock = $("#nowplaying");
  if (!dock) return;
  const chains = activeChains(info),
    cur = currentSound(),
    focusComp = cur && info.get(cur.id)?.comp;
  dock.textContent = "";
  dock.hidden = chains.length < 2;
  if (dock.hidden) return;
  dock.append(el("span", { className: "dockhint", textContent: "Chains playing", title: "Click a chip to focus that chain. [ and ] cycle through them." }));
  chains.forEach(({ comp, snd }) => {
    const ci = info.get(snd.id),
      chip = el("div", { className: "dockchip" + (comp === focusComp ? " focused" : ""), role: "button", tabIndex: 0,
        title: comp === focusComp ? "In focus: the arrow keys and chain buttons control this chain" : "Click to focus this chain" });
    setTint(chip, ci.hue);   // sets --h / --s so the dot takes the chain's colour (neutral grey for shared parts)
    chip.append(
      el("span", { className: "dockdot" }),
      el("span", { className: "dockname", textContent: snd.name }),
      el("button", { className: "tiny dockstop", textContent: "■", title: "Stop this sound (the focus stays where it is)",
        onclick: ev => { ev.stopPropagation(); stopSound(snd); } }));
    const focus = () => {
      setFocus(snd);
      // If the sound's card is off screen, pan the canvas to it (zoom unchanged).
      const card = document.querySelector(`.snd[data-id="${snd.id}"]`);
      if (card && !MOBILE) {
        const p = Canvas.posIn(card),
          v = Canvas.view,
          st = $("#stage"),
          sx = v.x + (p.x + card.offsetWidth / 2) * v.k,
          sy = v.y + (p.y + card.offsetHeight / 2) * v.k;
        if (sx < 0 || sy < 0 || sx > st.clientWidth || sy > st.clientHeight) Canvas.centerOn(p.x + card.offsetWidth / 2, p.y + card.offsetHeight / 2);
      }
    };
    chip.addEventListener("click", focus);
    chip.addEventListener("keydown", ev => { if (ev.key === "Enter" && ev.target === chip) focus(); });
    dock.append(chip);
  });
}

// currentSound(): the sound that is "in focus": what the arrow keys, the chain buttons and the chain
// highlight act on. It is the last started (or last focused, see setFocus) sound while that is still
// playing. If it has stopped, focus falls back to the newest playing sound that belongs to a chain, so
// another active chain takes over instead of the controls going dead. null if no chain is playing.
function currentSound() {
  const s = byId(lastStarted);
  if (s && engines.get(s.id)?.playing) return s;
  let best = null;
  allSounds().forEach(x => {
    const e = engines.get(x.id);
    if (e?.playing && (x.next || predsOf(x).length) && (!best || e.startedAt > engines.get(best.id).startedAt)) best = x;
  });
  return best;
}

// activePath(): the chain "through" the current sound, as a description for highlighting.
// Walks backwards (via backPred) to the chain's start, then forwards (via next) to its end,
// stopping if it would revisit a sound (loops).
// Returns { nodes:Set of sound ids, edges:Set of "fromId>toId", cur, base } or null if there is
// no current sound or it is not chained to anything. `base` = the first sound on the path.
function activePath() {
  const cur = currentSound();
  if (!cur || (!cur.next && !predsOf(cur).length)) return null; // unchained sounds don't select a chain
  const nodes = new Set([cur.id]),
    edges = new Set();
  let base = cur;
  // Walk back. A `for` with an empty condition runs until an explicit break.
  for (let s = cur; ;) {
    const p = backPred(s);
    if (!p || nodes.has(p.id)) break;
    nodes.add(p.id);
    edges.add(p.id + ">" + s.id);
    s = p;
    base = p;
  }
  // Walk forward along `next` links.
  for (let s = cur; ;) {
    const n = byId(s.next);
    if (!n || nodes.has(n.id)) break;
    nodes.add(n.id);
    edges.add(s.id + ">" + n.id);
    s = n;
  }
  return { nodes, edges, cur: cur.id, base: base.id };
}

// advance(snd, mode, target): crossfade from `snd` to another sound. Returns true if it moved.
//   mode "auto"/"next" -> follow snd.next;  mode "prev" -> go back to backPred(snd);
//   target (optional)  -> go to this exact sound instead.
// snd fades out over the tile's link time while the new sound fades in over the same time.
// Side effects: updates cameFrom, stops/starts sounds (which call render()).
// Crossfade from snd to target (default: its next / chosen previous).
function advance(snd, mode = "auto", target = null) {
  const e = engines.get(snd.id),
    loc = locate(snd.id);
  if (e) clearTimeout(e.advTimer);
  const nxt = target || (mode === "prev" ? backPred(snd) : byId(snd.next));
  if (!nxt || !loc) return false;
  if (mode !== "prev") cameFrom.set(nxt.id, snd.id); // entering nxt from snd selects that path; going back never changes it
  const secs = linkSecs(loc.tile);
  stopSound(snd, false, { secs: Math.max(secs, 0.05), reset: true });
  const ne = engines.get(nxt.id);
  if (ne?.status === "ready") {
    if (ne.playing) stopSound(nxt, true, { reset: true });   // never stack two copies of the target
    // An automatic hand-over in a chain that is NOT in focus must not steal the focus from the chain
    // you are controlling, so it starts "in the background" (see startSound). A hand-over by the arrow
    // keys / buttons, or in the focused chain, moves the focus along to the new sound as before.
    startSound(nxt, { fadeIn: secs, background: mode === "auto" && lastStarted !== snd.id });
  }
  return true;
}

// chainStep(dir): "next" (dir > 0) or "back" (dir < 0) along the chain from the current sound.
// Bound to the right/left arrow keys and the Next/Prev buttons.
function chainStep(dir) {
  const cur = currentSound();
  if (!cur) return;
  if (dir > 0) { if (cur.next) advance(cur, "next"); }
  else if (backPred(cur)) advance(cur, "prev");
}

// pathStep(dir): up/down arrows. Where the path merges several inputs, pick a different
// input (dir = +1 next one, -1 previous one, wrapping around). It looks backwards from the
// current sound for the nearest sound that has more than one input, and changes cameFrom there.
// Only re-renders (to move the highlight); does not change what is playing.
// up/down: pick a different input on the path (the nearest sound back along it that has several)
function pathStep(dir) {
  const cur = currentSound();
  if (!cur) return;
  const seen = new Set();   // guards against looping forever on cyclic chains
  for (let s = cur; s && !seen.has(s.id); s = backPred(s)) {
    seen.add(s.id);
    const preds = predsOf(s);
    if (preds.length > 1) {
      const i = preds.findIndex(p => p.id === backPred(s).id);
      // (i + dir + length) % length is a wrap-around index; adding length first keeps it non-negative.
      cameFrom.set(s.id, preds[(i + dir + preds.length) % preds.length].id);
      return render();
    }
  }
}
$("#nextBtn").onclick = () => chainStep(1);
$("#prevBtn").onclick = () => chainStep(-1);
$("#upBtn").onclick = () => pathStep(-1);
$("#downBtn").onclick = () => pathStep(1);

// lastPress: sound id -> time (ms, from performance.now()) of its last accepted press.
// A Map rather than a field on the sound because sounds are saved to the server: a timestamp
// stored there would persist, and after a reload (when performance.now() restarts near 0)
// it would look "recent" and silently block presses.
const lastPress = new Map(); // not stored on the sound: it would be saved and block presses after a reload

// trigger(snd): what happens when the user presses a sound (mouse, touch, Enter or its hotkey).
//   - ignores a second press within 150 ms (key auto-repeat or duplicate events);
//   - makes sure audio is unlocked and the sound is loaded;
//   - if it is waiting for a repeat timer: cancels the timer ("press to stop" on) or plays it now (off);
//   - if already playing: stops it ("press to stop" on) or restarts it (off);
//   - otherwise starts it, resuming where it stopped unless it is an "instant" sound or has
//     "restart" set. For "music" sounds, other music on the same tile is stopped first.
// `async`: it may have to wait for the audio context / loading, without blocking the page.
async function trigger(snd) {
  // guard against key auto-repeat / double events creating stacked or flip-flopping playback
  const now = performance.now();
  if (now - (lastPress.get(snd.id) || -1e9) < 150) return;
  lastPress.set(snd.id, now);
  if (ctx.state !== "running") await ctx.resume();
  const e = engines.get(snd.id) || await loadSound(snd);   // load on demand if not preloaded yet
  const loc = locate(snd.id);
  if (e.status !== "ready" || !loc) return;
  // Waiting for a repeat: pressing cancels the timer (or, with "press to stop" off, plays it right now).
  if (e.repeatAt) {
    if (stopToggle) return cancelRepeat(snd);
    e.repeatAt = 0;
  }
  if (e.playing) {
    if (stopToggle) return stopSound(snd); // press again = stop (remembers spot)
    stopSound(snd, true, { reset: true });   // toggle off: retrigger restarts, never stacks
    clearPathMemory(snd);
    return startSound(snd);
  }
  if (e.audio && snd.type === "music") // one soundtrack at a time per tile
    loc.tile.sounds.filter(o => o.id !== snd.id && o.type === "music").forEach(o => stopSound(o));
  // "fresh" = start from the beginning rather than resuming a stopped position.
  const fresh = snd.type === "instant" || snd.restart || e.resumeAt == null;
  clearPathMemory(snd);   // a manual press begins a new path selection (for this chain only)
  startSound(snd, { from: fresh ? null : e.resumeAt });
}

// The "Stop all" button: stop every sound with its normal fade.
$("#stopAll").onclick = () => allSounds().forEach(s => stopSound(s));

// ------------------------------------------------------------ chain visuals
// Colours and numbering for chained sounds, and the SVG "cables" drawn between them.

// chainInfo(path): compute, for every chained sound, how it should look.
// Returns a Map (sound id -> { hue, pos, cyc }) with an extra property `ins` attached to the
// Map object itself (JavaScript lets you add fields to any object): ins = Map of sound id ->
// array of the sounds feeding it.
//   hue  colour angle 0..360, or null for neutral grey
//   pos  position number shown in the badge (longest distance from a chain start)
//   cyc  true if the sound is part of a loop
// `path` is the result of activePath() (or null); it decides colours for merged chains.
// Pure computation: reads S, changes nothing.
// Each chain base (a sound with no inputs) gets its own colour. Sounds only one base reaches share that
// colour; sounds several bases merge into are neutral until a path is selected, then take the selected base's colour.
function chainInfo(path) {
  const all = allSounds(),
    map = new Map(all.map(s => [s.id, s]));   // id -> sound lookup table
  // nextOf(s): the id s links to, but only if that sound still exists.
  const nextOf = s => (s.next && map.has(s.next) ? s.next : null);
  // ins: id -> array of sounds that link into it. Start every id with an empty array...
  const ins = new Map(all.map(s => [s.id, []]));
  // ...then add each sound to the list of its target.
  all.forEach(s => {
    const n = nextOf(s);
    if (n) ins.get(n).push(s);
  });
  ins.forEach(list => list.sort((x, y) => (x.nextAt || 0) - (y.nextAt || 0))); // newest link last -> lowest square

  // Find sounds that sit on a loop: follow next-links from each sound; if we get back to
  // where we started, it is cyclic. The iteration cap (all.length) guarantees termination.
  const cyc = new Set();
  all.forEach(s => {
    let c = s.id;
    for (let i = 0; i <= all.length; i++) {
      c = nextOf(map.get(c));
      if (!c) break;
      if (c === s.id) {
        cyc.add(s.id);
        break;
      }
    }
  });

  // depth: the badge number. Start everything at 1 and repeatedly relax "target must be at
  // least source + 1" (like Bellman-Ford shortest paths, but for the longest path). Loop
  // members are skipped so the relaxation settles; at most all.length passes are needed.
  const depth = new Map(all.map(s => [s.id, 1]));
  for (let it = 0; it < all.length; it++) {
    let changed = false;
    all.forEach(s => {
      const n = nextOf(s);
      if (n && !cyc.has(n) && depth.get(n) < depth.get(s.id) + 1) {
        depth.set(n, depth.get(s.id) + 1);
        changed = true;
      }
    });
    if (!changed) break;
  }

  // members: sounds that take part in any chain (have an output or an input).
  const members = all.filter(s => nextOf(s) || ins.get(s.id).length);
  // Which connected chain does each sound belong to? A "union-find": every sound starts as its own group,
  // and each link merges the group of its source with the group of its target. find(id) returns a
  // representative id for the group (path compression keeps the lookups fast). Two sounds are in the same
  // chain exactly when find() gives the same answer; that id is stored as `comp` (used to group the playing
  // chains in the "chains playing" dock and to forget one chain's path memory without touching another's).
  const parent = new Map(all.map(s => [s.id, s.id]));
  const find = x => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  all.forEach(s => {
    const n = nextOf(s);
    if (n) parent.set(find(s.id), find(n));
  });
  // reach: id -> list of chain-base ids that can reach this sound by following links.
  const reach = new Map(members.map(s => [s.id, []]));
  // bases: chain starts = have an output but no input.
  const bases = members.filter(s => nextOf(s) && !ins.get(s.id).length);
  // walk(base): follow links from a base, recording it in `reach` of every sound visited
  // (stops on revisiting, so loops are safe).
  const walk = base => {
    const seen = new Set();
    for (let c = base; c && !seen.has(c.id); c = map.get(nextOf(c))) {
      seen.add(c.id);
      reach.get(c.id).push(base.id);
    }
  };
  bases.forEach(walk);
  // A pure loop has no base at all; pick the first unreached member of it as a pseudo-base.
  members.filter(s => !reach.get(s.id).length).forEach(s => {
    if (!reach.get(s.id).length) {
      bases.push(s);
      walk(s);
    }
  });
  // Colours: sort base ids so each base keeps a stable index; then step the hue by 137.508
  // degrees (the "golden angle"), which spreads colours far apart however many bases exist.
  const order = bases.map(b => b.id).sort();
  const baseHue = id => (25 + order.indexOf(id) * 137.508) % 360;

  const info = new Map();
  members.forEach(s => {
    const R = reach.get(s.id);
    let hue = null;                                   // null = neutral (shared, nothing selected)
    if (R.length === 1) hue = baseHue(R[0]);
    else if (path && path.nodes.has(s.id) && R.includes(path.base)) hue = baseHue(path.base);
    info.set(s.id, { hue, pos: depth.get(s.id), cyc: cyc.has(s.id), comp: find(s.id) });   // comp = which connected chain it belongs to
  });
  info.ins = ins;
  return info;
}

// tint(hue, light): a CSS colour string for a hue (null = grey). Backtick strings are
// "template literals": ${...} inserts the value of an expression into the text.
// hsl(hue saturation% lightness%) is a CSS colour notation.
// CSS variables / colours for a (possibly neutral) hue
const tint = (hue, light = 62) => (hue == null ? `hsl(250 0% ${light + 8}%)` : `hsl(${hue} 80% ${light}%)`);

// setTint(node, hue): store the hue on a DOM element as CSS custom properties (--h, --s) that
// the stylesheet (CSS file) uses to colour the card. null hue -> zero saturation (grey).
function setTint(node, hue) {
  node.style.setProperty("--h", hue ?? 250);
  if (hue == null) node.style.setProperty("--s", "0%");
  else node.style.removeProperty("--s");
}

// cleanLinks(): remove chain links that point at sounds that no longer exist (e.g. after
// deleting a sound or tile). Mutates S; the caller decides whether to save().
function cleanLinks() {
  allSounds().forEach(s => {
    if (s.next && !byId(s.next)) {
      delete s.next;
      delete s.nextAt;
    }
  });
}

// The cable geometry (SVGNS, bezier, routed, roundPoly, routeCables) lives in cables.js, shared with
// the campaign tracker. These constants just give the shared functions their old local names.
const { SVGNS, bezier, routed, roundPoly, routeCables } = Cables;

// drawLinks(): (re)draw all cables on the SVG overlay. Called after every render (via
// requestAnimationFrame) and on window resize. Desktop only (phones show no cables).
// Steps: measure where each card/port is on the page, build a `links` list, ask routeCables()
// for paths (falling back to simple curves on failure), then create one SVG <path> per link.
// Coordinates are WORLD coordinates (see canvas.js): every position is measured with Canvas.posIn,
// which is independent of pan and zoom. The SVG overlay sits inside the same #world element as the
// tiles, so when you pan or zoom the cables move with the tiles and need no redrawing; they are only
// redrawn when a tile moves, resizes or changes.
function drawLinks() {
  const layer = $("#linkLayer");
  if (MOBILE) return;
  const W = Canvas.WORLD,
    H = Canvas.WORLD;
  layer.textContent = "";   // empties the layer (removes all old cables)
  const path = activePath(),
    info = chainInfo(path);
  // Rectangles of all visible sound cards. `n.offsetParent` is null for hidden elements (e.g. in a
  // collapsed section), so those are skipped. offsetWidth/offsetHeight are the element's own size in world pixels.
  const cards = [...document.querySelectorAll(".snd")].filter(n => n.offsetParent).map(n => {
    const p = Canvas.posIn(n);
    return { l: p.x, r: p.x + n.offsetWidth, t: p.y, b: p.y + n.offsetHeight, id: n.dataset.id };
  });
  const byCard = new Map(cards.map(c => [c.id, c]));
  const links = [];
  allSounds().forEach(s => {
    if (!s.next) return;
    // The output port circle of the source card, and the input square on the target card that belongs to this source.
    // (Template literals build CSS selectors; `data-id` attributes were set in soundEl.)
    const outEl = document.querySelector(`.snd[data-id="${s.id}"] .port`);
    const inEl = document.querySelector(`.snd[data-id="${s.next}"] .in[data-from="${s.id}"]`);
    if (!outEl?.offsetParent || !inEl?.offsetParent) return;   // either end hidden: draw nothing
    const o = Canvas.posIn(outEl),
      i = Canvas.posIn(inEl),
      cs = byCard.get(s.id),
      ct = byCard.get(s.next);
    links.push({
      s,
      a: { x: o.x + outEl.offsetWidth / 2, y: o.y + outEl.offsetHeight / 2 },   // centre of the output circle
      b: { x: i.x - 1, y: i.y + inEl.offsetHeight / 2 },                        // left edge of the input square
      sx: cs.r + 12,
      ex: ct.l - 12,
      cs,
      ct
    });
  });
  let routed2 = null;
  try { routed2 = routeCables(links, cards, W, H); } catch (err) { console.error("cable routing failed", err); }
  const items = links.map((l, n) => {
    // `on` = this cable is part of the highlighted path. (`?.` is safe when path is null.)
    const on = path?.edges.has(l.s.id + ">" + l.s.next);
    // Use the routed path; if missing, a bezier for rightward links or the simple routed() fallback otherwise.
    const d = routed2?.[n] || (l.b.x - l.a.x >= 10 ? bezier(l.a, l.b) : routed(l.a, l.b, { top: l.cs.t, bottom: l.cs.b }, { top: l.ct.t, bottom: l.ct.b }, W));
    return { l, on, d };
  }).sort((m, n) => m.on - n.on); // selected path on top
  // (Sorting by a boolean difference puts "off" cables first so the highlighted ones are painted last = on top.)
  items.forEach(({ l, on, d }) => {   // destructuring in the parameter list
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);   // "d" is the SVG attribute that holds the path commands
    p.setAttribute("class", "link" + (on ? " onpath" : path ? " off" : "") + (engines.get(l.s.id)?.playing ? " flow" : ""));
    p.style.stroke = tint(info.get(l.s.id)?.hue, on ? 70 : 62);
    p.setAttribute("marker-end", "url(#arr)");   // arrowhead defined in the HTML
    layer.append(p);
    // A wider invisible copy of the cable on top, so it is easy to click: clicking it removes the link,
    // exactly like clicking the output circle or the input square (and the same as on the campaign page).
    // (pointer-events: stroke in the stylesheet makes only the stroke receive the mouse.)
    const hit = document.createElementNS(SVGNS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "linkhit");
    hit.addEventListener("click", () => {
      linkHistory.record("removed a chain link");
      delete l.s.next;
      delete l.s.nextAt;
      save();
      render(true);
    });
    const tip = document.createElementNS(SVGNS, "title");   // an SVG <title> child is the shape's tooltip
    tip.textContent = `${l.s.name} → ${byId(l.s.next)?.name ?? "?"}  (click to remove)`;
    hit.append(tip);
    layer.append(hit);
  });
  // Remember where the cards were when we drew, so verifyLayout() can notice if they move afterwards.
  drawnLayout = layoutSignature();
  verifyLayout();
}

// layoutSignature(): a short string describing where every visible sound card is in the world.
// Two equal signatures mean "nothing moved".
function layoutSignature() {
  return [...document.querySelectorAll(".snd")]
    .filter(n => n.offsetParent)
    .map(n => {
      const p = Canvas.posIn(n);
      return `${Math.round(p.x)},${Math.round(p.y)}`;
    })
    .join("|");
}

// The browser can finish laying the page out AFTER we measured it (a scrollbar appearing, cards
// reflowing, web fonts arriving), and none of those reliably fire an event. So after drawing we
// look again shortly afterwards, and redraw if any card has moved. verifyCount caps this at a few
// tries so a layout that never settles cannot make us redraw forever.
let drawnLayout = "",
  verifyCount = 0;
function verifyLayout() {
  if (verifyCount >= 4) return;
  verifyCount++;
  setTimeout(() => { if (layoutSignature() !== drawnLayout) drawLinks(); }, 120);
}

// scheduleDraw(): ask for a cable redraw at the next screen repaint. requestAnimationFrame(fn) =
// "run fn right before the next repaint", which also coalesces bursts of events into one redraw
// per frame. A fresh request (as opposed to verifyLayout's own re-check) resets the retry budget.
function scheduleDraw() {
  verifyCount = 0;
  requestAnimationFrame(drawLinks);
}
// (Resizing the browser window does not move anything in world coordinates, so unlike before no
// window-resize listener is needed. Tile size changes are watched by tileObserver, see render().)
// Fonts load asynchronously and change text widths, and therefore card heights.
document.fonts?.ready.then(scheduleDraw);

// ------------------------------------------------------- undo / redo for chains
// Every change to the chain links (making, removing or re-routing one) can be undone and redone, with
// Ctrl+Z / Ctrl+Y (Cmd on a Mac) or the ↶ ↷ buttons in the toolbar. undo.js keeps the history; here we only
// say how to take a snapshot of the links and how to put one back.
//   snapshot: for every sound that has a link, its target and its link timestamp, as JSON text.
//   restore:  set every sound's link from that snapshot (sounds not in it lose their link), then save and
//             redraw. A link to a sound that has since been deleted is dropped by cleanLinks() during render.
// Deleting a sound (which also removes its links) is not part of this history.
const linkHistory = Undo.create({
  snapshot: () => JSON.stringify(Object.fromEntries(allSounds().filter(s => s.next).map(s => [s.id, [s.next, s.nextAt || 0]]))),
  restore: text => {
    const saved = JSON.parse(text);
    allSounds().forEach(s => {
      if (saved[s.id]) { s.next = saved[s.id][0]; s.nextAt = saved[s.id][1]; }
      else { delete s.next; delete s.nextAt; }
    });
    save();
    render(true);
  },
  onChange: () => {   // grey out the toolbar buttons when there is nothing to undo / redo
    $("#undoBtn").disabled = !linkHistory.canUndo();
    $("#redoBtn").disabled = !linkHistory.canRedo();
  }
});
$("#undoBtn").onclick = () => Undo.toast(linkHistory.undo() ? "Undid the last chain change" : "Nothing to undo");
$("#redoBtn").onclick = () => Undo.toast(linkHistory.redo() ? "Redid the chain change" : "Nothing to redo");
$("#undoBtn").disabled = $("#redoBtn").disabled = true;   // an empty history to start with
Undo.bindKeys(linkHistory);

// ------------------------------------------------------- dragging a connector
// drag a connector from a sound's output circle (or an existing input square, to re-route it) onto a sound
// linking: non-null while a cable is being dragged ({ moved, x0, y0 } = whether the pointer has
// moved noticeably, and the world coordinates of the port where the drag began).
// pendingRender: set when render() was requested mid-drag and postponed (see render()).
let linking = null,
  pendingRender = false;

// startLink(ev, snd): begin dragging the output cable of sound `snd`. Called on pointerdown on
// an output port, or on one of the target's input squares (which belongs to a source `snd`, so
// dragging it re-routes that source's cable).
//   ev  - the pointer event that started the drag
//   On release over another sound: snd.next = that sound (a new/changed link; outputs are
//   limited to one, so this replaces any old link). A click with no movement removes the
//   existing link instead. Then save() and render(true).
// Why pointer events on the whole window instead of HTML drag-and-drop? We need live coordinates for
// a rubber-band line and full control; so move/up/cancel listeners are added to the window now and
// removed in end().
function startLink(ev, snd) {
  // preventDefault stops the browser's default action (text selection / native drag);
  // stopPropagation stops the event from also reaching parent elements' handlers (e.g. the card's own "press to play").
  ev.preventDefault();
  ev.stopPropagation();
  const outEl = document.querySelector(`.snd[data-id="${snd.id}"] .port`);
  // World coordinates (the same space drawLinks draws in): the centre of the output circle.
  const p0 = Canvas.posIn(outEl);
  linking = { moved: false, x0: p0.x + outEl.offsetWidth / 2, y0: p0.y + outEl.offsetHeight / 2 };
  document.body.classList.add("linking");
  // The rubber-band cable shown while dragging.
  const temp = document.createElementNS(SVGNS, "path");
  temp.setAttribute("class", "link temp");
  temp.setAttribute("marker-end", "url(#arr)");
  $("#tempLayer").append(temp);
  // under(e): the sound card currently beneath the pointer (or undefined/null). elementFromPoint finds the topmost element at a screen position; closest() walks up the tree to a matching ancestor.
  const under = e => document.elementFromPoint(e.clientX, e.clientY)?.closest(".snd");
  // clear(): remove the highlight from every previously highlighted target card.
  const clear = () => document.querySelectorAll(".linktarget").forEach(n => n.classList.remove("linktarget"));
  // move(e): pointer moved; update the rubber band and highlight the card we would drop onto.
  // `moved` only becomes true after 5 px, so a plain click is not mistaken for a drag.
  const move = e => {
    const w = Canvas.toWorld(e.clientX, e.clientY),   // mouse position converted to world coordinates (accounts for pan and zoom)
      px = w.x,
      py = w.y;
    if (Math.hypot(px - linking.x0, py - linking.y0) > 5) linking.moved = true;
    temp.setAttribute("d", bezier({ x: linking.x0, y: linking.y0 }, { x: Math.max(px, linking.x0 + 12), y: py }));
    clear();
    const t = under(e);
    if (t && t.dataset.id !== snd.id) t.classList.add("linktarget");
  };
  // end(e, cancelled): finish the drag (released, or cancelled by the system). Unregister the
  // listeners, work out what we dropped on, and update the link.
  const end = (e, cancelled) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", cancel);
    const t = cancelled ? null : under(e),
      moved = linking?.moved;
    linking = null;
    temp.remove();
    clear();
    document.body.classList.remove("linking");
    if (moved && t && t.dataset.id !== snd.id) {
      linkHistory.record(snd.next ? "re-routed a chain link" : "made a chain link");   // remember the state first, so it can be undone
      snd.next = t.dataset.id;
      snd.nextAt = Date.now();   // timestamp: orders this link after older ones feeding the same target
    } // inputs are unlimited, output is one
    else if (!moved && !cancelled && snd.next) {
      linkHistory.record("removed a chain link");
      delete snd.next;
      delete snd.nextAt;
    } // plain click removes the link
    save();
    render(true);   // true = force: rebuild now even though linking just ended (see render())
  };
  // up/cancel are small wrappers; they are `const`s defined AFTER end(), but are only called later, by which time they exist.
  const up = e => end(e, false),
    cancel = e => end(e, true);
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", cancel);
}

// ----------------------------------------------------------- moving things
// Cards (sounds) and frames are moved with the pointer by canvas.js (Canvas.dragItems), the same code the
// campaign page uses. There is no longer any HTML5 drag-and-drop here.

// drag: non-null while a card or a frame is being dragged ({ kind: "node" }). render() is postponed
// while it is set, because rebuilding the page would destroy the element being dragged.
let drag = null;

// moveTile(id, sectionId): put a tile into a section (used by the Tile settings dialog and when a
// tile is dropped inside another section's frame). Only the `section` field changes; the frames
// follow the cards.
function moveTile(id, sectionId) {
  const t = S.tiles.find(x => x.id === id);
  if (t) t.section = sectionId;
}

// ---------------------------------------------------------------- render
// Building the visible page from S. The movable things are the sound CARDS: each has its own x, y on
// the canvas. Sections, tiles and subsections are FRAMES drawn behind them, sized to fit the cards
// that belong to them (canvas.js, layoutFrames), so a frame stretches and shrinks as you move its cards.
// render() creates all frames first (so they sit behind), then all cards, then fits the frames.

// frames: the latest rectangles of all frames ({ frameId: { l, t, r, b } }, world coordinates).
let frames = {};

// frameModel(exceptSoundId, exceptTileId): describes the nesting for Canvas.layoutFrames: sections
// containing tiles containing cards and subsections. The optional arguments leave one card (or one whole
// tile) out, to answer "where would the frames be without it?" when something is dropped.
function frameModel(exceptSound = null, exceptTile = null) {
  const cards = (t, test) => t.sounds.filter(s => s.id !== exceptSound && test(s));
  return {
    sections: S.sections.map(sec => ({
      id: sec.id,
      obj: sec,
      collapsed: !!sec.collapsed,
      tiles: S.tiles.filter(t => t.section === sec.id && t.id !== exceptTile).map(t => {
        const subIds = new Set(t.subs.map(x => x.id));   // a card whose group is missing/unknown counts as "loose"
        return {
          id: t.id,
          obj: t,
          items: cards(t, s => !s.group || !subIds.has(s.group)),
          subs: t.subs.map(x => ({ id: x.id, obj: x, items: cards(t, s => s.group === x.id) }))
        };
      })
    }))
  };
}
// relayout(): re-fit every frame around its cards (cheap; called after any move or size change).
function relayout() { frames = Canvas.layoutFrames(frameModel()); }

// cardEl(snd): the page element of a sound card (null if not drawn).
const cardEl = snd => document.querySelector(`.snd[data-iid="${snd.id}"]`);
// tileSounds / sectionSounds: all the sounds a tile / a section contains (for moving a frame with its cards).
const sectionSounds = sec => S.tiles.filter(t => t.section === sec.id).flatMap(t => t.sounds);

// dragHooks(after): the hooks passed to Canvas.dragItems for every drag on this page. While dragging,
// `drag` blocks render(), and the frames and cables are re-fitted on every step. When the drag ends,
// `after(moved)` runs (it decides what the drop means), then everything is saved and redrawn.
function dragHooks(after) {
  return {
    onStart: () => { drag = { kind: "node" }; },
    onMove: () => { relayout(); scheduleDraw(); },
    onEnd: moved => {
      drag = null;
      if (moved) { after?.(); save(); }
      render(true);
    }
  };
}

// adoptSound(snd): after a card is dropped, decide which tile (and subsection) it belongs to NOW.
// The frames are computed WITHOUT this card (otherwise its own frame would have stretched to cover it
// wherever it was dropped); if the centre of the card lies inside another tile's or subsection's frame, the
// card joins that tile / subsection. Dropped inside its own tile but outside any subsection frame, it becomes a
// "loose" card of the tile (no subsection). Dropped in empty space, it stays where it was (membership unchanged).
function adoptSound(snd) {
  const loc = locate(snd.id),
    card = cardEl(snd);
  if (!loc || !card) return;
  const rects = Canvas.layoutFrames(frameModel(snd.id), true),   // true = just compute, change nothing
    fid = Canvas.frameAt(rects, snd.x + card.offsetWidth / 2, snd.y + card.offsetHeight / 2);
  if (!fid || fid.startsWith("sec:")) return;
  const [kind, tileId, subId] = fid.split(":");   // "sub:TILE:SUB" or "tile:TILE"
  const dest = S.tiles.find(t => t.id === tileId);
  if (!dest) return;
  if (dest !== loc.tile) {
    loc.tile.sounds.splice(loc.i, 1);
    dest.sounds.push(snd);
  }
  snd.group = kind === "sub" ? subId : undefined;
}

// adoptTile(tile): after a tile's frame is dragged, if its centre is now inside ANOTHER section's frame,
// the tile joins that section (frames computed without this tile, as in adoptSound).
function adoptTile(tile) {
  const mine = frames[`tile:${tile.id}`];
  if (!mine) return;
  const rects = Canvas.layoutFrames(frameModel(null, tile.id), true),
    cx = (mine.l + mine.r) / 2,
    cy = (mine.t + mine.b) / 2;
  for (const sec of S.sections) {
    const r = rects[`sec:${sec.id}`];
    if (sec.id !== tile.section && r && cx > r.l && cx < r.r && cy > r.t && cy < r.b) { tile.section = sec.id; return; }
  }
}

// placeSound(snd, tile): choose a free canvas position for a sound that is being added to `tile`: the
// nearest free spot to that tile's other cards (or to the tile's empty frame). Cards of OTHER tiles
// are treated as bigger obstacles so the new card stays clear of their frames.
function placeSound(snd, tile) {
  const mine = new Set(tile.sounds.filter(s => s !== snd).map(s => s.id)),
    rects = Canvas.itemRects(new Set([snd.id])),
    grow = (r, m) => ({ l: r.l - m, t: r.t - m, r: r.r + m, b: r.b + m });
  const obstacles = rects.map(r => (mine.has(r.id) ? r : grow(r, 70)));
  // Other tiles' frames count too (important for tiles that are still empty).
  Object.entries(frames).forEach(([fid, r]) => { if (fid.startsWith("tile:") && fid !== `tile:${tile.id}`) obstacles.push(grow(r, 20)); });
  const near = rects.filter(r => mine.has(r.id)),
    own = frames[`tile:${tile.id}`];
  Object.assign(snd, Canvas.freeSpot(obstacles, Canvas.CARD_W, Canvas.CARD_H, near.length ? near : own ? [own] : []));
}

// soundEl(snd, tile, info, path): build the clickable card for one sound.
//   snd/tile - the sound and its tile
//   info     - result of chainInfo() (colours/badges/inputs), shared by all cards in this render
//   path     - result of activePath() (or null), to mark the highlighted chain
// Returns the new DOM element (the caller inserts it into the page).
// Contains: a drag bar along the top (grab it to move the card), name, type label, gear button (edit),
// chain badge, input squares (one per incoming cable plus a free one), output port, volume slider,
// hotkey label. The card sits at its own x, y on the canvas.
function soundEl(snd, tile, info, path) {
  const e = engines.get(snd.id),
    ci = info.get(snd.id);   // ci = chain info for this sound (undefined if not chained)
  // CSS classes for the card; falsy entries ("" / undefined) are filtered out below.
  const cls = [
    "snd",
    snd.type,
    e?.status === "error" ? "error" : e?.status === "ready" ? "" : "loading",
    e?.playing ? "playing" : "",
    ci ? "chained" : "",
    ci?.cyc ? "cyc" : "",
    path?.nodes.has(snd.id) ? "onpath" : "",
    path?.cur === snd.id ? "current" : "",
    e?.repeatAt ? "waiting" : ""   // silent, counting down to its next repeat
  ];
  // role/tabIndex make a plain <div> behave like a button for keyboard and screen-reader users.
  const b = el("div", { className: cls.filter(Boolean).join(" "), role: "button", tabIndex: 0, title: e?.status === "error" ? e.error : snd.url });
  b.dataset.id = snd.id;    // becomes the HTML attribute data-id="..."; drawLinks() finds cards with it
  b.dataset.iid = snd.id;   // the canvas code finds cards by this attribute
  // Which section / tile / subsection the card belongs to (used by the "snap only to the same ..." option).
  b.dataset.sec = tile.section;
  b.dataset.tile = tile.id;
  b.dataset.sub = tile.id + ":" + (snd.group || "");
  // Place the card on the canvas (world coordinates); hidden while its section is collapsed.
  b.style.left = snd.x + "px";
  b.style.top = snd.y + "px";
  if (S.sections.find(x => x.id === tile.section)?.collapsed) b.style.display = "none";
  if (ci) setTint(b, ci.hue);
  // The drag bar: pressing here and moving drags the card (a plain press on the rest of the card plays it).
  const bar = el("div", { className: "dragbar", textContent: "⠿⠿⠿", title: "Drag to move this sound" });
  bar.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    // After the drop the card may now belong to another tile or subsection (see adoptSound).
    Canvas.dragItems(ev, [{ obj: snd, el: b }], dragHooks(() => adoptSound(snd)));
  });
  b.append(
    bar,
    el("span", { className: "nm", textContent: snd.name || "…" }),
    el("span", {
      className: "tp",
      textContent: e?.status === "error"
        ? "⚠ failed"
        : e?.status !== "ready"
          ? "loading…"
          : e.repeatAt
            ? repeatLabel(e)   // waiting for the next repeat
            : snd.type === "music"
              ? "♪ soundtrack"
              : snd.type === "instant"
                ? "myinstants"
                : "clip"
    }),
    // Gear button: opens the edit dialog. stopPropagation so the click does not also count as a card press.
    el("span", { className: "gear", textContent: "⚙", onclick: ev => { ev.stopPropagation(); openSoundDlg(snd, tile.id); } })
  );
  if (ci) {
    // The corner badge shows the sound's position in its chain. On a sound that is PLAYING in a chain that is
    // not in focus it doubles as a focus button ("◎"): pressing it moves the focus to this chain without
    // starting or stopping anything (the card itself still just plays/stops the sound, as always).
    const inBackground = e?.playing && currentSound()?.id !== snd.id;
    const badge = el("span", {
      className: "badge" + (inBackground ? " focusable" : ""),
      textContent: (inBackground ? "◎ " : "") + (ci.cyc ? "↻" : ci.pos),
      title: inBackground ? "Playing in the background. Click to focus this chain." : "Position in chain"
    });
    if (inBackground) badge.addEventListener("pointerdown", ev => { ev.stopPropagation(); setFocus(snd); });
    b.append(badge);
  }
  // inputs: one square per incoming link, plus an always-visible free one
  const insCol = el("span", { className: "ins" });
  (info.ins.get(snd.id) || []).forEach(src => {
    const q = el("span", { className: "in on", title: `From “${src.name}”. Click to remove, drag to re-route` });
    q.dataset.from = src.id;   // data-from: lets drawLinks() find the square belonging to this source
    setTint(q, info.get(src.id)?.hue);
    q.addEventListener("pointerdown", ev => startLink(ev, src));   // dragging an input re-routes the SOURCE's cable
    insCol.append(q);
  });
  insCol.append(el("span", { className: "in free", title: "Drop a connector anywhere on this sound to chain into it" }));
  const port = el("span", {
    className: "port" + (snd.next ? " on" : ""),
    title: snd.next ? "Output. Drag to re-link, click to unlink" : "Output. Drag onto another sound to play it next"
  });
  port.addEventListener("pointerdown", ev => startLink(ev, snd));
  const vol = el("input", { type: "range", min: 0, max: 1, step: 0.01, value: snd.volume ?? 1, className: "svol", title: "Sound volume" });
  // Slider moved: store it, apply to any playing audio right away, and schedule a save.
  vol.oninput = () => {
    snd.volume = +vol.value;
    applyVolume(snd);
    save();
  };
  const row = el("span", { className: "srow" }, vol);
  if (snd.key) row.append(el("span", { className: "kb", textContent: snd.key.toUpperCase() }));
  b.append(insCol, port, row);
  // pointerdown, not click: fires on press instead of release
  // (click only fires after the button is released, which adds noticeable delay; pointerdown
  // makes the soundboard feel instant). Presses on the little controls are ignored: the
  // `closest(...)` check asks "is the target inside one of these elements?".
  b.addEventListener("pointerdown", ev => {
    if (ev.button !== 0 || ev.target.closest(".gear,.dragbar,.port,.in,.svol,.focusable")) return;   // button 0 = primary (left) button
    // trigger() is async; .catch() logs failures instead of leaving an unhandled rejected Promise.
    trigger(snd).catch(err => console.error("play failed", err));
  });
  // Keyboard users: Enter on a focused card presses it.
  b.addEventListener("keydown", ev => { if (ev.key === "Enter" && ev.target === b) trigger(snd); });
  return b;
}

// frameEl(level, fid, title color hue...): builds the shell of a frame: a <div class="frame f-LEVEL"> with
// its id and a header holding `head` elements. Dragging the header moves all the cards inside (or the
// empty frame itself): `getItems()` returns the { obj, el } list to move, `after` runs on drop.
function frameEl(level, fid, hue, head, getItems, after) {
  const frame = el("div", { className: `frame f-${level}` });
  frame.dataset.fid = fid;
  frame.style.setProperty("--gh", hue);   // colour for the frame (CSS custom property, read by the stylesheet)
  const header = el("header", {}, ...head);
  frame.append(header);
  header.addEventListener("pointerdown", ev => {
    if (ev.button !== 0 || ev.target.closest("button,input,select,a")) return;
    Canvas.dragItems(ev, getItems(), dragHooks(after));
  });
  return frame;
}
// cardsOf(sounds): the { obj, el } list Canvas.dragItems wants for a list of sounds.
const cardsOf = sounds => sounds.map(s => ({ obj: s, el: cardEl(s) }));

// sectionFrame(sec): the outermost frame, drawn around a section's tiles: title bar with collapse
// arrow, name and tools (add tile, rename, delete). Dragging its title bar moves the whole section.
function sectionFrame(sec) {
  const tiles = S.tiles.filter(t => t.section === sec.id);
  const hue = (S.sections.indexOf(sec) * 137.5 + 260) % 360;   // golden-angle steps give each section its own colour
  const head = [
    el("button", { className: "tiny", textContent: sec.collapsed ? "▸" : "▾", title: "Collapse / expand",
      onclick: () => { sec.collapsed = !sec.collapsed; save(); render(); } }),
    el("h2", { textContent: sec.name }),
    el("span", { className: "tools" },
      el("button", { textContent: "+ Tile", onclick: () => addTile(sec.id) }),
      el("button", { textContent: "✎", title: "Rename section", onclick: () => {
        const n = prompt("Section name", sec.name);
        if (n) { sec.name = n; save(); render(); }
      } }),
      el("button", { textContent: "🗑", title: "Delete section", onclick: () => {
        if (S.sections.length < 2) return alert("Keep at least one section.");
        const dest = S.sections.find(s => s !== sec);   // the tiles of a deleted section move to another one
        if (tiles.length && !confirm(`Delete section "${sec.name}"? Its ${tiles.length} tile(s) move to "${dest.name}".`)) return;
        tiles.forEach(t => (t.section = dest.id));
        S.sections = S.sections.filter(s => s !== sec);
        save();
        render();
      } }))
  ];
  return frameEl("sec", `sec:${sec.id}`, hue, head,
    () => (sectionSounds(sec).length ? cardsOf(sectionSounds(sec)) : [{ obj: sec, el: document.querySelector(`.frame[data-fid="sec:${sec.id}"]`) }]));
}

// tileFrame(tile): the frame around one tile's cards (and subsections): title bar with the tile's name,
// volume slider, fade button and tools (stop all, add sound, settings, delete). Dragging the title bar moves
// the tile's cards; dropping it inside another section's frame moves the tile to that section.
function tileFrame(tile) {
  const fadeOn = tile.fade?.on ?? true;
  const tools = el("span", { className: "tools" },
    el("button", { textContent: "■", title: "Stop this tile", onclick: () => tile.sounds.forEach(s => stopSound(s)) }),
    el("button", { textContent: "+", title: "Add sound here", onclick: () => openSoundDlg(null, tile.id) }),
    el("button", { textContent: "⚙", title: "Tile settings (rename, subsections, fades)", onclick: () => openTileDlg(tile) }));
  // Pinned tiles cannot be deleted. confirm() shows the browser's blocking OK/Cancel box.
  if (!tile.pinned) tools.append(el("button", {
    textContent: "🗑",
    title: "Delete tile",
    onclick: () => {
      if (confirm(`Delete tile "${tile.name}" and its ${tile.sounds.length} sounds?`)) {
        tile.sounds.forEach(s => stopSound(s, true));   // silence everything first
        S.tiles = S.tiles.filter(t => t !== tile);      // keep every tile except this one
        cleanLinks();                                   // drop chain links that pointed at its sounds
        save();
        render();
      }
    }
  }));
  const vol = el("input", { type: "range", min: 0, max: 1, step: 0.01, value: tile.volume ?? 1, className: "tvol", title: "Tile volume" });
  vol.oninput = () => {
    tile.volume = +vol.value;
    busFor(tile);   // busFor() re-applies tile.volume to the tile's GainNode
    save();
  };
  const fadeBtn = el("button", {
    className: "tiny fadebtn" + (fadeOn ? " on-state" : ""),
    textContent: fadeOn ? `Fade ${tile.fade.secs}s` : "Fade off",
    title: "Fade out when stopping sounds in this tile (click to toggle, ⚙ to change length)",
    onclick: () => { tile.fade.on = !fadeOn; save(); render(); }
  });
  const hue = (S.sections.findIndex(x => x.id === tile.section) * 137.5 + 260) % 360;
  return frameEl("tile", `tile:${tile.id}`, hue, [el("h2", { textContent: tile.name }), vol, fadeBtn, tools],
    () => (tile.sounds.length ? cardsOf(tile.sounds) : [{ obj: tile, el: document.querySelector(`.frame[data-fid="tile:${tile.id}"]`) }]),
    () => adoptTile(tile));
}

// subFrame(tile, sub): the frame around one subsection's cards: its name and tools (add sound, rename,
// delete). Dragging its title bar moves the subsection's cards.
function subFrame(tile, sub) {
  const mine = tile.sounds.filter(s => s.group === sub.id);
  const head = [
    el("h3", { textContent: sub.name }),
    el("span", { className: "tools" },
      el("button", { textContent: "+", title: "Add sound to subsection", onclick: () => openSoundDlg(null, tile.id, sub.id) }),
      el("button", { textContent: "✎", title: "Rename", onclick: () => {
        const n = prompt("Subsection name", sub.name);
        if (n) { sub.name = n; save(); render(); }
      } }),
      el("button", { textContent: "🗑", title: "Delete subsection (sounds stay in the tile)", onclick: () => {
        tile.subs = tile.subs.filter(x => x !== sub);
        tile.sounds.forEach(s => { if (s.group === sub.id) delete s.group; });
        save();
        render();
      } }))
  ];
  return frameEl("sub", `sub:${tile.id}:${sub.id}`, 260, head,
    () => (mine.length ? cardsOf(mine) : [{ obj: sub, el: document.querySelector(`.frame[data-fid="sub:${tile.id}:${sub.id}"]`) }]));
}

// addTile(sectionId): ask for a name and add a new empty tile to that section (or the first section if
// sectionId is null). Its (empty) frame goes in the free spot nearest to that section's other frames.
function addTile(sectionId) {
  const name = prompt("New tile name (e.g. 'Boss Phase 2')");
  if (!name) return;
  const sec = sectionId || S.sections[0].id;
  const tile = { id: uid(), name, pinned: false, section: sec, sounds: [], subs: [], volume: 1, fade: { on: true, secs: 1 }, linkFade: 2 };
  const grow = (r, m) => ({ l: r.l - m, t: r.t - m, r: r.r + m, b: r.b + m });
  const obstacles = Object.entries(frames).filter(([fid]) => fid.startsWith("tile:")).map(([, r]) => grow(r, 24));
  const near = S.tiles.filter(t => t.section === sec).map(t => frames[`tile:${t.id}`]).filter(Boolean);
  Object.assign(tile, Canvas.freeSpot(obstacles, 320, 100, near));
  S.tiles.push(tile);
  save();
  render();
}

// render(force): rebuild the whole page from S. The central "state -> screen" function.
// It is called after almost every change. It deletes the old DOM and recreates it, then asks
// (via requestAnimationFrame) for the cables to be redrawn once the browser has laid out the new elements.
// Gotcha: while a drag is in progress (`drag` or `linking` set) rebuilding the DOM would destroy the very
// element being dragged and cancel the drag. So render() just sets pendingRender and returns;
// the drag-end code calls render() again afterwards. `force = true` bypasses the postponement.
function render(force = false) {
  if (!force && (drag || linking)) { pendingRender = true; return; } // don't rebuild the DOM mid-drag
  pendingRender = false;
  cleanLinks();
  const root = $("#tiles");
  root.textContent = "";   // removes all children: wipes the old UI
  const path = activePath(),
    info = chainInfo(path);
  document.body.classList.toggle("haspath", !!path);   // a CSS class lets the stylesheet dim non-path cards
  // Frames first (so they sit behind the cards): sections, then tiles, then subsections; then every card.
  S.sections.forEach(sec => root.append(sectionFrame(sec)));
  S.tiles.forEach(t => root.append(tileFrame(t)));
  S.tiles.forEach(t => t.subs.forEach(sub => root.append(subFrame(t, sub))));
  S.tiles.forEach(t => t.sounds.forEach(s => root.append(soundEl(s, t, info, path))));
  relayout();   // fit each frame around its cards
  // Watch the size of every card: when one grows or shrinks (its name wrapped, the font loaded) the frames
  // and cables must follow. disconnect() forgets the old elements; observe() watches the new ones.
  cardObserver.disconnect();
  document.querySelectorAll(".snd").forEach(n => cardObserver.observe(n));
  drawDock(info);   // the "chains playing" bar (only shown while two or more chains are playing)
  scheduleDraw();
}
// cardObserver: a ResizeObserver (calls back when any observed element changes size). Re-fits the
// frames and redraws the cables.
const cardObserver = new ResizeObserver(() => {
  relayout();
  scheduleDraw();
});
// a drag that ends without a drop (Esc, outside the window) must never leave rendering frozen
// The third argument `true` registers the listener in the "capture" phase, so it runs before
// any other handler and even if a handler stops propagation.
addEventListener("dragend", () => { drag = null; if (pendingRender) render(true); }, true);

// Global keyboard shortcuts (a callback on every key press anywhere on the page):
//   Right/Left arrows = next/previous in the chain; Up/Down = switch the chosen input path;
//   [ and ] = move the focus to the previous/next chain when several chains are playing;
//   any letter that matches a sound's `key` = trigger that sound.
// Ignored while typing in a form field or dialog, with Ctrl/Cmd/Alt held (browser shortcuts), or for auto-repeat.
// `ev.target.closest?.(...)` uses optional chaining on a method call: skip if the method does not exist.
addEventListener("keydown", ev => {
  if (ev.repeat || ev.target.closest?.("input,select,textarea,dialog") || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
    ev.preventDefault();   // stop the page from scrolling sideways
    return chainStep(ev.key === "ArrowRight" ? 1 : -1);
  }
  if (ev.key === "[" || ev.key === "]") {   // switch focus between chains that are playing at the same time
    ev.preventDefault();
    return cycleFocus(ev.key === "]" ? 1 : -1);
  }
  if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && currentSound()) {
    ev.preventDefault();
    return pathStep(ev.key === "ArrowDown" ? 1 : -1);
  }
  for (const s of allSounds())
    if (s.key && s.key.toLowerCase() === ev.key.toLowerCase()) {
      ev.preventDefault();
      trigger(s);
      return;
    }
});

// ------------------------------------------------------- add / edit sound
// The "Add sound / Edit sound" <dialog>. A <dialog> is a built-in modal popup element; showModal()
// opens it and close() closes it. `form.url`, `form.name`, ... are the form's named fields (HTML
// name attributes become properties of the form object).
const dlg = $("#soundDlg"),
  form = $("#soundForm");
// editing: the sound being edited, or null when the dialog is adding a new sound.
let editing = null;
// Any element with a data-close attribute is a Cancel/close button. (`(b.onclick = ...)` in parentheses returns the assigned function.)
document.querySelectorAll("[data-close]").forEach(b => (b.onclick = () => b.closest("dialog").close()));

// fillGroups(tileId, selected): fill the dialog's "subsection" dropdown with the subsections of
// the chosen tile (plus "(none)") and select `selected`.
function fillGroups(tileId, selected) {
  const tile = S.tiles.find(t => t.id === tileId);
  form.group.textContent = "";
  form.group.append(el("option", { value: "", textContent: "(none)" }));
  (tile?.subs || []).forEach(s => form.group.append(el("option", { value: s.id, textContent: s.name })));
  form.group.value = selected || "";
}
// When the user picks a different tile in the dialog, the subsection list must change too.
form.tile.addEventListener("change", () => fillGroups(form.tile.value, ""));

// openSoundDlg(snd, tileId, groupId): open the dialog to edit `snd`, or to add a new sound
// (snd = null) pre-selecting a tile and optionally a subsection.
function openSoundDlg(snd, tileId, groupId) {
  editing = snd;
  const sel = form.tile;
  sel.textContent = "";
  S.tiles.forEach(t => sel.append(el("option", { value: t.id, textContent: t.name })));
  form.reset();   // clear any text left over from last time
  $("#soundDlgTitle").textContent = snd ? "Edit sound" : "Add sound";
  $("#deleteSound").hidden = !snd;   // hide the Delete button when adding
  $("#soundMsg").textContent = "";
  form.tile.value = tileId || S.tiles[0].id;
  fillGroups(form.tile.value, snd ? snd.group : groupId);
  if (snd) {
    // Copy the sound's fields into the form controls. An auto-filled name is shown as blank so it can keep tracking the media title.
    form.url.value = snd.url;
    form.name.value = snd.autoName ? "" : snd.name;
    form.key.value = snd.key || "";
    form.type.value = snd.type;
    form.start.value = snd.start ?? "";
    form.end.value = snd.end ?? "";
    form.volume.value = snd.volume ?? 1;
    form.loop.checked = !!snd.loop;
    form.restart.checked = !!snd.restart;
    form.repeatDelay.value = snd.repeatDelay ?? "";
  }
  // Refresh the MP3-folder drop-down, then select the sound's current file in it (if it is one).
  refreshLibrary(true).then(() => {
    if (snd && snd.url.startsWith(LIBRARY_PREFIX)) $("#libSelect").value = snd.url.slice(LIBRARY_PREFIX.length);
  });
  dlg.showModal();
}
$("#addSoundBtn").onclick = () => openSoundDlg(null, null);
// Convenience: pasting a myinstants.com link switches the type to "instant" automatically. (/.../i is a regular expression literal; i = case-insensitive.)
form.url.addEventListener("input", () => {
  if (/myinstants\.com/i.test(form.url.value)) form.type.value = "instant";
});
// ------------------------------------------------------- local files / MP3 folder
// Sounds can come from the server's own mp3s/ folder instead of the internet. Such a sound's url
// is "library:<file name>". Two ways to choose one in the dialog:
//   - Browse...: pick a file on THIS computer. A web page may not learn a picked file's real path
//     (a browser security rule), only its contents, so the file is uploaded into the folder.
//   - the drop-down: lists what is already in the folder (the server rescans it every 2 seconds,
//     so files you drop in by hand show up by themselves).
const LIBRARY_PREFIX = "library:";
// libVersion: the folder-listing version we last saw (the server bumps it whenever the folder changes).
let libVersion = -1;

// refreshLibrary(force): fetch the folder listing and rebuild the drop-down. Unless `force` is
// true it does nothing when the listing has not changed. Returns a Promise; never throws
// (if the server is briefly unreachable we keep the old list and the next poll tries again).
async function refreshLibrary(force) {
  try {
    const lib = await api("/api/library");
    if (!force && lib.version === libVersion) return;
    libVersion = lib.version;
    const sel = $("#libSelect"),
      keep = sel.value;   // remember the current choice so a refresh does not reset it
    sel.textContent = "";
    sel.append(el("option", { value: "", textContent: lib.files.length ? "(choose a file)" : "(the folder is empty)" }));
    lib.files.forEach(f => sel.append(el("option", { value: f.name, textContent: f.name })));
    sel.value = keep;   // if that file is gone this falls back to the first option
    sel.title = "Folder on the server: " + lib.folder;
  } catch (_) { /* ignore: try again on the next poll */ }
}

// pollLibrary(): runs every 3 seconds (started at boot). When the folder listing changed it
// refreshes the drop-down and retries every library sound that had failed to load, so a file
// that was missing and has now been put back starts working without a page reload.
async function pollLibrary() {
  const before = libVersion;
  await refreshLibrary(false);
  if (libVersion === before) return;   // nothing changed
  allSounds().forEach(s => {
    const e = engines.get(s.id);
    if (e?.status === "error" && s.url.startsWith(LIBRARY_PREFIX)) {
      engines.delete(s.id);   // forget the failed engine so loadSound builds a fresh one
      loadSound(s);
    }
  });
}

// Browse button: opens the browser's normal file picker through the hidden <input type="file">.
$("#browseBtn").onclick = () => $("#fileInput").click();
// When a file is chosen: upload it, then point the dialog's Link at it. All failures (no
// server, wrong file type, too big) become a message in the dialog; nothing throws.
$("#fileInput").addEventListener("change", async () => {
  const input = $("#fileInput"),
    file = input.files[0],
    msg = $("#soundMsg");
  if (!file) return;
  msg.textContent = `Uploading ${file.name}…`;
  try {
    const body = new FormData();   // builds a multipart/form-data request, as a file upload form does
    body.append("file", file);
    const r = await fetch("/api/library/upload", { method: "POST", body });
    const j = await r.json().catch(() => ({}));   // an HTML error page would not parse as JSON
    if (!r.ok) throw new Error(j.error || r.statusText);
    await refreshLibrary(true);
    $("#libSelect").value = j.name;
    form.url.value = LIBRARY_PREFIX + j.name;
    msg.textContent = `Added "${j.name}" to the MP3 folder.`;
  } catch (err) {
    msg.textContent = "Upload failed: " + err.message;
  }
  input.value = "";   // clear it so choosing the same file again still fires "change"
});
// Choosing a file in the drop-down sets the Link field to it.
$("#libSelect").addEventListener("change", () => {
  const name = $("#libSelect").value;
  if (name) form.url.value = LIBRARY_PREFIX + name;
});

// Delete button in the dialog: stop the sound, free its engine, remove it from its tile, tidy chain links.
// engines.delete drops our reference; the garbage collector reclaims the audio data.
$("#deleteSound").onclick = () => {
  const loc = locate(editing.id);
  stopSound(editing, true);
  engines.delete(editing.id);
  loc.tile.sounds.splice(loc.i, 1);
  cleanLinks();
  dlg.close();
  save();
  render();
};
// Submit (OK/Save) handler for the dialog. Reads the form into a `data` object, validates the
// URL, then either updates the existing sound or creates a new one, starts loading it,
// closes the dialog and saves. preventDefault() stops the browser's default form submission (a page reload).
form.addEventListener("submit", ev => {
  ev.preventDefault();
  // num(v): empty box -> undefined (field not set), otherwise a number.
  const f = form,
    num = v => (v === "" ? undefined : +v);
  const data = {
    url: f.url.value.trim(),
    name: f.name.value.trim(),
    key: f.key.value.trim().toLowerCase() || undefined,
    type: f.type.value,
    start: num(f.start.value),
    end: num(f.end.value),
    volume: +f.volume.value,
    loop: f.loop.checked,
    restart: f.restart.checked,
    // Blank, zero or negative means "no repeat" (undefined fields are left out when saving).
    repeatDelay: num(f.repeatDelay.value) > 0 ? num(f.repeatDelay.value) : undefined,
    group: f.group.value || undefined,
  };
  // A link must be http(s):// or "library:<file>" (a file in the server's MP3 folder; see the section below).
  if (!/^https?:\/\//i.test(data.url) && !data.url.startsWith(LIBRARY_PREFIX)) {
    $("#soundMsg").textContent = "Enter a full http(s) link, or use Browse / pick a file from the MP3 folder.";
    return;
  }
  const dest = S.tiles.find(t => t.id === f.tile.value);
  if (editing) {
    const old = locate(editing.id).tile;
    // A changed URL or type means the old audio is no longer valid: stop it and discard its engine so loadSound() starts over.
    if (editing.url !== data.url || editing.type !== data.type) { stopSound(editing, true); engines.delete(editing.id); }
    cancelRepeat(editing);          // changed settings: any pending repeat timer starts over from the next play
    Object.assign(editing, data);   // copy all the form fields onto the existing sound object
    if (!data.name) editing.autoName = true; else delete editing.autoName;
    if (old !== dest) {
      old.sounds.splice(old.sounds.indexOf(editing), 1);
      placeSound(editing, dest);   // moved to another tile in the dialog: put the card next to that tile's cards
      dest.sounds.push(editing);
    }
    loadSound(editing);   // returns a Promise; we do not wait. It will call render() when ready
  } else {
    // `...data` (spread) copies every field of data into the new object literal.
    const snd = { id: uid(), ...data, autoName: !data.name };
    if (!data.name) snd.name = "Loading…";
    placeSound(snd, dest);   // a free spot next to the tile's other cards
    dest.sounds.push(snd);
    loadSound(snd);
  }
  dlg.close();
  save();
  render(true);
});

// Toolbar buttons for adding tiles and sections.
$("#addTileBtn").onclick = () => addTile(null);
$("#addSectionBtn").onclick = () => {
  const name = prompt("New section name (e.g. 'Act 2')");
  if (name) {
    S.sections.push({ id: uid(), name });
    save();
    render();
  }
};

// ---------------------------------------------------------- tile settings
// The tile settings dialog (rename, move to another section, fade lengths, subsections).
// Subsection edits are made on a COPY (draftSubs) and only applied to the tile when OK is
// pressed, so Cancel discards them.
const tdlg = $("#tileDlg"),
  tform = $("#tileForm");
// editingTile: the tile whose settings are open. draftSubs: working copy of its subsections ({ id, name, del? }).
let editingTile = null,
  draftSubs = [];

// drawSubList(): redraw the subsection list inside the tile dialog from draftSubs.
// Entries marked `del` are hidden (they are deleted for real only on submit).
function drawSubList() {
  const box = $("#subList");
  box.textContent = "";
  draftSubs.filter(x => !x.del).forEach(x => {
    const inp = el("input", { value: x.name });
    inp.oninput = () => (x.name = inp.value);   // closure: edits the draft entry `x` as the user types
    box.append(el("div", { className: "row subrow" }, inp, el("button", {
      type: "button",   // type "button" so it does not submit the form
      className: "danger tiny",
      textContent: "Delete",
      title: "Sounds stay in the tile",
      onclick: () => {
        x.del = true;
        drawSubList();
      }
    })));
  });
  if (!box.children.length) box.append(el("span", { className: "muted", textContent: "No subsections yet." }));
}

// addDraftSub(): add the name typed in the "new subsection" box to draftSubs (ignored if blank).
function addDraftSub() {
  const inp = $("#newSub"),
    name = inp.value.trim();
  if (!name) return;
  draftSubs.push({ id: uid(), name });
  inp.value = "";
  drawSubList();
}
$("#addSubBtn").onclick = addDraftSub;
// Pressing Enter in that box adds the subsection instead of submitting the whole dialog.
$("#newSub").addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); addDraftSub(); } });

// openTileDlg(tile): fill the tile dialog with the tile's current settings and show it.
// `{ ...x }` copies each subsection object so edits do not touch the real ones until submit.
function openTileDlg(tile) {
  editingTile = tile;
  tform.section.textContent = "";
  S.sections.forEach(s => tform.section.append(el("option", { value: s.id, textContent: s.name })));
  tform.name.value = tile.name;
  tform.section.value = tile.section;
  tform.fadeOn.checked = tile.fade?.on ?? true;
  tform.fadeSecs.value = tile.fade?.secs ?? 1;
  tform.linkSecs.value = tile.linkFade ?? 2;
  draftSubs = tile.subs.map(x => ({ ...x }));
  drawSubList();
  tdlg.showModal();
}
// Dialog OK: copy the form values (clamped to sane minimums) onto the tile, apply the subsection
// edits (deleted subsections leave their sounds in the tile, i.e. their `group` is cleared),
// move the tile if a different section was chosen, then save and rebuild.
tform.addEventListener("submit", ev => {
  ev.preventDefault();
  const t = editingTile;
  addDraftSub(); // a typed-but-not-added name still counts
  t.name = tform.name.value.trim() || t.name;
  t.fade = { on: tform.fadeOn.checked, secs: Math.max(0.1, +tform.fadeSecs.value || 1) };
  t.linkFade = Math.max(0, +tform.linkSecs.value || 0);
  draftSubs.filter(x => x.del).forEach(x => t.sounds.forEach(s => { if (s.group === x.id) delete s.group; }));
  t.subs = draftSubs.filter(x => !x.del).map(x => ({ id: x.id, name: x.name.trim() || "Subsection" }));
  if (t.section !== tform.section.value) moveTile(t.id, tform.section.value, null);
  tdlg.close();
  save();
  render(true);
});

// --------------------------------------------------- campaigns & versions
// (The element ids and function names still say "preset": the feature was renamed Campaigns, only the wording and URLs changed.)
// Campaigns = named snapshots of the whole soundboard the user saved on purpose. Versions =
// automatic backups kept by the server. Both live on the server; this code lists them and asks the server to load/restore.
const pdlg = $("#presetDlg");

// refreshPresetUI(): fetch campaigns, versions and launch config from the server (three requests at once) and
// rebuild the three lists in the campaigns dialog. Promise.all([...]) waits for all of the
// futures to finish and returns their results as an array, which `const [a, b, c] = ...` unpacks.
async function refreshPresetUI() {
  const [presets, versions, cfg] = await Promise.all([api("/api/campaigns"), api("/api/versions"), api("/api/config")]);
  const pl = $("#presetList");
  pl.textContent = "";
  presets.forEach(n => pl.append(el("li", {}, el("span", { textContent: n }), el("span", {},
    // encodeURIComponent makes the name safe to put in a URL path (escapes "/", spaces, etc.).
    el("button", { textContent: "Load", onclick: () => applyState(api(`/api/campaigns/${encodeURIComponent(n)}/load`, "POST")) }),
    el("button", {
      textContent: "Delete",
      onclick: async () => {
        if (confirm(`Delete campaign ${n}?`)) {
          await api("/api/campaigns/" + encodeURIComponent(n), "DELETE");
          refreshPresetUI();
        }
      }
    })))));
  // The "launch behaviour" drop-downs: which campaign (if any) to load when the app starts.
  const lp = $("#launchPreset");
  lp.textContent = "";
  presets.forEach(n => lp.append(el("option", { value: n, textContent: n })));
  $("#launchMode").value = cfg.launch.mode;
  if (cfg.launch.preset) lp.value = cfg.launch.preset;
  const vl = $("#versionList");
  vl.textContent = "";
  versions.forEach(n => vl.append(el("li", {}, el("span", { textContent: n }),
    // `a && b`: b only runs if a is truthy, so applyState happens only when the user confirms.
    el("button", { textContent: "Restore", onclick: () => confirm("Replace live state with this version? (current state is snapshotted first)") && applyState(api(`/api/versions/${encodeURIComponent(n)}/restore`, "POST")) }))));
}

// applyState(p): replace the live state with one the server returns. `p` is a Promise (the
// not-yet-finished request). Stops all audio, discards every engine (their audio belongs to the old sounds), installs
// and normalises the new S, closes the dialog, redraws, and preloads the new sounds.
async function applyState(p) {
  allSounds().forEach(s => stopSound(s, true));
  S = await p;
  normalize();
  engines.clear();
  pdlg.close();
  render();
  loadAll();
}
$("#presetsBtn").onclick = async () => {
  await refreshPresetUI();
  pdlg.showModal();
};
// "Save campaign": first upload the current state (so the campaign captures what is on screen right
// now rather than the last debounced save), then ask the server to store it under the typed name.
$("#savePreset").onclick = async () => {
  const name = $("#presetName").value.trim();
  if (!name) return;
  try {
    await api("/api/state", "PUT", S);
    await api("/api/campaigns", "POST", { name });
    $("#presetName").value = "";
    refreshPresetUI();
  }
  catch (e) { alert(e.message); }
};
$("#saveLaunch").onclick = async () => {
  await api("/api/config", "PUT", { launch: { mode: $("#launchMode").value, preset: $("#launchPreset").value } });
  alert("Launch behaviour saved.");
};


// ------------------------------------------------- play requests from other pages
// The campaign tracker page can link a sound to a flag. When that flag is triggered it sends
// { type: "play", id } on this channel (a BroadcastChannel is a browser feature that lets pages of
// the same site talk to each other), and we press the sound exactly as if the user had clicked it.
// If the id no longer exists (the sound was deleted) the message is ignored. The try/catch covers
// very old browsers without BroadcastChannel; the soundboard works the same, it just cannot be
// triggered from the campaign page.
try {
  new BroadcastChannel("dm-soundboard").onmessage = ev => {
    const snd = ev.data?.type === "play" ? byId(ev.data.id) : null;
    if (snd) trigger(snd);
  };
} catch (_) {}

// ----------------------------------------------- messages from the app shell
// This page runs inside a frame of the app shell (shell.html), which keeps it loaded while you look at
// other tabs. A hidden frame cannot measure layout, so when the shell shows this tab again it sends
// { type: "shown" } and we redraw the cables. (window.postMessage is how pages in different frames
// talk to each other; the receiving page gets a "message" event.)
addEventListener("message", ev => {
  if (ev.data?.type === "shown" && !MOBILE) scheduleDraw();
  if (ev.data?.type === "focusSound") revealSound(ev.data.id);
});

// revealSound(id): bring a sound into view: expand its section if that is collapsed, zoom in a little if the
// canvas is zoomed far out, centre the canvas on the card, and flash it for a moment so the eye finds it.
// (Asked for by the campaign page's 🎯 buttons through the app shell.) Does nothing if the sound no longer exists.
function revealSound(id) {
  const loc = locate(id);
  if (!loc) return;
  const sec = S.sections.find(x => x.id === loc.tile.section);
  if (sec?.collapsed) {   // a collapsed section hides its cards: open it first
    sec.collapsed = false;
    save();
    render(true);
  }
  const card = cardEl(loc.snd);
  if (!card) return;
  const p = Canvas.posIn(card);
  if (Canvas.view.k < 0.7) Canvas.view.k = 0.9;   // zoomed far out: come in closer so the card is readable
  Canvas.centerOn(p.x + card.offsetWidth / 2, p.y + card.offsetHeight / 2);
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 2000);
}

// ------------------------------------------------------------------ boot
// Start-up. Everything above only defined functions and registered callbacks; this is where
// the app actually begins.

// loadAll(): start loading (downloading/decoding) every sound in the soundboard.
function loadAll() { allSounds().forEach(s => loadSound(s)); }

// An "async IIFE": define an anonymous async function and call it immediately, so we can use
// `await` at top level. Sequence: fetch state from the server -> normalise -> first render
// (cards appear, showing "loading…") -> kick off loading of all sounds in the background.
(async () => {
  // Turn #stage / #world into the pan-and-zoom canvas (not on phones, which use the plain page).
  // If there is no saved view from an earlier visit, frame all the tiles once they are drawn.
  const restored = MOBILE ? true : Canvas.mount($("#stage"), $("#world"), "soundboard");
  S = await api("/api/state");
  normalize();
  render();
  if (!restored) Canvas.fit();   // first visit: zoom/pan so every tile is in view
  loadAll(); // preload + decode everything up front so playback is instant
  startRepeatClock();   // begin the once-a-second heartbeat that fires repeat timers
  pollLibrary();        // fill the MP3-folder list now...
  setInterval(pollLibrary, 3000);   // ...and keep it current (also retries library sounds that had failed)
})();
