"""Party members: Fight Club 5 import/export, live tracker values, full character view.

Each character is stored as its original Fight Club <character> XML element in
data/party/<id>.xml so nothing is lost and export is a faithful round-trip. Tracker edits
(HP, slots, hit dice, inspiration, money) are written back into that XML. Things Fight Club
has no field for (personal trackers such as Mana/Ki/Rage, conditions, death saves) live in data/party_extra.json and are
not exported.

HOW THIS FILE FITS IN (for readers new to Flask / XML)
------------------------------------------------------
* This is a Flask "Blueprint": a bundle of web routes defined in a separate file. app.py
  imports `bp` from here and calls app.register_blueprint(bp), which adds these routes to
  the one server. Flask is a library that owns the network loop; a decorator such as
  `@bp.get("/api/party")` registers the function below it as the callback for "HTTP GET
  /api/party" (like adding an entry to a dispatch table).
* One request: browser sends e.g. PATCH /api/party/12-Gandalf with a JSON body -> Flask
  finds the matching function -> the function loads that character's XML file, applies the
  change, saves it, and returns JSON (via jsonify) that the page's JavaScript displays.
* "Fight Club 5" is a phone app for D&D 5th edition characters. Its backup files are XML:
  text with nested tags like <character><name>Bob</name><hpMax>20</hpMax></character>.
  XML is a tree: each tag is an "element" with text and child elements. We read/modify it
  with Python's ElementTree (imported as ET): root.find("x") returns the first child <x>
  (or None), root.findall("x") returns all of them, root.findtext("x") returns its text.

Where data lives on disk (relative to this file's folder):
  data/party/<id>.xml     one file per character: the raw Fight Club <character> element
  data/party_extra.json   {character id: {"trackers": [...], "conditions": "...", "deaths": {...}}}; fields that
                          Fight Club has no tag for. Kept OUT of the XML on purpose: we want
                          the XML to stay exactly what Fight Club understands, so export
                          round-trips cleanly, and unknown tags might be rejected or lost by
                          the app. So the "mana" bar and the conditions text live here and
                          are not part of the exported backup.
  data/initiative.json    the initiative tracker's order/round/active turn
Who may see a character: its owner (the player who uploaded it, stored as "owner" in party_extra.json) and
the DM. Every route below checks this with _guard()/_may_use() using the signed-in user from auth.py.

Why characters are stored as raw XML (not converted to our own JSON): a conversion would
drop every field we do not know about (Fight Club has many). Keeping the original element
means export is just "put them back in a zip", and editing is "change a few tags in place".
The read-only views (summary() / detail()) are built on demand from that XML.

Locking: `lock` (a threading.RLock, i.e. a recursive mutex) serialises every read-modify-
write of the XML files and party_extra.json. Flask may handle several requests at once on
different threads; without it two edits could read the same file, each change a different
field, and the later write would silently undo the earlier one.
"""
import base64
import io
import json
import os
import re
import threading
import uuid
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

from flask import Blueprint, Response, abort, jsonify, request, send_file

import auth

try:  # hardened parser if available (entity-expansion attacks), stdlib otherwise
    # defusedxml is a third-party drop-in for ElementTree's parsing functions that refuses
    # malicious XML (e.g. "billion laughs" files that expand to gigabytes). It matters
    # because we parse files uploaded through the browser. We only use it for READING;
    # writing always uses the standard ET.
    from defusedxml import ElementTree as SafeET
except ImportError:  # pragma: no cover
    SafeET = ET

# The Blueprint object: the routes below attach to it, app.py attaches it to the server.
bp = Blueprint("party", __name__)
BASE = Path(__file__).resolve().parent  # folder containing this file
# ROOT: where the data lives: next to this file normally, or the folder named by the DND_DATA_ROOT
# environment variable (a mounted volume when running in a container). Same rule as app.py.
ROOT = Path(os.environ.get("DND_DATA_ROOT") or BASE)
DIR = ROOT / "data" / "party"  # Path "/" joins path pieces
EXTRA = ROOT / "data" / "party_extra.json"
DIR.mkdir(parents=True, exist_ok=True)  # create the folder if missing (mkdir -p)
lock = threading.RLock()  # see "Locking" in the module docstring

# Order of the six ability scores inside Fight Club's comma list <abilities>.
ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]
# Fight Club's numeric <type> code on an <item> -> human-readable category.
ITEM_TYPES = {"1": "Light Armor", "2": "Medium Armor", "3": "Heavy Armor", "4": "Shield",
              "5": "Melee Weapon", "6": "Ranged Weapon", "7": "Ammunition", "8": "Rod",
              "9": "Staff", "10": "Wand", "11": "Ring", "12": "Potion", "13": "Scroll",
              "14": "Wondrous Item", "15": "Gear / Treasure"}
# Fight Club's numeric <school> code on a <spell> -> school of magic.
SCHOOLS = {"1": "Abjuration", "2": "Conjuration", "3": "Divination", "4": "Enchantment",
           "5": "Evocation", "6": "Illusion", "7": "Necromancy", "8": "Transmutation"}


# ------------------------------------------------------------------ storage
def _extra():
    """Load data/party_extra.json as a dict ({} if missing or unreadable).

    Shape: {"<character id>": {"trackers": [{"id", "label", "cur", "max"}], "conditions": "text", "deaths": {"s", "f"}}}.
    (A leading underscore on a name is just a Python convention for "internal helper".)
    """
    try:
        return json.loads(EXTRA.read_text())
    except Exception:
        return {}


def _trackers(ex):
    """The list of personal trackers for one character's sidecar record `ex` (see summary).

    A character only has trackers if somebody added them: there is no default "Mana" bar any more.
    Older data kept ONE counter under "resource"; if that was ever used (a maximum or a current value
    above zero) it is presented as a single tracker so nothing is lost.
    """
    if "trackers" in ex:
        return ex["trackers"]
    r = ex.get("resource") or {}
    if r.get("max", 0) > 0 or r.get("cur", 0) > 0:
        return [{"id": "legacy", "label": r.get("label", "Mana"), "cur": r.get("cur", 0), "max": r.get("max", 0)}]
    return []


def _save_extra(d):
    """Write the sidecar dict atomically: write "<name>.tmp", then os.replace() it over the
    real file (~ write temp file then rename()), so a crash cannot leave a truncated file."""
    tmp = EXTRA.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=2))
    os.replace(tmp, EXTRA)


def _path(cid):
    """Map a character id to its XML file path, rejecting unsafe ids.

    The id comes straight from the URL, so it must not contain "/" or ".." (which would let
    a request read or overwrite files elsewhere). The regex [\\w-]+ allows only letters,
    digits, underscore and hyphen; fullmatch requires the WHOLE id to match. abort(400)
    stops the request with an HTTP 400 "Bad Request" error.
    """
    if not re.fullmatch(r"[\w-]+", cid):
        abort(400)
    return DIR / f"{cid}.xml"


def _load(cid):
    """Parse a character's XML file and return its root <character> element.
    404 (Not Found) if there is no such character. Uses the hardened parser."""
    p = _path(cid)
    if not p.exists():
        abort(404)
    return SafeET.parse(p).getroot()


def _write(cid, root):
    """Save a <character> element to data/party/<cid>.xml atomically (temp file + rename).

    ElementTree(root).write(...) serialises the tree back to text, adding the
    <?xml ...?> declaration line at the top.
    """
    p = _path(cid)
    tmp = p.with_suffix(".tmp")
    ET.ElementTree(root).write(tmp, encoding="utf-8", xml_declaration=True)
    os.replace(tmp, p)


def _ids():
    """Sorted list of all character ids (the XML file names without ".xml")."""
    return sorted(p.stem for p in DIR.glob("*.xml"))


# ------------------------------------------------------------------ helpers
def _t(e, tag, default=""):
    """Text of child <tag> of element `e`, whitespace-trimmed, or `default` if the tag is
    missing or empty. Fight Club stores every value as text, so this is used everywhere."""
    v = e.findtext(tag)
    return v.strip() if v else default


def _ints(s):
    """Pull every integer out of a string, e.g. "17,14,12," -> [17, 14, 12].

    Fight Club packs lists of numbers into one comma-separated text field (ability scores,
    spell slots). The regex -?\\d+ matches an optional minus sign followed by one or more
    digits. `s or ""` makes None safe.
    """
    return [int(x) for x in re.findall(r"-?\d+", s or "")]


def _num(s, default=0.0):
    """Convert text to float, returning `default` if it is empty/None/not a number."""
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def _mod(score):
    """D&D ability modifier: (score - 10) / 2 rounded DOWN. // is floor division, so
    9 -> -1 (not 0), matching the game's rule for odd scores below 10."""
    return (score - 10) // 2


def _feats(parent):
    """List of {"name", "text"} for every <feat> child of `parent` (a class, race,
    background or the character itself). A "feat" here means any named feature/trait."""
    return [{"name": _t(f, "name"), "text": _t(f, "text")} for f in parent.findall("feat")]


def _item(it):
    """Convert one Fight Club <item> element into a flat dict for the page.

    Field meanings: type = numeric code (see ITEM_TYPES); magic = "1" means magical;
    ac only shown if > 0; damage1H/damage2H = one-/two-handed damage dice.
    `equipped` is derived: only armor/shield/weapon/ring/wondrous types can be worn, and
    Fight Club's <slot> is "" or "1" when the item is not in an equipment slot (so any
    other slot value means it is equipped).
    """
    return {
        "name": _t(it, "name"), "detail": _t(it, "detail"), "text": _t(it, "text"),
        "type": ITEM_TYPES.get(_t(it, "type"), ""), "magic": _t(it, "magic") == "1",
        # `int(...) or 1`: a missing/zero quantity is shown as 1.
        "quantity": int(_num(_t(it, "quantity"), 1)) or 1, "weight": _num(_t(it, "weight")),
        "value": _num(_t(it, "value")),
        "ac": _t(it, "ac") if _num(_t(it, "ac"), -1) > 0 else "",
        "damage": _t(it, "damage1H"), "damage2h": _t(it, "damage2H"),
        "damageType": _t(it, "damageType"),
        "property": _t(it, "weaponProperty"), "range": _t(it, "weaponRange"),
        "equipped": _t(it, "type") in ("1", "2", "3", "4", "5", "6", "11", "14")
        and _t(it, "slot") not in ("", "1"),
    }


def _may_use(cid):
    """True if the signed-in user may see and change character `cid`: the DM always, a player only for
    the characters they own (owner names compare ignoring upper/lower case, like user names)."""
    user = auth.current_user()
    if not user:
        return False
    if user["role"] == "dm":
        return True
    return _extra().get(cid, {}).get("owner", "").lower() == user["name"].lower()


def _guard(cid):
    """Stop the request with 404 unless the signed-in user may use character `cid`. A player asking for
    someone else's character gets the same "not found" as for a character that does not exist, so the
    answer does not reveal who else is in the party. _path() first rejects an unsafe id (400)."""
    _path(cid)
    if not _may_use(cid):
        abort(404)


def reown(old, new):
    """Give every character that belonged to user `old` to user `new` (used when two accounts are linked)."""
    with lock:
        ex = _extra()
        changed = False
        for rec in ex.values():
            if rec.get("owner", "").lower() == old.lower():
                rec["owner"] = new
                changed = True
        if changed:
            _save_extra(ex)


def disown(name):
    """Clear the owner of every character that belonged to user `name` (used when the account is deleted)."""
    with lock:
        ex = _extra()
        changed = False
        for rec in ex.values():
            if rec.get("owner", "").lower() == name.lower():
                rec["owner"] = ""
                changed = True
        if changed:
            _save_extra(ex)


def summary(cid, root):
    """The short per-character record used by the party list and tracker.

    Returns a dict: id, name, class (e.g. "Wizard 5 / Cleric 1"), race, hp, hpMax,
    slots (max spell slots per level 1..9), slotsCurrent (remaining), inspiration (0/1),
    hasImage (portrait present), trackers (this character's own counters such as Mana, Ki or
    Rage, from the sidecar file; an empty list for a character that has none), conditions (free
    text from the sidecar), deaths (death saving throws), mods (six ability modifiers).
    Pure read: nothing is written.
    """
    cls = root.findall("class")  # a multiclassed character has several <class> elements
    levels = " / ".join(f"{_t(c, 'name')} {_t(c, 'level', '?')}" for c in cls)
    ex = _extra().get(cid, {})  # this character's sidecar record, or {}
    return {
        "id": cid, "name": _t(root, "name"), "class": levels, "owner": ex.get("owner", ""),
        "race": _t(root.find("race"), "name") if root.find("race") is not None else "",
        "hp": int(_num(_t(root, "hpCurrent"))), "hpMax": int(_num(_t(root, "hpMax"))),
        # <slots> and <slotsCurrent> are comma lists like "4,3,2,0,0,0,0,0,0," (index 0 =
        # 1st-level slots). slots = maximum, slotsCurrent = how many are still unspent.
        "slots": _ints(_t(root, "slots")), "slotsCurrent": _ints(_t(root, "slotsCurrent")),
        "inspiration": int(_num(_t(root, "inspiration"))),
        "hasImage": bool((root.findtext("imageData") or "").strip()),
        "trackers": _trackers(ex),
        "conditions": ex.get("conditions", ""),
        # death saving throws, kept in the sidecar file (Fight Club has no field for them)
        "deaths": ex.get("deaths", {"s": 0, "f": 0}),
        # <abilities> is "STR,DEX,CON,INT,WIS,CHA" scores; [:6] keeps just those six.
        "mods": [_mod(v) for v in _ints(_t(root, "abilities"))[:6]],
    }


def detail(cid, root):
    """The full character sheet record: everything in summary() plus abilities, race,
    background, classes (with features), spells, notes, items, containers and total weight.
    Pure read; used by GET /api/party/<cid> for the full character page."""
    d = summary(cid, root)
    scores = _ints(_t(root, "abilities"))[:6]
    # zip pairs names with scores in order, stopping at the shorter list.
    d["abilities"] = [{"name": n, "score": s, "mod": _mod(s)} for n, s in zip(ABILITIES, scores)]
    d["xp"] = _t(root, "xp")
    d["money"] = _t(root, "money")
    d["unarmed"] = _t(root, "unarmed")
    race = root.find("race")
    d["raceInfo"] = (
        {k: _t(race, k) for k in ("name", "speed", "age", "height", "weight", "eyes", "skin", "hair")}
        if race is not None else {}
    )
    d["raceFeats"] = _feats(race) if race is not None else []
    bg = root.find("background")
    d["background"] = {"name": _t(bg, "name"), "feats": _feats(bg)} if bg is not None else {}
    d["classes"], d["spells"] = [], []  # both set to a fresh empty list
    for c in root.findall("class"):
        feats = _feats(c)
        seen = {f["name"] for f in feats}  # set of feature names already listed
        # <autolevel> blocks hold the features gained at each level; add any we lack.
        for al in c.findall("autolevel"):
            for f in _feats(al):
                if f["name"] not in seen:
                    seen.add(f["name"])
                    feats.append(f)
        d["classes"].append({
            "name": _t(c, "name"), "level": _t(c, "level"),
            # hd = hit die size (e.g. 8), hdCurrent = hit dice still unspent.
            "hd": _t(c, "hd"), "hdCurrent": _t(c, "hdCurrent"),
            "armor": _t(c, "armor"), "weapons": _t(c, "weapons"), "tools": _t(c, "tools"),
            "feats": feats,
        })
        for s in c.findall("spell"):
            d["spells"].append({
                "name": _t(s, "name"), "level": int(_num(_t(s, "level"))),
                "school": SCHOOLS.get(_t(s, "school"), ""),
                "time": _t(s, "time"), "range": _t(s, "range"), "duration": _t(s, "duration"),
                # Components V/S/M (verbal/somatic/material): the tags <v>,<s>,<m> hold "1"
                # when required; join the letters of the ones that are.
                "components": "".join(k for k, f in (("V", "v"), ("S", "s"), ("M", "m")) if _t(s, f) == "1"),
                "materials": _t(s, "materials"), "text": _t(s, "text"),
                "prepared": _t(s, "prepared") == "1",
                "class": _t(s, "sclass") or _t(c, "name"),
            })
    d["feats"] = _feats(root)
    d["notes"] = [{"name": _t(n, "name"), "text": _t(n, "text")} for n in root.findall("note")]
    d["items"] = [_item(i) for i in root.findall("item")]
    d["containers"] = [
        {"name": _t(c, "name"), "weight": _num(_t(c, "weight")), "value": _num(_t(c, "value")),
         "items": [_item(i) for i in c.findall("item")]}
        for c in root.findall("container")
    ]
    # Carried weight: loose items (weight x quantity) plus each container's own weight and
    # the items inside it; rounded to one decimal place.
    d["totalWeight"] = round(
        sum(i["weight"] * i["quantity"] for i in d["items"])
        + sum(c["weight"] + sum(i["weight"] * i["quantity"] for i in c["items"])
              for c in d["containers"]),
        1)
    return d


# ------------------------------------------------------------------- import
def _characters_from(data: bytes):
    """Parse XML bytes and return a list of <character> elements found in them.

    Fight Club backups have <data> as the root with several <character> children; a single
    exported character may have <character> itself as the root. Handles both. Raises
    ET.ParseError on malformed XML.
    """
    root = SafeET.fromstring(data)
    return [root] if root.tag == "character" else root.findall("character")


def _read_upload(f):
    """Extract <character> elements from an uploaded file object `f`.

    The upload may be plain XML or a zip (Fight Club's .backup files are zips of XML).
    zipfile.is_zipfile() sniffs the content; io.BytesIO wraps the in-memory bytes so the
    zip library can treat them as a file (like fmemopen() in C). For zips, every entry
    ending .xml/.backup is parsed; directories, entries over 200 MiB uncompressed (a
    "zip bomb" guard) and unparsable entries are skipped.
    """
    raw = f.read()  # whole upload as a bytes object
    if zipfile.is_zipfile(io.BytesIO(raw)):
        out = []
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            for info in z.infolist():
                if info.is_dir() or info.file_size > 200 * 1024 * 1024:
                    continue
                if info.filename.lower().endswith((".xml", ".backup")):
                    try:
                        out += _characters_from(z.read(info))  # += on a list appends all items
                    except ET.ParseError:
                        continue
        return out
    return _characters_from(raw)


def _cid_for(ch, taken):
    """Build a character id (and file name) from the <character>'s uid and name.

    e.g. uid "12", name "Gandalf the Grey" -> "12-Gandalf-the-Grey". Spaces become hyphens,
    then the regex [^\\w-] (anything that is not a word character or hyphen) is removed so the
    result passes _path()'s safety check; "char" is used if nothing is left. Re-importing the
    same character gives the same id, so it OVERWRITES the old copy (an update, not a
    duplicate). `taken` (ids from this upload) is accepted but unused.
    """
    base = re.sub(r"[^\w-]", "", f"{_t(ch, 'uid', '0')}-{_t(ch, 'name')}".replace(" ", "-")) or "char"
    return base


@bp.post("/api/party/import")
def import_party():
    """POST /api/party/import : upload a Fight Club backup (multipart form field "file").

    Response: {"imported": ["<id>", ...]} (200), or {"error": "..."} (400) when no file was
    sent, the file cannot be parsed, or it holds no <character> entries.
    Side effects: writes one data/party/<id>.xml per character (overwriting same-id files).
    """
    f = request.files.get("file")  # uploaded files arrive in request.files, not the JSON body
    if not f:
        return jsonify(error="No file uploaded"), 400
    try:
        chars = _read_upload(f)
    except Exception as e:
        return jsonify(error=f"Could not read file: {e}"), 400
    if not chars:
        return jsonify(error="No <character> entries found in that file"), 400
    user = auth.current_user()
    with lock:
        ex = _extra()
        # Who the characters belong to: a player's upload is always theirs; the DM may name an owner in the
        # form (field "owner"), otherwise a re-imported character keeps the owner it already had.
        owner = user["name"] if user["role"] != "dm" else (request.form.get("owner") or "").strip()
        if owner and user["role"] == "dm" and owner.lower() not in auth._load()["users"]:
            return jsonify(error=f"No user named {owner}"), 400
        ids = []
        for ch in chars:
            cid = _cid_for(ch, ids)
            # A player may add new characters or update their own, never replace somebody else's.
            if user["role"] != "dm" and (DIR / f"{cid}.xml").exists() and not _may_use(cid):
                return jsonify(error=f"{_t(ch, 'name')} already belongs to someone else"), 409
            ids.append(cid)
        for ch, cid in zip(chars, ids):
            _write(cid, ch)
            if owner:
                ex.setdefault(cid, {})["owner"] = owner
        _save_extra(ex)
    return jsonify(imported=ids)


# ------------------------------------------------------------------ routes
# Set by app.py: a function giving the ids in the loaded campaign's party, or None when the campaign has no
# party list yet. Used by "?active=1" below.
active_ids = lambda: None  # noqa: E731


@bp.get("/api/party")
def list_party():
    """GET /api/party -> JSON list of summary() records for every character the signed-in user may see
    (the DM: everyone; a player: their own), sorted by id.

    "?active=1" (DM) narrows the list to the loaded campaign's party, if that campaign has one; the party
    tracker panel asks for it this way."""
    keep = active_ids() if request.args.get("active") and auth.is_dm() else None
    with lock:
        return jsonify([summary(i, _load(i)) for i in _ids() if _may_use(i) and (keep is None or i in keep)])


@bp.get("/api/party/<cid>")
def get_member(cid):
    """GET /api/party/<cid> -> detail() JSON for one character; 404 if unknown, 400 if the
    id has illegal characters. <cid> in the URL is passed in as the `cid` argument."""
    _guard(cid)
    with lock:
        return jsonify(detail(cid, _load(cid)))


@bp.get("/api/party/<cid>/portrait")
def portrait(cid):
    """GET /api/party/<cid>/portrait -> the character's picture as a PNG/JPEG image.

    Fight Club embeds the portrait as base64 text inside <imageData>. We decode it back to
    raw bytes and return it as an image the browser can show in an <img> tag. The type is
    detected from the first bytes (the PNG magic number \\x89PNG); anything else is assumed
    JPEG. 404 if there is no image. Cached by the browser for 60 s.
    """
    _guard(cid)
    data = (_load(cid).findtext("imageData") or "").strip()
    if not data:
        abort(404)
    raw = base64.b64decode(data)
    mime = "image/png" if raw[:4] == b"\x89PNG" else "image/jpeg"
    # Response(...) is a hand-built HTTP response (raw bytes + content type + headers),
    # used instead of jsonify because the body is binary, not JSON.
    return Response(raw, mimetype=mime, headers={"Cache-Control": "max-age=60"})


@bp.patch("/api/party/<cid>")
def update_member(cid):
    """PATCH /api/party/<cid> : change tracker values on one character.

    PATCH means "update only the fields I send". Request body (JSON), every key optional:
      hpCurrent    int   clamped to 0..hpMax (no upper limit if hpMax is unknown)
      hpMax        int   at least 1
      slotsCurrent [int] remaining spell slots per level, each clamped to 0..that level's max
      inspiration  int   0 or more
      money        any   stored as text
      hdCurrent    int   hit dice left on the FIRST class; 0 or more
      trackers     [{id, label, cur, max}]  the character's own counters (replaces the whole list) -> sidecar only
      deaths       {s, f}              death saves, each 0..3      -> sidecar file only
      conditions   str   free text, max 200 chars                -> sidecar file only
    Response: the updated summary() JSON. 404 if unknown id. A non-numeric value makes
    int() raise, which Flask turns into an HTTP 500 error.
    Side effects: rewrites data/party/<cid>.xml (always) and data/party_extra.json (only if
    trackers/conditions/deaths were sent). The lock makes the whole read-modify-write one step.
    """
    _guard(cid)
    body = request.get_json(force=True) or {}  # force=True: parse body as JSON regardless of Content-Type
    with lock:
        root = _load(cid)

        # Local helper (closure over `root`): set the text of child <tag>, creating the
        # element first if the file did not have it. XML text is always a string.
        def setv(tag, val):
            e = root.find(tag)
            if e is None:
                e = ET.SubElement(root, tag)
            e.text = str(val)

        if "hpCurrent" in body:
            hp_max = int(_num(_t(root, "hpMax"), 0))
            # max(0, min(x, cap)) is the usual clamp idiom; 10 ** 6 means "no real cap".
            setv("hpCurrent", max(0, min(int(body["hpCurrent"]), hp_max if hp_max else 10 ** 6)))
        if "hpMax" in body:
            setv("hpMax", max(1, int(body["hpMax"])))
        if "slotsCurrent" in body:
            maxes = _ints(_t(root, "slots"))
            # Clamp each level's value to that level's maximum (99 if the max is unknown).
            cur = [max(0, min(int(v), maxes[i] if i < len(maxes) else 99))
                   for i, v in enumerate(body["slotsCurrent"])]
            # Fight Club's format is a comma list with a trailing comma, e.g. "3,2,0,".
            setv("slotsCurrent", "".join(f"{v}," for v in cur))
        if "inspiration" in body:
            setv("inspiration", max(0, int(body["inspiration"])))
        if "money" in body:
            setv("money", body["money"])
        if "hdCurrent" in body and root.find("class") is not None:
            c = root.find("class")  # first <class> only
            e = c.find("hdCurrent")
            if e is None:
                e = ET.SubElement(c, "hdCurrent")
            e.text = str(max(0, int(body["hdCurrent"])))
        _write(cid, root)
        if "trackers" in body or "conditions" in body or "deaths" in body:
            ex = _extra()
            m = ex.setdefault(cid, {})  # this character's sidecar record (created if absent)
            if "trackers" in body:
                # The character's own counters. Each: a name (30 chars max), a maximum (0 or more) and a
                # current value clamped to 0..maximum. At most 12 per character. Saving the list also
                # retires the old single "resource" field, whose value was migrated into the list.
                m["trackers"] = []
                for t in list(body["trackers"])[:12]:
                    mx = max(0, int(t.get("max", 0)))
                    m["trackers"].append({"id": str(t.get("id") or uuid.uuid4().hex[:8])[:12],
                                          "label": str(t.get("label", "Tracker"))[:30] or "Tracker",
                                          "max": mx, "cur": max(0, min(int(t.get("cur", 0)), mx))})
                m.pop("resource", None)
            if "conditions" in body:
                m["conditions"] = str(body["conditions"])[:200]
            if "deaths" in body:
                # Death saving throws: successes and failures, each clamped to the legal range 0..3.
                dth = body["deaths"]
                m["deaths"] = {"s": max(0, min(3, int(dth.get("s", 0)))), "f": max(0, min(3, int(dth.get("f", 0))))}
            _save_extra(ex)
        return jsonify(summary(cid, root))


@bp.delete("/api/party/<cid>")
def delete_member(cid):
    """DELETE /api/party/<cid> : remove a character's XML file and sidecar entry.
    Response {"ok": true}; deleting an unknown (but well-formed) id is not an error. A player may delete
    only their own characters (someone else's is "not found")."""
    if _path(cid).exists():
        _guard(cid)
    with lock:
        p = _path(cid)
        if p.exists():
            p.unlink()  # delete the file
        ex = _extra()
        if ex.pop(cid, None) is not None:  # pop returns the removed value, or None if absent
            _save_extra(ex)
    return jsonify(ok=True)


@bp.put("/api/party/<cid>/owner")
def set_owner(cid):
    """PUT /api/party/<cid>/owner {"owner": "name" | ""} : give a character to a user (or to nobody). DM only."""
    auth.require_dm()
    if not _path(cid).exists():
        abort(404)
    owner = str((request.get_json(force=True, silent=True) or {}).get("owner", "")).strip()
    if owner and owner.lower() not in auth._load()["users"]:
        return jsonify(error=f"No user named {owner}"), 400
    with lock:
        ex = _extra()
        ex.setdefault(cid, {})["owner"] = owner
        _save_extra(ex)
    return jsonify(ok=True)


# NOTE: this literal route (".../export.zip") must not be shadowed by "/api/party/<cid>";
# Flask prefers the more specific literal match, and GET <cid> would never contain ".zip".
@bp.get("/api/party/export.zip")
def export_party():
    """Fight Club-importable backup (characters only), zipped.

    GET /api/party/export.zip downloads FightClub5-party.zip containing one file,
    "FightClub5.backup": an XML <data> document with a version and uid header followed by
    every stored <character>, i.e. the same layout Fight Club exports. The sidecar-only
    data (mana, conditions) is NOT included. The "version"/"uid" values are fixed numbers
    that mimic a Fight Club header so the app accepts the file.
    """
    with lock:
        data = ET.Element("data")  # new root element <data>
        ET.SubElement(data, "version").text = "37"
        ET.SubElement(data, "uid").text = "1031"
        for i in _ids():
            if _may_use(i):  # a player's backup holds only their own characters
                data.append(_load(i))
        xml = ET.tostring(data, encoding="utf-8", xml_declaration=True)  # tree -> bytes
    # Build the zip in memory (BytesIO ~ a growable in-RAM file), then rewind to the start
    # with seek(0) so send_file reads from the beginning.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("FightClub5.backup", xml)
    buf.seek(0)
    # as_attachment=True makes the browser save a file rather than display it.
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name="FightClub5-party.zip")


# Initiative tracker storage: one JSON file shared by everyone who opens the tracker page.
INIT = ROOT / "data" / "initiative.json"


@bp.get("/api/initiative")
def get_initiative():
    """GET /api/initiative -> {"round": int, "active": ..., "order": [...]} as last saved.
    If nothing has been saved yet (or the file is unreadable) returns a fresh combat:
    round 1, nobody active, empty order. The shape of "order" entries is chosen by the
    tracker page's JavaScript; the server stores it opaquely. DM only."""
    auth.require_dm()
    try:
        return jsonify(json.loads(INIT.read_text()))
    except Exception:
        return jsonify(round=1, active=None, order=[])


@bp.put("/api/initiative")
def put_initiative():
    """PUT /api/initiative : replace the saved initiative state with the request body.

    Body: JSON object that must contain "order" as a list (other keys such as round/active
    are stored as sent). Response {"ok": true}, or {"error": ...} (400) if "order" is not a
    list. Written atomically (temp file + os.replace). Unlike the character routes this
    takes no lock: the whole file is replaced in one rename, last writer wins. DM only.
    """
    auth.require_dm()
    body = request.get_json(force=True) or {}
    if not isinstance(body.get("order"), list):
        return jsonify(error="order must be a list"), 400
    tmp = INIT.with_suffix(".tmp")
    tmp.write_text(json.dumps(body, indent=2))
    os.replace(tmp, INIT)
    return jsonify(ok=True)


@bp.get("/download/collection.zip")
def download_collection():
    """The Fight Club 5e XML expansion collection zip, if it sits next to app.py.

    Serves the first file matching FightClub5eXML*.zip in the project folder (sorted, so
    the choice is deterministic) as "FightClub5eXML.zip"; 404 if none is present. The
    for-loop returns on its first iteration, so it is really "first match or fall through
    to abort". DM only.
    """
    auth.require_dm()
    for p in sorted(BASE.glob("FightClub5eXML*.zip")):
        return send_file(p, mimetype="application/zip", as_attachment=True, download_name="FightClub5eXML.zip")
    abort(404)
