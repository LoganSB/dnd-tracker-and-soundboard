"use strict";
// =============================================================================
// cables.js - drawing cables (curved or routed SVG paths) between two points
// =============================================================================
//
// WHAT THIS IS
//   The geometry helpers used to draw the "cables" that connect items: the soundboard's chains
//   (app.js) and the campaign tracker's links (campaign.js). They were moved out of app.js so both
//   pages share one copy. Nothing here touches the page: every function takes points / rectangles
//   and returns an SVG path description (the text that goes in a path's "d" attribute).
//
//   live(a, b)                        the cable shown while one is being dragged to the pointer at b
//   paths(links, cards, W, H)         the final paths for ALL cables: routed and bundled, with fallbacks
//   pair(layer, d, opts)              add one cable to an SVG layer: the visible path plus a wide invisible click target
//   tempPath(layer)                   add the rubber-band path used while dragging
//   bezier(a, b)                      a smooth S-curve from a to b
//   routed(a, b, sa, sb, W)           fallback path when b is not to the right of a
//   roundPoly(points, radius)         a polyline with rounded corners
//   routeCables(links, cards, W, H)   tidy orthogonal routes for many cables at once, around obstacles
//   SVGNS                             the namespace needed to create SVG elements from JavaScript
//
// Like canvas.js this is wrapped in an immediately-invoked function: only the names in the final
// `return` are visible to other scripts (as exports of a C module would be).
const Cables = (() => {
// The XML namespace needed to create SVG elements from JavaScript (plain createElement would
// make unknown HTML elements instead of drawable SVG shapes).
const SVGNS = "http://www.w3.org/2000/svg";

// bezier(a, b): an SVG path string for a smooth curve from point a to point b, each {x, y}.
// SVG path commands: M x,y = "move pen to"; C c1 c2 end = cubic Bezier curve with two control
// points. Control points sit horizontally off each end so the cable leaves a to the right and
// enters b from the left. k = how far they stick out (6..60 px, shrinking for short cables).
function bezier(a, b) { // gentle S-curve: leaves a to the right, enters b from the left (control arms never overshoot)
  const k = Math.min(60, Math.max(6, (b.x - a.x) / 2));
  return `M${a.x},${a.y} C${a.x + k},${a.y} ${b.x - k},${b.y} ${b.x},${b.y}`;
}

// routed(a, b, sa, sb, W): FALLBACK path for a cable whose target is not to the right of its
// source (used if routeCables() fails or finds no route). It leaves a to the right, runs along
// a horizontal channel between the two cards (yb), and comes in from the left, with rounded corners.
//   a, b    start / end points {x, y}
//   sa, sb  vertical extents {top, bottom} of the source / target card
//   W       page width, to keep the path on the page
// Returns an SVG path string. L = line-to command; Q = quadratic curve (one control point,
// used here to round each corner).
// Targets that are not to the right: leave right, run through the gutters / row gaps, enter from the left.
// Rounded orthogonal path, so it never loops and never leaves the page.
function routed(a, b, sa, sb, W) {
  const R = 14,
    ax = Math.min(a.x + R, W - 6),
    bx = Math.max(b.x - R, 6);
  // yb: the y of the horizontal run: midway between the cards if they do not overlap
  // vertically, otherwise just below the lower of the two.
  const yb = sb.top > sa.bottom
    ? (sa.bottom + sb.top) / 2
    : sa.top > sb.bottom
      ? (sa.top + sb.bottom) / 2
      : Math.max(sa.bottom, sb.bottom) + 12;
  // The corner points of the path: out, down/up, across, down/up, in.
  const pts = [[a.x, a.y], [ax, a.y], [ax, yb], [bx, yb], [bx, b.y], [b.x, b.y]];
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    // Destructuring arrays: `const [px, py] = pts[i-1]` unpacks a 2-element array into two names.
    const [px, py] = pts[i - 1],
      [cx, cy] = pts[i],
      [nx, ny] = pts[i + 1];
    // r = corner radius, limited to half of each adjoining segment so curves never overlap.
    const r = Math.min(R, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    // u(x, y, tx, ty): unit vector (length 1) pointing from (x,y) toward (tx,ty).
    const u = (x, y, tx, ty) => {
      const l = Math.hypot(tx - x, ty - y) || 1;   // `|| 1` avoids dividing by zero
      return [(tx - x) / l, (ty - y) / l];
    };
    const [ix, iy] = u(cx, cy, px, py),   // direction back toward the previous point
      [ox, oy] = u(cx, cy, nx, ny);       // direction on toward the next point
    // Straight line to just before the corner, then a quadratic curve through the corner
    // point (as the control point) to just after it.
    d += ` L${cx + ix * r},${cy + iy * r} Q${cx},${cy} ${cx + ox * r},${cy + oy * r}`;
  }
  return d + ` L${b.x},${b.y}`;
}

// ---- cable routing: orthogonal paths that go around sound cards, bundled like parallel cables.
// Routing graph = intersections of lines running just outside every card edge (so there are several lanes per
// gutter) plus each port's own height. Dijkstra with a turn penalty finds each cable's path.

// roundPoly(pts, R): turn a list of corner points [[x,y], ...] (straight horizontal/vertical
// segments) into one SVG path string with each corner rounded to radius R. Same corner-rounding
// idea as routed() above, but returns the path through every point, however many there are.
function roundPoly(pts, R = 7) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1],
      [cx, cy] = pts[i],
      [nx, ny] = pts[i + 1];
    const r = Math.min(R, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    const u = (x, y, tx, ty) => {
      const l = Math.hypot(tx - x, ty - y) || 1;
      return [(tx - x) / l, (ty - y) / l];
    };
    const [ix, iy] = u(cx, cy, px, py),
      [ox, oy] = u(cx, cy, nx, ny);
    d += ` L${cx + ix * r},${cy + iy * r} Q${cx},${cy} ${cx + ox * r},${cy + oy * r}`;
  }
  const last = pts.at(-1);   // .at(-1) = last element (negative index counts from the end)
  return d + ` L${last[0]},${last[1]}`;
}

// routeCables(links, cards, W, H): choose a tidy path for every cable.
//   links - array of { a:{x,y} start port, b:{x,y} end port, sx, ex (x of the lanes just
//           outside the source / target card), ... } built by drawLinks()
//   cards - array of { l, r, t, b } rectangles (left/right/top/bottom) of every sound card
//   W, H  - page size in pixels
// Returns an array (same order as links) of SVG path strings, or null entries for cables
// that could not be routed (the caller then falls back to bezier()/routed()).
//
// HOW IT WORKS, IN PLAIN TERMS
//  1. Build a grid of candidate lines. Draw a vertical line just left and just right of every
//     card, and a horizontal line just above and below every card, plus lines at each port's
//     height. Where these cross, we get "intersections" (nodes). Roads between neighbouring
//     intersections (edges) are usable unless they pass through a card.
//  2. For each cable, run Dijkstra's shortest-path algorithm on that road map. The state is
//     (intersection, direction of travel) so we can charge a penalty (TURN) for every bend;
//     the result is a short path with few corners rather than a staircase.
//  3. Cleanup: remove redundant points so each path is a clean alternating
//     horizontal/vertical polyline.
//  4. Lane bundling: several cables often end up sharing exactly the same road. Instead of
//     drawing them on top of each other, find overlapping collinear segments, group them,
//     and shift each cable in the group sideways by a few pixels so they run side by side
//     like a ribbon cable. The cable's first and last segments stay fixed so they still hit
//     their ports.
//  5. Round the corners with roundPoly().
function routeCables(links, cards, W, H) {
  // E = how far (px) a card's collision box is grown; TURN = cost of one bend (in px of
  // detour we would accept to avoid it); GAP = distance of the guide lines from card edges;
  // q = round a number to 2 decimals so equal coordinates compare equal as Map/Set keys.
  const E = 2,
    TURN = 28,
    GAP = 12,
    q = v => +v.toFixed(2);

  // --- Step 1: collect the x positions (xs) and y positions (ys) of all guide lines.
  const xs = new Set([8, q(W - 8)]),
    ys = new Set([8, q(H - 8)]);   // a Set removes duplicate coordinates automatically
  cards.forEach(r => {
    xs.add(q(r.l - GAP));
    xs.add(q(r.r + GAP));
    ys.add(q(r.t - GAP));
    ys.add(q(r.b + GAP));
  });
  links.forEach(l => {
    ys.add(q(l.a.y));
    ys.add(q(l.b.y));
    xs.add(q(l.sx));
    xs.add(q(l.ex));
  });
  // X and Y: the sorted, in-bounds line coordinates as arrays. `[...set]` (spread) copies a Set into an
  // array; sort with (m, n) => m - n is a numeric ascending sort.
  const X = [...xs].filter(v => v >= 0 && v <= W).sort((m, n) => m - n),
    Y = [...ys].filter(v => v >= 0 && v <= H).sort((m, n) => m - n);
  // nx, ny: number of vertical / horizontal lines. xi, yi: coordinate -> index lookup tables.
  const nx = X.length,
    ny = Y.length,
    xi = new Map(X.map((v, i) => [v, i])),
    yi = new Map(Y.map((v, i) => [v, i]));
  // hFree[j][i] = 1 if the road from intersection (i,j) to (i+1,j) is open; vFree[i][j] likewise
  // for (i,j)-(i,j+1). Uint8Array is a compact byte array (like unsigned char[]); fill(1) =
  // "everything open for now". Array.from({length: n}, fn) builds an array of n entries by calling fn.
  const hFree = Array.from({ length: ny }, () => new Uint8Array(nx - 1).fill(1));   // edge (i,j)-(i+1,j)
  const vFree = Array.from({ length: nx }, () => new Uint8Array(ny - 1).fill(1));   // edge (i,j)-(i,j+1)
  // firstAbove(arr, v): binary search in a sorted array: index of the first element > v.
  const firstAbove = (arr, v) => {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;   // >> 1 = integer divide by two
      arr[m] > v ? (hi = m) : (lo = m + 1);   // ternary used as a statement (if/else in one expression)
    }
    return lo;
  };
  // Block the roads that run through a card: for each card, clear the "free" flag on every
  // horizontal road that crosses its box and every vertical road that crosses it.
  cards.forEach(r => {
    const L = r.l - E,
      R = r.r + E,
      T = r.t - E,
      B = r.b + E;
    for (let j = firstAbove(Y, T); j < ny && Y[j] < B; j++)
      for (let i = Math.max(0, firstAbove(X, L) - 1); i < nx - 1 && X[i] < R; i++)
        if (X[i + 1] > L) hFree[j][i] = 0;
    for (let i = firstAbove(X, L); i < nx && X[i] < R; i++)
      for (let j = Math.max(0, firstAbove(Y, T) - 1); j < ny - 1 && Y[j] < B; j++)
        if (Y[j + 1] > T) vFree[i][j] = 0;
  });

  // Directions are numbered 0..3 = right, left, down, up. DX/DY are the step in each direction.
  // Note that direction n and n^1 (XOR 1) are opposites: 0<->1 and 2<->3.
  const DX = [1, -1, 0, 0],
    DY = [0, 0, 1, -1];

  // route(l): Dijkstra for one cable. Returns the list of [x, y] intersection points from its
  // start to its end, or null if no route exists.
  const route = l => {
    // Find the start and end intersections of this cable in the grid.
    const si = xi.get(q(l.sx)),
      sj = yi.get(q(l.a.y)),
      ei = xi.get(q(l.ex)),
      ej = yi.get(q(l.b.y));
    if (si == null || sj == null || ei == null || ej == null) return null;   // `== null` is true for both null and undefined
    // A search "state" is (intersection, arrival direction), packed into one integer:
    // state = (j*nx + i)*4 + direction. dist[state] = best cost found so far (Float64Array
    // = double[]); prev[state] = the state we came from (-1 = none), used to rebuild the path.
    const N = nx * ny * 4,
      dist = new Float64Array(N).fill(Infinity),
      prev = new Int32Array(N).fill(-1);
    // The priority queue: a binary min-heap kept in a plain array of [cost, state] pairs. It
    // always lets us take the cheapest unexplored state next.
    const heap = []; // [cost, state]

    // push(it): add an item to the heap, then "sift up": swap with the parent while the parent
    // costs more. Parent of index i is (i - 1) >> 1. `[x, y] = [y, x]` swaps two values.
    const push = it => {
      heap.push(it);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };

    // pop(): remove and return the cheapest item (the root). Move the last item to the root,
    // then "sift down": swap it with the cheaper child until neither child is cheaper.
    // Children of index i are 2i+1 and 2i+2.
    const pop = () => {
      const top = heap[0],
        last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (; ;) {
          let m = i;   // m = index of the smallest among i and its two children
          const a = 2 * i + 1,
            b = a + 1;
          if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
          if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };

    // id(i, j, d): pack (column, row, direction) into a single state number.
    const id = (i, j, d) => (j * nx + i) * 4 + d;
    // Start at the source with cost 0. (Direction 0 = "heading right", as a cable leaves a card.)
    dist[id(si, sj, 0)] = 0;
    push([0, id(si, sj, 0)]);

    while (heap.length) {
      const [c, st] = pop();   // c = cost to reach this state, st = the state
      if (c > dist[st]) continue;   // stale queue entry: a cheaper way was already found
      // Unpack the state: d = direction, cell = intersection number, then column i / row j.
      // `| 0` truncates a float to an integer (like a C cast).
      const d = st & 3,
        cell = st >> 2,
        i = cell % nx,
        j = (cell / nx) | 0;
      if (i === ei && j === ej) { // rebuild vertices
        // Reached the goal: walk the prev[] chain backwards to collect the corner points, then reverse.
        const pts = [];
        for (let s2 = st; s2 !== -1; s2 = prev[s2]) {
          const k = s2 >> 2;
          pts.push([X[k % nx], Y[(k / nx) | 0]]);
        }
        return pts.reverse();
      }
      // Try to move one step in each of the four directions.
      for (let nd = 0; nd < 4; nd++) {
        if ((nd ^ 1) === d && st !== id(si, sj, 0)) continue; // no U-turns (0<->1, 2<->3)
        if (nd === 1 && st === id(si, sj, 0)) continue;       // first move can't go back into the source card
        const ni = i + DX[nd],
          nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;   // off the grid
        // Is the road in that direction open? (Horizontal moves check hFree, vertical ones vFree.)
        if (nd < 2 ? !hFree[j][Math.min(i, ni)] : !vFree[i][Math.min(j, nj)]) continue;
        // Cost of the step = its length + TURN if the direction changed + another TURN if the
        // final approach is not heading right (cables should enter a port from the left).
        const len = Math.abs(X[ni] - X[i]) + Math.abs(Y[nj] - Y[j]);
        let cost = c + len + (nd !== d ? TURN : 0) + (ni === ei && nj === ej && nd !== 0 ? TURN : 0);
        const ns = id(ni, nj, nd);
        if (cost < dist[ns]) {   // better than anything known for that state: record and queue it
          dist[ns] = cost;
          prev[ns] = st;
          push([cost, ns]);
        }
      }
    }
    return null;   // heap ran dry: the goal is unreachable
  };

  // --- Step 2 and 3: route every cable, then tidy each path.
  const paths = links.map(l => {
    const mid = route(l);
    if (!mid) return null;
    // Add the exact port positions at both ends (the grid points are lane positions just outside the cards).
    const pts = [[l.a.x, l.a.y], ...mid, [l.b.x, l.b.y]];
    // drop collinear / duplicate vertices so segments alternate horizontal / vertical
    const out = [pts[0]];
    for (let k = 1; k < pts.length - 1; k++) {
      // (px,py) = last kept point, (cx,cy) = candidate, (nx2,ny2) = the point after it.
      const [px, py] = out.at(-1),
        [cx, cy] = pts[k],
        [nx2, ny2] = pts[k + 1];
      if (Math.abs(cx - px) < 0.01 && Math.abs(cy - py) < 0.01) continue;   // duplicate point
      // If the previous, this and the next point are in a straight line, this one is redundant.
      if ((Math.abs(cy - py) < 0.01 && Math.abs(ny2 - cy) < 0.01) || (Math.abs(cx - px) < 0.01 && Math.abs(nx2 - cx) < 0.01)) continue;
      out.push(pts[k]);
    }
    out.push(pts.at(-1));
    return out;
  });

  // --- Step 4: lane bundling.
  // bundle: collinear overlapping segments from different cables become parallel lanes
  // First, list every straight segment of every path as an object:
  //   li = which cable, k = segment index within it, h = horizontal?, c = its fixed coordinate
  //   (y if horizontal, x if vertical), a..b = the range it spans along the other axis,
  //   off = sideways shift we will compute, fixed = first/last segment (attached to a port).
  const segs = [];
  paths.forEach((pts, li) => {
    if (!pts) return;
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, y0] = pts[k],
        [x1, y1] = pts[k + 1],
        h = Math.abs(y1 - y0) < 0.01;
      segs.push({
        li,
        k,
        h,
        c: h ? y0 : x0,
        a: h ? Math.min(x0, x1) : Math.min(y0, y1),
        b: h ? Math.max(x0, x1) : Math.max(y0, y1),
        off: 0,
        fixed: k === 0 || k === pts.length - 2
      });
    }
  });
  // Union-find ("disjoint set"): par[i] is the parent of segment i; find() follows parents to
  // the group's representative (with path compression, halving the chain as it goes). Merging
  // two groups = pointing one representative at the other.
  const par = segs.map((_, i) => i),
    find = i => {
      while (par[i] !== i) {
        par[i] = par[par[i]];
        i = par[i];
      }
      return i;
    };
  // Compare every pair of segments (O(n^2), fine for the small counts here); join those that
  // lie on the same line (same orientation, same coordinate within 0.5 px) and overlap by
  // more than 1 px along it. Segments of the same cable, and fixed port segments, never join.
  for (let m = 0; m < segs.length; m++)
    for (let n = m + 1; n < segs.length; n++) {
      const u = segs[m],
        v = segs[n];
      if (u.fixed || v.fixed || u.li === v.li || u.h !== v.h || Math.abs(u.c - v.c) > 0.5) continue;
      if (Math.min(u.b, v.b) - Math.max(u.a, v.a) > 1) par[find(m)] = find(n);
    }
  // Collect the groups: representative -> list of its segments. `(a || b)` picks the existing
  // list, or creates and stores a new empty one (Map.set returns the Map, so .get(r) fetches it).
  const groups = new Map();
  segs.forEach((sg, i) => {
    if (!sg.fixed) {
      const r = find(i);
      (groups.get(r) || groups.set(r, []).get(r)).push(sg);
    }
  });
  // For each group of n different cables, spread them evenly around the shared line:
  // offsets are centred on 0 and `gap` apart (at most 5 px; squeezed so the whole ribbon stays within 10 px).
  groups.forEach(g => {
    const ids = [...new Set(g.map(sg => sg.li))].sort((m, n) => m - n),
      n = ids.length;
    if (n < 2) return;
    const gap = Math.min(5, 10 / (n - 1));
    g.forEach(sg => (sg.off = (ids.indexOf(sg.li) - (n - 1) / 2) * gap));
  });

  // --- Step 5: rebuild each path with the lane offsets applied, and round the corners.
  return paths.map((pts, li) => {
    if (!pts) return null;
    // NB: this local `S` (this cable's segments) shadows the global state object S inside this callback only.
    const S = segs.filter(sg => sg.li === li).sort((m, n) => m.k - n.k);
    const out = [pts[0]];
    // A corner of the cable is where two consecutive segments meet: its x comes from the
    // vertical segment's lane, its y from the horizontal one's lane (each shifted by its offset).
    for (let k = 0; k < S.length - 1; k++) {
      const u = S[k],
        v = S[k + 1];
      out.push(u.h ? [v.c + v.off, u.c + u.off] : [u.c + u.off, v.c + v.off]);
    }
    out.push(pts.at(-1));
    return roundPoly(out, 7);
  });
}


// live(a, b): the cable drawn while dragging from a (the output circle) to the pointer b. Unlike bezier() it keeps following the
// pointer when that is BEHIND the start (to its left): longer arms make a smooth S that loops back, instead of squashing into a
// slightly slanted line. For a pointer well to the right it is exactly bezier().
function live(a, b) {
  const dx = b.x - a.x;
  const k = dx >= 80 ? Math.min(60, dx / 2) : Math.min(160, 40 + (80 - dx) / 2);
  return `M${a.x},${a.y} C${a.x + k},${a.y} ${b.x - k},${b.y} ${b.x},${b.y}`;
}

// tempPath(layer): the rubber-band path shown while a cable is dragged (class "link temp", with the arrowhead). The caller
// sets its "d" on every pointer move and removes it at the end.
function tempPath(layer) {
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("class", "link temp");
  p.setAttribute("marker-end", "url(#arr)");
  layer.append(p);
  return p;
}

// paths(links, cards, W, H): the SVG path for every cable, in the order of `links`. Each link is { a, b, sx, ex, cs, ct }:
// a / b the port positions, sx / ex the x of the lanes just outside the source / target item, cs / ct their { t, b } extents.
// `cards` are the obstacles. All cables are routed TOGETHER by routeCables, so cables that share a road run side by side as
// lanes instead of stacking on top of each other (the soundboard and the campaign tracker both draw their cables this way).
// A cable the router cannot place falls back to a plain curve (target to the right) or the routed() U-turn.
function paths(links, cards, W, H) {
  let routed2 = null;
  try { routed2 = routeCables(links, cards, W, H); } catch (err) { console.error("cable routing failed", err); }
  return links.map((l, n) => routed2?.[n] || (l.b.x - l.a.x >= 10 ? bezier(l.a, l.b)
    : routed(l.a, l.b, { top: l.cs.t, bottom: l.cs.b }, { top: l.ct.t, bottom: l.ct.b }, W)));
}

// PATTERNS / patterns(links, sourceOf): when one item has several cables leaving it, each gets its own dash pattern so they can be told
// apart: solid, dashed, dotted, dash-dot, long dash (five; a sixth cable repeats the first). A lone cable gets none (null) and keeps
// the page's own look. `sourceOf(link)` names the item a cable leaves (the campaign page: the link's `from` key). Returns one entry per
// link, in order: a stroke-dasharray string ("none" = solid) or null. Numbers are tuned for the 3px round-capped cable.
const PATTERNS = ["none", "14 9", "1 8", "14 7 1 7", "26 10"];
function patterns(links, sourceOf) {
  const group = new Map();
  links.forEach(l => group.set(sourceOf(l), (group.get(sourceOf(l)) || 0) + 1));
  const seen = new Map();
  return links.map(l => {
    const k = sourceOf(l);
    if (group.get(k) < 2) return null;
    const i = seen.get(k) || 0;
    seen.set(k, i + 1);
    return PATTERNS[i % PATTERNS.length];
  });
}

// pair(layer, d, opts): add one cable to `layer`: the visible path and, on top of it, a wider invisible one that is easy to click.
//   opts.cls      the visible path's class         opts.stroke   optional stroke colour
//   opts.dash     optional stroke-dasharray (one of PATTERNS; see patterns())
//   opts.title    tooltip text                     opts.onRemove called when the cable is clicked (a click removes the link)
// Returns the visible path so the caller can add more attributes.
function pair(layer, d, { cls, stroke, dash, title, onRemove }) {
  const vis = document.createElementNS(SVGNS, "path");
  vis.setAttribute("d", d);
  vis.setAttribute("class", cls);
  if (stroke) vis.style.stroke = stroke;
  if (dash) vis.style.strokeDasharray = dash;
  vis.setAttribute("marker-end", "url(#arr)");
  layer.append(vis);
  const hit = document.createElementNS(SVGNS, "path");   // pointer-events: stroke in the stylesheet makes only the stroke receive the mouse
  hit.setAttribute("d", d);
  hit.setAttribute("class", "linkhit");
  hit.addEventListener("click", onRemove);
  const tip = document.createElementNS(SVGNS, "title");   // an SVG <title> child is the shape's tooltip
  tip.textContent = title;
  hit.append(tip);
  layer.append(hit);
  return vis;
}

  return { SVGNS, bezier, routed, roundPoly, routeCables, live, tempPath, paths, pair, patterns, PATTERNS };
})();
