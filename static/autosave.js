"use strict";
// =============================================================================
// autosave.js - when the soundboard and the campaign tracker save themselves
// =============================================================================
//
// Both pages keep the whole board in the browser and send it to the server. They used to send it 0.3 seconds after every change; now a change
// is sent at most once every 30 SECONDS (AUTOSAVE_MS), and the label beside the toolbar says so. One shared piece, so both pages behave the
// same and the time is changed in one place.
//
//   const saver = Autosave.create({ send, label })
//     send(keepalive)  the page's own upload (a function returning a promise); `keepalive` is true when the page is being closed or hidden
//     label            the element whose text shows "unsaved ...", "saving…", "saved" or "SAVE FAILED"
//   saver.request()    a change was made: the board is sent within 30 seconds (the countdown starts at the FIRST unsaved change and is not
//                      restarted by later ones, so a steady stream of edits still saves every 30 s)
//   saver.flush()      send now (Ctrl+S / Cmd+S does this; so does hiding or closing the page, so a reload does not lose the last edits)
//   saver.pending()    is there anything not sent yet?
//   Autosave.put(url, data, keepalive)  PUT JSON and return the answer (throws the server's message); `keepalive` lets the request finish
//                      while the page closes (browsers allow it only for bodies under 64 KB, so it is used only then).
const Autosave = (() => {
  const AUTOSAVE_MS = 30000;

  async function put(url, data, keepalive = false) {
    const body = JSON.stringify(data);
    const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: keepalive && body.length < 60000 });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  function create({ send, label }) {
    let timer = null, dirty = false, sending = false;
    const say = text => { if (label) label.textContent = text; };
    async function flush(keepalive = false) {
      clearTimeout(timer);
      timer = null;
      if (!dirty || sending) return;
      dirty = false;
      sending = true;
      say("saving…");
      try { await send(keepalive); say("saved"); }
      catch (_) { dirty = true; say("SAVE FAILED (trying again)"); timer = setTimeout(flush, AUTOSAVE_MS); }
      finally { sending = false; }
    }
    function request() {
      dirty = true;
      say("unsaved (saves every 30 s)");
      if (!timer) timer = setTimeout(flush, AUTOSAVE_MS);
    }
    addEventListener("pagehide", () => flush(true));
    addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true); });
    addEventListener("keydown", ev => { if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); flush(); } });
    return { request, flush, pending: () => dirty || sending };
  }

  return { create, put, AUTOSAVE_MS };
})();
