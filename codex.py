"""codex.py - Fight Club's own rule book (its "compendium"): the races, classes, backgrounds, feats, spells and items that character creation and level-up copy from.

WHERE IT COMES FROM. A Fight Club backup holds the app's compendium next to the characters (the same elements the app itself uses when you make a character), in exactly the
shape a character holds them: a <race> with its <feat>s and <mod>s, a <class> with its whole level table (<autolevel>), a <spell> with its <sclass>es, an <item>. The
Fight Club 5e XML collections (the zip next to app.py) are what that compendium is built from, so a backup made after importing a collection holds the same data. The
codex is therefore taken from a backup, never typed in or fetched from anywhere else:
  1. data/codex/compendium.xml   the copy kept by the app (in the bucket on Cloud Run). Written whenever a backup that holds a compendium is imported (adopt()).
  2. the newest *.backup file next to app.py that holds one - for running on your own computer; it is not in the container image.
With neither, creation says so and asks for a backup (the DM's Home page tells how).

WHAT FIGHT CLUB DOES WHEN YOU MAKE A CHARACTER (read from FightClub5_with_level_1_cleric.backup, whose character "Name" it made): the character's <race>, <background> and
<class> are copies of the compendium's; the class keeps its whole <autolevel> table; its <feat> list is the features EARNED: every autolevel feature that is not optional, plus the
optional ones that were chosen ("Starting <Class>" for a first class, "Divine Domain: Life Domain" for the sub-class picked, and that sub-class's own "Life Domain: ..." features as
their levels come). parse_class() reads exactly that structure; charbuild.py copies from it.

A CHOICE is found, not listed: at a level, a non-optional feature F (such as "Divine Domain", "Primal Path", "Fighting Style", "Pact Boon") that has optional features named
"F: <Option>" asks the player to pick an Option. The picked option's own followers ("<Option>: ...") come with it at their levels.
Pure reading and copying: no Flask. Needs defusedxml if available, the standard library otherwise.
"""
import copy
import os
import re
import threading
from pathlib import Path
import xml.etree.ElementTree as ET

try:
    from defusedxml import ElementTree as SafeET
except ImportError:  # pragma: no cover
    SafeET = ET

BASE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("DND_DATA_ROOT") or BASE)
DIR = ROOT / "data" / "codex"
FILE = DIR / "compendium.xml"
KEEP = ("race", "class", "background", "feat", "spell", "item")   # (monsters are not needed here)
HIT_DIE = {1: 6, 2: 8, 3: 10, 4: 12}
ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]
SKILLS = ["Acrobatics", "Animal Handling", "Arcana", "Athletics", "Deception", "History", "Insight", "Intimidation", "Investigation", "Medicine", "Nature", "Perception",
          "Performance", "Persuasion", "Religion", "Sleight of Hand", "Stealth", "Survival"]
SCHOOLS = {"1": "Abjuration", "2": "Conjuration", "3": "Divination", "4": "Enchantment", "5": "Evocation", "6": "Illusion", "7": "Necromancy", "8": "Transmutation"}

# PHB, "Multiclassing": the ability scores (13 or more) a class requires, by class name. [[0, 1]] = "Strength or Dexterity"; every group is required.
PREREQUISITES = {"artificer": [[3]], "barbarian": [[0]], "bard": [[5]], "cleric": [[4]], "druid": [[4]], "fighter": [[0, 1]], "monk": [[1], [4]], "paladin": [[0], [5]],
                 "ranger": [[1], [4]], "rogue": [[1]], "sorcerer": [[5]], "warlock": [[5]], "wizard": [[3]]}
# how a class counts toward the multiclass spellcaster level (PHB; the Artificer is Tasha's: half, rounded UP)
CASTER = {"bard": "full", "cleric": "full", "druid": "full", "sorcerer": "full", "wizard": "full", "paladin": "half", "ranger": "half", "artificer": "half-up", "warlock": "pact"}
# PHB, "Multiclass Spellcaster: Spell Slots per Spell Level" (caster level 1..20 -> slots of spell level 1..9)
MULTI_SLOTS = [
    [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1],
    [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
    [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]]
# PHB spells KNOWN by level 1..20 for the classes whose table lists them (the others prepare from their list: modifier + level; the Wizard's spellbook grows by two)
KNOWN = {"bard": [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15, 16, 18, 19, 19, 20, 22, 22, 22], "sorcerer": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 15],
         "warlock": [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15], "ranger": [0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11]}
# a choice that is made several times with the same options (the first time the options are in the table; later levels only add picks): {feature: {level: how many}}
PICKS = {"Metamagic": {3: 2, 10: 1, 17: 1}}
# PHB, Warlock "Pact Magic" by level 1..20: (slots, their spell level). Fight Club's table lists only the cantrips for a warlock, so the slots come from here.
PACT = [(1, 1), (2, 1), (2, 2), (2, 2), (2, 3), (2, 3), (2, 4), (2, 4), (2, 5), (2, 5), (3, 5), (3, 5), (3, 5), (3, 5), (3, 5), (3, 5), (4, 5), (4, 5), (4, 5), (4, 5)]
XP_FOR_LEVEL = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000]

lock = threading.Lock()
_cache = {"key": None, "codex": None}


# ============================================================================================================================ loading
def _text(e, tag, default=""):
    v = e.findtext(tag)
    return v.strip() if v and v.strip() else default


class Codex:
    """The compendium's elements by kind: .races, .classes, .backgrounds, .feats, .spells, .items (lists of ElementTree elements) and where they came from."""

    def __init__(self, root, source):
        self.source = source
        self.races, self.classes, self.backgrounds = root.findall("race"), root.findall("class"), root.findall("background")
        self.feats, self.spells, self.items = root.findall("feat"), root.findall("spell"), root.findall("item")
        self._class_info = {}

    def counts(self):
        return {"races": len(self.races), "classes": len(self.classes), "backgrounds": len(self.backgrounds), "feats": len(self.feats), "spells": len(self.spells),
                "items": len(self.items)}

    def class_named(self, name):
        n = (name or "").strip().lower()
        return next((i for i, c in enumerate(self.classes) if _text(c, "name").lower() == n), None)

    def parsed_class(self, index):
        if index not in self._class_info:
            self._class_info[index] = parse_class(self.classes[index], index)
        return self._class_info[index]


def _score(root):
    return sum(len(root.findall(t)) for t in ("class", "race", "background", "spell")) if len(root.findall("class")) >= 3 and len(root.findall("race")) >= 3 else 0


def _compact(root):
    out = ET.Element("compendium")
    for tag in KEEP:
        for e in root.findall(tag):
            out.append(e)
    return out


def adopt(raw):
    """adopt_root() for backup bytes."""
    try:
        return adopt_root(SafeET.fromstring(raw))
    except ET.ParseError:
        return None


def adopt_root(root):
    """Keep the compendium of a parsed Fight Club backup as the codex when it holds one (at least three classes and three races). Returns its counts, or None when the file has none.
    Called when a backup is imported, so the rule book follows the Fight Club app the players really use."""
    if not _score(root):
        return None
    comp = _compact(root)
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    ET.ElementTree(comp).write(tmp, encoding="utf-8", xml_declaration=True)
    os.replace(tmp, FILE)
    with lock:
        _cache.update(key=None, codex=None)
    return Codex(comp, "an imported Fight Club backup").counts()


def _discover():
    """The newest backup next to app.py that holds a compendium (the newest is the one made by the Fight Club app as it is now). Files under 1 MB cannot hold one and are not parsed."""
    best = None
    for p in BASE.glob("*.backup"):
        try:
            if p.stat().st_size < 1_000_000:
                continue
            root = SafeET.parse(p).getroot()
        except Exception:
            continue
        s = _score(root)
        if s and (best is None or p.stat().st_mtime > best[0]):
            best = (p.stat().st_mtime, p, root)
    return best


def load():
    """The codex, or None when there is none yet. Cached until the codex file changes."""
    with lock:
        key = (FILE.stat().st_mtime_ns if FILE.exists() else 0, "disk")
        if key[0] == 0:
            key = ("local", tuple(sorted((p.name, p.stat().st_mtime_ns) for p in BASE.glob("*.backup"))))
        if _cache["key"] == key and _cache["codex"] is not None:
            return _cache["codex"]
        codex = None
        if FILE.exists():
            codex = Codex(SafeET.parse(FILE).getroot(), "the rule book kept by the app")
        else:
            best = _discover()
            if best:
                codex = Codex(_compact(best[2]), f"{best[1].name} next to the app")
        _cache.update(key=key, codex=codex)
        return codex


# ============================================================================================================================ reading a class
def _int(s, default=0):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return default


def slots_of(autolevel):
    """The ten numbers of a level's <slots> (position 0 = cantrips known), or None when the level has none."""
    s = autolevel.findtext("slots")
    return (([_int(x) for x in re.findall(r"-?\d+", s)] + [0] * 10)[:10]) if s else None


def parse_class(el, index=None):
    """A compendium <class> -> {id, name, key (lower case name), hd, saves, skills {count, options [skill index]}, armor, weapons, tools, wealth, spellAbility (0-5, 6 none),
    caster, prerequisites, levels {n: {feats [{name, text, optional}], slots [10], asi}}, groups [choice groups], asiLevels, startName, multiName}.
    A choice group = {level, head, options [{name, label, text}], picks}."""
    name = _text(el, "name")
    key = name.lower()
    profs = [_int(p.text, -1) for p in el.findall("proficiency")]
    levels, order = {}, []
    for a in el.findall("autolevel"):
        n = _int(a.findtext("level"), 1)
        lv = levels.setdefault(n, {"feats": [], "slots": None, "asi": False})
        sl = slots_of(a)
        if sl:
            lv["slots"] = sl
        if a.find("scoreImprovement") is not None:
            lv["asi"] = True
        for f in a.findall("feat"):
            lv["feats"].append({"name": _text(f, "name"), "text": f.findtext("text") or "", "optional": f.find("optional") is not None, "el": f})
    # slots carry forward: a level that lists none keeps the previous level's
    last = [0] * 10
    for n in sorted(levels):
        if levels[n]["slots"] is None:
            levels[n]["slots"] = list(last)
        last = levels[n]["slots"]
    if key == "warlock":   # (see PACT) keep the cantrips from the table, add the pact slots
        for n, lv in levels.items():
            if 1 <= n <= 20:
                count, at = PACT[n - 1]
                lv["slots"] = [lv["slots"][0]] + [count if i + 1 == at else 0 for i in range(9)]
    groups, seen = [], set()
    for n in sorted(levels):
        heads = {f["name"] for f in levels[n]["feats"] if not f["optional"]}
        for head in sorted(heads):
            opts = []
            for f in levels[n]["feats"]:
                if f["optional"] and f["name"].startswith(head + ": ") and f["name"] not in [o["name"] for o in opts]:
                    opts.append({"name": f["name"], "label": f["name"][len(head) + 2:], "text": f["text"], "el": f["el"]})
            if opts and (n, head) not in seen:
                seen.add((n, head))
                groups.append({"level": n, "head": head, "options": opts, "picks": PICKS.get(head, {}).get(n, 1)})
    for head, per in PICKS.items():   # later levels that add picks of an earlier choice (Metamagic)
        first = next((g for g in groups if g["head"] == head), None)
        if first:
            for n, picks in per.items():
                if n != first["level"] and n in levels:
                    groups.append({"level": n, "head": head, "options": first["options"], "picks": picks})
    return {"id": index, "el": el, "name": name, "key": key, "hd": HIT_DIE.get(_int(el.findtext("hd"), 1), 6), "saves": [p for p in profs if 0 <= p < 6],
            "skills": {"count": _int(el.findtext("numClassSkills"), 2), "options": [p - 100 for p in profs if p >= 100]},
            "armor": _text(el, "armor"), "weapons": _text(el, "weapons"), "tools": _text(el, "tools"), "wealth": _text(el, "wealth", "4d4x10"),
            "spellAbility": _int(el.findtext("spellAbility"), 6), "caster": CASTER.get(key, ""), "prerequisites": PREREQUISITES.get(key, []),
            "levels": levels, "groups": groups, "asiLevels": sorted(n for n in levels if levels[n]["asi"]),
            "startName": f"Starting {name}", "multiName": f"Multiclass {name}"}


def class_summary(cls):
    """parse_class() for the page: the same, without feature texts or XML elements. `spellKind` says how the class gets spells: "known" (the list `known`, by level), "spellbook", "prepared" (its
    ability modifier + level, half for `half`) or "" for none."""
    any_slots = any(lv["slots"][0] or any(lv["slots"][1:]) for lv in cls["levels"].values())
    return {"spellKind": "known" if cls["key"] in KNOWN else "spellbook" if cls["key"] == "wizard" else "prepared" if any_slots else "", "known": KNOWN.get(cls["key"]),
            "half": cls["caster"] in ("half", "half-up"),"id": cls["id"], "name": cls["name"], "hd": cls["hd"], "saves": cls["saves"], "skills": cls["skills"], "armor": cls["armor"], "weapons": cls["weapons"],
            "tools": cls["tools"], "wealth": cls["wealth"], "spellAbility": cls["spellAbility"], "caster": cls["caster"], "asiLevels": cls["asiLevels"],
            "slots": {n: lv["slots"] for n, lv in cls["levels"].items()},
            "groups": [{"level": g["level"], "head": g["head"], "picks": g["picks"], "options": [{"name": o["name"], "label": o["label"]} for o in g["options"]]} for g in cls["groups"]]}


def spells_known_allowance(cls, level, shown):
    """How many cantrips and spells a class has at `level` (shown = the six ability scores): {cantrips, spells, kind}. Cantrips are position 0 of the level's slots. Spells:
    the PHB tables for bard, sorcerer, warlock, ranger ("known"); the Wizard's spellbook (6 + 2 a level); the rest prepare ability modifier + level (half for paladin and
    artificer), at least 1 ("prepared")."""
    lv = cls["levels"].get(level) or {"slots": [0] * 10}
    cantrips = lv["slots"][0]
    if not cls["caster"] and not cantrips and not any(lv["slots"][1:]):
        return {"cantrips": 0, "spells": 0, "kind": ""}
    if cls["key"] in KNOWN:
        return {"cantrips": cantrips, "spells": KNOWN[cls["key"]][min(level, 20) - 1], "kind": "known"}
    if cls["key"] == "wizard":
        return {"cantrips": cantrips, "spells": 6 + 2 * (level - 1), "kind": "spellbook"}
    mod = (shown[cls["spellAbility"]] - 10) // 2 if cls["spellAbility"] < 6 else 0
    half = cls["caster"] in ("half", "half-up")
    if not (cantrips or any(lv["slots"][1:])):
        return {"cantrips": 0, "spells": 0, "kind": ""}
    return {"cantrips": cantrips, "spells": max(1, mod + (level // 2 if half else level)), "kind": "prepared"}


def spell_info(el):
    """A compendium <spell> as a short row for a list: name, level, school, time, classes."""
    return {"name": _text(el, "name"), "level": _int(el.findtext("level"), 0), "school": SCHOOLS.get(_text(el, "school"), ""), "time": _text(el, "time"),
            "classes": [c.text for c in el.findall("sclass")]}
