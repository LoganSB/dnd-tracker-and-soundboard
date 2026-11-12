"""Accounts, sign-in and permission levels (DM and player).

TWO PERMISSION LEVELS
  dm      sees and edits everything: soundboard, campaign tracker, every character, accounts, invites.
  player  sees only their own character(s): they can upload a Fight Club file and view or edit what they
          uploaded, and nothing else. The server enforces this on every request (see check_request), so
          hiding a button in the page is only a convenience, never the protection.

HOW SIGNING IN WORKS
* Accounts live in data/users.json. A password is never stored: only a salted hash of it (werkzeug's
  generate_password_hash), which cannot be turned back into the password.
* After a successful sign-in the server gives the browser a signed cookie ("dnd_session") holding the
  user name. The signature (itsdangerous, keyed by data/secret_key) means the browser cannot invent or edit
  one. Every later request, including the page frames and the API calls, sends it automatically.
* The cookie also holds the account's "ver" (a random number changed whenever the password is changed or
  reset), so changing a password signs out every device that was using the old one.
* Players cannot register on their own. The DM makes an invite link (valid for 7 days, usable once); opening
  it lets the person choose their own user name and a password (or link their Google account).
* Google sign-in is optional. It is switched on by giving the server a Google "OAuth client" through the
  environment variables below; without them the Google buttons are hidden.

FIRST RUN
* No accounts and no DND_PASSWORD set (running on your own computer): there is nothing to protect, so every
  visitor acts as the DM, exactly as before accounts existed. Create a DM account whenever you like.
* No accounts but DND_PASSWORD set (a deployed copy): the site is locked, and the sign-in page offers
  "Create the DM account", which needs DND_PASSWORD as the setup key. After that the key is not used again.

ENVIRONMENT VARIABLES (all optional)
  DND_PASSWORD             setup key for creating the first DM account (see above)
  DND_DM_EMAIL             a Google address that is always allowed to sign in as the DM
  DND_GOOGLE_CLIENT_ID     } the Google OAuth client; both needed to switch Google sign-in on
  DND_GOOGLE_CLIENT_SECRET }
  DND_PUBLIC_URL           the site's public address, such as https://dnd.gloan.me (used to build the
                           Google redirect address; the address of the incoming request is used if unset)
"""
import base64
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

import requests
from flask import Blueprint, Response, abort, g, jsonify, redirect, render_template, request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

bp = Blueprint("auth", __name__)
BASE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("DND_DATA_ROOT") or BASE)
USERS = ROOT / "data" / "users.json"
SECRET = ROOT / "data" / "secret_key"
USERS.parent.mkdir(parents=True, exist_ok=True)

lock = threading.RLock()  # serialises read-modify-write of users.json (same idea as party.py)
COOKIE = "dnd_session"
SESSION_DAYS = 30
INVITE_DAYS = 7
NAME_RE = re.compile(r"[A-Za-z0-9_.-]{2,32}")  # allowed user names
MIN_PASSWORD = 8


def setup_key():
    """The key that allows creating the first DM account ("" when none is set)."""
    return os.environ.get("DND_PASSWORD", "")


def google_enabled():
    return bool(os.environ.get("DND_GOOGLE_CLIENT_ID") and os.environ.get("DND_GOOGLE_CLIENT_SECRET"))


# ------------------------------------------------------------------ storage
def _load():
    """Load users.json as {"users": {name: record}, "invites": {token: record}} (empty if missing)."""
    try:
        d = json.loads(USERS.read_text())
    except Exception:
        d = {}
    d.setdefault("users", {})
    d.setdefault("invites", {})
    return d


def _save(d):
    """Write users.json atomically (temp file, then rename) and keep it readable by this user only."""
    tmp = USERS.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=2))
    os.chmod(tmp, 0o600)
    os.replace(tmp, USERS)


def _secret_key():
    """The signing key: made once, stored in data/secret_key, so sessions survive restarts."""
    with lock:
        if not SECRET.exists():
            SECRET.write_text(secrets.token_hex(32))
            os.chmod(SECRET, 0o600)
        return SECRET.read_text().strip()


def _signer(salt):
    return URLSafeTimedSerializer(_secret_key(), salt=salt)


def _key(name):
    """Users are looked up case-insensitively: 'Alice' and 'alice' are the same account."""
    return (name or "").strip().lower()


def public(name, rec):
    """The parts of a user record that are safe to show (never the hash)."""
    return {"name": rec.get("name", name), "role": rec.get("role", "player"), "email": rec.get("email", ""),
            "hasPassword": bool(rec.get("hash")), "created": rec.get("created", 0)}


# ------------------------------------------------------------------ who is asking
def auth_open():
    """True when nothing needs protecting: no accounts yet and no setup key (a local copy)."""
    return not setup_key() and not _load()["users"]


def current_user():
    """The signed-in user for this request as {"name", "role"}, or None for a visitor. Cached per request.

    In open mode (see auth_open) every visitor is the DM. Otherwise the cookie must carry a valid
    signature, not be older than SESSION_DAYS, and match the account's current "ver".
    """
    if "user" in g:
        return g.user
    user = None
    if auth_open():
        user = {"name": "local", "role": "dm"}
    else:
        token = request.cookies.get(COOKIE)
        if token:
            try:
                data = _signer("session").loads(token, max_age=SESSION_DAYS * 86400)
                rec = _load()["users"].get(data.get("u"))
                if rec and rec.get("ver") == data.get("v"):
                    user = {"name": rec.get("name", data["u"]), "role": rec.get("role", "player")}
            except BadSignature:
                pass
    g.user = user
    return user


def is_dm():
    u = current_user()
    return bool(u and u["role"] == "dm")


def require_dm():
    """Call at the top of a route that only the DM may use; answers 401 to a visitor who is not signed in and
    403 to a player."""
    if not is_dm():
        abort(401 if not current_user() else 403)


def _start_session(resp, key):
    """Attach the signed session cookie for user `key` to the response `resp`."""
    rec = _load()["users"][key]
    token = _signer("session").dumps({"u": key, "v": rec["ver"]})
    # Secure = only sent over HTTPS (when the request itself came in over HTTPS). HttpOnly = invisible to
    # page scripts. SameSite=Lax = not sent on requests started by other sites (stops cross-site forgery).
    resp.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="Lax",
                    secure=request.is_secure)
    return resp


# ------------------------------------------------------------------ what each level may reach
# Anyone, signed in or not: the landing/sign-in pages, the sign-in API, page styles and scripts, the health check.
OPEN_EXACT = {"/", "/login", "/healthz", "/favicon.ico"}
OPEN_PREFIXES = ("/static/", "/api/auth/", "/auth/", "/invite/")
# Players may also use the character pages and character API (route code limits them to their own characters),
# plus the small page that is their home tab.
PLAYER_PREFIXES = ("/api/party", "/_/party", "/party", "/_/home")


def check_request():
    """Run before EVERY request (registered in app.py): decide whether this visitor may reach this address.

    Returns None to carry on, or a response that answers the request right here: a redirect to the sign-in
    page for a visitor asking for a page, 401 for a visitor calling the API, 403 for a player reaching for
    something only the DM may use. Which routes a player may use is the PLAYER_PREFIXES list above.
    """
    path = request.path
    if path in OPEN_EXACT or path.startswith(OPEN_PREFIXES):
        return None
    user = current_user()
    if user and (user["role"] == "dm" or path.startswith(PLAYER_PREFIXES)):
        return None
    wants_page = request.method == "GET" and not path.startswith("/api/") and "text/html" in request.headers.get("Accept", "")
    if not user:
        if wants_page:
            return redirect("/login?" + urlencode({"next": request.full_path.rstrip("?")}))
        return jsonify(error="Sign in required"), 401
    if wants_page:
        return redirect("/")
    return jsonify(error="The DM only"), 403


# ------------------------------------------------------------------ guarding against password guessing
_fails = {}  # "ip|name" -> [number of recent failures, time of the first one]
MAX_FAILS, FAIL_WINDOW = 6, 300


def _throttled(name):
    """True if this address has failed to sign in too often recently (5 minute window)."""
    k = f"{request.remote_addr}|{_key(name)}"
    n, first = _fails.get(k, (0, 0))
    if time.time() - first > FAIL_WINDOW:
        _fails.pop(k, None)
        return False
    return n >= MAX_FAILS


def _forgive(name):
    """Forget earlier failed sign-ins for this address and name (called after a successful one)."""
    _fails.pop(f"{request.remote_addr}|{_key(name)}", None)


def _fail(name):
    k = f"{request.remote_addr}|{_key(name)}"
    n, first = _fails.get(k, (0, time.time()))
    _fails[k] = (n + 1, first)


# ------------------------------------------------------------------ account actions
def _valid_new(name, password):
    """Return an error message if `name`/`password` cannot be used for a new account, else None."""
    if not NAME_RE.fullmatch(name or ""):
        return "User name: 2 to 32 letters, digits, dots, dashes or underscores"
    if password is not None and len(password) < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters"
    if _key(name) in _load()["users"]:
        return "That user name is taken"
    return None


def _create(name, role, password=None, email=""):
    """Add an account and return its key. The caller has already checked _valid_new."""
    with lock:
        d = _load()
        d["users"][_key(name)] = {"name": name, "role": role, "email": email.lower(), "created": int(time.time()),
                                  "ver": secrets.token_hex(8),
                                  **({"hash": generate_password_hash(password)} if password else {})}
        _save(d)
    return _key(name)


@bp.get("/api/auth/me")
def me():
    """GET /api/auth/me -> who is signed in, and what the sign-in page needs to know:
    {"user": {"name","role"} | null, "open": bool, "needsSetup": bool, "google": bool}."""
    d = _load()
    return jsonify(user=current_user(), open=auth_open(),
                   needsSetup=not any(u.get("role") == "dm" for u in d["users"].values()),
                   google=google_enabled())


@bp.post("/api/auth/login")
def login():
    """POST /api/auth/login {"username","password"} -> sets the session cookie. Same error for a wrong name and
    a wrong password, so the answer does not reveal which user names exist."""
    body = request.get_json(force=True, silent=True) or {}
    name, pw = body.get("username", ""), body.get("password", "")
    if _throttled(name):
        return jsonify(error="Too many attempts: wait a few minutes"), 429
    rec = _load()["users"].get(_key(name))
    if not rec or not rec.get("hash") or not check_password_hash(rec["hash"], pw):
        _fail(name)
        return jsonify(error="Wrong user name or password"), 401
    _forgive(name)
    return _start_session(jsonify(ok=True, role=rec["role"]), _key(name))


@bp.post("/api/auth/logout")
def logout():
    resp = jsonify(ok=True)
    resp.delete_cookie(COOKIE)
    return resp


@bp.post("/api/auth/setup")
def setup():
    """POST /api/auth/setup {"username","password","key"} -> create the FIRST DM account (only while none exists).
    `key` must be DND_PASSWORD when that is set."""
    body = request.get_json(force=True, silent=True) or {}
    with lock:
        if any(u.get("role") == "dm" for u in _load()["users"].values()):
            return jsonify(error="A DM account already exists"), 409
        if _throttled("setup"):
            return jsonify(error="Too many attempts: wait a few minutes"), 429
        want = setup_key()
        if want and not secrets.compare_digest(str(body.get("key", "")).encode(), want.encode()):
            _fail("setup")
            return jsonify(error="Wrong setup key"), 403
        err = _valid_new(body.get("username"), body.get("password"))
        if err:
            return jsonify(error=err), 400
        key = _create(body["username"], "dm", body["password"])
    return _start_session(jsonify(ok=True), key)


@bp.post("/api/auth/password")
def change_password():
    """POST /api/auth/password {"old","new"} -> change your own password (signs out your other devices)."""
    user = current_user()
    if not user or user["name"] == "local":
        abort(401)
    body = request.get_json(force=True, silent=True) or {}
    with lock:
        d = _load()
        rec = d["users"].get(_key(user["name"]))
        if not rec or not rec.get("hash") or not check_password_hash(rec["hash"], body.get("old", "")):
            return jsonify(error="Current password is wrong"), 403
        if len(body.get("new", "")) < MIN_PASSWORD:
            return jsonify(error=f"Password must be at least {MIN_PASSWORD} characters"), 400
        rec["hash"], rec["ver"] = generate_password_hash(body["new"]), secrets.token_hex(8)
        _save(d)
    return _start_session(jsonify(ok=True), _key(user["name"]))


# ------------------------------------------------------------------ DM: accounts and invites
@bp.get("/api/auth/users")
def list_users():
    """GET /api/auth/users (DM) -> every account, without hashes."""
    require_dm()
    return jsonify([public(k, v) for k, v in sorted(_load()["users"].items())])


@bp.delete("/api/auth/users/<name>")
def delete_user(name):
    """DELETE /api/auth/users/<name> (DM) -> remove an account. The DM cannot delete themselves, and the last
    DM can never be removed (that would lock everyone out). Their characters stay, unowned."""
    require_dm()
    with lock:
        d = _load()
        k = _key(name)
        rec = d["users"].get(k)
        if not rec:
            abort(404)
        if k == _key(current_user()["name"]):
            return jsonify(error="You cannot delete your own account"), 400
        del d["users"][k]
        _save(d)
    import party  # imported here: party imports this module too
    party.disown(rec.get("name", name))
    return jsonify(ok=True)


@bp.post("/api/auth/users/<name>/password")
def reset_password(name):
    """POST /api/auth/users/<name>/password {"password"} (DM) -> set a new password for someone who forgot theirs."""
    require_dm()
    pw = (request.get_json(force=True, silent=True) or {}).get("password", "")
    if len(pw) < MIN_PASSWORD:
        return jsonify(error=f"Password must be at least {MIN_PASSWORD} characters"), 400
    with lock:
        d = _load()
        rec = d["users"].get(_key(name))
        if not rec:
            abort(404)
        rec["hash"], rec["ver"] = generate_password_hash(pw), secrets.token_hex(8)
        _save(d)
    return jsonify(ok=True)


def _live_invites(d):
    """Drop expired invites from `d` and return the rest."""
    now = time.time()
    d["invites"] = {t: i for t, i in d["invites"].items() if i.get("expires", 0) > now}
    return d["invites"]


@bp.get("/api/auth/invites")
def list_invites():
    """GET /api/auth/invites (DM) -> unused, unexpired invites: [{"token","note","expires"}]."""
    require_dm()
    d = _load()
    return jsonify([{"token": t, **i} for t, i in _live_invites(d).items()])


@bp.post("/api/auth/invites")
def make_invite():
    """POST /api/auth/invites {"note"} (DM) -> a new single-use invite for a player. The link to give them is
    /invite/<token>. `note` is only a reminder of who it is for."""
    require_dm()
    note = str((request.get_json(force=True, silent=True) or {}).get("note", ""))[:60]
    token = secrets.token_urlsafe(18)
    with lock:
        d = _load()
        _live_invites(d)
        d["invites"][token] = {"note": note, "expires": int(time.time() + INVITE_DAYS * 86400)}
        _save(d)
    return jsonify(token=token, path=f"/invite/{token}")


@bp.delete("/api/auth/invites/<token>")
def revoke_invite(token):
    require_dm()
    with lock:
        d = _load()
        d["invites"].pop(token, None)
        _save(d)
    return jsonify(ok=True)


@bp.post("/api/auth/redeem")
def redeem():
    """POST /api/auth/redeem {"token","username","password"} -> use an invite: create the player account and sign in."""
    body = request.get_json(force=True, silent=True) or {}
    with lock:
        d = _load()
        inv = _live_invites(d).get(body.get("token", ""))
        if not inv:
            return jsonify(error="This invite link is no longer valid"), 410
        err = _valid_new(body.get("username"), body.get("password"))
        if err:
            return jsonify(error=err), 400
        del d["invites"][body["token"]]
        _save(d)
        key = _create(body["username"], "player", body["password"])
    return _start_session(jsonify(ok=True), key)


# ------------------------------------------------------------------ pages
@bp.get("/login")
def login_page():
    """GET /login : the sign-in page (also holds "Create the DM account" on a first run)."""
    return render_template("login.html")


@bp.get("/invite/<token>")
def invite_page(token):
    """GET /invite/<token> : where a player chooses their user name and password. Shows an error if the link has
    expired or was already used."""
    valid = token in _live_invites(_load())
    return render_template("invite.html", token=token, valid=valid, google=google_enabled())


# ------------------------------------------------------------------ Google sign-in (optional)
GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"


def _redirect_uri():
    base = os.environ.get("DND_PUBLIC_URL", "").rstrip("/") or request.url_root.rstrip("/")
    return base + "/auth/google/callback"


def _error_page(message, status=400):
    return Response(render_template("login.html", error=message), status)


@bp.get("/auth/google")
def google_start():
    """GET /auth/google[?invite=TOKEN&username=NAME] : send the browser to Google to sign in.

    The "state" value we send comes back unchanged, signed so it cannot be forged; it carries a random
    nonce (also stored in a short-lived cookie, so only the browser that started the sign-in can finish it)
    and, for an invite, the invite token and chosen user name.
    """
    if not google_enabled():
        abort(404)
    nonce = secrets.token_urlsafe(12)
    state = _signer("google-state").dumps({"n": nonce, "i": request.args.get("invite", ""),
                                           "u": request.args.get("username", ""), "next": request.args.get("next", "/")})
    url = GOOGLE_AUTH + "?" + urlencode({
        "client_id": os.environ["DND_GOOGLE_CLIENT_ID"], "redirect_uri": _redirect_uri(), "response_type": "code",
        "scope": "openid email", "state": state, "prompt": "select_account"})
    resp = redirect(url)
    resp.set_cookie("dnd_oauth", nonce, max_age=600, httponly=True, samesite="Lax", secure=request.is_secure)
    return resp


@bp.get("/auth/google/callback")
def google_callback():
    """GET /auth/google/callback : Google sends the browser back here with a one-time code.

    We swap the code for an ID token by calling Google directly (server to server over HTTPS, using our
    client secret), read the verified email address from it, then either sign in the account that has that
    email, finish an invite (creating a player account linked to the address), or sign in the DM whose
    address is DND_DM_EMAIL. Any other address is refused.
    """
    if not google_enabled():
        abort(404)
    try:
        state = _signer("google-state").loads(request.args.get("state", ""), max_age=600)
    except BadSignature:
        return _error_page("The Google sign-in expired. Please try again.")
    if state["n"] != request.cookies.get("dnd_oauth") or not request.args.get("code"):
        return _error_page("The Google sign-in could not be verified. Please try again.")
    try:
        r = requests.post(GOOGLE_TOKEN, timeout=15, data={
            "code": request.args["code"], "client_id": os.environ["DND_GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["DND_GOOGLE_CLIENT_SECRET"], "redirect_uri": _redirect_uri(),
            "grant_type": "authorization_code"})
        r.raise_for_status()
        # The ID token arrived straight from Google over HTTPS, so its contents can be trusted without
        # checking its signature (OpenID Connect allows this for the code flow). Part 2 of a JWT is the payload.
        part = r.json()["id_token"].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except Exception:
        return _error_page("Google did not accept the sign-in. Please try again.")
    if claims.get("aud") != os.environ["DND_GOOGLE_CLIENT_ID"] or not claims.get("email_verified") or \
            claims.get("iss") not in ("https://accounts.google.com", "accounts.google.com"):
        return _error_page("That Google account could not be verified.")
    email = claims["email"].lower()

    with lock:
        d = _load()
        # 1. An invite being finished: create the player and link the address.
        if state.get("i"):
            inv = _live_invites(d).get(state["i"])
            if not inv:
                return _error_page("This invite link is no longer valid.", 410)
            err = _valid_new(state.get("u"), None)
            if err:
                return _error_page(err)
            if any(u.get("email") == email for u in d["users"].values()):
                return _error_page("That Google account is already linked to a user.")
            del d["invites"][state["i"]]
            _save(d)
            key = _create(state["u"], "player", None, email)
        else:
            # 2. An account already linked to this address.
            key = next((k for k, u in d["users"].items() if u.get("email") == email), None)
            # 3. The DM's own address: make the DM account the first time.
            if not key and email == os.environ.get("DND_DM_EMAIL", "").lower():
                base = re.sub(r"[^A-Za-z0-9_.-]", "", email.split("@")[0])[:28] or "dm"
                name, n = base, 1
                while _key(name) in d["users"]:
                    n += 1
                    name = f"{base}{n}"
                key = _create(name, "dm", None, email)
            if not key:
                return _error_page("No account uses that Google address. Ask the DM for an invite link.", 403)
    nxt = state.get("next") or "/"
    resp = redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else "/")
    resp.delete_cookie("dnd_oauth")
    return _start_session(resp, key)
