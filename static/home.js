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
//   POST /api/auth/merge                 {keep, merge}  "these two logins are the same person" (DM)
//   POST /api/auth/users/<name>/email    {email}  let an account also sign in with a Google address (DM)
//   GET  /api/auth/requests              pending "let me join this campaign" requests (DM)
//   POST /api/auth/requests/resolve      {user, campaign, approve}
//   GET  /api/my/campaigns               (player) campaign names with my status: member / requested / none
//   POST /api/my/campaigns/<name>/request   (player) ask to join
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

// attempt(msg, fn, rebuild): run an action; show the server's error text under it if it fails, otherwise rebuild
// the page (unless `rebuild` is false, for actions whose confirmation message should stay on screen).
const attempt = (msg, fn, rebuild = true) => async () => {
  try { await fn(); if (rebuild) boot(); } catch (e) { msg.say(e.message, true); }
};

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
  const [mine, camps] = await Promise.all([api("/api/party"), api("/api/my/campaigns")]);
  const inParty = new Set(camps.myCharactersInParty);
  const cards = mine.length ? mine.map(c => h("div", { className: "homecard" },
    c.hasImage ? h("img", { src: `/api/party/${c.id}/portrait`, alt: "" }) : null,
    h("div", {}, h("strong", { textContent: c.name }),
      h("div", { className: "muted", textContent: `${c.class || ""}  ·  HP ${c.hp}/${c.hpMax}` }),
      inParty.has(c.id) ? h("div", { className: "ok", textContent: `In the party for ${camps.loaded}` }) : null),
    h("button", { textContent: "Open sheet", onclick: () => openSheet(c.id) })))
    : [h("p", { className: "muted", textContent: "You have not uploaded a character yet." })];
  return [
    section("Your character", ...cards),
    section("Upload your character", uploadBox(null)),
    playerCampaignsBox(camps),
    passwordBox(),
  ];
}

// playerCampaignsBox: the names of the campaigns, whether I belong to each, and a button to ask the DM to add me.
function playerCampaignsBox(camps) {
  const msg = status();
  const rows = camps.campaigns.length ? camps.campaigns.map(c => h("li", {},
    h("span", { textContent: c.name + (c.name === camps.loaded ? "  (running now)" : "") }),
    c.status === "member" ? h("span", { className: "ok", textContent: "You are in this campaign" })
      : c.status === "requested" ? h("span", { className: "muted", textContent: "Request sent" })
        : h("button", { textContent: "Request to join", onclick: attempt(msg, () => api(`/api/my/campaigns/${encodeURIComponent(c.name)}/request`, "POST")) })))
    : [h("li", { className: "muted", textContent: "There are no campaigns yet." })];
  return section("Campaigns", h("ul", { className: "list" }, rows),
    h("p", { className: "muted", textContent: "Ask to join a campaign and your DM will see the request." }), msg);
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
  const [camps, ap, chars, users, invites, requests] = await Promise.all([
    api("/api/campaigns"), api("/api/active-party"), api("/api/party"), api("/api/auth/users"),
    api("/api/auth/invites"), api("/api/auth/requests"),
  ]);
  return [
    requests.length ? requestsBox(requests) : null,
    campaignBox(camps, ap), partyBox(ap), rosterBox(chars, users, ap), playersBox(users, invites), uploadSection(users),
  ];
}

// requestsBox: players asking to join a campaign. Shown first, and only when there is something to answer.
function requestsBox(requests) {
  const msg = status();
  const answer = (r, approve) => attempt(msg, () => api("/api/auth/requests/resolve", "POST", { user: r.user, campaign: r.campaign, approve }));
  return section(`Join requests (${requests.length})`,
    h("ul", { className: "list" }, requests.map(r => h("li", {},
      h("span", { textContent: `${r.user} wants to join ${r.campaign}` }),
      h("span", {}, h("button", { className: "primary", textContent: "Approve", onclick: answer(r, true) }),
        h("button", { textContent: "Deny", onclick: answer(r, false) }))))), msg);
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
    h("div", { className: "row" }, name, h("button", { className: "primary", textContent: "Save current board as campaign", onclick: attempt(msg, () => api("/api/campaigns", "POST", { name: name.value })) })),
    h("p", { className: "muted", textContent: "A campaign holds the soundboard, the campaign tracker and the list of party members. Party members are only references: each character's sheet stays with the player who uploaded it." }),
    msg);
}

// setParty(ids): save the party. Characters move between the two lists below purely because of this list:
// the party list shows the ids in it, the roster shows everyone else.
const setParty = ids => api("/api/active-party", "PUT", { ids }).then(boot);

// partyBox: the loaded campaign's party. "Remove from campaign" moves a character back to the Characters list.
function partyBox(ap) {
  const rows = ap.party.length ? ap.party.map(p => h("li", {},
    h("span", { textContent: `${p.name || p.id}${p.owner ? "  ·  " + p.owner : ""}` }),
    h("span", {},
      p.present ? h("button", { textContent: "Open", onclick: () => openSheet(p.id) })
        : h("span", { className: "warn", textContent: `waiting for ${p.owner || "an upload"} ` }),
      h("button", { textContent: "Remove from campaign", onclick: () => setParty(ap.party.map(q => q.id).filter(id => id !== p.id)) }))))
    : [h("li", { className: "muted", textContent: "No one is in the party yet. Use Add to campaign below." })];
  return section(ap.campaign ? `Party in ${ap.campaign}` : "Party in this campaign", h("ul", { className: "list" }, rows));
}

// rosterBox: uploaded characters that are NOT in the party, with who owns each. "Add to campaign" moves one
// into the party list above (and makes its owner a member of the campaign).
function rosterBox(chars, users, ap) {
  const inParty = new Set(ap.party.map(p => p.id));
  const free = chars.filter(c => !inParty.has(c.id));
  const rows = free.length ? free.map(c => {
    const owner = h("select", { onchange: () => api(`/api/party/${c.id}/owner`, "PUT", { owner: owner.value }).then(boot) },
      h("option", { value: "", textContent: "(no owner)" }),
      users.map(u => h("option", { value: u.name, textContent: u.name, selected: u.name.toLowerCase() === (c.owner || "").toLowerCase() })));
    return h("tr", {},
      h("td", { textContent: c.name }), h("td", { className: "muted", textContent: c.class }), h("td", {}, owner),
      h("td", {}, h("button", { className: "primary", textContent: "Add to campaign", onclick: () => setParty([...inParty, c.id]) }),
        h("button", { textContent: "Open", onclick: () => openSheet(c.id) })));
  }) : [h("tr", {}, h("td", { colSpan: 4, className: "muted", textContent: chars.length ? "Every uploaded character is in the campaign." : "No characters uploaded yet." }))];
  return section("Characters",
    h("table", { className: "loot" }, h("tr", {}, ["Character", "Class", "Player", ""].map(t => h("th", { textContent: t }))), rows));
}

// playersBox: accounts (how each signs in, which campaigns they are in), linking two accounts that are the same
// person, and invite links for new players.
function playersBox(users, invites) {
  const msg = status();
  const act = (fn, rebuild) => attempt(msg, fn, rebuild);
  const rows = users.map(u => h("tr", {},
    h("td", { textContent: u.name }),
    h("td", { textContent: u.role === "dm" ? "DM" : "Player" }),
    // How they sign in: a password, and/or Google addresses (each can be unlinked).
    h("td", {}, u.hasPassword ? h("div", { className: "muted", textContent: "password" }) : null,
      u.emails.map(e => h("div", { className: "muted" }, `Google: ${e} `,
        h("button", { className: "tiny", textContent: "✕", title: "Unlink this Google address",
          onclick: act(() => api(`/api/auth/users/${encodeURIComponent(u.name)}/email/${encodeURIComponent(e)}`, "DELETE")) })))),
    h("td", {}, u.campaigns.length ? u.campaigns.map(c => h("div", { className: "muted" }, `${c} `,
      h("button", { className: "tiny", textContent: "✕", title: "Remove from this campaign",
        onclick: act(() => api(`/api/auth/users/${encodeURIComponent(u.name)}/campaigns/${encodeURIComponent(c)}`, "DELETE")) })))
      : h("span", { className: "muted", textContent: "none" })),
    h("td", {},
      // A password reset only makes sense for an account that has a password. A Google-only account has nothing to reset.
      u.hasPassword ? h("button", { textContent: "Reset password", onclick: async () => {
        const pw = prompt(`New password for ${u.name} (8+ characters):`);
        if (pw) act(() => api(`/api/auth/users/${encodeURIComponent(u.name)}/password`, "POST", { password: pw }).then(() => msg.say("Password changed")), false)();
      } }) : null,
      h("button", { textContent: "Add Google address", onclick: async () => {
        const email = prompt(`Google email address that should sign in as ${u.name}:`);
        if (email) act(() => api(`/api/auth/users/${encodeURIComponent(u.name)}/email`, "POST", { email }))();
      } }),
      h("button", { className: "danger", textContent: "Delete", onclick: async () => {
        if (!confirm(`Delete the account ${u.name}? Their characters stay, with no owner.`)) return;
        act(() => api("/api/auth/users/" + encodeURIComponent(u.name), "DELETE"))();
      } }))));

  // "Link accounts": two logins that are really one person. The second is folded into the first.
  const opts = () => users.map(u => h("option", { value: u.name, textContent: u.name }));
  const keep = h("select", {}, opts()), merge = h("select", {}, opts());
  if (users.length > 1) merge.selectedIndex = 1;
  const link = h("div", { className: "row" }, h("span", { textContent: "These two logins are the same person:" }),
    keep, h("span", { textContent: "(the account to keep) and" }), merge, h("span", { textContent: "(folded into it)" }),
    h("button", { textContent: "Link them", onclick: () => {
      if (keep.value === merge.value) return msg.say("Choose two different accounts", true);
      if (!confirm(`Fold ${merge.value} into ${keep.value}? ${merge.value}'s characters, campaigns and sign-in methods move to ${keep.value}, and the ${merge.value} account is deleted. ${keep.value} will need to sign in again.`)) return;
      act(() => api("/api/auth/merge", "POST", { keep: keep.value, merge: merge.value }).then(() => msg.say("Linked")))();
    } }));

  const note = h("input", { placeholder: "Who is it for? (a reminder, e.g. Alice)" });
  const linkLine = h("p", {});
  const full = path => location.origin + path;
  const pending = invites.map(i => h("li", {},
    h("span", { textContent: `${i.note || "(no note)"}  ·  ${full("/invite/" + i.token)}` }),
    h("span", {},
      h("button", { textContent: "Copy", onclick: () => navigator.clipboard.writeText(full("/invite/" + i.token)) }),
      h("button", { className: "danger", textContent: "Revoke", onclick: () => api("/api/auth/invites/" + i.token, "DELETE").then(boot) }))));
  return section("Players and invite links",
    h("table", { className: "loot" }, h("tr", {}, ["User", "Level", "Signs in with", "Campaigns", ""].map(t => h("th", { textContent: t }))), rows),
    msg,
    h("h3", { textContent: "Link accounts" }), link,
    h("h3", { textContent: "Invite a player" }),
    h("div", { className: "row" }, note, h("button", { className: "primary", textContent: "Create invite link", onclick: async () => {
      const r = await api("/api/auth/invites", "POST", { note: note.value });
      linkLine.textContent = `Send this link (valid 7 days, works once): ${full(r.path)}`;
      navigator.clipboard.writeText(full(r.path)).catch(() => {});
      boot();
    } })), linkLine,
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
