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
| `monster` | a companion: `label`, `name`, `size`, `type`, `alignment`, `abilities`, `hd`, `hpMax`, `hpCurrent`, `armor`, `speed`, `cr`, `savingThrow`s, `skill`s, `vulnerable`, `resist`, `immune`, `conditionImmune`, `senses`, `languages`, `trait` / `action` / `reaction` / `legendary` sections, `text`, `environment` | see "Companions" below. A companion picked from Fight Club's own list has only `label`, `name`, `size`, `type`, `abilities`, `hd` |
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

## Ability scores, item slots and mods

* `<abilities>` holds the BASE scores. The score Fight Club shows is the base plus every `<mod>` with `category` 1 in the race (and its features), background, class, character feats and active items: `type` is the ability (0 STR ... 5 CHA; **absent means 0**) and `value` the amount. Each level-up's Ability Score Improvement is one such `mod` on the `<class>`. Lynius: WIS 17 + race 1 + two level-ups = 20 (checked against the phone app).
* An item's `<slot>`: 1 or none = carried, 2 = main hand, 4 = off hand (a shield or a second weapon), 5 = body armor. Where a ring, amulet or boots go is unknown (none worn in any sample), so the app cannot equip those. An item `mod` with `type` 10 and a `value` is an AC bonus; `type` 1 / 2 with a `value` are attack / damage bonuses. **Which items' bonuses count** (checked on a phone: Lynius shows STR 23): armor, shields and weapons only when equipped; any other item when it has a slot at all. Slot 1 (the pack's main list) counts, so his Belt of Stone Giant Strength (slot 1, +9) applies; an item with NO slot (stowed) does not, so his Gauntlets of Ogre Power (+5) do not. Both the score bonuses and armor class bonuses follow this rule (`fcedit.is_active`).
* Quantity is `<quantity>` (none = 1).

## Companions (`<monster>`) and class trackers

Confirmed from `FightClub5_Lynius_Creature.backup` (a custom creature with everything filled in, a companion with hit points set, a compendium companion) and the file's owner. Code: `fcmonster.py`.

* **What "Add companion" writes.** Buggy's Aalpamac was made by THIS app (an earlier version, six fields), downloaded and imported into Fight Club without trouble, so Fight Club does not need more than `label`, `name`, `size`, `type`, `abilities` and `hd`, and everything else is optional. It is not a sample of what Fight Club itself writes: only Floofy (label and type "Squirrel") is that. The app writes label and type = the monster's name, the monster's own six scores and its full hit dice (`13d12+52`), plus `hpMax`, `hpCurrent`, `armor` and `speed`.
* **Hit points and AC** live on the monster: `hpMax`, `hpCurrent`, `armor`. Fight Club writes them once somebody sets them (Logan's "Mana" is 7 of 11).
* `size`: 0 Tiny, 1 Small, 2 Medium, 3 Large, 4 Huge, 5 Gargantuan (Fight Club's own files give 0 Tiny, 1 Small, and 5 as the largest option, so 2-4 follow in order). `speed`: feet. `cr`: the challenge rating itself (6 = CR 6).
* `savingThrow`: `ability` 0-5 = STR..CHA, `modifier`. `skill`: `id` 0-17 = the skills in alphabetical order (as `charcalc.SKILLS`), `modifier`.
* `environment`: a bit mask: Arctic 1, Forest 2, Mountain 4, Underwater 8, Coastal 16, Grassland 32, Swamp 64, Urban 128, Desert 256, Hill 512, Underdark 1024 (all = 2047). Display only.
* Sections `trait`, `action`, `reaction`, `legendary`: `name`, `text`, `recharge`, `charges`, and any number of `attack` (`name`, `type` 1 melee / 2 ranged / 3 magic, `attackBonus`, `damage`, `damageType`).
  * `recharge`: 0 none, 1 "#/day" (then `charges` is the number), 2-5 "Recharge N-6", 6 "Recharge 6", 7 after a short rest, 8 after a long rest. A section this app writes would always use 1 with `charges` 1 (the app writes no sections today).
  * `damage`: dice such as `1d20`; `1n55` is ONE die of 55 sides (shown as 1d55). `attackBonus` and `damage` may be Fight Club formulas with `%` tokens (`%3+%4+%2`, `1w+1o`): nobody knows what they mean, so they are shown as written and never calculated. Damage type codes beyond 1-3 are unknown (shown as "type 12").
* **Class trackers**: `<class><tracker>` (`label`, `type`, `resetType`, `value` = left now, `formula` = the most) and `<autolevel><tracker>` giving the `formula` from that level on (Channel Divinity: 1, 2 at level 6, 3 at level 18). `resetType` 1 is the only value seen; it is read as "returns on a short rest" (unconfirmed); every tracker returns on a long rest.

## The compendium in a backup, and how Fight Club makes a character from it

A backup holds the Fight Club app's compendium after the characters: top-level `race`, `class`, `background`, `feat`, `spell`, `item` and `monster` elements, in exactly the shape a character holds them (the file `FightClub5_with_level_1_cleric.backup` has 82 races, 13 classes, 55 backgrounds, 75 feats, 504 spells, 2149 items and 1030 monsters: the collection "CoreRulebooksAndSupplements" of the Fight Club 5e XML repository). Making a character **copies** them: the character's `race` is the compendium race (its `feat`s and ability `mod`s, written in ability order) with the looks added after the name; the `background` is the compendium background; the `class` is the compendium class (saving throw `proficiency` codes, chosen skills 100+, `slots`/`slotsCurrent` for level 1, the whole 20-level `autolevel` table, `spellAbility`); a `spell` is copied as it is with `prepared` inserted before its `sclass` names (none for a cantrip); starting gold is a bare `Gold (gp)` item (name, type 15, quantity, value 1.0, weight 0.02) plus `money`. A level-1 first class has no `level` or `hdCurrent`, and the character no `xp`. The class's own `feat` list holds the features EARNED: for each level reached, every autolevel feature that is not `optional`, then the options chosen. A choice is a non-optional feature F (Divine Domain, Primal Path, Fighting Style, Pact Boon ...) that has optional features named "F: Option"; the option's own "Option: ..." features come with it at their levels; "Starting Cleric" is optional and taken by a first class (`codex.py` reads all of this).

## What Fight Club's reader needs (found the hard way: a downloaded character once crashed it)

Fight Club's own files hold **no empty element at all** (none of the 1.8 MB sample has a single `<x/>` or `<x></x>`), and the app now never writes one: `fcedit.strip_empty` runs on every character as it is saved and as it is read (so a file an earlier version saved with an empty `<age/>`, `<materials/>` or `<text/>` is cleaned), and a feat with no text gets its name as text. Also: a class's level table entries (`autolevel` / `feat`) have only `name`, `text` and `optional`, no `expanded`; every character ends with `slots`, `slotsCurrent` and `money` (a decimal); a race holds a looks tag only when it has a value. `test_fcsafe.py` checks an upload, many edits, a level-up and characters made by the wizard for every class against the tags Fight Club's own sample uses, for empty elements, for numbers that are numbers, and for the ten-number slot lists. If a download ever fails to import into Fight Club again, run it and compare the tag that differs.

## Spell slot lists: position 0 is the cantrips

`slots` and `slotsCurrent` (on the character and on each class) are ten numbers. **Position 0 is the number of cantrips known** (a 13th-level Cleric is `5,4,3,3,3,2,1,1,0,0`: five cantrips, then four 1st-level, three 2nd-level ... slots; a level 2 Cleric `3,3,0,...`: three cantrips and three 1st-level slots), and positions 1 to 9 are the slots of spell level 1 to 9. Earlier versions of this app read position 0 as 1st-level slots, which showed every level one place too low; `fcedit.slot_levels` / `set_slot_levels` now read and write levels 1 to 9 and leave the cantrip count alone. A character made by the creation wizard writes both lists this way.

## Slots and what the app keeps beside the file

Fight Club's `<slot>` only covers armor (5), the off hand (4) and the main hand (2); 1 is the pack's main list. It has no place for a belt, boots or attunement, so this app keeps the worn kind and attunement in the extras (see `GLOAN5E-FORMAT.md`), and the Fight Club file is unchanged by them. New items the app adds have no `<slot>` (stowed).
