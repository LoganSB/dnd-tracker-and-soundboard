// home.js - the Home (banner) tab: what you see first after signing in.
//
// Loaded by templates/home.html, which is shown inside the app shell. The page's level (document.body.dataset.role,
// "dm" or "player") only chooses which panels to BUILD; the server decides what each request may do, so a
// player who edited this script would still be refused (see auth.py).
//
// SERVER ROUTES USED
//   GET  /api/party                      characters you may see (DM: all; player: yours), each with "owner"
//   POST /api/party/import               multipart upload "file" (DM may add field "owner")
//   PUT  /api/party/<id>/owner           {owner}  DM: give a character to a user
//   GET  /api/active-party               {campaign, party:[{id,name,owner,present}]}  the loaded campaign's party
//   PUT  /api/active-party               {ids:[...]}  set which characters are in the party
//   GET  /api/campaigns                  saved campaign names;  POST same: save the board as {name}
//   POST /api/campaigns/<name>/load      make a campaign the live one;  DELETE /api/campaigns/<name>
//   GET/POST/DELETE /api/auth/users, /api/auth/invites ...   accounts and invite links (DM)
//   POST /api/auth/password              {old, new}  change your own password
// After a campaign is loaded the shell is told to reload the Soundboard and Campaign pages
// (postMessage {type: "reloadPages"}), because they keep their own copy of the board in memory.

const role = document.body.dataset.role;
const root = document.getElementById("home");

// h(tag, props, ...children): build a DOM element. Properties such as textContent are plain text, never HTML,
// so a user name or character name can never inject markup. Children may be strings or elements.
function h(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}

// api(url, method, body): JSON request; returns the parsed answer, or throws Error(message from the server).
async function api(url, method = "GET", body) {
  const r = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

// section(title, ...content): a titled panel.
const section = (title, ...content) => h("section", { className: "homebox" }, h("h2", { textContent: title }), ...content);

// status(): a small line of text under a form that shows progress or an error (shown in red when `bad`).
function status() {
  const p = h("p", { className: "muted" });
  p.say = (t, bad) => { p.textContent = t; p.className = bad ? "bad" : "muted"; };
  return p;
}

// openSheet(id): ask the shell to show the Characters tab on that character.
const openSheet = id => parent.postMessage({ type: "goto", page: "party", path: "/_/party/" + id }, location.origin);

// uploadBox(users): the Fight Club import form. A DM also gets a drop-down to choose whose character it is.
function uploadBox(users) {
  const file = h("input", { type: "file", accept: ".backup,.xml,.zip" });
  const owner = users && h("select", {}, h("option", { value: "", textContent: "(no owner)" }),
    users.map(u => h("option", { value: u.name, textContent: u.name })));
  const msg = status();
  const btn = h("button", { className: "primary", textContent: "Upload", onclick: async () => {
    if (!file.files[0]) return msg.say("Choose a file first", true);
    const fd = new FormData();
    fd.append("file", file.files[0]);
    if (owner && owner.value) fd.append("owner", owner.value);
    msg.say("Uploading…");
    const r = await fetch("/api/party/import", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return msg.say(j.error || "Upload failed", true);
    msg.say(`Imported ${j.imported.length} character(s)`);
    boot();
    parent.document.getElementById("f-party")?.contentWindow.location.reload();   // the Characters tab shows the new sheet
  } });
  return h("div", {}, h("p", { className: "muted", textContent: "Fight Club 5 backup (.backup / .xml) or a zip containing one. Characters with the same id are updated." }),
    h("div", { className: "row" }, file, owner, btn), msg);
}

// ---------------------------------------------------------------- player view
async function playerView() {
  const mine = await api("/api/party");
  const cards = mine.length ? mine.map(c => h("div", { className: "homecard" },
    c.hasImage ? h("img", { src: `/api/party/${c.id}/portrait`, alt: "" }) : null,
    h("div", {}, h("strong", { textContent: c.name }), h("div", { className: "muted", textContent: `${c.class || ""}  ·  HP ${c.hp}/${c.hpMax}` })),
    h("button", { textContent: "Open sheet", onclick: () => openSheet(c.id) })))
    : [h("p", { className: "muted", textContent: "You have not uploaded a character yet." })];
  return [
    section("Your character", ...cards),
    section("Upload your character", uploadBox(null)),
    passwordBox(),
  ];
}

// passwordBox(): change your own password.
function passwordBox() {
  const oldPw = h("input", { type: "password", placeholder: "Current password", autocomplete: "current-password" });
  const newPw = h("input", { type: "password", placeholder: "New password (8+ characters)", autocomplete: "new-password" });
  const msg = status();
  return section("Password", h("div", { className: "row" }, oldPw, newPw, h("button", { textContent: "Change", onclick: async () => {
    try {
      await api("/api/auth/password", "POST", { old: oldPw.value, new: newPw.value });
      oldPw.value = newPw.value = "";
      msg.say("Password changed");
    } catch (e) { msg.say(e.message, true); }
  } })), msg);
}

// ---------------------------------------------------------------- DM view
async function dmView() {
  const [camps, ap, chars, users, invites] = await Promise.all([
    api("/api/campaigns"), api("/api/active-party"), api("/api/party"), api("/api/auth/users"), api("/api/auth/invites"),
  ]);
  return [campaignBox(camps, ap), partyBox(ap), rosterBox(chars, users, ap), playersBox(users, invites), uploadSection(users)];
}

// campaignBox: which campaign is loaded, load or delete saved ones, save the current board as a campaign.
function campaignBox(camps, ap) {
  const msg = status();
  const reload = () => parent.postMessage({ type: "reloadPages" }, location.origin);
  const list = camps.length ? camps.map(n => h("li", {},
    h("span", { textContent: n + (n === ap.campaign ? "  (loaded)" : "") }),
    h("span", {},
      h("button", { textContent: "Load", onclick: async () => {
        if (!confirm(`Load campaign "${n}"? The current board is saved as a version first.`)) return;
        await api(`/api/campaigns/${encodeURIComponent(n)}/load`, "POST");
        reload(); boot();
      } }),
      h("button", { className: "danger", textContent: "Delete", onclick: async () => {
        if (confirm(`Delete campaign "${n}"?`)) { await api("/api/campaigns/" + encodeURIComponent(n), "DELETE"); boot(); }
      } }))))
    : [h("li", { className: "muted", textContent: "No saved campaigns yet." })];
  const name = h("input", { placeholder: "Campaign name", value: ap.campaign || "" });
  return section("Campaign",
    h("p", { textContent: ap.campaign ? `Loaded: ${ap.campaign}` : "No saved campaign is loaded (this is the working board)." }),
    h("ul", { className: "list" }, list),
    h("div", { className: "row" }, name, h("button", { className: "primary", textContent: "Save current board as campaign", onclick: async () => {
      try { await api("/api/campaigns", "POST", { name: name.value }); boot(); } catch (e) { msg.say(e.message, true); }
    } })),
    h("p", { className: "muted", textContent: "A campaign holds the soundboard, the campaign tracker and the list of party members. Party members are only references: each character's sheet stays with the player who uploaded it." }),
    msg);
}

// partyBox: the loaded campaign's party, with a note for members whose sheet has not been uploaded here.
function partyBox(ap) {
  const rows = ap.party.length ? ap.party.map(p => h("li", {},
    h("span", { textContent: `${p.name || p.id}${p.owner ? "  ·  " + p.owner : ""}` }),
    p.present ? h("button", { textContent: "Open", onclick: () => openSheet(p.id) })
      : h("span", { className: "warn", textContent: `waiting for ${p.owner || "an upload"}` })))
    : [h("li", { className: "muted", textContent: "No one is in the party yet. Tick characters below." })];
  return section("Party in this campaign", h("ul", { className: "list" }, rows));
}

// rosterBox: every uploaded character, who owns it, and whether it is in the party.
function rosterBox(chars, users, ap) {
  const inParty = new Set(ap.party.map(p => p.id));
  const save = () => api("/api/active-party", "PUT", { ids: [...root.querySelectorAll("input.inparty:checked")].map(c => c.value) }).then(boot);
  const rows = chars.length ? chars.map(c => {
    const owner = h("select", { onchange: () => api(`/api/party/${c.id}/owner`, "PUT", { owner: owner.value }).then(boot) },
      h("option", { value: "", textContent: "(no owner)" }),
      users.map(u => h("option", { value: u.name, textContent: u.name, selected: u.name.toLowerCase() === (c.owner || "").toLowerCase() })));
    return h("tr", {},
      h("td", {}, h("input", { type: "checkbox", className: "inparty", value: c.id, checked: inParty.has(c.id), onchange: save })),
      h("td", { textContent: c.name }), h("td", { className: "muted", textContent: c.class }), h("td", {}, owner),
      h("td", {}, h("button", { textContent: "Open", onclick: () => openSheet(c.id) })));
  }) : [h("tr", {}, h("td", { colSpan: 5, className: "muted", textContent: "No characters uploaded yet." }))];
  return section("Characters and who they belong to",
    h("table", { className: "loot" }, h("tr", {}, ["In party", "Character", "Class", "Player", ""].map(t => h("th", { textContent: t }))), rows));
}

// playersBox: accounts, plus invite links for new players.
function playersBox(users, invites) {
  const msg = status();
  const rows = users.map(u => h("tr", {},
    h("td", { textContent: u.name }),
    h("td", { textContent: u.role === "dm" ? "DM" : "Player" }),
    h("td", { className: "muted", textContent: u.email || (u.hasPassword ? "password" : "") }),
    h("td", {},
      h("button", { textContent: "Reset password", onclick: async () => {
        const pw = prompt(`New password for ${u.name} (8+ characters):`);
        if (!pw) return;
        try { await api(`/api/auth/users/${encodeURIComponent(u.name)}/password`, "POST", { password: pw }); msg.say("Password changed"); }
        catch (e) { msg.say(e.message, true); }
      } }),
      h("button", { className: "danger", textContent: "Delete", onclick: async () => {
        if (!confirm(`Delete the account ${u.name}? Their characters stay, with no owner.`)) return;
        try { await api("/api/auth/users/" + encodeURIComponent(u.name), "DELETE"); boot(); } catch (e) { msg.say(e.message, true); }
      } }))));
  const note = h("input", { placeholder: "Who is it for? (a reminder, e.g. Alice)" });
  const link = h("p", {});
  const full = path => location.origin + path;
  const pending = invites.map(i => h("li", {},
    h("span", { textContent: `${i.note || "(no note)"}  ·  ${full("/invite/" + i.token)}` }),
    h("span", {},
      h("button", { textContent: "Copy", onclick: () => navigator.clipboard.writeText(full("/invite/" + i.token)) }),
      h("button", { className: "danger", textContent: "Revoke", onclick: () => api("/api/auth/invites/" + i.token, "DELETE").then(boot) }))));
  return section("Players and invite links",
    h("table", { className: "loot" }, h("tr", {}, ["User", "Level", "Sign-in", ""].map(t => h("th", { textContent: t }))), rows),
    msg,
    h("h3", { textContent: "Invite a player" }),
    h("div", { className: "row" }, note, h("button", { className: "primary", textContent: "Create invite link", onclick: async () => {
      const r = await api("/api/auth/invites", "POST", { note: note.value });
      link.textContent = `Send this link (valid 7 days, works once): ${full(r.path)}`;
      navigator.clipboard.writeText(full(r.path)).catch(() => {});
      boot();
    } })), link,
    pending.length ? h("ul", { className: "list" }, pending) : null);
}

// uploadSection: the DM can upload a character on a player's behalf.
const uploadSection = users => section("Upload a character", uploadBox(users));

// ---------------------------------------------------------------- start
let booting = false;
// boot(): (re)build the page from fresh server data. Called on load and after every change.
async function boot() {
  if (booting) return;
  booting = true;
  try {
    const parts = await (role === "dm" ? dmView() : playerView());
    root.replaceChildren(h("h1", { textContent: "🎲 DND Tracker" }), ...parts);
  } catch (e) {
    root.replaceChildren(h("p", { className: "bad", textContent: e.message }));
  } finally { booting = false; }
}
boot();
