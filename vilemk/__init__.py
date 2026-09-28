"""VileMK - design, check and build ZMK keymaps.

Two layers, and the import direction only ever points down:

    vilemk.webui     the page: `server`, and the built app in `dist/`
    vilemk.*         the manipulators - keypos, keymap, check, custom

The manipulators are pure Python over devicetree text: they take a path or a
string and give back dicts, lists and devicetree. None of them import `webui`,
and none of them contain markup.

Each module that has a command carries its own `main()` at the bottom, under a
`# command` banner - `keypos`, `check`, `webui.server`.
"""

import os

__version__ = "0.1.0"

# The VileMK checkout - one level above this package. `config/`, `.zmk/`,
# `custom/` and `variants/` live here, beside the source rather than inside it. Anything that needs to
# reach them takes it from here; deriving it per-module is how it drifts.
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
