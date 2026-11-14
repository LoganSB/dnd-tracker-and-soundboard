"""gear.py - what an item is for, where it is worn, and the limits on wearing things. Pure functions on ElementTree items and plain dicts.

THE RULES (5th edition), and which are real rules:
  * Attunement: a creature can be attuned to at most THREE magic items at once. A real rule (DMG, "Attunement"; PHB). Only items that say they require attunement.
  * Wearing (DMG, "Wearing and Wielding Items"): a character can normally wear only one pair of footwear, one pair of gloves or gauntlets, one pair of bracers, one
    suit of armor, one item of headwear and one cloak; the DM may make exceptions (a circlet under a helm, two cloaks). The book does NOT limit belts, amulets
    or rings, and does not limit bags at all: those limits below (1 belt, 1 amulet, 10 rings - a finger each - and 2 bags) are this app's house rules, as
    is the two-hand limit's two-handed-weapon handling (the PHB gives you two hands and a free object interaction, no slot list).
  The app enforces all of them and says which item is in the way.

WHERE WORN ITEMS ARE KEPT: Fight Club's file has a <slot> for armor (5), shield / second weapon (4) and main hand (2) only; where a belt or boots go is not in it. So
the worn kind (belt, feet ...) and attunement live in the EXTRAS beside the file (see gloan5e.py), linked to an item by its KEY (below):
    extras["worn"]     {item key: "belt" | "ring" | ... | "off"}   "off" = deliberately taken off
    extras["attuned"]  {item key: true | false}
With no entry the Fight Club file decides, as before: an item with a slot counts as worn (and attuned); one without a slot does not (see states()).
"""
import hashlib
import re

WORN_KINDS = {"head": "Headwear", "neck": "Amulet / necklace", "cloak": "Cloak", "hands": "Gloves / gauntlets", "wrists": "Bracers", "belt": "Belt",
              "feet": "Footwear", "ring": "Ring"}
LIMITS = {"head": 1, "neck": 1, "cloak": 1, "hands": 1, "wrists": 1, "belt": 1, "feet": 1, "ring": 10}
ATTUNE_LIMIT = 3
BAG_LIMIT = 2
FC_SLOT_TYPES = ("1", "2", "3", "4", "5", "6")   # armor, shield, weapons: worn in Fight Club's own slots (fcedit.equip)

# name words that settle the kind at once ("Belt of Giant Strength", "Winged Boots", "Ring of Invisibility")
_KEYWORDS = [
    ("ring", r"\brings?\b"), ("belt", r"\b(belt|girdle)\b"), ("feet", r"\b(boots?|shoes?|slippers?|sandals?|greaves)\b"),
    ("hands", r"\b(gloves?|gauntlets?|handwraps?|mitts?)\b"), ("wrists", r"\b(bracers?|bracelets?|vambraces?|armbands?)\b"),
    ("cloak", r"\b(cloak|cape|mantle|shawl)\b"), ("neck", r"\b(amulet|necklace|periapt|medallion|pendant|talisman|brooch|scarab)\b"),
    ("head", r"\b(helm|helmet|hat|circlet|crown|hood|headband|cap|mask|goggles|diadem|tiara|lenses)\b"),
]


def _t(e, tag):
    v = e.findtext(tag)
    return v.strip() if v and v.strip() else ""


def _kind_in(text):
    for kind, pat in _KEYWORDS:
        if re.search(pat, text):
            return kind
    return None


def kind_of(it):
    """The worn kind of an item (a key of WORN_KINDS) from its name, else from how its description says it is worn ("While wearing this belt ..."), else
    None: the page then asks. A ring-type item is a ring."""
    if _t(it, "type") == "11":
        return "ring"
    k = _kind_in(_t(it, "name").lower())
    if k:
        return k
    m = re.search(r"\bwear(?:ing|s)?\s+(?:this|these|the|a|an|your)\s+([a-z' -]{3,30})", _t(it, "text")[:400].lower())
    return _kind_in(m.group(1)) if m else None


def needs_attunement(it):
    """Does the item require attunement? Fight Club's item text starts with "Requires attunement" or "Attunement" for those that do."""
    return "attunement" in _t(it, "text")[:120].lower() or "attunement" in _t(it, "detail").lower()


def all_items(root):
    """Every item with its place: [(parent, element, key)] loose items first, then each bag's. The KEY identifies an item for the extras: a short hash of
    its name, detail and type, with -2, -3 ... for a second and third item that look the same. (Fight Club gives items no id.) Count, slot and description
    may change without breaking the link; renaming an item does."""
    seen, out = {}, []
    for parent, el in [(root, i) for i in root.findall("item")] + [(c, i) for c in root.findall("container") for i in c.findall("item")]:
        base = hashlib.sha1(f"{_t(el, 'name')}|{_t(el, 'detail')}|{_t(el, 'type')}".encode()).hexdigest()[:8]
        seen[base] = seen.get(base, 0) + 1
        out.append((parent, el, base if seen[base] == 1 else f"{base}-{seen[base]}"))
    return out


def states(root, extras, is_equipped):
    """What every item is doing: {element: {key, kind, worn (kind or ""), needs, attuned, active}}.
      worn    the kind the item is worn as, or "" : an explicit extras entry, else (no entry) a classifiable item with a slot counts as worn
      attuned only for items that need attunement: the explicit entry, else True when the item has a slot (or is equipped), else False
      active  whether its own bonuses count: armor, shields and weapons when equipped; anything else when worn / carried-with-a-slot (an explicit "off" turns it
              off, an explicit kind turns it on); and, if it needs attunement, only while attuned
    `is_equipped(el)` is fcedit.is_equipped (passed in so this file stays free of imports from there)."""
    worn, att = (extras or {}).get("worn", {}), (extras or {}).get("attuned", {})
    out = {}
    for parent, el, key in all_items(root):
        fc = _t(el, "type") in FC_SLOT_TYPES
        has_slot = bool(_t(el, "slot")) and parent is root
        needs = needs_attunement(el)
        kind = kind_of(el) if not fc else None
        explicit = worn.get(key)
        if fc:
            base_active, wk = is_equipped(el), ""
        elif explicit == "off":
            base_active, wk = False, ""
        elif explicit in WORN_KINDS:
            base_active, wk = True, explicit
        else:
            base_active, wk = has_slot, (kind or "") if has_slot else ""
        attuned = False
        if needs:
            attuned = bool(att[key]) if key in att else (base_active if fc else has_slot)
        out[el] = {"key": key, "kind": kind, "worn": wk, "needs": needs, "attuned": attuned, "active": base_active and (attuned if needs else True), "fc": fc}
    return out


def can_wear(st, el, kind):
    """Refuse (ValueError) putting `el` on as `kind` when the limit for that kind is reached; the message names what is in the way."""
    if kind not in WORN_KINDS:
        raise ValueError("Choose where it is worn")
    others = [(e, s) for e, s in st.items() if e is not el and s["worn"] == kind]
    if len(others) >= LIMITS[kind]:
        names = ", ".join(_t(e, "name") for e, _ in others[:3])
        limit = f"{LIMITS[kind]} {WORN_KINDS[kind].lower()}" if LIMITS[kind] > 1 else f"one {WORN_KINDS[kind].lower()}"
        raise ValueError(f"You can only wear {limit}: take off {names} first")


def can_attune(st, el):
    """Refuse (ValueError) a fourth attunement."""
    if not st[el]["needs"]:
        raise ValueError("That item does not need attunement")
    on = [(e, s) for e, s in st.items() if e is not el and s["attuned"]]
    if len(on) >= ATTUNE_LIMIT:
        raise ValueError(f"You can be attuned to {ATTUNE_LIMIT} items at most: end the attunement to {', '.join(_t(e, 'name') for e, _ in on)} first")
