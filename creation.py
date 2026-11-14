"""creation.py - the web side of character creation and level-up: the rule book routes, POST /api/party/create and GET / POST /api/party/<id>/levelup.

charbuild.py makes the changes to the XML and rules5e.py reads the Open5e rule book (classes, races, backgrounds, feats, weapons, armor); this file checks what the
page sends, fetches what it needs, and saves the result through party.py (so the new character has an owner, a file and an id like any other).

WHO MAY: a player creates characters for themselves (the owner is always them) and levels their own; the DM creates for anyone (an optional "owner") and levels any.
The rule book routes (/api/rules/...) and the spell catalogue are open to players like the spell and item searches.

ROUTES
  GET  /api/rules/<kind>                       classes | races | backgrounds | feats -> [{slug, name, source, ...}]
  GET  /api/rules/classes/<slug>               the parsed class (levels table, skills, sub-classes) without the feature texts
  GET  /api/rules/classes/<slug>/subclass/<s>  the features of one sub-class [{name, level, text}]
  GET  /api/rules/races/<slug> | /api/rules/backgrounds/<slug>      the parsed race (with sub-races) / background
  GET  /api/rules/equipment?class=<slug>&background=<slug>          the starting equipment choices, each option already turned into items
  POST /api/party/create                       see create() for the body -> {id, character}
  GET  /api/party/<id>/levelup?class=<slug>    what the next level in that class brings (and why a multiclass is refused) -> plan
  POST /api/party/<id>/levelup                 {class, roll, asi, subclass} -> {result, character}
"""
import re
import random
import xml.etree.ElementTree as ET

from flask import Blueprint, jsonify, request

import auth
import charbuild as B
import encounters
import fcedit
import party
import rules5e as R

bp = Blueprint("creation", __name__)


def _fail(message, code=400):
    return jsonify(error=message), code


@bp.errorhandler(RuntimeError)
def _no_net(e):
    return jsonify(error=str(e)), 502


@bp.errorhandler(LookupError)
def _missing(e):
    return jsonify(error=str(e)), 404


def _record(kind, slug):
    try:
        return R.record(kind, slug)
    except ValueError:
        raise LookupError("No such entry")


def _cls(slug):
    return R.parse_class(_record("classes", slug))


# ================================================================================================================ the rule book
@bp.get("/api/rules/<kind>")
def rules_list(kind):
    if kind not in ("classes", "races", "backgrounds", "feats"):
        return _fail("Unknown kind", 404)
    rows = R.index(kind)
    if kind == "feats":
        return jsonify([{"slug": r["slug"], "name": r["name"], "source": r["source"], "prerequisite": r["record"].get("prerequisite") or "",
                         "text": " ".join([r["record"].get("desc") or ""] + [f"• {e}" for e in r["record"].get("effects_desc") or []]).strip()} for r in rows])
    return jsonify([{"slug": r["slug"], "name": r["name"], "source": r["source"]} for r in rows])


@bp.get("/api/rules/classes/<slug>")
def rules_class(slug):
    c = _cls(slug)
    c.pop("featureText")
    return jsonify(c)


@bp.get("/api/rules/classes/<slug>/subclass/<sub>")
def rules_subclass(slug, sub):
    return jsonify(R.subclass_features(_record("classes", slug), sub))


@bp.get("/api/rules/races/<slug>")
def rules_race(slug):
    return jsonify(R.parse_race(_record("races", slug)))


@bp.get("/api/rules/backgrounds/<slug>")
def rules_background(slug):
    return jsonify(R.parse_background(_record("backgrounds", slug)))


def _gear():
    return R.index("weapons"), R.index("armor")


def _resolve(text, weapons, armors):
    """Turn an equipment text ("a light crossbow and 20 bolts") into [{name, qty, kind: "weapon"|"armor"|"gear"|"coin", fields?}]: items found in the weapon and armor lists
    carry their Fight Club fields; the rest are plain gear (its name as written)."""
    out = []
    for it in R.items_in(text):
        if "coin" in it:
            out.append({"name": f"{it['qty']} {it['coin']}", "qty": it["qty"], "kind": "coin", "coin": it["coin"]})
            continue
        hit = R.find_gear(it["name"], weapons, armors)
        if hit and hit[0] == "weapon":
            out.append({"name": hit[1]["name"], "qty": it["qty"], "kind": "weapon", "fields": R.weapon_item(hit[1], it["qty"])})
        elif hit:
            out.append({"name": hit[1]["name"], "qty": it["qty"], "kind": "armor", "fields": R.armor_item(hit[1], it["qty"])})
        else:
            name = it["name"][:1].upper() + it["name"][1:]
            out.append({"name": name, "qty": it["qty"], "kind": "gear", "fields": {"name": name, "type": "15", "detail": "Adventuring Gear", "quantity": it["qty"]}})
    return out


@bp.get("/api/rules/equipment")
def rules_equipment():
    cls = _cls(request.args.get("class", ""))
    bg = R.parse_background(_record("backgrounds", request.args["background"])) if request.args.get("background") else None
    weapons, armors = _gear()
    lines = []
    for ch in R.equipment_choices(cls["equipment"]):
        if "options" in ch:
            lines.append({"options": [{"text": o, "items": _resolve(o, weapons, armors)} for o in ch["options"]]})
        else:
            lines.append({"fixed": {"text": ch["fixed"], "items": _resolve(ch["fixed"], weapons, armors)}})
    return jsonify({"lines": lines, "background": _resolve(bg["equipment"], weapons, armors) if bg else [], "wealth": cls["wealth"]})


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
    """POST /api/party/create -> {"id", "character"}. Body:
      name, level (1-20), owner (the DM only; a player's characters are always theirs)
      race (slug), subrace (slug or ""), raceChoices [ability index per "choose" bonus], looks {age, height, weight, eyes, skin, hair}
      background (slug), bgSkills [skill index per "of your choice"]
      class (slug), subclass (slug, needed from the level the class picks one), skills [the class's skill choices]
      abilityMethod (standard | pointbuy | roll | manual), abilities [six base scores]
      hpRolls [die rolled for each level 2..level] (omit or null = the average)
      asi [one decision per ability score improvement reached: {type: "asi", inc: [i, j]} or {type: "feat", feat: {name, text, ability?}}]
      equipment {mode: "package" | "gold" | "none", picks [option index per choice line], gold: the rolled amount}
      spells {cantrips: [slug], spells: [slug]}"""
    user = auth.current_user()
    b = request.get_json(force=True, silent=True) or {}
    try:
        name = party._text(b.get("name"), 80)
        level = int(b.get("level") or 1)
        if not name:
            raise ValueError("Give the character a name")
        if not 1 <= level <= 20:
            raise ValueError("The level is 1 to 20")
        cls = _cls(str(b.get("class") or ""))
        race = R.parse_race(_record("races", str(b.get("race") or "")))
        bg = R.parse_background(_record("backgrounds", str(b.get("background") or "")))
        _validate_abilities(b.get("abilityMethod"), b.get("abilities"))
        sub = next((s for s in race["subraces"] if s["slug"] == b.get("subrace")), None)
        if race["subraces"] and sub is None:
            raise ValueError(f"Choose a {race['name']} subrace")
        # race: bonuses and the player's picks
        bonuses, picks = dict(race["bonuses"]), list(race["choices"])
        if sub:
            for k, v in sub["bonuses"].items():
                bonuses[k] = bonuses.get(k, 0) + v
            picks += sub["choices"]
        chosen = b.get("raceChoices") or []
        if len(chosen) != len(picks) or any(not isinstance(i, int) or not 0 <= i < 6 for i in chosen) or len(set(chosen)) != len(chosen) or any(i in bonuses for i in chosen):
            raise ValueError("Choose the abilities your race raises (each a different one)")
        mods = list(bonuses.items()) + [(i, v) for i, v in zip(chosen, picks)]
        # skills
        class_skills = b.get("skills") or []
        if len(class_skills) != cls["skills"]["count"] or len(set(class_skills)) != len(class_skills) or any(s not in cls["skills"]["options"] for s in class_skills):
            raise ValueError(f"Choose {cls['skills']['count']} class skills from the list")
        bg_extra = b.get("bgSkills") or []
        if len(bg_extra) != bg["extraSkills"] or any(not isinstance(s, int) or not 0 <= s < 18 for s in bg_extra):
            raise ValueError(f"Choose {bg['extraSkills']} more background skill(s)" if bg["extraSkills"] else "This background has no skills to choose")
        bg_skills = bg["skills"] + bg_extra
        if len(set(bg_skills + class_skills)) != len(bg_skills) + len(class_skills):
            raise ValueError("A skill cannot come from both the class and the background: choose another")
        sub_feats = []
        if cls["subclass"]["options"] and level >= cls["subclass"]["level"]:
            slug = str(b.get("subclass") or "")
            if slug not in {o["slug"] for o in cls["subclass"]["options"]}:
                raise ValueError(f"Choose a {cls['subclass']['label'].lower()}")
            sub_feats = R.subclass_features(_record("classes", cls["slug"]), slug)
        # the shell, then level 1, then one apply_level per further level
        uid = _next_uid()
        ch = B.new_character(uid=uid, name=name, base_abilities=b["abilities"], looks=b.get("looks"),
                             race={"name": sub["name"] if sub else race["name"], "speed": race["speed"], "size": race["size"],
                                   "feats": race["feats"] + (sub["feats"] if sub else []), "mods": mods},
                             background={"name": bg["name"], "skills": bg_skills, "feats": ([{"name": "Description", "text": bg["desc"]}] if bg["desc"] else []) +
                                         ([{"name": bg["feature"]["name"], "text": bg["feature"]["text"]}] if bg["feature"]["name"] else [])})
        asi_levels = [lv for lv in cls["asiLevels"] if lv <= level]
        decisions = b.get("asi") or []
        if len(decisions) != len(asi_levels):
            raise ValueError(f"Make {len(asi_levels)} ability score improvement choice(s)" if asi_levels else "No ability score improvements yet at this level")
        rolls = b.get("hpRolls") or []
        for lv in range(1, level + 1):
            asi = B.validate_asi(ch, decisions[asi_levels.index(lv)]) if lv in asi_levels else None
            roll = rolls[lv - 2] if lv >= 2 and lv - 2 < len(rolls) else None
            if roll is not None and (not isinstance(roll, int) or not 1 <= roll <= cls["hd"]):
                raise ValueError(f"A hit die roll is 1 to {cls['hd']}")
            feats = [{"name": f["name"], "text": f["text"]} for f in sub_feats if f["level"] == lv]
            B.apply_level(ch, cls, {}, roll=roll, asi=asi, subclass_feats=feats)
            if lv == 1:
                B.add_class_skills(ch, cls["name"], class_skills)
        put_hp = party._num(party._t(ch, "hpMax"))
        fcedit.put(ch, "hpCurrent", int(put_hp))
        # spells
        _, shown = B.abilities(ch)
        allow = B.spell_allowance(cls, level, shown)
        want = b.get("spells") or {}
        cantrips, spells = list(want.get("cantrips") or []), list(want.get("spells") or [])
        if len(cantrips) > allow["cantrips"] or len(spells) > allow["spells"]:
            raise ValueError(f"{cls['name']} gets {allow['cantrips']} cantrips and {allow['spells']} spells at level {level}")
        klass = next(c for c in ch.findall("class"))
        for slug in cantrips + spells:
            f = encounters.SPELLS.full(slug)
            if cls["name"].lower() not in (f.get("dnd_class") or "").lower():
                raise ValueError(f"{f.get('name', slug)} is not a {cls['name']} spell")
            if (slug in cantrips) != (int(f.get("level_int") or 0) == 0):
                raise ValueError(f"{f.get('name', slug)} is in the wrong list (cantrips and spells)")
            klass.append(B.spell_element(f, cls["name"]))
        # equipment
        _equip(ch, cls, bg, b.get("equipment") or {})
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


def _equip(ch, cls, bg, eq):
    """Starting equipment: the class's choices and the background's items (mode "package"), or starting gold instead (mode "gold"), or nothing. Armor, a shield and one weapon are
    put on / in hand. Background gold becomes coins."""
    mode = eq.get("mode") or "none"
    if mode == "none":
        return
    weapons, armors = _gear()
    items, coins = [], {}
    if mode == "gold":
        gold = int(eq.get("gold") or 0)
        if not 0 <= gold <= _wealth_max(cls["wealth"]):
            raise ValueError(f"Starting gold for a {cls['name']} is at most {_wealth_max(cls['wealth'])}")
        coins["gp"] = gold
    elif mode == "package":
        lines = R.equipment_choices(cls["equipment"])
        picks = eq.get("picks") or []
        for n, line in enumerate(lines):
            if "options" in line:
                k = picks[n] if n < len(picks) else 0
                if not isinstance(k, int) or not 0 <= k < len(line["options"]):
                    raise ValueError("Choose one of the options for each line of equipment")
                items += _resolve(line["options"][k], weapons, armors)
            else:
                items += _resolve(line["fixed"], weapons, armors)
    else:
        raise ValueError("Unknown equipment choice")
    items += _resolve(bg["equipment"], weapons, armors)
    for it in items:
        if it["kind"] == "coin":
            coins[it["coin"]] = coins.get(it["coin"], 0) + it["qty"]
        else:
            ch.insert(_item_slot(ch), B.item_element(it["fields"]))
    for coin, n in coins.items():
        fcedit.change_coin(ch, coin, n)
    # put the best armor on, a shield and a weapon in hand
    loose = ch.findall("item")
    for kind_tags, once in ((("1", "2", "3"), True), (("4",), True), (("5",), True)):
        for i, it in enumerate(loose):
            if party._t(it, "type") in kind_tags:
                try:
                    fcedit.equip(ch, f"i{i}", True)
                except ValueError:
                    pass
                if once:
                    break


def _item_slot(ch):
    """Where a new item goes among the character's children: after the last item, else after the feats / containers, before the slots."""
    kids = list(ch)
    last = max((i for i, k in enumerate(kids) if k.tag == "item"), default=None)
    if last is not None:
        return last + 1
    last = max((i for i, k in enumerate(kids) if k.tag in ("feat", "container", "class")), default=len(kids) - 1)
    return last + 1


# ================================================================================================================ level up
def _rules_of(root):
    """{class name: parsed class} for every class the character has that the rule book knows."""
    out = {}
    for c in root.findall("class"):
        name = party._t(c, "name")
        try:
            out[name] = _cls(re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"))
        except (LookupError, RuntimeError):
            pass
    return out


@bp.get("/api/party/<cid>/levelup")
def levelup_plan(cid):
    """GET /api/party/<id>/levelup[?class=<slug>] -> what the next level brings. Without `class`: {classes [{name, slug, level}], total, canLevel, options [the classes a multiclass could
    take: {slug, name, problems [messages]}]}. With it: the plan (charbuild.plan_next_level) plus `problems` (why a multiclass is refused) and `asiFeats` (feats to pick from)."""
    party._guard(cid)
    root = party._peek(cid)
    rules = _rules_of(root)
    total = B.total_level(root)
    mine = [{"name": party._t(c, "name"), "slug": re.sub(r"[^a-z0-9]+", "-", party._t(c, "name").lower()).strip("-"), "level": int(party._num(party._t(c, "level"), 1))} for c in root.findall("class")]
    slug = request.args.get("class")
    if not slug:
        opts = []
        for r in R.index("classes"):
            if any(m["slug"] == r["slug"] for m in mine):
                continue
            try:
                problems = B.multiclass_problems(root, _cls(r["slug"]), rules)
            except (LookupError, RuntimeError):
                continue
            opts.append({"slug": r["slug"], "name": r["name"], "problems": problems})
        return jsonify(classes=mine, total=total, canLevel=total < 20, options=opts, xp=int(party._num(party._t(root, "xp"))), xpNext=R.XP_FOR_LEVEL[total] if total < 20 else None)
    cls = _cls(slug)
    own = any(m["slug"] == slug for m in mine)
    problems = [] if own else B.multiclass_problems(root, cls, rules)
    plan = B.plan_next_level(root, cls, rules)
    plan["problems"] = problems
    plan["class"] = {"name": cls["name"], "slug": cls["slug"]}
    plan["subclass"] = {"label": cls["subclass"]["label"], "options": cls["subclass"]["options"]} if plan["subclassNow"] else None
    return jsonify(plan)


@bp.post("/api/party/<cid>/levelup")
def levelup_apply(cid):
    """POST /api/party/<id>/levelup {class: slug, roll: die rolled or null for the average, asi: decision (when the level has one), subclass: slug (when it asks)} ->
    {result: {level, classLevel, hpGain, features}, character}. Refused with 400 and a message when a rule is broken."""
    party._guard(cid)
    b = request.get_json(force=True, silent=True) or {}
    with party.lock:
        root = party._load(cid)
        try:
            cls = _cls(str(b.get("class") or ""))
            rules = _rules_of(root)
            own = any(party._t(c, "name") == cls["name"] for c in root.findall("class"))
            if not own:
                problems = B.multiclass_problems(root, cls, rules)
                if problems:
                    raise ValueError("; ".join(problems))
            plan = B.plan_next_level(root, cls, rules)
            asi = None
            if plan["asi"]:
                asi = B.validate_asi(root, b.get("asi"))
            roll = b.get("roll")
            if roll is not None and (not isinstance(roll, int) or not 1 <= roll <= cls["hd"]):
                raise ValueError(f"A hit die roll is 1 to {cls['hd']}")
            feats = []
            if plan["subclassNow"]:
                slug = str(b.get("subclass") or "")
                if slug not in {o["slug"] for o in cls["subclass"]["options"]}:
                    raise ValueError(f"Choose a {cls['subclass']['label'].lower()}")
                feats = [{"name": f["name"], "text": f["text"]} for f in R.subclass_features(_record("classes", cls["slug"]), slug) if f["level"] <= plan["classLevel"]]
            else:   # a sub-class chosen earlier brings more at this level: its features are looked up by the name saved on the class
                feats = _later_subclass_features(root, cls, plan["classLevel"])
            result = B.apply_level(root, cls, rules, roll=roll, asi=asi, subclass_feats=feats)
        except (ValueError, KeyError, TypeError) as err:
            return _fail(str(err) or "That level-up is not allowed")
        party._write(cid, root)
    return jsonify(result=result, character=party.detail(cid, party._peek(cid)))


def _later_subclass_features(root, cls, level):
    """The features of the sub-class the character already has that arrive at class level `level` (found by the "<label>: <name>" feature saved when it was chosen)."""
    c = next((c for c in root.findall("class") if party._t(c, "name") == cls["name"]), None)
    if c is None:
        return []
    label = cls["subclass"]["label"] + ": "
    mark = next((party._t(f, "name") for f in c.findall("feat") if party._t(f, "name").startswith(label)), "")
    if not mark:
        return []
    chosen = mark[len(label):]
    arch = next((o for o in cls["subclass"]["options"] if o["name"] == chosen), None)
    if not arch:
        return []
    return [{"name": f["name"], "text": f["text"]} for f in R.subclass_features(_record("classes", cls["slug"]), arch["slug"]) if f["level"] == level and f["name"] != mark]
