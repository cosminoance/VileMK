"""Everything that knows the keymap data ends up on a web page.

`build` turns the data from `vilemk.keymap` into a single self-contained HTML
file; `server` serves that page live and lets it write back to the `custom/`
store. The markup, CSS and JS themselves are not Python at all - they live in
`template.html` next to this file.
"""
