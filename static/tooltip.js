"use strict";
// =============================================================================
// tooltip.js - hover text for every element that has a `title`, replacing the browser's own tooltip, which waits about a second and vanishes when the mouse
// twitches. Loaded by every page (after errors.js); nothing calls it, it works from the pages' own `title` attributes.
//
//   MOUSE   the text shows after a tiny delay (SHOW_MS) and is STICKY: it stays while the pointer is on the element or on the text, and for a moment (HIDE_MS)
//           after it leaves, so a small slip does not lose it; the text FADES OUT over that moment and comes back at full strength if the pointer returns.
//   NOT EVERYTHING: a title that only repeats what is already there is not shown: a short title (SHORT characters or fewer) on an element that has its own text or
//           no text at all (a spell slot bubble, a tab), one equal to the element's text, and the full text of a clipped table cell that is not actually clipped.
//           Icon buttons (a ✎ or ✕ with one or two characters of text) always show theirs, as do elements marked with class "hint" or an explicit data-tip.
//   TOUCH   there is no hover on a phone, so a TAP on an element that is marked as having hover text (class "hint", a stat tile, a spellcasting line, or anything with
//           data-tip) shows the text; a tap anywhere else, or a few seconds, hides it. (Plain buttons keep their `title` for the mouse only: a tap on them just presses
//           them.)
// The `title` is moved to data-tip the first time it is needed so the browser's tooltip never also appears; setting `title` again later (a redrawn page) works the same.
// =============================================================================
(() => {
  const SHOW_MS = 60, HIDE_MS = 160, TOUCH_MS = 5000, SHORT = 24;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  if ("popover" in tip) tip.popover = "manual";   // in the top layer, so it also shows over a pop-up dialog
  tip.hidden = true;
  let target = null, showT = 0, hideT = 0, touchT = 0, lastTouch = 0;
  const attach = () => { if (!tip.isConnected) document.body.append(tip); };

  const norm = s => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  // does the tip say anything the element does not already say?
  function worthShowing(el) {
    if (el.classList.contains("cliptext")) return el.scrollWidth > el.clientWidth;   // only a cut-short text needs its whole text
    if (!el.dataset.fromTitle || el.classList.contains("hint") || el.closest(".stat, .spellcast")) return true;   // written for the purpose
    const tip = norm(el.dataset.tip), text = norm(el.textContent);
    if (tip === text) return false;
    const iconOnly = text.length >= 1 && text.length <= 2;
    return iconOnly || tip.length > SHORT;
  }
  // the nearest element above `from` with hover text; its title is moved to data-tip
  function owner(from, touchOnly) {
    const el = from?.closest?.(touchOnly ? ".hint, .stat, .spellcast, [data-tip]" : "[title], [data-tip]");
    if (!el || el === tip || tip.contains(el)) return null;
    if (el.hasAttribute("title")) { if (el.title) { el.dataset.tip = el.title; el.dataset.fromTitle = "1"; } el.removeAttribute("title"); }
    return el.dataset.tip && worthShowing(el) ? el : null;
  }
  function place(el) {
    tip.style.left = "0px"; tip.style.top = "0px";
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let top = r.bottom + 6;
    if (top + t.height > vh - 4) top = Math.max(4, r.top - t.height - 6);   // no room below: above
    tip.style.left = Math.max(4, Math.min(r.left, vw - t.width - 4)) + "px";
    tip.style.top = top + "px";
  }
  function show(el) {
    attach();
    clearTimeout(hideT);
    target = el;
    tip.textContent = el.dataset.tip;
    tip.style.transition = "none"; tip.style.opacity = "1";
    tip.hidden = false;
    try { tip.showPopover?.(); } catch (_) { /* already showing */ }
    place(el);
  }
  function hide() {
    clearTimeout(showT); clearTimeout(hideT); clearTimeout(touchT);
    target = null; tip.hidden = true; tip.style.opacity = "1";
    try { tip.hidePopover?.(); } catch (_) { /* not showing */ }
  }
  // leaving: the text fades out over HIDE_MS and is gone at the end of it (anything that brings the pointer back cancels this: show() / the pointer on the text)
  const hideSoon = () => {
    clearTimeout(showT); clearTimeout(hideT);
    tip.style.transition = `opacity ${HIDE_MS}ms linear`; tip.style.opacity = "0";
    hideT = setTimeout(hide, HIDE_MS);
  };
  const keep = () => { clearTimeout(hideT); tip.style.transition = "none"; tip.style.opacity = "1"; };

  document.addEventListener("mouseover", ev => {
    if (Date.now() - lastTouch < 800) return;   // the mouse events a touch makes
    if (tip.contains(ev.target)) { keep(); return; }
    const el = owner(ev.target, false);
    if (!el) { if (target) hideSoon(); return; }
    if (el === target) { keep(); return; }   // still on the same thing: nothing to redo
    clearTimeout(showT); keep();
    showT = setTimeout(() => show(el), target ? 0 : SHOW_MS);   // moving from one tip to the next is instant
  }, true);
  document.addEventListener("mouseout", ev => {
    if (!ev.relatedTarget || (!ev.relatedTarget.closest?.("[data-tip], [title]") && !tip.contains(ev.relatedTarget))) hideSoon();
  }, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", hide, true);

  // a tap: show the text of what was tapped, or hide it when something else was
  document.addEventListener("touchend", ev => {
    lastTouch = Date.now();
    if (tip.contains(ev.target)) return;
    const el = owner(ev.target, true);
    if (!el) { hide(); return; }
    if (el === target && !tip.hidden) { hide(); return; }
    show(el);
    clearTimeout(touchT);
    touchT = setTimeout(hide, TOUCH_MS);
  }, { passive: true, capture: true });
})();
