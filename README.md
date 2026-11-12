# DM Soundboard

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python app.py            # http://127.0.0.1:5000
    .venv/bin/python app.py --live     # ignore the launch campaign, load live changes
    .venv/bin/python app.py --campaign NAME

Sounds are downloaded once into `media/` (yt-dlp for YouTube, scraped mp3 for MyInstants), then
decoded in the browser so playback is instant. State lives in `data/` (live.json autosave,
versions/ snapshot per server start, presets/ = your saved campaigns, config.json launch choice, users.json accounts).

## Accounts: DM and players
`/` is a banner page with the app's header and a **Login** button. There are two permission levels, enforced by the server on every request (`auth.py`):
- **DM** sees everything: Home, Soundboard, Campaign, Characters, the party tracker, accounts and invites.
- **Player** sees only Home and **My character**: they can upload a Fight Club file (the same import as before) and view or edit what they uploaded. Everyone else's characters, and every other page, answer "forbidden".

The DM's **Home** tab lists the saved campaigns, the party, every uploaded character with the player who owns it (changeable), the accounts, and invite links. Players cannot register on their own: the DM creates a single-use invite link (valid 7 days). The player opens it, types a user name and presses **Next**, then either sets a password (typed twice) or presses the standard **Sign up with Google** button.
- **Linking accounts.** One person can end up with two accounts (say a password one and later a Google one). On the Home tab, under "Link accounts", the DM picks the account to keep and the one that is "the same person": the second is folded into the first, with its characters, campaign memberships and sign-in methods, and then deleted. The DM can also attach a Google address to an existing account ("Add Google address"), so that person signs in with Google into the account they already have.
- **Password resets** are offered only for accounts that have a password. A Google-only account has nothing to reset (the person's Google account handles that), and setting one would quietly add a second way in that the DM chose.
- **Campaigns and join requests.** Players see the campaign names (nothing inside them) and press **Request to join**; the request appears at the top of the DM's Home tab to approve or deny. Each account records the campaigns it belongs to; a player whose character is added to a campaign's party joins that campaign automatically.
Sign-in is by user name and password (stored only as salted hashes in `data/users.json`) and optionally Google. **First run:** a local copy with no accounts stays open (everyone is the DM) until you create an account on `/login`; a deployed copy (which has `DND_PASSWORD` set) is locked, and `/login` offers "Create the DM account", which asks for `DND_PASSWORD` as the setup key. Google sign-in needs `DND_GOOGLE_CLIENT_ID`, `DND_GOOGLE_CLIENT_SECRET` and (optionally) `DND_DM_EMAIL`; see the top of `auth.py`.

## Campaigns
**Campaign** is the new name for what used to be called a preset: a named snapshot of the soundboard and the campaign tracker (stored in `data/presets/`). It now also carries the list of **party members**, saved as references only (character id, name, owner), never the character sheets. Each sheet stays with the player who uploaded it (`data/party/<id>.xml`), so loading a campaign brings back who is in the party, and each member appears as soon as their file is on the server (until then Home says "waiting for <player>"). On the Home tab, the **Characters** list holds every uploaded character that is not in the campaign; **Add to campaign** moves one into **Party in <campaign>** (and out of the Characters list), and **Remove from campaign** moves it back. Because the party list is part of the campaign file, loading another campaign swaps the lists automatically. The party tracker panel shows just the party.

## Party
- `/party` import (.backup/.xml/.zip from Fight Club 5), export (zip with FightClub5.backup), per-character full pages at `/party/<id>`.
- Tracker: the **Party** button on the soundboard (floating panel) or `/tracker` (pop-out window).
- Characters are stored as their original Fight Club XML in `data/party/`; HP, slots, hit dice, inspiration and money edits are written back so export round-trips. "Mana"/conditions have no Fight Club field, so they are kept in `data/party_extra.json` and are not exported.

## Where to start reading the code
| File | Role |
|---|---|
| `app.py` | Flask server: saves/loads the soundboard, downloads audio, campaigns, versions, launch options |
| `auth.py` | Flask blueprint: accounts, sign-in (password and Google), invites, and which requests each level may make |
| `party.py` | Flask blueprint: Fight Club character import/export, tracker edits, initiative storage |
| `templates/*.html` | Page outlines (JavaScript fills in the rest) |
| `static/home.js` | The Home tab: campaigns, party, roster and accounts for the DM; the player's own character and upload |
| `static/app.js` | The soundboard: audio engine, chains, cable routing, drag and drop (long header explains the data model) |
| `static/tracker.js`, `static/party.js` | Party/initiative tracker widget and the /party pages |
| `static/style.css` | Styling, built in layers (later rules override earlier ones) |

Every file starts with a plain-language overview, and every function has a comment explaining what it does and why.

## Your own audio files (mp3s/ folder)
Drop audio files (.mp3 .ogg .wav .m4a .opus .aac .flac) into `mp3s/`, or use **Browse...** in the add/edit sound dialog (it uploads the picked file into that folder). The server rescans the folder every 2 seconds, and the dialog's drop-down lists what is there. A sound using one is saved as `library:<file name>`; if the file goes missing the card shows "failed" and recovers by itself when the file comes back.

## Campaign tracker (/campaign)
Same layout as the soundboard (sections > tiles > subsections, drag and drop), but the clickable items are **flags** the party has triggered. A flag can have a checklist (the tile grows to fit it, up to a per-flag max width), a loot table you can roll on (🎁), and an optional soundboard sound that plays when it is triggered (the soundboard page must be open). Campaign data is stored inside the same state file as the sounds, so every preset and version snapshot includes it.

## The canvas (pan and zoom, like ComfyUI)
The soundboard and the campaign tracker are infinite canvases. Drag empty space to pan (or hold Space and drag, or middle-mouse drag), use the mouse wheel to zoom (Shift + wheel pans sideways), and use the buttons in the bottom-right corner to zoom or **Fit** everything into view. Drag a tile by its title bar to move it and drag its bottom-right corner to resize it. Each section is drawn as a coloured frame around its tiles (drag the frame's title bar to move the whole section; drop a tile inside another frame to move it to that section). The first tile goes in the middle of the canvas and new tiles are placed in the nearest free spot around their section. See `static/canvas.js`.

## One app, several pages at once
Once signed in, every address (`/`, `/sound`, `/campaign`, `/party`) serves the same shell page (`templates/shell.html`): one shared header ("DND Tracker", always linking to Home, with the current page highlighted) and the Home, Soundboard, Campaign and Characters pages loaded together as frames (a player gets only Home and Characters). The soundboard now lives at `/sound`; `/` is Home. Switching tabs only shows/hides a frame, so the soundboard keeps playing (and its timers keep running) while you look at the other pages. The real pages are served under `/_/...`; `/tracker` stays a stand-alone pop-out window.

## Campaign links
In the campaign tracker, drag from the circle on the right edge of ANY item (section, tile, flag, checklist entry, a flag's loot table) onto any other item to link them. A cable is solid green once the item it comes from is done (flag triggered, entry ticked, loot rolled, tile/section finished) and dashed otherwise; items still waiting on something are shown dimmed ("locked") with a tooltip. Click a cable to remove it. Flags have a 🗑 button.

## Switching focus between playing chains
When more than one chain is playing, one is "in focus" (the arrow keys, the chain buttons and the highlight act on it; the others are dimmed less than idle chains). A **"Chains playing" bar** appears at the bottom with one chip per playing chain: click a chip to move the focus there (the canvas pans to it if needed), or use `[` and `]`. The corner badge of a sound playing in a background chain also turns into a ◎ focus button. None of these touch the audio; clicking a playing sound itself still just stops it in one click. A background chain advancing by itself never steals the focus, and if the focused sound ends, focus falls back to another playing chain.


## Cards and frames (soundboard and campaign share the same layout code)
The movable things are the **cards**: sounds on the soundboard, flags on the campaign page. Each card sits at its own position (drag it by the bar along its top). Sections, tiles and subsections are **frames** drawn around the cards that belong to them and resized automatically. Drag a frame's title bar to move everything inside it. Drop a card inside another tile's (or subsection's) frame to move it there; drop a tile's frame inside another section's frame to move the tile.

**Snap** (button in the bottom-right corner, remembered): while dragging, cards snap to the grid and line up with other cards (left / centre / right and top / middle / bottom) with pink guide lines. Hold Alt to skip snapping for one drag.

## Links
Soundboard: many inputs, ONE output per sound. Campaign: any number of inputs AND outputs per item (each side shows one port per link plus an empty dashed one for the next link). On both pages you remove a link by clicking its output circle, its input square, or the cable itself; dragging a filled port re-routes it.

## Personal trackers on characters
The tracker has no built-in Mana bar. Use **+ Tracker** on a character's card to give THAT character a counter (Mana, Ki, Rage ...). Characters without one show nothing. They are stored beside the Fight Club data, not in the export. (An older single "Mana" value that was in use is kept as one tracker.)

The pop-out tracker window (Party > pop out) has no shared header: just the Party and Initiative tabs. There is no phone layout at the moment.


## Snapping options, party button, jump-to-sound
- **Snap menu** (⚙ next to Snap in the bottom-right controls): turn the grid and card-to-card alignment on or off separately, and choose which cards count for alignment: every card, only cards in the same section, the same tile, or the same subsection.
- **Party** now sits in the shared header next to the page links and works on every tab (the panel opens at the top right; "pop out" still opens the stand-alone window).
- On the campaign page the 🎯 button on a flag (and on checklist entries that have a sound) jumps to that sound: it switches to the Soundboard tab, centres the canvas on the card and flashes it. A checklist entry can be given a sound in the flag's edit dialog; ticking it plays the sound, like triggering a flag that has one.


## Undo / redo for chains
Every change to chain links can be undone and redone on both pages: making a link, removing one (click its output, input or cable) and re-routing one. Use **Ctrl/Cmd+Z** to undo and **Ctrl/Cmd+Y** (or Ctrl/Cmd+Shift+Z) to redo, or the ↶ ↷ buttons in the toolbar. Each page keeps its own history for as long as it is open (up to 100 steps), and typing in a text box keeps the browser's normal text undo. Deleting a sound, flag or tile is not part of this history. See `static/undo.js`.


## Running it on Google Cloud
`Dockerfile`, `gunicorn.conf.py` and `.dockerignore` package the app as a container, and **DEPLOY-GOOGLE-CLOUD.md** has the step-by-step instructions to upload it to Cloud Run with a Cloud Storage bucket for your data and a password for the site. Settings read from the environment: `DND_DATA_ROOT` (where data/, media/ and mp3s/ live), `DND_PASSWORD` (the setup key for the first DM account; setting it locks the site until that account exists) and `PORT`, plus the optional Google sign-in settings above.
# dnd-tracker-and-soundboard
