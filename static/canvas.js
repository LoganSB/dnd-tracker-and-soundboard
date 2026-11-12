"use strict";
// =============================================================================
// canvas.js - an infinite pan-and-zoom canvas (in the style of ComfyUI), shared by the
//             soundboard and the campaign tracker
// =============================================================================
//
// THE IDEA
//   Instead of a page that scrolls, the board is a huge flat "world" (20000 x 20000 pixels) that
//   you look at through a window, the "stage". Every tile is a box placed at its own (x, y)
//   position in the world. You move the view by panning (dragging empty space) and change the
//   magnification by zooming (mouse wheel). The first tile goes in the middle of the world and
//   new tiles are placed in the nearest free spot around the others.
//
// HOW THE VIEW WORKS (the one CSS idea you need)
//   #world is a single element holding everything. To pan and zoom we never move the contents;
//   we put one CSS transform on #world:
//        transform: translate(view.x px, view.y px) scale(view.k)
//   That is exactly an affine transform, like the matrix you would multiply by in a graphics
//   program: a point at world position (wx, wy) appears on screen at
//        (view.x + wx * view.k,  view.y + wy * view.k)   relative to the stage's top-left corner.
//   toWorld() below is the inverse of that. Because the cable overlay (an SVG) lives INSIDE
//   #world, cables pan and zoom together with the tiles for free; they only need redrawing when
//   a tile moves or changes size.
//
// WHAT THIS FILE PROVIDES (everything hangs off the global `Canvas`):
//   Canvas.mount(stage, world, key)       turn the two elements into a pan/zoom canvas; returns true if it
//                                         restored a saved view
//   Canvas.toWorld(clientX, clientY)      screen position -> world position
//   Canvas.posIn(element)                 an element's top-left position in world coordinates
//   Canvas.itemRects(except)              the rectangles of all cards on the canvas
//   Canvas.freeSpot(...)                  find a free spot for a new card or frame, near a given group
//   Canvas.arrangeInGrid(...)             lay cards out in a tidy grid (used to convert older saves)
//   Canvas.layoutMissing(tiles, sections) give every tile that has no position one
//   Canvas.layoutFrames(model)            size the nested frames (section > tile > subsection) around their cards
//   Canvas.frameAt(rects, x, y)           which frame is a point inside (used when a card is dropped)
//   Canvas.dragItems(ev, items, hooks)    drag cards or whole frames around, with snapping
//   Canvas.fit()                          zoom/pan so everything is visible
//
// THE MODEL: the movable things are CARDS (sounds on the soundboard, flags on the campaign page). Each
// card has its own x, y. Tiles, subsections and sections are not boxes that hold cards: they are FRAMES
// drawn around the cards that belong to them (membership is just data: tile.sounds, sound.group ...). The
// frames are recomputed from the card positions every time, so they stretch and shrink as you move cards.
// Both pages use exactly the same code for this.
//
// A NOTE ON MEASURING
//   Positions inside the world are measured with offsetLeft/offsetTop (summed up the chain of
//   parent elements, see posIn). Those values ignore CSS transforms, so they are the same however
//   far you are zoomed in. getBoundingClientRect() would instead return screen pixels that change
//   with the zoom.
//
// This file creates its own private variables inside a function (an "IIFE"); only `Canvas` is
// visible to the other scripts, like the exported symbol of a C module.
const Canvas = (() => {
  const WORLD = 20000,           // world size in pixels (square)
    CENTER = WORLD / 2,          // the middle of the world: where the first tile goes
    MIN_K = 0.2,                 // zoom limits: 20% ...
    MAX_K = 2;                   // ... to 200%
  const TILE_W = 400, TILE_H = 300;      // size assumed for a tile that has no cards yet (older saves)
  const CARD_W = 190, CARD_H = 150;      // size assumed for a card that has not been measured yet

  // stage: the visible window. world: the big element inside it that we transform.
  // key: a name for this page, used to remember its view between visits.
  // view: x, y = where the world's top-left corner is on screen; k = zoom factor (1 = 100%).
  let stage = null,
    world = null,
    key = "board",
    label = null,
    spaceDown = false;
  const view = { x: 0, y: 0, k: 1 };

  // ---------------------------------------------------------------- view
  // apply(): push `view` into the page: the transform on #world, the zoom label, the dotted grid
  // background (which moves and scales with the view so it looks fixed to the world), and the
  // saved copy of the view in localStorage (a small per-site key/value store; every use is wrapped
  // in try/catch because it can throw in private mode).
  function apply() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    const grid = 28 * view.k;
    stage.style.backgroundSize = `${grid}px ${grid}px`;
    stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
    if (label) label.textContent = Math.round(view.k * 100) + "%";
    try { localStorage.setItem("view:" + key, JSON.stringify(view)); } catch (_) {}
  }

  // zoomAt(factor, cx, cy): multiply the zoom by `factor`, keeping the world point under the screen
  // position (cx, cy) (relative to the stage) where it is, so zooming feels anchored to the cursor.
  // Derivation: the world point under the cursor is (cx - view.x) / k. After the zoom it must still
  // satisfy cx = newX + worldPoint * newK, which gives the new view.x/y below.
  function zoomAt(factor, cx, cy) {
    const k = Math.min(MAX_K, Math.max(MIN_K, view.k * factor)),
      f = k / view.k;
    view.x = cx - (cx - view.x) * f;
    view.y = cy - (cy - view.y) * f;
    view.k = k;
    apply();
  }

  // toWorld(clientX, clientY): convert a mouse position (in browser-window pixels) to world coordinates.
  function toWorld(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  }

  // posIn(el): the top-left corner of `el` in world coordinates. offsetLeft/offsetTop are relative to
  // the element's "offset parent" (the nearest positioned ancestor), so we add them up the chain until
  // we reach #world. Unaffected by pan and zoom (see the note at the top).
  function posIn(el) {
    let x = 0,
      y = 0;
    for (let e = el; e && e !== world; e = e.offsetParent) {
      x += e.offsetLeft;
      y += e.offsetTop;
    }
    return { x, y };
  }

  // centerOn(wx, wy): pan so the world point (wx, wy) is in the middle of the stage (zoom unchanged).
  function centerOn(wx, wy) {
    view.x = stage.clientWidth / 2 - wx * view.k;
    view.y = stage.clientHeight / 2 - wy * view.k;
    apply();
  }

  // fit(): choose the zoom and position that show everything: every card and every top-level frame.
  // With nothing on the canvas, just look at the middle of the world at 100%.
  function fit() {
    const nodes = [...world.querySelectorAll("[data-iid], .frame.f-sec")].filter(n => n.offsetParent);
    if (!nodes.length) { view.k = 1; centerOn(CENTER, CENTER); return; }
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    nodes.forEach(n => {
      const p = posIn(n);
      l = Math.min(l, p.x); t = Math.min(t, p.y);
      r = Math.max(r, p.x + n.offsetWidth); b = Math.max(b, p.y + n.offsetHeight);
    });
    const pad = 80;
    // The largest zoom at which the box (plus padding) still fits in the stage, capped to 100% so a
    // single small card is not blown up.
    view.k = Math.min(1, Math.max(MIN_K, Math.min(stage.clientWidth / (r - l + 2 * pad), stage.clientHeight / (b - t + 2 * pad))));
    centerOn((l + r) / 2, (t + b) / 2);
  }

  // ------------------------------------------------------------- mounting
  // mount(stageEl, worldEl, storageKey): set everything up. Restores the saved view, or centres the
  // world's middle; adds the zoom buttons; and registers the wheel / pan listeners.
  //   Pan:  drag empty space, or hold Space and drag anywhere, or drag with the middle mouse button.
  //   Zoom: mouse wheel (anchored at the cursor), or the buttons, or Ctrl + wheel / pinch on a trackpad.
  //   Shift + wheel pans sideways instead.
  function mount(stageEl, worldEl, storageKey) {
    stage = stageEl;
    world = worldEl;
    key = storageKey;
    let restored = false;
    try {
      const s = JSON.parse(localStorage.getItem("view:" + key));
      if (s && isFinite(s.x) && isFinite(s.y) && isFinite(s.k)) { Object.assign(view, s); restored = true; }
    } catch (_) {}
    if (!restored) centerOn(CENTER, CENTER);

    // Small control box in the corner of the stage: zoom out, current zoom (click to reset to 100%),
    // zoom in, and Fit (show everything).
    label = document.createElement("button");
    label.title = "Reset zoom to 100%";
    const mk = (text, title, fn) => Object.assign(document.createElement("button"), { textContent: text, title, onclick: fn });
    const box = document.createElement("div");
    box.id = "zoomctl";
    const mid = () => [stage.clientWidth / 2, stage.clientHeight / 2];
    box.append(
      mk("−", "Zoom out", () => zoomAt(1 / 1.25, ...mid())),   // `...mid()` spreads the two numbers into two arguments
      label,
      mk("+", "Zoom in", () => zoomAt(1.25, ...mid())),
      mk("Fit", "Show everything", fit));
    // Snap toggle: when on, cards snap to the grid and align (left / centre / right and top / middle /
    // bottom) with other cards while you drag them. Holding Alt while dragging turns snapping off for that drag.
    snapBtn = document.createElement("button");
    snapBtn.onclick = () => setSnap(!snapOn);
    // The gear opens a small menu that says what snapping does: grid, other cards, and which cards.
    const menu = document.createElement("div");
    menu.id = "snapmenu";
    menu.hidden = true;
    menu.innerHTML = `
      <b>Snapping</b>
      <label><input type="checkbox" data-k="grid"> Snap to the grid</label>
      <label><input type="checkbox" data-k="cards"> Snap to other cards <span class="muted">(left / centre / right, top / middle / bottom)</span></label>
      <label>Cards to snap to
        <select data-k="scope">
          <option value="all">Every card</option>
          <option value="sec">Only cards in the same section</option>
          <option value="tile">Only cards in the same tile</option>
          <option value="sub">Only cards in the same subsection</option>
        </select>
      </label>
      <span class="muted">Hold Alt while dragging to skip snapping once.</span>`;
    // Show the saved choices in the controls, and save a choice as soon as it changes.
    menu.querySelectorAll("[data-k]").forEach(c => {
      const k = c.dataset.k;
      if (c.type === "checkbox") c.checked = !!snapCfg[k]; else c.value = snapCfg[k];
      c.addEventListener("change", () => {
        snapCfg[k] = c.type === "checkbox" ? c.checked : c.value;
        saveCfg();
      });
    });
    const gear = mk("⚙", "Snapping options", () => { menu.hidden = !menu.hidden; });
    box.append(snapBtn, gear);
    stage.append(menu);
    setSnap(snapOn);
    label.onclick = () => zoomAt(1 / view.k, ...mid());
    stage.append(box);
    const hint = document.createElement("div");
    hint.id = "canvashint";
    hint.textContent = "Drag empty space to pan · wheel to zoom · drag a card's top bar or a frame's title bar to move it (hold Alt to skip snapping)";
    stage.append(hint);
    apply();

    // Wheel: zoom around the cursor. The factor is an exponential of the wheel movement so that equal
    // wheel clicks always change the size by an equal percentage. `{ passive: false }` is required to
    // be allowed to call preventDefault (which stops the page itself from scrolling).
    stage.addEventListener("wheel", ev => {
      if (ev.target.closest?.("#zoomctl")) return;
      ev.preventDefault();
      if (ev.shiftKey) {                      // sideways pan
        view.x -= ev.deltaY || ev.deltaX;
        apply();
        return;
      }
      const r = stage.getBoundingClientRect();
      zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    // Space bar = temporary pan mode (ignored while typing in a box or a dialog is open).
    addEventListener("keydown", ev => {
      if (ev.code !== "Space" || ev.repeat || ev.target.closest?.("input,select,textarea,button,dialog")) return;
      spaceDown = true;
      document.body.classList.add("spacepan");
      ev.preventDefault();
    });
    addEventListener("keyup", ev => {
      if (ev.code !== "Space") return;
      spaceDown = false;
      document.body.classList.remove("spacepan");
    });
    addEventListener("blur", () => { spaceDown = false; document.body.classList.remove("spacepan"); });

    // Start of a pan. Conditions: the middle button anywhere; or the left button while Space is held; or
    // the left button on empty space (not on a card, a frame's title bar, or the controls).
    // This listener is in the "capture" phase (third argument true), so it runs BEFORE the handlers on
    // the tiles and, for middle-button / Space drags, can stop them from ever seeing the press.
    stage.addEventListener("pointerdown", ev => {
      const onThing = ev.target.closest?.("[data-iid],.frame > header,#zoomctl");
      const wants = ev.button === 1 || (ev.button === 0 && (spaceDown || !onThing));
      if (!wants) return;
      ev.preventDefault();                          // no text selection / native drag / middle-click autoscroll
      if (onThing) ev.stopPropagation();            // a Space-drag over a tile must not press the tile
      const start = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
      document.body.classList.add("panning");
      const move = e => {
        view.x = start.vx + (e.clientX - start.x);
        view.y = start.vy + (e.clientY - start.y);
        apply();
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        document.body.classList.remove("panning");
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    }, true);
    return restored;   // true if a view saved from an earlier visit was used (so the caller need not call fit())
  }

  // ------------------------------------------------------------- snapping
  // GRID matches the dots drawn in the background. snapOn is the toggle (remembered in localStorage).
  // SNAP_PX: how close, in SCREEN pixels, an edge must be to another edge or to a grid line to snap to it.
  const GRID = 28,
    SNAP_PX = 9;
  let snapOn = true,
    snapBtn = null;
  try { snapOn = localStorage.getItem("snap") !== "0"; } catch (_) {}
  // snapCfg: WHAT snapping does while it is on (the Snap button is the master switch, the menu behind the
  // gear next to it sets these):
  //   grid   snap a card's top-left corner to the background grid
  //   cards  line cards up with other cards (left / centre / right, top / middle / bottom)
  //   scope  which other cards count: "all" (every card), "sec" (same section), "tile" (same tile),
  //          "sub" (same subsection). The dragged card's own membership is what is compared.
  let snapCfg = { grid: true, cards: true, scope: "all" };
  try { Object.assign(snapCfg, JSON.parse(localStorage.getItem("snapCfg"))); } catch (_) {}
  // saveCfg(): remember snapCfg between visits.
  function saveCfg() { try { localStorage.setItem("snapCfg", JSON.stringify(snapCfg)); } catch (_) {} }

  // setSnap(on): turn snapping on or off and update the button and the saved setting.
  function setSnap(on) {
    snapOn = on;
    try { localStorage.setItem("snap", on ? "1" : "0"); } catch (_) {}
    if (snapBtn) {
      snapBtn.textContent = on ? "⊞ Snap: ON" : "⊞ Snap: OFF";
      snapBtn.classList.toggle("on-state", on);
      snapBtn.title = "Snap cards to the grid and to each other (left / centre / right, top / middle / bottom). Hold Alt while dragging to skip it for one move.";
    }
  }

  // snapAxis(lo, hi, others, loKey, hiKey, thr): find how far to nudge a moving span [lo, hi] along one
  // axis so that its low edge, high edge or centre lines up with the same of another card; failing that,
  // so that its low edge sits on a grid line (each only if enabled in snapCfg). `others` are rectangles; loKey/hiKey are "l","r" for the
  // horizontal axis and "t","b" for the vertical one; `thr` is the snapping distance in world pixels.
  // Returns { d, lines }: the nudge, and the coordinates of the alignment lines to draw as guides.
  function snapAxis(lo, hi, others, loKey, hiKey, thr) {
    const mid = (lo + hi) / 2;
    let best = null;
    (snapCfg.cards ? others : []).forEach(o => {   // card-to-card alignment only when that option is on
      // The three alignments: low edge to low edge, high edge to high edge, centre to centre.
      [[lo, o[loKey]], [hi, o[hiKey]], [mid, (o[loKey] + o[hiKey]) / 2]].forEach(([mine, theirs]) => {
        const d = theirs - mine;
        if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d };
      });
    });
    if (!best) return { d: snapCfg.grid ? Math.round(lo / GRID) * GRID - lo : 0, lines: [] };   // no neighbour close: snap to the grid (if that option is on)
    // Collect every alignment that now coincides, so all of them get a guide line.
    const lines = [];
    others.forEach(o => {
      [[lo, o[loKey]], [hi, o[hiKey]], [mid, (o[loKey] + o[hiKey]) / 2]].forEach(([mine, theirs]) => {
        if (Math.abs(theirs - (mine + best.d)) < 0.5) lines.push({ at: theirs, other: o });
      });
    });
    return { d: best.d, lines };
  }

  // guideLayer: an invisible full-size element inside the world that holds the alignment guide lines
  // (thin coloured lines) shown while a drag is snapping to other cards.
  let guideLayer = null;
  function clearGuides() { if (guideLayer) guideLayer.textContent = ""; }
  function drawGuides(vertical, horizontal, box) {
    if (!guideLayer) {
      guideLayer = document.createElement("div");
      guideLayer.id = "snapguides";
      world.append(guideLayer);
    }
    clearGuides();
    const px = 1 / view.k;   // one SCREEN pixel in world units, so the lines look the same thickness at every zoom
    const line = (l, t, w, h) => {
      const d = document.createElement("div");
      d.className = "snapguide";
      Object.assign(d.style, { left: l + "px", top: t + "px", width: w + "px", height: h + "px" });
      guideLayer.append(d);
    };
    vertical.forEach(g => line(g.at, Math.min(box.t, g.other.t), px, Math.max(box.b, g.other.b) - Math.min(box.t, g.other.t)));
    horizontal.forEach(g => line(Math.min(box.l, g.other.l), g.at, Math.max(box.r, g.other.r) - Math.min(box.l, g.other.l), px));
  }

  // ----------------------------------------------------------- measuring cards
  // itemRects(exceptIds): the rectangle { id, l, t, r, b } of every visible card on the canvas (elements
  // with a data-iid attribute), in world coordinates, skipping the ids in `exceptIds` (a Set).
  function itemRects(exceptIds = new Set()) {
    return [...world.querySelectorAll("[data-iid]")].filter(n => n.offsetParent && !exceptIds.has(n.dataset.iid)).map(n => {
      const p = posIn(n);
      // sec / tile / sub: which section, tile and subsection the card belongs to (set by the page as data
      // attributes); the snapping scope compares them.
      return { id: n.dataset.iid, sec: n.dataset.sec, tile: n.dataset.tile, sub: n.dataset.sub, l: p.x, t: p.y, r: p.x + n.offsetWidth, b: p.y + n.offsetHeight };
    });
  }

  // ------------------------------------------------------------ placement
  // overlaps(a, b, margin): do two rectangles { l, t, r, b } overlap, counting `margin` extra pixels
  // around them? (Two boxes are apart if one is entirely left of, right of, above or below the other.)
  const overlaps = (a, b, m) => !(a.r + m <= b.l || b.r + m <= a.l || a.b + m <= b.t || b.b + m <= a.t);

  // freeSpot(obstacles, w, h, nearRects): the free spot closest to the centre of `nearRects` (or of the
  // world when there are none) for a w x h box. Searches outward in square rings of grid cells (ring 0 is
  // the cell centred on that point, ring 1 the 8 cells around it, ring 2 the 16 around those ...), nearest
  // cells first within each ring, and takes the first cell that does not overlap any obstacle. That is what
  // puts the very first card in the middle and later ones in a neat spiral around their group.
  // Returns { x, y }, snapped to the grid when snapping is on.
  function freeSpot(obstacles, w, h, nearRects = []) {
    const near = nearRects.length
      ? { x: nearRects.reduce((s, r) => s + (r.l + r.r) / 2, 0) / nearRects.length, y: nearRects.reduce((s, r) => s + (r.t + r.b) / 2, 0) / nearRects.length }
      : { x: CENTER, y: CENTER };
    const stepX = w + 28,
      stepY = h + 28;
    for (let ring = 0; ring < 40; ring++) {
      const cells = [];
      for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++)
        if (Math.max(Math.abs(i), Math.abs(j)) === ring) cells.push([i, j]);
      cells.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));   // nearest first
      for (const [i, j] of cells) {
        let x = Math.round(near.x - w / 2 + i * stepX),
          y = Math.round(near.y - h / 2 + j * stepY);
        if (snapOn && snapCfg.grid) { x = Math.round(x / GRID) * GRID; y = Math.round(y / GRID) * GRID; }
        const box = { l: x, t: y, r: x + w, b: y + h };
        if (!obstacles.some(o => overlaps(box, o, 14))) return { x, y };
      }
    }
    return { x: Math.round(near.x - w / 2), y: Math.round(near.y - h / 2) };   // world is full: just stack it in the middle
  }

  // arrangeInGrid(origin, groups, w, h): give every card in `groups` (an array of arrays of card objects)
  // a position in a tidy grid starting at origin { x, y, w }: rows of as many w x h cards as fit in the
  // origin's width, one group after another with a gap between groups for the subsection frame headers.
  // Used to convert saves from the time when cards sat in a grid inside a tile.
  function arrangeInGrid(origin, groups, w, h) {
    const cols = Math.max(1, Math.floor(((origin.w || TILE_W) - 16 + 14) / (w + 14)));
    let y = origin.y + 56;
    groups.forEach(items => {
      if (!items.length) return;
      items.forEach((c, i) => {
        c.x = origin.x + 16 + (i % cols) * (w + 14);
        c.y = y + Math.floor(i / cols) * (h + 14);
      });
      y += Math.ceil(items.length / cols) * (h + 14) + 56;
    });
  }

  // layoutMissing(tiles, sections): position every tile that has no x, y yet (older saves keep theirs, a new
  // install has none). A tile's x, y is only used as the place of an EMPTY tile and as the origin when old
  // cards are converted to free positions. They go in section order so the tiles of a section sit together.
  function layoutMissing(tiles, sections) {
    const order = new Map(sections.map((s, i) => [s.id, i]));
    tiles.filter(t => !Number.isFinite(t.x) || !Number.isFinite(t.y))
      .sort((a, b) => (order.get(a.section) ?? 0) - (order.get(b.section) ?? 0))   // sort is stable, so ties keep their order
      .forEach(t => {
        const w = t.w || TILE_W,
          placed = tiles.filter(o => o !== t && Number.isFinite(o.x));
        const obstacles = placed.map(o => ({ l: o.x, t: o.y, r: o.x + (o.w || TILE_W), b: o.y + TILE_H }));
        const near = placed.filter(o => o.section === t.section).map(o => ({ l: o.x, t: o.y, r: o.x + (o.w || TILE_W), b: o.y + TILE_H }));
        Object.assign(t, freeSpot(obstacles, w, TILE_H, near));
        t.w = w;
      });
  }

  // ---------------------------------------------------------------- frames
  // Frames (section > tile > subsection) are boxes drawn behind the cards, sized to fit the cards that
  // belong to them. Their elements (class "frame", attribute data-fid) are created by the page; this
  // function only sets each one's left/top/width/height.
  //   Padding and title-bar height per level: a subsection hugs its cards, a tile hugs its cards and
  //   subsections, a section hugs its tiles.
  //   `head` is the title bar's height PLUS a gap below it, so the title bar never touches the frames or
  //   cards inside, and the title bars of nested frames never touch each other. MIN_W is the narrowest a
  //   frame may get, so its title bar (name and buttons) always fits on one line instead of being cut off.
  const LEVEL = { sub: { pad: 16, head: 60 }, tile: { pad: 22, head: 72 }, sec: { pad: 28, head: 72 } };
  const MIN_W = { sub: 260, tile: 440, sec: 400 };
  const EMPTY = { sub: [250, 80], tile: [320, 110], sec: [360, 110] };   // size of a frame that holds nothing yet

  // layoutFrames(model): `model` describes the nesting:
  //   { sections: [ { id, obj, collapsed, tiles: [ { id, obj, items: [card objects], subs:
  //       [ { id, obj, items: [card objects] } ] } ] } ] }
  // where `obj` is the saved data object of that level (it may hold x, y, used only while the frame is
  // empty) and each card object has id, x, y. The frame element for each is found by data-fid ("sec:ID",
  // "tile:ID", "sub:TILEID:SUBID"). Returns { fid: { l, t, r, b } } for every frame, in world coordinates.
  // A collapsed section hides its tiles and subsections and shrinks to just its title bar.
  // With dry = true nothing on the page or in the data is touched: it only computes and returns the
  // rectangles (used to ask "where WOULD the frames be without this card?" when a card is dropped).
  function layoutFrames(model, dry = false) {
    const rects = {};
    const cardRect = c => {
      const n = world.querySelector(`[data-iid="${c.id}"]`);
      return { l: c.x, t: c.y, r: c.x + (n?.offsetWidth || CARD_W), b: c.y + (n?.offsetHeight || CARD_H) };
    };
    const union = rs => ({ l: Math.min(...rs.map(r => r.l)), t: Math.min(...rs.map(r => r.t)), r: Math.max(...rs.map(r => r.r)), b: Math.max(...rs.map(r => r.b)) });
    // grow(r, lv, kind): the frame around rectangle r: padding on the sides and bottom, title-bar room on top,
    // and at least the level's minimum width.
    const grow = (r, lv, kind) => {
      const f = { l: r.l - lv.pad, t: r.t - lv.head, r: r.r + lv.pad, b: r.b + lv.pad };
      f.r = Math.max(f.r, f.l + MIN_W[kind]);
      return f;
    };
    // setFrame(fid, r, visible): position the frame element. Hidden frames (inside a collapsed section) get display:none.
    const setFrame = (fid, r, visible = true) => {
      const f = world.querySelector(`.frame[data-fid="${fid}"]`);
      if (!f || dry) return;
      f.style.display = visible ? "" : "none";
      Object.assign(f.style, { left: r.l + "px", top: r.t + "px", width: r.r - r.l + "px", height: r.b - r.t + "px" });
    };
    // placeholder(obj, kind, at): the rectangle of an EMPTY frame: where it was last (obj.x, obj.y), or `at` the first time.
    const placeholder = (obj, kind, at) => {
      const x = Number.isFinite(obj.x) ? obj.x : at.x,
        y = Number.isFinite(obj.y) ? obj.y : at.y;
      if (!dry) { obj.x = x; obj.y = y; }
      return { l: x, t: y, r: x + EMPTY[kind][0], b: y + EMPTY[kind][1] };
    };
    model.sections.forEach(sec => {
      const tileRects = [];
      sec.tiles.forEach(tile => {
        const loose = tile.items.map(cardRect),
          subRects = [],
          looseBox = loose.length ? union(loose) : null;
        tile.subs.forEach(sub => {
          const rs = sub.items.map(cardRect);
          // An empty subsection is parked just under the tile's own cards (or at the tile's corner).
          const at = looseBox ? { x: looseBox.l, y: looseBox.b + 24 } : { x: (tile.obj.x ?? CENTER) + LEVEL.tile.pad, y: (tile.obj.y ?? CENTER) + LEVEL.tile.head };
          const r = rs.length ? grow(union(rs), LEVEL.sub, "sub") : placeholder(sub.obj, "sub", at);
          if (rs.length && !dry) { sub.obj.x = r.l; sub.obj.y = r.t; }   // remembered in case it is emptied later
          rects[`sub:${tile.id}:${sub.id}`] = r;
          subRects.push(r);
          setFrame(`sub:${tile.id}:${sub.id}`, r, !sec.collapsed);
        });
        const parts = [...loose, ...subRects];
        const r = parts.length ? grow(union(parts), LEVEL.tile, "tile") : placeholder(tile.obj, "tile", { x: CENTER - 160, y: CENTER - 50 });
        if (parts.length && !dry) { tile.obj.x = r.l; tile.obj.y = r.t; }
        rects[`tile:${tile.id}`] = r;
        tileRects.push(r);
        setFrame(`tile:${tile.id}`, r, !sec.collapsed);
      });
      let r;
      if (sec.collapsed) {
        // Just a title bar, at the top-left of where its tiles are.
        const base = tileRects.length ? union(tileRects) : placeholder(sec.obj, "sec", { x: CENTER - 180, y: CENTER - 50 });
        r = { l: base.l - LEVEL.sec.pad, t: base.t - LEVEL.sec.head, r: base.l - LEVEL.sec.pad + EMPTY.sec[0], b: base.t - LEVEL.sec.head + 56 };
      } else {
        r = tileRects.length ? grow(union(tileRects), LEVEL.sec, "sec") : placeholder(sec.obj, "sec", { x: CENTER - 180, y: CENTER - 50 });
      }
      if (tileRects.length && !dry) { sec.obj.x = r.l; sec.obj.y = r.t; }
      rects[`sec:${sec.id}`] = r;
      setFrame(`sec:${sec.id}`, r, true);
    });
    return rects;
  }

  // frameAt(rects, cx, cy): the id of the innermost frame containing the point (cx, cy), or null.
  // Subsections beat tiles, tiles beat sections. Used when a card is dropped, to decide which tile (and
  // subsection) it now belongs to.
  function frameAt(rects, cx, cy) {
    let best = null;
    for (const kind of ["sub", "tile", "sec"]) {
      for (const [fid, r] of Object.entries(rects)) {
        if (fid.startsWith(kind + ":") && cx > r.l && cx < r.r && cy > r.t && cy < r.b) { best = fid; break; }
      }
      if (best) return best;
    }
    return null;
  }

  // scopedRects(items): the rectangles of the cards the dragged `items` may snap to, according to
  // snapCfg.scope: every card, or only those in the same section / tile / subsection as the first dragged
  // card. The cards being dragged themselves are never included.
  function scopedRects(items) {
    const all = itemRects(new Set(items.map(it => it.obj.id)));
    if (snapCfg.scope === "all") return all;
    const mine = items.find(it => it.el)?.el.dataset[snapCfg.scope];   // e.g. dataset.tile = the id of the dragged card's tile
    return mine === undefined ? all : all.filter(r => r[snapCfg.scope] === mine);
  }

  // ------------------------------------------------------------- dragging
  // dragItems(ev, items, hooks): drag one or more things with the pointer: a single card, or all the
  // cards of a tile/section when its frame's title bar is dragged. `items` is a list of { obj, el } where
  // obj has x and y fields (a card, or an empty frame's data) and el is its element. Hooks (all optional):
  //   onStart()      called once when the drag begins
  //   onMove()       called after every position change (used to re-fit frames and redraw cables)
  //   onEnd(moved)   called when the button is released; `moved` says whether it really moved
  //   others()       returns the rectangles of cards to align with (default: every card not being moved)
  // The pointer moves in screen pixels but the world is zoomed, so movement is divided by view.k.
  // A tiny movement (under 3 px) counts as a click, not a drag. While snapping is on (and Alt is not
  // held) the dragged group's bounding box snaps to other cards' left / centre / right and top / middle /
  // bottom, or failing that to the grid, and thin guide lines show what it lined up with.
  function dragItems(ev, items, hooks = {}) {
    ev.preventDefault();
    const sx = ev.clientX,
      sy = ev.clientY,
      starts = items.map(it => ({ it, x: it.obj.x, y: it.obj.y, w: it.el?.offsetWidth || 0, h: it.el?.offsetHeight || 0 }));
    // The bounding box of everything being moved, at the start of the drag.
    const box0 = {
      l: Math.min(...starts.map(q => q.x)), t: Math.min(...starts.map(q => q.y)),
      r: Math.max(...starts.map(q => q.x + q.w)), b: Math.max(...starts.map(q => q.y + q.h))
    };
    let others = null,
      moved = false;
    const move = e => {
      if (!moved) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 3) return;
        moved = true;
        hooks.onStart?.();
        items.forEach(it => it.el?.classList.add("dragging-node"));
        others = hooks.others ? hooks.others() : scopedRects(items);
      }
      let dx = (e.clientX - sx) / view.k,
        dy = (e.clientY - sy) / view.k;
      if (snapOn && !e.altKey && (snapCfg.grid || snapCfg.cards)) {
        const thr = SNAP_PX / view.k;
        const sxn = snapAxis(box0.l + dx, box0.r + dx, others, "l", "r", thr),
          syn = snapAxis(box0.t + dy, box0.b + dy, others, "t", "b", thr);
        dx += sxn.d;
        dy += syn.d;
        drawGuides(sxn.lines, syn.lines, { l: box0.l + dx, t: box0.t + dy, r: box0.r + dx, b: box0.b + dy });
      } else clearGuides();
      starts.forEach(({ it, x, y }) => {
        it.obj.x = Math.round(x + dx);
        it.obj.y = Math.round(y + dy);
        if (it.el) { it.el.style.left = it.obj.x + "px"; it.el.style.top = it.obj.y + "px"; }
      });
      hooks.onMove?.();
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      items.forEach(it => it.el?.classList.remove("dragging-node"));
      clearGuides();
      hooks.onEnd?.(moved);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }

  return { WORLD, CENTER, CARD_W, CARD_H, mount, toWorld, posIn, itemRects, freeSpot, arrangeInGrid, layoutMissing, layoutFrames, frameAt, dragItems, fit, centerOn, view };
})();
