"""Encounters, the monster search (Open5e) and the initiative order. DM only: check_request in auth.py keeps
players away from every route here, because none of these paths is in its PLAYER_PREFIXES list.

WHERE THINGS ARE STORED
  Both live inside the campaign's own state (app.py's `state`, saved in data/live.json and in every saved
  campaign), so loading another campaign brings back ITS encounters and ITS combat, not the previous one's:
    state["encounters"]  [{"id","name","notes","monsters":[{"slug","name","count","hp","ac","cr","xp","bonus","doc"}]}]
    state["initiative"]  {"round","active","order":[...]}   (shape documented in static/tracker.js)
  A monster line keeps a COPY of the numbers it needs, so a saved campaign still works with no internet.

MONSTERS come from the Open5e API (https://api.open5e.com), a free service that includes Kobold Press books
such as Tome of Beasts. The browser never talks to it: these routes do, and keep answers for an hour.

app.py calls bind() once so this module can reach the live state without importing app.py (which imports us).
"""
import re
import secrets
import threading
import time

import requests
from flask import Blueprint, abort, jsonify, make_response, render_template, request

import auth
import party

bp = Blueprint("encounters", __name__)
API = "https://api.open5e.com/v1"
_ctx = {}                    # filled by bind(): {"state": function, "commit": function, "lock": lock}
_cache = {}                  # url+params -> (time fetched, answer)
_cache_lock = threading.Lock()
CACHE_SECONDS = 3600
LIST_FIELDS = "slug,name,size,type,cr,armor_class,hit_points,dexterity,document__slug,document__title"

# Experience points per challenge rating (Dungeon Master's Guide, "Encounter Building").
XP = {0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900,
      9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000,
      19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000,
      28: 120000, 29: 135000, 30: 155000}


def _fail(message, code=400):
    """Stop the request with a JSON error body (the pages read {"error": ...})."""
    abort(make_response(jsonify(error=message), code))


def bind(get_state, commit, lock):
    """Called once by app.py. get_state() returns the live state dict; commit(revision=True) saves it (and bumps
    the revision other pages poll for when `revision` is true); lock is app.py's lock."""
    _ctx.update(state=get_state, commit=commit, lock=lock)


def _state():
    return _ctx["state"]()


# ------------------------------------------------------------------ Open5e (cached)
def _get(path, params=None):
    """GET an Open5e address and return its JSON; raises abort(502) with a readable message if it is down."""
    key = path + "?" + "&".join(f"{k}={v}" for k, v in sorted((params or {}).items()))
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    try:
        r = requests.get(API + path, params=params, timeout=15, headers={"User-Agent": "dnd-tracker"})
        r.raise_for_status()
        data = r.json()
    except Exception:
        _fail("Open5e could not be reached. Try again in a moment.", 502)
    with _cache_lock:
        if len(_cache) > 500:
            _cache.clear()
        _cache[key] = (now, data)
    return data


def _mod(score):
    return (int(score or 10) - 10) // 2


def _summary(m):
    """The short record the builder's search results show."""
    cr = float(m.get("cr") or 0)
    return {"slug": m["slug"], "name": m["name"], "size": m.get("size", ""), "type": m.get("type", ""), "cr": cr,
            "xp": XP.get(cr, 0), "ac": m.get("armor_class"), "hp": m.get("hit_points"),
            "bonus": _mod(m.get("dexterity")), "doc": m.get("document__slug", ""), "docTitle": m.get("document__title", "")}


@bp.get("/api/monsters")
def search_monsters():
    """GET /api/monsters?q=&type=&doc=&crMin=&crMax=&page= -> {"count", "page", "pages", "items":[summary]}.
    Search is Open5e's own name search; the other fields narrow it. 30 results a page, easiest first."""
    a = request.args
    params = {"fields": LIST_FIELDS, "limit": 30, "ordering": "cr,name", "page": max(1, int(a.get("page", 1) or 1))}
    if a.get("q"):
        params["search"] = a["q"][:80]
    if a.get("type"):
        params["type__iexact"] = a["type"][:30]
    if a.get("doc"):
        params["document__slug"] = a["doc"][:40]
    for src, dst in (("crMin", "cr__gte"), ("crMax", "cr__lte")):
        if a.get(src, "") != "":
            try:
                params[dst] = float(a[src])
            except ValueError:
                _fail("CR must be a number")
    data = _get("/monsters/", params)
    return jsonify(count=data["count"], page=params["page"], pages=-(-data["count"] // 30),
                   items=[_summary(m) for m in data["results"]])


@bp.get("/api/monsters/documents")
def monster_sources():
    """GET /api/monsters/documents -> [{"slug","title"}] the books Open5e has monsters from."""
    data = _get("/documents/", {"fields": "slug,title", "limit": 50})
    return jsonify([{"slug": d["slug"], "title": d["title"]} for d in data["results"]])


def _full(slug):
    if not re.fullmatch(r"[\w-]+", slug):
        abort(400)
    return _get(f"/monsters/{slug}/")


@bp.get("/api/monsters/<slug>")
def monster(slug):
    """GET /api/monsters/<slug> -> the whole Open5e record (stat block text included)."""
    return jsonify(_full(slug))


@bp.get("/monster/<slug>")
def monster_page(slug):
    """GET /monster/<slug> : one stat block as a small page (used by the builder's preview and the tracker's book button)."""
    return render_template("monster.html", m=_full(slug), mod=_mod, xp=XP)


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


@bp.post("/api/encounters/<eid>/tile")
def add_encounter_tile(eid):
    """POST /api/encounters/<id>/tile {"tile": id of a campaign tracker tile, or "" for the first one} -> put this
    encounter on the campaign tracker as an encounter tile. Does nothing if that tile already has it.

    The new card has no x, y: the campaign page finds it a free spot the next time it loads the board."""
    want = str((request.get_json(force=True, silent=True) or {}).get("tile", ""))
    with _ctx["lock"]:
        st = _state()
        _find(st, eid)
        camp = st.setdefault("campaign", {})
        camp.setdefault("links", [])
        if not camp.get("sections"):
            camp["sections"] = [{"id": secrets.token_hex(4), "name": "Main story"}]
        if not camp.get("tiles"):
            camp["tiles"] = [{"id": secrets.token_hex(4), "name": "Chapter 1", "section": camp["sections"][0]["id"], "subs": [], "items": []}]
        tile = next((t for t in camp["tiles"] if t["id"] == want), camp["tiles"][0])
        tile.setdefault("items", [])
        if not any(i.get("encounter") == eid for i in tile["items"]):
            tile["items"].append({"id": secrets.token_hex(4), "name": "", "encounter": eid, "checklist": [],
                                  "triggered": False, "loot": {"entries": [], "log": []}})
        _ctx["commit"](True)
        return jsonify(tile=tile["name"])


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
    """POST /api/encounters/<id>/load {"mode": "replace"|"append"} -> the new initiative state.

    Adds one combatant per monster (several of the same kind are numbered, each rolling its own d20 + its
    Dexterity modifier, with its average hit points and armor class) and every party member who is not in the
    order yet. "replace" starts a fresh combat first; "append" (the default) adds to the one in progress.
    Any open tracker, including the pop-out window, shows it within a few seconds because it polls."""
    import random
    mode = (request.get_json(force=True, silent=True) or {}).get("mode", "append")
    d20 = lambda: random.randint(1, 20)  # noqa: E731
    with _ctx["lock"]:
        st = _state()
        enc = _find(st, eid)
        ini = _fresh() if mode == "replace" else (st.get("initiative") or _fresh())
        order = ini["order"]
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
        return jsonify(ini)
