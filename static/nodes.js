"use strict";
// =============================================================================
// nodes.js - what the soundboard and the campaign tracker share about their OBJECTS
// =============================================================================
//
// THE MODEL (see board.py): a board is a tree of SECTIONS holding CARDS. Sections nest to any depth; a section's `parent` is another
// section's id or "" for none, and a card's `section` is its parent section's id or "" for none. Nothing depends on its parent.
// There are no tiles or subsections any more: they are just sections inside sections.
//
// Everything here works on those plain arrays, so both pages use the same code:
//   TREE   Nodes.kids / descendants / inside / roots / depth / hue / hidden / path / options / fix / model / remove / reparent
//   PLACEMENT  Nodes.nest(secs) (depth, canEnter, moveInto, moveUp: the nesting rules for ANY object, sections and cards alike),
//          Nodes.upButton (the move-up button), Nodes.dropper (drag onto a section's header to move into it)
//   MENUS  Nodes.tools(actions)   the row of small buttons on a section's title bar and on every card (one implementation)
//          Nodes.form(spec)       the one settings dialog (section settings, timer settings, an added note ...): fields in, values out
//          Nodes.popup(spec)      a roomy pop-up around any element (the character sheet's item and spell search)
//   (The create menu that opens when empty canvas is clicked is Canvas.clickMenu in canvas.js.)
const Nodes = (() => {
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  };

  // ---------------------------------------------------------------- the tree
  const byId = (secs, id) => secs.find(s => s.id === id);
  // kids(secs, id): the child sections of `id` ("" = the top level), in list order.
  const kids = (secs, id) => secs.filter(s => (s.parent || "") === (id || "") && s.id !== id);
  // roots(secs): the top-level sections (a section whose parent no longer exists counts as top-level).
  const roots = secs => secs.filter(s => !s.parent || !byId(secs, s.parent));
  // descendants(secs, id): the ids of every section below `id` (not `id` itself).
  function descendants(secs, id) {
    const out = new Set(), walk = p => kids(secs, p).forEach(c => { if (!out.has(c.id)) { out.add(c.id); walk(c.id); } });
    walk(id);
    return out;
  }
  // inside(secs, id, ancestor): is section `id` the same as, or somewhere below, section `ancestor`?
  function inside(secs, id, ancestor) {
    for (let s = byId(secs, id), n = 0; s && n < 100; s = byId(secs, s.parent), n++) if (s.id === ancestor) return true;
    return false;
  }
  // chain(secs, id): the section and its ancestors, innermost first.
  function chain(secs, id) {
    const out = [];
    for (let s = byId(secs, id); s && out.length < 100 && !out.includes(s); s = byId(secs, s.parent)) out.push(s);
    return out;
  }
  const depth = (secs, id) => Math.max(0, chain(secs, id).length - 1);
  // hue(secs, id): the colour (0-360) of the top-level section `id` belongs to, the same for everything inside it; null for none.
  function hue(secs, id) {
    const top = chain(secs, id).at(-1);
    const i = top ? roots(secs).indexOf(top) : -1;
    return i < 0 ? null : (i * 137.5 + 260) % 360;   // golden-angle steps give each top-level section its own colour
  }
  // hidden(secs, id): is a card in section `id` hidden because that section, or one above it, is collapsed?
  const hidden = (secs, id) => chain(secs, id).some(s => s.collapsed);
  // path(secs, id): "Act 1 › The Temple" (names from the top down); "" for no section.
  const path = (secs, id) => chain(secs, id).reverse().map(s => s.name).join(" › ");
  // options(secs, { except, none }): the sections as drop-down choices, in tree order, indented by depth. `except` leaves out a section and
  // everything below it (a section cannot be moved into itself); `none` adds a first choice with value "".
  function options(secs, { except = null, none = "(no section)", keep = null } = {}) {
    const skip = except ? new Set([except, ...descendants(secs, except)]) : new Set(), out = none == null ? [] : [{ value: "", label: none }];
    const walk = (list, d) => list.forEach(s => {
      if (skip.has(s.id)) return;
      if (keep && !keep(s)) { walk(kids(secs, s.id), d + 1); return; }   // not offered, but what is inside it may be
      out.push({ value: s.id, label: "  ".repeat(d) + (d ? "↳ " : "") + s.name });
      walk(kids(secs, s.id), d + 1);
    });
    walk(roots(secs), 0);
    return out;
  }
  // fix(secs): make the parent links sound: a missing parent becomes "", and a loop (A inside B inside A) is cut at the section that
  // closes it. Call after loading or restoring a board.
  function fix(secs) {
    secs.forEach(s => { if (s.parent === undefined || s.parent === null || (s.parent && !byId(secs, s.parent))) s.parent = ""; });
    secs.forEach(s => { if (s.parent && chain(secs, s.id).length >= 100) s.parent = ""; });
    secs.forEach(s => { if (s.parent && inside(secs, s.parent, s.id)) s.parent = ""; });
  }
  // model(secs, cards, { exceptCard, exceptSection }): the nested description Canvas.layoutFrames wants. `exceptCard` / `exceptSection`
  // leave one card (or one whole section) out, to answer "where would the frames be without it?" when something is dropped.
  function model(secs, cards, { exceptCard = null, exceptSection = null } = {}) {
    const seen = new Set();
    const build = s => {
      seen.add(s.id);
      return { id: s.id, obj: s, collapsed: !!s.collapsed, items: cards.filter(c => (c.section || "") === s.id && c.id !== exceptCard),
        children: kids(secs, s.id).filter(c => c.id !== exceptSection && !seen.has(c.id)).map(build) };
    };
    return { sections: roots(secs).filter(s => s.id !== exceptSection).map(build) };
  }
  // remove(secs, cards, id): delete section `id` WITHOUT deleting anything inside it: its child sections and its cards become children of
  // its own parent (or stand at the top level if it had none). Returns the section list without it.
  function remove(secs, cards, id) {
    const sec = byId(secs, id), up = sec?.parent || "";
    secs.forEach(s => { if (s.parent === id) s.parent = up; });
    cards.forEach(c => { if (c.section === id) c.section = up; });
    return secs.filter(s => s.id !== id);
  }
  // reparent(secs, id, parentId): move a section inside another (or to the top level with ""); refuses (returns false) to put it inside itself
  // or one of its own descendants.
  function reparent(secs, id, parentId) {
    const sec = byId(secs, id);
    if (!sec || (parentId && inside(secs, parentId, id))) return false;
    sec.parent = parentId || "";
    return true;
  }

  // ---------------------------------------------------------------- placement: the "has a parent" component
  // Every board object (a section, a sound, a flag, a timer ...) HAS a parent link: a section's is `parent`, a card's is `section`. All the rules
  // about nesting live here, written against that one idea, so no page and no kind of object needs its own copy. A new kind of object only
  // needs a row in LINKS saying which field is its parent link.
  //   depth      the object's level: a section's own depth (top level 0, then 1, 2 ...); a card's is the depth of the section it sits in (-1 for
  //              a loose card, which may go anywhere)
  //   canEnter   may the object be moved INTO this section? Not itself or its own descendants, not the section it is already in, and only a
  //              section at the object's level or DEEPER (going shallower is what moveUp is for)
  //   moveUp     the ONLY way to take an object out of its section: it goes into that section's own parent (or to the top level)
  const LINKS = [{ test: (secs, o) => secs.includes(o), key: "parent" }, { test: () => true, key: "section" }];
  const treeDepth = depth;   // (the tree function above; `depth` is also a name inside nest)
  function nest(secs) {
    const key = o => LINKS.find(l => l.test(secs, o)).key, parentId = o => o[key(o)] || "";
    const depthOfObj = o => (key(o) === "parent" ? treeDepth(secs, o.id) : chain(secs, o.section).length - 1);
    const canEnter = (o, t) => !!t && t !== o && t.id !== parentId(o) && !inside(secs, t.id, o.id) && treeDepth(secs, t.id) >= depthOfObj(o);
    const canMoveUp = o => !!byId(secs, parentId(o));
    return {
      depth: depthOfObj, canEnter, canMoveUp, parentId,
      targets: o => secs.filter(t => canEnter(o, t)),
      // moveInto(o, t): put the object inside section t (refused, returning false, if the rules say no)
      moveInto(o, t) { if (!canEnter(o, t)) return false; o[key(o)] = t.id; return true; },
      moveUp(o) { const up = byId(secs, parentId(o)); if (!up) return false; o[key(o)] = up.parent || ""; return true; },
      // options(o): the drop-down choices for moving an EXISTING object from a dialog: only where it already is, or where it may enter
      options: o => options(secs, { keep: t => t.id === parentId(o) || canEnter(o, t), none: parentId(o) ? null : "(no section)" }),
    };
  }

  // upButton(nest, obj, secs, run): the small "move up" button for a card's drag bar: takes the object out of its section into that section's
  // parent. null when the object is in no section. `run()` does the move (the page records the undo step, saves and redraws).
  function upButton(nst, obj, secs, run) {
    if (!nst.canMoveUp(obj)) return null;
    const up = byId(secs, nst.parentId(obj)), to = up && byId(secs, up.parent) ? `"${byId(secs, up.parent).name}"` : "the top level";
    return el("button", { type: "button", className: "up", textContent: "⤴", title: `Move up out of "${up.name}" into ${to}`,
      onpointerdown: ev => ev.stopPropagation(), onclick: ev => { ev.stopPropagation(); run(); } });
  }

  // dropper(nest, secs, obj): the drag-and-drop half. To put an object into another section you drag it onto that section's HEADER (title bar).
  // While it is carried, every section it may enter (nest.canEnter) has its header highlighted; the one under the pointer is highlighted
  // more. Use the three calls from Canvas.dragItems' hooks: start() when the drag begins, over(event) as the pointer moves, end(event) on release
  // (clears the highlights and returns the section dropped on, or null).
  function dropper(nst, secs, obj) {
    const targets = new Set(nst.targets(obj).map(t => t.id)), frame = id => document.querySelector(`.frame[data-fid="sec:${id}"]`);
    const hit = e => {
      for (const n of document.elementsFromPoint(e.clientX, e.clientY)) {
        const f = n.matches?.(".frame > header") ? n.parentElement : null, id = f?.dataset.fid?.slice(4);
        if (id && targets.has(id)) return byId(secs, id);
      }
      return null;
    };
    const clear = () => document.querySelectorAll(".droptarget,.dropover").forEach(n => n.classList.remove("droptarget", "dropover"));
    return {
      start: () => targets.forEach(id => frame(id)?.classList.add("droptarget")),
      over: e => { document.querySelectorAll(".dropover").forEach(n => n.classList.remove("dropover")); const t = e && hit(e); if (t) frame(t.id)?.classList.add("dropover"); },
      end: e => { const t = e && e.type !== "pointercancel" ? hit(e) : null; clear(); return t; },
    };
  }

  // ---------------------------------------------------------------- menus
  // tools(actions, className) -> <span>: the row of small buttons on a title bar or a card, built the same way everywhere.
  //   actions  [{ icon, title, run(event), danger, cls, hidden }]
  // A click runs the action and goes no further, so pressing a button never also starts a drag or toggles the card under it.
  function tools(actions, className = "tools") {
    return el("span", { className }, actions.filter(a => a && !a.hidden).map(a =>
      el("button", { type: "button", className: ["tiny", a.danger ? "danger" : "", a.cls || ""].filter(Boolean).join(" "), textContent: a.icon, title: a.title,
        onclick: ev => { ev.stopPropagation(); return a.run(ev); } })));
  }

  // dialog(cls): the ONE <dialog id="nodeDlg"> every pop-up here uses (created on first use); `cls` "wide" makes it roomy for search pop-ups.
  function dialog(cls) {
    let dlg = document.getElementById("nodeDlg");
    if (!dlg) {
      dlg = el("dialog", { id: "nodeDlg" });
      document.body.append(dlg);
    }
    dlg.className = cls;
    return dlg;
  }
  // popup({ title, body, note }): a roomy pop-up around any element `body` (a search panel, a list), with a Close button; returns the dialog.
  // This and form() are the app's two pop-ups: form() asks for values, popup() shows something to work in.
  function popup({ title, body, note = "" }) {
    const dlg = dialog("wide");
    dlg.replaceChildren(el("h2", { textContent: title }), ...(note ? [el("p", { className: "muted", textContent: note })] : []), body,
      el("menu", {}, el("span", { className: "grow" }), el("button", { type: "button", textContent: "Close", onclick: () => dlg.close() })));
    dlg.showModal();
    return dlg;
  }

  // form({ title, fields, save, saveLabel, note }): the one settings dialog. It is built fresh each time inside a single <dialog>.
  //   fields  [{ key, label, type, value, options, min, max, step, placeholder, hint }] with type "text" (default), "number",
  //           "range", "select" (options [{ value, label }]), "checkbox", or "note" (just a paragraph of `hint`)
  //   save(values)  called when Save is pressed with { key: value } (numbers as numbers, a blank number as null, checkboxes as true / false).
  //                 Return a string to show it as an error and keep the dialog open; anything else closes it.
  function form({ title, fields, save, saveLabel = "Save", note = "" }) {
    const dlg = dialog("");
    const inputs = {}, msg = el("p", { className: "bad" });
    const rows = fields.map(f => {
      if (f.type === "note") return el("p", { className: "muted", textContent: f.hint });
      let input;
      if (f.type === "select") input = el("select", {}, f.options.map(o => el("option", { value: o.value, textContent: o.label })));
      else if (f.type === "checkbox") input = el("input", { type: "checkbox", checked: !!f.value });
      else if (f.type === "textarea") input = el("textarea", { rows: f.rows || 4, maxLength: f.max ?? 4000, placeholder: f.placeholder || "" });
      else input = el("input", { type: f.type || "text", placeholder: f.placeholder || "", min: f.min ?? "", max: f.max ?? "", step: f.step ?? "" });
      if (f.type !== "checkbox") input.value = f.value ?? "";
      inputs[f.key] = input;
      return el("label", { className: f.type === "checkbox" ? "check" : "" }, f.type === "checkbox" ? [input, " " + f.label] : [f.label + " ", input],
        f.hint ? el("span", { className: "muted", textContent: " " + f.hint }) : null);
    });
    const value = f => { const i = inputs[f.key]; return f.type === "checkbox" ? i.checked : f.type === "number" || f.type === "range" ? (i.value === "" ? null : +i.value) : i.value; };
    const submit = el("button", { type: "submit", className: "primary", textContent: saveLabel });
    const formEl = el("form", { method: "dialog" }, el("h2", { textContent: title }), note ? el("p", { className: "muted", textContent: note }) : null, ...rows, msg,
      el("menu", {}, el("span", { className: "grow" }), el("button", { type: "button", textContent: "Cancel", onclick: () => dlg.close() }), submit));
    formEl.addEventListener("submit", async ev => {
      ev.preventDefault();
      const out = {};
      fields.filter(f => f.type !== "note").forEach(f => { out[f.key] = value(f); });
      const err = await save(out);
      if (typeof err === "string") { msg.textContent = err; return; }
      dlg.close();
    });
    dlg.replaceChildren(formEl);
    dlg.showModal();
    return dlg;
  }

  return { el, byId, kids, roots, descendants, inside, chain, depth, hue, hidden, path, options, fix, model, remove, reparent, nest, upButton, dropper, tools, form, popup };
})();
