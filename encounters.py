"""Encounters, the monster search (Open5e) and the initiative order. DM only: check_request in auth.py keeps
players away from every route here, because none of these paths is in its PLAYER_PREFIXES list.

WHERE THINGS ARE STORED
  Both live inside the campaign's own state (app.py's `state`, saved in data/live.json and in every saved
  campaign), so loading another campaign brings back ITS encounters and ITS combat, not the previous one's:
    state["encounters"]  [{"id","name","notes","monsters":[{"slug","name","count","hp","ac","cr","xp","bonus","doc"}]}]
    state["initiative"]  {"round","active","order":[...]}   (shape documented in static/tracker.js)
  A monster line keeps a COPY of the numbers it needs, so a saved campaign still works with no internet.

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


# ------------------------------------------------------------------ encounters (in the campaign state)
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


def _find(st, eid):
    for e in st.get("encounters", []):
        if e["id"] == eid:
            return e
    abort(404)


@bp.get("/api/encounters")
def list_encounters():
    """GET /api/encounters -> the loaded campaign's encounters, each with "onTracker": names of the campaign tracker
    tiles that hold it (computed here, not stored)."""
    with _ctx["lock"]:
        st = _state()
        tiles = st.get("campaign", {}).get("tiles", [])
        return jsonify([{**e, "onTracker": [t.get("name", "") for t in tiles if any(i.get("encounter") == e["id"] for i in t.get("items", []))]}
                        for e in st.get("encounters", [])])


@bp.post("/api/encounters")
def create_encounter():
    """POST /api/encounters {"name"} -> a new, empty encounter (returned)."""
    name = str((request.get_json(force=True, silent=True) or {}).get("name", "")).strip()[:80] or "New encounter"
    with _ctx["lock"]:
        e = {"id": secrets.token_hex(4), "name": name, "notes": "", "monsters": []}
        _state().setdefault("encounters", []).append(e)
        _ctx["commit"](True)
    return jsonify(e)


@bp.put("/api/encounters/<eid>")
def update_encounter(eid):
    """PUT /api/encounters/<id> {"name","notes","monsters":[line]} -> the saved encounter."""
    b = request.get_json(force=True, silent=True) or {}
    if not isinstance(b.get("monsters", []), list):
        return jsonify(error="monsters must be a list"), 400
    with _ctx["lock"]:
        e = _find(_state(), eid)
        if "name" in b:
            e["name"] = str(b["name"]).strip()[:80] or e["name"]
        if "notes" in b:
            e["notes"] = str(b["notes"])[:2000]
        if "monsters" in b:
            e["monsters"] = [_clean_line(x) for x in b["monsters"][:60] if isinstance(x, dict)]
        _ctx["commit"](True)
        return jsonify(e)


@bp.delete("/api/encounters/<eid>")
def delete_encounter(eid):
    """DELETE /api/encounters/<id>. Campaign tiles that pointed at it stay and show "deleted encounter"."""
    with _ctx["lock"]:
        st = _state()
        st["encounters"] = [e for e in st.get("encounters", []) if e["id"] != eid]
        _ctx["commit"](True)
    return jsonify(ok=True)


def _add_card(st, want, matches, make):
    """Put a card on the campaign tracker (the one place encounters and loot tables share). `want` is a tile id ("" for
    the first tile; a campaign with no tiles yet gets a section and a tile). `matches(item)` says whether a card already
    exists (then nothing is added) and `make()` builds a new card without x, y: the campaign page finds it a free spot
    the next time it loads the board. Returns (tile, card)."""
    camp = st.setdefault("campaign", {})
    camp.setdefault("links", [])
    if not camp.get("sections"):
        camp["sections"] = [{"id": secrets.token_hex(4), "name": "Main story"}]
    if not camp.get("tiles"):
        camp["tiles"] = [{"id": secrets.token_hex(4), "name": "Chapter 1", "section": camp["sections"][0]["id"], "subs": [], "items": []}]
    tile = next((t for t in camp["tiles"] if t["id"] == want), camp["tiles"][0])
    tile.setdefault("items", [])
    card = next((i for i in tile["items"] if matches(i)), None)
    if not card:
        card = make()
        tile["items"].append(card)
    return tile, card


@bp.post("/api/encounters/<eid>/tile")
def add_encounter_tile(eid):
    """POST /api/encounters/<id>/tile {"tile": id of a campaign tracker tile, or "" for the first one} -> put this
    encounter on the campaign tracker as an encounter tile. Does nothing if that tile already has it.
    Returns {"tile": its name, "item": the card's id} (the id lets the page highlight it on the campaign tracker)."""
    want = str((request.get_json(force=True, silent=True) or {}).get("tile", ""))
    with _ctx["lock"]:
        st = _state()
        _find(st, eid)
        tile, card = _add_card(st, want, lambda i: i.get("encounter") == eid,
                               lambda: {"id": secrets.token_hex(4), "name": "", "encounter": eid, "checklist": [],
                                        "triggered": False, "loot": {"entries": [], "log": []}})
        _ctx["commit"](True)
        return jsonify(tile=tile["name"], item=card["id"])


# ------------------------------------------------------------------ loot tables (in the campaign state)
# state["loots"] = [{"id","name","notes","entries":[{"slug","name","type","rarity","weight","note"}]}]. Like encounters, they
# belong to the campaign. A flag on the campaign tracker can roll on one (flag["loot"]["source"] = "table:<id>").
def _clean_entry(x):
    try:
        weight = max(1, min(1000, int(float(x.get("weight", 1)))))
    except (TypeError, ValueError):
        weight = 1
    return {"slug": str(x.get("slug", ""))[:80], "name": str(x.get("name", "Item"))[:80] or "Item",
            "type": str(x.get("type", ""))[:40], "rarity": _rarity(x.get("rarity")) if x.get("rarity") else "",
            "weight": weight, "note": str(x.get("note", ""))[:200]}


def _find_loot(st, lid):
    for t in st.get("loots", []):
        if t["id"] == lid:
            return t
    abort(404)


@bp.get("/api/loots")
def list_loots():
    """GET /api/loots -> the loaded campaign's loot tables, each with "onTracker": names of campaign tiles whose flags roll on it."""
    with _ctx["lock"]:
        st = _state()
        tiles = st.get("campaign", {}).get("tiles", [])
        return jsonify([{**t, "onTracker": [x.get("name", "") for x in tiles
                                            if any(i.get("loot", {}).get("source") == "table:" + t["id"] for i in x.get("items", []))]}
                        for t in st.get("loots", [])])


@bp.post("/api/loots")
def create_loot():
    """POST /api/loots {"name"} -> a new empty loot table (returned)."""
    name = str((request.get_json(force=True, silent=True) or {}).get("name", "")).strip()[:80] or "New loot table"
    with _ctx["lock"]:
        t = {"id": secrets.token_hex(4), "name": name, "notes": "", "entries": []}
        _state().setdefault("loots", []).append(t)
        _ctx["commit"](True)
    return jsonify(t)


@bp.put("/api/loots/<lid>")
def update_loot(lid):
    """PUT /api/loots/<id> {"name","notes","entries":[entry]} -> the saved table."""
    b = request.get_json(force=True, silent=True) or {}
    if not isinstance(b.get("entries", []), list):
        return jsonify(error="entries must be a list"), 400
    with _ctx["lock"]:
        t = _find_loot(_state(), lid)
        if "name" in b:
            t["name"] = str(b["name"]).strip()[:80] or t["name"]
        if "notes" in b:
            t["notes"] = str(b["notes"])[:2000]
        if "entries" in b:
            t["entries"] = [_clean_entry(x) for x in b["entries"][:200] if isinstance(x, dict)]
        _ctx["commit"](True)
        return jsonify(t)


@bp.delete("/api/loots/<lid>")
def delete_loot(lid):
    """DELETE /api/loots/<id>. Flags that rolled on it keep their card and say "deleted loot table"."""
    with _ctx["lock"]:
        st = _state()
        st["loots"] = [t for t in st.get("loots", []) if t["id"] != lid]
        _ctx["commit"](True)
    return jsonify(ok=True)


@bp.post("/api/loots/<lid>/tile")
def add_loot_tile(lid):
    """POST /api/loots/<id>/tile {"tile"} -> put a flag on the campaign tracker that rolls on this table (like encounters).
    Returns {"tile", "item"}."""
    want = str((request.get_json(force=True, silent=True) or {}).get("tile", ""))
    with _ctx["lock"]:
        st = _state()
        t = _find_loot(st, lid)
        tile, card = _add_card(st, want, lambda i: i.get("loot", {}).get("source") == "table:" + lid,
                               lambda: {"id": secrets.token_hex(4), "name": t["name"], "checklist": [], "triggered": False,
                                        "loot": {"entries": [], "log": [], "source": "table:" + lid}})
        _ctx["commit"](True)
        return jsonify(tile=tile["name"], item=card["id"])


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
        enc = _find(st, eid)
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
