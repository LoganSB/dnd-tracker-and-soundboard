"use strict";
// =============================================================================
// undo.js - undo / redo for chain links, shared by the soundboard and the campaign tracker
// =============================================================================
//
// WHAT IT DOES
//   Every change to the links between items (making a link, removing one, re-routing one) can be undone
//   and redone: with Ctrl+Z / Ctrl+Y (Cmd on a Mac; Ctrl/Cmd+Shift+Z also redoes) or the two arrow buttons
//   in the toolbar. Each page keeps its own history, and the history lives only as long as the page is open.
//
// HOW IT WORKS (a "snapshot" undo stack)
//   Instead of describing each kind of change and how to reverse it, we simply remember what the links
//   looked like BEFORE the change, as a piece of text (JSON). Undoing means putting that remembered state
//   back. A history is two stacks (arrays used as stacks, push/pop at the end):
//       undo stack: states to go back to      redo stack: states to go forward to
//   - record(label)  call it right BEFORE changing the links: the current state is pushed on the undo stack
//                    and the redo stack is emptied (a new change makes the old "future" meaningless).
//   - undo()         push the CURRENT state on the redo stack, pop the undo stack and restore that state.
//   - redo()         the mirror image.
//   The page supplies two small functions that know how its links are stored:
//       snapshot() -> text describing the current links
//       restore(text) -> put those links back (and save and redraw)
//   Snapshots are compared as text, so a change that did not change anything is not recorded.
//
// This file creates one global, `Undo`, with three functions: Undo.create(options), Undo.bindKeys(history)
// and Undo.toast(text) (a short message at the bottom of the page: "Undid: removed a link").
const Undo = (() => {
  const LIMIT = 100;   // how many steps are remembered; older ones are forgotten

  // create({ snapshot, restore, onChange }): make a new history. onChange() is called whenever the
  // stacks change (the page uses it to enable or disable the Undo / Redo buttons).
  // Returns { record, undo, redo, canUndo, canRedo }.
  function create({ snapshot, restore, onChange = () => {} }) {
    const undoStack = [],   // each entry: { state, label } - the state to go back to, and what the change was
      redoStack = [];

    // record(label): call BEFORE a change. Remembers the current links so the change can be undone.
    function record(label) {
      const state = snapshot();
      if (undoStack.length && undoStack.at(-1).state === state) return;   // nothing changed since the last record
      undoStack.push({ state, label });
      if (undoStack.length > LIMIT) undoStack.shift();   // forget the oldest step
      redoStack.length = 0;                              // `length = 0` empties an array
      onChange();
    }
    // undo(): step back one change. Returns the label of what was undone, or null if there was nothing to undo.
    function undo() {
      const step = undoStack.pop();
      if (!step) return null;
      redoStack.push({ state: snapshot(), label: step.label });   // so redo() can come back to where we are now
      restore(step.state);
      onChange();
      return step.label;
    }
    // redo(): step forward again (only possible right after undoing). Returns the label, or null.
    function redo() {
      const step = redoStack.pop();
      if (!step) return null;
      undoStack.push({ state: snapshot(), label: step.label });
      restore(step.state);
      onChange();
      return step.label;
    }
    return { record, undo, redo, canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0 };
  }

  // toast(text): show a short message at the bottom-left of the page that fades away by itself. It reuses one
  // element (id "toast"), created the first time it is needed; a new message replaces the old one.
  let toastTimer = null;
  function toast(text) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      document.body.append(t);
    }
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // bindKeys(history, notify): register the keyboard shortcuts for a history: Ctrl/Cmd+Z = undo,
  // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo. `notify(text)` (optional) is told what happened ("Undid: ...").
  // The shortcuts are ignored while you are typing in a text box or a dialog is open, so the browser's own
  // text undo keeps working there.
  function bindKeys(history, notify = toast) {
    addEventListener("keydown", ev => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      if (ev.target.closest?.("input,select,textarea,dialog,[contenteditable]")) return;
      const key = ev.key.toLowerCase();
      if (key === "z" && !ev.shiftKey) {
        ev.preventDefault();
        const label = history.undo();
        notify(label ? "Undid: " + label : "Nothing to undo");
      } else if ((key === "z" && ev.shiftKey) || key === "y") {
        ev.preventDefault();
        const label = history.redo();
        notify(label ? "Redid: " + label : "Nothing to redo");
      }
    });
  }

  return { create, bindKeys, toast };
})();
