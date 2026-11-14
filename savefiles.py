"""savefiles.py - the saved files of the app: SOUNDBOARDS and CAMPAIGNS are separate things that point at each other.

THE MODEL
  A soundboard is the sound side of the board: its sections, sounds and timers.     data/soundboards/<name>.json   {sections, sounds, timers}
  A campaign is the campaign side: the tracker, the party and the combat.            data/presets/<name>.json       {campaign, party, initiative,
                                                                                                                       soundboard: {default, last}}
  A campaign names TWO soundboards: its DEFAULT (what loading the campaign from Home brings in) and the LAST one used with it (updated whenever a
  soundboard is loaded while that campaign is loaded; what starting the server brings in). Any soundboard can serve any campaign, and a campaign
  can be loaded without touching the soundboard.
  The LIVE state (data/live.json, in memory in app.py) is still the two together plus `campaignName`, `soundboardName` and `boardRefs`, so the pages
  do not change how they read it. The loaded soundboard autosaves into its own file (app.py: PUT /api/state); a campaign is saved when you press Save.

THE OLD FORMAT
  A campaign file used to hold the whole board (sections, sounds, timers ...) as well. split_legacy() turns each such file into a soundboard file
  (named after the campaign) plus a campaign file that points at it as both default and last; the original is copied into data/versions/ first.

Everything here works on plain dicts and folders: no Flask and no module state, so it can be tested on its own. app.py calls it.
"""
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

import board as board_model

BOARD_KEYS = ("sections", "sounds", "timers")                      # the soundboard side of the live state
CAMPAIGN_KEYS = ("campaign", "party", "initiative", "encounters", "loots")   # the campaign side (the last two: very old files, see encounters.adopt)
NOT_CAMPAIGN = BOARD_KEYS + ("tiles", "revision", "campaignName", "soundboardName", "boardRefs", "soundboard")
EMPTY_REFS = {"default": "", "last": ""}


def atomic_write(path: Path, obj):
    """Write `obj` as pretty JSON to `path` so a reader never sees a half-written file: write "<name>.tmp" completely, then rename it over the real
    name (rename is atomic on one filesystem, so the file is always the complete old version or the complete new one)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2))
    os.replace(tmp, path)


def read_json(path: Path, fallback=None):
    """Load JSON from `path`; `fallback` if the file is missing or unparsable (a corrupt file must never crash the server)."""
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def safe_name(name: str) -> str:
    """A name safe to use as a file name: letters, digits, space, underscore, dot and hyphen only, no leading or trailing dots, 60 characters at most.
    That strips slashes and other path tricks. May return ""."""
    return re.sub(r"[^A-Za-z0-9 _.-]", "", name or "").strip().strip(".")[:60]


def stamp():
    """Current local time as 'YYYYmmdd-HHMMSS' (names snapshot files so they sort by date)."""
    return datetime.now().strftime("%Y%m%d-%H%M%S")


# ------------------------------------------------------------------ soundboards
def board_part(state):
    """The soundboard side of a state: {sections, sounds, timers} (copies of the lists, so the file never aliases live data)."""
    return {k: json.loads(json.dumps(state.get(k, []))) for k in BOARD_KEYS}


def list_boards(boards: Path):
    return sorted(p.stem for p in boards.glob("*.json"))


def read_board(boards: Path, name):
    """A soundboard file as a dict, or None when there is no such soundboard."""
    p = boards / f"{safe_name(name)}.json"
    return read_json(p) if safe_name(name) and p.exists() else None


def write_board(boards: Path, name, state):
    """Save the soundboard side of `state` as soundboard `name`."""
    atomic_write(boards / f"{safe_name(name)}.json", board_part(state))


def delete_board(boards: Path, name):
    p = boards / f"{safe_name(name)}.json"
    if p.exists():
        p.unlink()


def unique_name(folder: Path, wanted, fallback="Soundboard"):
    """`wanted` made safe and not already used in `folder`: "Forest", "Forest (2)", "Forest (3)" ..."""
    base = safe_name(wanted) or fallback
    name, n = base, 2
    while (folder / f"{name}.json").exists():
        name = f"{base[:54]} ({n})"
        n += 1
    return name


# ------------------------------------------------------------------ campaigns
def campaign_part(state):
    """The campaign side of a state: every key that is not the soundboard or bookkeeping (campaign, party, initiative ...)."""
    return {k: v for k, v in state.items() if k not in NOT_CAMPAIGN}


def read_campaign(presets: Path, name):
    """A campaign file as a dict, or None."""
    p = presets / f"{safe_name(name)}.json"
    return read_json(p) if safe_name(name) and p.exists() else None


def refs_of(data):
    """The {default, last} soundboard names a campaign file holds (blank when it holds none)."""
    r = (data or {}).get("soundboard") or {}
    return {"default": str(r.get("default") or ""), "last": str(r.get("last") or "")}


def write_campaign(presets: Path, name, state, refs):
    """Save the campaign side of `state` as campaign `name`, pointing at the soundboards `refs` ({default, last})."""
    atomic_write(presets / f"{safe_name(name)}.json", {**json.loads(json.dumps(campaign_part(state))), "soundboard": {"default": refs.get("default", ""), "last": refs.get("last", "")}})


def set_refs(presets: Path, name, **changes):
    """Change `default` and/or `last` inside an existing campaign file. A missing file is left alone (returns False)."""
    data = read_campaign(presets, name)
    if data is None:
        return False
    refs = refs_of(data)
    refs.update({k: v for k, v in changes.items() if k in refs})
    data["soundboard"] = refs
    atomic_write(presets / f"{safe_name(name)}.json", data)
    return True


def campaigns_using(presets: Path, board):
    """The campaigns whose default or last soundboard is `board` (a soundboard that is still in use must not be deleted)."""
    out = []
    for p in sorted(presets.glob("*.json")):
        refs = refs_of(read_json(p, {}))
        if board in (refs["default"], refs["last"]):
            out.append(p.stem)
    return out


# ------------------------------------------------------------------ the old format
def split_legacy(presets: Path, boards: Path, versions: Path):
    """Turn every campaign file in the old whole-board format into a soundboard file + a campaign file that points at it (default and last). The old
    file is copied to data/versions/preset-<name>-before-split-<time>.json first. Returns [(campaign, soundboard)] for the files converted; running it
    again does nothing."""
    done = []
    for p in sorted(presets.glob("*.json")):
        data = read_json(p)
        if not isinstance(data, dict) or ("sounds" not in data and "tiles" not in data):
            continue
        shutil.copy2(p, versions / f"preset-{p.stem}-before-split-{stamp()}.json")
        board = unique_name(boards, p.stem)
        if "tiles" in data:   # even older still: sections > tiles > subsections: the app converts it when it loads (board.migrate_state)
            board_model.migrate_state(data)
        atomic_write(boards / f"{board}.json", board_part(data))
        rest = {k: v for k, v in data.items() if k not in NOT_CAMPAIGN}
        atomic_write(p, {**rest, "soundboard": {"default": board, "last": board}})
        done.append((p.stem, board))
    return done
