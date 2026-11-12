"use strict";
// importer.js - the "which characters?" pop-up shared by the Home tab's upload box and the Characters page's import form.
//
// Importer.start(file, { owner, onDone }) -> Promise
//   1. POST the file to /api/party/preview: the server lists the characters inside it (nothing is saved yet).
//   2. A pop-up shows them with a checkbox each (all ticked; a character a player may not replace is greyed out), with "all" and
//      "none" buttons and a count. Characters already on the server are marked "will be updated".
//   3. Import sends the file again with only the ticked ids (/api/party/import, fields select + only); the server saves each
//      character individually, so one that fails does not stop the others. The pop-up lists any that failed and why.
//   owner   optional user name (the DM's "whose character" menu), sent along as the import's owner
//   onDone  called with the server's answer ({imported, failed}) after the pop-up closes
// A failure to read the file is thrown, so the button that started it shows the message beside itself (errors.js).
const Importer = (() => {
  const h = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  };

  async function start(file, { owner, onDone } = {}) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/party/preview", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);

    const rows = j.characters.map(c => {
      const box = h("input", { type: "checkbox", checked: !c.blocked, disabled: c.blocked });
      const tag = c.blocked ? "belongs to someone else" : c.exists ? "already here: will be updated" : c.portrait ? "new, with portrait" : "new";
      return { c, box, el: h("label", { className: "importrow" + (c.blocked ? " off" : "") }, box,
        h("span", {}, h("b", { textContent: c.name || c.id }), " ", h("span", { className: "muted", textContent: [c.class, c.hp && `HP ${c.hp}`].filter(Boolean).join(" · ") }),
          h("div", { className: c.blocked ? "bad" : "muted", textContent: tag }))) };
    });
    const count = h("span", { className: "muted" });
    const msg = h("p", { className: "muted" });
    const go = h("button", { className: "primary", textContent: "Import selected" });
    const dlg = h("dialog", { className: "importdlg" },
      h("h2", { textContent: "Choose characters to import" }),
      h("p", { className: "muted", textContent: `${j.characters.length} character${j.characters.length === 1 ? "" : "s"} found in ${file.name}. Untick any you do not want.` }),
      h("div", { className: "row" },
        h("button", { type: "button", textContent: "All", onclick: () => { rows.forEach(x => { if (!x.c.blocked) x.box.checked = true; }); refresh(); } }),
        h("button", { type: "button", textContent: "None", onclick: () => { rows.forEach(x => (x.box.checked = false)); refresh(); } }), count),
      h("div", { className: "importlist" }, rows.map(x => x.el)), msg,
      h("menu", {}, h("span", { className: "grow" }), h("button", { type: "button", textContent: "Cancel", onclick: () => dlg.close() }), go));
    const refresh = () => {
      const n = rows.filter(x => x.box.checked).length;
      count.textContent = `${n} of ${rows.length} selected`;
      go.disabled = !n;
    };
    rows.forEach(x => (x.box.onchange = refresh));
    refresh();

    let answer = null;
    go.onclick = async () => {
      go.disabled = true;
      msg.className = "muted";
      msg.textContent = "Importing…";
      const body = new FormData();
      body.append("file", file);
      body.append("select", "1");
      rows.filter(x => x.box.checked).forEach(x => body.append("only", x.c.id));
      if (owner) body.append("owner", owner);
      const res = await fetch("/api/party/import", { method: "POST", body });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { msg.className = "bad"; msg.textContent = out.error || "Import failed"; go.disabled = false; return; }
      answer = out;
      if (out.failed?.length) {   // some were saved, some were not: say which, and let the user read it before closing
        msg.className = "bad";
        msg.textContent = `Imported ${out.imported.length}. Not imported: ` + out.failed.map(f => `${f.name} (${f.error})`).join(", ");
        go.textContent = "Done";
        go.disabled = false;
        go.onclick = () => dlg.close();
        return;
      }
      dlg.close();
    };
    return new Promise(resolve => {
      dlg.addEventListener("close", () => { dlg.remove(); if (answer) onDone?.(answer); resolve(answer); });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  return { start };
})();
