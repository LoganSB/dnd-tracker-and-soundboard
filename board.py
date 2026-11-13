"""The shape of a board (soundboard and campaign tracker) and the one-way conversion from the old shape.

THE MODEL (both pages)
  A board is a TREE of SECTIONS holding CARDS. There is one kind of container, the section, and it nests: a section's parent is
  another section (or "" for none). Every card (a sound, a timer, a campaign flag ...) has a `section` (its parent, or "" for none).
  Nothing depends on its parent: deleting a section hands its children to the section's own parent.

    soundboard   state = { "sections": [section], "sounds": [sound], "timers": [timer], "campaign": {...}, ... }
    campaign     campaign = { "sections": [section], "items": [card], "links": [link] }
    section      { "id", "name", "parent": "" | section id, "collapsed"?, "x"?, "y"?,
                   soundboard only: "volume", "fade": {"on","secs"}, "linkFade", "pinned" }
    card         { "id", "name", "section": "" | section id, "x", "y", ... }

THE OLD SHAPE (before sections could nest) had three fixed levels: sections > TILES > subsections, with cards inside tiles
(`tiles[].sounds` / `tiles[].items`, and `group` = the subsection). migrate_state() / migrate_campaign() turn that into the
model above: each tile becomes a section inside its old section, each subsection a section inside its tile, and each card points
at the innermost one. The cards held by the old hidden "(no tile)" holder get section "". Both functions are idempotent: a board
already in the new shape is left alone, so they are safe to call on every load.
"""
LOOSE = "_loose"   # the id of the old hidden holder tile for cards that had no tile


def _flatten(old_sections, tiles, card_key):
    """Old sections + tiles (with subsections and cards) -> (sections, cards) in the new shape."""
    sections = [{**s, "parent": s.get("parent", "")} for s in old_sections or []]
    known = {s["id"] for s in sections}
    cards = []
    for t in tiles or []:
        if t.get("id") == LOOSE:
            for c in t.get(card_key, []):
                c["section"] = ""
                cards.append(c)
            continue
        sec = {k: v for k, v in t.items() if k not in (card_key, "subs", "section", "w")}
        sec["parent"] = t.get("section", "") if t.get("section", "") in known else ""
        sections.append(sec)
        known.add(sec["id"])
        subs = {}
        for sub in t.get("subs", []):
            subs[sub["id"]] = True
            s2 = {"id": sub["id"], "name": sub.get("name", ""), "parent": t["id"]}
            if "x" in sub and "y" in sub:
                s2.update(x=sub["x"], y=sub["y"])
            sections.append(s2)
        for c in t.get(card_key, []):
            g = c.pop("group", None)
            c["section"] = g if g in subs else t["id"]
            cards.append(c)
    return sections, cards


def _relink(links):
    """Link keys of the old shape ("tile:ID", "sub:TILE:SUB") point at sections now ("sec:ID")."""
    for l in links or []:
        for end in ("from", "to"):
            k = l.get(end, "")
            if k.startswith("tile:"):
                l[end] = "sec:" + k[5:]
            elif k.startswith("sub:"):
                l[end] = "sec:" + k.split(":")[2]
    return links


def migrate_campaign(c):
    """Campaign dict in the old shape -> the new shape (in place); a campaign already in the new shape is only tidied."""
    if "tiles" in c:
        c["sections"], c["items"] = _flatten(c.get("sections"), c.pop("tiles"), "items")
        _relink(c.get("links"))
    c.setdefault("sections", [])
    c.setdefault("items", [])
    c.setdefault("links", [])
    for s in c["sections"]:
        s.setdefault("parent", "")
    for i in c["items"]:
        i.setdefault("section", "")
    return c


def migrate_state(s):
    """Soundboard state (with its campaign inside) in the old shape -> the new shape (in place). Returns `s`."""
    if "tiles" in s:
        s["sections"], s["sounds"] = _flatten(s.get("sections"), s.pop("tiles"), "sounds")
    if isinstance(s.get("campaign"), dict):
        migrate_campaign(s["campaign"])
    if "sounds" in s:
        s.setdefault("sections", [])
        s.setdefault("timers", [])
        for sec in s["sections"]:
            sec.setdefault("parent", "")
        for c in s["sounds"] + s["timers"]:
            c.setdefault("section", "")
    return s


def default_state():
    """A fresh, empty soundboard: four sections to put sounds in (the first is pinned: it cannot be deleted) and no sounds."""
    def sec(sid, name, pinned=False):
        return {"id": sid, "name": name, "parent": "", "pinned": pinned, "volume": 1, "fade": {"on": True, "secs": 1}, "linkFade": 2}
    return {"revision": 0, "sections": [sec("main", "Main / Persistent", True), sec("challenge-1", "Challenge 1"),
                                        sec("secret-challenge", "Secret Challenge"), sec("end-boss", "End Boss")],
            "sounds": [], "timers": []}
