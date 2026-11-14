"use strict";
// =============================================================================
// mapview.js - the Map page: shows the map the DM loaded, and nothing else.
//
// WHAT IT SHOWS   GET /api/map says whether a map is loaded (name, kind, which encounter it came from, `at` = when it was loaded); GET /api/map/file is the picture or PDF.
//                 The page asks every 4 seconds and redraws only when `at` changes, so when the DM loads another map everybody's page changes by itself.
// A PICTURE       fits the window; click it (or tap) to see it at full size (scroll or drag to move), click again to fit. A PDF is shown in the browser's own PDF viewer.
// FULL SCREEN     the ⛶ button (or the F key) fills the screen with the map; Esc or F leaves.
// THE DM          also gets a Clear map button. Loading a map is done from the Encounters tab's map list (static/maps.js).
// Needs ui.js and errors.js loaded first.
// =============================================================================
const { h, api } = UI;
const root = document.getElementById("map");
const isDM = document.body.dataset.role === "dm";
let full = false;   // full screen: the browser's own (when it allows it) or, failing that, the shell's header hidden
let shown = null;   // the `at` of what is on screen (null = not drawn yet; 0 = nothing loaded)

function empty() {
  root.replaceChildren(h("div", { className: "mapempty" }, h("h2", { textContent: "No map loaded" }),
    h("p", { className: "muted", textContent: isDM ? "Load one from the Encounters tab: open an encounter's Maps list and press 📍 Load." : "The DM has not loaded a map." })));
}

function draw(info) {
  const url = `/api/map/file?v=${info.at}`;   // (the number makes a new map replace the cached one)
  const head = h("div", { className: "maphead" }, h("b", { textContent: info.name }), h("span", { className: "muted", textContent: ` from ${info.encounter}` }),
    h("button", { className: "tiny", id: "fsBtn", textContent: full ? "✕ Exit full screen" : "⛶ Full screen", title: "Fill the whole screen with the map (Esc or F to leave)", onclick: () => toggleFull() }),
    isDM ? h("button", { className: "tiny danger", textContent: "Clear map", onclick: async () => { try { await api("/api/map", "DELETE"); poll(); } catch (e) { alert(e.message); } } }) : null);
  let view;
  if (info.ext === ".pdf") view = h("iframe", { className: "mappdf", src: url, title: info.name });
  else {
    const img = h("img", { className: "mapimg fit", src: url, alt: info.name, title: "Click to see it at full size" });
    img.onclick = () => { img.classList.toggle("fit"); img.title = img.classList.contains("fit") ? "Click to see it at full size" : "Click to fit it to the window"; };
    view = h("div", { className: "mapscroll" }, img);
  }
  root.replaceChildren(head, view);
}

// Full screen: the browser's own where it works (a computer, an Android phone), else the shell hides its header so this page fills the window (an iPhone cannot make a page
// full screen). Esc or F leaves it. While it is on, the bar with the name and buttons floats over the map's corner.
function setFull(on) {
  full = on;
  document.body.classList.toggle("full", on);
  const b = document.getElementById("fsBtn");
  if (b) b.textContent = on ? "✕ Exit full screen" : "⛶ Full screen";
}
async function toggleFull() {
  if (document.fullscreenElement) { await document.exitFullscreen(); return; }
  if (full) { setFull(false); parent.postMessage({ type: "mapFull", on: false }, location.origin); return; }
  try {
    if (!document.documentElement.requestFullscreen) throw new Error("no full screen here");
    await document.documentElement.requestFullscreen();   // (fullscreenchange below sets the look)
  } catch (_) {
    setFull(true);
    parent.postMessage({ type: "mapFull", on: true }, location.origin);
  }
}
document.addEventListener("fullscreenchange", () => setFull(!!document.fullscreenElement));
addEventListener("keydown", ev => {
  if (ev.target.closest?.("input, textarea, select")) return;
  if (ev.key === "f" || ev.key === "F") toggleFull();
  else if (ev.key === "Escape" && full && !document.fullscreenElement) toggleFull();   // (the browser handles Esc itself in its own full screen)
});

async function poll() {
  try {
    const info = await api("/api/map");
    const at = info.loaded ? info.at : 0;
    if (at === shown) return;
    shown = at;
    if (info.loaded) draw(info); else empty();
  } catch (_) { /* the server is restarting: try again next time */ }
}
poll();
setInterval(poll, 4000);
addEventListener("message", ev => { if (ev.data?.type === "shown") poll(); });   // the shell says when this tab is shown: look at once (a map may have just been loaded)
