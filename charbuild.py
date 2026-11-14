"""charbuild.py - making a new Fight Club character, and levelling one up, as changes to the character's XML, the way Fight Club itself does it.

The rule book is Fight Club's own compendium (codex.py): a race, class, background, feat, spell or item is COPIED from it into the character, never rebuilt from text. This
file is plain functions on ElementTree elements and dicts: no Flask, no files, no network, so it is tested on its own. creation.py is the web side.

ONE WAY TO MAKE A LEVEL. Creating a character at level 5 = a level-1 character, then `apply_level` four times; levelling up later is `apply_level` once. So the two cannot disagree about hit
points, slots, features or ability score improvements.

WHAT A LEVEL ADDS TO THE CLASS (FightClub5_with_level_1_cleric.backup, the character "Name" Fight Club made, and the leveled sample characters): the class's own <feat> list holds the
features EARNED, copied from the class's level table (autolevel): every feature of that level that is not optional; "Starting <Class>" at level 1 for the first class ("Multiclass <Class>" for
another one); each choice made (the sub-class "Divine Domain: Life Domain", a fighting style, a pact boon ...) and, as their levels come, that choice's own features ("Life Domain: Divine
Strike"). An ability score improvement is a <mod> (+1) on the class per point, or a feat on the character. `level` and `hdCurrent` are not written for a first class at level 1.

RULES FOLLOWED (PHB): hit points = the die at character level 1 (its maximum) and then the average (die / 2 + 1) or a roll, plus the Constitution modifier each level, at least 1 a level;
if the Constitution modifier rises the maximum rises by 1 for every level so far; an ability score improvement is +2 to one score or +1 to two, never past 20, or a feat; multiclassing needs
13 in the key ability of each class involved (codex.PREREQUISITES); slots of a character with several casting classes come from the multiclass spellcaster table (codex.MULTI_SLOTS), with
Warlock's Pact Magic added on top. NOT DONE: the few proficiencies a multiclass gives, third-caster sub-classes (Eldritch Knight, Arcane Trickster), what a feat does beyond its own <mod>.
"""
import copy
import xml.etree.ElementTree as ET

import codex as C
import fcedit
from fcedit import put, _t, _num

VERSION = "37"
strip_empty = fcedit.strip_empty


def con_mod(score):
    return (score - 10) // 2


class_level = fcedit.class_level


def total_level(root):
    return sum(class_level(c) for c in root.findall("class"))


def abilities(root):
    """-> (base scores, shown scores) of a character element (fcedit.ability_scores)."""
    base, shown, _ = fcedit.ability_scores(root, None)
    return base, shown


def _add(parent, tag, text=None):
    e = ET.SubElement(parent, tag)
    if text is not None:
        e.text = str(text)
    return e


def _mod(parent, ability, value, name=None):
    m = _add(parent, "mod")
    if name:
        _add(m, "name", name)
    _add(m, "category", "1")
    if ability:   # STR (0) has no <type>, as in Fight Club's own files
        _add(m, "type", ability)
    _add(m, "value", value)
    return m


# ============================================================================================================================ the pieces of a new character
def new_character(*, uid, name, base_abilities, race_el, background_el, looks=None):
    """The shell: name, base scores, a COPY of the codex race (with the looks the player gave, after its name) and background, no class yet, no hit points yet."""
    ch = ET.Element("character")
    _add(ch, "version", VERSION)
    _add(ch, "uid", uid)
    _add(ch, "name", name)
    _add(ch, "abilities", "".join(f"{v}," for v in base_abilities))
    _add(ch, "hpMax", 0)
    _add(ch, "hpCurrent", 0)
    _add(ch, "unarmed", "1")
    race = copy.deepcopy(race_el)
    at = max((i for i, k in enumerate(race) if k.tag in ("name", "size", "speed")), default=0)
    given = [t for t in ("age", "height", "weight", "eyes", "skin", "hair") if str((looks or {}).get(t) or "").strip()]
    for n, k in enumerate(given):
        e = ET.Element(k)
        e.text = str(looks[k]).strip()[:40]
        race.insert(at + 1 + n, e)
    mods = sorted(race.findall("mod"), key=lambda m: int(_num(_t(m, "type"), 0)))   # Fight Club writes a character's race modifiers in ability order
    for m in race.findall("mod"):
        race.remove(m)
    at2 = max((i for i, k in enumerate(race) if k.tag == "feat"), default=len(race) - 1)
    for n, m in enumerate(mods):
        race.insert(at2 + 1 + n, m)
    ch.append(race)
    ch.append(copy.deepcopy(background_el))
    _add(ch, "slots", "0," * 10)
    _add(ch, "slotsCurrent", "0," * 10)
    _add(ch, "money", "0.0")
    strip_empty(ch)
    return ch


def class_element(cls, first):
    """A new <class> for the parsed class `cls` (codex.parse_class): a copy of the codex class as Fight Club makes it, with its saving throw proficiencies (the skills are added by
    add_class_skills), empty slots, no earned features yet, the whole level table and the spell ability. A class taken by multiclassing carries no wealth, skills or proficiencies."""
    c = copy.deepcopy(cls["el"])
    for tag in ("proficiency", "slots", "slotsCurrent", "level", "hdCurrent", "feat", "mod", "spell"):
        for e in c.findall(tag):
            c.remove(e)
    at = max((i for i, k in enumerate(c) if k.tag in ("name", "hd", "wealth")), default=0)
    new = []
    for tag in ("slots", "slotsCurrent"):
        e = ET.Element(tag)
        e.text = "0," * 10
        new.append(e)
    if first:
        for s in cls["saves"]:
            e = ET.Element("proficiency")
            e.text = str(s)
            new.append(e)
    for n, e in enumerate(new):
        c.insert(at + 1 + n, e)
    if not first:
        for tag in ("wealth", "numClassSkills", "armor", "weapons", "tools"):
            for e in c.findall(tag):
                c.remove(e)
    strip_empty(c)
    return c


def add_class_skills(root, cls_name, skill_indexes):
    """The class's chosen skill proficiencies go after its saving throw ones."""
    c = next(c for c in root.findall("class") if _t(c, "name") == cls_name)
    last = max((i for i, k in enumerate(c) if k.tag == "proficiency"), default=None)
    for n, s in enumerate(skill_indexes):
        e = ET.Element("proficiency")
        e.text = str(100 + s)
        c.insert((last if last is not None else 4) + 1 + n, e)


def _set_level(c, level, only_class):
    """level and hdCurrent sit right after the name; a first class at level 1 has neither (as in Fight Club's files)."""
    for tag in ("level", "hdCurrent"):
        for e in c.findall(tag):
            c.remove(e)
    if level == 1 and only_class:
        return
    for n, tag in enumerate(("level", "hdCurrent")):
        e = ET.Element(tag)
        e.text = str(level)
        c.insert(1 + n, e)


def _hd_current(c):
    t = _t(c, "hdCurrent")
    return int(_num(t, class_level(c))) if t else class_level(c)


# ============================================================================================================================ features and choices
def chosen_options(c, cls):
    """The names of the options already chosen on a character's class element `c`: every option of every choice group of `cls` that is among its <feat>s."""
    have = {_t(f, "name") for f in c.findall("feat")} if c is not None else set()
    return {o["name"] for g in cls["groups"] for o in g["options"] if o["name"] in have}


def groups_at(cls, level, c=None):
    """The choices to make on reaching class level `level`: the groups of that level (for a repeated pick such as Metamagic, without the options already taken)."""
    taken = chosen_options(c, cls)
    out = []
    for g in cls["groups"]:
        if g["level"] != level:
            continue
        opts = [o for o in g["options"] if o["name"] not in taken]
        if opts:
            out.append({**g, "options": opts, "key": f"{g['level']}:{g['head']}"})
    return out


def validate_choices(cls, level, c, choices):
    """Check `choices` ({"<level>:<head>": [option names]}) against the groups at `level`; returns the flat list of chosen option names. ValueError with a message when wrong."""
    picked = []
    for g in groups_at(cls, level, c):
        got = (choices or {}).get(g["key"]) or []
        names = {o["name"] for o in g["options"]}
        if len(got) != g["picks"] or len(set(got)) != len(got) or any(n not in names for n in got):
            raise ValueError(f"Choose {g['picks']} for {g['head']}" if g["picks"] > 1 else f"Choose your {g['head'].lower()}")
        picked += got
    return picked


def _feat_copy(el):
    f = copy.deepcopy(el)
    if f.find("expanded") is None:
        _add(f, "expanded", "0")
    return f


def features_for_level(cls, level, first, c, picked):
    """The <feat> elements (copies, with the expanded flag) a class level brings: every feature of the level that is not optional; "Starting X" (first class) or "Multiclass X" at level 1;
    the options chosen now (`picked`); and the level's features of any option chosen so far ("<Option>: ...")."""
    lv = cls["levels"].get(level)
    if not lv:
        return []
    have = chosen_options(c, cls) | set(picked)
    labels = {o["label"] for g in cls["groups"] for o in g["options"] if o["name"] in have}
    out = []
    for f in lv["feats"]:
        n = f["name"]
        if not f["optional"] or (level == 1 and n == (cls["startName"] if first else cls["multiName"])) or n in picked or any(n.startswith(lab + ": ") for lab in labels):
            out.append(_feat_copy(f["el"]))
    for g in cls["groups"]:   # an option picked at a later level than the table that lists it (Metamagic at 10): its feature is the one where it is listed
        if g["level"] == level:
            for o in g["options"]:
                if o["name"] in picked and not any(_t(e, "name") == o["name"] for e in out):
                    out.append(_feat_copy(o["el"]))
    return out


# ============================================================================================================================ slots
def recompute_slots(root, rules):
    """Set <slots> from the classes and their levels (`rules` = {class name: parsed class}). One casting class: its own table. Several: the multiclass spellcaster table for the combined level,
    plus Pact Magic's slots. The cantrip count (position 0) is the cantrips each class knows, added. Spent slots are kept: slotsCurrent goes up by what the maximum went up by (a level-up does
    not refill them) and never above the new maximum."""
    old_max, old_cur = fcedit.slot_list(root, "slots"), fcedit.slot_list(root, "slotsCurrent")
    full = half = 0
    pact = [0] * 10
    cantrips, ordinary_rows = 0, []
    for c in root.findall("class"):
        cls = rules.get(_t(c, "name"))
        lvl = class_level(c)
        if not cls or lvl not in cls["levels"]:
            continue
        row = cls["levels"][lvl]["slots"]
        cantrips += row[0]
        own = "".join(f"{v}," for v in row)
        old_own = fcedit.slot_list(c, "slots")
        old_own_cur = fcedit.slot_list(c, "slotsCurrent")
        put(c, "slots", own)
        # (as the Fight Club app does on a level-up, checked against a character it levelled: the maximum rises and the slots left are as they were; a class with no slots yet starts full)
        put(c, "slotsCurrent", own if not any(old_own) else "".join(f"{min(row[i], old_own_cur[i])}," for i in range(10)))
        kind = cls["caster"]
        if kind == "full":
            full += lvl
            ordinary_rows.append(row)
        elif kind in ("half", "half-up"):
            half += (lvl + 1) // 2 if kind == "half-up" else lvl // 2
            ordinary_rows.append(row)
        elif kind == "pact":
            pact = [pact[i] + row[i] for i in range(10)]
    if len(ordinary_rows) == 1:   # one ordinary casting class: its own table
        ordinary = ordinary_rows[0][1:]
    elif len(ordinary_rows) > 1:
        level = full + half
        ordinary = (C.MULTI_SLOTS[min(level, 20) - 1] + [0] * 9)[:9] if level >= 1 else [0] * 9
    else:
        ordinary = [0] * 9
    new = [cantrips] + [ordinary[i] + pact[i + 1] for i in range(9)]
    # a level-up raises the maximum and leaves the slots left as they were, as Fight Club's own level-up does (it does not hand out the new slot at once); a character who had no slots starts full
    cur = [new[0]] + (new[1:] if not any(old_max[1:]) else [min(new[i], old_cur[i]) for i in range(1, 10)])
    put(root, "slots", "".join(f"{v}," for v in new))
    put(root, "slotsCurrent", "".join(f"{v}," for v in cur))


# ============================================================================================================================ one level
def hit_points_for_level(hd, con, level, roll=None):
    """The hit points one level adds: the maximum of the die at character level 1, else the roll (when given: 1..hd) or the average (hd / 2 + 1), plus the Constitution modifier, never below 1."""
    if level == 1:
        return hd + con
    base = hd // 2 + 1 if roll is None else max(1, min(hd, int(roll)))
    return max(1, base + con)


def validate_asi(root, decision, feats=None):
    """Check an ability score improvement decision {type: "asi", inc: [i, j]} (one index twice = +2; two = +1 each) or {type: "feat", id: codex feat index} or {type: "feat", feat: {name, text,
    ability?}} (a feat written by hand). Returns the decision; ValueError when it breaks the rules."""
    if not isinstance(decision, dict):
        raise ValueError("Choose an ability score improvement or a feat")
    if decision.get("type") == "feat":
        if decision.get("id") is not None:
            if not isinstance(decision["id"], int) or not 0 <= decision["id"] < len(feats or []):
                raise ValueError("That feat is not in the rule book")
            return decision
        if not str((decision.get("feat") or {}).get("name") or "").strip():
            raise ValueError("Name the feat")
        return decision
    inc = decision.get("inc")
    if decision.get("type") != "asi" or not isinstance(inc, list) or len(inc) != 2 or any(not isinstance(i, int) or not 0 <= i < 6 for i in inc):
        raise ValueError("An ability score improvement is +2 to one score or +1 to two")
    _, shown = abilities(root)
    for i in set(inc):
        if shown[i] + inc.count(i) > 20:
            raise ValueError(f"{C.ABILITIES[i]} cannot go above 20")
    return decision


def _apply_asi(root, c, decision, feats):
    """Write an ability score improvement: mods on the class (+1 each, as Fight Club writes them), or a feat on the character (a copy of the codex feat, or one written by hand)."""
    if decision["type"] == "feat":
        if decision.get("id") is not None:
            f = _feat_copy(feats[decision["id"]])
        else:
            x = decision["feat"]
            f = ET.Element("feat")
            _add(f, "name", str(x["name"]).strip()[:80])
            _add(f, "text", (str(x.get("text") or "").strip() or str(x["name"]).strip())[:6000])
            _add(f, "expanded", "0")
            ab = x.get("ability")
            if isinstance(ab, int) and 0 <= ab < 6:
                _mod(f, ab, 1)
        fcedit.append_after(root, f, ("feat",), ("item", "note", "monster", "slots", "slotsCurrent", "money"))
        return
    for i in decision["inc"]:
        _mod(c, i, 1, "Ability Score Improvement")


def _order_class(c):
    """Fight Club's class order: ... tools, the earned feats, the mods, the autolevels, spellAbility, spells."""
    for tag, before in (("mod", ("autolevel",)), ("feat", ("mod", "autolevel"))):
        els = c.findall(tag)
        for e in els:
            c.remove(e)
        kids = list(c)
        at = next((i for i, k in enumerate(kids) if k.tag in before), len(kids))
        for n, e in enumerate(els):
            c.insert(at + n, e)


def _set_xp(root, xp):
    """<xp> sits right after <hpCurrent> in Fight Club's files (it is absent on a new level-1 character)."""
    e = root.find("xp")
    if e is None:
        e = ET.Element("xp")
        kids = list(root)
        root.insert(next((i for i, k in enumerate(kids) if k.tag == "hpCurrent"), len(kids) - 1) + 1, e)
    e.text = str(xp)


def apply_level(root, cls, rules, *, roll=None, asi=None, choices=None, feats=None):
    """Raise the character one level in the parsed class `cls` (codex.parse_class). A class the character does not have yet is added (multiclassing). `rules` = {class name: parsed class}
    for every class the character has (for the slots). roll = the die rolled for hit points (None = the average); asi = a validated decision for this level's ability score improvement (or
    None); choices = {"<level>:<head>": [option names]} for this level's choices; `feats` = the codex's feat elements (for a feat taken from it). Returns {level, classLevel, hpGain,
    features [names]} for the page to report."""
    classes = root.findall("class")
    c = next((c for c in classes if _t(c, "name") == cls["name"]), None)
    new_total = total_level(root) + 1
    if new_total > 20:
        raise ValueError("A character cannot go past level 20")
    if c is None:
        c = class_element(cls, not classes)
        fcedit.append_after(root, c, ("class",), ("container", "feat", "item", "note", "monster", "slots", "slotsCurrent", "money"))
        level = 1
        _set_level(c, 1, not classes)
    else:
        level = class_level(c) + 1
        hd_now = _hd_current(c) + 1
        _set_level(c, level, False)
        put(c, "hdCurrent", hd_now)
    picked = validate_choices(cls, level, c, choices)
    _, before = abilities(root)
    if asi is not None:   # applied first so that a rise in Constitution counts for this level's hit points too
        _apply_asi(root, c, asi, feats)
    _, shown = abilities(root)
    gain = hit_points_for_level(cls["hd"], con_mod(shown[2]), new_total, roll)
    gain += max(0, con_mod(shown[2]) - con_mod(before[2])) * (new_total - 1)   # a higher Constitution modifier counts for every earlier level too
    put(root, "hpMax", int(_num(_t(root, "hpMax"))) + gain)
    put(root, "hpCurrent", int(_num(_t(root, "hpCurrent"))) + gain)
    names = []
    for f in features_for_level(cls, level, root.findall("class")[0] is c, c, picked):
        c.append(f)
        names.append(_t(f, "name"))
    _order_class(c)
    strip_empty(c)
    all_rules = dict(rules)
    all_rules[cls["name"]] = cls
    recompute_slots(root, all_rules)
    if new_total > 1 or _t(root, "xp"):
        _set_xp(root, max(int(_num(_t(root, "xp"), 0)), C.XP_FOR_LEVEL[new_total - 1]))
    return {"level": new_total, "classLevel": level, "hpGain": gain, "features": names}


# ============================================================================================================================ what a level-up offers
def plan_next_level(root, cls, rules):
    """What taking the next level in the parsed class `cls` involves, for the level-up page: {newTotal, classLevel, hd, hpAverage, conMod, features [{name, text}], asi, groups [the choices to
    make], newCantrips, newSpells, slots [10]}. ValueError when the class has no such level."""
    cur = next((c for c in root.findall("class") if _t(c, "name") == cls["name"]), None)
    level = class_level(cur) + 1 if cur is not None else 1
    if level not in cls["levels"]:
        raise ValueError(f"{cls['name']} has no level {level}")
    _, shown = abilities(root)
    new_total = total_level(root) + 1
    first = cur is None and not root.findall("class")
    feats = [{"name": _t(e, "name"), "text": e.findtext("text") or ""} for e in features_for_level(cls, level, first, cur, [])]
    groups = [{"key": g["key"], "head": g["head"], "picks": g["picks"], "options": [{"name": o["name"], "label": o["label"], "text": o["text"]} for o in g["options"]]}
              for g in groups_at(cls, level, cur)]
    now = C.spells_known_allowance(cls, level, shown)
    prev = C.spells_known_allowance(cls, level - 1, shown) if level > 1 else {"cantrips": 0, "spells": 0}
    return {"newTotal": new_total, "classLevel": level, "hd": cls["hd"], "hpAverage": hit_points_for_level(cls["hd"], con_mod(shown[2]), new_total), "conMod": con_mod(shown[2]),
            "features": feats, "asi": cls["levels"][level]["asi"], "groups": groups, "newCantrips": max(0, now["cantrips"] - prev["cantrips"]),
            "newSpells": max(0, now["spells"] - prev["spells"]) if now["kind"] != "prepared" else 0, "slots": cls["levels"][level]["slots"]}


def multiclass_problems(root, new_cls, rules):
    """Why the character may not take a first level in `new_cls`: a list of messages (empty = allowed). PHB: you need 13 in the key ability of your CURRENT class(es) and of the new one."""
    _, shown = abilities(root)
    out = []
    need = lambda cls: all(any(shown[i] >= 13 for i in group) for group in cls["prerequisites"])
    text = lambda cls: " and ".join(" or ".join(C.ABILITIES[i] for i in g) for g in cls["prerequisites"]) + " 13"
    for c in root.findall("class"):
        cls = rules.get(_t(c, "name"))
        if cls and not need(cls):
            out.append(f"{cls['name']} requires {text(cls)}")
    if not need(new_cls):
        out.append(f"{new_cls['name']} requires {text(new_cls)}")
    return out


# ============================================================================================================================ spells and items (copies from the codex)
def spell_copy(el, prepared=False):
    """A copy of a codex <spell> for a class's list: Fight Club writes it as it is, with <prepared> before the class names for a spell above cantrips."""
    sp = copy.deepcopy(el)
    if sp.find("prepared") is None and int(_num(_t(sp, "level"), 0)) > 0:
        p = ET.Element("prepared")
        p.text = "1" if prepared else "0"
        kids = list(sp)
        at = next((i for i, k in enumerate(kids) if k.tag == "sclass"), len(kids))
        sp.insert(at, p)
    return sp


def item_copy(el, qty=1):
    """A copy of a codex <item>, with its quantity set when above 1."""
    it = copy.deepcopy(el)
    if qty > 1:
        q = it.find("quantity")
        if q is None:
            q = ET.Element("quantity")
            kids = list(it)
            at = max((i for i, k in enumerate(kids) if k.tag in ("type", "slot")), default=-1)
            it.insert(at + 1, q)
        q.text = str(qty)
    return it
