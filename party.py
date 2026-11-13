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
  (the initiative order now lives with the campaign: see encounters.py)
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
import charcalc
import fcformat

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
IMG = ROOT / "data" / "party_images"   # portraits: <character id>.b64 (the base64 text from the backup)
DIR.mkdir(parents=True, exist_ok=True)  # create the folder if missing (mkdir -p)
lock = threading.RLock()  # see "Locking" in the module docstring

# Order of the six ability scores inside Fight Club's comma list <abilities>.
ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]
# Fight Club's numeric <type> code on an <item> -> human-readable category.
ITEM_TYPES = {"1": "Light Armor", "2": "Medium Armor", "3": "Heavy Armor", "4": "Shield",
              "5": "Melee Weapon", "6": "Ranged Weapon", "7": "Ammunition", "8": "Rod",
              "9": "Staff", "10": "Wand", "11": "Ring", "12": "Potion", "13": "Scroll",
              "14": "Wondrous Item", "15": "Gear / Treasure"}
# Fight Club's numeric <damageType> on a weapon. Only the three weapon damage types are confirmed from real files (Rapier and Dagger
# 2, a Maul 1, a Battleaxe 3); an unknown code shows no type rather than a guess.
DAMAGE_TYPES = {"1": "bludgeoning", "2": "piercing", "3": "slashing"}
# <weaponProperty> is a sum of bits (a Dagger is 138 = Finesse + Light + Thrown; a Maul 260 = Heavy + Two-Handed; a Battleaxe 512 =
# Versatile). Confirmed from real files: Ammunition, Finesse, Heavy, Light, Thrown, Two-Handed, Versatile. Loading, Reach and Special
# are the remaining low bits in the compendium's order, which no file here uses yet.
WEAPON_PROPS = [(1, "Ammunition"), (2, "Finesse"), (4, "Heavy"), (8, "Light"), (16, "Loading"), (32, "Reach"), (64, "Special"),
                (128, "Thrown"), (256, "Two-Handed"), (512, "Versatile")]
# A class's <hd> is a code, not the die size: 1 = d6, 2 = d8, 3 = d10, 4 = d12 (a Cleric is 2, a Fighter or Paladin 3, a Barbarian 4 in real files).
HIT_DIE = {1: 6, 2: 8, 3: 10, 4: 12}
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


def _class_line(root):
    """"Wizard 5 / Cleric 1": a multiclassed character has several <class> elements."""
    return " / ".join(f"{_t(c, 'name')} {_t(c, 'level', '?')}" for c in root.findall("class"))


def _image_b64(cid, root):
    """The character's portrait as base64 text, or "" when it has none. A Fight Club backup keeps the picture OUTSIDE the
    character (the character only holds <imageData><uid>), so import saves it as data/party_images/<id>.b64; an older
    file may hold the picture inline in <imageData> itself, which is still honoured."""
    f = IMG / f"{cid}.b64"
    if f.exists():
        return f.read_text().strip()
    return (root.findtext("imageData") or "").strip()


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
    ac only shown if > 0; damage1H/damage2H = one-/two-handed damage dice; damageType and the
    weapon properties are decoded from their numeric codes (DAMAGE_TYPES, WEAPON_PROPS).
    `bonus` = the item's own numbers from its <mod> children: atk and dmg (a +2 weapon) and ac
    (a +2 armor); a name that starts "+1 " counts as +1/+1 when the item has no valued mod.
    `equipped` is derived: only armor/shield/weapon/ring/wondrous types can be worn, and
    Fight Club's <slot> is "" or "1" when the item is not in an equipment slot (so any
    other slot value means it is equipped).
    """
    name = _t(it, "name")
    bonus = {"atk": 0, "dmg": 0, "ac": 0}
    for m in it.findall("mod"):
        val = _t(m, "value")
        key = {"1": "atk", "2": "dmg", "10": "ac"}.get(_t(m, "type"))
        if val and key:
            bonus[key] += int(_num(val))
    pre = re.match(r"^\+(\d)\s", name)
    if pre and not bonus["atk"] and not bonus["dmg"]:
        bonus["atk"] = bonus["dmg"] = int(pre.group(1))
    code = int(_num(_t(it, "weaponProperty")))
    return {
        "name": name, "detail": _t(it, "detail"), "text": _t(it, "text"),
        "type": ITEM_TYPES.get(_t(it, "type"), ""), "magic": _t(it, "magic") == "1",
        # `int(...) or 1`: a missing/zero quantity is shown as 1.
        "quantity": int(_num(_t(it, "quantity"), 1)) or 1, "weight": _num(_t(it, "weight")),
        "value": _num(_t(it, "value")),
        "ac": _t(it, "ac") if _num(_t(it, "ac"), -1) > 0 else "",
        "damage": _t(it, "damage1H"), "damage2h": _t(it, "damage2H"),
        "damageType": DAMAGE_TYPES.get(_t(it, "damageType"), ""),
        "property": ", ".join(label for bit, label in WEAPON_PROPS if code & bit), "propCode": code,
        "range": _t(it, "weaponRange"), "longRange": _t(it, "weaponLongRange"),
        "bonus": bonus,
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
    levels = _class_line(root)
    ex = _extra().get(cid, {})  # this character's sidecar record, or {}
    return {
        "id": cid, "name": _t(root, "name"), "class": levels, "owner": ex.get("owner", ""),
        # total character level (the encounter builder uses it to rate difficulty)
        "level": sum(int(_num(_t(c, "level"))) for c in cls),
        "race": _t(root.find("race"), "name") if root.find("race") is not None else "",
        "hp": int(_num(_t(root, "hpCurrent"))), "hpMax": int(_num(_t(root, "hpMax"))),
        # <slots> and <slotsCurrent> are comma lists like "4,3,2,0,0,0,0,0,0," (index 0 =
        # 1st-level slots). slots = maximum, slotsCurrent = how many are still unspent.
        "slots": _ints(_t(root, "slots")), "slotsCurrent": _ints(_t(root, "slotsCurrent")),
        "inspiration": int(_num(_t(root, "inspiration"))),
        "hasImage": bool(_image_b64(cid, root)),
        "trackers": _trackers(ex),
        "conditions": ex.get("conditions", ""),
        # hit dice per class: the die size, the class level (= the most there can be) and how many are left (all of them when the
        # file does not say)
        "hitDice": [{"name": _t(c, "name"), "hd": HIT_DIE.get(int(_num(_t(c, "hd"))), 0), "level": int(_num(_t(c, "level"), 1)),
                     "left": int(_num(_t(c, "hdCurrent"), _num(_t(c, "level"), 1)))} for c in cls],
        # companions, familiars and summons the player keeps track of (sidecar only; Fight Club has no field for them)
        "creatures": ex.get("creatures", []),
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
        # The class's own <feat> list is exactly what Fight Club shows for this character (the features it has earned, with the one
        # chosen subclass). Each <autolevel> block is the class's whole level table (EVERY subclass option and every level up to 20),
        # so merging those in listed all the druid circles and features far above the character's level. Not used here.
        feats = _feats(c)
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
    # Fight Club companions (<monster>: a familiar, pet or summon the player added in the app). They have no hit points in the file, only a
    # kind, a name, six ability scores and a hit dice expression such as "1d8".
    d["companions"] = [{"name": _t(m, "name"), "kind": _t(m, "type") or _t(m, "label"), "hd": _t(m, "hd"), "abilities": _ints(_t(m, "abilities"))[:6]}
                       for m in root.findall("monster")]
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
    # Proficiency codes (see charcalc): the classes' and the background's <proficiency> numbers, saves below 100 and skills from 100.
    codes = [int(_num(p.text)) for e in [*root.findall("class"), *( [bg] if bg is not None else [] )] for p in e.findall("proficiency") if p.text]
    d["profs"] = {"saves": sorted({c for c in codes if c < 6}), "skills": sorted({c for c in codes if c >= 100})}
    d.update(charcalc.derive(d))
    return d


# ------------------------------------------------------------------- import
def _characters_from(data: bytes):
    """Parse XML bytes and return ([<character> elements], {portrait uid: base64 text}).

    A Fight Club backup has <data> as the root with <character> children and, after them, the portraits as
    <imageData><uid>U</uid><encoded>..</encoded></imageData>; a single exported character may have <character> itself as
    the root. Handles both. Raises ET.ParseError on malformed XML.
    """
    root = SafeET.fromstring(data)
    if root.tag == "character":
        return [root], {}
    images = {(i.findtext("uid") or "").strip(): "".join((i.findtext("encoded") or "").split()) for i in root.findall("imageData") if i.find("encoded") is not None}
    return root.findall("character"), images


def _read_upload(f):
    """Extract ([<character> elements], {portrait uid: base64}) from an uploaded file object `f`.

    Fight Club's own .backup files are PLAIN XML; a zip (older exports from this app, or one the user made) containing
    one is accepted too. zipfile.is_zipfile() sniffs the content; io.BytesIO wraps the in-memory bytes so the zip library
    can treat them as a file. For zips, every entry ending .xml/.backup is parsed; directories, entries over 200 MiB
    uncompressed (a "zip bomb" guard) and unparsable entries are skipped.
    """
    raw = f.read()  # whole upload as a bytes object
    if zipfile.is_zipfile(io.BytesIO(raw)):
        chars, images = [], {}
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            for info in z.infolist():
                if info.is_dir() or info.file_size > 200 * 1024 * 1024:
                    continue
                if info.filename.lower().endswith((".xml", ".backup")):
                    try:
                        c, i = _characters_from(z.read(info))
                        chars += c
                        images.update(i)
                    except ET.ParseError:
                        continue
        return chars, images
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


@bp.post("/api/party/preview")
def preview_import():
    """POST /api/party/preview : look inside an upload (multipart form field "file") WITHOUT saving anything.

    Response: {"characters": [{"id", "name", "class", "hp", "exists", "blocked", "portrait"}]} where `exists` means a character
    with that id is already on the server (importing would update it) and `blocked` means the signed-in player may not replace
    it because it belongs to someone else. The page shows these as a checklist; the chosen ones are then sent to /api/party/import.
    400 {"error"} if the file is missing, unreadable, or holds no characters."""
    f = request.files.get("file")
    if not f:
        return jsonify(error="No file uploaded"), 400
    try:
        chars, images = _read_upload(f)
    except Exception as e:
        return jsonify(error=f"Could not read file: {e}"), 400
    if not chars:
        return jsonify(error="No <character> entries found in that file"), 400
    user = auth.current_user()
    out = []
    with lock:
        for ch in chars:
            cid = _cid_for(ch, [])
            exists = (DIR / f"{cid}.xml").exists()
            out.append({"id": cid, "name": _t(ch, "name"), "class": _class_line(ch), "hp": f"{_t(ch, 'hpCurrent')}/{_t(ch, 'hpMax')}",
                        "exists": exists, "blocked": bool(user["role"] != "dm" and exists and not _may_use(cid)),
                        "portrait": bool(images.get((ch.findtext("imageData/uid") or "").strip()) or (ch.findtext("imageData") or "").strip())})
    return jsonify(characters=out)


@bp.post("/api/party/import")
def import_party():
    """POST /api/party/import : upload a Fight Club backup (multipart form field "file").

    By default EVERY character in the file is imported. To import only some, send the form field "select" (any value) and one
    "only" field per character id wanted (the ids /api/party/preview listed); with "select" and no "only" nothing is imported.

    Each character is imported INDIVIDUALLY: one that cannot be (a player may not replace somebody else's character) is
    reported and skipped, and the others are still saved. Response: {"imported": ["<id>", ...], "failed": [{"id", "name",
    "error"}]} (200); {"error", "failed"} (409) when every wanted character failed; or {"error": "..."} (400) when no file was sent, the file cannot be parsed, it holds no <character>
    entries, or the named owner does not exist.
    Side effects: writes data/party/<id>.xml (overwriting a same-id file) and the portrait for each imported character.
    """
    f = request.files.get("file")  # uploaded files arrive in request.files, not the JSON body
    if not f:
        return jsonify(error="No file uploaded"), 400
    try:
        chars, images = _read_upload(f)
    except Exception as e:
        return jsonify(error=f"Could not read file: {e}"), 400
    if not chars:
        return jsonify(error="No <character> entries found in that file"), 400
    user = auth.current_user()
    wanted = set(request.form.getlist("only")) if "select" in request.form else None
    with lock:
        ex = _extra()
        # Who the characters belong to: a player's upload is always theirs; the DM may name an owner in the
        # form (field "owner"), otherwise a re-imported character keeps the owner it already had.
        owner = user["name"] if user["role"] != "dm" else (request.form.get("owner") or "").strip()
        if owner and user["role"] == "dm" and owner.lower() not in auth._load()["users"]:
            return jsonify(error=f"No user named {owner}"), 400
        imported, failed = [], []
        for ch in chars:
            cid = _cid_for(ch, imported)
            if wanted is not None and cid not in wanted:
                continue
            # A player may add new characters or update their own, never replace somebody else's.
            if user["role"] != "dm" and (DIR / f"{cid}.xml").exists() and not _may_use(cid):
                failed.append({"id": cid, "name": _t(ch, "name"), "error": "already belongs to someone else"})
                continue
            try:
                _write(cid, ch)
                # The portrait travels beside the characters in the backup: keep it with this character (see _image_b64).
                ref = (ch.findtext("imageData/uid") or "").strip()
                if ref in images and images[ref]:
                    IMG.mkdir(parents=True, exist_ok=True)
                    (IMG / f"{cid}.b64").write_text(images[ref])
                if owner:
                    ex.setdefault(cid, {})["owner"] = owner
                imported.append(cid)
            except Exception as e:  # one character failing must not stop the others
                failed.append({"id": cid, "name": _t(ch, "name"), "error": str(e)})
        _save_extra(ex)
    if failed and not imported:   # nothing could be imported: an error, with the reasons
        return jsonify(error=f"{failed[0]['name']}: {failed[0]['error']}", imported=[], failed=failed), 409
    return jsonify(imported=imported, failed=failed)


# ------------------------------------------------------------------ routes
# Set by app.py: a function giving the ids in the loaded campaign's party (a list, possibly empty).
# Used by "?active=1" below.
active_ids = lambda: None  # noqa: E731


@bp.get("/api/party")
def list_party():
    """GET /api/party -> JSON list of summary() records for every character the signed-in user may see
    (the DM: everyone; a player: their own), sorted by id.

    "?active=1" (DM) narrows the list to the loaded campaign's party ONLY (an empty party gives an empty
    list); the party tracker panel asks for it this way."""
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
    data = _image_b64(cid, _load(cid))
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
      hitDice      [int] hit dice left, one number per class in order; each clamped to 0..that class's level
      trackers     [{id, label, cur, max}]  the character's own counters (replaces the whole list) -> sidecar only
      deaths       {s, f}              death saves, each 0..3      -> sidecar file only
      conditions   str   free text, max 200 chars                -> sidecar file only
      creatures    [{id, name, hp, hpMax, ac, notes}]  companions / summons (replaces the whole list, 20 at most) -> sidecar only
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
        if "hitDice" in body:
            for c, v in zip(root.findall("class"), body["hitDice"]):
                e = c.find("hdCurrent")
                if e is None:
                    e = ET.SubElement(c, "hdCurrent")
                e.text = str(max(0, min(int(v), int(_num(_t(c, "level"), 1)))))
        _write(cid, root)
        if "trackers" in body or "conditions" in body or "deaths" in body or "creatures" in body:
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
            if "creatures" in body:
                m["creatures"] = []
                for c in list(body["creatures"])[:20]:
                    mx = max(0, int(c.get("hpMax", 0)))
                    m["creatures"].append({"id": str(c.get("id") or uuid.uuid4().hex[:8])[:12], "name": str(c.get("name", "Creature"))[:40] or "Creature",
                                           "hpMax": mx, "hp": max(0, min(int(c.get("hp", 0)), mx or 10 ** 4)),
                                           "ac": max(0, int(c.get("ac", 0))), "notes": str(c.get("notes", ""))[:200]})
            if "deaths" in body:
                # Death saving throws: successes and failures, each clamped to the legal range 0..3.
                dth = body["deaths"]
                m["deaths"] = {"s": max(0, min(3, int(dth.get("s", 0)))), "f": max(0, min(3, int(dth.get("f", 0))))}
            _save_extra(ex)
        return jsonify(summary(cid, root))


# ---- adding things to a character: loot, spells and notes from the character sheet's Add buttons. Each becomes a normal Fight Club element inside
# the character's XML, so the character exports (and opens in the phone app) with it. The browser sends plain values; every one is cut to a safe
# size here.
# Fight Club item type for an Open5e magic item type ("Wondrous item", "Weapon (longsword)", "Ring" ...), by what the type starts with.
ITEM_CODE_BY_TYPE = [("ring", "11"), ("potion", "12"), ("scroll", "13"), ("staff", "9"), ("wand", "10"), ("rod", "8"), ("wondrous", "14"),
                     ("armor", "2"), ("shield", "4"), ("weapon", "5"), ("ammunition", "7")]
SCHOOL_CODE = {v.lower(): k for k, v in SCHOOLS.items()}


def _text(v, n):
    return str(v or "").strip()[:n]


def _append(root, parent, elem, after, before=()):
    """Put `elem` inside `parent` after the last child tagged one of `after`, else just before the first tagged one of `before`, else last.
    Keeps Fight Club's own order (items, containers, feats, notes, then the slots and money) so the file still looks the way it writes it."""
    kids = list(parent)
    last = max((i for i, k in enumerate(kids) if k.tag in after), default=None)
    if last is None:
        last = next((i - 1 for i, k in enumerate(kids) if k.tag in before), len(kids) - 1)
    parent.insert(last + 1, elem)


def _sub(parent, tag, text):
    e = ET.SubElement(parent, tag)
    e.text = text
    return e


@bp.post("/api/party/<cid>/items")
def add_item(cid):
    """POST /api/party/<id>/items {name, type, rarity, text, attunement} -> {"ok": true, "name"}: add a magic item (from the item search) to the
    character's loose items. `type` is Open5e's ("Wondrous item"); it is turned into Fight Club's type code and shown in the detail line."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    name = _text(b.get("name"), 80)
    if not name:
        return jsonify(error="The item needs a name"), 400
    kind, rarity = _text(b.get("type"), 60), _text(b.get("rarity"), 20)
    with lock:
        root = _load(cid)
        it = ET.Element("item")
        _sub(it, "name", name)
        _sub(it, "detail", ", ".join(x for x in (kind, rarity, "requires attunement" if b.get("attunement") else "") if x))
        _sub(it, "text", _text(b.get("text"), 6000))
        _sub(it, "type", next((c for p, c in ITEM_CODE_BY_TYPE if kind.lower().startswith(p)), "15"))
        _sub(it, "magic", "1")
        _sub(it, "weight", "0.0")
        _sub(it, "value", "0.0")
        _sub(it, "quantity", "1")
        _append(root, root, it, ("item", "container"), ("feat", "note", "slots", "slotsCurrent", "money"))
        _write(cid, root)
    return jsonify(ok=True, name=name)


@bp.post("/api/party/<cid>/spells")
def add_spell(cid):
    """POST /api/party/<id>/spells {name, level, school, time, range, duration, components, materials, text, ritual, classes} -> {"ok": true, "name"}:
    add a spell (from the spell search) to the character's FIRST class. It starts unprepared."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    name = _text(b.get("name"), 80)
    if not name:
        return jsonify(error="The spell needs a name"), 400
    comps = _text(b.get("components"), 40).upper()
    with lock:
        root = _load(cid)
        cls = root.find("class")
        if cls is None:
            return jsonify(error="This character has no class to add a spell to"), 400
        sp = ET.Element("spell")
        _sub(sp, "name", name)
        _sub(sp, "school", SCHOOL_CODE.get(_text(b.get("school"), 20).lower(), ""))
        _sub(sp, "level", str(max(0, min(9, int(_num(b.get("level")))))))
        _sub(sp, "time", _text(b.get("time"), 60))
        _sub(sp, "range", _text(b.get("range"), 60))
        for tag, letter in (("v", "V"), ("s", "S"), ("m", "M")):
            if re.search(rf"\b{letter}\b", comps):
                _sub(sp, tag, "1")
        _sub(sp, "materials", _text(b.get("materials"), 300))
        _sub(sp, "duration", _text(b.get("duration"), 60))
        _sub(sp, "text", _text(b.get("text"), 6000))
        _sub(sp, "prepared", "0")
        _sub(sp, "sclass", _t(cls, "name"))
        if b.get("ritual"):
            _sub(sp, "ritual", "1")
        _append(root, cls, sp, ("spell",), ())
        _write(cid, root)
    return jsonify(ok=True, name=name)


@bp.post("/api/party/<cid>/notes")
def add_note(cid):
    """POST /api/party/<id>/notes {name, text} -> {"ok": true, "name"}: add a note to the character (shown under Feats, Features and Notes)."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    name = _text(b.get("name"), 80)
    if not name:
        return jsonify(error="The note needs a title"), 400
    with lock:
        root = _load(cid)
        n = ET.Element("note")
        _sub(n, "name", name)
        _sub(n, "text", _text(b.get("text"), 8000))
        _append(root, root, n, ("note",), ("slots", "slotsCurrent", "money"))
        _write(cid, root)
    return jsonify(ok=True, name=name)


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
        (IMG / f"{cid}.b64").unlink(missing_ok=True)
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


def _stream_download(source, filename, mimetype="application/zip"):
    """Send `source` (an open binary file object, closed afterwards) as a download, STREAMED in 1 MiB pieces with no
    Content-Length. One ordinary download for the user, and it also gets past Cloud Run's 32 MiB limit on a single
    HTTP/1 response, which does not apply to streamed ones. The price: the browser cannot show a percentage, because
    the total size is not sent. Used by every download here (the collection zip and the character backups)."""
    def pieces():
        with source:
            while chunk := source.read(1024 * 1024):
                yield chunk
    return Response(pieces(), mimetype=mimetype, headers={"Content-Disposition": f'attachment; filename="{filename}"',
                                                          "Cache-Control": "private, no-store" if source.__class__ is io.BytesIO else "private, max-age=3600"})


def _backup_download(ids, download_name):
    """Send the characters `ids` as a Fight Club backup. By default that is Fight Club's own format: ONE PLAIN XML FILE named
    <something>.backup (see fcformat.py for the rules). "?format=zip" gives the old form, the same file inside a zip, in case the
    plain file is not accepted. The caller has already checked the user may use every id. The sidecar-only data (mana,
    conditions) is NOT included."""
    with lock:
        chars = [_load(i) for i in ids]
        images = {}
        for cid, ch in zip(ids, chars):
            ref = (ch.findtext("imageData/uid") or "").strip()
            b64 = _image_b64(cid, ch) if ref else ""
            if ref and b64 and not (ch.findtext("imageData") or "").strip():   # the picture is held outside the character
                images[ref] = b64
        xml = fcformat.encode(chars, images)
    if request.args.get("format") == "zip":
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("FightClub5.backup", xml)
        buf.seek(0)
        return _stream_download(buf, download_name + ".zip")
    return _stream_download(io.BytesIO(xml), download_name + ".backup", "application/octet-stream")


# NOTE: this literal route (".../export.zip") must not be shadowed by "/api/party/<cid>";
# Flask prefers the more specific literal match, and GET <cid> would never contain ".zip".
@bp.get("/api/party/export.zip")
def export_party():
    """GET /api/party/export.zip downloads FightClub5.backup: every character the signed-in user may see (the DM: all; a
    player: only their own), as a Fight Club backup (plain XML; add ?format=zip for a zipped copy). The address keeps its old
    name ("export.zip") so existing links and buttons still work."""
    with lock:
        ids = [i for i in _ids() if _may_use(i)]
    return _backup_download(ids, "FightClub5")


@bp.get("/api/party/<cid>/export.zip")
def export_member(cid):
    """GET /api/party/<id>/export.zip downloads ONE character as a Fight Club backup named FightClub5-<Name>.backup. The DM may
    download any; a player only a character assigned to them (anything else is a 404, like every other character route, see
    _guard). Add ?format=zip for a zipped copy."""
    _guard(cid)
    with lock:
        name = _t(_load(cid), "name") or cid
    return _backup_download([cid], "FightClub5-" + re.sub(r"[^\w.-]+", "_", name).strip("_"))


@bp.get("/download/collection.zip")
def download_collection():
    """The Fight Club 5e XML expansion collection zip, if it sits next to app.py.

    Serves the first file matching FightClub5eXML*.zip in the project folder (sorted, so the choice is
    deterministic) as "FightClub5eXML.zip"; 404 if none is present. Any signed-in user may download it
    (check_request in auth.py lets it through for players).

    Streamed (see _stream_download), because the zip is about 123 MB, far over Cloud Run's 32 MiB single-response limit.
    """
    for p in sorted(BASE.glob("FightClub5eXML*.zip")):
        return _stream_download(open(p, "rb"), "FightClub5eXML.zip")
    abort(404)
