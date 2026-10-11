# Command line and keyboard list details

[← back to the README](README.md)

## The keyboard list

The sidebar has two groups.

**Saved variations** are your keymaps. They are the only ones you can
overwrite and build.

**Vendor defaults** are the keymaps that come with a keyboard. They are for
comparing against (**compare with…**) and for starting a new variation.

Some vendors ship two keymaps for one keyboard, so the keyboard is listed
twice, each marked:

- **board default** is the keymap ZMK falls back to when a build names none.
- **vendor's firmware** is the keymap the vendor's released firmware is built
  from. It can differ from the board default. The Eyelash Sofle's has a fourth
  layer, left empty as a spare. It is listed one step in, under the board
  default.

The **⋮** button beside each row has **Export keymap**, **Export as picture**,
**Flash firmware** (variations only) and **Delete**. Delete on a variation deletes it and its built firmware. On a
vendor default it removes the keyboard from the project, and the keyboard's
module with it. That is refused while variations use the keyboard, and the
dialog names them; delete those first.

### Keyboard modules

**Add a keyboard** also lists your modules. **Update** fetches the latest
commit of the module's branch or tag and checks your variations against it
before replacing anything. If one would break (a key removed from the layout, a
board renamed), the module is left as it was and the dialog lists what would
break, with **Overwrite** to install it anyway. **Remove** is refused while a
variation still uses one of the module's keyboards. **Rename** changes only the
name the app shows.

A module has to be a clean ZMK module: a `zephyr/module.yml` and the keyboard's
files under `boards/`, laid out as ZMK expects, with no custom CI rearranging
them. Many keyboard repositories on GitHub are personal configs that only build
through their owner's workflow. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) says how
to tell them apart, what each build error means, and how to fork a repository
into shape.

From the command line:

```bash
make module ARGS="add <github-url> --ref main"
```

```bash
make module ARGS=<name>
```

## make

```
make          # check every keymap, then build the app and serve it
make design   # build the app, then serve it
make check    # validate every keymap and build list
make pos      # print each keyboard's key-position map
make zmk      # fetch ZMK and pin the commit
make module ARGS=<name>        # fetch or update a keyboard module
make firmware ARGS=<variant>   # build a variant's firmware (needs Docker)
make install  # put the vilemk-* commands on your PATH
```

If the page ever says the app is not built yet, run `make web`.

`make` only looks for a Makefile in the current directory. From anywhere else,
point it at the checkout:

```bash
make -C path/to/VileMK
```

Or run `make install` once and use the `vilemk-*` commands (`vilemk-design`,
`vilemk-check`, `vilemk-build` and the rest) from any directory.

`make check` also compares each variant's build against the vendor's build
list and prints what is missing, such as a part the vendor builds that your
variant leaves out with nothing switching the matching feature off. It never
changes anything. It cannot catch a part the vendor never listed, or a
keyboard with no vendor module at all, and says so when it has nothing to
compare against.
