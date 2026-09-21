"""Everything that knows the keymap data ends up on a web page.

`server` serves the page and lets it write back to the `custom/` store. The page
itself is not Python: it is the React app in `web/`, built into `dist/` next to
this file by `make web`.
"""
