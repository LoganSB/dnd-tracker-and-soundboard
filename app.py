#!/usr/bin/env python3
"""DM Soundboard - a local D&D soundboard server.

Sounds from YouTube (via yt-dlp) and MyInstants are downloaded once into ./media
and served from this machine, so the browser can decode/buffer them up front and
playback is instant (no network round-trip, no embedded-player spin-up).

HOW THIS PROGRAM WORKS (read this first if you have never seen Flask)
---------------------------------------------------------------------
This file is a small web server. Think of it as a long-running C program with a main loop
that you never write: Flask owns the socket and the loop, and you only register callbacks.
A route like `@app.get("/api/state")` is the Python spelling of "put this function in the
dispatch table under the key (GET, /api/state)". The flow of one request is:

    browser  --HTTP request-->  Flask looks up (method, URL) in its table
             -->  your route function runs (it may read/write the in-memory `state`
                  and files on disk)
             -->  it returns a value; `jsonify(...)` turns a dict into a JSON text body
    browser  <--HTTP response--  (a `(body, 400)` tuple means "body, with HTTP status 400")

The browser page (templates/index.html and its JavaScript) does all the drawing; this file
only stores data and serves files. "JSON" is just structured text: {"a": 1, "b": [1, 2]}.
Python dicts/lists map directly onto it (dict ~ hash table, list ~ dynamic array).

Where data lives on disk (all paths are relative to the folder holding this file):
  data/live.json       - live state, autosaved on every change
  data/versions/*.json - snapshot of the previous live state, once per server start
                         (also taken just before a preset load or version restore)
  data/presets/*.json  - your saved CAMPAIGNS (named whole-board snapshots; the folder keeps its old name)
  data/config.json     - launch behaviour (which campaign, if any, loads at start)
  data/users.json      - accounts and invites (see auth.py)
  media/               - downloaded audio files (<key>.<ext>) plus a <key>.json with the title
  mp3s/                - YOUR OWN audio files. Drop files in (or use Browse in the sound dialog, which
                         uploads into it); a background thread notices additions and removals and the
                         page offers them in a drop-down. Sounds refer to them as "library:<file name>".
Files owned by party.py (see that file): data/party/*.xml, data/party_extra.json,
data/initiative.json. Accounts, sign-in and the DM / player permission levels are in auth.py.

How the files connect: party.py defines a Flask "Blueprint" (a bundle of routes written in
another file). This file imports it and calls app.register_blueprint(), which merges those
routes into the same dispatch table. Both files therefore run inside ONE process.

Concurrency in one paragraph: Flask is started with threaded=True, so each request may run
on its own thread, and media downloads run on extra background threads. Shared data (the
`state` dict, `jobs` dict) is protected by `lock`, which is a mutex (an RLock: the same
thread may take it twice without deadlocking, like a recursive mutex).

Run:  python app.py [--live | --campaign NAME] [--port 5000] [--host 127.0.0.1]

Running in a container / on a server (see DEPLOY-GOOGLE-CLOUD.md): a production web server (gunicorn)
imports this file instead of running it, and these environment variables (settings given to the
process from outside) configure it:
  DND_DATA_ROOT  folder that holds data/, media/ and mp3s/ (default: the folder next to this file).
                 In the container it is a mounted volume, so your data survives restarts.
  DND_PASSWORD   the setup key for creating the first DM account on a deployed copy; setting it also locks
                 the site until that account exists. Leave it unset on your own computer, where the site
                 stays open (everyone is the DM) until you create an account. More settings, such as
                 Google sign-in, are listed at the top of auth.py.
  PORT           the port gunicorn listens on (Cloud Run sets it; see gunicorn.conf.py).
"""
import argparse
import hashlib
import json
import logging
import mimetypes
import os
import re
import select
import shutil
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urljoin, quote

import requests
from flask import Flask, Response, abort, jsonify, render_template, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import safe_join

import auth

# ---- paths and constants. Path objects overload "/" to join path components.
# __file__ is this script; resolve() makes it absolute; .parent is its folder.
BASE = Path(__file__).resolve().parent
# ROOT: where all the saved data lives. Normally the folder next to this file; in a container the
# DND_DATA_ROOT environment variable points it at a mounted volume so data outlives the container.
ROOT = Path(os.environ.get("DND_DATA_ROOT") or BASE)
DATA = ROOT / "data"
MEDIA = ROOT / "media"
LIBRARY = ROOT / "mp3s"  # the user's own audio files (scanned by library_watcher below)
PRESETS = DATA / "presets"
VERSIONS = DATA / "versions"
LIVE = DATA / "live.json"
CONFIG = DATA / "config.json"
# Make sure all the folders exist before anything tries to write into them
# (like `mkdir -p`; exist_ok means "not an error if it is already there").
for d in (DATA, MEDIA, LIBRARY, PRESETS, VERSIONS):
    d.mkdir(parents=True, exist_ok=True)

# Log lines go to standard error. On Cloud Run that is collected into Cloud Logging, where
# `gcloud run services logs read` and the Logs Explorer show them; run locally they appear in the terminal.
logging.basicConfig(level=logging.INFO, format="%(levelname)s dnd: %(message)s")
log = logging.getLogger("dnd")

# Some sites reject requests without a browser-like User-Agent header.
UA = {"User-Agent": "Mozilla/5.0 (DM-Soundboard)"}
MAX_BYTES = 150 * 1024 * 1024  # download size cap: 150 MiB per sound
AUDIO_EXT = (".mp3", ".ogg", ".wav", ".m4a", ".webm", ".opus", ".aac", ".flac")

# The Flask application object: owns the route table and the HTTP machinery.
app = Flask(__name__)
# Reject request bodies bigger than a download (plus 1 MiB for the form around an uploaded file).
# Flask then answers 413 before reading the whole thing into memory (see too_large below).
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES + 1024 * 1024
# One process-wide mutex guarding `state`, `jobs` and the files written from them.
lock = threading.RLock()

# Behind Cloud Run (or any proxy) the browser's real address and HTTPS-ness arrive in X-Forwarded-* headers.
# ProxyFix believes ONE proxy's worth of them, so request.is_secure, request.remote_addr and url_root are
# the real values (the session cookie's Secure flag and the sign-in attempt limiter depend on them).
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Run before EVERY request: auth.check_request decides whether this visitor (signed out, player or DM)
# may reach this address. See auth.py for the rules.
app.before_request(auth.check_request)
app.register_blueprint(auth.bp)


@app.get("/healthz")
def healthz():
    """GET /healthz : answers "ok" so a container platform can tell the process is alive. No password."""
    return "ok"


# ----------------------------------------------------------------- helpers
def default_state():
    """Return a fresh, empty soundboard: four named tiles with no sounds.

    State shape (this is also exactly what is saved to data/live.json):
      {"revision": int,                    # bumped on each save so clients can detect changes
       "tiles": [{"id", "name", "pinned", "sounds": [ {url, name, ...}, ... ]}, ...]}
    "Tile" = one panel of sound buttons on the page; "pinned" tiles stay visible.
    """
    # A nested function: just a local helper that builds one tile dict.
    def tile(tid, name, pinned=False):
        return {"id": tid, "name": name, "pinned": pinned, "sounds": []}
    return {
        "revision": 0,
        "tiles": [
            tile("main", "Main / Persistent", True),
            tile("challenge-1", "Challenge 1"),
            tile("secret-challenge", "Secret Challenge"),
            tile("end-boss", "End Boss"),
        ],
    }


def atomic_write(path: Path, obj):
    """Write `obj` as pretty JSON to `path` so a reader never sees a half-written file.

    Why: if the program crashes (or loses power) in the middle of a plain write, the real
    file would be left truncated and all saved data lost. Instead we write a sibling
    "<name>.tmp" file completely, then os.replace() it over the real name. That is the C
    pattern "write temp file, then rename()": rename is atomic on one filesystem, so the
    file is always either the complete old version or the complete new one.
    """
    tmp = path.with_suffix(path.suffix + ".tmp")  # e.g. live.json -> live.json.tmp
    tmp.write_text(json.dumps(obj, indent=2))
    os.replace(tmp, path)


def read_json(path: Path, fallback=None):
    """Load JSON from `path`; return `fallback` if the file is missing or unparsable.

    The blanket `except Exception` is deliberate: a missing or corrupt file should make the
    server fall back to defaults, never crash it.
    """
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def safe_name(name: str) -> str:
    """Sanitize a user-supplied name so it is safe to use as a file name.

    The regex [^A-Za-z0-9 _.-] matches any character that is NOT a letter, digit, space,
    underscore, dot or hyphen; those are deleted. That strips slashes and other
    path-tricks (so "../../x" cannot escape the folder). We then trim whitespace and dots
    from the ends and cap the length at 60. `name or ""` handles None. May return "".
    """
    name = re.sub(r"[^A-Za-z0-9 _.-]", "", name or "").strip().strip(".")
    return name[:60]


def stamp():
    """Current local time as 'YYYYmmdd-HHMMSS', used to name snapshot files (sorts by date)."""
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def keep_campaign(new):
    """Carry the current campaign data into `new` when `new` has none of its own.

    Used when a preset or an old version replaces the state: presets saved before the campaign
    tracker existed contain no campaign, and loading one must not wipe the campaign progress.
    A preset that does contain a campaign replaces it, as intended. Returns `new`.
    """
    if "campaign" not in new and "campaign" in state:
        new["campaign"] = state["campaign"]
    if "party" not in new and "party" in state:  # likewise a campaign saved before party lists existed
        new["party"] = state["party"]
    return new


def validate_state(s):
    """Check that `s` looks like a soundboard state and tidy it. Returns `s`.

    Raises ValueError if it is not a dict with a "tiles" list (callers turn that into an
    HTTP 400 or ignore it). Side effect: deletes runtime-only keys from every sound.
    """
    if not isinstance(s, dict) or not isinstance(s.get("tiles"), list):
        raise ValueError("state must contain a 'tiles' list")
    for t in s["tiles"]:  # drop runtime-only fields ("_last" etc.) an older client may have saved
        for snd in t.get("sounds", []):
            # Keys starting with "_" are scratch values the browser uses while playing.
            # Build the key list first (the list comprehension) so we are not deleting
            # from the dict while iterating over it.
            for k in [k for k in snd if k.startswith("_")]:
                del snd[k]
    return s


# ------------------------------------------------------------------- state
# The authoritative in-memory copy of the soundboard. The browser asks for it via
# GET /api/state and replaces it via PUT /api/state; every change is mirrored to LIVE.
state = default_state()


def save_live():
    """Write the in-memory `state` to data/live.json (autosave). Takes the lock so no other
    thread changes `state` mid-write; atomic_write protects against crashes."""
    with lock:  # `with` ~ RAII: the lock is released automatically when the block exits
        atomic_write(LIVE, state)


def snapshot_previous_live(tag="start"):
    """Copy the existing live file into data/versions/ and return the new file's name.

    Called once per server start, BEFORE startup() overwrites live.json, so you always
    have a copy of how things looked the last time the server was running (the "versions"
    history shown in the UI). Returns None if there was nothing (or an empty file) to keep.
    Not done on every save: that would create thousands of near-identical files.
    """
    if LIVE.exists() and LIVE.stat().st_size:
        dest = VERSIONS / f"live-{stamp()}-{tag}.json"  # f-string ~ snprintf
        shutil.copy2(LIVE, dest)  # copy2 also preserves the file's timestamps
        prune_start_snapshots()
        return dest.name
    return None


def prune_start_snapshots(keep=50):
    """Keep only the newest `keep` automatic start-up snapshots in data/versions/.

    In a container that scales to zero the server "starts" every time someone opens the page after a
    quiet spell, which would otherwise pile up snapshots forever. Only files named "...-start.json"
    are pruned (the names sort by date); snapshots made before a preset load or restore, and anything
    else, are never deleted here. Errors are ignored: pruning is housekeeping, not important.
    """
    try:
        old = sorted(VERSIONS.glob("live-*-start.json"))[:-keep]  # [:-keep] = everything except the newest `keep`
        for f in old:
            f.unlink()
    except OSError:
        pass


def startup(args):
    """Decide what to load at launch (live changes vs. a saved preset) and set `state`.

    `args` is the argparse result (args.live / args.preset). Priority, highest first:
      1. --live         -> load live.json
      2. --preset NAME  -> load that preset
      3. data/config.json says mode "preset" -> load that preset, but only if we are
         attached to a real terminal; then give the user 5 seconds to type "L" + Enter
         to override and load live changes instead. (No terminal = no prompt, e.g. when
         started by another program, so it can never hang waiting for a key.)
      4. otherwise live.json if it exists, else built-in defaults.
    Side effects: writes a version snapshot, rewrites live.json, prints status lines, and
    starts background downloads for every sound the loaded state references.
    """
    # `global` is needed to ASSIGN to the module-level `state` from inside a function;
    # without it Python would create a new local variable of the same name.
    global state
    cfg = read_json(CONFIG, {"launch": {"mode": "live", "preset": None}})
    launch = cfg.get("launch", {})
    # Tuple assignment: both names are set in one statement.
    mode, preset = launch.get("mode", "live"), launch.get("preset")

    if args.live:
        mode = "live"
    elif args.preset:  # --campaign is the same option under its newer name
        mode, preset = "preset", args.preset
    elif mode == "preset" and preset and sys.stdin.isatty():
        print(f"\nLaunch campaign: '{preset}'. Press L + Enter within 5s to load live changes instead...",
              flush=True)
        # select() ~ the C select(2) call: wait up to 5 s for stdin to become readable
        # (i.e. the user pressed Enter). Returns three lists; we only need the "readable" one.
        r, _, _ = select.select([sys.stdin], [], [], 5)
        # If something arrived, read the line; any answer starting with l/L means "live".
        if r and sys.stdin.readline().strip().lower().startswith("l"):
            mode = "live"

    snap = snapshot_previous_live()
    if snap:
        print(f"Saved version snapshot of previous live state: data/versions/{snap}")

    loaded = None
    if mode == "preset" and preset and (PRESETS / f"{safe_name(preset)}.json").exists():
        state = validate_state(read_json(PRESETS / f"{safe_name(preset)}.json"))
        if "campaign" not in state:  # an older preset: keep the campaign progress from live.json
            old_live = read_json(LIVE, {})
            if isinstance(old_live, dict) and "campaign" in old_live:
                state["campaign"] = old_live["campaign"]
        state["campaignName"] = safe_name(preset)
        loaded = f"campaign '{preset}'"
    elif LIVE.exists():
        state = validate_state(read_json(LIVE, default_state()))
        loaded = "live changes"
    else:
        loaded = "defaults"
    state.setdefault("revision", 0)  # setdefault: set the key only if it is missing
    save_live()
    print(f"Loaded {loaded}.")
    resume_media_for_state()
    library_scan()  # fill the MP3 folder listing now...
    threading.Thread(target=library_watcher, daemon=True).start()  # ...and keep it fresh


# ------------------------------------------------------------------- media
# Download bookkeeping: media key -> {"status": "downloading"|"ready"|"error",
# "title": str, "error": str}. Lives only in memory (rebuilt from disk after a restart).
# Guarded by `lock` where it is read-then-written (see ensure_media).
jobs = {}  # key -> {status, title, error}


def youtube_id(url):
    """Extract the 11-ish character video id from a YouTube URL, or None if not YouTube.

    Handles youtu.be/<id>, youtube.com/watch?v=<id>, and /shorts/, /embed/, /live/ paths.
    """
    p = urlparse(url)  # splits a URL into scheme, hostname, path, query ...
    # Normalise the host: lowercase, drop a leading "www." or "m." (mobile site).
    host = (p.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    if host == "youtu.be":
        # Short links put the id in the path: https://youtu.be/<id>
        return p.path.strip("/").split("/")[0] or None
    if host in ("youtube.com", "music.youtube.com"):
        if p.path == "/watch":
            # parse_qs gives {"v": ["<id>"], ...}; take the first "v" value or None.
            return parse_qs(p.query).get("v", [None])[0]
        # Regex: start of path, "/shorts/" or "/embed/" or "/live/", then capture a run of
        # 6+ word characters or hyphens (the id). group(2) is that captured id.
        m = re.match(r"^/(shorts|embed|live)/([\w-]{6,})", p.path)
        if m:
            return m.group(2)
    return None


def classify(url):
    """Decide what kind of sound URL this is and give it a stable cache key.

    Returns (kind, key) where kind is "youtube", "myinstants", "direct" or "library", and key is a
    short filesystem-safe id used as the file name under media/ and in /api/media/<key>.
    Raises ValueError for anything else.

    Why only these hosts: the server downloads whatever URL it is given, so accepting
    arbitrary URLs would let anyone who can reach the page make this machine fetch internal
    addresses (an "SSRF" hole) or huge/odd files. Restricting to YouTube, MyInstants and
    URLs whose path ends in an audio extension keeps it to the intended use.

    Key scheme (same URL -> same key, so a sound is downloaded only once and every tile
    that uses it shares one file):
      yt-<video id>            - the YouTube id is already unique and short
      mi-<12 hex of SHA-1>     - hash of the URL with any ?query removed, so tracking
                                 parameters do not create duplicate downloads
      dl-<12 hex of SHA-1>     - hash of the full URL (query may matter for direct files)
      lib-<12 hex of SHA-1>    - hash of the file name for a file in the mp3s/ folder
    SHA-1 is used here only as a short fingerprint, not for security.
    """
    if url.startswith(LIBRARY_PREFIX):
        # A file in the user's own MP3 folder, written as "library:<file name>". Nothing is downloaded.
        name = url[len(LIBRARY_PREFIX):]
        if not library_name_ok(name):
            raise ValueError("Not a valid MP3-folder file name")
        return "library", "lib-" + hashlib.sha1(name.encode()).hexdigest()[:12]
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("Not a valid http(s) URL")
    host = p.hostname.lower().removeprefix("www.")
    yt = youtube_id(url)
    if yt:
        return "youtube", "yt-" + yt
    if host.endswith("myinstants.com"):
        # hexdigest() is the hash as hex text; [:12] keeps the first 12 characters.
        return "myinstants", "mi-" + hashlib.sha1(url.split("?")[0].encode()).hexdigest()[:12]
    if p.path.lower().endswith(AUDIO_EXT):  # endswith accepts a tuple of suffixes
        return "direct", "dl-" + hashlib.sha1(url.encode()).hexdigest()[:12]
    raise ValueError("Unsupported link: use a YouTube, MyInstants or direct audio (.mp3/.ogg/...) URL")


def media_file(key):
    """Return the Path of the finished audio file for `key`, or None if not downloaded yet.

    The extension is not known in advance (yt-dlp picks it), so glob for "<key>.*" and skip
    the metadata sidecar (<key>.json) and in-progress downloads (*.part).
    """
    for f in MEDIA.glob(key + ".*"):
        if f.suffix != ".json" and not f.name.endswith(".part"):
            return f
    return None


def media_meta(key):
    """Return the saved metadata dict ({"title", maybe "duration"}) for `key`, or {}."""
    return read_json(MEDIA / f"{key}.json", {}) if (MEDIA / f"{key}.json").exists() else {}


def stream_to_file(url, dest_base, referer=None):
    """Download `url` to disk, never holding the whole file in memory. Returns the final Path.

    `dest_base` is the target path WITHOUT extension; the extension is taken from the URL
    (falling back to .mp3). `referer` is sent as the Referer header for sites that refuse
    hot-linking. Raises on HTTP errors, timeouts, or if the file exceeds MAX_BYTES.

    The data is written to "<name>.part" first and renamed at the end (same idea as
    atomic_write) so media_file() never mistakes a half-downloaded file for a finished one.
    """
    headers = dict(UA)  # copy, so adding Referer does not modify the shared UA dict
    if referer:
        headers["Referer"] = referer
    # stream=True: do not read the body yet; we pull it in chunks below. The `with` closes
    # the connection on exit. timeout=30 is per network operation, not for the whole file.
    with requests.get(url, headers=headers, stream=True, timeout=30) as r:
        r.raise_for_status()  # raises an exception for HTTP 4xx/5xx responses
        ext = Path(urlparse(url).path).suffix.lower()
        if ext not in AUDIO_EXT:
            ext = ".mp3"
        part = Path(str(dest_base) + ext + ".part")
        size = 0
        with open(part, "wb") as fh:
            for chunk in r.iter_content(1 << 16):  # 1 << 16 = 65536-byte chunks
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("File too large")
                fh.write(chunk)
        final = Path(str(dest_base) + ext)
        os.replace(part, final)
        return final


def do_fetch(key, kind, url):
    """Download one sound and record the outcome in `jobs[key]`. Runs on a background thread.

    Why a thread: yt-dlp / large downloads take seconds to minutes. Doing it inside a
    request handler would freeze that request (and the browser's button) until finished.
    Instead ensure_media() starts this function on its own thread and returns at once; the
    page then polls GET /api/media/<key> to see "downloading" -> "ready"/"error".

    Per kind:
      youtube    - yt-dlp library: pick audio, write media/<key>.<ext> (+ title/duration).
      myinstants - fetch the HTML page, regex out the real /media/sounds/... file URL and
                   the page title, then stream that file.
      direct     - stream the URL itself; the title is the file name without extension.
    On success writes media/<key>.json (title metadata) and sets status "ready". ANY error
    is caught and stored as status "error" (max 300 chars) because an exception escaping
    from a thread would just print a traceback and leave the UI waiting forever.
    """
    log.info("download start: %s %s (%s)", kind, url, key)
    started = time.time()
    try:
        title = ""
        if kind == "youtube":
            import yt_dlp  # imported lazily so the server still starts if yt-dlp is missing
            opts = {
                # yt-dlp format selector, tried left to right ("/" = fall back to next):
                #   bestaudio[ext=m4a] - best audio-only stream in m4a (AAC) form, which every
                #                        browser can decode;
                #   bestaudio          - otherwise any best audio-only stream (webm/opus...);
                #   best               - otherwise a full video+audio file (last resort).
                "format": "bestaudio[ext=m4a]/bestaudio/best",
                # Output file template: yt-dlp fills in %(ext)s with the real extension.
                "outtmpl": str(MEDIA / f"{key}.%(ext)s"),
                "noplaylist": True, "quiet": True,  # single video, no console spam
                "max_filesize": MAX_BYTES,
                # Send yt-dlp's own warnings and errors to our log (it would otherwise hide the reason a
                # download failed, such as YouTube asking for a sign-in).
                "logger": log,
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)  # blocks until the file is saved
                title = info.get("title", "")
                meta = {"title": title, "duration": info.get("duration")}
        elif kind == "myinstants":
            html = requests.get(url, headers=UA, timeout=20).text
            # Regex: a quote (' or "), then a path starting /media/sounds/ , any characters
            # up to a dot and mp3|ogg|wav, then the closing quote. group(1) = the path alone.
            # (?:...) is a non-capturing group; the triple-quoted string lets us use both quote kinds.
            m = re.search(r"""['"](/media/sounds/[^'"]+\.(?:mp3|ogg|wav))['"]""", html)
            if not m:
                raise ValueError("Could not find the sound on that MyInstants page")
            # Title: prefer the Open Graph meta tag (content="...") else the <title> text.
            # `A or B` returns B when A is None (no match). The backslash continues the line.
            t = re.search(r'<meta property="og:title" content="([^"]+)"', html) or \
                re.search(r"<title>([^<]+)</title>", html)
            # Strip the site's suffix such as " - Instant Buttons" / " | Sound Button...":
            # whitespace, a "-" or "|", optional "Instant "/"Sound ", then Button(s) and the rest.
            title = re.sub(r"\s*(-|\|)\s*(Instant )?(Sound )?(Button|Buttons).*$", "", t.group(1)).strip() if t else ""
            # urljoin makes the relative path (/media/sounds/x.mp3) absolute using the page URL.
            stream_to_file(urljoin(url, m.group(1)), MEDIA / key, referer=url)
            meta = {"title": title}
        else:
            stream_to_file(url, MEDIA / key)
            meta = {"title": Path(urlparse(url).path).stem}
        # Metadata is written LAST: once <key>.json exists the download is complete.
        atomic_write(MEDIA / f"{key}.json", meta)
        jobs[key] = {"status": "ready", "title": meta.get("title", "")}
        log.info("download done: %s (%s) %.0fs, %s", url, key, time.time() - started, media_file(key))
    except Exception as e:  # report to UI rather than die in a thread
        log.exception("download failed after %.0fs: %s (%s)", time.time() - started, url, key)
        jobs[key] = {"status": "error", "error": str(e)[:300]}


def ensure_media(url):
    """Make sure the sound at `url` is cached locally; start a download if it is not.

    Returns the media key immediately (it does NOT wait for the download). Raises
    ValueError (from classify) for unsupported URLs. Safe to call repeatedly: a sound that
    is already on disk is just marked ready, and one already downloading is not started a
    second time. The lock makes "check jobs, then set jobs and start thread" one atomic
    step, so two simultaneous requests cannot both launch a download for the same key.
    """
    kind, key = classify(url)
    if kind == "library":
        # Nothing to download: just remember which file this key means. Whether the file actually
        # exists is checked every time the status is asked for (library_status), so a file that
        # is added or removed later is picked up without restarting.
        lib_names[key] = url[len(LIBRARY_PREFIX):]
        return key
    with lock:
        if media_file(key):
            jobs[key] = {"status": "ready", "title": media_meta(key).get("title", "")}
        elif jobs.get(key, {}).get("status") != "downloading":
            jobs[key] = {"status": "downloading"}
            # daemon=True: this thread will not keep the process alive at exit (Ctrl+C
            # stops the server even with a download in flight).
            threading.Thread(target=do_fetch, args=(key, kind, url), daemon=True).start()
    return key


def resume_media_for_state():
    """After a preset load or restart, make sure every referenced sound is cached.

    Walks every tile/sound in `state` and calls ensure_media for its URL, which restarts any
    missing or interrupted downloads. Unusable URLs are skipped silently.
    """
    for t in state.get("tiles", []):
        for s in t.get("sounds", []):
            try:
                ensure_media(s.get("url", ""))
            except Exception:
                pass


# ------------------------------------------------------------- MP3 library
# A folder (mp3s/) of the user's own audio files. A sound that uses one has the URL
# "library:<file name>". The folder is flat (no sub-folders) and only files with an audio
# extension count.
LIBRARY_PREFIX = "library:"

# library_index: what the last folder scan found. "files" maps file name -> (size in bytes,
# modification time); "version" goes up by one whenever that listing changes, so the page can
# cheaply ask "has anything changed?". lib_names maps a media key to its file name (see ensure_media).
library_index = {"version": 0, "files": {}}
lib_names = {}


def library_name_ok(name):
    """True if `name` is a plain audio file name that is safe to look up inside mp3s/.

    Rejects empty names, anything with a folder part ("a/b.mp3", "../x.mp3", "a\\b.mp3"),
    hidden files, and non-audio extensions. This is what stops a crafted name from reaching
    outside the folder.
    """
    return (bool(name) and name == Path(name).name and "\\" not in name and "\x00" not in name
            and not name.startswith(".") and Path(name).suffix.lower() in AUDIO_EXT)


def library_scan():
    """Look at the mp3s/ folder once and update `library_index` if its contents changed.

    Never raises: if the folder is missing or unreadable right now (deleted, drive unplugged), the
    previous listing is kept and the next scan simply tries again.
    """
    found = {}
    try:
        for p in LIBRARY.iterdir():  # iterdir lists the folder's entries
            if p.is_file() and library_name_ok(p.name):
                st = p.stat()
                found[p.name] = (st.st_size, st.st_mtime_ns)  # ns timestamp: notices a replaced file
    except OSError:
        return
    with lock:
        if found != library_index["files"]:
            library_index["files"] = found
            library_index["version"] += 1


def library_watcher():
    """Background thread: rescan the MP3 folder every 2 seconds, forever.

    Simple polling instead of operating-system file-change notifications: it works the same on
    every OS, needs no extra library, and 2 seconds is plenty fast for dropping a file in. The
    folder is re-created if someone deletes it. Any error is swallowed so the thread cannot die.
    """
    while True:
        try:
            LIBRARY.mkdir(parents=True, exist_ok=True)
            library_scan()
        except Exception:
            pass
        time.sleep(2)


def library_status(name):
    """Status dict (same shape as /api/media/<key> answers) for the library file `name`.

    Checked against the disk on every call. A missing or unreadable file gives an "error" status
    with a readable message, which the page shows on the sound's card; it never raises.
    """
    try:
        st = (LIBRARY / name).stat()
        if (LIBRARY / name).is_file():
            return {"status": "ready", "title": Path(name).stem, "src": "/library/" + quote(name),
                    "size": st.st_size, "duration": None}
        return {"status": "error", "error": f"Not a file in the MP3 folder: {name}"}
    except FileNotFoundError:
        return {"status": "error", "error": f"File not found in the MP3 folder: {name} (was it moved or deleted?)"}
    except OSError as e:
        return {"status": "error", "error": f"Cannot read {name}: {e.strerror or e}"}


# ------------------------------------------------------------------ routes
# Imported here, not at the top, because party.py is a separate module that must be loaded
# after this module's own setup. `# noqa: E402` just silences a linter warning about it.
import party  # noqa: E402
from party import bp as party_bp  # noqa: E402  (needs `app` paths set up first)

# Merge all of party.py's routes (/api/party..., /api/initiative, ...) into this app.
app.register_blueprint(party_bp)


# Decorators (@something above a def) wrap the function that follows. Here @app.get("/")
# means: "register the function below as the handler for HTTP GET requests to /".
# It is like adding an entry {GET, "/"} -> callback to a dispatch table; the function
# itself is unchanged. Flask calls it when that URL is requested.
#
# THE APP SHELL. The user-visible pages (/, /campaign, /party, /party/<id>) all return the SAME
# page, shell.html: the shared header plus one <iframe> (a page inside the page) for each of the
# soundboard, the campaign tracker and the characters. All three are loaded at once and switching
# tabs only hides and shows them, so leaving the soundboard never unloads it (sound keeps playing,
# timers keep running). Which tab starts visible depends on the URL. The iframes load the "inner"
# pages below (under /_/), which are the real pages without the shared header.
# Several decorators stack: all of these URLs reach this one function. "<cid>" is a URL variable:
# whatever text is in that position is passed as the argument `cid` (a character id).
@app.get("/")
@app.get("/sound")
@app.get("/campaign")
@app.get("/party")
@app.get("/party/<cid>")
def shell(cid=None):
    """GET / , /sound , /campaign , /party , /party/<cid> : the app shell (shared header + the pages).

    `active` = which tab starts visible (the home banner at "/"); `party_path` = which character page the
    Characters iframe starts on; `role` = "dm" (all tabs) or "player" (Home and Characters only).
    A visitor who is not signed in gets the plain banner page with a Login button instead of the shell.
    """
    user = auth.current_user()
    if not user:
        return render_template("landing.html")
    path = request.path
    active = "campaign" if path == "/campaign" else "party" if path.startswith("/party") else \
        "sound" if path == "/sound" else "home"
    return render_template("shell.html", active=active, user=user, role=user["role"],
                           party_path="/_/party" + (f"/{cid}" if cid else ""))


@app.get("/_/home")
def inner_home():
    """GET /_/home : the banner/home page itself (the shell's first iframe). What it shows depends on the
    signed-in user's level; the page's own JavaScript fetches the data for it."""
    return render_template("home.html", role=auth.current_user()["role"])


@app.get("/_/sound")
def inner_sound():
    """GET /_/sound : the soundboard page itself (loaded inside the shell's first iframe).
    render_template fills templates/index.html."""
    return render_template("index.html")


@app.get("/_/campaign")
def inner_campaign():
    """GET /_/campaign : the campaign tracker page (loaded inside the shell's second iframe)."""
    return render_template("campaign.html")


@app.get("/_/party")
@app.get("/_/party/<cid>")
def inner_party(cid=None):
    """GET /_/party and /_/party/<cid> : the characters pages (third iframe). The id is not used
    here; the page's own JavaScript reads it from the address bar and fetches what it needs."""
    return render_template("party.html", role=auth.current_user()["role"])


@app.get("/tracker")
def tracker_page():
    """GET /tracker : the combat/initiative tracker on its own page (the pop-out window). It is not
    part of the shell. Its data comes from the /api/party and /api/initiative routes in party.py."""
    return render_template("tracker.html")


@app.get("/api/state")
def get_state():
    """GET /api/state -> the full soundboard state as JSON (see default_state for shape).
    Holds the lock so we never serialise it halfway through another thread's update."""
    with lock:
        return jsonify(state)


@app.put("/api/state")
def put_state():
    """PUT /api/state : replace the whole soundboard state (the page calls this on every edit).

    Request body: the full state JSON ({"tiles": [...]}).
    Response: {"revision": N} (200) or {"error": "..."} (400 if the body is not valid).
    Side effects: swaps the in-memory `state`, bumps `revision` (server-assigned, so the
    client cannot forge it) and autosaves to data/live.json.
    """
    global state  # we rebind the module-level variable, so it must be declared global
    try:
        # force=True: parse the body as JSON even if the Content-Type header is not
        # "application/json" (the browser may send plain text).
        new = validate_state(request.get_json(force=True))
    except Exception as e:
        return jsonify(error=str(e)), 400  # (body, status code) tuple = HTTP 400 Bad Request
    with lock:
        # The soundboard page never edits the campaign tracker, but its copy of the state may carry an
        # OLD copy of the campaign data (loaded before the campaign page saved something). Keep the
        # server's campaign so a soundboard save can never overwrite campaign progress.
        for k in ("campaign", "party", "campaignName"):  # party = the campaign's list of party characters (see below)
            if k in state:
                new[k] = state[k]
        new["revision"] = state.get("revision", 0) + 1
        state = new
        save_live()  # automatic export of live changes
    return jsonify(revision=new["revision"])


@app.put("/api/campaign")
def put_campaign():
    """PUT /api/campaign : replace just the campaign-tracker part of the state.

    Request body: {"campaign": {"sections": [...], "tiles": [...]}}. Response: {"revision": N}, or
    {"error": "..."} (400) if the shape is wrong. The campaign lives INSIDE the same `state` as the
    sounds, so it is saved in live.json and in every preset and version snapshot together with them.
    Only this key is replaced; the sounds are left exactly as they are, which is why the campaign
    page uses this route instead of PUT /api/state.
    """
    global state
    body = request.get_json(force=True) or {}
    camp = body.get("campaign")
    if not isinstance(camp, dict) or not isinstance(camp.get("tiles"), list) or not isinstance(camp.get("sections"), list):
        return jsonify(error="campaign must contain 'sections' and 'tiles' lists"), 400
    with lock:
        state["campaign"] = camp
        state["revision"] = state.get("revision", 0) + 1
        save_live()
        rev = state["revision"]
    return jsonify(revision=rev)


# The campaign's party: which characters are in the active party. The campaign file (state["party"]) keeps
# only REFERENCES, {"id", "name", "owner"}, never the character sheets: those stay with the players who
# uploaded them (data/party/<id>.xml). Loading a campaign therefore brings back the list, and each
# character appears as soon as its player has uploaded (or already uploaded) their file.
def active_party():
    """The campaign's party as the browser sees it: each reference plus `present` (is the sheet uploaded
    on this server?), with the owner and name refreshed from the uploaded sheet when there is one."""
    out = []
    for ref in state.get("party", []):
        f = party._path(ref["id"])
        if f.exists():
            ex = party._extra().get(ref["id"], {})
            out.append({"id": ref["id"], "name": party._t(party._load(ref["id"]), "name") or ref.get("name", ""),
                        "owner": ex.get("owner", ref.get("owner", "")), "present": True})
        else:
            out.append({**ref, "present": False})
    return out


# party.py asks this (through party.active_ids) when the tracker wants only the active party.
party.active_ids = lambda: [r["id"] for r in state.get("party", [])] or None


@app.get("/api/active-party")
def get_active_party():
    """GET /api/active-party (DM) -> {"campaign": name of the loaded campaign or "", "party": [{"id","name",
    "owner","present"}, ...]} for the loaded campaign's party."""
    with lock:
        return jsonify(campaign=state.get("campaignName", ""), party=active_party())


@app.put("/api/active-party")
def put_active_party():
    """PUT /api/active-party {"ids": [character id, ...]} (DM) : set which characters are in the party.

    Only characters that exist, or that were already in the list (so a missing player's slot is not lost
    when somebody else is toggled), are accepted. The name and owner are copied into the reference so the
    saved campaign still says who it was for. Saved with the rest of the state, hence in every campaign
    saved afterwards. Response: same as GET.
    """
    ids = (request.get_json(force=True, silent=True) or {}).get("ids")
    if not isinstance(ids, list):
        return jsonify(error="ids must be a list"), 400
    with lock:
        old = {r["id"]: r for r in state.get("party", [])}
        refs = []
        for cid in dict.fromkeys(ids):  # dict.fromkeys drops duplicates but keeps the order
            if not isinstance(cid, str) or not re.fullmatch(r"[\w-]+", cid):
                continue
            if party._path(cid).exists():
                ex = party._extra().get(cid, {})
                refs.append({"id": cid, "name": party._t(party._load(cid), "name"), "owner": ex.get("owner", "")})
            elif cid in old:
                refs.append(old[cid])
        state["party"] = refs
        state["revision"] = state.get("revision", 0) + 1
        save_live()
        return jsonify(campaign=state.get("campaignName", ""), party=active_party())


@app.post("/api/media")
def add_media():
    """POST /api/media : ask the server to fetch and cache a sound.

    Request body: {"url": "https://..."}.
    Response: {"key": "...", "kind": "youtube|myinstants|direct"} (200), or
    {"error": "..."} (400) for an unsupported link. The download then proceeds in the
    background; poll GET /api/media/<key> for progress.
    """
    # `(x or {})` guards against a JSON null body; .get(...).strip() trims whitespace.
    url = (request.get_json(force=True) or {}).get("url", "").strip()
    try:
        kind, key = classify(url)
        ensure_media(url)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(key=key, kind=kind)


@app.get("/api/media/<key>")
def media_status(key):
    """GET /api/media/<key> : download status of one sound.

    Responses (JSON):
      ready       {"status": "ready", "title", "src": "/media/<file>", "size" (bytes), "duration"}
      downloading {"status": "downloading"}
      error       {"status": "error", "error": "..."}
      unknown     {"status": "missing"}
    `src` is a URL the browser can load the audio from (served by serve_media below).
    """
    # Keys are used to build file names, so allow only word characters and hyphens
    # (regex [\w-]+ ; fullmatch requires the WHOLE string to match). abort(400) stops the
    # handler immediately and returns an HTTP 400 error to the browser.
    if not re.fullmatch(r"[\w-]+", key):
        abort(400)
    if key in lib_names:  # a file from the MP3 folder: answer from the disk right now
        return jsonify(library_status(lib_names[key]))
    f = media_file(key)
    if f:
        return jsonify(status="ready", title=media_meta(key).get("title", ""),
                       src=f"/media/{f.name}", size=f.stat().st_size,
                       duration=media_meta(key).get("duration"))
    return jsonify(jobs.get(key, {"status": "missing"}))


# Cloud Run refuses any single HTTP response over 32 MiB (the browser sees a 500), and an hour or more of
# audio is bigger than that. So audio files larger than this are sent in slices (HTTP 206 "partial content"):
# the <audio> element asks for a range, we answer at most this many bytes of it, and it asks again for the
# next slice as it plays or seeks. Kept well under the limit.
MAX_SLICE = 16 * 1024 * 1024


def send_audio(directory, name, max_age=None):
    """Send an audio file, in slices of at most MAX_SLICE bytes when the file is large.

    Small files and conditional requests (304) go through send_from_directory exactly as before.
    A large file is answered with the byte range the browser asked for ("Range: bytes=START-END",
    or from byte 0 when it sent none), shortened to MAX_SLICE bytes. The Content-Range header tells the
    browser how much it got and how big the whole file is, so it can request the rest.
    """
    path = safe_join(str(directory), name)  # None if the name tries to climb out of the folder
    if path is None or not os.path.isfile(path):
        abort(404)
    size = os.path.getsize(path)
    if size <= MAX_SLICE:
        return send_from_directory(directory, name, conditional=True, max_age=max_age)

    start, end = 0, size - 1
    m = re.match(r"bytes=(\d*)-(\d*)$", request.headers.get("Range", ""))
    if m and (m.group(1) or m.group(2)):
        if m.group(1):  # "bytes=START-" or "bytes=START-END"
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
        else:  # "bytes=-N": the last N bytes
            start = max(0, size - int(m.group(2)))
    if start >= size:
        return Response(status=416, headers={"Content-Range": f"bytes */{size}"})
    end = min(end, size - 1, start + MAX_SLICE - 1)
    length = end - start + 1

    def body():
        with open(path, "rb") as fh:
            fh.seek(start)
            left = length
            while left > 0:
                chunk = fh.read(min(1 << 16, left))
                if not chunk:
                    break
                left -= len(chunk)
                yield chunk

    headers = {"Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(length),
               "Accept-Ranges": "bytes"}
    if max_age:
        headers["Cache-Control"] = f"public, max-age={max_age}"
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return Response(body(), status=206, mimetype=mime, headers=headers)


@app.get("/media/<path:name>")
def serve_media(name):
    """GET /media/<file> : send a cached audio file to the browser.

    send_from_directory is Flask's safe file server: it refuses names that try to climb out
    of MEDIA (e.g. "../"). conditional=True supports "If-Modified-Since"/Range requests
    (seeking, 304 Not Modified); max_age=31536000 (one year, in seconds) lets the browser
    cache it, which is safe because a key's file never changes once downloaded.
    """
    return send_audio(MEDIA, name, max_age=31536000)


@app.get("/library/<path:name>")
def serve_library(name):
    """GET /library/<file> : send a file from the MP3 folder to the browser.

    Same safe file server as serve_media. No long cache time here, because the user may replace a
    file under the same name; conditional=True still lets the browser skip re-downloading an
    unchanged one. A missing file is a normal 404, which the page handles as an error on the card.
    """
    return send_audio(LIBRARY, name)


@app.get("/api/library")
def list_library():
    """GET /api/library : what is in the MP3 folder, for the drop-down in the sound dialog.

    Response: {"version": int (changes whenever the listing changes), "folder": "<path>",
    "files": [{"name", "size"}...]} sorted by name, case-insensitively.
    """
    with lock:
        files = [{"name": n, "size": v[0]} for n, v in sorted(library_index["files"].items(), key=lambda kv: kv[0].lower())]
        version = library_index["version"]
    return jsonify(version=version, folder=str(LIBRARY), files=files)


@app.post("/api/library/upload")
def upload_library():
    """POST /api/library/upload : copy a file the user picked ("Browse...") into the MP3 folder.

    A web page is not allowed to learn the real path of a file the user picks, only its contents,
    so "browsing" means uploading the contents here. The file is stored in mp3s/ (so it also shows up
    in the drop-down) and the page then refers to it as "library:<name>".

    Request: multipart form with one field named "file". Response: {"name": "<stored name>"} (200)
    or {"error": "..."} (400/413/500). Steps: clean the name, check the extension, write to a hidden
    temporary file, then rename it into place. If the same file (same name and size) is already
    there it is reused rather than stored twice; a different file with the same name gets " (2)".
    """
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file was chosen"), 400
    # Browsers normally send only the bare file name, but strip any folder part just in case,
    # then replace characters that could be troublesome in a file name.
    name = Path(f.filename.replace("\\", "/")).name
    name = re.sub(r"[^\w .,()\[\]&'+!-]", "_", name).strip(" .")
    ext = Path(name).suffix.lower()
    if ext not in AUDIO_EXT:
        return jsonify(error=f"Unsupported file type '{ext or 'none'}'. Use one of: {', '.join(AUDIO_EXT)}"), 400
    stem = Path(name).stem[:100] or "sound"
    tmp = LIBRARY / f".upload-{os.getpid()}-{threading.get_ident()}.part"  # hidden, so scans ignore it
    try:
        LIBRARY.mkdir(parents=True, exist_ok=True)
        f.save(tmp)
        size = tmp.stat().st_size
        dest = LIBRARY / f"{stem}{ext}"
        n = 2
        while dest.exists() and dest.stat().st_size != size:  # same name but different file: find a free name
            dest = LIBRARY / f"{stem} ({n}){ext}"
            n += 1
        if dest.exists():
            tmp.unlink()  # identical file already stored: reuse it
        else:
            os.replace(tmp, dest)  # atomic rename into place, so a scan never sees half a file
    except OSError as e:
        try:
            tmp.unlink()
        except OSError:
            pass
        return jsonify(error=f"Could not save the file: {e.strerror or e}"), 500
    library_scan()  # update the listing immediately instead of waiting for the next 2 s scan
    return jsonify(name=dest.name)


@app.errorhandler(413)
def too_large(_err):
    """Answer "request too large" (from MAX_CONTENT_LENGTH) with JSON the page can show,
    instead of Flask's default HTML error page."""
    return jsonify(error=f"File is too big (limit {MAX_BYTES // (1024 * 1024)} MB)"), 413


# campaigns (saved whole-board snapshots; stored in data/presets/, the folder keeps its old name)
@app.get("/api/campaigns")
def list_campaigns():
    """GET /api/campaigns -> JSON list of saved campaign names, alphabetical
    (file names in data/presets without the .json)."""
    return jsonify(sorted(p.stem for p in PRESETS.glob("*.json")))


@app.post("/api/campaigns")
def save_campaign():
    """POST /api/campaigns : save the CURRENT live state under a name (overwrites a same-named campaign).

    Request body: {"name": "My Preset"}; the name is sanitised by safe_name.
    Response: {"name": "<sanitised name>"} or {"error": ...} (400 if the name is empty).
    Side effect: writes data/presets/<name>.json.
    """
    name = safe_name((request.get_json(force=True) or {}).get("name"))
    if not name:
        return jsonify(error="Campaign name required"), 400
    with lock:
        state["campaignName"] = name  # remembered so the Home page can say which campaign is loaded
        atomic_write(PRESETS / f"{name}.json", state)
        save_live()
    return jsonify(name=name)


@app.post("/api/campaigns/<name>/load")
def load_campaign(name):
    """POST /api/campaigns/<name>/load : make a campaign the live state.

    Response: the new full state JSON; 404 if no such campaign.
    Side effects: first copies the current live.json into data/versions/ ("before-load-<name>")
    so the load can be undone, then replaces `state`, bumps revision, autosaves, and starts
    downloads for any sounds the preset needs that are not cached yet.
    """
    global state
    p = PRESETS / f"{safe_name(name)}.json"
    if not p.exists():
        abort(404)
    with lock:
        shutil.copy2(LIVE, VERSIONS / f"live-{stamp()}-before-load-{safe_name(name)}.json")
        state = keep_campaign(validate_state(read_json(p)))
        state["campaignName"] = safe_name(name)
        state["revision"] = state.get("revision", 0) + 1
        save_live()
    resume_media_for_state()
    return jsonify(state)


@app.delete("/api/campaigns/<name>")
def delete_campaign(name):
    """DELETE /api/campaigns/<name> : remove a campaign file. Response {"ok": true}; deleting a
    campaign that does not exist is not an error (the end result is the same)."""
    p = PRESETS / f"{safe_name(name)}.json"
    if p.exists():
        p.unlink()  # unlink = delete the file
    return jsonify(ok=True)


# versions
@app.get("/api/versions")
def list_versions():
    """GET /api/versions -> JSON list of the 100 newest snapshot names (no .json).
    Names start with a timestamp, so reverse alphabetical order is newest first."""
    files = sorted(VERSIONS.glob("*.json"), reverse=True)
    return jsonify([f.stem for f in files[:100]])


@app.post("/api/versions/<name>/restore")
def restore_version(name):
    """POST /api/versions/<name>/restore : roll the live state back to a snapshot.

    Response: the restored full state JSON; 404 if the snapshot does not exist.
    Side effects: first saves the current live.json as "...-before-restore" (so a restore is
    itself undoable), then swaps `state`, bumps revision, autosaves, and re-checks media.
    """
    global state
    p = VERSIONS / f"{safe_name(name)}.json"
    if not p.exists():
        abort(404)
    with lock:
        shutil.copy2(LIVE, VERSIONS / f"live-{stamp()}-before-restore.json")
        state = keep_campaign(validate_state(read_json(p)))
        state["revision"] = state.get("revision", 0) + 1
        save_live()
    resume_media_for_state()
    return jsonify(state)


# launch config
@app.get("/api/config")
def get_config():
    """GET /api/config -> {"launch": {"mode": "live"|"preset", "preset": name|null}}.
    Read by startup() on the next server launch; defaults to "live" if never saved."""
    return jsonify(read_json(CONFIG, {"launch": {"mode": "live", "preset": None}}))


@app.put("/api/config")
def put_config():
    """PUT /api/config : choose what loads on the next launch.

    Request body: {"launch": {"mode": "preset", "preset": "Name"}} (anything else means live).
    Response: the normalised config actually stored. Mode "preset" is only kept if a preset
    name is also given; the name is sanitised, and an empty name is stored as null.
    Side effect: writes data/config.json.
    """
    body = request.get_json(force=True) or {}
    launch = body.get("launch", {})
    mode = "preset" if launch.get("mode") == "preset" and launch.get("preset") else "live"
    cfg = {"launch": {"mode": mode, "preset": safe_name(launch.get("preset") or "") or None}}
    atomic_write(CONFIG, cfg)
    return jsonify(cfg)


@app.get("/api/export")
def export_state():
    """GET /api/export : download the current state as a timestamped .json file.
    The Content-Disposition header tells the browser to save it as a file instead of
    displaying it."""
    with lock:
        resp = jsonify(state)
    resp.headers["Content-Disposition"] = f"attachment; filename=soundboard-{stamp()}.json"
    return resp


# Entry point, like main() in C: this block runs only when the file is started directly
# (`python app.py`), not when another module imports it.
if __name__ == "__main__":
    # argparse ~ getopt: builds --host/--port/--live/--preset handling and --help text.
    # description=__doc__ reuses the module docstring at the top as the help text.
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")  # 127.0.0.1 = this computer only
    ap.add_argument("--port", type=int, default=5000)
    # Mutually exclusive: giving both --live and --preset is a usage error.
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--live", action="store_true", help="load live changes, ignoring the launch preset")
    g.add_argument("--preset", "--campaign", dest="preset", metavar="NAME",
                   help="load this campaign on launch (overrides saved config)")
    args = ap.parse_args()
    startup(args)  # load state and kick off media downloads BEFORE serving requests
    print(f"\nDM Soundboard running at http://{args.host}:{args.port}\n")
    # Blocks forever serving requests. threaded=True = one thread per request, which is
    # why shared data needs `lock`.
    app.run(host=args.host, port=args.port, threaded=True)
else:
    # Imported by a production server such as gunicorn (gunicorn app:app): there is no command line and
    # nobody to answer the "press L" prompt, so do the same start-up with the defaults: load whatever the
    # saved launch settings say (live changes unless a launch preset is configured) and start the
    # background folder watcher. This runs once when the server process starts.
    startup(argparse.Namespace(live=False, preset=None))
