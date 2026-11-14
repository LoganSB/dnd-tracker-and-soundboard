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
import atexit
import base64
import copy
import io
import json
import os
import re
import threading
import time
import uuid
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

from flask import Blueprint, Response, abort, jsonify, request, send_file

import auth
import charcalc
import fcedit
import fcformat
import fcmonster
import gear
import gloan5e

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
# ---- the cache in front of the files
# The data folder is a Cloud Storage bucket when deployed, where every read and write of a file takes a good fraction of a second (a character file
# is over a megabyte). So the characters and the extras record are kept in memory: a read is served from memory (the file is looked at again only
# when its modified time changed from outside), and a change is applied in memory at once and written to the file a few seconds later (FLUSH_AFTER),
# many changes in a row becoming one write. The files are also written when the server stops (atexit), so only a crash loses the last few seconds.
# A character that does not have a file yet is written at once, so the file listing (_ids) never lies.
FLUSH_AFTER = 3.0   # seconds between a change and its write to the file
_chars = {}         # character id -> [root element, file modified time (ns) when read; 0 = not on disk yet]
_dirty = set()      # character ids whose memory is newer than their file
_extra_cache = [None, 0]   # [extras dict, file modified time]
_extra_dirty = [False]
_timer = [None]
_flush_lock = threading.Lock()


def _mtime(p):
    try:
        return p.stat().st_mtime_ns
    except OSError:
        return 0


def _schedule():
    """Arrange for flush() to run FLUSH_AFTER seconds from now unless a run is already waiting."""
    if _timer[0] is None:
        t = threading.Timer(FLUSH_AFTER, flush)
        t.daemon = True
        _timer[0] = t
        t.start()


def flush():
    """Write everything changed in memory to its file now (atomic: temp file, then rename). Runs on a timer after a change, at exit, and before anything
    that reads the files directly."""
    with _flush_lock:
        _timer[0] = None
        with lock:
            ids, extra = sorted(_dirty), _extra_dirty[0]
            roots = {c: _chars[c][0] for c in ids if c in _chars}
            ex = copy.deepcopy(_extra_cache[0]) if extra else None
            _dirty.clear()
            _extra_dirty[0] = False
        for cid, root in roots.items():
            p = _path(cid)
            tmp = p.with_suffix(".tmp")
            ET.ElementTree(root).write(tmp, encoding="utf-8", xml_declaration=True)
            os.replace(tmp, p)
            with lock:
                if cid in _chars and _chars[cid][0] is root:
                    _chars[cid][1] = _mtime(p)
        if ex is not None:
            tmp = EXTRA.with_suffix(".tmp")
            tmp.write_text(json.dumps(ex, indent=2))
            os.replace(tmp, EXTRA)
            with lock:
                _extra_cache[1] = _mtime(EXTRA)


atexit.register(flush)


def _extra():
    """Load data/party_extra.json as a dict ({} if missing or unreadable): a COPY, so a caller can change it and hand it to _save_extra.

    Shape: {"<character id>": {"trackers": [{"id", "label", "cur", "max"}], "conditions": "text", "deaths": {"s", "f"}}}.
    (A leading underscore on a name is just a Python convention for "internal helper".)
    """
    with lock:
        if _extra_cache[0] is None or (not _extra_dirty[0] and _mtime(EXTRA) != _extra_cache[1]):
            try:
                _extra_cache[0] = json.loads(EXTRA.read_text())
            except Exception:
                _extra_cache[0] = {}
            _extra_cache[1] = _mtime(EXTRA)
        return copy.deepcopy(_extra_cache[0])


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


def _gifts(cid, root):
    """The pending gifts of one character: items another player gave them, not yet acknowledged. A gift whose item no longer exists (it was used up or
    given on) is not listed. Kept in the sidecar file as {id, name, qty, from, at}: the highlight on the sheet, never part of the Fight Club file."""
    names = {_t(i, "name") for i in root.findall("item")}
    return [g for g in _extra().get(cid, {}).get("gifts", []) if g.get("name") in names]


def _save_extra(d):
    """Keep the sidecar dict in memory and have it written to data/party_extra.json shortly (see the cache above)."""
    with lock:
        _extra_cache[0] = d
        _extra_dirty[0] = True
        _schedule()


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


def _peek(cid):
    """A character's <character> element straight from the cache, to READ only: nobody may change it (use _load for that). 404 if there is no such
    character. Uses the hardened parser the first time and whenever the file changed from outside."""
    p = _path(cid)
    with lock:
        hit = _chars.get(cid)
        if hit and (cid in _dirty or hit[1] == _mtime(p) != 0):
            return hit[0]
        if not p.exists():
            _chars.pop(cid, None)
            abort(404)
        root = SafeET.parse(p).getroot()
        _chars[cid] = [root, _mtime(p)]
        return root


def _load(cid):
    """A character's <character> element to CHANGE: a private copy, so a change that fails half way never leaves the cached one damaged. Save it with
    _write. 404 if there is no such character."""
    return copy.deepcopy(_peek(cid))


def _write(cid, root):
    """Save a <character> element: into the cache now, to data/party/<cid>.xml a few seconds later (a character with no file yet: at once)."""
    p = _path(cid)
    with lock:
        _chars[cid] = [root, 0]
        if p.exists():
            _dirty.add(cid)
            _schedule()
        else:
            tmp = p.with_suffix(".tmp")
            ET.ElementTree(root).write(tmp, encoding="utf-8", xml_declaration=True)
            os.replace(tmp, p)
            _chars[cid][1] = _mtime(p)


def _class_line(root):
    """"Wizard 5 / Cleric 1": a multiclassed character has several <class> elements."""
    return " / ".join(f"{_t(c, 'name')} {_t(c, 'level', '?')}" for c in root.findall("class"))


def _has_image(cid, root):
    """Does the character have a portrait? Without reading it: the picture is megabytes of text, and the party list asks every few seconds."""
    f = IMG / f"{cid}.b64"
    return (f.exists() and f.stat().st_size > 0) or bool((root.findtext("imageData") or "").strip())


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


def _feats(parent, prefix="f"):
    """List of {"ref", "name", "text"} for every <feat> child of `parent` (a class, race, background or the character itself). A "feat" here means any named
    feature/trait. `ref` ("r0" race, "b0" background, "c1.0" the second class, "f0" the character) is how PATCH .../features/<ref> finds it (see _feature_at)."""
    return [{"ref": f"{prefix}{i}", "name": _t(f, "name"), "text": _t(f, "text")} for i, f in enumerate(parent.findall("feat"))]


def _item(it, ref="", st=None):
    """Convert one Fight Club <item> element into a flat dict for the page.

    Field meanings: type = numeric code (see ITEM_TYPES); magic = "1" means magical;
    ac only shown if > 0; damage1H/damage2H = one-/two-handed damage dice; damageType and the
    weapon properties are decoded from their numeric codes (DAMAGE_TYPES, WEAPON_PROPS).
    `bonus` = the item's own numbers from its <mod> children: atk and dmg (a +2 weapon) and ac
    (a +2 armor); a name that starts "+1 " counts as +1/+1 when the item has no valued mod.
    `equipped` is derived (fcedit.is_equipped): only armor/shield/weapon/ring/wondrous types can be worn, and
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
        "equipped": fcedit.is_equipped(it), "slot": _t(it, "slot"),
        # what the item is doing (gear.states): its key for the extras, the kind it is worn as ("" if not worn) and the kind its name says, whether it needs
        # attunement and is attuned, and whether its own bonuses (score, armor class) count
        "key": st["key"] if st else "", "kind": st["kind"] if st else None, "worn": st["worn"] if st else "",
        "needsAttune": st["needs"] if st else False, "attuned": st["attuned"] if st else False, "active": st["active"] if st else fcedit.is_equipped(it),
        "fcSlot": _t(it, "type") in gear.FC_SLOT_TYPES, "coin": fcedit.coin_of(it) or "",
        # where the item is in the file ("i3", "c1.2"): how the page names it when it changes, equips, gives or removes it (see fcedit.py)
        "ref": ref,
        # whether Equip / Unequip makes sense for it: loose armor, shields and weapons, rings, wondrous items, and anything whose name says what it is
        "canEquip": ref.startswith("i") and (_t(it, "type") in gear.FC_SLOT_TYPES + ("11", "14") or bool(st and st["kind"])),
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
    slots (max spell slots per level 1..9; the file's position 0 is the cantrips known, `cantrips` here), slotsCurrent (remaining), inspiration (0/1),
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
        "slots": fcedit.slot_levels(root, "slots"), "slotsCurrent": fcedit.slot_levels(root, "slotsCurrent"), "cantrips": fcedit.slot_list(root, "slots")[0],
        "inspiration": int(_num(_t(root, "inspiration"))),
        "hasImage": _has_image(cid, root),
        "trackers": _trackers(ex),
        "conditions": ex.get("conditions", ""),
        # hit dice per class: the die size, the class level (= the most there can be) and how many are left (all of them when the
        # file does not say)
        "hitDice": [{"name": _t(c, "name"), "hd": HIT_DIE.get(int(_num(_t(c, "hd"))), 0), "level": int(_num(_t(c, "level"), 1)),
                     "left": int(_num(_t(c, "hdCurrent"), _num(_t(c, "level"), 1)))} for c in cls],
        # companions (Fight Club <monster>): where each is in the file, its name and kind, hit points and AC (see fcmonster.py)
        "creatures": [fcmonster.row(i, m) for i, m in enumerate(root.findall("monster"))],
        # the class's own counters (Channel Divinity ...): label, left now, the most, resetType, class
        "classTrackers": fcmonster.class_trackers(root),
        # death saving throws, kept in the sidecar file (Fight Club has no field for them)
        "deaths": ex.get("deaths", {"s": 0, "f": 0}),
        # <abilities> is "STR,DEX,CON,INT,WIS,CHA" scores; [:6] keeps just those six.
        # the six ability modifiers of the SHOWN scores: base plus the race, level-up, feat and equipped-item bonuses (fcedit.ability_scores)
        "mods": [_mod(v) for v in fcedit.ability_scores(root, ex)[1]],
        # items other players gave this character that have not been acknowledged yet ({id, name, qty, from, at}); one whose item is gone is not listed
        "gifts": _gifts(cid, root),
    }


def detail(cid, root):
    """The full character sheet record: everything in summary() plus abilities, race,
    background, classes (with features), spells, notes, items, containers and total weight.
    Pure read; used by GET /api/party/<cid> for the full character page."""
    d = summary(cid, root)
    base, scores, why = fcedit.ability_scores(root, _extra().get(cid, {}))
    # score = what Fight Club shows (base + bonuses); `why` lists the bonuses (race, level-ups ...) so the page can explain it
    d["abilities"] = [{"name": n, "score": s, "base": b0, "mod": _mod(s), "why": w} for n, s, b0, w in zip(ABILITIES, scores, base, why)]
    d["xp"] = _t(root, "xp")
    d["money"] = _t(root, "money")
    d["unarmed"] = _t(root, "unarmed")
    race = root.find("race")
    d["raceInfo"] = (
        {k: _t(race, k) for k in ("name", "speed", "age", "height", "weight", "eyes", "skin", "hair")}
        if race is not None else {}
    )
    # Fight Club leaves <speed> out of a race whose speed is the standard 30 (Human, Half-Orc, Goblin ...) and writes it only for the others
    # (Leonin 35, Aarakocra 25), so a missing tag means 30 feet.
    if race is not None and not d["raceInfo"]["speed"]:
        d["raceInfo"]["speed"] = "30"
    d["raceFeats"] = _feats(race, "r") if race is not None else []
    bg = root.find("background")
    d["background"] = {"name": _t(bg, "name"), "feats": _feats(bg, "b")} if bg is not None else {}
    d["classes"], d["spells"] = [], []  # both set to a fresh empty list
    for c in root.findall("class"):
        # The class's own <feat> list is exactly what Fight Club shows for this character (the features it has earned, with the one
        # chosen subclass). Each <autolevel> block is the class's whole level table (EVERY subclass option and every level up to 20),
        # so merging those in listed all the druid circles and features far above the character's level. Not used here.
        feats = _feats(c, f"c{len(d['classes'])}.")
        d["classes"].append({
            "name": _t(c, "name"), "level": _t(c, "level"),
            # hd = hit die size (e.g. 8), hdCurrent = hit dice still unspent.
            "hd": _t(c, "hd"), "hdCurrent": _t(c, "hdCurrent"),
            "armor": _t(c, "armor"), "weapons": _t(c, "weapons"), "tools": _t(c, "tools"),
            "spellAbility": _t(c, "spellAbility"),   # the casting ability's index (0 = STR ... 5 = CHA); 6 = none
            "feats": feats,
        })
        for s in c.findall("spell"):
            d["spells"].append({
                "ref": len(d["spells"]),   # the spell's place among all the character's spells (PATCH .../spells/<ref>)
                "name": _t(s, "name"), "level": int(_num(_t(s, "level"))),
                "school": SCHOOLS.get(_t(s, "school"), ""),
                "time": _t(s, "time"), "range": _t(s, "range"), "duration": _t(s, "duration"),
                # Components V/S/M (verbal/somatic/material): the tags <v>,<s>,<m> hold "1"
                # when required; join the letters of the ones that are.
                "components": "".join(k for k, f in (("V", "v"), ("S", "s"), ("M", "m")) if _t(s, f) == "1"),
                "materials": _t(s, "materials"), "text": _t(s, "text"),
                "prepared": _t(s, "prepared") == "1" or int(_num(_t(s, "level"))) == 0,   # a cantrip is always ready
                "class": _t(s, "sclass") or _t(c, "name"),
            })
    # Fight Club companions (<monster>): everything the file holds for each (fcmonster.parse): size, hit points, AC, speed, saves, skills, resistances,
    # senses, traits, actions ... A companion picked from Fight Club's own list only has name, kind, abilities and hit dice.
    d["companions"] = [fcmonster.parse(i, m) for i, m in enumerate(root.findall("monster"))]
    d["feats"] = _feats(root)
    d["notes"] = [{"ref": f"n{i}", "name": _t(n, "name"), "text": _t(n, "text")} for i, n in enumerate(root.findall("note"))]
    st = gear.states(root, _extra().get(cid, {}), fcedit.is_equipped)
    d["items"] = [_item(i, f"i{n}", st[i]) for n, i in enumerate(root.findall("item"))]
    d["containers"] = [
        {"name": _t(c, "name"), "weight": _num(_t(c, "weight")), "value": _num(_t(c, "value")),
         "items": [_item(i, f"c{j}.{k}", st[i]) for k, i in enumerate(c.findall("item"))]}
        for j, c in enumerate(root.findall("container"))
    ]
    # Carried weight: loose items (weight x quantity) plus each container's own weight and
    # the items inside it; rounded to one decimal place.
    d["totalWeight"] = round(
        sum(i["weight"] * i["quantity"] for i in d["items"])
        + sum(c["weight"] + sum(i["weight"] * i["quantity"] for i in c["items"])
              for c in d["containers"]),
        1)
    # Proficiency codes (see charcalc): the classes' and the background's <proficiency> numbers, saves below 100 and skills from 100.
    codes = [int(_num(p.text)) for e in [*root.findall("class"), *([bg] if bg is not None else []), *([race] if race is not None else [])] for p in e.findall("proficiency") if p.text]
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
    """Read an uploaded file object `f` of EITHER kind -> ([<character> elements], {portrait uid: base64}, {character uid: extras}).

    The kind is told from the file itself (gloan5e.load): a Gloan5e file brings its extras; a Fight Club file is converted to the same record with
    no extras. Fight Club's own .backup files are PLAIN XML; a zip (older exports, or one the user made) containing one is accepted too:
    zipfile.is_zipfile() sniffs the content, every entry ending .xml/.backup is parsed, and directories, entries over 200 MiB uncompressed (a "zip
    bomb" guard) and unparsable entries are skipped."""
    raw, name = f.read(), getattr(f, "filename", "") or ""   # whole upload as a bytes object
    fc, extras, kind = gloan5e.load(raw, name)
    if kind == "gloan5e":
        chars, images = _characters_from(fc)
        return chars, images, extras
    if zipfile.is_zipfile(io.BytesIO(fc)):
        chars, images = [], {}
        with zipfile.ZipFile(io.BytesIO(fc)) as z:
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
        return chars, images, {}
    chars, images = _characters_from(fc)
    return chars, images, {}


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


def _clean_extras(got):
    """The extras of one character from an uploaded file, cut down to the right shapes (a file is data, never trusted): trackers [{id, label, cur, max}], conditions
    text, deaths {s, f}, worn {item key: kind or "off"}, attuned {item key: bool}."""
    out = {}
    if isinstance(got.get("trackers"), list):
        out["trackers"] = [{"id": str(t.get("id") or uuid.uuid4().hex[:8])[:12], "label": str(t.get("label", "Tracker"))[:30] or "Tracker", "max": max(0, int(_num(t.get("max")))),
                            "cur": max(0, min(int(_num(t.get("cur"))), max(0, int(_num(t.get("max"))))))} for t in got["trackers"][:12] if isinstance(t, dict)]
    if isinstance(got.get("conditions"), str):
        out["conditions"] = got["conditions"][:200]
    if isinstance(got.get("deaths"), dict):
        out["deaths"] = {"s": max(0, min(3, int(_num(got["deaths"].get("s"))))), "f": max(0, min(3, int(_num(got["deaths"].get("f")))))}
    if isinstance(got.get("worn"), dict):
        out["worn"] = {str(k)[:20]: v for k, v in got["worn"].items() if v == "off" or v in gear.WORN_KINDS}
    if isinstance(got.get("attuned"), dict):
        out["attuned"] = {str(k)[:20]: bool(v) for k, v in got["attuned"].items()}
    return out


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
        chars, images, _ = _read_upload(f)
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
        chars, images, extras = _read_upload(f)
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
                # The extras that came in a Gloan5e file (trackers, conditions, death saves, worn and attuned items) replace this character's; a
                # Fight Club file has none, and then the extras the character already has are kept.
                got = extras.get(_t(ch, "uid"))
                if got:
                    mine = ex.setdefault(cid, {})
                    for k in gloan5e.EXTRA_KEYS:
                        mine.pop(k, None)
                    mine.update(_clean_extras(got))
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
        return jsonify([summary(i, _peek(i)) for i in _ids() if _may_use(i) and (keep is None or i in keep)])


@bp.get("/api/party/<cid>")
def get_member(cid):
    """GET /api/party/<cid> -> detail() JSON for one character; 404 if unknown, 400 if the
    id has illegal characters. <cid> in the URL is passed in as the `cid` argument."""
    _guard(cid)
    with lock:
        return jsonify(detail(cid, _peek(cid)))


@bp.get("/api/party/<cid>/portrait")
def portrait(cid):
    """GET /api/party/<cid>/portrait -> the character's picture as a PNG/JPEG image.

    Fight Club embeds the portrait as base64 text inside <imageData>. We decode it back to
    raw bytes and return it as an image the browser can show in an <img> tag. The type is
    detected from the first bytes (the PNG magic number \\x89PNG); anything else is assumed
    JPEG. 404 if there is no image. Cached by the browser for 60 s.
    """
    _guard(cid)
    data = _image_b64(cid, _peek(cid))
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
      creatures    [{i, hp, hpMax, ac}]  the companions (Fight Club <monster>) to KEEP, i = position in the file; those not listed are removed. Hit points and
                   AC are written into the monster itself (hpCurrent, hpMax, armor).
      classTrackers [{label, cur}]  the class's own counters (Channel Divinity ...): the value left now -> the <tracker> in the class
      name, xp, unarmed, abilities [6 base scores], race {name, speed, age, height, weight, eyes, skin, hair}, background {name}, classes [{name, level, hd,
                   armor, weapons, tools}], slots [9 maximums], profs {saves, skills}   the Edit character form (see fcedit.edit_character)
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
            maxes = fcedit.slot_levels(root, "slots")
            # Clamp each level's value to that level's maximum (spell levels 1-9; position 0 of the file's list, the cantrips, is left alone).
            cur = [max(0, min(int(v), maxes[i])) for i, v in enumerate(list(body["slotsCurrent"])[:9])]
            fcedit.set_slot_levels(root, "slotsCurrent", cur + [0] * (9 - len(cur)))
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
        if "creatures" in body:
            # The list says which companions stay (by position in the file) and their hit points and AC; every other <monster> is removed.
            mons, keep = root.findall("monster"), {}
            for c in body["creatures"]:
                if isinstance(c, dict) and "i" in c and 0 <= int(c["i"]) < len(mons):
                    keep[int(c["i"])] = c
            for i, mon in reversed(list(enumerate(mons))):
                if i not in keep:
                    root.remove(mon)
                else:
                    c = keep[i]
                    fcmonster.set_vitals(mon, hp=c.get("hp"), hp_max=c.get("hpMax"), ac=c.get("ac"))
        if "classTrackers" in body:
            for t in body["classTrackers"]:
                fcmonster.set_class_tracker(root, str(t.get("label", "")), int(_num(t.get("cur"))))
        edit = {k: body[k] for k in ("name", "xp", "unarmed", "abilities", "race", "background", "classes", "slots", "profs") if k in body}
        if edit:   # the Edit character form (fcedit.edit_character)
            try:
                fcedit.edit_character(root, edit)
            except (ValueError, TypeError, AttributeError) as err:
                return jsonify(error=str(err) or "That is not a valid character change"), 400
        if "hitDice" in body:
            for c, v in zip(root.findall("class"), body["hitDice"]):
                e = c.find("hdCurrent")
                if e is None:
                    e = ET.SubElement(c, "hdCurrent")
                e.text = str(max(0, min(int(v), int(_num(_t(c, "level"), 1)))))
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
    """Put `elem` inside `parent` in Fight Club's own order (see fcedit.append_after). (`root` is unused: kept so the calls read the same.)"""
    fcedit.append_after(parent, elem, after, before)


def _sub(parent, tag, text):
    e = ET.SubElement(parent, tag)
    e.text = text
    return e


@bp.post("/api/party/<cid>/items")
def add_item(cid):
    """POST /api/party/<id>/items -> {"ok": true, "name"}: add an item to the character's loose items (the same item again just raises its count).
    Two kinds of body:
      from the magic item search {name, type (Open5e's: "Wondrous item"), rarity, text, attunement}
      from the Add item form      {name, typeCode, detail, text, quantity, weight, value, magic, ac, damage, damageType}
      a bag                       {name, bag: true, weight, value, text}   (a <container>; 2 at most)
    Either may carry quantity (the search kind: how many) and givenBy (the DM only: it is loot given to that character, noted on their sheet like a gift).
    """
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    name = _text(b.get("name"), 80)
    if not name:
        return jsonify(error="The item needs a name"), 400
    with lock:
        root = _load(cid)
        if b.get("bag"):   # a bag, pack or chest: a <container>, two at most
            try:
                fcedit.add_bag(root, fcedit.make_bag(b))
            except ValueError as err:
                return jsonify(error=str(err)), 400
            _write(cid, root)
            return jsonify(ok=True, name=name, character=detail(cid, root))
        if "typeCode" in b:
            try:
                it = fcedit.make_item(b, ITEM_TYPES)
            except ValueError as err:
                return jsonify(error=str(err)), 400
        else:
            kind, rarity = _text(b.get("type"), 60), _text(b.get("rarity"), 20)
            it = ET.Element("item")
            _sub(it, "name", name)
            _sub(it, "detail", ", ".join(x for x in (kind, rarity, "requires attunement" if b.get("attunement") else "") if x))
            _sub(it, "text", _text(b.get("text"), 6000))
            _sub(it, "type", next((c for p, c in ITEM_CODE_BY_TYPE if kind.lower().startswith(p)), "15"))
            _sub(it, "magic", "1")
            _sub(it, "weight", "0.0")
            _sub(it, "value", "0.0")
            _sub(it, "quantity", "1")
        if "typeCode" not in b and b.get("quantity"):   # (the Add item form's own quantity is read by make_item)
            fcedit.put(it, "quantity", max(1, min(9999, int(_num(b["quantity"], 1)))))
        qty = fcedit.quantity(it)
        fcedit.add_to(root, it)
        _write(cid, root)
        if b.get("givenBy") and auth.is_dm():   # loot handed over by the DM: the player's sheet highlights it until they acknowledge it
            ex = _extra()
            _note_gift(ex, cid, name, qty, "the DM")
            _save_extra(ex)
        return jsonify(ok=True, name=name, character=detail(cid, root))


def _forget(mine, key):
    """An item left the character: drop what the extras said about it (worn kind, attunement)."""
    for field in ("worn", "attuned"):
        mine.get(field, {}).pop(key, None)


@bp.patch("/api/party/<cid>/items/<ref>")
def change_item(cid, ref):
    """PATCH /api/party/<id>/items/<ref> -> {"ok": true, "removed": bool}. Body, any of:
      quantity   n            how many; 0 removes the item
      equip      true|false   wear / hold it or take it off. Armor, shields and weapons use Fight Club's own slots (two hands, one suit of armor: fcedit.equip).
                              Any other item is worn as a `kind` (gear.WORN_KINDS: belt, feet, ring ...: the one its name says, else the `kind` sent) if the limit
                              for that kind allows (gear.can_wear); the worn kind is kept in the extras beside the file
      attune     true|false   attune to it or end it; at most 3 items at once (gear.can_attune); only for items that need attunement
    Refused with 400 and a message that names the item in the way."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    with lock:
        root, ex = _load(cid), _extra()
        mine = ex.setdefault(cid, {})
        try:
            parent, it = fcedit.item_at(root, ref)
            sts = gear.states(root, mine, fcedit.is_equipped)
            st = sts[it]
            removed = False
            if "quantity" in b:
                removed = fcedit.set_quantity(root, ref, int(_num(b["quantity"])))
                if removed:
                    _forget(mine, st["key"])
            if "equip" in b:
                if st["fc"]:
                    fcedit.equip(root, ref, bool(b["equip"]))
                    if b["equip"] and st["needs"]:
                        mine.setdefault("attuned", {}).setdefault(st["key"], False)
                elif parent is not root:
                    raise ValueError("Take it out of the bag first: only loose items can be worn")
                elif b["equip"]:
                    kind = str(b.get("kind") or st["kind"] or "")
                    gear.can_wear(sts, it, kind)
                    mine.setdefault("worn", {})[st["key"]] = kind
                    if st["needs"]:
                        mine.setdefault("attuned", {}).setdefault(st["key"], False)   # worn is not attuned: it gives nothing until the player attunes
                    if not _t(it, "slot"):
                        fcedit.put(it, "slot", "1")   # Fight Club's own rule counts an item with a slot as carried and active
                else:
                    mine.setdefault("worn", {})[st["key"]] = "off"
            if "attune" in b:
                if b["attune"]:
                    gear.can_attune(sts, it)
                elif not st["needs"]:
                    raise ValueError("That item does not need attunement")
                mine.setdefault("attuned", {})[st["key"]] = bool(b["attune"])
        except ValueError as err:
            return jsonify(error=str(err)), 400
        _write(cid, root)
        _save_extra(ex)
    return jsonify(ok=True, removed=removed, character=detail(cid, root))


@bp.patch("/api/party/<cid>/coins")
def change_coins(cid):
    """PATCH /api/party/<id>/coins {coin: "gp", delta: -5} -> {"ok": true, "amount": n}: spend or add coins. Coins are the character's own items ("Gold (gp)" ...)
    so Fight Club shows them; this makes the item when there is none and removes it at zero."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    with lock:
        root = _load(cid)
        try:
            amount = fcedit.change_coin(root, str(b.get("coin") or ""), int(_num(b.get("delta"))))
        except ValueError as err:
            return jsonify(error=str(err)), 400
        _write(cid, root)
    return jsonify(ok=True, amount=amount, character=detail(cid, root))


@bp.delete("/api/party/<cid>/items/<ref>")
def delete_item(cid, ref):
    """DELETE /api/party/<id>/items/<ref> : take the whole stack out of the character."""
    _guard(cid)
    with lock:
        root, ex = _load(cid), _extra()
        try:
            _, it = fcedit.item_at(root, ref)
            _forget(ex.setdefault(cid, {}), gear.states(root, ex.get(cid, {}), fcedit.is_equipped)[it]["key"])
            fcedit.remove_item(root, ref)
        except ValueError as err:
            return jsonify(error=str(err)), 400
        _write(cid, root)
        _save_extra(ex)
    return jsonify(ok=True)


# ---- giving an item to another player. The item moves between the two characters' files (a stack is split); the receiver's sheet highlights it
# "Given to you by <player>" until they acknowledge it. The note lives in the sidecar file under the receiver (gifts), not in the Fight Club file.
def _recipients(giver):
    """Who the character `giver` can give items to: the OTHER characters in the loaded campaign's party, and only when `giver` is in that party
    too (the DM and players alike). [{id, name, owner}]"""
    if not auth.current_user():
        return []
    party_ids = active_ids() or []
    if giver not in party_ids:
        return []
    ex = _extra()
    return [{"id": i, "name": _t(_peek(i), "name"), "owner": ex.get(i, {}).get("owner", "")} for i in party_ids if i != giver and (DIR / f"{i}.xml").exists()]


def _note_gift(ex, to, name, qty, giver):
    """Record in the extras `ex` that character `to` was given `qty` of `name` by `giver` (a note on their sheet until acknowledged; the last 50 are kept)."""
    gifts = ex.setdefault(to, {}).setdefault("gifts", [])
    gifts.append({"id": uuid.uuid4().hex[:8], "name": name, "qty": max(1, int(qty)), "from": giver, "at": int(time.time())})
    del gifts[:-50]


@bp.get("/api/party/recipients")
def list_recipients():
    """GET /api/party/recipients?from=<character id> -> [{id, name, owner}]: who that character can give an item to (see _recipients). The caller must be
    allowed to use the character."""
    giver = request.args.get("from", "")
    _guard(giver)
    return jsonify(_recipients(giver))


@bp.post("/api/party/<cid>/items/<ref>/give")
def give_item(cid, ref):
    """POST /api/party/<id>/items/<ref>/give {to: character id, quantity} -> {"ok": true, "name"}: move that many of the item to another character.
    The receiver gets a "Given to you by <you>" note until they acknowledge it."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    to = str(b.get("to") or "")
    if to == cid or to not in {r["id"] for r in _recipients(cid)}:
        return jsonify(error="You can only give items to the other characters in the campaign party you are in"), 400
    user = auth.current_user()
    with lock:
        src, dst = _load(cid), _load(to)
        ex = _extra()
        try:
            _, it0 = fcedit.item_at(src, ref)
            key0, have0 = gear.states(src, ex.get(cid, {}), fcedit.is_equipped)[it0]["key"], fcedit.quantity(it0)
            name = fcedit.give(src, ref, dst, int(_num(b.get("quantity"), 1)))
        except ValueError as err:
            return jsonify(error=str(err)), 400
        if int(_num(b.get("quantity"), 1)) == have0:
            _forget(ex.setdefault(cid, {}), key0)   # the whole stack left: what the extras said about it goes too
        _write(cid, src)
        _write(to, dst)
        giver = user["name"] if user["name"] != "local" else (ex.get(cid, {}).get("owner") or _t(src, "name"))
        _note_gift(ex, to, name, int(_num(b.get("quantity"), 1)), giver)
        _save_extra(ex)
    return jsonify(ok=True, name=name)


@bp.delete("/api/party/<cid>/gifts/<gid>")
def acknowledge_gift(cid, gid):
    """DELETE /api/party/<id>/gifts/<gift id> : the receiver acknowledges a gift, which ends its highlight."""
    _guard(cid)
    with lock:
        ex = _extra()
        mine = ex.get(cid, {})
        mine["gifts"] = [g for g in mine.get("gifts", []) if g.get("id") != gid]
        _save_extra(ex)
    return jsonify(ok=True)


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
        _sub(sp, "prepared", "1" if int(_num(b.get("level"))) == 0 else "0")   # a cantrip is always ready
        _sub(sp, "sclass", _t(cls, "name"))
        if b.get("ritual"):
            _sub(sp, "ritual", "1")
        _append(root, cls, sp, ("spell",), ())
        _write(cid, root)
    return jsonify(ok=True, name=name)


@bp.patch("/api/party/<cid>/spells/<int:ref>")
def change_spell(cid, ref):
    """PATCH /api/party/<id>/spells/<ref> {prepared: true|false} -> {"ok": true, "character"}: ready or un-ready a spell (ref = its place in the character's spell list,
    `spells[].ref`). A cantrip is always ready, so it cannot be changed."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    with lock:
        root = _load(cid)
        spells = [s for c in root.findall("class") for s in c.findall("spell")]
        if not 0 <= ref < len(spells):
            return jsonify(error="No such spell"), 404
        sp = spells[ref]
        if int(_num(_t(sp, "level"))) == 0:
            return jsonify(error="A cantrip is always ready"), 400
        fcedit.put(sp, "prepared", "1" if b.get("prepared") else "0")
        _write(cid, root)
    return jsonify(ok=True, character=detail(cid, root))


@bp.post("/api/party/<cid>/companions")
def add_companion(cid):
    """POST /api/party/<id>/companions {name, kind, size, abilities:[6], hd, hp, ac, speed} -> the updated summary: add a companion chosen from the
    monster search. `kind` is the monster's name ("Wolf"), `name` what the character calls it ("Fang"). It is written as a Fight Club <monster> exactly
    as Fight Club writes one picked from its own list (fcmonster.make), plus its hit points, AC and speed, which Fight Club keeps on the monster too."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    kind = _text(b.get("kind"), 60)
    name = _text(b.get("name"), 40) or kind
    if not kind:
        return jsonify(error="Choose a monster first"), 400
    with lock:
        root = _load(cid)
        if len(root.findall("monster")) >= 20:
            return jsonify(error="A character can have 20 companions; remove one first"), 400
        mon = fcmonster.make(name, kind, _text(b.get("size"), 20), _ints(",".join(str(x) for x in b.get("abilities", []))), _text(b.get("hd"), 20),
                             hp=int(_num(b.get("hp"))), ac=int(_num(b.get("ac"))), speed=int(_num(b.get("speed"))))
        _append(root, root, mon, ("monster",), ("slots", "slotsCurrent", "money"))
        _write(cid, root)
        return jsonify(summary(cid, root))


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


def _feature_at(root, ref):
    """The element a feature `ref` names (see _feats; "n2" is the third note): race "r", background "b", class "c<class>.<n>", character feat "f", note "n"."""
    m = re.fullmatch(r"([rbfn]|c(\d+)\.)(\d+)", ref)
    if not m:
        raise ValueError("No such entry")
    kind, i = m.group(1), int(m.group(3))
    parent = {"r": root.find("race"), "b": root.find("background")}.get(kind, root)
    if kind.startswith("c"):
        classes = root.findall("class")
        parent = classes[int(m.group(2))] if int(m.group(2)) < len(classes) else None
    items = parent.findall("note" if kind == "n" else "feat") if parent is not None else []
    if i >= len(items):
        raise ValueError("No such entry")
    return items[i]


@bp.patch("/api/party/<cid>/features/<ref>")
def change_feature(cid, ref):
    """PATCH /api/party/<id>/features/<ref> {name, text} -> {"ok": true, "character"}: edit the title and text of a note, feat or class / race / background feature
    (`ref` from the character record: notes "n0", feats "f0", class "c0.3", race "r1", background "b0")."""
    _guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    name = _text(b.get("name"), 80)
    if not name:
        return jsonify(error="It needs a title"), 400
    with lock:
        root = _load(cid)
        try:
            el = _feature_at(root, ref)
        except ValueError as err:
            return jsonify(error=str(err)), 404
        fcedit.put(el, "name", name)
        fcedit.put(el, "text", _text(b.get("text"), 8000))
        _write(cid, root)
    return jsonify(ok=True, character=detail(cid, root))


@bp.delete("/api/party/<cid>")
def delete_member(cid):
    """DELETE /api/party/<cid> : remove a character's XML file and sidecar entry.
    Response {"ok": true}; deleting an unknown (but well-formed) id is not an error. A player may delete
    only their own characters (someone else's is "not found")."""
    if _path(cid).exists():
        _guard(cid)
    with lock:
        p = _path(cid)
        _chars.pop(cid, None)
        _dirty.discard(cid)
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
    """Send the characters `ids` as a download in the format chosen by ?as= : "fightclub5e" (the default) or "gloan5e".

    ONE path builds both: the characters become a Gloan5e file (Fight Club backup + the extras kept beside it, gloan5e.pack), and a Fight Club download is
    that file STRIPPED back to the Fight Club backup inside it (gloan5e.strip): plain XML named <something>.backup (see fcformat.py), byte for byte what
    Fight Club reads. "?format=zip" (Fight Club only) gives the same backup inside a zip. The caller has already checked the user may use every id."""
    with lock:
        chars = [_peek(i) for i in ids]
        images, extras, ex = {}, {}, _extra()
        for cid, ch in zip(ids, chars):
            ref = (ch.findtext("imageData/uid") or "").strip()
            b64 = _image_b64(cid, ch) if ref else ""
            if ref and b64 and not (ch.findtext("imageData") or "").strip():   # the picture is held outside the character
                images[ref] = b64
            extras[_t(ch, "uid")] = {k: ex.get(cid, {}).get(k) for k in gloan5e.EXTRA_KEYS}
        blob = gloan5e.pack(fcformat.encode(chars, images), extras)
    if request.args.get("as") == "gloan5e":
        return _stream_download(io.BytesIO(blob), download_name.replace("FightClub5", "Gloan5e") + gloan5e.EXT, "application/octet-stream")
    xml = gloan5e.strip(blob)
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
    if not ids:
        return jsonify(error="There are no characters to download yet"), 404   # (the button shows this beside itself instead of saving an empty file)
    return _backup_download(ids, "FightClub5")


@bp.get("/api/party/<cid>/export.zip")
def export_member(cid):
    """GET /api/party/<id>/export.zip downloads ONE character as a Fight Club backup named FightClub5-<Name>.backup. The DM may
    download any; a player only a character assigned to them (anything else is a 404, like every other character route, see
    _guard). Add ?format=zip for a zipped copy."""
    _guard(cid)
    with lock:
        name = _t(_peek(cid), "name") or cid
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


def migrate_creatures():
    """Earlier versions kept a companion's hit points and AC in the sidecar file (party_extra.json, "creatures"). They now live in the character's own
    <monster> (hpMax, hpCurrent, armor), where Fight Club keeps them too. Move any old entries over (a creature with no <monster> gets one) and drop
    them from the sidecar. Runs once when the server starts; harmless to run again."""
    with lock:
        ex = _extra()
        changed = False
        for cid, rec in list(ex.items()):
            old = rec.pop("creatures", None)
            if old is None:
                continue
            changed = True
            path = DIR / f"{cid}.xml"
            if not old or not path.exists():
                continue
            root = SafeET.parse(path).getroot()
            mons = root.findall("monster")
            for c in old:
                mon = next((x for x in mons if _t(x, "name") == c.get("name")), None)
                if mon is None:
                    mon = fcmonster.make(str(c.get("name", "Creature")), str(c.get("notes") or c.get("name", "Creature")), "", [], "")
                    _append(root, root, mon, ("monster",), ("slots", "slotsCurrent", "money"))
                    mons.append(mon)
                fcmonster.set_vitals(mon, hp=c.get("hp"), hp_max=c.get("hpMax"), ac=c.get("ac"))
            _write(cid, root)
        if changed:
            _save_extra(ex)


try:
    migrate_creatures()
except Exception:   # never stop the server over old companion data
    pass
