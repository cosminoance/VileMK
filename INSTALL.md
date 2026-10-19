# Install and start

[← back to the README](README.md)

## Requirements

You need:

- **Python 3.9 or newer.** Its one extra package, pyserial (to talk to a
  keyboard over USB), installs itself into `.venv/` in the checkout the first
  time the app starts. On macOS, if downloads from GitHub fail with a
  certificate error: with Python from python.org run its **Install
  Certificates.command** once (in `/Applications/Python 3.x/`); with Homebrew
  run `brew reinstall ca-certificates openssl@3`.
- **Node.js 20.19 or newer**, to build the web page. `make design` runs it for
  you. Ubuntu's and Debian's own `nodejs` package is too old; use
  [nodejs.org](https://nodejs.org/) or the command `make design` prints.
- **Docker**, for building firmware. On macOS and Windows install
  [Docker Desktop](https://www.docker.com/products/docker-desktop/) and keep it
  running. On Linux install Docker Engine with the command for your system:

  - Arch: `sudo pacman -S docker`
  - Ubuntu, Debian, Mint: `sudo apt install docker.io`
  - Fedora: `sudo dnf install docker`

  Then let your user run `docker` without sudo (log out and back in after the
  first command; the `docker` group is equivalent to root on that machine):

  ```bash
  sudo usermod -aG docker $USER
  ```

  ```bash
  sudo systemctl enable --now docker
  ```

  Without Docker the app still edits, checks and exports keymaps; only
  **Build firmware** is off, and it says why. `make design` warns at start
  when Docker cannot be reached.
- **git**, and on Linux and macOS **make**. On macOS, run
  `xcode-select --install` if either is missing. Many Linux installs lack make:
  `sudo apt install make`, `sudo dnf install make` or `sudo pacman -S make`.
- **A USB data cable** for the keyboard. Some cables only charge and carry no
  data; with one of those the keyboard never shows up.

## Install and start

**Windows:** install [Python](https://www.python.org/downloads/) (tick "Add
python.exe to PATH"), [Node.js LTS](https://nodejs.org/) and [Docker
Desktop](https://www.docker.com/products/docker-desktop/) (it installs WSL2 and
may ask you to restart Windows). Get the code into a
short folder such as `C:\VileMK`, either with
`git clone https://github.com/cosminoance/VileMK.git C:\VileMK` or with **Code →
Download ZIP** on GitHub, unzipped there. A deep folder like `Downloads\...` can
hit Windows' 260-character path limit when keyboard files are fetched. Open the
folder and double-click `start.bat`. It checks for Python and Node, builds the page and
opens the app in your browser. Keep its window open while you use the app;
closing it stops the app.

**Linux and macOS:**

```bash
git clone https://github.com/cosminoance/VileMK.git
```

```bash
cd VileMK
```

Start the app:

```bash
make design
```

It first checks for Python and Node and, if one is missing, says how to install it
on your system. On first start it also fetches pyserial and the parts of ZMK the app needs
(pinned to an exact version, so every keymap is checked and built against the
same ZMK), and warns if Docker cannot be reached.

The page opens in your browser by itself; if it does not, open `http://127.0.0.1:7879`.
Leave the terminal running while you use the app; Ctrl+C stops it.

Then continue with [Firmware mode](FIRMWARE.md), step 1.
