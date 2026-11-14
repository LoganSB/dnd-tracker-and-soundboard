// home.js - the Home (banner) tab: what you see first after signing in.
//
// Loaded by templates/home.html (after ui.js, which provides h, api, status, box and dataTable), inside the app
// shell. The page's level (document.body.dataset.role, "dm" or "player") only chooses which panels to BUILD;
// the server decides what each request may do, so a player who edited this script would still be refused.
//
// EVERY list here is a dataTable: collapsible (click the heading), searchable with a regular expression and
// filterable per column. The Party and Characters lists are the same table (characterTable): same columns,
// same code; only the buttons differ.
//
// SERVER ROUTES USED
//   GET  /api/party                      characters you may see (DM: all; player: yours), each with "owner"
//   POST /api/party/preview              multipart upload "file": lists the characters inside (saves nothing)
//   POST /api/party/import               multipart upload "file" + the chosen ids (DM may add field "owner"); see importer.js
//   PUT  /api/party/<id>/owner           {owner}  DM: give a character to a user
//   GET/PUT /api/active-party            the loaded campaign's party {campaign, party:[{id,name,owner,present}]} / {ids}
//   GET/POST /api/campaigns, POST /api/campaigns/<name>/load, DELETE /api/campaigns/<name>
//   GET/POST/DELETE /api/auth/users, /api/auth/invites ...   accounts and invite links (DM)
//   GET  /api/auth/requests, POST /api/auth/requests/resolve   join requests (DM)
//   GET  /api/my/campaigns, POST /api/my/campaigns/<name>/request   (player) campaigns and asking to join
//   POST /api/auth/password              {old, new}  change your own password
//   GET  /api/auth/me                    who am I, and do I have a password
//   POST /api/auth/link                  {username, password}  link this Google login to a password account (footer pop-up)
// After a campaign is loaded the shell is told to reload the Soundboard and Campaign pages
// (postMessage {type: "reloadPages"}), because they keep their own copy of the board in memory.

const { h, api, status, box, dataTable } = UI;   // (finder.js and browse.js are loaded first by home.html)
const role = document.body.dataset.role;
const root = document.getElementById("home");

// attempt(msg, fn, rebuild): run an action; show the server's error under it if it fails, otherwise rebuild
// the page (unless `rebuild` is false, for actions whose confirmation message should stay on screen).
const attempt = (msg, fn, rebuild = true) => async () => {
  try { await fn(); if (rebuild) boot(); } catch (e) { msg.say(e.message, true); }
};

// openSheet(id): ask the shell to show the Characters tab on that character.
const openSheet = id => parent.postMessage({ type: "goto", page: "party", path: "/_/party/" + id }, location.origin);

// characterTable(key, rows, opts) - the one table for characters, used for the party AND for the roster.
//   rows  [{ id, name, class, owner, hp, hpMax, present }]   (present === false: a party slot whose sheet is not uploaded yet)
//   opts  { users: accounts the DM can assign a character to (omit for players), buttons: (row) -> buttons, empty }
function characterTable(key, rows, { users, buttons, empty }) {
  const owner = r => {
    if (!users) return r.owner || "";
    const sel = h("select", { onchange: () => api(`/api/party/${r.id}/owner`, "PUT", { owner: sel.value }).then(boot) },
      h("option", { value: "", textContent: "(no owner)" }),
      users.map(u => h("option", { value: u.name, textContent: u.name, selected: u.name.toLowerCase() === (r.owner || "").toLowerCase() })));
    return sel;
  };
  return dataTable({
    key, rows, empty,
    columns: [
      { label: "Character", text: r => r.name || r.id },
      { label: "Class", text: r => r.class || "", filter: true },
      { label: "Player", text: r => r.owner || "(no owner)", show: owner, filter: true },
      { label: "HP", text: r => (r.present === false ? "waiting for upload" : `${r.hp}/${r.hpMax}`) },
    ],
    // Every row that has a sheet here also gets a download (a Fight Club zip of just that character).
    actions: r => [...buttons(r), r.present === false ? null : h("button", { className: "btn", onclick: () => downloadCharacters(`/api/party/${r.id}/export.zip`, r.name || r.id), textContent: "⬇", title: "Download this character (you choose the format)" })],
  });
}

// uploadBox(users): the Fight Club import form. A DM also gets a drop-down to choose whose character it is.
function uploadBox(users) {
  const file = h("input", { type: "file", accept: ".backup,.xml,.zip,.gloan5e" });
  const owner = users && h("select", {}, h("option", { value: "", textContent: "(no owner)" }),
    users.map(u => h("option", { value: u.name, textContent: u.name })));
  const msg = status();
  // Importer (importer.js) looks inside the file, asks which characters to import, then imports each chosen one on its own.
  const btn = h("button", { className: "primary", textContent: "Upload", onclick: async () => {
    if (!file.files[0]) return msg.say("Choose a file first", true);
    msg.say("Reading the file…");
    const res = await Importer.start(file.files[0], { owner: owner?.value, onDone: () => {
      boot();
      parent.document.getElementById("f-party")?.contentWindow.location.reload();   // the Characters tab shows the new sheets
    } });
    msg.say(res ? `Imported ${res.imported.length} character(s)` : "Nothing imported");
  } });
  return h("div", {}, h("p", { className: "muted", textContent: "A Fight Club 5 backup (.backup / .xml), a Gloan5e file (.gloan5e: a backup plus worn items, attunement, conditions and trackers) or a zip containing a backup. The type is recognised from the file. You choose which characters in it to import; characters with the same id are updated." }),
    h("div", { className: "row" }, file, owner, btn), msg,
    // The Fight Club 5e collection zip (a button, not a link: safeDownload prints a failure beside the button). "Download all characters" is in the
    // Characters box above.
    h("div", { className: "row" }, h("button", { onclick: () => safeDownload("/download/collection.zip"), textContent: "⬇ Fight Club 5e collection zip" })));
}

// linkFooter(me): a small line at the very bottom of this page, shown only to someone signed in with Google alone.
// It opens a pop-up where they name the user name they already have and prove it with its password; their Google login
// then opens that same account. (Done by the person, never the DM. Nowhere else in the app offers it.)
function linkFooter(me) {
  if (me.hasPassword || me.user?.name === "local") return null;
  const name = h("input", { placeholder: "Your existing user name", autocomplete: "username" });
  const pw = h("input", { type: "password", placeholder: "Its password", autocomplete: "current-password" });
  const msg = status();
  const dlg = h("dialog", {},
    h("h2", { textContent: "Link this login to a password login" }),
    h("p", { className: "muted", textContent: "You are signed in with Google. If you also have a user name and password here, link them: afterwards either way of signing in opens the same account, with the same characters and campaigns." }),
    h("div", { className: "row" }, name, pw), msg,
    h("menu", {}, h("span", { className: "grow" }), h("button", { textContent: "Cancel", onclick: () => dlg.close() }),
      h("button", { className: "primary", textContent: "Link", onclick: async () => {
        try {
          await api("/api/auth/link", "POST", { username: name.value, password: pw.value });
          parent.location.reload();   // the browser is now signed in as the other account
        } catch (e) { msg.say(e.message, true); }
      } })));
  return h("footer", { className: "homefoot" }, dlg,
    h("button", { className: "linkish", textContent: "Already have a user name and password? Link this login", onclick: () => { msg.say(""); dlg.showModal(); } }));
}

// passwordBox(): change your own password.
function passwordBox() {
  const oldPw = h("input", { type: "password", placeholder: "Current password", autocomplete: "current-password" });
  const newPw = h("input", { type: "password", placeholder: "New password (8+ characters)", autocomplete: "new-password" });
  const msg = status();
  return box("password", "Password", h("div", { className: "row" }, oldPw, newPw, h("button", { textContent: "Change", onclick: async () => {
    try {
      await api("/api/auth/password", "POST", { old: oldPw.value, new: newPw.value });
      oldPw.value = newPw.value = "";
      msg.say("Password changed");
    } catch (e) { msg.say(e.message, true); }
  } })), msg);
}

// ---------------------------------------------------------------- player view
async function playerView(me) {
  const [mine, camps] = await Promise.all([api("/api/party"), api("/api/my/campaigns")]);
  const inParty = new Set(camps.myCharactersInParty);
  const msg = status();
  return [
    box("mine", "Your characters", h("div", { className: "row" }, h("button", { onclick: () => downloadCharacters("/api/party/export.zip", "all your characters"), textContent: "⬇ Download all my characters", title: "One Fight Club backup file holding every character assigned to you" })), characterTable("mine", mine.map(c => ({ ...c, class: c.class })), {
      empty: "You have not uploaded a character yet.",
      buttons: c => [inParty.has(c.id) ? h("span", { className: "ok", textContent: `In ${camps.loaded}` }) : null,
        h("button", { textContent: "Open sheet", onclick: () => openSheet(c.id) })],
    })),
    box("upload", "Upload your character", uploadBox(null)),
    box("campaigns", "Campaigns", dataTable({
      key: "pcamps", rows: camps.campaigns, empty: "There are no campaigns yet.",
      columns: [
        { label: "Campaign", text: c => c.name + (c.name === camps.loaded ? "  (running now)" : "") },
        { label: "You", text: c => (c.status === "member" ? "In this campaign" : c.status === "requested" ? "Request sent" : "Not joined"), filter: true },
      ],
      actions: c => (c.status === "none" ? [h("button", { textContent: "Request to join", onclick: attempt(msg, () => api(`/api/my/campaigns/${encodeURIComponent(c.name)}/request`, "POST")) })] : []),
    }), h("p", { className: "muted", textContent: "Ask to join a campaign and your DM will see the request." }), msg),
    me.hasPassword ? passwordBox() : null,
  ];
}

// ---------------------------------------------------------------- DM view
async function dmView(me) {
  const [camps, ap, chars, users, invites, requests] = await Promise.all([
    api("/api/campaigns"), api("/api/active-party"), api("/api/party"), api("/api/auth/users"),
    api("/api/auth/invites"), api("/api/auth/requests"),
  ]);
  const inParty = new Set(ap.party.map(p => p.id));
  const byId = new Map(chars.map(c => [c.id, c]));
  // Party rows: the uploaded character when it exists here, otherwise the saved reference (waiting for upload).
  const partyRows = ap.party.map(p => (byId.has(p.id) ? { ...byId.get(p.id), present: true } : { id: p.id, name: p.name, owner: p.owner, present: false }));
  const rosterRows = chars.filter(c => !inParty.has(c.id));
  const setParty = ids => api("/api/active-party", "PUT", { ids }).then(boot);
  return [
    requests.length ? requestsBox(requests) : null,
    campaignBox(camps, ap),
    box("party", ap.campaign ? `Party in ${ap.campaign}` : "Party in this campaign", characterTable("party", partyRows, {
      users, empty: "No one is in the party yet. Use Add to campaign below.",
      buttons: p => [p.present ? h("button", { textContent: "Open", onclick: () => openSheet(p.id) }) : null,
        h("button", { className: "danger", textContent: "Remove from campaign", onclick: () => setParty([...inParty].filter(id => id !== p.id)) })],
    })),
    box("roster", "Characters", h("div", { className: "row" }, h("button", { onclick: () => downloadCharacters("/api/party/export.zip", "all characters"), textContent: "⬇ Download all characters", title: "One Fight Club backup file holding every character" })), characterTable("roster", rosterRows, {
      users, empty: chars.length ? "Every uploaded character is in the campaign." : "No characters uploaded yet.",
      buttons: c => [h("button", { className: "primary", textContent: "Add to campaign", onclick: () => setParty([...inParty, c.id]) }),
        h("button", { textContent: "Open", onclick: () => openSheet(c.id) })],
    })),
    playersBox(users),
    invitesBox(invites),
    box("upload", "Upload a character", uploadBox(users)),
    // Search and browse the campaign's encounters and loot tables (Open jumps to that tab with the record selected).
    browseHost("encounter", "encounters"), browseHost("loot", "loot"),
  ];
}

// browseHost(kind, page): a Browse list whose Open button shows the Encounters or Loot tab on that record.
function browseHost(kind, page) {
  const host = h("div");
  Browse.mount(host, kind, r => parent.postMessage({ type: "goto", page, path: `/_/${page}?id=${r.id}` }, location.origin));
  return host;
}

// requestsBox: players asking to join a campaign. Shown first, and only when there is something to answer.
function requestsBox(requests) {
  const msg = status();
  const answer = (r, approve) => attempt(msg, () => api("/api/auth/requests/resolve", "POST", { user: r.user, campaign: r.campaign, approve }));
  return box("requests", `Join requests (${requests.length})`, dataTable({
    key: "requests", rows: requests,
    columns: [{ label: "Player", text: r => r.user, filter: true }, { label: "Campaign", text: r => r.campaign, filter: true }],
    actions: r => [h("button", { className: "primary", textContent: "Approve", onclick: answer(r, true) }), h("button", { textContent: "Deny", onclick: answer(r, false) })],
  }), msg);
}

// campaignBox: which campaign is loaded, load or delete saved ones, save the current board as a campaign.
function campaignBox(camps, ap) {
  const msg = status();
  const reload = () => parent.postMessage({ type: "reloadPages" }, location.origin);
  const name = h("input", { placeholder: "Campaign name", value: ap.campaign || "" });
  return box("campaigns", "Campaigns",
    h("p", { textContent: ap.campaign ? `Loaded: ${ap.campaign}` : "No saved campaign is loaded (this is the working board)." }),
    dataTable({
      key: "campaigns", rows: camps.map(n => ({ name: n, loaded: n === ap.campaign })), empty: "No saved campaigns yet.",
      columns: [{ label: "Campaign", text: r => r.name }, { label: "State", text: r => (r.loaded ? "loaded" : "saved"), filter: true }],
      actions: r => [
        h("button", { textContent: "Load", onclick: async () => {
          if (!confirm(`Load campaign "${r.name}"? The current board is saved as a version first.`)) return;
          await parent.flushAllPages?.();   // send the pages' unsaved edits first, so they cannot overwrite the loaded campaign afterwards
          await api(`/api/campaigns/${encodeURIComponent(r.name)}/load`, "POST");
          reload(); boot();
        } }),
        h("button", { className: "danger", textContent: "Delete", onclick: async () => {
          if (confirm(`Delete campaign "${r.name}"?`)) { await api("/api/campaigns/" + encodeURIComponent(r.name), "DELETE"); boot(); }
        } })],
    }),
    h("div", { className: "row" }, name, h("button", { className: "primary", textContent: "Save current board as campaign", onclick: attempt(msg, async () => { await parent.flushAllPages?.(); return api("/api/campaigns", "POST", { name: name.value }); }) })),
    h("p", { className: "muted", textContent: "A campaign holds the campaign tracker (cards that point at encounters and loot tables, which are shared by every campaign), its combat and the list of party members, and remembers its default soundboard (loaded with it) and the last one you used. Party members are only references: each character's sheet stays with the player who uploaded it." }),
    msg);
}

// playersBox: accounts: how each signs in and which campaigns they are in. Linking two logins is done by the
// person themselves (see linkBox), not here.
function playersBox(users) {
  const msg = status();
  const act = (fn, rebuild) => attempt(msg, fn, rebuild);
  return box("players", "Players", dataTable({
    key: "players", rows: users, empty: "No accounts yet.",
    columns: [
      { label: "User", text: u => u.name },
      { label: "Level", text: u => (u.role === "dm" ? "DM" : "Player"), filter: true },
      { label: "Signs in with", text: u => [u.hasPassword ? "password" : "", ...u.emails.map(e => "Google: " + e)].filter(Boolean).join(", "),
        show: u => h("div", {}, u.hasPassword ? h("div", { className: "muted", textContent: "password" }) : null,
          u.emails.map(e => h("div", { className: "muted" }, `Google: ${e} `,
            h("button", { className: "tiny", textContent: "✕", title: "Unlink this Google address",
              onclick: act(() => api(`/api/auth/users/${encodeURIComponent(u.name)}/email/${encodeURIComponent(e)}`, "DELETE")) })))) },
      { label: "Campaigns", text: u => u.campaigns.join(", ") || "none",
        show: u => (u.campaigns.length ? h("div", {}, u.campaigns.map(c => h("div", { className: "muted" }, `${c} `,
          h("button", { className: "tiny", textContent: "✕", title: "Remove from this campaign",
            onclick: act(() => api(`/api/auth/users/${encodeURIComponent(u.name)}/campaigns/${encodeURIComponent(c)}`, "DELETE")) })))) : h("span", { className: "muted", textContent: "none" })) },
    ],
    actions: u => [
      // A password reset only makes sense for an account that has a password. A Google-only account has nothing to reset.
      u.hasPassword ? h("button", { textContent: "Reset password", onclick: () => {
        const pw = prompt(`New password for ${u.name} (8+ characters):`);
        if (pw) act(() => api(`/api/auth/users/${encodeURIComponent(u.name)}/password`, "POST", { password: pw }).then(() => msg.say("Password changed")), false)();
      } }) : null,
      h("button", { className: "danger", textContent: "Delete", onclick: () => {
        if (!confirm(`Delete the account ${u.name}? Their characters stay, with no owner.`)) return;
        act(() => api("/api/auth/users/" + encodeURIComponent(u.name), "DELETE"))();
      } })],
  }), msg);
}

// invitesBox: make invite links for new players and list the unused ones.
function invitesBox(invites) {
  const note = h("input", { placeholder: "Who is it for? (a reminder, e.g. Alice)" });
  const linkLine = h("p", {});
  const full = path => location.origin + path;
  return box("invites", "Invite links",
    h("div", { className: "row" }, note, h("button", { className: "primary", textContent: "Create invite link", onclick: async () => {
      const r = await api("/api/auth/invites", "POST", { note: note.value });
      linkLine.textContent = `Send this link (valid 7 days, works once): ${full(r.path)}`;
      navigator.clipboard.writeText(full(r.path)).catch(() => {});
      boot();
    } })), linkLine,
    dataTable({
      key: "invites", rows: invites, empty: "No unused invite links.",
      columns: [{ label: "For", text: i => i.note || "(no note)" }, { label: "Link", text: i => full("/invite/" + i.token) }],
      actions: i => [h("button", { textContent: "Copy", onclick: () => navigator.clipboard.writeText(full("/invite/" + i.token)) }),
        h("button", { className: "danger", textContent: "Revoke", onclick: () => api("/api/auth/invites/" + i.token, "DELETE").then(boot) })],
    }));
}

// ---------------------------------------------------------------- start
let booting = false;
// boot(): (re)build the page from fresh server data. Called on load and after every change.
async function boot() {
  if (booting) return;
  booting = true;
  try {
    const me = await api("/api/auth/me");
    const parts = await (role === "dm" ? dmView(me) : playerView(me));
    root.replaceChildren(h("h1", {}, h("img", { className: "brandicon", src: "/static/icon.jpeg", alt: "" }), " DND Tracker"), ...parts.filter(Boolean), linkFooter(me) || []);
  } catch (e) {
    root.replaceChildren(h("p", { className: "bad", textContent: e.message }));
  } finally { booting = false; }
}
boot();
