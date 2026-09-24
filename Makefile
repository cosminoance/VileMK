# Task runner - the `scripts` block of a package.json.
# Every target runs the scripts in place; nothing here needs to be installed
# first. Every command works on this checkout: config/, build.yaml and .zmk/
# live beside the code.
#
#   make            # check every keymap, then build the app and serve it
#   make design     # kill any stale instance, then start the local backend
#                   # (VileDances, combos, modifiers, layers) on
#                   # http://127.0.0.1:7879
#   make web        # build the React app in web/ into vilemk/webui/dist/
#   make webdev     # the Vite dev server, with live reload
#   make kill       # just kill a stale server, without starting a new one
#   make check      # validation only (build.yaml, then every keymap)
#   make pos        # print key-position maps
#   make zmk        # fetch ZMK's board data at the ref in config/west.yml
#                   # and pin the commit (ARGS="--ref v0.3" to switch)
#   make module ARGS=<name>
#                   # fetch a keyboard module listed in config/west.yml
#                   # into .zmk/modules/<name>/ and pin the commit
#   make module ARGS="add <github-url> --ref main"
#                   # add a module that is not in west.yml yet
#   make firmware ARGS=<variant>
#                   # build a variant's firmware in Docker, into
#                   # variants/<variant>/firmware/
#   make install    # put vilemk-* on your PATH
#   make clean

PY  ?= python3
NPM ?= npm
# Extra flags, e.g.  make check ARGS="config/corne.keymap"
ARGS ?=

.PHONY: all design kill check web webdev pos zmk module firmware install uninstall build clean help
.DEFAULT_GOAL := all

all: check design

# The app, served from a local process so it can write back to custom/ and
# variants/. Kills a stale server first - the port is fixed (7879), so a
# leftover process from an earlier session is the only thing that ever
# occupies it.
design: web kill
	$(PY) -m vilemk.webui.server $(ARGS)

# vilemk/webui/dist/ is generated and not in the repo, so this has to run once
# in a fresh clone and again after any change under web/src/. Needs Node.
# `npm ci` wipes and reinstalls node_modules every time it runs, so it hangs off
# the lockfile rather than off this target - `make design` depends on `web`.
web: web/node_modules
	cd web && $(NPM) run build

web/node_modules: web/package-lock.json
	cd web && $(NPM) ci
	@touch web/node_modules

# Live reload while working on the app. Serves http://localhost:5173/ and
# proxies /api to the Python server, so `make design` has to be running in
# another terminal for the page to have any data.
webdev:
	cd web && $(NPM) run dev

kill:
	pkill -f 'vilemk\.webui\.server' 2>/dev/null && sleep 0.3 || true

# build.yaml first - which halves get built, from which keymap, with which
# parts - then every keymap in config/ and variants/. Read-only, like
# everything here: it prints the line to add, you edit.
check:
	$(PY) -m vilemk.check $(ARGS)

pos:
	$(PY) -m vilemk.keypos $(ARGS)

# Writes .zmk/zmk/ and config/west.yml, nothing else. With no west.yml yet it
# starts one at ZMK v0.3, which is how a fresh checkout gets its board data.
zmk:
	$(PY) -m vilemk.workspace update zmk $(ARGS)

# Writes .zmk/modules/<name>/ and its pin in config/west.yml. A bare name updates
# a module listed there; `add <url>` and `remove <name>` pass straight through.
module:
	$(PY) -m vilemk.workspace $(if $(filter add remove,$(firstword $(ARGS))),,update) $(ARGS)

# Needs Docker. The west workspace lives in the `vilemk-zmk` volume; the first
# run pulls the build image and all of ZMK and Zephyr.
firmware:
	$(PY) -m vilemk.firmware $(ARGS)

install:
	uv tool install --editable . || pip install -e .

uninstall:
	uv tool uninstall vilemk

build:
	uv build

clean:
	rm -rf build dist *.egg-info vilemk/webui/dist
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

help:
	@sed -n 's/^#   //p' $(MAKEFILE_LIST)
