# Fight Club 5e backup format: rules the encoder follows

Source: a real `FightClub5.backup` (6 characters, 9 MB) exported by the Fight Club app, plus the six characters this app
stored from it. `fcformat.py` writes this format; `party.py` reads it. `test_fc.py` (kept with the test scripts, skipped when
the real file is missing) checks that our export of those six characters is **byte for byte** what Fight Club wrote.

## The file

| Rule | Evidence |
|---|---|
| It is ONE PLAIN XML FILE named `*.backup`. It is **not** a zip. (We used to zip it, and Fight Club rejected that.) | `FightClub5.backup` starts with `<?xml`, is not a zip |
| First line `<?xml version="1.0" encoding="UTF-8"?>` with double quotes, then `\n<data>\n` | file start |
| Header on one line: `<version>37</version><uid>N</uid>` | file start |
| Then every `<character>`, each followed by `\n` | tails in the file |
| After the characters, portraits: `<imageData><uid>U</uid><encoded>BASE64</encoded></imageData>` (base64 wrapped at 76 characters, a `\n` before `</encoded>`) | last element of the file |
| Ends with `</data>`, no trailing newline | file end |
| No indentation, no spaces between tags, `<x></x>` for an empty element, one `\n` after every `</container>` | whole file |
| Text escapes are numeric: `&`=`&#38;` `<`=`&#60;` `>`=`&#62;` `'`=`&#39;`; `"` and all non-ASCII text are written as themselves | entities in the file |

The header `uid` is Fight Club's counter for new ids (1031 in the real file, one more than the highest uid used). We write
`max(1031, highest uid in the file + 1)`.

## What the real file also holds (we do NOT write it)

Besides characters, `<data>` bundles every library object the app knows: ~2,200 `<item>`, ~1,000 `<monster>`, ~500 `<spell>`,
80 `<race>`, 75 `<feat>`, 57 `<background>`, 13 `<class>`, 13 `<container>`. Characters are self-contained (each carries
its own race, class, items and spells in full), so we assume the library is optional. **Unverified**: if Fight Club still
rejects a character-only file, the next experiment is to bundle the library objects a character uses.

## A character (`<character>`), in the order Fight Club writes it

| Tag | Meaning and format (observed) |
|---|---|
| `version`, `uid` | `37`; the character's own id |
| `name` | text |
| `imageData` | only holds `<uid>` here: it points at the portrait stored at `<data>` level |
| `abilities` | `STR,DEX,CON,INT,WIS,CHA,` (comma list with a trailing comma) |
| `hpMax`, `hpCurrent`, `xp` | integers (`xp` is absent on a new character) |
| `unarmed` | damage expression such as `1d4+%1` (`%1` = ability modifier), or `1` |
| `meleeAbility`, `inspiration` | small integers; present only when set |
| `race` | `name`, `speed`, `age`, `height`, `weight`, `eyes`, `skin`, `hair`, `size`, `spellAbility`, `proficiency`, many `feat` (`name`, `text`, `expanded`), `mod` |
| `background` | `name`, `proficiency` codes, `feat`s, `align`, `mod` |
| `class` | `name`, `level`, `hd`, `hdCurrent`, `wealth` (`5d4x10`), `slots` and `slotsCurrent` (ten comma-separated numbers), `proficiency` codes, `numClassSkills`, `armor`, `weapons`, `tools`, `spellAbility`, `feat`s, `mod`s, one `autolevel` per level (`slots`, `feat`s, `scoreImprovement`), and the character's `spell`s (`name`, `school`, `level`, `time`, `range`, `v`/`s`/`m`, `materials`, `duration`, `text`, `prepared`, `sclass`, `roll`, `ritual`) |
| `container` | `name`, `value`, `weight`, `ignore`, `text`, and the `item`s inside it |
| `feat` | `name`, `text`, `prereq`, `proficiency`, `expanded`, `mod` |
| `item` | `name`, `detail`, `text`, `type` (code), `magic`, `slot`, `value`, `weight`, `ac`, `strength`, `stealth`, `roll`, `damage1H`, `damage2H`, `damageType` (code), `weaponProperty` (a number that combines flags), `weaponRange`, `weaponLongRange`, `quantity`, `mod` |
| `mod` | `category`, `type`, `value` (and sometimes `name`): a bonus the item, feat or class gives |
| `note` | `name`, `text`, `expanded`, `archived` |
| `monster` | a companion: `label`, `name`, `size`, `type`, `abilities`, `hd` |
| `slots`, `slotsCurrent`, `money` | spell slots (maximum, remaining) as comma lists; `money` as a decimal number |

Numbers are written the way Java writes them: `65.0`, `2.0`, `1.5E7`. Tags that do not apply to a character are left out
rather than written empty. Codes (item `type`, `damageType`, spell `school`, `weaponProperty`, `proficiency`) are numbers;
the meanings this app knows are in `party.py` (`ITEM_TYPES`, `SCHOOLS`, `DAMAGE_TYPES`, `WEAPON_PROPS`, `HIT_DIE`) and `charcalc.py`.

## How this app uses it

* **Import** (`party._read_upload`): accepts a plain `.backup`/`.xml`, or a zip holding one. Each `<character>` is stored as it
  came (`data/party/<id>.xml`); its portrait (matched by `<imageData><uid>`) is saved as `data/party_images/<id>.b64`.
* **Edits** (HP, slots, trackers...) change values inside the stored XML, so an export is still a faithful Fight Club file.
  Mana, conditions, owner and death saves live beside it in `data/party_extra.json` and are not exported.
* **Export** (`party._backup_download`): `fcformat.encode(characters, portraits)`. Default is the plain `.backup`; add
  `?format=zip` for the old zipped form. Whole party: `FightClub5.backup`; one character: `FightClub5-<Name>.backup`.

## Still guesses (to confirm in the Fight Club app)

1. That the plain `.backup` is accepted, and whether the **file name** matters.
2. That a backup without the bundled library objects restores the characters fully.
3. Whether the header `uid` has to be above every uid already in the app.


## Codes worked out from real files (used by the Skills and Stats page)

Found by comparing the codes in the sample characters with what the game says about them; only the ones listed are confirmed.

| Where | Code | Meaning |
|---|---|---|
| class `hd` | 1, 2, 3, 4 | hit die d6, d8, d10, d12 (Cleric 2, Fighter and Paladin 3, Barbarian 4) |
| item `damageType` | 1, 2, 3 | bludgeoning (a Maul), piercing (Rapier, Dagger), slashing (a Battleaxe) |
| item `weaponProperty` | sum of bits | 1 Ammunition, 2 Finesse, 4 Heavy, 8 Light, 128 Thrown, 256 Two-Handed, 512 Versatile (a Dagger is 138 = 2 + 8 + 128). 16 Loading, 32 Reach, 64 Special are the unconfirmed low bits in the compendium's order |
| item `mod` (with a `value`) | `type` 1 / 2 / 10 | attack bonus / damage bonus / armor class bonus (a +2 Maul has 1:+2 and 2:+2; a plate "Armor Bonus" is 10:+2). A `mod` with no `value` carries nothing |
| class or background `proficiency` | 0-5 | a saving throw, by ability order STR..CHA (a Cleric has 4 and 5 = Wis and Cha) |
| class or background `proficiency` | 100-117 | a skill, in alphabetical order: 100 Acrobatics, 101 Animal Handling, 102 Arcana, 103 Athletics, 104 Deception, 105 History, 106 Insight, 107 Intimidation, 108 Investigation, 109 Medicine, 110 Nature, 111 Perception, 112 Performance, 113 Persuasion, 114 Religion, 115 Sleight of Hand, 116 Stealth, 117 Survival |
| class `autolevel` | one per level, with a `<level>` child | the class's whole level table, including EVERY subclass option (marked `optional`); the character's own `class/feat` list is already just what they have, so features come from there |
| `monster` | `label`, `name`, `size`, `type`, `abilities`, `hd` (e.g. `1d8`) | a companion; no hit points are stored. Seen in ONE file (a squirrel named Floofy: label and type "Squirrel", size 0). "Add companion" writes these same six fields (`party.add_companion`): label and type = the monster's name, `size` 0-5 = Tiny..Gargantuan (only 0 and 1 are confirmed), `hd` = the monster's hit dice. Unconfirmed: whether Fight Club needs more, or matches label/type against its own monster list |
