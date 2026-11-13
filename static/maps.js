"use strict";
// =============================================================================
// maps.js - the maps (pictures and PDFs) attached to an encounter
// =============================================================================
//
// One component, used in two places: the Encounters tab (as the editor's `attach` hook, see builder.js) and the campaign tracker's
// 🗺 dialog on an encounter card (campaign.js). Both just call Maps.panel(encounter).
//
//   Maps.panel(enc, { onChange }) -> element
//     enc       an encounter record from GET /api/encounters; its `maps` list is [{ id, name, ext, size }] and is updated in place, so
//               every part of the page that holds the record sees the change
//     onChange  called after an upload or a delete
//   The panel shows the maps as a UI.dataTable (search, filters, size buttons like every other list; click a row to preview a picture),
//   with View (new browser tab), Download (safeDownload, errors.js: a failure is printed beside the button) and Delete buttons, and an
//   upload row. Files are png, jpg, gif, webp or pdf, 25 MB at most, 20 per encounter; the server enforces it (encounters.py).
//
// SERVER ROUTES   POST /api/encounters/<id>/maps (form field "file")    GET /api/encounters/<id>/maps/<map id>[?download=1]
//                 DELETE /api/encounters/<id>/maps/<map id>
// Needs ui.js and errors.js loaded first.
const Maps = (() => {
  const { h, dataTable } = UI;
  const size = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const href = (enc, m, download) => `/api/encounters/${enc.id}/maps/${m.id}` + (download ? "?download=1" : "");

  function panel(enc, { onChange } = {}) {
    const host = h("div", { className: "maps" });
    const msg = UI.status();
    const failed = e => msg.say(e.message, true);

    async function upload(file) {
      const body = new FormData();
      body.append("file", file);
      const r = await fetch(`/api/encounters/${enc.id}/maps`, { method: "POST", body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
      (enc.maps ||= []).push(j);
      draw(`Uploaded ${j.name}`);
      UI.libraryChanged();   // the other pages' encounter lists hear about it (ui.js)
      onChange?.();
    }
    async function remove(m) {
      if (!confirm(`Delete the map "${m.name}"? This cannot be undone.`)) return;
      const r = await fetch(`/api/encounters/${enc.id}/maps/${m.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Delete failed (${r.status})`);
      enc.maps = enc.maps.filter(x => x.id !== m.id);
      draw(`Deleted ${m.name}`);
      UI.libraryChanged();
      onChange?.();
    }

    function draw(note) {
      const maps = enc.maps || [];
      const file = h("input", { type: "file", accept: ".png,.jpg,.jpeg,.gif,.webp,.pdf,image/*,application/pdf" });
      const send = h("button", { className: "primary", textContent: "⬆ Upload map", onclick: () => {
        if (!file.files[0]) { msg.say("Choose a picture or PDF first", true); return; }
        msg.say("Uploading…");
        upload(file.files[0]).catch(failed);
      } });
      msg.say(note || "");
      host.replaceChildren(
        h("h3", { textContent: `Maps (${maps.length})` }),
        dataTable({
          key: "maps." + enc.id, rows: maps, empty: "No maps yet. Upload a picture or PDF below.",
          columns: [{ label: "Map", text: m => m.name }, { label: "Type", text: m => m.ext.slice(1).toUpperCase(), filter: true }, { label: "Size", text: m => size(m.size) }],
          // A picture opens under its row; a PDF has nothing to preview, so it only has the View button.
          detail: m => (m.ext === ".pdf" ? null : h("img", { src: href(enc, m), alt: m.name, loading: "lazy", className: "mapthumb" })),
          actions: m => [h("a", { className: "btn tiny", href: href(enc, m), target: "_blank", rel: "noopener", textContent: "View", title: "Open in a new tab" }),
            h("button", { className: "tiny", textContent: "⬇", title: "Download", onclick: () => safeDownload(href(enc, m, true)) }),
            h("button", { className: "tiny danger", textContent: "✕", title: "Delete this map", onclick: () => remove(m).catch(failed) })],
        }),
        h("div", { className: "row" }, file, send), msg);
    }
    draw();
    return host;
  }

  return { panel };
})();
