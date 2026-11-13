# Linked components: keep related features in step

Audience: the coding assistant working on this repo. Read this file at the start of every session (CLAUDE.md points here).
Goal: when one feature changes, the other features that depend on it get the same change, without a user having to remember
them, and without the assistant looping forever.

## The rules

1. **Track links as you work.** When a change creates or touches a link between two parts of the app, add or update a row in
   the registry below. This is a small edit and needs no confirmation.
2. **Do the link check LAST.** Finish the requested work first: code, tests, README/doc updates, the recap. Only then run the
   link check. It is the final step of the prompt, so a skipped or slow link check never blocks the real work.
3. **Run it once per user prompt.** For each part you added or changed this prompt, find its registry rows and list the linked
   components that were NOT updated. If there are none, say "link check: nothing outstanding" and stop.
4. **Ask before changing anything.** Put the list to the user as ONE question with the `wrap_up` buttons (or `AskUserQuestion`
   when there is no wrap_up): apply all, or skip. Name each candidate in one short line. Never apply link-check changes
   without an answer.
5. **No recursion.** Changes made because of a "yes" are NOT link-checked again. If doing them reveals more links, write them
   under "Open candidates" below and mention them in one line; they are raised only in a LATER prompt, and only if the user's
   next request touches that area.
6. **Respect "no".** A skipped candidate goes under "Declined" with the date. Do not offer the same pair again unless the user
   asks.
7. **Keep it cheap.** The check is a read of this file plus targeted `grep` calls for the names in the row. It is not a
   code review and it does not add features the user did not ask about.

## Registry

Each row: the thing that changes, the components linked to it, and what must be updated in them.

| When this changes | Linked components | Update |
|---|---|---|
| A new kind of card on the campaign tracker (flag, encounter, loot flag, condition, ...) | `Canvas.clickMenu` entries in `static/campaign.js`; the `LIB` table and `#encDlg` there; toolbar buttons in `templates/campaign.html`; `frameModel` / `locate`; link keys (`lookup`, `isDone`, `pruneLinks`); `cards_of()` and `reindex()` in `encounters.py`; Browse "Campaigns" column | add a menu entry, a toolbar button if the others have one, link handling, and the card scan |
| A new kind of item on the soundboard (sound, tile, section, ...) | click-menu build function in `static/app.js`; toolbar buttons in `templates/index.html`; `frameModel`; `placeSound`; cable/link code | add a menu entry and toolbar button; place it where the canvas was clicked |
| The click menu on either canvas | `Canvas.clickMenu` in `static/canvas.js` (shared); the build functions in `static/app.js` and `static/campaign.js` | change the shared function once; keep both build functions' entries in step |
| A field on an encounter or loot table | `_clean_line` / `_clean_entry` and `_create` in `encounters.py`; the Builder config in `static/encounters.js` / `static/loottable.js`; `static/browse.js` columns; card rendering (`encounterEl`, `lootEntries`) in `static/campaign.js`; `test_enc.py` | add the field to each |
| A new library-style record type (like encounters / loot) | `LIB_FILES`, `adopt`, `reindex`, `forget_campaign` in `encounters.py`; `LIB` in `static/campaign.js`; a Browse kind; a Builder config; `put_state` key list in `app.py` | give it its own file, campaign usage tracking, Browse list and editor |
| A new page / tab | `templates/_nav.html`; `templates/shell.html` (iframe, `urls`, popstate, `reloadPages` list); `app.py` (shell route list, active mapping, `/_/` route); `static/errors.js` include; README table | add each |
| A new Python module | `Dockerfile` COPY line; `app.py` import / `bind()` / blueprint registration | add each |
| A new button that can fail | `static/errors.js` (shows the error beside the button); downloads must use `safeDownload` | use buttons, not links, for downloads; no `alert` pop-ups for new code |
| A new route a player may use | `PLAYER_PREFIXES` in `auth.py`; the player view in `static/home.js` / `static/party.js`; `test_auth.py` | allow it, show it, test it |
| A new list or table on Home or another page | `UI.dataTable` in `static/ui.js` (regex + Finder search, filters, tags) | use `dataTable` so search and filters match every other list |
| A new searchable catalogue (like monsters / items) | `Catalog` and `_routes` in `encounters.py`; `Finder.panel` config; `Builder` config | add a Catalog, reuse Finder and Builder |
| A new key stored in the campaign state | `put_state` preserved keys and `keep_campaign` in `app.py`; `adopt()` migration if it moves out | decide whether it travels with the campaign or lives outside it |
| Anything that edits encounters or loot tables (a new editor, import, bulk action) | `UI.libraryChanged()` / `UI.onLibraryChanged()` in `static/ui.js`; `Builder` (`changed()`); `Browse.mount` listener; `campaign.js` save | call `UI.libraryChanged()` after the change so Browse lists on other pages refresh |
| Cables / links between items (soundboard chains, campaign links) | `Cables.paths`, `Cables.pair`, `Cables.live`, `Cables.tempPath` in `static/cables.js`; `drawLinks` and `startLink` in `static/app.js` and `static/campaign.js` | change the shared function once; keep both `drawLinks` link records `{a, b, sx, ex, cs, ct}` and both obstacle lists in step |
| The result-list size (10 / 20 / 50 / 100) | `Finder.pageSize` in `static/finder.js` (saved in localStorage `finder.pageSize`), used by `Finder.panel` and `UI.dataTable` through the single button `Finder.pageSize.more`; the compact pop-up is fixed at 6 ("Show more") | change it once in `Finder.pageSize`; the button only appears when a list is longer than 10 rows |
| The Fight Club file format (new character fields, export rules) | `fcformat.py` (encoder); `party._characters_from` / `_read_upload` / `_backup_download`; `FIGHTCLUB-FORMAT.md`; `test_fc.py` against a real `FightClub5.backup`; Dockerfile COPY | change the encoder and the rules doc together and re-run the byte-for-byte test |
| A new way to import characters (another upload box, an API client) | `Importer.start` in `static/importer.js` (preview, choose, import each); `preview_import` / `import_party` in `party.py`; templates must load `importer.js` | call `Importer.start` instead of posting the file straight to `/api/party/import` |
| A new per-sound setting (volume, amp, ...) | the sound dialog in `templates/index.html`; `openSoundDlg` (fill) and the submit handler (read) in `static/app.js`; the card (`soundEl`); `level()` / `applyVolume` if it changes the gain; the data-model comment at the top of `app.js`; README | add the field to every one of these |
| The app icon or name in the banner | `static/icon.jpeg`; the `<link rel="icon">` in every full page template; the `.brand` markup in `_nav.html`, `login.html`, `invite.html`, `landing.html`; `/favicon.ico` in `app.py`; the page headings in `landing.html` and `static/home.js` | change all of them together |
| What a link means (a new link field or rule on the campaign tracker, like a condition's group / tier) | `linkSatisfied`, `isDone`, `markLinked`, `drawLinks` (wire style and unlock flash), `trackUnlocks`, `addLink`, the re-route code in `startLink`, `pruneLinks`, and the condition dialog in `static/campaign.js`; README | change them together; a link's satisfaction is only decided in `linkSatisfied` |
| A new postMessage type between frames | header comment of `templates/shell.html`; receiving page's message handler | document it and handle it |

## Notes

- The phone layout (`MOBILE`, body class `mobile` in `static/app.js`) is dormant: no server code sets that class any more, so every device
  gets the canvas layout and a tap works like a click. Do not build phone-only features unless the user brings the phone layout back.

## Open candidates (raised only when a later request touches the area)

- (none yet)

## Declined

- (none yet)
