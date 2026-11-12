"""Fight Club 5e backup format: the ENCODER (and the rules it follows).

Fight Club's own "FightClub5.backup" is NOT a zip: it is one plain XML text file. This module writes files that match it,
so the app accepts our exports. The rules (derived from a real 9 MB backup of six characters; the full list is in
FIGHTCLUB-FORMAT.md):

  * The file starts with the declaration  <?xml version="1.0" encoding="UTF-8"?>  (double quotes), a newline, then <data>
    and another newline. It ends with </data> and NO trailing newline.
  * <data> holds, in this order: <version>37</version><uid>N</uid> on one line, then each <character> (each followed by a
    newline), then the portraits. Fight Club's own backup also bundles every library object it knows (items, spells, races ...);
    characters are self-contained (they carry their own race, class, items and spells), so we do not.
  * <uid> in the header is the app's counter for ids: at least 1031 here and above every uid used in the file.
  * A portrait is split in two: the character holds <imageData><uid>U</uid></imageData> (a reference) and <data> holds
    <imageData><uid>U</uid><encoded>BASE64</encoded></imageData> after the characters. The base64 text is wrapped at 76
    characters per line, as Fight Club writes it.
  * Elements are written inline: no indentation, no spaces between tags, <x></x> for an empty element (never <x/>). The only
    newlines are one after every </container> and one after every </character>.
  * Text escapes are numeric: & is &#38;  < is &#60;  > is &#62;  ' is &#39;  (a double quote is written as it is).
    Accented and other non-ASCII characters are written as themselves (UTF-8).

decode() is not needed here: party.py reads files with the normal XML parser, which understands both numeric and named
entities, and picks the portraits out of <data> (see party._characters_from).
"""
HEADER_UID_MIN = 1031   # Fight Club's own value for the six-character backup this was learned from
VERSION = "37"


def esc(text):
    """Escape element text the way Fight Club does (numeric entities for & < > ')."""
    return text.replace("&", "&#38;").replace("<", "&#60;").replace(">", "&#62;").replace("'", "&#39;")


def element_xml(e):
    """One element as Fight Club writes it: <tag>text<child>..</child></tag>, nothing between tags, <tag></tag> when empty.
    (Any whitespace between an element's children is dropped; the character files hold none.) Fight Club follows every
    <container> with a newline, so that is copied exactly."""
    return f"<{e.tag}>{esc(e.text or '')}{''.join(element_xml(c) for c in e)}</{e.tag}>" + ("\n" if e.tag == "container" else "")


def wrap76(b64):
    """Base64 text re-wrapped at 76 characters per line (the shape Fight Club writes), without a trailing newline."""
    flat = "".join((b64 or "").split())
    return "\n".join(flat[i:i + 76] for i in range(0, len(flat), 76))


def max_uid(characters):
    """The highest integer found in any <uid> element of the given characters (0 if none)."""
    best = 0
    for ch in characters:
        for u in ch.iter("uid"):
            try:
                best = max(best, int((u.text or "").strip()))
            except ValueError:
                pass
    return best


def encode(characters, images=None):
    """Bytes of a Fight Club backup holding `characters` (a list of <character> Elements). `images` maps a portrait uid (text) to
    its base64 text; each one is written after the characters."""
    uid = max(HEADER_UID_MIN, max_uid(characters) + 1)
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<data>\n', f"<version>{VERSION}</version><uid>{uid}</uid>"]
    parts.extend(element_xml(ch) + "\n" for ch in characters)
    for u, b64 in (images or {}).items():
        parts.append(f"<imageData><uid>{esc(str(u))}</uid><encoded>{wrap76(b64)}\n</encoded></imageData>")
    parts.append("</data>")
    return "".join(parts).encode("utf-8")
