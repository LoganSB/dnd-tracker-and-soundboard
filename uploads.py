"""uploads.py - the two small parts of accepting an uploaded file that every upload route shares.

  clean_name(filename)             the file name a browser sent, made safe to keep: no folder part, no odd characters
  save_atomic(file, dest, max)     write the upload next to its final place under a hidden temporary name, then rename it into place
                                   (so a reader never sees half a file, and a failed or too-big upload leaves nothing behind)

Used by the sound library upload (app.py) and the encounter maps (encounters.py). Pure helpers: no Flask routes here, so any module
may import this one.
"""
import os
import re
import threading
from pathlib import Path


class TooBig(Exception):
    """The uploaded file is bigger than the limit given to save_atomic."""


def clean_name(filename):
    """A safe version of an uploaded file's name. Browsers normally send only the bare name, but strip any folder part anyway, then
    replace characters that could be troublesome in a file name. May return "" (the caller then picks a default)."""
    name = Path((filename or "").replace("\\", "/")).name
    return re.sub(r"[^\w .,()\[\]&'+!-]", "_", name).strip(" .")


def save_atomic(fileobj, dest, max_bytes=None):
    """Save the werkzeug upload `fileobj` as `dest` (a Path); returns its size in bytes.

    The bytes go to a hidden temporary file in the same folder first (the folder is created if missing), and only a complete, small
    enough file is renamed over `dest`. Raises TooBig when it is over `max_bytes`, or OSError when the disk refuses; either way the
    temporary file is removed."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".upload-{os.getpid()}-{threading.get_ident()}.part"
    try:
        fileobj.save(tmp)
        size = tmp.stat().st_size
        if max_bytes is not None and size > max_bytes:
            raise TooBig(size)
        os.replace(tmp, dest)
        return size
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
