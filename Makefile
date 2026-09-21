# Task runner - the `scripts` block of a package.json.
# Every target runs the scripts in place; nothing here needs to be installed
# first. The ZMK config repo is found by the scripts themselves (--repo,
# $ZMK_CONFIG, a config/west.yml above the cwd, or `zmk config user.home`),
# so these work from any directory.
#
#   make            # check every keymap, then build and open the viewer
#   make design     # kill any stale instance, then start the local backend
#                   # (VileDances, combos, modifiers, layers) on
#                   # http://127.0.0.1:7879
#   make web        # build the React app in web/ into vilemk/webui/dist/
#   make webdev     # the Vite dev server, with live reload
#   make kill       # just kill a stale server, without starting a new one
#   make check      # validation only (build.yaml, then every keymap)
#   make ui         # write keymap-ui.html (static, read-only)
#   make view       # write it and open it
#   make pos        # print key-position maps
#   make install    # put vilemk-* on your PATH
#   make clean

PY  ?= python3
NPM ?= npm
OUT ?= keymap-ui.html
# Extra flags, e.g.  make ui ARGS="--all"   /   make check ARGS="config/corne.keymap"
ARGS ?=

.PHONY: all design kill check ui view web webdev pos install uninstall build clean help
.DEFAULT_GOAL := all

all: check view

# The editable UI. Unlike `ui`, this serves the page from a local process so
# it can write back to custom/ and variants/. Kills a stale server first -
# the port is fixed (7879), so a leftover process from an earlier session is
# the only thing that ever occupies it.
design: kill
	$(PY) -m vilemk.webui.server $(ARGS)

# The React app, at /app while the port is in progress. Its output,
# vilemk/webui/dist/, is generated and not in the repo, so this has to run
# once in a fresh clone and again after any change under web/src/. Needs
# Node; `npm ci` installs from the lockfile and is a no-op once node_modules
# is there and matches.
web:
	cd web && $(NPM) ci && $(NPM) run build

# Live reload while working on the app. Serves http://localhost:5173/app/ and
# proxies /api to the Python server, so `make design` has to be running in
# another terminal for the page to have any data.
webdev:
	cd web && $(NPM) run dev

kill:
	pkill -f 'vilemk\.webui\.server' 2>/dev/null && sleep 0.3 || true

# build.yaml first - which halves get built, from which keymap, with which
# parts - then every keymap in config/ and variants/. Read-only, like
# everything here: it prints the line to add, you edit and push.
check:
	$(PY) -m vilemk.check $(ARGS)

ui:
	$(PY) -m vilemk.webui.build -o $(OUT) $(ARGS)

view:
	$(PY) -m vilemk.webui.build -o $(OUT) --open $(ARGS)

pos:
	$(PY) -m vilemk.keypos $(ARGS)

install:
	uv tool install --editable . || pip install -e .

uninstall:
	uv tool uninstall vilemk

build:
	uv build

clean:
	rm -rf build dist *.egg-info $(OUT)
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

help:
	@sed -n 's/^#   //p' $(MAKEFILE_LIST)
