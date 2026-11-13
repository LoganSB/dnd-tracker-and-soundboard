"""Encounters, the monster search (Open5e) and the initiative order. DM only: check_request in auth.py keeps
players away from every route here, because none of these paths is in its PLAYER_PREFIXES list.

WHERE THINGS ARE STORED
  Encounters and loot tables are a shared LIBRARY in their own files (data/encounters.json, data/loots.json), not part of
  any campaign, so every campaign can use every one; each record notes which campaigns have it on their tracker (see
  "the library" below). The combat in progress belongs to the campaign:
    state["initiative"]  {"round","active","order":[...]}   (shape documented in static/tracker.js)

MONSTERS come from the Open5e API (https://api.open5e.com), a free service that includes Kobold Press books
such as Tome of Beasts. The browser never talks to it: these routes do, and keep what they fetch on disk so the
service is called as rarely as possible (see "Open5e, with as few calls as possible" below).

app.py calls bind() once so this module can reach the live state without importing app.py (which imports us).
"""
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

import requests
from flask import Blueprint, abort, jsonify, make_response, render_template, request

import auth
import party

ROOT = Path(os.environ.get("DND_DATA_ROOT") or Path(__file__).resolve().parent)

bp = Blueprint("encounters", __name__)
API = "https://api.open5e.com/v1"
_ctx = {}                    # filled by bind(): {"state": function, "commit": function, "lock": lock}
LIST_FIELDS = "slug,name,type,cr,armor_class,hit_points,dexterity,document__slug,document__title"

# Experience points per challenge rating (Dungeon Master's Guide, "Encounter Building").
XP = {0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900,
      9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000,
      19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000,
      28: 120000, 29: 135000, 30: 155000}


def bind(get_state, commit, lock):
    """Called once by app.py. get_state() returns the live state dict; commit(revision=True) saves it (and bumps
    the revision other pages poll for when `revision` is true); lock is app.py's lock."""
    _ctx.update(state=get_state, commit=commit, lock=lock)


def _state():
    return _ctx["state"]()


# ------------------------------------------------------------------ Open5e, with as few calls as possible
# Open5e supplies two catalogues here, MONSTERS and MAGIC ITEMS, and both work the same way (class Catalog):
#   * the LIST (a short record per entry: about 3,200 monsters, 1,600 items) is fetched in one or two calls and saved
#     as data/<name>_index.json (in the bucket on Cloud Run). The browser downloads that one file and does all the
#     searching itself, so typing in a search box makes no API calls at all. It is rebuilt only when older than 30 days
#     or when the DM presses "Refresh" (at most once a day).
#   * the FULL RECORD (a stat block, an item's description) is fetched the first time it is opened and saved as
#     data/<name>/<slug>.json, so each entry costs at most one call, ever.
INDEX_DAYS, REFRESH_MIN_SECONDS = 30, 86400
RARITIES = ["common", "uncommon", "rare", "very rare", "legendary", "artifact"]


def _fail(message, code=400):
    """Stop the request with a JSON error body (the pages read {"error": ...})."""
    abort(make_response(jsonify(error=message), code))


def _mod(score):
    return (int(score or 10) - 10) // 2


def _rarity(text):
    """Open5e writes rarity many ways ("Very Rare", "uncommon (+1), rare (+2)" ...): one of RARITIES, else "varies"."""
    t = (text or "").strip().lower()
    return t if t in RARITIES else "varies"


class Catalog:
    """One Open5e catalogue kept on disk. `row(record)` turns an API record into the short list the browser searches."""

    def __init__(self, name, endpoint, fields, row, extra=None):
        self.name, self.endpoint, self.fields, self.row, self.extra = name, endpoint, fields, row, extra or {}
        self.file = ROOT / "data" / f"{name}_index.json"
        self.stats = ROOT / "data" / name
        self.data, self.building, self.guard = None, False, threading.Lock()

    def build(self):
        """Download every short record (up to 2000 a call) and save the list. Runs in a thread; keeps the old list on failure."""
        try:
            rows, docs, url, params = [], {}, self.endpoint, {"limit": 2000, "fields": self.fields}
            while True:
                r = requests.get(API + url if url.startswith("/") else url, params=params, timeout=60,
                                 headers={"User-Agent": "dnd-tracker"})
                r.raise_for_status()
                page = r.json()
                for m in page["results"]:
                    docs[m.get("document__slug", "")] = m.get("document__title", "")
                    rows.append(self.row(m))
                if not page.get("next"):
                    break
                url, params = page["next"], None          # the "next" address already carries the parameters
            out = {"built": int(time.time()), "docs": docs, "m": rows, **self.extra}
            tmp = self.file.with_suffix(".tmp")
            tmp.write_text(json.dumps(out, separators=(",", ":")))
            tmp.replace(self.file)
            self.data = out
        except Exception:
            pass
        finally:
            self.building = False

    def start(self):
        with self.guard:
            if not self.building:
                self.building = True
                threading.Thread(target=self.build, daemon=True).start()

    def index(self):
        """The list for the browser. 202 {"building": true} while the very first copy downloads (the page asks again in a
        few seconds); a copy older than 30 days is served as it is while a fresh one is fetched."""
        if self.data is None and self.file.exists():
            try:
                self.data = json.loads(self.file.read_text())
            except Exception:
                pass
        if self.data is None or time.time() - self.data.get("built", 0) > INDEX_DAYS * 86400:
            self.start()
        if self.data is None:
            return jsonify(building=True), 202
        resp = jsonify(self.data)
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    def refresh(self):
        """Fetch the list again, unless it is under a day old (so a stray click cannot hammer the service)."""
        if self.data and time.time() - self.data.get("built", 0) < REFRESH_MIN_SECONDS:
            return jsonify(error="The list was refreshed less than a day ago"), 429
        self.start()
        return jsonify(ok=True)

    def full(self, slug):
        """The whole Open5e record: from data/<name>/<slug>.json if we have it, else one API call (then saved)."""
        if not re.fullmatch(r"[\w-]+", slug):
            _fail("Bad id")
        f = self.stats / f"{slug}.json"
        if f.exists():
            try:
                return json.loads(f.read_text())
            except Exception:
                pass
        try:
            r = requests.get(f"{API}{self.endpoint}{slug}/", timeout=30, headers={"User-Agent": "dnd-tracker"})
            r.raise_for_status()
            data = r.json()
        except Exception:
            _fail("Open5e could not be reached. Try again in a moment.", 502)
        self.stats.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(data))
        return data


MONSTERS = Catalog("monsters", "/monsters/", "slug,name,type,cr,armor_class,hit_points,dexterity,document__slug,document__title",
                   lambda m: [m["slug"], m["name"], m.get("type", ""), float(m.get("cr") or 0), m.get("armor_class"),
                              m.get("hit_points"), _mod(m.get("dexterity")), m.get("document__slug", "")], {"xp": XP})
ITEMS = Catalog("magicitems", "/magicitems/", "slug,name,type,rarity,requires_attunement,document__slug,document__title",
                lambda m: [m["slug"], m["name"], m.get("type", ""), _rarity(m.get("rarity")),
                           1 if (m.get("requires_attunement") or "").strip() else 0, m.get("document__slug", "")],
                {"rarities": RARITIES + ["varies"]})


def _routes(cat, kind, page, template, **extra):
    """Register the four routes every catalogue has: /api/<kind>/index, /api/<kind>/index/refresh,
    /api/<kind>/<slug> (the full record) and /<page>/<slug> (a small readable page for it)."""
    bp.add_url_rule(f"/api/{kind}/index", f"{kind}_index", lambda: cat.index())
    bp.add_url_rule(f"/api/{kind}/index/refresh", f"{kind}_refresh", lambda: cat.refresh(), methods=["POST"])
    bp.add_url_rule(f"/api/{kind}/<slug>", f"{kind}_full", lambda slug: jsonify(cat.full(slug)))
    bp.add_url_rule(f"/{page}/<slug>", f"{kind}_page", lambda slug: render_template(template, m=cat.full(slug), **extra))


_routes(MONSTERS, "monsters", "monster", "monster.html", mod=_mod, xp=XP)
_routes(ITEMS, "items", "item", "item.html")


# ------------------------------------------------------------------ the library: encounters and loot tables
# Encounters and loot tables belong to NO campaign. They live in their own files, data/encounters.json and
# data/loots.json, so any campaign can use any of them. (Only the combat in progress, the initiative order, belongs to a
# campaign.) Each record also carries "campaigns": the names of the saved campaigns that have it on their campaign
# tracker as a card. The Browse lists filter on it. It is kept up to date by reindex() whenever a campaign is saved,
# its tracker changes, or a card is added from the Encounters / Loot tab.
#   encounter  {"id","name","notes","monsters":[{"slug","name","count","hp","ac","cr","xp","bonus","doc"}],"campaigns":[...]}
#   loot table {"id","name","notes","entries":[{"slug","name","type","rarity","weight","note"}],"campaigns":[...]}
# A line keeps a COPY of the numbers it needs, so a campaign still works with no internet.
LIB_FILES = {"encounters": ROOT / "data" / "encounters.json", "loots": ROOT / "data" / "loots.json"}
_lib_cache = {}   # kind -> (file modified time, list)


def _lib(kind):
    """The list of records of one kind (a live list: callers change it, then call _save_lib). Read from disk when the file changed."""
    f = LIB_FILES[kind]
    mtime = f.stat().st_mtime_ns if f.exists() else 0
    hit = _lib_cache.get(kind)
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        items = json.loads(f.read_text()) if mtime else []
    except Exception:
        items = []
    _lib_cache[kind] = (mtime, items)
    return items


def _save_lib(kind, items):
    f = LIB_FILES[kind]
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2))
    tmp.replace(f)
    _lib_cache[kind] = (f.stat().st_mtime_ns, items)


def _find(kind, rid):
    for r in _lib(kind):
        if r["id"] == rid:
            return r
    abort(404)


def adopt(st):
    """Older saves kept encounters and loot tables INSIDE the campaign. Move any found in state `st` into the library (a record
    already there with the same id wins) and remove them from `st`. Returns True if `st` was changed. Called on start-up and
    whenever a campaign or version is loaded."""
    changed = False
    for kind in ("encounters", "loots"):
        if kind in st:
            have = {r["id"] for r in _lib(kind)}
            moved = [dict(r, campaigns=r.get("campaigns", [])) for r in st.pop(kind) if r.get("id") not in have]
            if moved:
                _save_lib(kind, _lib(kind) + moved)
            changed = True
    return changed


def cards_of(campaign):
    """(encounter ids, loot table ids) that have a card on this campaign tracker."""
    enc, loot = set(), set()
    for i in (campaign or {}).get("items", []):
        if i.get("encounter"):
            enc.add(i["encounter"])
        src = i.get("loot", {}).get("source", "")
        if src.startswith("table:"):
            loot.add(src[6:])
    return enc, loot


def reindex(name, campaign):
    """Record, on every encounter and loot table, whether saved campaign `name` has a card for it (see "campaigns" above)."""
    if not name:
        return
    for kind, ids in zip(("encounters", "loots"), cards_of(campaign)):
        items, changed = _lib(kind), False
        for r in items:
            has, want = name in r.setdefault("campaigns", []), r["id"] in ids
            if has != want:
                r["campaigns"] = sorted((set(r["campaigns"]) | {name}) if want else (set(r["campaigns"]) - {name}))
                changed = True
        if changed:
            _save_lib(kind, items)


def forget_campaign(name):
    """A campaign was deleted: it no longer holds cards for anything."""
    for kind in ("encounters", "loots"):
        items = _lib(kind)
        if any(name in r.get("campaigns", []) for r in items):
            for r in items:
                r["campaigns"] = [c for c in r.get("campaigns", []) if c != name]
            _save_lib(kind, items)


def _on_tracker(st, field_of):
    """For the LOADED campaign: {record id: [names of the sections holding a card for it]} ("(no section)" for a loose card)."""
    out = {}
    camp = st.get("campaign", {})
    names = {s["id"]: s.get("name", "") for s in camp.get("sections", [])}
    for i in camp.get("items", []):
        rid = field_of(i)
        if rid:
            out.setdefault(rid, []).append(names.get(i.get("section", ""), "(no section)"))
    return out


def _listing(kind, field_of):
    """The records of one kind, each with "onTracker": section names in the loaded campaign (computed, not stored)."""
    with _ctx["lock"]:
        held = _on_tracker(_state(), field_of)
        return jsonify([{**r, "campaigns": r.get("campaigns", []), "onTracker": held.get(r["id"], [])} for r in _lib(kind)])


def _create(kind, default_name, extra):
    name = str((request.get_json(force=True, silent=True) or {}).get("name", "")).strip()[:80] or default_name
    with _ctx["lock"]:
        r = {"id": secrets.token_hex(4), "name": name, "notes": "", **extra, "campaigns": []}
        items = _lib(kind)
        items.append(r)
        _save_lib(kind, items)
        _ctx["commit"](True)
    return jsonify(r)


def _delete(kind, rid):
    with _ctx["lock"]:
        _save_lib(kind, [r for r in _lib(kind) if r["id"] != rid])
        _ctx["commit"](True)
    return jsonify(ok=True)


def _enc_ref(item):
    return item.get("encounter")


def _loot_ref(item):
    src = item.get("loot", {}).get("source", "")
    return src[6:] if src.startswith("table:") else None


# ---- encounters
def _clean_line(x):
    """One monster line from the browser, with every field forced to a safe type and size."""
    try:
        cr = float(x.get("cr") or 0)
    except (TypeError, ValueError):
        cr = 0.0
    num = lambda v, lo, hi: None if v in (None, "") else max(lo, min(hi, int(float(v))))  # noqa: E731
    return {"slug": str(x.get("slug", ""))[:80], "name": str(x.get("name", "Monster"))[:80] or "Monster",
            "count": num(x.get("count", 1), 1, 50) or 1, "hp": num(x.get("hp"), 0, 99999),
            "ac": num(x.get("ac"), 0, 99), "cr": cr, "xp": XP.get(cr, 0), "bonus": num(x.get("bonus", 0), -10, 20) or 0,
            "doc": str(x.get("doc", ""))[:40]}


@bp.get("/api/encounters")
def list_encounters():
    """GET /api/encounters -> every encounter, each with "campaigns" (saved campaigns that have it on their tracker) and
    "onTracker" (section names in the LOADED campaign; computed here, not stored)."""
    return _listing("encounters", _enc_ref)


@bp.post("/api/encounters")
def create_encounter():
    """POST /api/encounters {"name"} -> a new, empty encounter (returned)."""
    return _create("encounters", "New encounter", {"monsters": []})


@bp.put("/api/encounters/<eid>")
def update_encounter(eid):
    """PUT /api/encounters/<id> {"name","notes","monsters":[line]} -> the saved encounter."""
    b = request.get_json(force=True, silent=True) or {}
    if not isinstance(b.get("monsters", []), list):
        return jsonify(error="monsters must be a list"), 400
    with _ctx["lock"]:
        e = _find("encounters", eid)
        if "name" in b:
            e["name"] = str(b["name"]).strip()[:80] or e["name"]
        if "notes" in b:
            e["notes"] = str(b["notes"])[:2000]
        if "monsters" in b:
            e["monsters"] = [_clean_line(x) for x in b["monsters"][:60] if isinstance(x, dict)]
        _save_lib("encounters", _lib("encounters"))
        _ctx["commit"](True)
        return jsonify(e)


@bp.delete("/api/encounters/<eid>")
def delete_encounter(eid):
    """DELETE /api/encounters/<id>. Campaign cards that pointed at it stay and show "deleted encounter"."""
    return _delete("encounters", eid)


def _add_card(st, want, matches, make):
    """Put a card on the loaded campaign's tracker (the one place encounters and loot tables share). `want` is the id of the section it
    goes in ("" for none: a loose card). `matches(item)` says whether the card already exists in that section (then nothing is
    added) and `make()` builds a new card without x, y: the campaign page finds it a free spot the next time it loads the board.
    Returns (the section's name, the card)."""
    camp = st.setdefault("campaign", {})
    camp.setdefault("links", [])
    camp.setdefault("sections", [])
    items = camp.setdefault("items", [])
    sec = next((s for s in camp["sections"] if s["id"] == want), None)
    where = sec["id"] if sec else ""
    card = next((i for i in items if i.get("section", "") == where and matches(i)), None)
    if not card:
        card = {**make(), "section": where}
        items.append(card)
    return (sec["name"] if sec else "(no section)"), card


@bp.post("/api/encounters/<eid>/place")
def add_encounter_card(eid):
    """POST /api/encounters/<id>/place {"section": id of a campaign tracker section, or "" for none} -> put this
    encounter on the LOADED campaign's tracker as an encounter card. Does nothing if that section already has it.
    Returns {"section": its name, "item": the card's id} (the id lets the page highlight it on the campaign tracker)."""
    want = str((request.get_json(force=True, silent=True) or {}).get("section", ""))
    with _ctx["lock"]:
        st = _state()
        _find("encounters", eid)
        sec, card = _add_card(st, want, lambda i: i.get("encounter") == eid,
                               lambda: {"id": secrets.token_hex(4), "name": "", "encounter": eid, "checklist": [],
                                        "triggered": False, "loot": {"entries": [], "log": []}})
        reindex(st.get("campaignName", ""), st["campaign"])
        _ctx["commit"](True)
        return jsonify(section=sec, item=card["id"])


# ------------------------------------------------------------------ loot tables (see "the library" above)
# A flag on the campaign tracker rolls on a table when flag["loot"]["source"] = "table:<id>".
def _clean_entry(x):
    try:
        weight = max(1, min(1000, int(float(x.get("weight", 1)))))
    except (TypeError, ValueError):
        weight = 1
    return {"slug": str(x.get("slug", ""))[:80], "name": str(x.get("name", "Item"))[:80] or "Item",
            "type": str(x.get("type", ""))[:40], "rarity": _rarity(x.get("rarity")) if x.get("rarity") else "",
            "weight": weight, "note": str(x.get("note", ""))[:200]}


@bp.get("/api/loots")
def list_loots():
    """GET /api/loots -> every loot table, each with "campaigns" and "onTracker" (see list_encounters)."""
    return _listing("loots", _loot_ref)


@bp.post("/api/loots")
def create_loot():
    """POST /api/loots {"name"} -> a new empty loot table (returned)."""
    return _create("loots", "New loot table", {"entries": []})


@bp.put("/api/loots/<lid>")
def update_loot(lid):
    """PUT /api/loots/<id> {"name","notes","entries":[entry]} -> the saved table."""
    b = request.get_json(force=True, silent=True) or {}
    if not isinstance(b.get("entries", []), list):
        return jsonify(error="entries must be a list"), 400
    with _ctx["lock"]:
        t = _find("loots", lid)
        if "name" in b:
            t["name"] = str(b["name"]).strip()[:80] or t["name"]
        if "notes" in b:
            t["notes"] = str(b["notes"])[:2000]
        if "entries" in b:
            t["entries"] = [_clean_entry(x) for x in b["entries"][:200] if isinstance(x, dict)]
        _save_lib("loots", _lib("loots"))
        _ctx["commit"](True)
        return jsonify(t)


@bp.delete("/api/loots/<lid>")
def delete_loot(lid):
    """DELETE /api/loots/<id>. Flags that rolled on it keep their card and say "deleted loot table"."""
    return _delete("loots", lid)


@bp.post("/api/loots/<lid>/place")
def add_loot_card(lid):
    """POST /api/loots/<id>/place {"section"} -> put a flag on the loaded campaign's tracker that rolls on this table (like encounters).
    Returns {"section", "item"}."""
    want = str((request.get_json(force=True, silent=True) or {}).get("section", ""))
    with _ctx["lock"]:
        st = _state()
        t = _find("loots", lid)
        sec, card = _add_card(st, want, lambda i: i.get("loot", {}).get("source") == "table:" + lid,
                               lambda: {"id": secrets.token_hex(4), "name": t["name"], "checklist": [], "triggered": False,
                                        "loot": {"entries": [], "log": [], "source": "table:" + lid}})
        reindex(st.get("campaignName", ""), st["campaign"])
        _ctx["commit"](True)
        return jsonify(section=sec, item=card["id"])


# ------------------------------------------------------------------ the initiative order
def _fresh():
    return {"round": 1, "active": None, "order": []}


@bp.get("/api/initiative")
def get_initiative():
    """GET /api/initiative -> {"round","active","order"} for the LOADED campaign (a new one has an empty order)."""
    with _ctx["lock"]:
        return jsonify(_state().get("initiative") or _fresh())


@bp.put("/api/initiative")
def put_initiative():
    """PUT /api/initiative {"round","active","order":[...]} : replace the loaded campaign's combat.

    Saved with the campaign but WITHOUT bumping the revision: the tracker saves on every click, and a bump
    would make the soundboard and campaign pages reload their whole board each time."""
    body = request.get_json(force=True, silent=True) or {}
    if not isinstance(body.get("order"), list):
        return jsonify(error="order must be a list"), 400
    with _ctx["lock"]:
        _state()["initiative"] = body
        _ctx["commit"](False)
    return jsonify(ok=True)


def forget_characters(keep_ids):
    """Called (with the party's ids) when the party changes: drop combatants for characters that left it."""
    st = _state()
    ini = st.get("initiative")
    if ini and any(c.get("kind") == "pc" and c.get("pc") not in keep_ids for c in ini.get("order", [])):
        ini["order"] = [c for c in ini["order"] if c.get("kind") != "pc" or c.get("pc") in keep_ids]
        if not any(c["id"] == ini.get("active") for c in ini["order"]):
            ini["active"] = ini["order"][0]["id"] if ini["order"] else None


@bp.post("/api/encounters/<eid>/load")
def load_encounter(eid):
    """POST /api/encounters/<id>/load {"mode": "replace"|"append", "again": bool} -> {"initiative": ..., "added": n}.

    Adds one combatant per monster (several of the same kind are numbered, each rolling its own d20 + its
    Dexterity modifier, with its average hit points and armor class) and every party member who is not in the
    order yet. "replace" starts a fresh combat first; "append" (the default) adds to the one in progress.

    NO DOUBLE LOADING: an "append" is ignored (added = 0) when the order already holds monsters from this same
    encounter, so a second click, a double click or two open windows cannot double the monsters. Pass "again": true
    to add another set on purpose. Clearing the combat, or removing those monsters, makes it loadable again.
    Any open tracker, including the pop-out window, shows the result within a few seconds because it polls."""
    import random
    b = request.get_json(force=True, silent=True) or {}
    mode, again = b.get("mode", "append"), bool(b.get("again"))
    d20 = lambda: random.randint(1, 20)  # noqa: E731
    with _ctx["lock"]:
        st = _state()
        enc = _find("encounters", eid)
        ini = _fresh() if mode == "replace" else (st.get("initiative") or _fresh())
        order = ini["order"]
        if mode != "replace" and not again and any(c.get("enc") == eid for c in order):
            return jsonify(initiative=ini, added=0)
        before = len(order)
        for ref in st.get("party", []):                       # party members first (only those with a sheet here)
            if party._path(ref["id"]).exists() and not any(c.get("pc") == ref["id"] for c in order):
                s = party.summary(ref["id"], party._load(ref["id"]))
                bonus = s["mods"][1] if len(s["mods"]) > 1 else 0
                order.append({"id": secrets.token_hex(4), "kind": "pc", "pc": ref["id"], "name": s["name"],
                              "bonus": bonus, "init": d20() + bonus})
        for line in enc["monsters"]:
            have = sum(1 for c in order if c.get("base") == line["name"])
            for i in range(line["count"]):
                n = have + i + 1
                order.append({"id": secrets.token_hex(4), "kind": "npc", "base": line["name"], "mid": line["slug"],
                              "name": line["name"] if line["count"] == 1 and have == 0 else f"{line['name']} {n}",
                              "bonus": line["bonus"], "init": d20() + line["bonus"], "hp": line["hp"],
                              "hpMax": line["hp"], "ac": line["ac"], "enc": eid})
        order.sort(key=lambda c: (-(c.get("init") if c.get("init") is not None else -99), -(c.get("bonus") or 0)))
        if not any(c["id"] == ini.get("active") for c in order):
            ini["active"] = order[0]["id"] if order else None
        st["initiative"] = ini
        _ctx["commit"](False)
        return jsonify(initiative=ini, added=len(order) - before)
