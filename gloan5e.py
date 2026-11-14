"""gloan5e.py - the Gloan5e character file: a Fight Club backup PLUS the extras this app keeps beside it, in one file that is easy to take apart.

THE IDEA
The app stores a character as two linked parts, never merged: the Fight Club XML (data/party/<id>.xml, byte-for-byte what Fight Club understands) and a
small record of EXTRAS (data/party_extra.json: trackers, conditions, death saves, which items are worn and attuned ...). The two are linked by the
character's own <uid>. A Gloan5e file is those two parts side by side:

    <name>.gloan5e      a zip file holding
      FightClub5.backup   the Fight Club backup, EXACTLY as the "Fight Club 5e" download would be (no change to a single byte)
      gloan.json          {"format": "gloan5e", "version": 1, "characters": {"<uid>": {extras}}}
      README.txt          how to turn it back into a Fight Club file

Stripping it back is one step: take FightClub5.backup out (strip()). Nothing in the Fight Club part was changed to make room for the extras, so
Fight Club never sees them. A file's type is told at once by its extension (.gloan5e) and by the marker entry gloan.json inside (is_gloan()).

LOADING: load() reads either kind and always returns the same thing, a Gloan5e record (the Fight Club bytes plus the extras). A Fight Club file simply has
no extras: the Fight Club loader converts straight to Gloan5e that way.

Pure functions on bytes and dicts: no Flask, no files.
"""
import io
import json
import zipfile

EXT = ".gloan5e"
FC_ENTRY = "FightClub5.backup"
MARK_ENTRY = "gloan.json"
VERSION = 1
EXTRA_KEYS = ("trackers", "conditions", "deaths", "worn", "attuned")   # what travels with a character (never the owner or pending gifts: they belong to one server)
README = (
    "This is a Gloan5e file: a Fight Club 5e backup plus extras.\n\n"
    f"  {FC_ENTRY}  the Fight Club backup, unchanged. Import it into Fight Club 5e as it is.\n"
    f"  {MARK_ENTRY}      the extras this app adds (trackers, conditions, death saves, worn and attuned items), linked to each character by its uid.\n\n"
    "To convert back to Fight Club: unzip this file and use the .backup, or download \"Fight Club 5e\" from the app.\n"
)


def pack(fc_bytes, extras):
    """A Gloan5e file from Fight Club backup bytes and `extras` ({character uid: {trackers, conditions, deaths, worn, attuned}})."""
    meta = {"format": "gloan5e", "version": VERSION,
            "characters": {str(uid): {k: v for k, v in e.items() if k in EXTRA_KEYS and v not in (None, "", [], {})} for uid, e in extras.items()}}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(FC_ENTRY, fc_bytes)
        z.writestr(MARK_ENTRY, json.dumps(meta, indent=1))
        z.writestr("README.txt", README)
    return buf.getvalue()


def is_gloan(raw, filename=""):
    """Is this upload a Gloan5e file? By its marker entry (the content is the proof), or by the .gloan5e extension."""
    try:
        if zipfile.is_zipfile(io.BytesIO(raw)):
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                if MARK_ENTRY in z.namelist() and FC_ENTRY in z.namelist():
                    return True
    except zipfile.BadZipFile:
        pass
    return (filename or "").lower().endswith(EXT)


def unpack(raw):
    """-> (Fight Club backup bytes, extras by character uid) from a Gloan5e file. ValueError when it is not one."""
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            fc = z.read(FC_ENTRY)
            meta = json.loads(z.read(MARK_ENTRY))
    except (zipfile.BadZipFile, KeyError, ValueError) as e:
        raise ValueError(f"That is not a valid Gloan5e file ({e})")
    if meta.get("format") != "gloan5e":
        raise ValueError("That is not a Gloan5e file")
    return fc, {str(u): {k: v for k, v in (e or {}).items() if k in EXTRA_KEYS} for u, e in (meta.get("characters") or {}).items()}


def strip(raw):
    """Gloan5e file -> the plain Fight Club backup bytes inside it: the whole conversion back is taking this one entry out."""
    return unpack(raw)[0]


def load(raw, filename=""):
    """The loader for ANY upload: -> (Fight Club bytes, extras by uid, "gloan5e" | "fightclub5e"). A Fight Club file is converted to the Gloan5e record by
    giving it empty extras, so everything after this works on one shape."""
    if is_gloan(raw, filename):
        fc, extras = unpack(raw)
        return fc, extras, "gloan5e"
    return raw, {}, "fightclub5e"
