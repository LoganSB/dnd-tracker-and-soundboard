"use strict";
// errors.js - one rule for every button: if its action fails, the message appears right next to that button. It never
// replaces the page, and it is not a pop-up. Loaded by every page, before the page's own script.
//
// HOW: it remembers the last button or link that was pressed. A failure that nobody caught (a rejected promise, an
// exception in a click handler) or a call to alert() is shown in a small red line placed after that button, and fades
// after 10 seconds. Code that wants its own message can still catch the error itself.
//
// safeDownload(url): start a file download from a button WITHOUT leaving the page when the server says no. A plain
// link to an address that answers "not found" would replace the whole page with the error. This asks first (the
// request is cancelled as soon as the answer's headers arrive, so a large file is not fetched twice), and only a
// good answer starts the real download. On failure it throws, and the rule above prints the message by the button.
(() => {
  let last = null, lastAt = 0;   // the control most recently pressed and when
  const nativeAlert = window.alert.bind(window);

  const press = ev => {
    const el = ev.target.closest?.("button,a,[role=button],summary");
    if (el) { last = el; lastAt = Date.now(); }
  };
  addEventListener("pointerdown", press, true);
  addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") press(ev); }, true);

  // show(message, near): put the message after `near` (or, if that control is gone, in a small strip at the bottom).
  function show(message, near) {
    document.querySelectorAll(".inlineerr").forEach(e => { if (e.dataset.for === (near?.id || "") || !near?.isConnected) e.remove(); });
    const span = document.createElement("span");
    span.className = "inlineerr";
    span.setAttribute("role", "alert");
    span.textContent = message;
    if (near?.isConnected) near.after(span); else { span.classList.add("floating"); document.body.append(span); }
    setTimeout(() => span.remove(), 10000);
  }
  const recent = ms => last && Date.now() - lastAt < ms;
  const textOf = e => (e && (e.message || e.error)) || String(e);

  addEventListener("unhandledrejection", ev => {
    if (!recent(30000)) return;
    ev.preventDefault();
    show(textOf(ev.reason), last);
  });
  addEventListener("error", ev => { if (recent(2000) && ev.message) show(ev.message, last); });
  // alert(message) was used for failures all over the place: show those by the button too. (With no recent press, such as
  // a message from a timer, the normal alert box is used.)
  window.alert = message => { if (recent(30000)) show(String(message), last); else nativeAlert(message); };

  // The character download comes in two formats: "Fight Club 5e" (the plain backup, what the Fight Club app reads) and "Gloan5e" (the same backup plus this
  // app's extras in one file; see gloan5e.py). downloadCharacters(url, what) opens the pop-up that asks which (Nodes.form, nodes.js; the choice is remembered)
  // and then downloads `url` in that format. The Characters page and Home both call it, so there is one pop-up.
  const FORMATS = [["fightclub5e", "Fight Club 5e"], ["gloan5e", "Gloan5e"]];
  const fmtGet = () => { try { const v = localStorage.getItem("dl.format"); return FORMATS.some(f => f[0] === v) ? v : "fightclub5e"; } catch (_) { return "fightclub5e"; } };
  window.downloadCharacters = (url, what) => Nodes.form({
    title: `Download ${what}`, saveLabel: "Download",
    note: "Fight Club 5e is the plain backup the Fight Club app reads. Gloan5e is the same backup plus this app's extras (worn items, attunement, conditions, trackers, death saves) in one file, so nothing is lost moving between servers.",
    fields: [{ key: "as", label: "Format", type: "select", value: fmtGet(), options: FORMATS.map(([value, label]) => ({ value, label })) }],
    save: v => {
      try { localStorage.setItem("dl.format", v.as); } catch (_) { /* not remembered */ }
      window.safeDownload(url + (url.includes("?") ? "&" : "?") + "as=" + v.as).catch(e => alert(e.message));
    },
  });

  window.safeDownload = async url => {
    const ctl = new AbortController();
    let r;
    try { r = await fetch(url, { signal: ctl.signal }); } catch (e) { throw new Error("Could not reach the server"); }
    if (!r.ok) {
      let m = "";
      try { m = (await r.json()).error || ""; } catch (_) { /* not JSON */ }
      throw new Error(m || (r.status === 404 ? "Not found" : r.status === 401 ? "Sign in required" : r.status === 403 ? "Not allowed" : `Download failed (${r.status})`));
    }
    ctl.abort();   // the answer is good: stop this check and let the browser do the real download
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  };
})();
