"use strict";
// =============================================================================
// undo.js - undo / redo for EVERY change on a page, shared by the soundboard and the campaign tracker
// =============================================================================
//
// WHAT IT DOES
//   Anything that changes the board can be undone and redone: creating or deleting a section, sound or card,
//   renaming, moving things, editing in a dialog, ticking a checklist, making, re-routing or removing a link ...
//   Ctrl+Z / Ctrl+Y (Cmd on a Mac; Ctrl/Cmd+Shift+Z also redoes) or the two arrow buttons in the toolbar. Each page keeps
//   its own history, and it lives only as long as the page is open.
//
// HOW IT WORKS: THE COMMAND PATTERN, with a snapshot standing in for the reverse code
//   Every change is registered as a COMMAND: a small object with a label and two functions,
//       { label, undo(), redo(), at }
//   kept on a LIFO stack (last in, first out: an array you push and pop at the end). Undo pops the newest command, calls
//   its undo() and pushes it on a second stack, the redo stack; redo does the mirror image. A new command empties the redo
//   stack, because the old "future" no longer applies. Only the last LIMIT commands are kept.
//   Writing a separate "how to reverse this" function for every kind of change would be a lot of code that could drift out of
//   step with the change itself, so each command's undo() and redo() simply restore the state of the page from BEFORE and AFTER
//   the change (two pieces of text, JSON), using the page's restore() function. The page needs no per-change code except an
//   optional label.
//
//   The page gives us:
//       snapshot() -> text describing everything that can be undone      restore(text) -> put that state back (and save, redraw)
//   and calls:
//       edits.record(label)   OPTIONAL, before or while changing something: names the next command ("deleted a section")
//       edits.commit()        after EVERY change, from the page's save(): compares the page with the last state, and if it
//                             differs registers a command. (Changes that follow each other within a second under the same
//                             label, such as typing or dragging a slider, are merged into one command.)
//       edits.reset()         after the page loads or reloads state from the server: the new state becomes the baseline,
//                             without making a command.
//       edits.clear()         the page switched to unrelated data (a different campaign): forget the history too.
//   Pages call commit() from save(), so every change that is saved is undoable without any other code.
//
// This file creates one global, `Undo`, with three functions: Undo.create(options), Undo.bindKeys(edits)
// and Undo.toast(text) (a short message at the bottom of the page: "Undid: removed a link").
const Undo = (() => {
  const LIMIT = 200;        // how many commands are remembered; older ones are forgotten
  const MERGE_MS = 1000;    // changes this close together, with the same label, become one command

  // create({ snapshot, restore, onChange }) -> { record, commit, reset, clear, undo, redo, canUndo, canRedo, labels }
  function create({ snapshot, restore, onChange = () => {} }) {
    const undoStack = [], redoStack = [];   // arrays used as stacks: push and pop at the end
    let base = null,        // the state after the last command (what the page looked like at the last commit)
      pending = "",         // the label for the next command, set by record()
      busy = false;         // true while undo() / redo() is restoring, so that restore()'s own save() makes no command

    // record(label): name the next command. Call it before or while making a change.
    const record = label => { pending = label; };

    // commit(): the page changed (it just saved). If the state really differs from the last one, register a command.
    function commit() {
      if (busy) return;
      const now = snapshot();
      if (base === null) { base = now; return; }       // the very first call only sets the baseline
      if (now === base) { pending = ""; return; }       // nothing changed
      const label = pending || "edit", before = base, at = Date.now();
      pending = "";
      base = now;
      const last = undoStack.at(-1);
      if (last && last.label === label && at - last.at < MERGE_MS) {   // typing, dragging a slider: one command
        last.at = at;
        last.after = now;
        last.redo = () => restore(now);
      } else {
        const cmd = { label, at, after: now, undo: () => restore(before), redo: () => restore(now) };
        undoStack.push(cmd);
        if (undoStack.length > LIMIT) undoStack.shift();   // forget the oldest command
      }
      redoStack.length = 0;                                // `length = 0` empties an array
      onChange();
    }

    // reset(): take the current page state as the baseline without making a command (call after loading from the server).
    function reset() { base = snapshot(); pending = ""; }

    // clear(): forget the whole history (call when the page switches to unrelated data, e.g. a different campaign).
    function clear() { undoStack.length = 0; redoStack.length = 0; reset(); onChange(); }

    // run(cmd, direction, from, to): walk one command back or forward and move it to the other stack; shared by undo and redo.
    function run(cmd, direction, from, to) {
      busy = true;
      try { cmd[direction](); base = snapshot(); } finally { busy = false; }
      from.pop();
      to.push(cmd);
      onChange();
      return cmd.label;
    }
    // undo(): walk back the newest command with one call. Returns its label, or null if there was nothing to undo.
    function undo() {
      const cmd = undoStack.at(-1);
      return cmd ? run(cmd, "undo", undoStack, redoStack) : null;
    }
    // redo(): walk forward again (only possible after undoing). Returns the label, or null.
    function redo() {
      const cmd = redoStack.at(-1);
      return cmd ? run(cmd, "redo", redoStack, undoStack) : null;
    }
    return { record, commit, reset, clear, undo, redo, canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,
      labels: () => undoStack.map(c => c.label) };
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

  // bindKeys(edits, notify): register the keyboard shortcuts: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo.
  // `notify(text)` (optional) is told what happened ("Undid: ..."). The shortcuts are ignored while you are typing in a
  // text box or a dialog is open, so the browser's own text undo keeps working there.
  function bindKeys(edits, notify = toast) {
    addEventListener("keydown", ev => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      if (ev.target.closest?.("input,select,textarea,dialog,[contenteditable]")) return;
      const key = ev.key.toLowerCase();
      if (key === "z" && !ev.shiftKey) {
        ev.preventDefault();
        const label = edits.undo();
        notify(label ? "Undid: " + label : "Nothing to undo");
      } else if ((key === "z" && ev.shiftKey) || key === "y") {
        ev.preventDefault();
        const label = edits.redo();
        notify(label ? "Redid: " + label : "Nothing to redo");
      }
    });
  }

  return { create, bindKeys, toast };
})();
