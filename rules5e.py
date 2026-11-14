"""rules5e.py - the rule book data that character creation and level-up need: classes, races, backgrounds, weapons, armor and feats, from Open5e.

Open5e (api.open5e.com) is the same source the monster, spell and magic item searches use. Like them, nothing is fetched twice: a list (every name) is kept as
data/rules/<kind>_index.json and rebuilt when it is over 30 days old; one full record is kept as data/rules/<kind>/<slug>.json for good. The files are in the
data folder (the bucket on Cloud Run), so after the first use the rule book works offline, and a test can put records there to run with no network.

This file has two halves, both free of Flask:
  FETCHING   index(kind) -> [{slug, name, source}]    record(kind, slug) -> the Open5e record     (RuntimeError "Could not reach Open5e" when there is no copy and no network)
  PARSING    parse_class / parse_race / parse_background / equipment_choices / weapon_item / armor_item turn the records (mostly Markdown text) into plain dicts

The parsers only read what the records hold: a class's level table (proficiency bonus, features, spell slots, cantrips and spells known, and its own columns such as
Ki or Sneak Attack), its feature texts (the headings in its description), its sub-classes (archetypes), its starting equipment. Rules that are not in the data
(multiclass prerequisites, which classes cast how) are the small tables below, from the Player's Handbook.
"""
import json
import os
import re
import time
from pathlib import Path

import requests

BASE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("DND_DATA_ROOT") or BASE)
RULES = ROOT / "data" / "rules"
API = "https://api.open5e.com/v1"
INDEX_DAYS = 30
KINDS = ("classes", "races", "backgrounds", "weapons", "armor", "feats")
ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]
ABILITY_NAMES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"]
# the eighteen skills in Fight Club's order (code 100 + position); the same list as charcalc.SKILLS
SKILLS = ["Acrobatics", "Animal Handling", "Arcana", "Athletics", "Deception", "History", "Insight", "Intimidation", "Investigation", "Medicine", "Nature",
          "Perception", "Performance", "Persuasion", "Religion", "Sleight of Hand", "Stealth", "Survival"]
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}

# PHB, "Multiclassing": the ability scores (13 or more) needed to take a level in a class. A list inside a list means "any one of these";
# every other entry is required.
PREREQUISITES = {
    "barbarian": [[0]], "bard": [[5]], "cleric": [[4]], "druid": [[4]], "fighter": [[0, 1]], "monk": [[1], [4]], "paladin": [[0], [5]], "ranger": [[1], [4]],
    "rogue": [[1]], "sorcerer": [[5]], "warlock": [[5]], "wizard": [[3]],
}
# PHB, "Spellcasting" and "Multiclassing": how a class counts toward the multiclass spellcaster level. full: every level; half: half of them (rounded down);
# pact: Warlock's Pact Magic, separate. Anything else casts nothing (or, for a third-caster subclass, is not tracked here).
CASTER = {"bard": "full", "cleric": "full", "druid": "full", "sorcerer": "full", "wizard": "full", "paladin": "half", "ranger": "half", "warlock": "pact"}
# PHB, "Multiclass Spellcaster: Spell Slots per Spell Level" (caster level 1..20 -> slots of level 1..9)
MULTI_SLOTS = [
    [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1],
    [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
    [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]]
# PHB, "Starting equipment": the gold a class may take instead of its equipment (dice, multiplier)
WEALTH = {"barbarian": "2d4x10", "bard": "5d4x10", "cleric": "5d4x10", "druid": "2d4x10", "fighter": "5d4x10", "monk": "5d4", "paladin": "5d4x10", "ranger": "5d4x10",
          "rogue": "4d4x10", "sorcerer": "3d4x10", "warlock": "4d4x10", "wizard": "4d4x10"}
# experience points needed for each level 1..20 (PHB, "Character Advancement")
XP_FOR_LEVEL = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000]
HIT_DIE_CODE = {6: 1, 8: 2, 10: 3, 12: 4}


# ============================================================================================================================ fetching
def _get(url, params=None):
    try:
        r = requests.get(url, params=params, timeout=30, headers={"User-Agent": "dnd-tracker"})
        if r.status_code == 404:
            raise LookupError("Open5e has no such entry")
        r.raise_for_status()
        return r.json()
    except LookupError:
        raise
    except Exception as e:
        raise RuntimeError(f"Could not reach Open5e ({e.__class__.__name__}); the rule book needs the internet the first time") from e


def _read(path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")))
    tmp.replace(path)


def index(kind):
    """Every entry of one kind as [{slug, name, source, record?}], sorted by name. Weapons, armor and feats come with their whole records (they are short);
    for the others a full record is fetched when one is chosen (record())."""
    if kind not in KINDS:
        raise ValueError("Unknown kind")
    f = RULES / f"{kind}_index.json"
    data = _read(f)
    if data and time.time() - data.get("built", 0) < INDEX_DAYS * 86400:
        return data["rows"]
    try:
        rows, url, params = [], f"{API}/{kind}/", {"limit": 500}
        while url:
            page = _get(url, params)
            for m in page["results"]:
                row = {"slug": m["slug"], "name": m["name"], "source": m.get("document__title", ""), "doc": m.get("document__slug", "")}
                if kind in ("weapons", "armor", "feats"):
                    row["record"] = m
                rows.append(row)
            url, params = page.get("next"), None
        rows.sort(key=lambda r: r["name"].lower())
        _write(f, {"built": int(time.time()), "rows": rows})
        return rows
    except RuntimeError:
        if data:   # an old copy beats nothing
            return data["rows"]
        raise


def record(kind, slug):
    """The whole Open5e record of one entry, from data/rules/<kind>/<slug>.json or (once) from Open5e."""
    if kind not in KINDS or not re.fullmatch(r"[\w-]+", slug or ""):
        raise ValueError("Unknown entry")
    f = RULES / kind / f"{slug}.json"
    rec = _read(f)
    if rec is None:
        hit = next((r.get("record") for r in (index(kind) if kind in ("weapons", "armor", "feats") else []) if r["slug"] == slug and r.get("record")), None)
        rec = hit or _get(f"{API}/{kind}/{slug}/")
        _write(f, rec)
    return rec


# ============================================================================================================================ small helpers
def ordinal(text):
    m = re.match(r"\s*(\d+)", text or "")
    return int(m.group(1)) if m else 0


def _norm(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _ability_index(name):
    n = (name or "").strip().lower()
    return next((i for i, a in enumerate(ABILITY_NAMES) if n.startswith(a[:3])), None)


def _skill_index(name):
    n = _norm(name)
    return next((i for i, s in enumerate(SKILLS) if _norm(s) == n), None)


def _plain(md):
    return re.sub(r"\s+", " ", re.sub(r"[*_#]+", "", md or "")).strip()


def _table(md):
    """A Markdown table -> [{header: cell}] (the separator line is skipped)."""
    lines = [ln.strip() for ln in (md or "").split("\n") if ln.strip().startswith("|")]
    if len(lines) < 3:
        return []
    cells = lambda ln: [c.strip() for c in ln.strip().strip("|").split("|")]
    head = cells(lines[0])
    return [dict(zip(head, cells(ln))) for ln in lines[2:] if len(cells(ln)) >= len(head)]


def _sections(md):
    """Markdown with ### / #### headings -> {normalised heading: (heading, body text)}."""
    out, name, buf = {}, None, []
    for ln in (md or "").split("\n") + ["# end"]:
        m = re.match(r"^#{1,6}\s+(.+?)\s*$", ln)
        if m:
            if name is not None:
                out.setdefault(_norm(name), (name, "\n".join(buf).strip()))
            name, buf = m.group(1), []
        else:
            buf.append(ln)
    return out


def _bold_sections(md):
    """"**_Darkvision._** text ..." (Open5e's race traits) -> [(name, text)]"""
    parts = re.split(r"\*\*_(.+?)\._\*\*\s*", md or "")
    return [(parts[i].strip(), parts[i + 1].strip()) for i in range(1, len(parts) - 1, 2)]


# ============================================================================================================================ classes
def parse_class(rec):
    """An Open5e class record -> {slug, name, hd, saves [ability index], armor, weapons, tools, skills {count, options [skill index]}, spellAbility (0-5, 6 = none),
    caster ("full" "half" "pact" ""), levels [{level, prof, features [name], cantrips, spellsKnown, slots [9], pact {slots, level}, extra {column: value}}],
    featureText {name: text}, subclass {label, level, options [{slug, name, source}]}, asiLevels [int], equipment text, prerequisites, wealth}."""
    rows = _table(rec.get("table", ""))
    levels, ordinal_cols = [], {}
    for r in rows:
        for h in r:
            if re.fullmatch(r"\d+(st|nd|rd|th)", h):
                ordinal_cols[h] = ordinal(h)
    known = {"Level", "Proficiency Bonus", "Features", "Cantrips Known", "Spells Known", "Spell Slots", "Slot Level"} | set(ordinal_cols)
    num = lambda s: int(s) if re.fullmatch(r"\d+", (s or "").strip()) else 0
    for r in rows:
        feats = [f.strip() for f in (r.get("Features") or "").split(",") if f.strip() and f.strip() != "-"]
        slots = [0] * 9
        for h, n in ordinal_cols.items():
            slots[n - 1] = num(r.get(h))
        pact = None
        if "Spell Slots" in r and "Slot Level" in r:
            pact = {"slots": num(r["Spell Slots"]), "level": ordinal(r["Slot Level"])}
        levels.append({"level": ordinal(r.get("Level")), "prof": int(re.sub(r"[^\d]", "", r.get("Proficiency Bonus") or "2") or 2), "features": feats,
                       "cantrips": num(r.get("Cantrips Known")), "spellsKnown": num(r.get("Spells Known")), "slots": slots, "pact": pact,
                       "extra": {h: v for h, v in r.items() if h not in known and v not in ("", "-")}})
    secs = _sections(rec.get("desc", ""))
    text = {}
    for lv in levels:
        for f in lv["features"]:
            hit = secs.get(_norm(f)) or secs.get(_norm(re.sub(r"\s*\(.*\)$", "", f))) or secs.get(_norm(f + " feature"))
            text[f] = hit[1] if hit and hit[1] else ""
    # the sub-class: the table names the level it is chosen at by a feature called like the sub-class kind ("Divine Domain", "Roguish Archetype")
    label = re.sub(r"s$", "", rec.get("subtypes_name") or "Subclass")
    sub_level = next((lv["level"] for lv in levels for f in lv["features"] if _norm(f).startswith(_norm(label))), 3)
    slug = rec.get("slug", "")
    return {
        "slug": slug, "name": rec.get("name", ""), "hd": int(re.sub(r"\D", "", (rec.get("hit_dice") or "1d8").split("d")[-1]) or 8),
        "saves": [i for i in (_ability_index(s) for s in re.split(r",|\band\b", rec.get("prof_saving_throws") or "")) if i is not None],
        "armor": _plain(rec.get("prof_armor")), "weapons": _plain(rec.get("prof_weapons")), "tools": _plain(rec.get("prof_tools")),
        "skills": _class_skills(rec.get("prof_skills") or ""),
        "spellAbility": next((i for i, a in enumerate(ABILITY_NAMES) if a.startswith((rec.get("spellcasting_ability") or "?").strip().lower()[:3])), 6),
        "caster": CASTER.get(slug, ""), "levels": levels, "featureText": text,
        "subclass": {"label": label, "level": sub_level, "options": sorted(({"slug": a.get("slug", ""), "name": a.get("name", ""), "source": a.get("document__title", "")} for a in rec.get("archetypes", [])),
                                                           key=lambda o: (o["source"] != "5e Core Rules", o["name"]))},   # the core rules' own first
        "asiLevels": [lv["level"] for lv in levels if any("ability score improvement" in f.lower() for f in lv["features"])],
        "equipment": rec.get("equipment", ""), "prerequisites": PREREQUISITES.get(slug, []), "wealth": WEALTH.get(slug, "4d4x10"),
    }


def _class_skills(text):
    """"Choose two from History, Insight, ..." / "Choose any three" -> {count, options [skill index]}"""
    for sk in SKILLS:   # (Open5e has typos such as "Animal, Handling")
        if " " in sk:
            text = re.sub(r",?\s+".join(map(re.escape, sk.split())), sk, text, flags=re.I)
    m = re.search(r"choose\s+(?:any\s+)?(\w+)", text, re.I)
    count = NUMBER_WORDS.get(m.group(1).lower(), 2) if m else 2
    if re.search(r"choose any", text, re.I):
        return {"count": count, "options": list(range(len(SKILLS)))}
    opts = [i for i in (_skill_index(s) for s in re.split(r",|\band\b|\bor\b", re.sub(r"(?i)^.*?\bfrom\b", "", text))) if i is not None]
    return {"count": count, "options": opts or list(range(len(SKILLS)))}


def subclass_features(rec_class, slug):
    """The features of one sub-class (an archetype of the class record): [{name, level, text}], level = when the text says "At 6th level" (else the level the
    sub-class is chosen at). The first feature is the sub-class's own description."""
    arch = next((a for a in rec_class.get("archetypes", []) if a.get("slug") == slug), None)
    if not arch:
        return []
    parsed = parse_class(rec_class)
    first = parsed["subclass"]["level"]
    out = [{"name": f"{parsed['subclass']['label']}: {arch['name']}", "level": first, "text": _first_paragraph(arch.get("desc", ""))}]
    for key, (name, body) in _sections(arch.get("desc", "")).items():
        if _norm(name) == _norm(arch["name"]):
            continue
        m = re.search(r"(?:at|starting at|beginning at|by|when you reach)\s+(\d+)(?:st|nd|rd|th)\s+level", body[:400], re.I)
        out.append({"name": f"{arch['name']}: {name}", "level": max(first, int(m.group(1))) if m else first, "text": body})
    return out


def _first_paragraph(md):
    parts = [p.strip() for p in re.split(r"\n\s*\n", md or "") if p.strip() and not p.strip().startswith("#")]
    return parts[0] if parts else ""


# ============================================================================================================================ races
def parse_race(rec):
    """An Open5e race record -> {slug, name, size, speed, bonuses {ability index: n}, choices [n, n ...] (each: raise any ability not already raised by n),
    feats [{name, text}], subraces [{slug, name, bonuses, choices, feats}], source}."""
    def asi(entries):
        fixed, picks = {}, []
        for a in entries or []:
            attrs = a.get("attributes") or []
            idx = [i for i in (_ability_index(x) for x in attrs) if i is not None]
            if len(idx) == 1 and len(attrs) == 1:
                fixed[idx[0]] = fixed.get(idx[0], 0) + int(a.get("value") or 0)
            else:
                picks.append(int(a.get("value") or 0))   # "Other" / "Choice": the player picks
        return fixed, picks
    fixed, picks = asi(rec.get("asi"))
    feats = []
    for key, label in (("asi_desc", ""), ("age", ""), ("alignment", ""), ("size", ""), ("speed_desc", ""), ("languages", ""), ("vision", ""), ("traits", "")):
        feats += _bold_sections(rec.get(key, ""))
    subs = []
    for s in rec.get("subraces", []) or []:
        sf, sp = asi(s.get("asi"))
        subs.append({"slug": s.get("slug", ""), "name": s.get("name", ""), "bonuses": sf, "choices": sp,
                     "feats": [{"name": "Description", "text": _plain(s.get("desc", ""))}] + [{"name": n, "text": t} for n, t in _bold_sections(s.get("traits", ""))]})
    return {"slug": rec.get("slug", ""), "name": rec.get("name", ""), "size": rec.get("size_raw") or "Medium", "speed": int((rec.get("speed") or {}).get("walk") or 30),
            "bonuses": fixed, "choices": picks, "feats": [{"name": n, "text": t} for n, t in feats], "subraces": subs, "source": rec.get("document__title", "")}


# ============================================================================================================================ backgrounds
def parse_background(rec):
    """-> {slug, name, skills [skill index], extraSkills n, tools, languages, equipment text, feature {name, text}, desc, source}"""
    text = rec.get("skill_proficiencies") or ""
    skills = [i for i in (_skill_index(s) for s in re.split(r",|\band\b", text)) if i is not None]
    extra = 0
    m = re.search(r"(\w+)\s+(?:skills?\s+)?of\s+your\s+choice", text, re.I)
    if m and m.group(1).lower() in NUMBER_WORDS:
        extra = NUMBER_WORDS[m.group(1).lower()]
    elif re.search(r"your choice", text, re.I):
        extra = 1
    return {"slug": rec.get("slug", ""), "name": rec.get("name", ""), "skills": skills, "extraSkills": extra, "tools": _plain(rec.get("tool_proficiencies")),
            "languages": _plain(rec.get("languages")), "equipment": _plain(rec.get("equipment")),
            "feature": {"name": rec.get("feature", ""), "text": _plain(rec.get("feature_desc"))}, "desc": _first_paragraph(rec.get("desc", "")), "source": rec.get("document__title", "")}


# ============================================================================================================================ equipment
def equipment_choices(md):
    """A class's starting equipment (Markdown bullets) -> [{options: [text, ...]}] for a line with "(a) ... or (b) ...", or [{fixed: text}] for one without.
    Text such as "a light crossbow and 20 bolts" is turned into items by items_in()."""
    out = []
    for ln in (md or "").split("\n"):
        ln = ln.strip()
        if not ln.startswith(("*", "-")):
            continue
        body = re.sub(r"[*_]", "", ln.lstrip("*- ")).strip()
        marks = list(re.finditer(r"\(([a-d])\)\s*", body))
        if len(marks) >= 2:
            opts = []
            for k, mk in enumerate(marks):
                end = marks[k + 1].start() if k + 1 < len(marks) else len(body)
                opts.append(re.sub(r"[,;]?\s*(?:or)?\s*$", "", body[mk.end():end].strip()).strip().rstrip(".").strip())
            out.append({"options": [o for o in opts if o]})
        elif body:
            out.append({"fixed": body.rstrip(".")})
    return out


def items_in(text):
    """"a light crossbow and 20 bolts" -> [{"name": "light crossbow", "qty": 1}, {"name": "bolts", "qty": 20}]. Coins ("15 gp") come out as {"coin": "gp", "qty": 15}."""
    out = []
    for part in re.split(r",|;|\band\b", re.sub(r"\(.*?\)", "", text or "")):
        p = part.strip().strip(".").strip()
        if not p:
            continue
        art = lambda t: re.sub(r"(?i)^(?:a|an|the|one)\s+", "", t)
        p = art(re.sub(r"(?i)^(?:pouch|bag|purse)\s+containing\s+", "", art(p)))
        c = re.fullmatch(r"(\d[\d,]*)\s*(pp|gp|ep|sp|cp)", p, re.I)
        if c:
            out.append({"coin": c.group(2).lower(), "qty": int(c.group(1).replace(",", ""))})
            continue
        q = re.match(r"(\d+|two|three|four|five|six|ten)\s+(.+)", p, re.I)
        qty, name = (int(q.group(1)) if q.group(1).isdigit() else {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "ten": 10}[q.group(1).lower()], q.group(2)) if q else (1, p)
        out.append({"name": name.strip(), "qty": qty})
    return out


def find_gear(name, weapons, armors):
    """The weapon or armor record whose name is `name` (singular, plural and case do not matter), or None. `weapons` / `armors` are index(kind) rows."""
    n = _norm(re.sub(r"(?i)^(?:a|an|the)\s+", "", name)).rstrip("s")
    for kind, rows in (("weapon", weapons), ("armor", armors)):
        for r in rows:
            if _norm(r["name"]).rstrip("s") == n:
                return kind, r["record"]
    return None


# weaponProperty bits (see FIGHTCLUB-FORMAT.md): the same codes as party.WEAPON_PROPS
_PROP_BITS = {"ammunition": 1, "finesse": 2, "heavy": 4, "light": 8, "loading": 16, "reach": 32, "special": 64, "thrown": 128, "two-handed": 256, "versatile": 512}
_DAMAGE_CODE = {"bludgeoning": "1", "piercing": "2", "slashing": "3"}


def _gp(cost):
    m = re.match(r"\s*([\d,\.]+)\s*(pp|gp|ep|sp|cp)", cost or "")
    return round(float(m.group(1).replace(",", "")) * {"pp": 10, "gp": 1, "ep": 0.5, "sp": 0.1, "cp": 0.01}[m.group(2)], 2) if m else 0.0


def _lb(w):
    m = re.match(r"\s*([\d\.]+)", w or "")
    return float(m.group(1)) if m else 0.0


def weapon_item(rec, qty=1):
    """An Open5e weapon -> the fields of a Fight Club <item> ({tag: text}), including the property bits, both damages and the range."""
    cat = rec.get("category", "")
    ranged = "ranged" in cat.lower()
    bits, d2, rng, long_rng = 0, "", "", ""
    for p in rec.get("properties") or []:
        name = re.match(r"[a-z\-]+", p.lower())
        name = name.group(0) if name else ""
        bits |= _PROP_BITS.get(name, 0)
        v = re.search(r"\((\d+d\d+)\)", p)
        if name == "versatile" and v:
            d2 = v.group(1)
        r = re.search(r"(\d+)\s*/\s*(\d+)", p)
        if r:
            rng, long_rng = r.group(1), r.group(2)
    fields = {"name": rec["name"], "detail": f"{'simple' if 'simple' in cat.lower() else 'martial'} Weapon, {'Ranged' if ranged else 'Melee'} Weapon", "type": "6" if ranged else "5",
              "value": _gp(rec.get("cost")), "weight": _lb(rec.get("weight")), "damage1H": rec.get("damage_dice") or "", "damageType": _DAMAGE_CODE.get((rec.get("damage_type") or "").lower(), ""),
              "weaponProperty": bits, "quantity": qty}
    if d2:
        fields["damage2H"] = d2
    if rng:
        fields["weaponRange"], fields["weaponLongRange"] = rng, long_rng
    return fields


def armor_item(rec, qty=1):
    """An Open5e armor or shield -> Fight Club <item> fields."""
    cat = (rec.get("category") or "").lower()
    code = "4" if "shield" in cat or rec.get("name", "").lower() == "shield" else "1" if "light" in cat else "2" if "medium" in cat else "3"
    ac = rec.get("base_ac") or rec.get("plus_flat_mod") or 2
    fields = {"name": rec["name"], "detail": {"4": "Shield", "1": "Light Armor", "2": "Medium Armor", "3": "Heavy Armor"}[code], "type": code, "ac": int(ac),
              "value": _gp(rec.get("cost")), "weight": _lb(rec.get("weight")) or {"4": 6.0, "1": 10.0, "2": 20.0, "3": 45.0}[code], "quantity": qty}
    if rec.get("strength_requirement"):
        fields["strength"] = int(rec["strength_requirement"])
    if rec.get("stealth_disadvantage"):
        fields["stealth"] = 1
    return fields
