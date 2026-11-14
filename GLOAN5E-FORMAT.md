# Gloan5e: Fight Club 5e plus extras

A Gloan5e file keeps a Fight Club 5e backup and this app's extras side by side, so a player can use either app. Code: `gloan5e.py` (pure functions, no Flask).

## Layout

`<name>.gloan5e` is a zip file holding:

| Entry | Content |
|---|---|
| `FightClub5.backup` | the Fight Club backup, byte-for-byte the same as the "Fight Club 5e" download |
| `gloan.json` | `{"format": "gloan5e", "version": 1, "characters": {"<uid>": {extras}}}` |
| `README.txt` | how to get the Fight Club file back |

Extras link to a character by its Fight Club `<uid>` and are never merged into the XML, like a table that links two fields without combining them. Extras keys (`gloan5e.EXTRA_KEYS`): `trackers`, `conditions`, `deaths`, `worn`, `attuned`. The owner and pending gifts belong to one server and are never exported.

- `worn`: `{item key: "head"|"neck"|"cloak"|"hands"|"wrists"|"belt"|"feet"|"ring"|"off"}`
- `attuned`: `{item key: true|false}`
- An item key is a short hash of the item's name, detail and type (`gear.all_items`), with `-2`, `-3` for items that look the same. Renaming an item breaks the link.

## Converting

- Gloan5e to Fight Club: take the `FightClub5.backup` entry out (`gloan5e.strip`). Fight Club never sees the extras.
- Fight Club to Gloan5e: the same record with empty extras (`gloan5e.load`).
- Detection: the `.gloan5e` extension or the `gloan.json` + `FightClub5.backup` entries (`gloan5e.is_gloan`).

## Routes (party.py)

`GET /api/party/<id>/export.zip?as=gloan5e|fightclub5e` (default Fight Club) and `GET /api/party/export.zip?as=...` for all. Upload (`/api/party/preview`, `/api/party/import`) accepts both kinds; extras are applied by `<uid>`, and a Fight Club upload leaves a character's existing extras alone.
