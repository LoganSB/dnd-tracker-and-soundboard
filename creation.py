"""creation.py - the web side of character creation and level-up: the rule book routes, POST /api/party/create and GET / POST /api/party/<id>/levelup.

The rule book is Fight Club's own compendium (codex.py), the same data the Fight Club app uses; charbuild.py copies from it into the character the way Fight Club does and this file
checks what the page sends and saves the result through party.py (so a new character has an owner, a file and an id like any other).

WHO MAY: a player creates characters for themselves (the owner is always them) and levels their own; the DM creates for anyone (an optional "owner") and levels any. The rule book routes
(/api/rules/...) are open to players like the spell and item searches.

ROUTES (ids are positions in the codex's lists: the page asks for the list and sends back the id)
  GET  /api/codex                              {available, source, counts}
  GET  /api/rules/races | classes | backgrounds | feats        [{id, name, ...}]
  GET  /api/rules/races/<id> | classes/<id> | backgrounds/<id>  one entry: its ability bonuses and traits / its levels, skills and choices / its skills and traits
  GET  /api/rules/spells?class=<name>          the class's spells [{id, name, level, school, time, text}]
  GET  /api/rules/items?q=<text>               items whose name or kind matches [{id, name, detail, value, weight}] (at most 40)
  POST /api/party/create                       see create() -> {id, character}
  GET  /api/party/<id>/levelup[?class=<name>]  the classes to take a level in, or what the next level in one brings (and why a multiclass is refused)
  POST /api/party/<id>/levelup                 {class, roll, asi, choices} -> {result, character}
"""
import re
import xml.etree.ElementTree as ET

from flask import Blueprint, jsonify, request

import auth
import charbuild as B
import codex as C
import fcedit
import party

bp = Blueprint("creation", __name__)
NO_BOOK = ("There is no Fight Club rule book yet. Import a Fight Club backup made after you imported its collection (it holds the rule book): the DM does that on the Home page, "
           "and creation and level-up then copy from it.")


def _fail(message, code=400):
    return jsonify(error=message), code


@bp.errorhandler(LookupError)
def _missing(e):
    return jsonify(error=str(e)), 404


def _book():
    cdx = C.load()
    if cdx is None:
        raise LookupError(NO_BOOK)
    return cdx


def _pick(lst, i):
    if not isinstance(i, int) or not 0 <= i < len(lst):
        raise LookupError("That is not in the rule book")
    return lst[i]


def _t(e, tag):
    return (e.findtext(tag) or "").strip()


def _source(e):
    """"Source: Player's Handbook p. 29" from an entry's Description feature, for the lists."""
    for f in e.findall("feat"):
        if _t(f, "name") == "Description":
            m = re.search(r"Source:\s*([^\n]*)", f.findtext("text") or "")
            if m:
                return re.sub(r"\s+p\.?\s*\d+.*$", "", m.group(1)).strip()
    return ""


# ================================================================================================================ the rule book
@bp.get("/api/codex")
def codex_info():
    cdx = C.load()
    return jsonify(available=cdx is not None, source=cdx.source if cdx else "", counts=cdx.counts() if cdx else {})


@bp.get("/api/rules/<kind>")
def rules_list(kind):
    cdx = _book()
    if kind == "races":
        return jsonify([{"id": i, "name": _t(r, "name"), "source": _source(r)} for i, r in enumerate(cdx.races)])
    if kind == "classes":
        return jsonify([{"id": i, "name": _t(c, "name")} for i, c in enumerate(cdx.classes)])
    if kind == "backgrounds":
        return jsonify([{"id": i, "name": _t(b, "name"), "source": _source(b)} for i, b in enumerate(cdx.backgrounds)])
    if kind == "feats":
        return jsonify([{"id": i, "name": _t(f, "name"), "text": (f.findtext("text") or "").strip()} for i, f in enumerate(cdx.feats)])
    return _fail("Unknown kind", 404)


@bp.get("/api/rules/races/<int:i>")
def rules_race(i):
    r = _pick(_book().races, i)
    bonuses = [{"ability": fcedit_int(m.findtext("type")), "value": fcedit_int(m.findtext("value"))} for m in r.findall("mod") if _t(m, "category") == "1"]
    return jsonify(id=i, name=_t(r, "name"), speed=fcedit_int(r.findtext("speed"), 30), bonuses=bonuses,
                   feats=[{"name": _t(f, "name"), "text": (f.findtext("text") or "").strip()} for f in r.findall("feat")])


def fcedit_int(s, default=0):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return default


@bp.get("/api/rules/classes/<int:i>")
def rules_class(i):
    cdx = _book()
    _pick(cdx.classes, i)
    return jsonify(C.class_summary(cdx.parsed_class(i)))


@bp.get("/api/rules/backgrounds/<int:i>")
def rules_background(i):
    b = _pick(_book().backgrounds, i)
    return jsonify(id=i, name=_t(b, "name"), skills=[fcedit_int(p.text) - 100 for p in b.findall("proficiency") if fcedit_int(p.text) >= 100],
                   feats=[{"name": _t(f, "name"), "text": (f.findtext("text") or "").strip()} for f in b.findall("feat")])


@bp.get("/api/rules/spells")
def rules_spells():
    cdx = _book()
    want = request.args.get("class", "").strip().lower()
    out = []
    for i, s in enumerate(cdx.spells):
        if want and want not in [c.text.strip().lower() for c in s.findall("sclass") if c.text]:
            continue
        info = C.spell_info(s)
        out.append({"id": i, "name": info["name"], "level": info["level"], "school": info["school"], "time": info["time"], "text": (s.findtext("text") or "").strip()[:240]})
    return jsonify(out)


@bp.get("/api/rules/items")
def rules_items():
    """Items whose name or kind contains `q`: plain gear first (then magic items), a name that starts with the text before one that only contains it. At most 40."""
    cdx = _book()
    q = request.args.get("q", "").strip().lower()
    found = []
    for i, it in enumerate(cdx.items):
        name = _t(it, "name")
        if q and q not in name.lower() and q not in _t(it, "detail").lower():
            continue
        magic = it.find("magic") is not None
        found.append(((magic, 0 if name.lower() == q else 1 if name.lower().startswith(q) else 2 if q in name.lower() else 3, name.lower()), {"id": i, "name": name, "detail": _t(it, "detail"),
                      "value": _t(it, "value"), "weight": _t(it, "weight")}))
    found.sort(key=lambda x: x[0])
    return jsonify([row for _, row in found[:40]])


# ================================================================================================================ creation
def _validate_abilities(method, scores):
    if not isinstance(scores, list) or len(scores) != 6 or any(not isinstance(v, int) for v in scores):
        raise ValueError("Give six ability scores")
    if method == "standard" and sorted(scores) != [8, 10, 12, 13, 14, 15]:
        raise ValueError("The standard array is 15, 14, 13, 12, 10, 8, each once")
    elif method == "pointbuy":
        cost = {8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9}
        if any(v not in cost for v in scores) or sum(cost[v] for v in scores) > 27:
            raise ValueError("Point buy: each score 8 to 15 and at most 27 points")
    elif method == "roll" and any(not 3 <= v <= 18 for v in scores):
        raise ValueError("Rolled scores are 3 to 18")
    elif method not in ("standard", "pointbuy", "roll", "manual"):
        raise ValueError("Unknown way to set the ability scores")
    elif method == "manual" and any(not 1 <= v <= 20 for v in scores):
        raise ValueError("Scores are 1 to 20")


def _next_uid():
    best = 1000
    for cid in party._ids():
        try:
            best = max(best, int(party._t(party._peek(cid), "uid", "0")))
        except ValueError:
            pass
    return best + 1


def _wealth_max(dice):
    m = re.fullmatch(r"(\d+)d(\d+)(?:x(\d+))?", dice)
    return int(m.group(1)) * int(m.group(2)) * int(m.group(3) or 1) if m else 0


@bp.post("/api/party/create")
def create():
    """POST /api/party/create -> {"id", "character"}. Body (ids are positions in the rule book's lists):
      name, level (1-20), owner (the DM only; a player's characters are always theirs)
      race (id), looks {age, height, weight, eyes, skin, hair}, background (id)
      class (id), skills [the class's skill choices: skill index 0-17], choices {"<level>:<feature>": [option names]} for every choice the levels reached ask for
      abilityMethod (standard | pointbuy | roll | manual), abilities [six base scores]
      hpRolls [die rolled for each level 2..level] (omit or null = the average)
      asi [one decision per ability score improvement reached: {type: "asi", inc: [i, j]} or {type: "feat", id} or {type: "feat", feat: {name, text, ability?}}]
      equipment {gold: starting gold, items: [{id, qty}]} (items copied from the rule book)
      spells {cantrips: [id], spells: [id]}"""
    user = auth.current_user()
    b = request.get_json(force=True, silent=True) or {}
    cdx = _book()
    try:
        name = party._text(b.get("name"), 80)
        level = int(b.get("level") or 1)
        if not name:
            raise ValueError("Give the character a name")
        if not 1 <= level <= 20:
            raise ValueError("The level is 1 to 20")
        cls = cdx.parsed_class(b.get("class")) if isinstance(b.get("class"), int) and 0 <= b["class"] < len(cdx.classes) else None
        if cls is None:
            raise ValueError("Choose a class")
        race = _pick(cdx.races, b.get("race"))
        bg = _pick(cdx.backgrounds, b.get("background"))
        _validate_abilities(b.get("abilityMethod"), b.get("abilities"))
        class_skills = b.get("skills") or []
        if len(class_skills) != cls["skills"]["count"] or len(set(class_skills)) != len(class_skills) or any(s not in cls["skills"]["options"] for s in class_skills):
            raise ValueError(f"Choose {cls['skills']['count']} class skills from the list")
        bg_skills = {fcedit_int(p.text) - 100 for p in bg.findall("proficiency") if fcedit_int(p.text) >= 100}
        if bg_skills & set(class_skills):
            raise ValueError("A skill cannot come from both the class and the background: choose another")
        ch = B.new_character(uid=_next_uid(), name=name, base_abilities=b["abilities"], race_el=race, background_el=bg, looks=b.get("looks"))
        asi_levels = [n for n in cls["asiLevels"] if n <= level]
        decisions = b.get("asi") or []
        if len(decisions) != len(asi_levels):
            raise ValueError(f"Make {len(asi_levels)} ability score improvement choice(s)" if asi_levels else "No ability score improvements yet at this level")
        rolls = b.get("hpRolls") or []
        for lv in range(1, level + 1):
            asi = B.validate_asi(ch, decisions[asi_levels.index(lv)], cdx.feats) if lv in asi_levels else None
            roll = rolls[lv - 2] if lv >= 2 and lv - 2 < len(rolls) else None
            if roll is not None and (not isinstance(roll, int) or not 1 <= roll <= cls["hd"]):
                raise ValueError(f"A hit die roll is 1 to {cls['hd']}")
            B.apply_level(ch, cls, {}, roll=roll, asi=asi, choices=b.get("choices"), feats=cdx.feats)
            if lv == 1:
                B.add_class_skills(ch, cls["name"], class_skills)
        fcedit.put(ch, "hpCurrent", int(party._num(party._t(ch, "hpMax"))))
        _add_spells(ch, cdx, cls, level, b.get("spells") or {})
        _add_equipment(ch, cdx, cls, b.get("equipment") or {})
        B.strip_empty(ch)   # Fight Club's own files hold no empty element at all (see fcedit.strip_empty)
    except (ValueError, KeyError, TypeError) as err:
        return _fail(str(err) or "That is not a valid character")
    owner = user["name"] if user["role"] != "dm" else str(b.get("owner") or "").strip()
    if owner and user["role"] == "dm" and owner.lower() not in auth._load()["users"]:
        return _fail(f"No user named {owner}")
    with party.lock:
        cid = party._cid_for(ch, set())
        party._write(cid, ch)
        if owner:
            ex = party._extra()
            ex.setdefault(cid, {})["owner"] = owner
            party._save_extra(ex)
    return jsonify(id=cid, character=party.detail(cid, party._peek(cid)))


def _add_spells(ch, cdx, cls, level, want):
    """The spells chosen at creation: copies of the rule book's, into the class's list (up to what the class table allows)."""
    _, shown = B.abilities(ch)
    allow = C.spells_known_allowance(cls, level, shown)
    cantrips, spells = list(want.get("cantrips") or []), list(want.get("spells") or [])
    if len(cantrips) > allow["cantrips"] or len(spells) > allow["spells"]:
        raise ValueError(f"{cls['name']} gets {allow['cantrips']} cantrips and {allow['spells']} spells at level {level}")
    klass = ch.find("class")
    for i in cantrips + spells:
        el = _pick(cdx.spells, i)
        if cls["name"].lower() not in [c.text.strip().lower() for c in el.findall("sclass") if c.text]:
            raise ValueError(f"{_t(el, 'name')} is not a {cls['name']} spell")
        if (i in cantrips) != (fcedit_int(el.findtext("level")) == 0):
            raise ValueError(f"{_t(el, 'name')} is in the wrong list (cantrips and spells)")
        klass.append(B.spell_copy(el, prepared=allow["kind"] != "spellbook"))


def _add_equipment(ch, cdx, cls, eq):
    """Starting gold (as Fight Club does: a Gold (gp) item and the money) and any items taken from the rule book (copies)."""
    gold = int(eq.get("gold") or 0)
    if not 0 <= gold <= _wealth_max(cls["wealth"]):
        raise ValueError(f"Starting gold for a {cls['name']} is at most {_wealth_max(cls['wealth'])}")
    items = [(_pick(cdx.items, int(x.get("id"))), max(1, min(9999, int(x.get("qty") or 1)))) for x in (eq.get("items") or [])]
    kids = list(ch)
    at = max((i for i, k in enumerate(kids) if k.tag in ("class", "container", "feat", "item")), default=len(kids) - 1)
    out = []
    if gold:   # the coin item Fight Club makes for starting gold: no description, just the name, quantity, value and weight
        coin = ET.Element("item")
        for tag, val in (("name", "Gold (gp)"), ("type", "15"), ("quantity", gold), ("value", "1.0"), ("weight", "0.02")):
            ET.SubElement(coin, tag).text = str(val)
        out.append(coin)
        fcedit.put(ch, "money", float(gold))
    out += [B.item_copy(el, qty) for el, qty in items]
    for n, it in enumerate(x for x in out if x is not None):
        ch.insert(at + 1 + n, it)


# ================================================================================================================ level up
def _rules_of(root, cdx):
    """{class name: parsed class} for every class the character has that the rule book knows."""
    out = {}
    for c in root.findall("class"):
        i = cdx.class_named(party._t(c, "name"))
        if i is not None:
            out[party._t(c, "name")] = cdx.parsed_class(i)
    return out


@bp.get("/api/party/<cid>/levelup")
def levelup_plan(cid):
    """GET /api/party/<id>/levelup[?class=<name>] -> what the next level brings. Without `class`: {classes [{name, level}], total, canLevel, options [the classes a multiclass could take: {name,
    problems [messages]}], xp, xpNext}. With it: the plan (charbuild.plan_next_level) plus `problems` (why a multiclass is refused)."""
    party._guard(cid)
    cdx = _book()
    root = party._peek(cid)
    rules = _rules_of(root, cdx)
    total = B.total_level(root)
    mine = [{"name": party._t(c, "name"), "level": B.class_level(c), "known": party._t(c, "name") in rules} for c in root.findall("class")]
    name = request.args.get("class")
    if not name:
        opts = [{"name": c["name"], "problems": B.multiclass_problems(root, c, rules)} for c in (cdx.parsed_class(i) for i in range(len(cdx.classes))) if c["name"] not in rules]
        return jsonify(classes=mine, total=total, canLevel=total < 20, options=opts, xp=int(party._num(party._t(root, "xp"))), xpNext=C.XP_FOR_LEVEL[total] if total < 20 else None)
    i = cdx.class_named(name)
    if i is None:
        return _fail(f"{name} is not in the rule book")
    cls = cdx.parsed_class(i)
    plan = B.plan_next_level(root, cls, rules)
    plan["problems"] = [] if cls["name"] in rules else B.multiclass_problems(root, cls, rules)
    plan["class"] = {"name": cls["name"]}
    return jsonify(plan)


@bp.post("/api/party/<cid>/levelup")
def levelup_apply(cid):
    """POST /api/party/<id>/levelup {class: name, roll: die rolled or null for the average, asi: decision (when the level has one), choices: {"<level>:<feature>": [option names]}} ->
    {result: {level, classLevel, hpGain, features}, character}. Refused with 400 and a message when a rule is broken."""
    party._guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    cdx = _book()
    with party.lock:
        root = party._load(cid)
        try:
            i = cdx.class_named(str(b.get("class") or ""))
            if i is None:
                raise ValueError("Choose a class from the rule book")
            cls = cdx.parsed_class(i)
            rules = _rules_of(root, cdx)
            if cls["name"] not in rules and root.findall("class"):
                problems = B.multiclass_problems(root, cls, rules)
                if problems:
                    raise ValueError("; ".join(problems))
            plan = B.plan_next_level(root, cls, rules)
            asi = B.validate_asi(root, b.get("asi"), cdx.feats) if plan["asi"] else None
            roll = b.get("roll")
            if roll is not None and (not isinstance(roll, int) or not 1 <= roll <= cls["hd"]):
                raise ValueError(f"A hit die roll is 1 to {cls['hd']}")
            result = B.apply_level(root, cls, rules, roll=roll, asi=asi, choices=b.get("choices"), feats=cdx.feats)
        except (ValueError, KeyError, TypeError) as err:
            return _fail(str(err) or "That level-up is not allowed")
        party._write(cid, root)
    return jsonify(result=result, character=party.detail(cid, party._peek(cid)))
