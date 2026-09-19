

<p align="center">
  <img src=".github/images/logo-banner.png" alt="VileMK" width="480">
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=jn9MJbdGJI8">
    <img src="https://i.ytimg.com/vi/jn9MJbdGJI8/maxresdefault.jpg" alt="VileMK - local zmk visual remapper" width="480"><br>
    <img src="https://img.shields.io/badge/-Watch%20on%20YouTube-red?logo=youtube&logoColor=white&style=for-the-badge" alt="Watch on YouTube">
  </a>
</p>

Tooling for authoring ZMK keymaps by hand, covering the things ZMK Studio
can't express: combos, macros, VileDances (Vial-style tap/hold/double-tap
dances), hold-taps and home-row mods, mod-morphs, conditional layers, encoder
bindings.

The name is a nod to [Vial](https://get.vial.today/), the graphical keymap
editor from the QMK world that inspired this project. Vial is a potion bottle;
VileMK is vile, as in ruthless. There is no live USB protocol. You write
devicetree and validate it locally before it reaches CI.

This repo holds only the tools. The firmware sources live in the config repo
created by the [`zmk` CLI](https://zmk.dev/docs/zmk-cli), and every tool here
finds that repo on its own:

```bash
zmk config user.home                        # where the CLI keeps it
zmk config user.home /path/to/zmk-config    # point the tools somewhere else
```

To override that for one run, pass `--repo PATH` or set `$ZMK_CONFIG`. Every
tool prints the repo it picked as its first line.

Nothing here writes to the config repo. Keymap edits go to `config/*.keymap`
there; firmware is built by GitHub Actions on push to that repo.

## Working in tandem with the ZMK config repo

VileMK is the second half of a two-repo setup. The first half is ZMK's own,
done exactly as ZMK's docs describe. VileMK starts where the CLI stops.

1. **Install the ZMK CLI and create the config repo.** [Installing
   ZMK](https://zmk.dev/docs/user-setup) covers installing the CLI and running
   `zmk init`, which creates the config repo on GitHub, clones it, and wires
   up the GitHub Actions workflow that builds firmware on every push.

2. **Add your keyboard.** [Keyboard
   management](https://zmk.dev/docs/zmk-cli#keyboard-management) covers both
   kinds:
   - A keyboard ZMK itself defines: run `zmk keyboard add` and pick it from
     the list.
   - A keyboard defined in a vendor's repository (an external module, as with
     the Eyelash Sofle): the same command takes the vendor's repo, adds it to
     `config/west.yml`, and downloads it into `.zmk/modules/`.

   Either way the CLI ends by adding entries to `build.yaml` and copying a
   default keymap into `config/`.

3. **Push once and flash the default firmware.** Optional, but a passing
   build before any custom keymap tells you the setup itself is sound.

4. **Run the VileMK server and modify the mappings:**

   ```bash
   make design
   ```

   No flags, no keymap argument. The server finds the config repo itself, and
   the keymap `zmk keyboard add` installed into `config/` is loaded
   automatically as the base you edit, drawn on its real key positions. Click
   keys to reassign them; design VileDances, macros, combos, modifiers and
   layers on top.

5. **Save your work as a variant and hand it back.** **Save as new variant**
   writes the modified keymap and a matching `build.yaml` under `variants/`
   in this repo, never into the config repo. Copying it across and pushing is
   a manual step, covered in
   ["Putting a variant on the keyboard"](#putting-a-variant-on-the-keyboard).

The ZMK CLI sets up and builds, the VileMK server is where mappings change,
and `variants/` travels between the two.

## Requirements

Python 3.9+. Clone and run; there is nothing to install.

Optionally, `pyproject.toml` installs the four tools as commands
(`vilemk-ui`, `vilemk-keypos`, `vilemk-check`, `vilemk-design`), so they work
from inside the config repo without a path to this one:

```bash
uv tool install --editable .    # or: pip install -e .
```

## Tools

| Command | What it does |
|---|---|
| `python3 -m vilemk.webui.build` | Builds `keymap-ui.html`: every keymap drawn on its real key positions, with layer tabs, combos, and a compare view that highlights what a variation changed. |
| `python3 -m vilemk.keypos config/<board>.keymap` | Prints the key-position map for a keyboard: the numbers that `key-positions` and `hold-trigger-key-positions` refer to. |
| `python3 -m vilemk.check config/<board>.keymap` | Static validation before a CI round-trip: binding counts per layer, out-of-range positions, undefined `&labels`, bad keycodes, arity, braces. It also reads `build.yaml` and flags halves built from different keymaps, a `KEYMAP_FILE` that names nothing, a part the vendor builds that your entry leaves out, and colliding artifact names. Pass `--no-build-list` for keymaps only. |
| `python3 -m vilemk.webui.server` | The same viewer, but editable: design VileDances, macros, combos, modifiers and layer bindings in Vial-style panels, click keys to reassign them, save to `custom/` and `variants/`. |

### Designing a keymap: every tab in the app

```bash
make design
```

This opens the viewer at `http://127.0.0.1:7879` with one board on screen and
a menu of eight tabs underneath it: **Keyboard**, **Media & system**,
**VileDance**, **Macros**, **Modifiers**, **Layers**, **Combos** and
**Conditional layers**.

Click a key on the board to open its editor. Whichever tab you're on, picking
something fills that key. Instead of a key, you can open one of the tabs'
**+ New …** buttons, which opens a creation panel above the menu; the menu
then fills whatever field in that panel you last clicked, the same way. Only
one thing (a key editor or a panel) is ever open at once, but nothing you
typed is lost by switching: each kind keeps its own unsaved draft, and the tab
you left grows a **Resume …** button until you either finish it or start a
fresh one.

Six of the eight tabs work this way — they fill a field. The last two,
**Combos** and **Conditional layers**, don't: nothing on the board can point
at a combo or a conditional layer, so instead of picking one into a key you
switch it on or off for the keymap you're looking at. Both kinds are covered
below.

#### Keyboard

The plain 104-key ANSI layout. Click a key on the board to open its editor,
then click a key on this tab: that assigns the keycode straight away, no
separate confirm step. Typing a binding by hand into the key editor's own
field still needs **Apply**.

<img src=".github/images/tab-keyboard.png" width="560" alt="The Keyboard tab's picker: the 104-key ANSI board, with Tab picked for the open key">

#### Media & system

Everything ZMK can send that a keyboard has no keycap for, in seven groups:

| group | examples | what the board needs |
|---|---|---|
| Media and consumer | volume, play/pause, brightness | nothing — every board sends these |
| Mouse | left/right/middle click, pointer movement, scroll | `CONFIG_ZMK_POINTING` |
| Bluetooth and output | profile select, clear, USB/BLE output | a wireless board |
| Lighting | underglow and backlight on/off, brightness, effect | the LEDs, plus the matching Kconfig |
| Power and firmware | soft off, bootloader, reset, Studio unlock | reset and bootloader are universal; the rest are not |
| Typing extras | caps word, key repeat, grave escape | nothing |
| Sticky and locked keys | one-shot (`&sk`) and latched (`&kt`) over the eight modifiers | nothing |

Each group names what has to be true of the board before its buttons do
anything real — a binding whose feature the firmware was never built with
doesn't misbehave, it fails to compile. Saving a variant adds whatever
`#include` lines those bindings need, and says so in the save message; you
never add them by hand.

This tab saves nothing itself. There's no record and no card — it's a picker,
same as Keyboard.

<img src=".github/images/tab-media-system.png" width="560" alt="The Media & system tab's picker: seven labelled groups of buttons, from media codes to sticky modifiers">

#### VileDance — Vial-style tap dances

Vial, the QMK-world editor this project takes its name from, has a
**TapDance** key: one key position, up to four different outputs depending on
how you hit it — a tap, a hold, a double tap, or a double tap where the
second press is held. ZMK has nothing that does all four in one behavior;
getting a hold *and* a double-tap out of a single key means nesting a
hold-tap inside a tap-dance. A **VileDance** is that composition, built for
you from four fields:

| slot | fires on |
|---|---|
| on tap | a single press and release |
| on hold | pressing and holding past the tapping term |
| on double tap | two presses within the tapping term |
| on tap + hold | the second press held down |

Fill only **on tap** and you get a plain key — no extra devicetree at all.
Add **on hold** and it becomes one hold-tap behavior. Add **on double tap**
(and optionally **on tap + hold**) and it becomes a tap-dance holding one or
two hold-taps. A hold slot has to be a behavior that takes exactly one
parameter — `&kp`, `&mo`, `&sk` — not something that takes none.

Two settings shape the timing: **tapping term** (how long a hold has to last,
and how much time a second tap has to land in) and **flavor**, which decides
how the hold-tap resolves an interrupting keystroke. The tap/hold pair keeps
whatever flavor you set; the double-tap/tap-hold pair always resolves fast
(`balanced`) regardless, because by the second press you've already committed
to something other than plain typing — a layer-hold there should engage the
instant the next key lands, not wait out a second tapping term. Because a
tap-dance's own term runs before the nested hold-tap's does, a plain hold on
this key lands at roughly *twice* the tapping term you set — worth knowing
before you tune it down.

A VileDance can't hold another VileDance in one of its own four slots — a
tap-dance inside a tap-dance is a keyboard nobody could predict the timing
of — but it can hold a **macro** in the double-tap or tap-hold slot. "Double
tap to type my email" is exactly the kind of thing a macro slot is for.

A saved VileDance is a live reference, not a copy: bind it to as many keys as
you like, and editing the record later changes every one of them the next
time you save a variant. The board tile for a key bound to one shows the
resolved tap with a small hint for the hold in the corner, rather than the
raw generated label.

<img src=".github/images/tab-viledance.png" width="380" alt="The VileDance panel: Name, four slots, tapping term and flavor, over Save/Devicetree/Close/Delete">

#### Macros

A **macro** is a sequence played back from one key, built from six kinds of
step:

| step | does |
|---|---|
| text | types the string you enter — the reason this tab exists; one field for `someone@example.com`, not nineteen individual key steps |
| tap | presses and releases one binding |
| press | holds a binding down across the steps that follow |
| release | lets a held binding go |
| wait | pauses for a number of milliseconds |
| pause | stops until the key the macro is bound to is itself released |

Add steps with the buttons at the bottom of the panel, reorder two with the
↑/↓ next to each row, remove one with ✕. A text step only understands what a
keyboard can actually type — letters, digits, the shifted symbols, space, tab,
newline; anything else (accented letters, emoji) is refused rather than
silently dropped, since there's no key position for it to send. There's also
a hard ceiling on how much one macro can queue at once (ZMK's own
`CONFIG_ZMK_BEHAVIORS_QUEUE_SIZE`, 64 by default) — a macro over that limit is
refused at save time rather than failing partway through on the actual
keyboard.

A macro can't hold itself as one of its own steps, but it can hold another
saved macro, and can be the target of a VileDance slot or a combo's output.

<img src=".github/images/tab-macros.png" width="420" alt="The Macros panel: a saved ctrl+alt+delete macro, six press/release steps with reorder and delete controls">

#### Modifiers

A chain of up to three [ZMK modifier
functions](https://zmk.dev/docs/keymaps/modifiers) — shift, control, alt, gui,
each left or right — wrapped around a keycode, e.g. ctrl+shift+A. Click up to
three of the eight modifier buttons in the panel (**remove last** / **clear**
to walk them back), then use the menu below to fill **Parameter** with the
key they wrap — a plain key, or another saved modifier, nested inside this
one's innermost slot.

Unlike a VileDance, a modifier's resolved text is baked in wherever you pick
it — there's no reference back to the saved record, because a modifier chain
isn't a devicetree behavior, just ZMK preprocessor syntax. Editing a saved
modifier later doesn't change a key that already picked it; re-pick it to
propagate the change.

<img src=".github/images/tab-modifiers.png" width="560" alt="The Modifiers panel: a saved ctrl+shift+F10 chain, the eight modifier buttons, and the resolved Parameter">

#### Layers

Layer switching in all five of ZMK's shapes, as ad-hoc one-click rows at the
top of the tab — no saving needed, since a layer number is the whole story
for four of them:

| row | behavior | what it does |
|---|---|---|
| Hold | `&mo` | layer on while held, off on release |
| Tap key / hold layer | `&lt` | tap for a key, hold for the layer |
| Sticky | `&sl` | one shot — on for the next key press only |
| Toggle | `&tog` | on until the same key is pressed again |
| Switch to | `&to` | switches to this layer and turns every other one off |

**Tap key / hold layer** is the one row worth naming and saving: give it a
tapping term or a flavor and it becomes its own generated hold-tap, with the
same live-reference behavior a VileDance has — a saved card you can bind to
several keys and edit in one place. Leave both blank and it's the same plain
`&lt` the ad-hoc row builds for free.

The Layers tab is also where you add a layer to the keyboard: a **+ layer**
button next to the layer tabs above the board, up to ZMK's own 32-layer cap.
It prompts for a name and starts the layer blank (every key `&trans`) until
you assign something into it; nothing is written until you save a variant.

<img src=".github/images/tab-layers.png" width="560" alt="The Layers tab's picker: the five ad-hoc rows, one button per layer, with two saved layer-tap cards below">

#### Combos and Conditional layers

The two board-wide tabs. A **combo** fires a binding when two or more keys on
the board are pressed together — open its panel and click the keys on the
board above to build the chord, same board, no separate picker. A
**conditional layer** turns a layer on automatically while two or more other
layers are held together (the common case: hold layer 1 and layer 2, get
layer 3).

Neither goes on a key, so neither can be picked into a field. What you decide
instead is whether *this keymap* gets it: each row has an On/Off switch, and
it's per keymap file — the same combo can be on for one variant and off for
another. A newly created one is switched on only for the keymap you designed
it against; flip it on for others yourself.

<img src=".github/images/tab-combos.png" width="380" alt="The Combos panel: a saved chord's Name, Keys, Output key and Timeout"> <img src=".github/images/tab-conditional-layers.png" width="380" alt="The Conditional layers panel: a saved tri-layer rule's Name, If layers and Then layer">

#### Saving

Every design above is written to `custom/` as you work, independent of any
keymap. Nothing reaches a keymap file until you save a variant — see ["Save
your work as a variant and hand it
back"](#working-in-tandem-with-the-zmk-config-repo) above. Only the generated
behaviors your keys, VileDances and combos actually reference are written;
anything designed but never bound stays out of the file entirely.

### make

```
make          # check every keymap, then build the viewer and open it
make design   # the editable viewer
make check    # validation only: build.yaml, then config/ and variants/
make ui       # write keymap-ui.html
make view     # write it and open it in your default browser
make pos      # key-position maps
make install  # put the vilemk-* commands on your PATH
make clean
```

Pass extra flags through `ARGS`, e.g. `make ui ARGS="--all"` or
`make check ARGS="config/corne.keymap"`.

`make` only looks for a Makefile in the current directory; it has none of the
repo-finding logic the tools do. From anywhere else, point it here:

```bash
make -C ~/git/VileMK          # or: make -C ~/git/VileMK check
```

Or run `make install` once and use `vilemk-ui --open`, `vilemk-check` and
`vilemk-keypos` directly; those find the config repo on their own, from any
directory.

## variants/

Saved copies of a keymap, never built. See
[variants/README.md](variants/README.md). Each one is a folder holding the
keymap and the `build.yaml` that builds it.

## Putting a variant on the keyboard

**The short way.** The designer writes a variant as a folder with both files
in it, so putting one on the keyboard is two copies and a push:

```bash
cp variants/<name>/<name>.keymap  /path/to/zmk-config/config/
cp variants/<name>/build.yaml     /path/to/zmk-config/build.yaml
make check          # keymap and build list, before the round trip
```

That generated `build.yaml` contains your repo's own entries for that
keyboard with only the `KEYMAP_FILE` swapped, so a split keeps both halves
and a `shield:` or `snippet:` survives. It also replaces everything else the
repo built. To keep building the original keymap too, merge by hand using the
rest of this section, giving each entry an `artifact-name:`.

The rest of this section explains what that generated file does for you, and
what you need to know when you write one yourself.

Nothing in `variants/` is ever built. The config repo's `build.yaml` drives
GitHub Actions, and ZMK picks a keymap by name: for each entry it looks in
`config/` for a file named after the board or shield being built,
`<board>.keymap` or `<shield>.keymap`. That is the file the `zmk` CLI
installed. Leave it alone; add your variant beside it and tell the build to
use the variant.

**1. Copy the variant into the config repo's `config/` directory, under a
name that matches no board and no shield.** The convention in `variants/`
works here too: `<keyboard>-<what-it-is>.keymap`. The suffix keeps the file
inert, since ZMK's name-based lookup will not pick it up on its own, so the
keymap the CLI installed stays as it is, just no longer the one being built.

The file has to live in the config repo. GitHub Actions only ever checks out
that repo and has no idea VileMK exists.

**2. Point the build at it.** In the config repo's `build.yaml`, give every
entry for that keyboard a `cmake-args` line naming your file:

```yaml
include:
  - board: <board>
    cmake-args: -DKEYMAP_FILE="${GITHUB_WORKSPACE}/config/<your-variant>.keymap"
```

Entries that use a shield keep their `shield:` line; only `cmake-args` is
added.

`KEYMAP_FILE` is a ZMK build setting. It names the keymap outright, so the
search by board name never runs. Write the path with `${GITHUB_WORKSPACE}` as
above rather than as a relative path; the build does not always run from the
directory you would expect.

A split keyboard has one entry per half, and both need the line, pointing at
the same file. The halves are two separate microcontrollers, each with its
own firmware, built from the same single keymap file: one keymap, two `.uf2`
files. Giving the two halves different keymaps produces a keyboard whose left
side does not agree with its right.

> **Watch `build.yaml` after every `zmk keyboard add`.** The CLI writes those
> entries itself, and it writes them plain: no `cmake-args`, and for a split,
> one entry per half. Anything it adds or re-adds is therefore back on the
> name-based lookup and building the CLI's own keymap, not yours. After each
> run, reopen `build.yaml` and put the line back on both halves, spelled
> identically. It drops more than the keymap line; see "What else the CLI
> leaves out" below.

To keep building the original keymap as well, leave the existing entries
alone and add extra ones carrying the `cmake-args`, each with an
`artifact-name`, so the two builds' `.uf2` files do not collide inside
`firmware.zip`.

**3. Validate, then commit and push in the config repo.** The push triggers
the build:

```bash
make check ARGS="<path to the copy you made in config/>"
```

That reads the keymap and `build.yaml`, so the line you just added is checked
too: whether both halves carry it, whether it points at a file that is really
there, and whether it is written as an absolute path.

When the run finishes, download its `firmware.zip`. Put each half into its
bootloader (on most boards, double-tapping reset mounts it as a USB drive)
and copy the matching `.uf2` across.

To go back to the original keymap, delete the `cmake-args` lines and push.
The file the CLI installed was never touched, so the name-based lookup finds
it again.

### What else the CLI leaves out

`zmk keyboard add` gives you a starting point. It writes the shortest thing
that could work, the board name and nothing else, because it cannot know what
you actually own.

Most keyboards are more than a board. A screen, an encoder, or an add-on
module is a separate part the build has to be told about, on the line for the
half it is plugged into. The same keyboard is often sold in several versions
(with a screen and without, one encoder or two), all built from one set of
files by the same vendor. So there is no single correct build list the CLI
could have written for you. There is the vendor's list, describing the
versions they sell, and there is yours, describing the one on your desk.
Reconciling the two is a step you do by hand, once, per keyboard.

Skip it and the build either comes back missing a feature, or fails with a
compiler error that says nothing about the missing line.

**Where to look.** The vendor's own list ships with the keyboard's code,
which the CLI downloaded into the config repo when you added the keyboard.
Reading in there is normal even though nothing in it is yours to change. In
the config repo, open:

```
.zmk/modules/<keyboard-module>/build.yaml
```

`<keyboard-module>` is the folder named after your keyboard; for an Eyelash
Sofle, `.zmk/modules/zmk-eyelash-sofle`. Nothing under `.zmk/` is yours: it
is a downloaded copy. Read it, never edit it, because the next fetch
overwrites it. If the folder is not there yet, the same file is on the
keyboard's GitHub page, at the top level of the repository `config/west.yml`
names.

Put that file beside your own `config/build.yaml` and compare them entry by
entry. For each half, the vendor's file may carry lines yours does not:

| line | what it means |
|---|---|
| `shield:` | an extra part on that half, most often a screen. Missing it is what makes a build fail on a keyboard that has a display. |
| `snippet:` | an optional build mode, like the one that enables ZMK Studio |
| `cmake-args:` | build settings; yours already has one naming your keymap |
| `artifact-name:` | a label so two `.uf2` files in the same download do not collide |

**What to copy: the `shield:` lines, for the parts you actually have.** Take
them exactly as spelled, onto the half they belong to. Leave your own
`cmake-args` line where it is and add the shield beside it:

```yaml
include:
  - board: eyelash_sofle_left
    shield: nice_view
    cmake-args: -DKEYMAP_FILE="${GITHUB_WORKSPACE}/config/eyelash_sofle-colemak.keymap"
```

The rest of the vendor's entries, such as a Studio build or a settings-reset
build, are extra firmware files you may not want. Copy those only if you know
you need them.

**When you do not have the part.** This is the version problem above, and it
takes one more step. Leaving the `shield:` line out is right, but it may not
be enough on its own. A vendor building for the version with the part often
switches that feature on for everyone, down in the keyboard's own settings.
The build then goes looking for hardware that is not there and fails. You
have to switch it back off.

You do that without touching the vendor's files. Make a file in the config
repo's `config/` directory named after the half it applies to
(`config/<board>.conf`, so `config/eyelash_sofle_left.conf` for an Eyelash
Sofle's left side) holding the one line that turns the feature off:

```
CONFIG_ZMK_DISPLAY=n
```

The file is added on top of the vendor's settings, not in place of them: only
what you write here changes, and everything else the keyboard needs carries
on untouched. The file is yours, the CLI never touches it, and it survives
every `zmk keyboard add` from here on.

The mirror image is yours to handle too: a part you added that the vendor
never listed needs its own line here.

**`make check` reads `build.yaml` too**, and every mistake in this section is
one it looks for: the two halves naming different keymaps, a `KEYMAP_FILE`
that points at nothing, a vendor `shield:` your entry left out with no
`.conf` line switching the matching feature off, and two entries whose
`.uf2` files collide. It compares your build list against the vendor's own,
in the CLI cache, and against what is actually in `config/`. It never
writes: it prints the line to add, and you edit and push.

It cannot check everything. A `shield:` the vendor never listed, a part they
list under a name that looks nothing like a display, or a keyboard with no
vendor module in the cache at all are still yours to read for. When it has
nothing to compare against it says so rather than staying quiet.

### A worked example: Eyelash Sofle

`zmk keyboard add` has been run once for an Eyelash Sofle. The config repo
now has `config/eyelash_sofle.keymap`, the CLI's default keymap, and a
`build.yaml` holding one entry per half:

```yaml
include:
  - board: eyelash_sofle_left
  - board: eyelash_sofle_right
```

In VileMK you designed some VileDances and combos, bound them, and hit **Save
as new variant**, which wrote `variants/eyelash_sofle-colemak.keymap`.

Copy that file into the config repo's `config/` directory. Keep the name:
`eyelash_sofle-colemak.keymap` matches neither board, so ZMK will not find it
by name, and `eyelash_sofle.keymap`, which does match and which the CLI owns,
stays where it is.

Then edit `build.yaml` so both halves name the file you just copied:

```yaml
include:
  - board: eyelash_sofle_left
    cmake-args: -DKEYMAP_FILE="${GITHUB_WORKSPACE}/config/eyelash_sofle-colemak.keymap"
  - board: eyelash_sofle_right
    cmake-args: -DKEYMAP_FILE="${GITHUB_WORKSPACE}/config/eyelash_sofle-colemak.keymap"
```

The two lines are identical: same file, both halves.

Now the check above. `.zmk/modules/zmk-eyelash-sofle/build.yaml` carries
`shield: nice_view` on the left half and `shield: nice_view_custom` on the
right. This keyboard was sold with screens, and the CLI's two plain entries
say nothing about them. Which lines you want depends on the version you own:

- **With the screens**: add each `shield:` line to its half, beside the
  `cmake-args` line already there.
- **Without them**: leave the shields out. The left half's own settings
  switch the display feature on regardless, and the build then fails on a
  missing screen, so add `config/eyelash_sofle_left.conf` containing
  `CONFIG_ZMK_DISPLAY=n`. The right half needs nothing; its settings never
  turn the display on.

Check the copy, then commit and push in the config repo:

```bash
make check ARGS="/path/to/zmk-config/config/eyelash_sofle-colemak.keymap"
```

The run produces a `firmware.zip` holding `eyelash_sofle_left-…-zmk.uf2` and
its right-hand counterpart. Flash the left half with the left file and the
right half with the right one.

The Eyelash Sofle is a board, so its entries have no `shield:` line. A
keyboard built as a shield on a generic controller, like a Corne on a
nice!nano, has `board:` and `shield:` on each entry; leave both alone and add
the same `cmake-args` line beside them.
