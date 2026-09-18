<img width="2525" height="1877" alt="image" src="https://github.com/user-attachments/assets/1b67ff5b-33be-4a93-98b1-f7c11a563330" />

# VileMK

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

### Designing VileDances, macros, combos, modifiers and layers

```bash
make design
```

This opens the viewer at `http://127.0.0.1:7879` with six extra tabs:
**Media & system**, **VileDance**, **Macros**, **Combos**, **Modifiers** and
**Layers**. The Layers tab covers layer switching in all five of ZMK's shapes
(`&mo`, `&lt`, `&sl`, `&tog`, `&to`), conditional layers included, such as the
tri-layer rule where holding 1 and 2 together turns 3 on. Each design is saved
under `custom/`. A plain layer binding needs no saving: the key picker builds
one for any layer in one click.

A **macro** is a sequence played back from one key: text, taps, a modifier
held across them, a wait. Type the text you want as one step
(`someone@example.com` is one field here, not nineteen `&macro_tap` lines) and
the expansion into keycodes happens when the keymap is written.

**Media & system** saves nothing. It is the list of keys a keyboard has no
keycap for: volume and the other media codes, mouse buttons and pointer
movement, `&bt` profiles and `&out`, underglow and backlight, `&bootloader` /
`&sys_reset` / `&soft_off` / `&studio_unlock`, and one-shot (`&sk`) or latched
(`&kt`) modifiers. Each group says what a board needs before its keys do
anything, and saving a variant adds the `dt-bindings` headers those bindings
need.

The **Save as new variant** button writes `variants/<name>.keymap`: your base
keymap with the keys you reassigned, plus only the generated behaviors those
keys actually reference. Anything you designed but never bound stays out of
the keymap. Combos and conditional layers go on no key, so they are switched
on per keymap in their own tabs. A saved variant can then be rewritten in
place (**Save to ‹name›**) or removed (**Delete variant**). `config/` and the
vendor defaults are only ever read.

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
