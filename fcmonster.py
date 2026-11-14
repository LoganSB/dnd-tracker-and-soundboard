"""fcmonster.py - Fight Club's <monster> (a character's companion) and class <tracker> elements: read them, make them, change their numbers.

WHY A MODULE OF ITS OWN
party.py is about a character as a whole; a companion is a small creature record with its own rules (size codes, a recharge menu, attack types,
an environment bit mask ...). This file knows those and nothing else: plain functions on ElementTree elements, no Flask, no files, so they can be
tested on their own. party.py calls them.

WHAT A <monster> HOLDS (worked out from real files, see FIGHTCLUB-FORMAT.md; the codes marked * were explained by the file's owner)
  label, name, size, type, alignment, abilities (six scores), hd (hit dice, "13d12+52"), hpMax, hpCurrent, armor (AC), speed (feet), cr,
  savingThrow (ability, modifier), skill (id, modifier), vulnerable, resist, immune, conditionImmune, senses, languages, text, environment,
  and the sections trait / action / reaction / legendary: each name, text, recharge, charges and any number of attacks (name, type,
  attackBonus, damage, damageType).
  size             0 Tiny, 1 Small, 2 Medium, 3 Large, 4 Huge, 5 Gargantuan        (4 and 5 confirmed; 2 and 3 follow in order)
  recharge *       0 none, 1 "#/day" (then `charges` says how many), 2-5 "Recharge N-6", 6 "Recharge 6", 7 after a short rest, 8 after a long rest
  attack type *    1 melee, 2 ranged, 3 magic
  speed *          feet
  environment *    a bit mask: Arctic 1, Forest 2, Mountain 4, Underwater 8, Coastal 16, Grassland 32, Swamp 64, Urban 128, Desert 256, Hill 512,
                   Underdark 1024 (all eleven = 2047)
  savingThrow      ability 0-5 = STR..CHA;  skill id 0-17 = the skills in alphabetical order (as charcalc.SKILLS)
  damage           dice such as "1d20"; Fight Club also writes "1n55" for ONE die of 55 sides (shown as 1d55); formulas with % are shown as written
  attackBonus      a number or a Fight Club formula ("%3+%4+%2": not decoded, shown as written)
  Fight Club leaves out what it can look up: a companion picked from its own monster list has only label, name, size, type, abilities and hd; the
  hit points and AC appear (hpMax, hpCurrent, armor) once somebody sets them.

CLASS TRACKERS: a <class> can hold <tracker> (label, type, resetType, value = left now, formula = the most) and each <autolevel> a <tracker> giving the
  `formula` from that level on (Channel Divinity: 1, then 2 at level 6, then 3 at level 18). resetType 1 is read as "comes back on a short rest"
  (UNCONFIRMED: it is the only value seen); every tracker comes back on a long rest.
"""
import re
import xml.etree.ElementTree as ET

ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]
SIZE_NAMES = ["Tiny", "Small", "Medium", "Large", "Huge", "Gargantuan"]
SIZE_CODE = {n.lower(): i for i, n in enumerate(SIZE_NAMES)}
ATTACK_TYPES = {1: "Melee", 2: "Ranged", 3: "Magic"}
ENVIRONMENTS = ["Arctic", "Forest", "Mountain", "Underwater", "Coastal", "Grassland", "Swamp", "Urban", "Desert", "Hill", "Underdark"]
SKILLS = ["Acrobatics", "Animal Handling", "Arcana", "Athletics", "Deception", "History", "Insight", "Intimidation", "Investigation", "Medicine",
          "Nature", "Perception", "Performance", "Persuasion", "Religion", "Sleight of Hand", "Stealth", "Survival"]
SECTIONS = [("trait", "Traits"), ("action", "Actions"), ("reaction", "Reactions"), ("legendary", "Legendary actions")]
SHORT_REST_RESET = 1   # a class tracker's resetType read as "short rest" (unconfirmed)


def _t(e, tag, default=""):
    v = e.findtext(tag)
    return v.strip() if v and v.strip() else default


def _int(s, default=None):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return default


def _mod(score):
    return (score - 10) // 2


def recharge_text(code, charges=""):
    """The words for a recharge code: "3/day", "Recharge 5-6", "Recharges after a short rest" ... ("" for none or an unknown code)."""
    c = _int(code, 0)
    if c == 1:
        return f"{_int(charges, 1)}/day"
    if 2 <= c <= 5:
        return f"Recharge {c}-6"
    return {6: "Recharge 6", 7: "Recharges after a short rest", 8: "Recharges after a long rest"}.get(c, "")


def dice(text):
    """Fight Club's "1n55" (one die of 55 sides) as "1d55"; anything else, including % formulas, is returned as written."""
    return re.sub(r"(\d+)n(\d+)", r"\1d\2", text or "")


def _section(e):
    attacks = [{"name": _t(a, "name"), "type": ATTACK_TYPES.get(_int(_t(a, "type")), ""), "bonus": _t(a, "attackBonus"), "damage": dice(_t(a, "damage")),
                "damageType": _t(a, "damageType")} for a in e.findall("attack")]
    return {"name": _t(e, "name"), "text": _t(e, "text"), "recharge": recharge_text(_t(e, "recharge"), _t(e, "charges")), "attacks": attacks}


def parse(i, m):
    """One <monster> as a dict for the page. `i` is its position among the character's monsters (how the page names it)."""
    scores = ([_int(x, 10) for x in re.findall(r"-?\d+", _t(m, "abilities"))] + [10] * 6)[:6]
    size = _int(_t(m, "size"))
    env = _int(_t(m, "environment"), 0)
    return {
        "i": i, "name": _t(m, "name"), "label": _t(m, "label"), "kind": _t(m, "type") or _t(m, "label"),
        "size": SIZE_NAMES[size] if size is not None and 0 <= size < len(SIZE_NAMES) else "", "alignment": _t(m, "alignment"),
        "abilities": scores, "mods": [_mod(v) for v in scores], "hd": _t(m, "hd"),
        "hp": _int(_t(m, "hpCurrent")), "hpMax": _int(_t(m, "hpMax")), "ac": _int(_t(m, "armor")), "speed": _int(_t(m, "speed")), "cr": _t(m, "cr"),
        "saves": [{"ability": ABILITIES[a], "mod": _int(_t(s, "modifier"), 0)} for s in m.findall("savingThrow") if 0 <= (a := _int(_t(s, "ability"), -1)) < 6],
        "skills": [{"name": SKILLS[k], "mod": _int(_t(s, "modifier"), 0)} for s in m.findall("skill") if 0 <= (k := _int(_t(s, "id"), -1)) < len(SKILLS)],
        "vulnerable": _t(m, "vulnerable"), "resist": _t(m, "resist"), "immune": _t(m, "immune"), "conditionImmune": _t(m, "conditionImmune"),
        "senses": _t(m, "senses"), "languages": _t(m, "languages"), "text": _t(m, "text"),
        "environment": [n for b, n in enumerate(ENVIRONMENTS) if env & (1 << b)],
        "sections": [{"title": title, "items": [_section(x) for x in m.findall(tag)]} for tag, title in SECTIONS if m.findall(tag)],
    }


def row(i, m):
    """The short record of a companion for the character summary: where it is in the file, its name and kind, its hit points and AC."""
    p = parse(i, m)
    return {k: p[k] for k in ("i", "name", "kind", "hp", "hpMax", "ac")}


def _set(m, tag, value):
    e = m.find(tag)
    if e is None:
        e = ET.SubElement(m, tag)
    e.text = str(value)


def set_vitals(m, hp=None, hp_max=None, ac=None):
    """Change a companion's hit points and/or AC. hit points never go below 0 or above the maximum (10,000 when it has none)."""
    if hp_max is not None:
        _set(m, "hpMax", max(0, min(10 ** 4, int(hp_max))))
    if hp is not None:
        top = _int(_t(m, "hpMax"), 0) or 10 ** 4
        _set(m, "hpCurrent", max(0, min(top, int(hp))))
    if ac is not None:
        _set(m, "armor", max(0, min(99, int(ac))))


def make(name, kind, size, scores, hd, hp=None, ac=None, speed=None):
    """A new <monster> as Fight Club writes a companion picked from its monster list: label and type are the monster's name, the six scores are the
    monster's own, hd is its full hit dice. Hit points, AC and speed are added too (Fight Club keeps hpMax / hpCurrent / armor / speed on the
    companion once they are set)."""
    m = ET.Element("monster")
    for tag, val in (("label", kind), ("name", name), ("size", SIZE_CODE.get((size or "").lower(), 2)), ("type", kind),
                     ("abilities", "".join(f"{v}," for v in (list(scores) + [10] * 6)[:6]))):
        _set(m, tag, val)
    if hp is not None:
        _set(m, "hpMax", max(0, int(hp)))
        _set(m, "hpCurrent", max(0, int(hp)))
    _set(m, "hd", hd or "")
    if ac is not None:
        _set(m, "armor", max(0, int(ac)))
    if speed:
        _set(m, "speed", int(speed))
    return m


def class_trackers(root):
    """Every class tracker of a character: [{label, cur, max, reset, cls}]. `max` is None when the formula is not a plain number."""
    out = []
    for c in root.findall("class"):
        level = _int(_t(c, "level"), 1)
        for t in c.findall("tracker"):
            label, formula, best = _t(t, "label"), _t(t, "formula"), 0
            for al in c.findall("autolevel"):   # the formula of the highest autolevel at or below the class level wins
                lvl = _int(_t(al, "level"), 0)
                for x in al.findall("tracker"):
                    if _t(x, "label") == label and best <= lvl <= level:
                        best, formula = lvl, _t(x, "formula")
            out.append({"label": label, "cur": _int(_t(t, "value"), 0), "max": _int(formula), "reset": _int(_t(t, "resetType"), 0), "cls": _t(c, "name")})
    return out


def set_class_tracker(root, label, cur):
    """Set the left-now value of the class tracker called `label` (0 up to its maximum when that is known)."""
    for c in root.findall("class"):
        for t in c.findall("tracker"):
            if _t(t, "label") == label:
                top = next((x["max"] for x in class_trackers(root) if x["label"] == label and x["cls"] == _t(c, "name")), None)
                _set(t, "value", max(0, min(top if top is not None else 10 ** 4, int(cur))))
                return True
    return False
