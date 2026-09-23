# Third-party software

VileMK is GPL-3.0. It redistributes none of the software below: ZMK's board
data, keyboard modules, Zephyr and the build image are all downloaded from
their own sources when you fetch or build, and the firmware you build stays on
your machine.

| component | used for | license |
|---|---|---|
| [ZMK](https://github.com/zmkfirmware/zmk) | board data in `.zmk/zmk/`, and the firmware a build compiles | MIT, Copyright (c) 2020 The ZMK Contributors |
| ZMK's `.github/workflows/build-user-config.yml` | the build steps in `vilemk/firmware.py` are derived from it; the notice is in that file | MIT, Copyright (c) 2020 The ZMK Contributors |
| [zmk-docker](https://github.com/zmkfirmware/zmk-docker) | builds the `zmkfirmware/zmk-build-arm` image a build runs in | MIT, Copyright (c) 2020 The ZMK Contributors |
| [Zephyr](https://github.com/zephyrproject-rtos/zephyr) | compiled into the firmware, fetched by the build | Apache-2.0 |
| Zephyr SDK toolchain, inside the build image | the compiler | GPL-3.0 with the GCC Runtime Library Exception |

Keyboard modules you add carry their own licenses; `fetch()` keeps each one's
`LICENSE` or `COPYING` file beside it in `.zmk/modules/<name>/`. Some modules
ship none. That is fine for building your own firmware; do not share a built
`.uf2` for such a keyboard without checking with its author.
