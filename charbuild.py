"""charbuild.py - making a new Fight Club character, and levelling one up, as changes to the character's XML.

The rules data (a class's level table and features, a race, a background) comes from rules5e.py already parsed into plain dicts; this file turns choices into
the XML Fight Club reads. It is plain functions on ElementTree elements and dicts: no Flask, no files, no network, so it is tested on its own. creation.py is the
web side (the routes, who may do what, fetching the rule book data).

ONE WAY TO MAKE A LEVEL. Creating a character at level 5 = a level-1 character, then `apply_level` four times; levelling up later is `apply_level` once. So the two
can never disagree about hit points, slots, features or ability score improvements.

WHAT A CHARACTER'S <class> HOLDS (FIGHTCLUB-FORMAT.md, from real files): name, level, hdCurrent, hd (code 1-4 = d6-d12), wealth, slots and slotsCurrent (ten numbers:
position 0 the cantrips known, 1-9 the slots), proficiency codes (saves 0-5, skills 100+), numClassSkills, armor, weapons, tools, the FEATURES EARNED (feat), one mod per
point of ability score improvement, the class's whole level table (autolevel: slots, feats, scoreImprovement; level 1 has no <level> tag), spellAbility (0-5, 6 = none) and the
spells. The <race> holds mods for its ability bonuses; the character holds feats taken in place of an ability score improvement.

RULES FOLLOWED (PHB): hit points = the die at level 1 (its maximum) and then the average (die / 2 + 1) or a roll, plus the Constitution modifier each level, at least 1 a level;
if the Constitution modifier rises the maximum rises by 1 for every level so far; an ability score improvement is +2 to one score or +1 to two, never past 20, or a feat; the
proficiency bonus follows the total level (charcalc); multiclassing needs 13 in the ability each of the classes involved requires (rules5e.PREREQUISITES), and the
spell slots of a character with several casting classes come from the multiclass spellcaster table (rules5e.MULTI_SLOTS), with Warlock's Pact Magic added on top.
NOT DONE: the few proficiencies a multiclass gives, third-caster sub-classes (Eldritch Knight, Arcane Trickster), choosing spells for the player.
"""
import re
import xml.etree.ElementTree as ET

import fcedit
import rules5e as R
from fcedit import put, _t, _num

SCHOOL_CODE = {"abjuration": "1", "conjuration": "2", "divination": "3", "enchantment": "4", "evocation": "5", "illusion": "6", "necromancy": "7", "transmutation": "8"}
VERSION = "37"


def con_mod(score):
    return (score - 10) // 2


def total_level(root):
    return sum(int(_num(_t(c, "level"), 0)) for c in root.findall("class"))


def abilities(root):
    """-> (base scores, shown scores) of a character element (fcedit.ability_scores)."""
    base, shown, _ = fcedit.ability_scores(root, None)
    return base, shown


def _add(parent, tag, text=None):
    e = ET.SubElement(parent, tag)
    if text is not None:
        e.text = str(text)
    return e


def _feat(parent, name, text, optional=False):
    f = _add(parent, "feat")
    _add(f, "name", name)
    _add(f, "text", text or "")
    if optional:
        _add(f, "optional", "1")
    _add(f, "expanded", "0")
    return f


def _mod(parent, ability, value, name=None):
    m = _add(parent, "mod")
    if name:
        _add(m, "name", name)
    _add(m, "category", "1")
    if ability:   # STR (0) has no <type>, as in Fight Club's own files
        _add(m, "type", ability)
    _add(m, "value", value)
    return m


# ============================================================================================================================ the class element
def class_element(cls, level=1, first=True):
    """A new <class> for the parsed class `cls` (rules5e.parse_class), at `level` (always built at 1; apply_level raises it). `first` = the character's first class
    (it brings the saving throw and skill proficiencies; a multiclass level brings none, and no starting wealth)."""
    c = ET.Element("class")
    _add(c, "name", cls["name"])
    _add(c, "level", level)
    _add(c, "hdCurrent", level)
    _add(c, "hd", R.HIT_DIE_CODE.get(cls["hd"], 2))
    if first:
        _add(c, "wealth", cls["wealth"])
    for tag in ("slots", "slotsCurrent"):
        _add(c, tag, "0," * 10)
    if first:
        for s in cls["saves"]:
            _add(c, "proficiency", s)
        _add(c, "numClassSkills", cls["skills"]["count"])
        _add(c, "armor", cls["armor"].lower())
        _add(c, "weapons", cls["weapons"].lower())
        _add(c, "tools", (cls["tools"] or "none").lower())
    for lv in cls["levels"]:   # the whole table, as Fight Club keeps it: what each level brings (its own app levels a character from this)
        al = _add(c, "autolevel")
        if lv["level"] > 1:
            _add(al, "level", lv["level"])
        _add(al, "slots", "".join(f"{v}," for v in [lv["cantrips"]] + _slots_at(lv)))
        if lv["level"] in cls["asiLevels"]:
            _add(al, "scoreImprovement", 1)
        for name in lv["features"]:
            _feat(al, name, cls["featureText"].get(name, ""))
    _add(c, "spellAbility", cls["spellAbility"])
    return c


def _slots_at(lv):
    """The nine slot numbers of a class at one level: ordinary slots, or Pact Magic's slots at its slot level."""
    if lv.get("pact"):
        out = [0] * 9
        if 1 <= lv["pact"]["level"] <= 9:
            out[lv["pact"]["level"] - 1] = lv["pact"]["slots"]
        return out
    return list(lv["slots"])


def _row(cls, level):
    return next((lv for lv in cls["levels"] if lv["level"] == level), None)


# ============================================================================================================================ slots
def recompute_slots(root, rules):
    """Set <slots> from the classes and their levels (`rules` = {class name: parsed class}). One casting class: its own table. Several: the multiclass spellcaster table
    for the combined level, plus Pact Magic's slots. The cantrip count (position 0) is the cantrips each class knows, added. Spent slots are kept: slotsCurrent
    goes up by what the maximum went up by (a level-up does not refill them) and never above the new maximum."""
    old_max, old_cur = fcedit.slot_list(root, "slots"), fcedit.slot_list(root, "slotsCurrent")
    full = half = 0
    pact = [0] * 9
    cantrips, casting = 0, []
    for c in root.findall("class"):
        cls = rules.get(_t(c, "name"))
        lvl = int(_num(_t(c, "level"), 1))
        row = _row(cls, lvl) if cls else None
        if not cls or not row:
            continue
        cantrips += row["cantrips"]
        if cls["caster"] == "full":
            full += lvl
        elif cls["caster"] == "half":
            half += lvl // 2
        elif cls["caster"] == "pact" and row.get("pact"):
            pact[row["pact"]["level"] - 1] += row["pact"]["slots"]
        if cls["caster"]:
            casting.append((cls, row))
        # the class's own slots (what Fight Club shows on the class)
        own = "".join(f"{v}," for v in [row["cantrips"]] + _slots_at(row))
        put(c, "slots", own)
        put(c, "slotsCurrent", own)
    ordinary = [0] * 9
    n_casting = sum(1 for cls, _ in casting if cls["caster"] in ("full", "half"))
    if n_casting == 1:   # one ordinary casting class: its own table (a lone Paladin or Ranger is a half-caster by that table, not rounded down)
        cls, row = next((cls, row) for cls, row in casting if cls["caster"] in ("full", "half"))
        ordinary = list(row["slots"])
    elif n_casting > 1:
        level = full + half
        ordinary = (R.MULTI_SLOTS[min(level, 20) - 1] + [0] * 9)[:9] if level >= 1 else [0] * 9
    new = [cantrips] + [ordinary[i] + pact[i] for i in range(9)]
    cur = [new[0]] + [min(new[i], max(0, old_cur[i] + max(0, new[i] - old_max[i]))) for i in range(1, 10)]
    put(root, "slots", "".join(f"{v}," for v in new))
    put(root, "slotsCurrent", "".join(f"{v}," for v in cur))


# ============================================================================================================================ one level
def hit_points_for_level(hd, con, level, roll=None):
    """The hit points one level adds: the maximum of the die at character level 1, else the roll (when given: 1..hd) or the average (hd / 2 + 1), plus the
    Constitution modifier, never below 1."""
    if level == 1:
        return hd + con
    base = hd // 2 + 1 if roll is None else max(1, min(hd, int(roll)))
    return max(1, base + con)


def asi_levels_used(root, cls_name, asi_levels):
    """How many of a class's ability score improvement levels the character has already reached."""
    c = next((c for c in root.findall("class") if _t(c, "name") == cls_name), None)
    lvl = int(_num(_t(c, "level"), 0)) if c is not None else 0
    return len([x for x in asi_levels if x <= lvl])


def validate_asi(root, decision):
    """Check an ability score improvement decision {type: "asi", inc: [ability index, ...]} (one index twice = +2; two indexes = +1 each) or {type: "feat", feat: {name, text,
    ability?}}. Returns the decision; ValueError when it breaks the rules."""
    if not isinstance(decision, dict):
        raise ValueError("Choose an ability score improvement or a feat")
    if decision.get("type") == "feat":
        feat = decision.get("feat") or {}
        if not str(feat.get("name") or "").strip():
            raise ValueError("Name the feat")
        return decision
    inc = decision.get("inc")
    if decision.get("type") != "asi" or not isinstance(inc, list) or len(inc) != 2 or any(not isinstance(i, int) or not 0 <= i < 6 for i in inc):
        raise ValueError("An ability score improvement is +2 to one score or +1 to two")
    _, shown = abilities(root)
    for i in set(inc):
        if shown[i] + inc.count(i) > 20:
            raise ValueError(f"{R.ABILITIES[i]} cannot go above 20")
    return decision


def apply_level(root, cls, rules, *, roll=None, asi=None, subclass_feats=()):
    """Raise the character one level in the parsed class `cls` (rules5e.parse_class). A class the character does not have yet is added at level 1 (multiclassing).
    `rules` = {class name: parsed class} for every class the character has (for the slots). roll = the die rolled for hit points (None = the average);
    asi = a validated decision for this level's ability score improvement (or None); subclass_feats = [{name, text}] to add (the sub-class chosen now, or what it brings
    at this level). Returns {level, classLevel, hpGain, features [names]} for the page to report."""
    classes = root.findall("class")
    c = next((c for c in classes if _t(c, "name") == cls["name"]), None)
    new_total = total_level(root) + 1
    if new_total > 20:
        raise ValueError("A character cannot go past level 20")
    first_ever = not classes
    if c is None:
        c = class_element(cls, 0, first=first_ever)
        # new classes go after the existing classes (before the character's feats and items, where Fight Club keeps them)
        fcedit.append_after(root, c, ("class",), ("container", "feat", "item", "note", "monster", "slots", "slotsCurrent", "money"))
        put(c, "level", 0)
        put(c, "hdCurrent", 0)
    level = int(_num(_t(c, "level"), 0)) + 1
    put(c, "level", level)
    put(c, "hdCurrent", int(_num(_t(c, "hdCurrent"), 0)) + 1)
    _, before = abilities(root)
    if asi is not None:   # applied first so that a rise in Constitution counts for this level's hit points too
        _apply_asi(root, c, asi)
    _, shown = abilities(root)
    gain = hit_points_for_level(cls["hd"], con_mod(shown[2]), new_total, roll)
    # if the Constitution modifier went up, every earlier level gains the difference
    gain += max(0, con_mod(shown[2]) - con_mod(before[2])) * (new_total - 1)
    put(root, "hpMax", int(_num(_t(root, "hpMax"))) + gain)
    put(root, "hpCurrent", int(_num(_t(root, "hpCurrent"))) + gain)
    row = _row(cls, level)
    names = []
    for name in (row["features"] if row else []):
        if _t_feat(c, name):
            continue
        _feat(c, name, cls["featureText"].get(name, ""))
        names.append(name)
    for f in subclass_feats:
        if not _t_feat(c, f["name"]):
            _feat(c, f["name"], f.get("text", ""))
            names.append(f["name"])
    all_rules = dict(rules)
    all_rules[cls["name"]] = cls
    _keep_order(c)
    recompute_slots(root, all_rules)
    xp = int(_num(_t(root, "xp"), 0))
    put(root, "xp", max(xp, R.XP_FOR_LEVEL[new_total - 1]))
    return {"level": new_total, "classLevel": level, "hpGain": gain, "features": names}


def _t_feat(parent, name):
    return next((f for f in parent.findall("feat") if _t(f, "name") == name), None)


def _apply_asi(root, c, decision):
    """Write an ability score improvement: mods on the class (+1 each, as Fight Club writes them), or a feat on the character (after its other feats)."""
    if decision["type"] == "feat":
        feat = decision["feat"]
        tmp = ET.Element("tmp")
        f = _feat(tmp, str(feat["name"]).strip()[:80], str(feat.get("text") or "")[:6000])
        _, shown = abilities(root)
        ab = feat.get("ability")   # a feat that raises an ability (Resilient, Actor ...): the one point is a mod of the feat, as Fight Club writes it
        if isinstance(ab, int) and 0 <= ab < 6 and shown[ab] < 20:
            _mod(f, ab, 1)
        fcedit.append_after(root, f, ("feat",), ("item", "note", "monster", "slots", "slotsCurrent", "money"))
        return
    for i in decision["inc"]:
        _mod(c, i, 1, "Ability Score Improvement")
    _reorder_mods(c)


def _reorder_mods(c):
    """Fight Club's class order: ... feats, mods, autolevels ... Put the mods right before the first autolevel."""
    mods = c.findall("mod")
    for m in mods:
        c.remove(m)
    kids = list(c)
    at = next((i for i, k in enumerate(kids) if k.tag == "autolevel"), len(kids))
    for n, m in enumerate(mods):
        c.insert(at + n, m)


def _keep_order(c):
    """Fight Club's class order: the earned feats stay together, before the mods and the autolevels."""
    feats = c.findall("feat")
    for f in feats:
        c.remove(f)
    kids = list(c)
    at = next((i for i, k in enumerate(kids) if k.tag in ("mod", "autolevel")), len(kids))
    for n, f in enumerate(feats):
        c.insert(at + n, f)


# ============================================================================================================================ what a level-up offers
def plan_next_level(root, cls, rules, sub=None):
    """What taking the next level in the parsed class `cls` involves, for the level-up page: {newTotal, classLevel, hd, hpAverage, features [{name, text}], asi (bool: this
    level has an ability score improvement), subclassNow (bool: the sub-class is chosen at this level and none is yet), newCantrips, newSpells, slots [9] after}."""
    cur = next((c for c in root.findall("class") if _t(c, "name") == cls["name"]), None)
    level = int(_num(_t(cur, "level"), 0)) + 1 if cur is not None else 1
    row = _row(cls, level)
    if row is None:
        raise ValueError(f"{cls['name']} has no level {level}")
    prev = _row(cls, level - 1) or {"cantrips": 0, "spellsKnown": 0}
    _, shown = abilities(root)
    new_total = total_level(root) + 1
    feats = [{"name": n, "text": cls["featureText"].get(n, "")} for n in row["features"]]
    has_sub = cur is not None and any(_t(f, "name").startswith(cls["subclass"]["label"] + ":") for f in cur.findall("feat"))
    return {"newTotal": new_total, "classLevel": level, "hd": cls["hd"], "hpAverage": hit_points_for_level(cls["hd"], con_mod(shown[2]), new_total),
            "conMod": con_mod(shown[2]), "features": feats, "asi": level in cls["asiLevels"],
            "subclassNow": level == cls["subclass"]["level"] and not has_sub and bool(cls["subclass"]["options"]),
            "newCantrips": max(0, row["cantrips"] - prev["cantrips"]), "newSpells": max(0, row["spellsKnown"] - prev["spellsKnown"]),
            "slots": _slots_at(row), "extra": row["extra"]}


def multiclass_problems(root, new_cls, rules):
    """Why the character may not take a first level in `new_cls`: a list of messages (empty = allowed). PHB: you need 13 in the key ability of your CURRENT class(es) and of
    the new one (some need either of two; Monk, Paladin and Ranger need both)."""
    _, shown = abilities(root)
    out = []
    need = lambda cls: all(any(shown[i] >= 13 for i in group) for group in cls["prerequisites"])
    text = lambda cls: " and ".join(" or ".join(R.ABILITIES[i] for i in g) for g in cls["prerequisites"]) + " 13"
    for c in root.findall("class"):
        cls = rules.get(_t(c, "name"))
        if cls and not need(cls):
            out.append(f"{cls['name']} requires {text(cls)}")
    if not need(new_cls):
        out.append(f"{new_cls['name']} requires {text(new_cls)}")
    return out


def spell_allowance(cls, level, shown):
    """How many spells a class gives at `level`: {cantrips, spells, kind} where kind is "known" (the table lists spells known), "spellbook" (Wizard: six, two more a level; prepares
    its Intelligence modifier + level) or "prepared" (Cleric, Druid: its ability modifier + level; Paladin: half level) from the whole class list."""
    row = _row(cls, level) or {"cantrips": 0, "spellsKnown": 0}
    ab = cls["spellAbility"]
    mod = con_mod(shown[ab]) if ab < 6 else 0
    if cls["caster"] == "":
        return {"cantrips": 0, "spells": 0, "kind": ""}
    if row["spellsKnown"]:
        return {"cantrips": row["cantrips"], "spells": row["spellsKnown"], "kind": "known"}
    if cls["slug"] == "wizard":
        return {"cantrips": row["cantrips"], "spells": 6 + 2 * (level - 1), "kind": "spellbook"}
    n = max(1, mod + (level // 2 if cls["caster"] == "half" else level))
    return {"cantrips": row["cantrips"], "spells": n, "kind": "prepared"}


# ============================================================================================================================ a new character
def item_element(fields, slot=None):
    """A Fight Club <item> from a field dict (rules5e.weapon_item / armor_item, or {name, detail, text, quantity ...} for plain gear)."""
    it = ET.Element("item")
    order = ("name", "detail", "text", "type", "slot", "quantity", "value", "weight", "ac", "strength", "stealth", "damage1H", "damage2H", "damageType", "weaponProperty",
             "weaponRange", "weaponLongRange")
    f = dict(fields)
    if slot:
        f["slot"] = slot
    for k in order:
        v = f.get(k)
        if v in (None, ""):
            continue
        if k == "quantity" and int(v) == 1:
            continue
        put(it, k, v)
    return it


def spell_element(f, class_name):
    """A <spell> from an Open5e spell record `f` (the same fields the sheet's Add spell reads)."""
    sp = ET.Element("spell")
    _add(sp, "name", (f.get("name") or "").strip()[:80])
    _add(sp, "school", SCHOOL_CODE.get((f.get("school") or "").lower(), ""))
    level = int(f.get("level_int") or 0)
    _add(sp, "level", level)
    _add(sp, "time", (f.get("casting_time") or "")[:60])
    _add(sp, "range", (f.get("range") or "")[:60])
    comps = (f.get("components") or "").upper()
    for tag, letter in (("v", "V"), ("s", "S"), ("m", "M")):
        if re.search(rf"\b{letter}\b", comps):
            _add(sp, tag, "1")
    _add(sp, "materials", (f.get("material") or "")[:300])
    _add(sp, "duration", (f.get("duration") or "")[:60])
    text = re.sub(r"\*\*", "", f.get("desc") or "") + (f"\n\nAt higher levels. {f['higher_level']}" if f.get("higher_level") else "")
    _add(sp, "text", text[:6000])
    _add(sp, "prepared", "1" if level == 0 else "0")   # a cantrip is always ready
    _add(sp, "sclass", class_name)
    if f.get("can_be_cast_as_ritual") is True or f.get("ritual") == "yes":
        _add(sp, "ritual", "1")
    return sp


def new_character(*, uid, name, base_abilities, race, background, looks=None):
    """The empty shell of a level-0 character: name, base scores, race with its ability bonuses and traits, background with its skills. Classes are added by apply_level, items by
    the caller. `race` = {name, speed, size, feats [{name, text}], mods [(ability index, amount)]}; `background` = {name, skills [skill index], feats [{name, text}]}."""
    ch = ET.Element("character")
    _add(ch, "version", VERSION)
    _add(ch, "uid", uid)
    _add(ch, "name", name)
    _add(ch, "abilities", "".join(f"{v}," for v in base_abilities))
    _add(ch, "hpMax", 0)
    _add(ch, "hpCurrent", 0)
    _add(ch, "xp", 0)
    _add(ch, "unarmed", "1")
    r = _add(ch, "race")
    _add(r, "name", race["name"])
    _add(r, "speed", race["speed"])
    for k in ("age", "height", "weight", "eyes", "skin", "hair"):
        _add(r, k, (looks or {}).get(k, "") or "")
    for f in race["feats"]:
        _feat(r, f["name"], f["text"])
    for ab, amount in race["mods"]:
        _mod(r, ab, amount)
    _add(r, "spellAbility", 6)
    b = _add(ch, "background")
    _add(b, "name", background["name"])
    for s in background["skills"]:
        _add(b, "proficiency", 100 + s)
    for f in background["feats"]:
        _feat(b, f["name"], f["text"])
    _add(ch, "slots", "0," * 10)
    _add(ch, "slotsCurrent", "0," * 10)
    return ch


def add_class_skills(root, cls_name, skill_indexes):
    """The class's chosen skill proficiencies go after its saving throw ones."""
    c = next(c for c in root.findall("class") if _t(c, "name") == cls_name)
    last = max((i for i, k in enumerate(c) if k.tag == "proficiency"), default=None)
    for n, s in enumerate(skill_indexes):
        e = ET.Element("proficiency")
        e.text = str(100 + s)
        c.insert((last if last is not None else 4) + 1 + n, e)
