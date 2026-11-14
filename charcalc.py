"""charcalc.py - the numbers on a character sheet that Fight Club does not store, worked out from what it does store.

WHY THIS FILE EXISTS
A Fight Club 5e file keeps the raw facts (ability scores, class levels, items and their bonuses, proficiency codes) but not the
results a player reads off a sheet: armor class, attack bonuses, skill modifiers, passive Perception. The phone app calculates those
itself. This module does the same for the Skills and Stats page of the character sheet.

It is a set of PURE functions on plain dicts (the character record built by party.detail()). No XML, no Flask, no files, so it can be
tested on its own and reused by anything that has a character dict. party.py calls derive() once and adds the answer to the record.

THE RULES USED (5th edition)
  proficiency bonus   2 + (total level - 1) // 4
  armor class         armor: light = base + Dex, medium = base + Dex (at most 2), heavy = base; shield adds its AC; magic bonuses add;
                      no body armor = 10 + Dex (a Barbarian adds Con, a Monk adds Wis instead of nothing)
  attack bonus        ability modifier + proficiency (when proficient with that weapon) + the item's magic bonus
                      ability: Str for melee, Dex for ranged, the better of the two for Finesse
  damage              the dice + the same ability modifier + the item's magic damage bonus
  skills / saves      ability modifier + proficiency bonus when proficient (Fight Club does not record expertise)
  passive Perception  10 + the Perception modifier

WHAT IS AN ESTIMATE
Bonuses that come from class features or effects (a fighting style, a spell, an ability score raised by a magic belt) are not in the
data, so they are not included. The page labels these as calculated.

FIGHT CLUB CODES USED (worked out from real files, see FIGHTCLUB-FORMAT.md)
  <proficiency> 0-5 on a class = saving throw (ability index);  100-117 = a skill, alphabetical (Acrobatics = 100 ... Survival = 117)
"""
import re

ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]

# The eighteen skills in Fight Club's order (alphabetical) with their ability. The proficiency code of skill i is 100 + i.
SKILLS = [("Acrobatics", 1), ("Animal Handling", 4), ("Arcana", 3), ("Athletics", 0), ("Deception", 5), ("History", 3), ("Insight", 4),
          ("Intimidation", 5), ("Investigation", 3), ("Medicine", 4), ("Nature", 3), ("Perception", 4), ("Performance", 5),
          ("Persuasion", 5), ("Religion", 3), ("Sleight of Hand", 1), ("Stealth", 1), ("Survival", 4)]
SKILL_CODE0 = 100
PERCEPTION = 11

# Weapon property bits on an item (<weaponProperty>); only the ones the maths needs.
FINESSE = 2


def proficiency_bonus(level):
    return 2 + (max(1, level) - 1) // 4


def total_level(classes):
    return sum(int(c.get("level") or 0) for c in classes) or 1


def _mods(d):
    """The six ability modifiers, STR..CHA (0 for anything missing)."""
    m = [a["mod"] for a in d.get("abilities", [])][:6]
    return m + [0] * (6 - len(m))


def _equipped(d):
    return [i for i in d.get("items", []) if i.get("equipped")] + [i for c in d.get("containers", []) for i in c.get("items", []) if i.get("equipped")]


def armor_class(d, mods, equipped):
    """-> (ac, how): the number and a short reason. Base 10 + Dex with nothing worn."""
    dex = mods[1]
    body = [i for i in equipped if i.get("type") in ("Light Armor", "Medium Armor", "Heavy Armor")]
    shields = [i for i in equipped if i.get("type") == "Shield"]
    if body:
        a = body[0]
        base = int(float(a.get("ac") or 10))
        kind = a["type"]
        ac = base + (dex if kind == "Light Armor" else min(dex, 2) if kind == "Medium Armor" else 0)
        how = a["name"].strip()
    else:
        names = {c.get("name", "").lower() for c in d.get("classes", [])}
        extra, how = (mods[2], "Unarmored Defense (Con)") if "barbarian" in names else (mods[4], "Unarmored Defense (Wis)") if "monk" in names else (0, "no armor")
        ac = 10 + dex + extra
    ac += sum(int(float(s.get("ac") or 0)) + s.get("bonus", {}).get("ac", 0) for s in shields)
    ac += sum(i.get("bonus", {}).get("ac", 0) for i in d.get("items", []) + [x for c in d.get("containers", []) for x in c["items"]] if i.get("active") and i not in shields)
    if shields:
        how += " + " + ", ".join(s["name"].strip() for s in shields)
    return ac, how


def _proficient_with(item, weapons_text):
    """Is the character proficient with this weapon? By category ("simple" / "martial" in the class's weapon list and in the item's
    detail line) or by the weapon's own name ("rapiers" lists the Rapier)."""
    text = (weapons_text or "").lower()
    detail = (item.get("detail") or "").lower()
    for cat in ("simple", "martial"):
        if cat in detail and cat in text:
            return True
    base = re.sub(r"^\+\d+\s+", "", item.get("name", "").lower()).strip()
    words = {base, base.split(" of ")[0], base.split()[-1] if base.split() else ""}
    return any(w and (w in text or w.rstrip("s") in text) for w in words)


def _signed(n):
    return f"+{n}" if n >= 0 else str(n)


def attacks(d, mods, prof, equipped):
    """One row per equipped weapon, then an unarmed strike. Row: name, atk (a number), damage ("1d8+3 piercing"), damage2h (versatile),
    notes (properties and range)."""
    weapons_text = " ".join(c.get("weapons", "") for c in d.get("classes", []))
    rows = []
    for i in equipped:
        if i.get("type") not in ("Melee Weapon", "Ranged Weapon") or not i.get("damage"):
            continue
        ranged = i["type"] == "Ranged Weapon"
        stat = mods[1] if ranged else max(mods[0], mods[1]) if i.get("propCode", 0) & FINESSE else mods[0]
        b = i.get("bonus", {})
        atk = stat + (prof if _proficient_with(i, weapons_text) else 0) + b.get("atk", 0)
        dmg = stat + b.get("dmg", 0)
        kind = i.get("damageType", "")
        def dice(x):
            return f"{x}{_signed(dmg) if dmg else ''} {kind}".strip()
        rng = f"range {i['range']}" + (f"/{i['longRange']}" if i.get("longRange") else "") if i.get("range") else ""
        rows.append({"name": i["name"].strip(), "atk": atk, "damage": dice(i["damage"]), "damage2h": dice(i["damage2h"]) if i.get("damage2h") else "",
                     "notes": ", ".join(x for x in (i.get("property", ""), rng) if x)})
    rows.append({"name": "Unarmed strike", "atk": mods[0] + prof, "damage": f"{max(1, 1 + mods[0])} bludgeoning", "damage2h": "", "notes": ""})
    return rows


def _speed(d, equipped):
    """-> (feet, how). The race's walking speed (30 when the race does not say: party.detail fills that in) plus the class feature Fast Movement
    (+10 ft for a Barbarian from 5th level, only while not in heavy armor), found by the feature's name in the character's own list."""
    base = int(float((d.get("raceInfo") or {}).get("speed") or 0))
    if not base:
        return 0, ""
    fast = any(f.get("name", "").strip().lower() == "fast movement" for c in d.get("classes", []) for f in c.get("feats", []))
    heavy = any(i.get("type") == "Heavy Armor" for i in equipped)
    if fast and not heavy:
        return base + 10, f"{base} ft + 10 ft Fast Movement"
    return base, f"{base} ft base" + (" (Fast Movement is off while in heavy armor)" if fast else "")


def derive(d):
    """The calculated part of a character: {profBonus, stats: {ac, acNote, initiative, speed, passivePerception, profBonus},
    skills: [{name, ability, mod, proficient}], saves: [{name, mod, proficient}], attacks: [...]}.

    `d` is the party.detail() record plus d["profs"] = {"saves": [index], "skills": [code]}."""
    mods = _mods(d)
    prof = proficiency_bonus(total_level(d.get("classes", [])))
    profs = d.get("profs", {})
    equipped = _equipped(d)
    skills = []
    for n, (name, ab) in enumerate(SKILLS):
        p = SKILL_CODE0 + n in profs.get("skills", [])
        skills.append({"name": name, "ability": ABILITIES[ab], "mod": mods[ab] + (prof if p else 0), "proficient": p})
    saves = [{"name": ABILITIES[n], "mod": mods[n] + (prof if n in profs.get("saves", []) else 0), "proficient": n in profs.get("saves", [])} for n in range(6)]
    ac, how = armor_class(d, mods, equipped)
    speed, speed_note = _speed(d, equipped)
    return {
        "profBonus": prof,
        "stats": {"ac": ac, "acNote": how, "initiative": mods[1], "speed": f"{speed} ft" if speed else "", "speedFeet": speed, "speedNote": speed_note,
                  "passivePerception": 10 + skills[PERCEPTION]["mod"], "profBonus": prof},
        "skills": skills, "saves": saves, "attacks": attacks(d, mods, prof, equipped),
    }
