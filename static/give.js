"use strict";
// =============================================================================
// give.js - giving a LOOT ITEM to a character: the one place every source of loot uses (the Loot tab's entries and rolls, the campaign tracker's loot pop-up,
// a roll on a table, a random item of a rarity). It also holds the one place that turns an Open5e item record into the body the server's add-item route takes,
// which the character sheet's "Add loot" uses too.
//
//   Give.itemBody(full)         an Open5e item record (GET /api/items/<slug>) -> { name, type, rarity, text, attunement }
//   Give.body(entry)            promise of that body for a loot ENTRY { slug?, name, type?, rarity?, note? }: a listed item is looked up (its description comes
//                               with it), one typed by hand ("50 gold pieces") becomes a plain item with the name and note
//   Give.toParty(entry)         pop-up: choose a character of the loaded campaign's party and how many; adds the item to that character, highlighted
//                               "Given to you by the DM" on their sheet until they acknowledge it. Promise of the character's name ("" when closed without giving)
//   Give.button(getEntry, onGiven)   a small "🎁 Give" button: getEntry() -> the entry (or null) when pressed; onGiven(entry, characterName) afterwards
//
// SERVER: POST /api/party/<id>/items {...body, quantity, givenBy: true} (party.add_item; the DM only may set givenBy) and GET /api/active-party.
// Needs ui.js and nodes.js loaded first.
// =============================================================================
const Give = (() => {
  const { h, api } = UI;

  const itemBody = f => ({ name: f.name, type: f.type, rarity: f.rarity, text: (f.desc || "").replace(/\*\*/g, ""), attunement: !!(f.requires_attunement || "").trim() });

  async function body(entry) {
    if (entry.slug) return itemBody(await api("/api/items/" + encodeURIComponent(entry.slug)));
    return { name: entry.name, typeCode: "15", text: entry.note || "" };
  }

  function toParty(entry) {
    return new Promise(async resolve => {
      let who;
      try { who = ((await api("/api/active-party")).party || []).filter(p => p.present !== false); } catch (e) { alert(e.message); return resolve(""); }
      if (!who.length) {
        Nodes.popup({ title: `Give ${entry.name}`, body: h("p", { className: "muted", textContent: "There is nobody to give it to: the loaded campaign has no characters in its party yet (add them on the Home tab)." }) });
        return resolve("");
      }
      const dlg = Nodes.form({
        title: `Give ${entry.name}`, saveLabel: "Give",
        note: "It goes into their inventory, highlighted \"Given to you by the DM\" until they acknowledge it.",
        fields: [{ key: "to", label: "Give to", type: "select", value: who[0].id, options: who.map(p => ({ value: p.id, label: p.name + (p.owner ? ` (${p.owner})` : "") })) },
          { key: "quantity", label: "How many", type: "number", min: 1, max: 9999, value: 1 }],
        save: async v => {
          try {
            await api(`/api/party/${encodeURIComponent(v.to)}/items`, "POST", { ...(await body(entry)), quantity: v.quantity || 1, givenBy: true });
          } catch (e) { return e.message; }
          resolve(who.find(p => p.id === v.to)?.name || "");
        },
      });
      dlg.addEventListener("close", () => resolve(""), { once: true });   // (a promise settles once: closing after a successful give changes nothing)
    });
  }

  function button(getEntry, onGiven) {
    const b = h("button", { className: "tiny", textContent: "🎁 Give", title: "Give this to a character in the party",
      onclick: async () => { const e = getEntry(); if (!e) return; const who = await toParty(e); if (who) onGiven?.(e, who); } });
    return b;
  }

  return { itemBody, body, toParty, button };
})();
