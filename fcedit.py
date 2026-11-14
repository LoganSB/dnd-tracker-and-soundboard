"""fcedit.py - changing a Fight Club character in place: items (count, equip, add, remove, give), ability scores and the "Edit character" form.

party.py is the web side (routes, who may do what); this file is the XML side. Plain functions on ElementTree elements: no Flask, no files, so they
can be tested on their own. A change that is not allowed raises ValueError with a message the page shows.

ITEMS ARE FOUND BY A REF, NOT AN ID: Fight Club gives items no id, so the page names one by where it is in the file: "i3" = the 4th loose <item>, "c1.2" =
the 3rd item in the 2nd <container>. A ref is only good until the file changes; party.detail hands out fresh ones with every record.

EQUIPPING: an item's <slot> says where it is worn or held. 1 (or none) means "carried"; 2 is the main hand, 4 the off hand (a shield or a second weapon),
5 the body (armor). That is what the sample files show (a Rapier in 2, a Dagger or a Shield in 4, Plate in 5, everything else 1). Where a ring, an
amulet or boots would go is unknown (no sample has one worn), so those cannot be equipped from here.

ABILITY SCORES: <abilities> holds the BASE scores. What Fight Club shows is the base plus every <mod category=1> (type = the ability, 0 = STR when absent,
value = the amount) from the race, background, class (each "Ability Score Improvement" a level-up chose is one of these), feats and active items (gear.states decides which items are active).
Lynius: Wisdom 17 + 1 (Leonin) + 2 (two level-ups) = 20.
"""
import copy
import re
import xml.etree.ElementTree as ET

ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]
EQUIPPABLE_TYPES = ("1", "2", "3", "4", "5", "6", "11", "14")   # armor, shield, weapons, ring, wondrous: the types a score bonus or a slot can matter for
BODY_TYPES = ("1", "2", "3")                                     # light, medium, heavy armor
WEAPON_TYPES = ("5", "6")                                        # melee, ranged
HIT_DIE_CODE = {6: 1, 8: 2, 10: 3, 12: 4}


def _t(e, tag, default=""):
    v = e.findtext(tag)
    return v.strip() if v and v.strip() else default


def _num(s, default=0.0):
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def _ints(s):
    return [int(x) for x in re.findall(r"-?\d+", s or "")]


def class_level(c):
    """A class's level. Fight Club leaves <level> out at level 1 (the sample character it made has none), so a missing one is 1."""
    return max(1, int(_num(_t(c, "level"), 1)))


def strip_empty(el):
    """Remove every element under `el` that has no text and no children. Fight Club's own backups never contain one, and an empty <age/> or <text/> is the kind of thing
    that makes its reader refuse a file; party._write calls this on everything the app saves."""
    for kid in list(el):
        strip_empty(kid)
        if len(kid) == 0 and not (kid.text or "").strip():
            el.remove(kid)


def slot_list(root, tag="slots"):
    """The ten numbers of <slots> / <slotsCurrent>: position 0 is the CANTRIPS known (Fight Club counts them as level 0: a 13th-level Cleric is
    "5,4,3,3,3,2,1,1,0,0" = 5 cantrips, then four 1st-level slots, three 2nd ... ), positions 1-9 are the slots of spell level 1-9."""
    ints = _ints(_t(root, tag))
    return (ints + [0] * 10)[:10]


def slot_levels(root, tag="slots"):
    """The nine numbers for spell levels 1-9 (not the cantrips)."""
    return slot_list(root, tag)[1:]


def set_slot_levels(root, tag, nine):
    """Write spell levels 1-9 into <slots> / <slotsCurrent>, leaving the cantrip count at position 0 as it is."""
    first = slot_list(root, tag)[0]
    put(root, tag, "".join(f"{v}," for v in [first] + [int(v) for v in (list(nine) + [0] * 9)[:9]]))


def put(parent, tag, value):
    """Set the text of the child <tag> of `parent`, creating the element when it is missing."""
    e = parent.find(tag)
    if e is None:
        e = ET.SubElement(parent, tag)
    e.text = str(value)
    return e


def append_after(parent, elem, after, before=()):
    """Put `elem` inside `parent` after the last child tagged one of `after`, else just before the first tagged one of `before`, else last. Keeps Fight
    Club's own order (items, containers, feats, notes, monsters, then the slots and money)."""
    kids = list(parent)
    last = max((i for i, k in enumerate(kids) if k.tag in after), default=None)
    if last is None:
        last = next((i - 1 for i, k in enumerate(kids) if k.tag in before), len(kids) - 1)
    parent.insert(last + 1, elem)


# ------------------------------------------------------------------ items
def is_equipped(it):
    """Worn or held: an armor, shield, weapon, ring or wondrous item whose <slot> is a real slot (not blank, not the carried slot 1)."""
    return _t(it, "type") in EQUIPPABLE_TYPES and _t(it, "slot") not in ("", "1")


def quantity(it):
    return int(_num(_t(it, "quantity"), 1)) or 1


def item_at(root, ref):
    """-> (parent, <item>) for a ref ("i3" or "c1.2"), or raises ValueError."""
    m = re.fullmatch(r"i(\d+)|c(\d+)\.(\d+)", ref or "")
    try:
        if m and m.group(1) is not None:
            return root, root.findall("item")[int(m.group(1))]
        if m:
            box = root.findall("container")[int(m.group(2))]
            return box, box.findall("item")[int(m.group(3))]
    except IndexError:
        pass
    raise ValueError("That item is not there any more: reload the page")


def set_quantity(root, ref, n):
    """Set how many of an item there are; zero or less removes the item. Returns True when it was removed."""
    parent, it = item_at(root, ref)
    if n <= 0:
        parent.remove(it)
        return True
    put(it, "quantity", min(int(n), 9999))
    return False


COINS = {"pp": ("Platinum", 10.0), "gp": ("Gold", 1.0), "ep": ("Electrum", 0.5), "sp": ("Silver", 0.1), "cp": ("Copper", 0.01)}   # abbreviation -> (name, value in gp)


def coin_of(it):
    """The coin an item is ("pp", "gp", "ep", "sp", "cp") when its name is "Gold (gp)" and so on (that is how Fight Club keeps money: as items), else None."""
    m = re.fullmatch(r"\s*(\w+)\s*\((pp|gp|ep|sp|cp)\)\s*", _t(it, "name"), re.I)
    return m.group(2).lower() if m else None


def change_coin(root, coin, delta):
    """Add `delta` (negative to spend) to the loose coin item of that kind, making it when there is none and removing it at zero. Refuses spending more than
    there is. Returns the new amount."""
    if coin not in COINS:
        raise ValueError("Unknown coin")
    it = next((i for i in root.findall("item") if coin_of(i) == coin), None)
    have = quantity(it) if it is not None and _t(it, "quantity") != "0" else 0
    new = have + int(delta)
    if new < 0:
        raise ValueError(f"Only {have} {coin} to spend")
    new = min(new, 999999)
    if it is None:
        name, value = COINS[coin]
        it = ET.Element("item")
        put(it, "name", f"{name} ({coin})")
        put(it, "type", "15")
        put(it, "quantity", new)
        put(it, "value", value)
        put(it, "weight", 0.02)
        append_after(root, it, ("item", "container"), ("feat", "note", "monster", "slots", "slotsCurrent", "money"))
    elif new == 0:
        root.remove(it)
    else:
        put(it, "quantity", new)
    return new


def remove_item(root, ref):
    parent, it = item_at(root, ref)
    parent.remove(it)


TWO_HANDED = 256   # the weaponProperty bit


def two_handed(it):
    return bool(int(_num(_t(it, "weaponProperty"))) & TWO_HANDED)


def equip(root, ref, on):
    """Equip (on=True) or unequip a loose armor, shield or weapon in Fight Club's own slots. Armor replaces the armor worn. You have TWO HANDS: a shield takes
    the off hand; a weapon takes the main hand, else the off hand, else swaps with the main hand; a two-handed weapon takes both hands (what was held is put
    away) and a shield cannot be taken up while one is held. Whatever is displaced goes back to "carried". Other gear (belts, boots, rings ...) is worn with
    gear.can_wear and the extras instead: see party.change_item."""
    parent, it = item_at(root, ref)
    kind = _t(it, "type")
    if parent is not root:
        raise ValueError("Take it out of the bag first: only loose items can be equipped")
    if kind not in BODY_TYPES + ("4",) + WEAPON_TYPES:
        raise ValueError("Only armor, shields and weapons can be equipped here")
    if not on:
        put(it, "slot", "1")
        return
    others = [o for o in root.findall("item") if o is not it]
    hands = [o for o in others if _t(o, "type") in ("4",) + WEAPON_TYPES and _t(o, "slot") in ("2", "4")]
    if kind in BODY_TYPES:
        for o in others:
            if _t(o, "type") in BODY_TYPES and _t(o, "slot") == "5":
                put(o, "slot", "1")
        put(it, "slot", "5")
    elif kind == "4":
        both = next((o for o in hands if two_handed(o)), None)
        if both is not None:
            raise ValueError(f"{_t(both, 'name')} is two-handed and uses both hands: put it away before taking up a shield")
        for o in hands:
            if _t(o, "slot") == "4":
                put(o, "slot", "1")
        put(it, "slot", "4")
    elif two_handed(it):
        for o in hands:
            put(o, "slot", "1")
        put(it, "slot", "2")
    else:
        for o in hands:
            if two_handed(o):
                put(o, "slot", "1")
        free = {_t(o, "slot") for o in hands if not two_handed(o)}
        if "2" not in free:
            put(it, "slot", "2")
        elif "4" not in free:
            put(it, "slot", "4")
        else:
            for o in hands:
                if _t(o, "slot") == "2" and _t(o, "type") in WEAPON_TYPES:
                    put(o, "slot", "1")
            put(it, "slot", "2")


def make_item(b, type_names):
    """A new <item> from the "Add item" form `b`: name, typeCode, detail, text, quantity, weight, value, magic, ac, damage, damageType."""
    name = str(b.get("name") or "").strip()[:80]
    if not name:
        raise ValueError("The item needs a name")
    code = str(b.get("typeCode") or "15")
    if code not in type_names:
        code = "15"
    it = ET.Element("item")
    put(it, "name", name)
    put(it, "detail", str(b.get("detail") or type_names[code])[:80])
    put(it, "text", str(b.get("text") or "")[:6000])
    put(it, "type", code)
    if b.get("magic"):
        put(it, "magic", "1")
    put(it, "value", float(max(0, min(1e9, _num(b.get("value"))))))
    put(it, "weight", float(max(0, min(1e5, _num(b.get("weight"))))))
    if code in BODY_TYPES + ("4",):
        put(it, "ac", int(max(0, min(30, _num(b.get("ac"))))))
    if code in WEAPON_TYPES:
        dice = str(b.get("damage") or "").strip()[:20]
        if dice:
            put(it, "damage1H", dice)
            if str(b.get("damageType")) in ("1", "2", "3"):
                put(it, "damageType", str(b["damageType"]))
    put(it, "quantity", max(1, min(9999, int(_num(b.get("quantity"), 1)))))
    return it


def make_bag(b):
    """A new <container> (a bag, pack or chest) from the Add item form: name, weight, value, description."""
    name = str(b.get("name") or "").strip()[:80]
    if not name:
        raise ValueError("The bag needs a name")
    c = ET.Element("container")
    put(c, "name", name)
    put(c, "value", float(max(0, min(1e9, _num(b.get("value"))))))
    put(c, "weight", float(max(0, min(1e5, _num(b.get("weight"))))))
    put(c, "text", str(b.get("text") or "")[:6000])
    return c


def add_bag(root, bag):
    """Add a bag; at most BAG_LIMIT (2) bags per character (a house rule: the book has no limit, see gear.py)."""
    import gear
    if len(root.findall("container")) >= gear.BAG_LIMIT:
        raise ValueError(f"A character can carry {gear.BAG_LIMIT} bags at most; put one down first")
    append_after(root, bag, ("item", "container"), ("feat", "note", "monster", "slots", "slotsCurrent", "money"))


def add_to(root, item, n=None):
    """Put `item` among the loose items: when the same item (name, kind, description) is already there, its count goes up instead. `n` = how many
    (default: the item's own quantity). Returns the item that now holds them."""
    n = n if n is not None else quantity(item)
    for o in root.findall("item"):
        if all(_t(o, k) == _t(item, k) for k in ("name", "type", "detail", "text")) and not is_equipped(o):
            put(o, "quantity", min(9999, quantity(o) + n))
            return o
    new = copy.deepcopy(item)
    put(new, "quantity", n)
    # no <slot>: it arrives stowed, so nothing it grants counts until equipped (slot 1, the main list, counts as worn: see gear.states)
    append_after(root, new, ("item", "container"), ("feat", "note", "monster", "slots", "slotsCurrent", "money"))
    return new


def give(src, ref, dst, n):
    """Move `n` of the item at `ref` from character `src` to character `dst`. Returns the item's name. A stack is split: what is left stays."""
    parent, it = item_at(src, ref)
    have = quantity(it)
    if n < 1 or n > have:
        raise ValueError(f"There are only {have} of that item")
    if is_equipped(it) and n == have:
        raise ValueError("Unequip it first")
    name = _t(it, "name")
    add_to(dst, it, n)
    if n == have:
        parent.remove(it)
    else:
        put(it, "quantity", have - n)
    return name


# ------------------------------------------------------------------ ability scores
def ability_bonuses(root, extras=None):
    """Every score bonus from <mod category=1>: [(source, ability index, amount)] for the race (and its features), background, classes (the level-up
    "Ability Score Improvement"s), feats and active items (gear.states)."""
    out = []

    def scan(e, source):
        for m in e.findall("mod"):
            ability, amount = int(_num(_t(m, "type"), 0)), int(_num(_t(m, "value")))
            if _t(m, "category") == "1" and amount and 0 <= ability < 6:
                out.append((source, ability, amount))

    race, bg = root.find("race"), root.find("background")
    if race is not None:
        scan(race, "race")
        for f in race.findall("feat"):
            scan(f, "race")
    if bg is not None:
        scan(bg, "background")
        for f in bg.findall("feat"):
            scan(f, "background")
    for c in root.findall("class"):
        scan(c, f"{_t(c, 'name') or 'class'} level-ups")
        for f in c.findall("feat"):
            scan(f, _t(c, "name") or "class")
    for f in root.findall("feat"):
        scan(f, f"feat {_t(f, 'name')}")
    import gear
    for it, st in gear.states(root, extras, is_equipped).items():
        if st["active"]:
            scan(it, _t(it, "name"))
    return out


def ability_scores(root, extras=None):
    """-> (base, effective, sources): the six base scores, the six shown scores, and per ability the list [{source, value}] that explains the difference."""
    base = (_ints(_t(root, "abilities")) + [10] * 6)[:6]
    eff, why = list(base), [[] for _ in range(6)]
    for source, i, amount in ability_bonuses(root, extras):
        eff[i] += amount
        why[i].append({"source": source, "value": amount})
    return base, eff, why


# ------------------------------------------------------------------ the Edit character form
def _clamp(v, lo, hi):
    return max(lo, min(hi, int(_num(v))))


def edit_character(root, b):
    """Apply the Edit character form `b` (every key optional): name, xp, unarmed, abilities [6 base scores], race {name, speed, age, height, weight, eyes,
    skin, hair}, background {name}, classes [{name, level, hd (6/8/10/12), armor, weapons, tools}] in file order, slots [9 maximums],
    profs {saves [0-5], skills [0-17]}."""
    if "name" in b and str(b["name"]).strip():
        put(root, "name", str(b["name"]).strip()[:60])
    if "xp" in b:
        put(root, "xp", _clamp(b["xp"], 0, 10 ** 7))
    if "unarmed" in b:
        put(root, "unarmed", str(b["unarmed"]).strip()[:40])
    if "abilities" in b:
        if len(b["abilities"]) != 6:
            raise ValueError("There are six ability scores")
        put(root, "abilities", "".join(f"{_clamp(v, 1, 30)}," for v in b["abilities"]))
    race = root.find("race")
    if "race" in b and race is not None:
        r = b["race"]
        for k in ("name", "age", "height", "weight", "eyes", "skin", "hair"):
            if k in r:
                put(race, k, str(r[k]).strip()[:60])
        if "speed" in r:
            if str(r["speed"]).strip() in ("", "30"):   # Fight Club leaves a standard 30 ft out
                for e in race.findall("speed"):
                    race.remove(e)
            else:
                put(race, "speed", _clamp(r["speed"], 0, 999))
    bg = root.find("background")
    if "background" in b and bg is not None and str(b["background"].get("name", "")).strip():
        put(bg, "name", str(b["background"]["name"]).strip()[:60])
    if "classes" in b:
        for c, v in zip(root.findall("class"), b["classes"]):
            if str(v.get("name", "")).strip():
                put(c, "name", str(v["name"]).strip()[:40])
            if "level" in v:
                level = _clamp(v["level"], 1, 20)
                put(c, "level", level)
                if c.find("hdCurrent") is not None:
                    put(c, "hdCurrent", min(level, int(_num(_t(c, "hdCurrent"), level))))
            if int(_num(v.get("hd"))) in HIT_DIE_CODE:
                put(c, "hd", HIT_DIE_CODE[int(v["hd"])])
            for k in ("armor", "weapons", "tools"):
                if k in v:
                    put(c, k, str(v[k]).strip()[:120])
    if "slots" in b:   # spell levels 1-9 (the cantrip count at position 0 of the file's list is not touched)
        new = [_clamp(v, 0, 9) for v in b["slots"]][:9]
        new += [0] * (9 - len(new))
        cur = slot_levels(root, "slotsCurrent")
        set_slot_levels(root, "slots", new)
        set_slot_levels(root, "slotsCurrent", [min(cur[i], new[i]) for i in range(9)])
    if "profs" in b:
        _edit_profs(root, b["profs"])


def _edit_profs(root, profs):
    """Make the saving throws and skills the character is proficient in exactly `profs` ({saves [0-5], skills [0-17]}). Codes are <proficiency> numbers:
    0-5 a save, 100-117 a skill. They sit in the race, background and classes; an unwanted one is removed wherever it is, a missing one is added to the
    first class. Other codes (tools, languages) are left alone."""
    want = {_clamp(s, 0, 5) for s in profs.get("saves", [])} | {100 + _clamp(k, 0, 17) for k in profs.get("skills", [])}
    holders = [e for e in [root.find("race"), root.find("background"), *root.findall("class")] if e is not None]
    have = set()
    for e in holders:
        for p in e.findall("proficiency"):
            code = int(_num(p.text, -1))
            if code < 6 or 100 <= code <= 117:
                if code in want and code not in have:
                    have.add(code)
                elif code not in want:
                    e.remove(p)
                else:
                    e.remove(p)   # a duplicate of one already counted
    first = root.find("class")
    if first is None:
        return
    for code in sorted(want - have):
        p = ET.Element("proficiency")
        p.text = str(code)
        append_after(first, p, ("proficiency",), ("numClassSkills", "armor", "weapons", "tools", "spellAbility", "feat"))
