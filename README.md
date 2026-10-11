<p align="center">
  <img src=".github/images/logo-banner.png" alt="VileMK" width="480">
</p>

VileMK is a keymap editor for keyboards that run [ZMK](https://zmk.dev), the
open-source firmware used by most wireless split keyboards. You change what
each key does in a web page on your own computer, and VileMK turns that into
firmware for your keyboard. Nothing is uploaded anywhere.

The name is a nod to [Vial](https://get.vial.today/), the graphical keymap
editor from the QMK world that inspired this project. Vial is a potion bottle;
VileMK is vile, as in ruthless.

<img src=".github/images/app-overview.png" width="800" alt="The app: the sidebar with saved variations and vendor defaults, the Build panel open above an Eyelash Sofle keymap, and the tab menu under the board">

## Contents

- [Words used here](#words-used-here)
- [Two modes](#two-modes)
  - [Firmware mode](FIRMWARE.md)
    - [1. Add your keyboard](FIRMWARE.md#1-add-your-keyboard)
    - [2. Make a variant](FIRMWARE.md#2-make-a-variant)
    - [3. Edit your keys](FIRMWARE.md#3-edit-your-keys)
    - [4. Optional: prepare for Studio mode](FIRMWARE.md#4-optional-prepare-for-studio-mode)
    - [5. Build](FIRMWARE.md#5-build)
    - [6. Flash](FIRMWARE.md#6-flash)
    - [Keymapping](FIRMWARE.md#keymapping)
    - [Building firmware in detail](FIRMWARE.md#building-firmware-in-detail)
  - [Studio mode](STUDIO.md)
    - [What vile slots are for](STUDIO.md#what-vile-slots-are-for)
    - [1. Prepare the firmware](STUDIO.md#1-prepare-the-firmware)
    - [2. Connect and edit](STUDIO.md#2-connect-and-edit)
    - [3. Keep the changes in a variant](STUDIO.md#3-keep-the-changes-in-a-variant)
    - [Reset to flashed firmware](STUDIO.md#reset-to-flashed-firmware)
- [How combos work](#how-combos-work)
- [Getting started](#getting-started)
  - [Requirements](#requirements)
  - [Install and start](#install-and-start)
- [The keymap tabs](KEYMAP.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Command line and keyboard list details](CLI.md)

## Words used here

<details>
<summary>New to ZMK? Open for the words this guide uses.</summary>

| Word | Meaning |
|---|---|
| **Firmware** | The program that runs inside the keyboard. It decides what each key sends. |
| **Keymap** | The part of the firmware that says which key does what, layer by layer. In ZMK it is a `.keymap` text file. |
| **Layer** | A full set of key meanings. Holding a layer key switches the whole board to another layer, the way Shift switches letters to capitals. |
| **Build** | Turning a keymap into a firmware file (`.uf2`). VileMK does this on your computer with Docker. |
| **Flash** | Copying that firmware file onto the keyboard. The keyboard shows up as a USB drive and you copy the file onto it. |
| **Vendor default** | The keymap your keyboard came with, as its maker published it. VileMK never changes it. |
| **Variant** | Your own copy of a keymap, which you edit, build and flash. |
| **Module** | A keyboard maker's GitHub repository with the files ZMK needs for their keyboard. VileMK fetches it when you add the keyboard. |
| **ZMK Studio** | A feature of ZMK that lets a program change keys on a plugged-in keyboard without a build. VileMK's Studio mode uses it. |
| **Split keyboard** | A keyboard in two halves. Each half has its own firmware file and is flashed on its own. |
| **Bootloader** | A mode the keyboard starts in to receive new firmware, usually by pressing its reset button twice quickly. It then shows up as a USB drive. |
| **Combo** | Two or more keys pressed together that send something else. |
| **VileDance** | One key that does different things on a tap, a hold, a double tap, or a tap then hold. |
| **Vile slots** | Room the build sets aside so Studio mode can add VileDances and combos without another build. |

</details>

## Two modes

The switch at the top of the page picks one.

| | Firmware mode | Studio mode |
|---|---|---|
| What you edit | A keymap file (a variant) | The keys on a keyboard plugged in over USB |
| When a change works | After a build and a flash | At once |
| What you can add | Everything: combos, macros, VileDances, hold-taps, mod-morphs, conditional layers, layers | Anything already in the firmware, plus VileDances and combos in the vile slots the build set aside |
| What it needs | Docker, to build | A keyboard flashed once from Firmware mode with a `&studio_unlock` key, plugged in over USB (not Bluetooth) |

**Start in Firmware mode.** Every keyboard is set up there: you add it, make
your variant, build and flash it once.

**Use Studio mode** afterwards to try key changes on the keyboard straight
away, without building. When you like the result, **Save as variant…** turns
it back into a keymap file, so the next build has it too.

- [Firmware mode](FIRMWARE.md): add a keyboard, make a variant, build and
  flash, and every behavior tab.
- [Studio mode](STUDIO.md): the vile slots build, then connecting and editing
  the keyboard live.

## How combos work

A combo fires when its keys are pressed together. Each combo has a switch per
keymap, so it can be on for one variant and off for another:

| State | In the firmware | Keys pressed together | Studio mode |
|---|---|---|---|
| **Off** | Not built | Each key types as usual | Cannot change it |
| **Reserved** | Built with `&none`, needs vile slots | Nothing happens, the keys do not type | Can switch it On |
| **On** | Built and active | Sends the combo's output | Can switch it Reserved or change its output |

Without vile slots, Reserved is the same as Off. New combos and changes to a
combo's keys, timeout or layers need a build. See
[KEYMAP.md](KEYMAP.md) for the Combos tab and [STUDIO.md](STUDIO.md#what-vile-slots-are-for)
for vile slots.

## Getting started

### Requirements

You need:

- **Python 3.9 or newer.** Its one extra package, pyserial (to talk to a
  keyboard over USB), installs itself into `.venv/` in the checkout the first
  time the app starts.
- **Node**, to build the web page. `make design` runs it for you.
- **Docker**, for building firmware. Your user has to be able to run `docker`
  without sudo (on Linux, add yourself to the `docker` group and log in
  again). Without Docker the app still edits, checks and exports keymaps; only
  **Build firmware** is off, and it says why.
- **make** and **git**, usually already installed.
- **A USB data cable** for the keyboard. Some cables only charge and carry no
  data; with one of those the keyboard never shows up.

### Install and start

```bash
git clone https://github.com/cosminoance/VileMK.git
```

```bash
cd VileMK
```

Fetch ZMK. This downloads the parts of ZMK the app needs and pins the exact
version, so every keymap is checked and built against the same ZMK:

```bash
make zmk
```

Start the app:

```bash
make design
```

Open `http://127.0.0.1:7879` in your browser. Leave the terminal running while
you use the app; Ctrl+C stops it.

Then continue with [Firmware mode](FIRMWARE.md), step 1. The video walkthrough on
[YouTube](https://www.youtube.com/playlist?list=PLAOzGtpkRAZg) shows the same steps.

## Troubleshooting

[TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers flashing problems, Studio mode
not finding or not editing a keyboard, what a keyboard module needs, each build
error and what it means, and missing drivers.

## Command line and keyboard list details

[CLI.md](CLI.md) has the sidebar's keyboard list and module management in
detail, and the `make` commands for running checks and builds from a terminal.
Everything there can be done from the app.
