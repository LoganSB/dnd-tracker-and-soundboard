"use strict";
// =============================================================================
// mapview.js - the Map page: shows the map the DM loaded, and nothing else.
//
// WHAT IT SHOWS   GET /api/map says whether a map is loaded (name, kind, which encounter it came from, `at` = when it was loaded); GET /api/map/file is the picture or PDF.
//                 The page asks every 4 seconds and redraws only when `at` changes, so when the DM loads another map everybody's page changes by itself.
// A PICTURE       fits the window; click it (or tap) to see it at full size (scroll or drag to move), click again to fit. A PDF is shown in the browser's own PDF viewer.
// FULL SCREEN     the ⛶ button (or the F key) fills the screen with the map; Esc or F leaves.
// GRID            a Grid button cycles off / squares / hexes laid over a picture (not a PDF); a slider sets the cell size and a colour box the lines. It is each person's own
//                 (kept in this browser, localStorage "map.grid"), not shared. Cell size is in pixels of the picture itself, so the grid scales with it (fit or full size).
// THE DM          also gets a Clear map button. Loading a map is done from the Encounters tab's map list (static/maps.js).
// Needs ui.js and errors.js loaded first.
// =============================================================================
const { h, api } = UI;
const root = document.getElementById("map");
const isDM = document.body.dataset.role === "dm";
let full = false;   // full screen: the browser's own (when it allows it) or, failing that, the shell's header hidden
let grid = { kind: "off", size: 70, color: "#ffffff" };   // kind: off | square | hex; size = pixels of the picture itself (hex: flat side to flat side)
try { Object.assign(grid, JSON.parse(localStorage.getItem("map.grid") || "{}")); } catch (_) { /* storage blocked or damaged: defaults */ }
const saveGrid = () => { try { localStorage.setItem("map.grid", JSON.stringify(grid)); } catch (_) { /* storage blocked: it just is not remembered */ } };
const KINDS = { off: "▦ Grid: off", square: "▦ Grid: squares", hex: "⬢ Grid: hexes" };
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
  let view, redrawGrid = () => {};
  if (info.ext === ".pdf") view = h("iframe", { className: "mappdf", src: url, title: info.name });
  else {
    const img = h("img", { className: "mapimg fit", src: url, alt: info.name, title: "Click to see it at full size" });
    img.onclick = () => { img.classList.toggle("fit"); img.title = img.classList.contains("fit") ? "Click to see it at full size" : "Click to fit it to the window"; };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "mapgrid");
    view = h("div", { className: "mapscroll" }, img, svg);
    redrawGrid = () => drawGrid(svg, img, view);
    img.addEventListener("load", redrawGrid);
    if (window.ResizeObserver) { const ro = new ResizeObserver(redrawGrid); ro.observe(img); ro.observe(view); }
    gridControls(head, redrawGrid);
  }
  root.replaceChildren(head, view);
  redrawGrid();
}

// gridControls(head, redraw): the Grid button, the cell-size slider and the colour box in the bar; the last two only show while a grid is on.
function gridControls(head, redraw) {
  const size = h("input", { type: "range", min: 20, max: 400, value: grid.size, title: "Cell size" });
  const color = h("input", { type: "color", value: grid.color, title: "Line colour" });
  const btn = h("button", { className: "tiny", textContent: KINDS[grid.kind] || KINDS.off, title: "Lay a square or hex grid over the map (off / squares / hexes)" });
  const sync = () => { size.hidden = color.hidden = grid.kind === "off"; btn.textContent = KINDS[grid.kind]; };
  btn.onclick = () => { grid.kind = grid.kind === "off" ? "square" : grid.kind === "square" ? "hex" : "off"; sync(); saveGrid(); redraw(); };
  size.oninput = () => { grid.size = +size.value; saveGrid(); redraw(); };
  color.oninput = () => { grid.color = color.value; saveGrid(); redraw(); };
  if (!KINDS[grid.kind]) grid.kind = "off";
  sync();
  head.insertBefore(h("span", { className: "gridctl" }, btn, size, color), document.getElementById("fsBtn"));
}

// drawGrid(svg, img, view): put the grid exactly over the picture (wherever it sits in the scroll area) as an SVG pattern in the picture's own pixel units.
function drawGrid(svg, img, view) {
  const W = img.naturalWidth, H = img.naturalHeight;
  svg.style.display = grid.kind === "off" || !W ? "none" : "block";
  if (grid.kind === "off" || !W) return;
  Object.assign(svg.style, { left: img.offsetLeft + "px", top: img.offsetTop + "px", width: img.offsetWidth + "px", height: img.offsetHeight + "px" });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const n = Math.max(8, grid.size), sw = Math.max(1, Math.round(W / 700));   // line width stays readable on big pictures
  let pat;
  if (grid.kind === "square") pat = `<pattern id="g" stroke="${grid.color}" stroke-width="${sw}" stroke-opacity=".7" width="${n}" height="${n}" patternUnits="userSpaceOnUse"><path d="M${n} 0V${n}M0 ${n}H${n}" fill="none"/></pattern>`;
  else {   // pointy-top hexes: n = flat to flat width, r = corner to centre; the tile is two rows (3r high) of the honeycomb
    const w = n, r = n / Math.sqrt(3);
    pat = `<pattern id="g" stroke="${grid.color}" stroke-width="${sw}" stroke-opacity=".7" width="${w}" height="${3 * r}" patternUnits="userSpaceOnUse"><path fill="none" d="M${w / 2} 0L${w} ${r / 2}L${w} ${1.5 * r}L${w / 2} ${2 * r}L0 ${1.5 * r}L0 ${r / 2}ZM${w / 2} ${2 * r}V${3 * r}"/></pattern>`;
  }
  svg.innerHTML = `<defs>${pat}</defs><rect width="${W}" height="${H}" fill="url(#g)"/>`;
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
