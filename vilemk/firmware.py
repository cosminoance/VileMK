"""Build a variant's firmware in ZMK's build container.

    python3 -m vilemk.firmware <variant>             # build it
    python3 -m vilemk.firmware <variant> --dry-run   # print what would run

A build is a variant: every entry in `variants/<name>/build.yaml`, compiled
against `config/` with the variant's keymap, into `variants/<name>/firmware/`.
It runs `zmkfirmware/zmk-build-arm:stable` with Docker. The west workspace (ZMK,
Zephyr, the HALs, a GB or more) lives in the named volume `vilemk-zmk`, never in
the checkout; only the finished `.uf2` files cross into it.

The steps are derived from ZMK's `.github/workflows/build-user-config.yml` at
v0.3, which carries this notice:

    MIT License. Copyright (c) 2020 The ZMK Contributors.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import shlex
import shutil
import subprocess
import sys
import threading
import time

from . import PROJECT_DIR, custom, keymap, keypos, workspace
from .workspace import WEST_YML

IMAGE = "zmkfirmware/zmk-build-arm:stable"
VOLUME = "vilemk-zmk"
CONTAINER = "vilemk-build"
STAGE_DIR = os.path.join(".zmk", "stage")
CONFIG_AT = "/zmk/config"
PREPARED_AT = "/zmk/prepared"
FIRMWARE = "firmware"
OUTPUTS = (".uf2", ".bin")
MAX_LINES = 50000


class BuildError(Exception):
    """A build that could not start, with a reason a user can act on."""


class Busy(BuildError):
    pass


class NotInstalled(BuildError):
    """The build names boards or shields that nothing in `.zmk/` provides."""

    def __init__(self, missing: list):
        super().__init__(f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} "
                         f"not installed; add the keyboard, or the module it comes "
                         f"from, in Add a keyboard")
        self.missing = missing


class FolderNeeded(BuildError):
    """A module defines the build's shields in more than one folder, and the
    variant has not picked one."""

    def __init__(self, module: str, folders: list):
        super().__init__(f"{module} defines this keyboard in more than one folder "
                         f"({', '.join(folders)}); pick the one to build in the "
                         f"Build panel")
        self.module = module
        self.folders = folders


# ------------------------------------------------------------------ docker

def docker_status() -> dict:
    """-> {ok, reason, mapped}. `reason` says what to fix when `ok` is false.

    `mapped` is true when the daemon already gives bind-mounted files to the
    host user: rootless Docker, and Docker Desktop (every Mac and Windows
    install), whose file sharing does the mapping.
    """
    if not shutil.which("docker"):
        return {"ok": False, "reason": "Docker is not installed", "mapped": False}
    try:
        r = subprocess.run(["docker", "info", "--format",
                            "{{json .SecurityOptions}} {{.OperatingSystem}}"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "reason": f"`docker info` failed: {exc}", "mapped": False}
    if r.returncode == 0:
        return {"ok": True, "reason": "",
                "mapped": "rootless" in r.stdout or "Docker Desktop" in r.stdout}
    err = (r.stderr or r.stdout).strip()
    low = err.lower()
    if "permission denied" in low:
        reason = ("your user cannot reach the Docker daemon; add it to the `docker` "
                  "group and log in again")
    elif "cannot connect" in low or "is the docker daemon running" in low:
        reason = "the Docker daemon is not running"
    else:
        reason = err.splitlines()[-1] if err else f"`docker info` exited {r.returncode}"
    return {"ok": False, "reason": reason, "mapped": False}


def _container_running() -> bool:
    try:
        r = subprocess.run(["docker", "ps", "-q", "--filter", f"name=^{CONTAINER}$"],
                           capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return bool(r.stdout.strip())


def kill() -> None:
    subprocess.run(["docker", "kill", CONTAINER], capture_output=True, timeout=30)


# ----------------------------------------------------------------- targets

def artifact_name(board: str, shield: str, name: str = "") -> str:
    """CI's rule: `${artifact-name:-${shield:+$shield-}${board}-zmk}`."""
    return name or f"{shield + '-' if shield else ''}{board}-zmk"


def build_yaml(name: str, zmk_dir: str, reset: bool, parts=None, folder=None,
               entries=None, confs=None) -> str:
    """The build.yaml the variant gets with these choices, from its saved keymap.

    The page's "include reset", parts, folder, entries and conf boxes apply to
    the next build without a save; `JOB.start(yaml_text=)` writes this before
    it builds.
    """
    path = custom.variant_path(name)
    try:
        text = keymap.read_text(path)
    except OSError:
        raise BuildError(f"there is no variant named {name}") from None
    m = keypos.KEYBOARD_HINT_RE.search(text)
    if not m:
        raise BuildError(f"variants/{name}/ does not say which keyboard it is for; "
                         f"save the variant again")
    try:
        out, _warnings = custom.build_yaml_for(
            m.group(1), os.path.basename(path), zmk_dir, keymap_text=text,
            reset=reset, parts=parts,
            build_path=os.path.join(custom.variant_dir(name), "build.yaml"),
            folder=folder, entries=entries, confs=confs)
    except (custom.EmitError, ValueError) as exc:
        raise BuildError(str(exc)) from None
    return out


def targets(name: str, yaml_text: str | None = None,
            zmk_dir: str = workspace.ZMK_DIR) -> list:
    """Every entry of the variant's build.yaml (or `yaml_text`), as the build
    will run it. Raises `NotInstalled` for a board or shield `.zmk/` lacks.

    Any `KEYMAP_FILE` the entry carries is dropped (older variants name a
    `${GITHUB_WORKSPACE}` path) and the variant's own keymap is named instead,
    except on a `settings_reset` entry, which builds its own stub keymap.
    """
    name = custom.variant_slug(name)
    folder = custom.variant_dir(name)
    build = os.path.join(folder, "build.yaml")
    if not os.path.isfile(custom.variant_path(name)):
        raise BuildError(f"there is no variant named {name}")
    if yaml_text is None and not os.path.isfile(build):
        raise BuildError(f"variants/{name}/ has no build.yaml; save the variant "
                         f"again to write one")
    out, seen = [], set()
    text = keymap.read_text(build) if yaml_text is None else yaml_text
    for e in keymap.parse_build_yaml(text):
        if not e.board:
            raise BuildError(f"an entry in variants/{name}/build.yaml has no board")
        shield = e.get("shield") or ""
        args = keymap.KEYMAP_FILE_RE.sub("", e.get("cmake-args") or "")
        try:
            cmake = shlex.split(args)
        except ValueError as exc:
            raise BuildError(f"cmake-args for {e.board}: {exc}") from None
        utility = any(s in keymap.UTILITY_SHIELDS for s in e.shields)
        if not utility:
            cmake.append(f"-DKEYMAP_FILE={CONFIG_AT}/{name}.keymap")
        art = artifact_name(e.board, shield, e.get("artifact-name") or "")
        if art in seen:
            raise BuildError(f"two entries would both write {art}; give one an "
                             f"`artifact-name:`")
        seen.add(art)
        out.append({"board": e.board, "shield": shield,
                    "snippet": e.get("snippet") or "", "cmake": cmake,
                    "artifact": art,
                    "display": f"{shield + ' - ' if shield else ''}{e.board}"})
    if not out:
        raise BuildError(f"variants/{name}/build.yaml has no entries")
    have = workspace.installed_names(zmk_dir)
    missing = sorted({n for t in out for n in [t["board"], *t["shield"].split()]
                      if n not in have})
    if missing:
        raise NotInstalled(missing)
    _check_folders(out, text, zmk_dir)
    return out


def _module_of(path: str, zmk_dir: str) -> str:
    rel = os.path.relpath(path, os.path.join(zmk_dir, "modules"))
    return "" if rel.startswith("..") else rel.split(os.sep)[0]


def _check_folders(tgts: list, text: str, zmk_dir: str) -> None:
    """A shield in two folders of one module needs the variant's folder pick,
    and every shield of that module must be in the picked folder. A shield in
    two modules cannot build at all."""
    dirs = workspace.shield_dirs(zmk_dir)
    picked = custom.build_choices(text)["folders"]
    twice = {}
    for s in sorted({s for t in tgts for s in t["shield"].split()}):
        where = dirs.get(s, [])
        owners = {_module_of(d, zmk_dir) for d in where}
        if len(owners) > 1 or ("" in owners and len(where) > 1):
            twice[s] = where
            continue
        m = next(iter(owners), "")
        folders = sorted({os.path.basename(d) for d in where})
        if len(where) > 1 and not picked.get(m):
            raise FolderNeeded(m, sorted(workspace.module_shape(zmk_dir, m)["folders"]))
        if picked.get(m) and folders and picked[m] not in folders:
            raise BuildError(f"{s} is not in {m}'s {picked[m]} folder; untick its "
                             f"entry in the Build panel or pick another folder")
    if twice:
        raise BuildError(_twice(twice, zmk_dir))


def _twice(dirs: dict, zmk_dir: str) -> str:
    """Why a build with shields Zephyr would find in two modules cannot run."""
    lines = [f"{shield} is in " + " and ".join(os.path.relpath(d, zmk_dir) for d in where)
             for shield, where in dirs.items()]
    return ("Zephyr would find a shield twice: " + "; ".join(lines)
            + ". Remove all but one of those modules in Add a keyboard.")


def firmware_dir(name: str) -> str:
    return os.path.join(custom.variant_dir(name), FIRMWARE)


def firmware_files(name: str) -> list:
    folder = firmware_dir(name)
    if not os.path.isdir(folder):
        return []
    return sorted(f for f in os.listdir(folder) if f.endswith(OUTPUTS))


def _source_ns(name: str) -> int:
    """When the variant's keymap or build.yaml last changed, in ns."""
    out = 0
    for p in (custom.variant_path(name),
              os.path.join(custom.variant_dir(name), "build.yaml")):
        try:
            out = max(out, os.stat(p).st_mtime_ns)
        except OSError:
            pass
    return out


def firmware_state(name: str) -> dict:
    """-> {uf2, fresh}: how many .uf2 files there are, and whether they were
    built from the keymap and build.yaml as they are now.

    `_publish()` stamps each output with the source's mtime from when the build
    was staged, so a save during or after the build makes it stale.
    """
    folder = firmware_dir(name)
    uf2 = [f for f in firmware_files(name) if f.endswith(".uf2")]
    if not uf2:
        return {"uf2": 0, "fresh": False}
    built = min(os.stat(os.path.join(folder, f)).st_mtime_ns for f in uf2)
    return {"uf2": len(uf2), "fresh": built >= _source_ns(name)}


def open_folder(name: str) -> None:
    """Show the variant's firmware folder in the system's file manager."""
    folder = os.path.abspath(firmware_dir(name))
    if not os.path.isdir(folder):
        raise BuildError(f"{name} has not been built yet")
    if sys.platform == "win32":
        os.startfile(folder)
        return
    cmd = ["open" if sys.platform == "darwin" else "xdg-open", folder]
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        raise BuildError(f"no {cmd[0]} on this machine; the folder is {folder}") from None


# ------------------------------------------------------------------- stage

def prepared(tgts: list, text: str, zmk_dir: str = workspace.ZMK_DIR,
             rewrites: bool = True) -> list:
    """The modules this build uses that cannot go through west as they are
    (`workspace.module_shape()`), each with what `stage()` does to its copy:
    `drop` the folders other than the picked one, copy `includes`
    ({folder: [file]}) in from its `config/`, write a `zephyr/module.yml` with
    `module_yml` as board_root when it is set, append `confs`
    ({"<folder>/<shield>.conf": [file]}) from its `config/`, and apply
    `rewrites` ([(old, new)]) to the staged keymap: the edits the module's CI
    makes to its keymap for the folder built (`workspace.keymap_rewrites()`).
    A keymap started from the vendor's needs them as much as the vendor's does.
    `rewrites=False` is the user's "build without" in the page's confirm: they
    go in `skipped` instead.
    """
    mods = os.path.join(zmk_dir, "modules")
    if not os.path.isdir(mods):
        return []
    names = {n for t in tgts for n in [t["board"], *t["shield"].split()]}
    choices = custom.build_choices(text)
    entries = [e for e in keymap.parse_build_yaml(text)
               if custom.RESET_SHIELD not in e.shields]
    out = []
    for m in sorted(os.listdir(mods)):
        if m.startswith("."):
            continue
        shape = workspace.module_shape(zmk_dir, m)
        if not shape["prepare"] or not names & {s for fs in shape["folders"].values()
                                                for s in fs}:
            continue
        folder = choices["folders"].get(m, "") if shape["twice"] else ""
        keep = [folder] if folder else list(shape["folders"])
        confs = {}
        for c in custom.confs_offer(m, zmk_dir, entries, folder, text):
            if not c["on"]:
                continue
            for s in c["shields"]:
                where = next(f for f in keep if s in shape["folders"][f])
                confs.setdefault(f"{where}/{s}.conf", []).append(c["file"])
        out.append({"module": m, "board_root": shape["board_root"], "folder": folder,
                    "drop": [f for f in shape["folders"] if f not in keep],
                    "includes": {f: shape["missing_includes"][f] for f in keep
                                 if f in shape["missing_includes"]},
                    "module_yml": "" if shape["module_yml"] else shape["board_root"],
                    "confs": confs,
                    **{"rewrites" if rewrites else "skipped":
                       [(r["old"], r["new"]) for r in shape["rewrites"]
                        if _branch_applies(r["when"], keep)]}})
    return out


def _branch_applies(when: list, folders: list) -> bool:
    """A CI `case` branch outside any case, or one whose glob picks a folder
    built. A glob that names no folder of the module is about something else."""
    return not when or any(fnmatch.fnmatch(f, g) for g in when for f in folders)


def ci_rewrites(name: str, text: str | None = None,
                zmk_dir: str = workspace.ZMK_DIR) -> list:
    """[{module, old, new, file}]: the keymap edits a build of `name` with this
    build.yaml text would make, for the page to confirm before it builds. Only
    those whose text the variant's keymap has."""
    if text is None:
        text = keymap.read_text(os.path.join(custom.variant_dir(name), "build.yaml"))
    km = keymap.read_text(custom.variant_path(name))
    out = []
    for p in prepared(targets(name, text, zmk_dir), text, zmk_dir):
        shape = workspace.module_shape(zmk_dir, p["module"])
        for old, new in p["rewrites"]:
            if old not in km:
                continue
            r = next(r for r in shape["rewrites"] if (r["old"], r["new"]) == (old, new))
            out.append({"module": p["module"], "old": old, "new": new, "file": r["file"]})
    return out


def missing_drivers(name: str, text: str | None = None,
                    zmk_dir: str = workspace.ZMK_DIR) -> list:
    """[{module, name, url, revision, ...}]: what the prepared modules this
    build uses pull in their own `config/west.yml` and ours lacks
    (`workspace.drivers()`, without the API calls). Their CI builds with those;
    ours fails on an unknown Kconfig symbol or `compatible` without them.
    Only prepared modules: eyelash's config lists drivers it does not need."""
    if text is None:
        text = keymap.read_text(os.path.join(custom.variant_dir(name), "build.yaml"))
    return [{"module": p["module"], **d}
            for p in prepared(targets(name, text, zmk_dir), text, zmk_dir)
            for d in workspace.drivers(p["module"], zmk_dir, refs=False)]


def drivers_notes(prep=(), zmk_dir: str = workspace.ZMK_DIR) -> list:
    """One line per driver a prepared module's own build fetches and ours lacks."""
    return [f"warning: {p['module']}'s own build also fetches {d['name']} ({d['url']}), "
            f"which config/west.yml does not have"
            for p in prep for d in workspace.drivers(p["module"], zmk_dir, refs=False)]


def describe(prep: dict) -> str:
    """One line on what `stage()` does to a prepared module."""
    parts = []
    if prep["folder"]:
        parts.append(f"keeps {prep['folder']}, drops {', '.join(prep['drop'])}")
    for f, files in prep["includes"].items():
        parts.append(f"copies {', '.join(files)} from config/ into {f}/")
    if prep["module_yml"]:
        parts.append(f"writes zephyr/module.yml (board_root: {prep['module_yml']})")
    for dst, files in prep["confs"].items():
        parts.append(f"appends config/{', config/'.join(files)} to {dst}")
    for old, new in prep.get("rewrites", ()):
        parts.append(f"changes `{old}` to `{new}` in the keymap, as its CI does")
    for old, new in prep.get("skipped", ()):
        parts.append(f"leaves `{old}` in the keymap (its CI changes it to `{new}`)")
    return f"prepared {prep['module']}: " + ("; ".join(parts) or "copied as is")


def keymap_includes(name: str, prep=(), zmk_dir: str = workspace.ZMK_DIR) -> dict:
    """{file: module}: what the variant's keymap `#include "..."`s that is not
    in `config/` but is in a module's `config/`, with what those include in
    turn. A keymap started from a vendor's keeps the vendor's includes, which
    its CI finds next to the keymap. Prepared modules are searched first.
    """
    mods = os.path.join(zmk_dir, "modules")
    order = [p["module"] for p in prep]
    if os.path.isdir(mods):
        order += [m for m in sorted(os.listdir(mods))
                  if not m.startswith(".") and m not in order]
    dirs = [(m, os.path.join(mods, m, "config")) for m in order]
    out = {}
    todo = [custom.variant_path(name)]
    while todo:
        try:
            text = keymap.read_text(todo.pop(0))
        except OSError:
            continue
        for inc in workspace.INCLUDE_RE.findall(text):
            if "/" in inc or inc in out or os.path.isfile(os.path.join("config", inc)):
                continue
            for m, d in dirs:
                src = os.path.join(d, inc)
                if os.path.isfile(src):
                    out[inc] = m
                    todo.append(src)
                    break
    return out


def includes_notes(name: str, prep=()) -> list:
    """One line per module `stage()` copies keymap includes from."""
    by = {}
    for fn, m in keymap_includes(name, prep).items():
        by.setdefault(m, []).append(fn)
    return [f"copies {', '.join(fs)} from {m}/config/ next to the keymap"
            for m, fs in by.items()]


def stage(name: str, prep=(), zmk_dir: str = workspace.ZMK_DIR) -> str:
    """Copy `config/` plus the variant's keymap into `.zmk/stage/<name>/`.

    The copy is what the container sees at /zmk/config, read-only. The
    variant's keymap goes in as `<name>.keymap`, replacing a file of that name
    in the copy only, with what it includes from a module's `config/`
    (`keymap_includes()`) and the `rewrites` of each module in `prep`.

    Each module in `prep` (`prepared()`) is copied to `modules/<module>/`,
    fixed up there, and dropped from the staged west.yml, so west does not
    also hand Zephyr the original. `.zmk/modules/` is not touched.
    """
    if not os.path.isfile(WEST_YML):
        raise BuildError(f"there is no {WEST_YML}; run `make zmk` first")
    root = os.path.join(STAGE_DIR, name)
    shutil.rmtree(root, ignore_errors=True)
    shutil.copytree("config", os.path.join(root, "config"))
    staged_keymap = os.path.join(root, "config", f"{name}.keymap")
    shutil.copyfile(custom.variant_path(name), staged_keymap)
    rewrites = [r for p in prep for r in p.get("rewrites", ())]
    if rewrites:
        text = keymap.read_text(staged_keymap)
        for old, new in rewrites:
            text = text.replace(old, new)
        with open(staged_keymap, "w", encoding="utf-8") as fh:
            fh.write(text)
    for fn, m in keymap_includes(name, prep, zmk_dir).items():
        shutil.copyfile(os.path.join(zmk_dir, "modules", m, "config", fn),
                        os.path.join(root, "config", fn))
    os.makedirs(os.path.join(root, "out"), exist_ok=True)
    for p in prep:
        src = os.path.join(zmk_dir, "modules", p["module"])
        dst = os.path.join(root, "modules", p["module"])
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".git"))
        shields = os.path.join(dst, p["board_root"], "boards", "shields")
        for f in p["drop"]:
            shutil.rmtree(os.path.join(shields, f))
        for f, files in p["includes"].items():
            for fn in files:
                shutil.copyfile(os.path.join(dst, "config", fn),
                                os.path.join(shields, f, fn))
        if p["module_yml"]:
            os.makedirs(os.path.join(dst, "zephyr"), exist_ok=True)
            with open(os.path.join(dst, "zephyr", "module.yml"), "w",
                      encoding="utf-8") as fh:
                fh.write(f"build:\n  settings:\n    board_root: {p['module_yml']}\n")
        for rel, files in p["confs"].items():
            with open(os.path.join(shields, *rel.split("/")), "a", encoding="utf-8") as fh:
                for fn in files:
                    body = keymap.read_text(os.path.join(dst, "config", fn))
                    fh.write(f"\n# config/{fn}, added by VileMK\n{body.rstrip()}\n")
    if prep:
        staged = os.path.join(root, WEST_YML)
        data = workspace.west_yml_read(staged)
        gone = {p["module"] for p in prep}
        data["manifest"]["projects"] = [
            p for p in data["manifest"]["projects"]
            if not (isinstance(p, dict) and p.get("name") in gone)]
        workspace.west_yml_write(data, staged)
    return os.path.abspath(root)


def script(tgts: list, owner: str = "", extra=()) -> str:
    """The shell script the container runs. Every value is `shlex.quote`d.

    Each entry builds in a fresh directory, as CI does, and a failed entry does
    not stop the rest (CI's `fail-fast: false`). `owner` is `uid:gid` for the
    finished files, or blank to leave them as the container wrote them.
    `extra` names prepared modules, passed to every build as ZMK_EXTRA_MODULES.
    """
    q = shlex.quote
    lines = [
        "set -u",
        "cd /zmk",
        "failed=0",
        f"[ -d .west ] || {{ echo '==> west init'; west init -l {q(CONFIG_AT)} || exit 1; }}",
        "echo '==> west update'",
        "west update --fetch-opt=--filter=tree:0 || exit 1",
        "west zephyr-export || exit 1",
    ]
    for i, t in enumerate(tgts, 1):
        cmd = ["west", "build", "-s", "zmk/app", "-d", "$d", "-b", t["board"]]
        if t["snippet"]:
            cmd += ["-S", t["snippet"]]
        cmd += ["--", f"-DZMK_CONFIG={CONFIG_AT}"]
        if t["shield"]:
            cmd.append(f"-DSHIELD={t['shield']}")
        if extra:
            cmd.append("-DZMK_EXTRA_MODULES="
                       + ";".join(f"{PREPARED_AT}/{m}" for m in extra))
        cmd += t["cmake"]
        west = " ".join('"$d"' if c == "$d" else q(c) for c in cmd)
        art = q(t["artifact"])

        def own(ext):
            # per file, right after the copy: a build killed later leaves
            # nothing root-owned behind
            return f" && chown {q(owner)} /out/{art}.{ext}" if owner else ""
        head = f"==> [{i}/{len(tgts)}] {t['display']}"
        lines += [
            f"echo {q(head)}",
            "d=$(mktemp -d)",
            f"echo + {q(' '.join(cmd))}",
            f"if {west}; then",
            f'  if [ -f "$d/zephyr/zmk.uf2" ]; then cp "$d/zephyr/zmk.uf2" /out/{art}.uf2{own("uf2")}',
            f'  elif [ -f "$d/zephyr/zmk.bin" ]; then cp "$d/zephyr/zmk.bin" /out/{art}.bin{own("bin")}',
            f"  else echo {q('no zmk.uf2 or zmk.bin for ' + t['artifact'])}; failed=1; fi",
            f"else echo {q('build failed: ' + t['artifact'])}; failed=1; fi",
            'rm -rf "$d"',
        ]
    lines.append("exit $failed")
    return "\n".join(lines) + "\n"


def command(root: str, body: str, prepared: bool = False) -> list:
    """The `docker run` argv. Nothing else from the host is mounted; the
    prepared modules, when there are any, go in read-only."""
    mods = (["--mount", f"type=bind,source={os.path.join(root, 'modules')},"
                        f"target={PREPARED_AT},readonly"] if prepared else [])
    return ["docker", "run", "--rm", "--name", CONTAINER,
            "--mount", f"type=volume,source={VOLUME},target=/zmk",
            "--mount", f"type=bind,source={os.path.join(root, 'config')},"
                       f"target={CONFIG_AT},readonly",
            *mods,
            "--mount", f"type=bind,source={os.path.join(root, 'out')},target=/out",
            IMAGE, "bash", "-c", body]


def _owner(status: dict) -> str:
    # Where the daemon maps ownership itself, a chown inside would fight it: under
    # rootless Docker 1000 inside is a subordinate id on the host. Windows has no
    # uid at all.
    if status.get("mapped") or not hasattr(os, "getuid"):
        return ""
    return f"{os.getuid()}:{os.getgid()}"


def _publish(name: str, root: str, source_ns: int) -> list:
    """Replace `variants/<name>/firmware/`'s outputs with the ones just built,
    each stamped with `source_ns` (see `firmware_state()`)."""
    dest = firmware_dir(name)
    os.makedirs(dest, exist_ok=True)
    for f in os.listdir(dest):
        if f.endswith(OUTPUTS):
            os.remove(os.path.join(dest, f))
    out = os.path.join(root, "out")
    for f in sorted(os.listdir(out)):
        shutil.move(os.path.join(out, f), os.path.join(dest, f))
        os.utime(os.path.join(dest, f), ns=(source_ns, source_ns))
    return firmware_files(name)


# --------------------------------------------------------------------- job

class Job:
    """The one build this process runs at a time, and its log.

    `state` is idle, running, ok, failed or cancelled. `lines` only grows while
    a job runs, so a reader can ask for everything after line N.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"
        self.variant = ""
        self.lines: list = []
        self.dropped = 0
        self.files: list = []
        self.started = self.finished = 0.0
        self.cancelled = False
        self.proc = None
        self.thread = None

    def log(self, line: str) -> None:
        with self.lock:
            self.lines.append(line)
            if len(self.lines) > MAX_LINES:
                cut = len(self.lines) - MAX_LINES
                del self.lines[:cut]
                self.dropped += cut

    def since(self, n: int) -> dict:
        with self.lock:
            start = max(n - self.dropped, 0)
            return {"state": self.state, "variant": self.variant,
                    "lines": self.lines[start:],
                    "next": self.dropped + len(self.lines),
                    "files": list(self.files),
                    "started": self.started, "finished": self.finished}

    def start(self, name: str, echo=None, yaml_text: str | None = None,
              rewrites: bool = True) -> None:
        """Check, stage and launch in a thread. Raises before anything runs.

        `yaml_text` replaces the variant's build.yaml first (`build_yaml()`).
        `rewrites` is whether the modules' CI keymap edits apply (`prepared()`).
        """
        name = custom.variant_slug(name)
        with self.lock:
            if self.state == "running":
                raise Busy(f"a build of {self.variant} is running")
        status = docker_status()
        if not status["ok"]:
            raise BuildError(status["reason"])
        if _container_running():
            raise Busy(f"a {CONTAINER} container is already running, probably "
                       f"from another VileMK; stop it with `docker kill {CONTAINER}`")
        tgts = targets(name, yaml_text)
        build = os.path.join(custom.variant_dir(name), "build.yaml")
        if yaml_text is not None:
            with open(build, "w", encoding="utf-8") as fh:
                fh.write(yaml_text)
        prep = prepared(tgts, keymap.read_text(build), rewrites=rewrites)
        source_ns = _source_ns(name)
        root = stage(name, prep)
        with self.lock:
            self.state, self.variant = "running", name
            self.lines, self.dropped, self.files = [], 0, []
            self.started, self.finished = time.time(), 0.0
            self.cancelled = False
        argv = command(root, script(tgts, _owner(status), [p["module"] for p in prep]),
                       bool(prep))
        self.thread = threading.Thread(target=self._run,
                                       args=(name, root, tgts, argv, echo, source_ns,
                                             [describe(p) for p in prep]
                                             + includes_notes(name, prep)
                                             + drivers_notes(prep)),
                                       daemon=True)
        self.thread.start()

    def _run(self, name, root, tgts, argv, echo, source_ns, notes=()) -> None:
        def say(line):
            self.log(line)
            if echo:
                echo(line)
        say(f"building {name}: " + ", ".join(t["artifact"] for t in tgts))
        for note in notes:
            say(note)
        say(f"workspace: docker volume {VOLUME}; the first build pulls {IMAGE} and "
            f"all of ZMK and Zephyr, which takes several minutes")
        code = -1
        try:
            self.proc = subprocess.Popen(argv, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                         errors="replace", bufsize=1)
            for line in self.proc.stdout:
                say(line.rstrip("\n"))
            code = self.proc.wait()
        except OSError as exc:
            say(f"could not run docker: {exc}")
        files = []
        if code == 0 and not self.cancelled:
            try:
                files = _publish(name, root, source_ns)
                say(f"wrote {len(files)} file(s) to variants/{name}/{FIRMWARE}/")
            except OSError as exc:
                say(f"copying the firmware out failed: {exc}")
                code = -1
        elif self.cancelled:
            say(f"cancelled; variants/{name}/{FIRMWARE}/ is unchanged")
        else:
            say(f"build failed (exit {code}); variants/{name}/{FIRMWARE}/ is unchanged")
        with self.lock:
            self.state = ("cancelled" if self.cancelled
                          else "ok" if code == 0 else "failed")
            self.files = files
            self.finished = time.time()
            self.proc = None

    def cancel(self) -> bool:
        with self.lock:
            if self.state != "running":
                return False
            self.cancelled = True
        self.log("cancelling")
        kill()
        return True

    def wait(self) -> str:
        if self.thread:
            self.thread.join()
        return self.state


JOB = Job()


# ----------------------------------------------------------------- command

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("variant", help="a folder name under variants/")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the docker command and the script, run nothing")
    args = ap.parse_args()
    os.chdir(PROJECT_DIR)

    try:
        if args.dry_run:
            name = custom.variant_slug(args.variant)
            tgts = targets(name)
            prep = prepared(tgts, keymap.read_text(
                os.path.join(custom.variant_dir(name), "build.yaml")))
            root = os.path.abspath(os.path.join(STAGE_DIR, name))
            argv = command(root, script(tgts, _owner(docker_status()),
                                        [p["module"] for p in prep]), bool(prep))
            for note in ([describe(p) for p in prep] + includes_notes(name, prep)
                         + drivers_notes(prep)):
                print(f"# {note}")
            print(" ".join(shlex.quote(a) for a in argv[:-1]) + " <<script>>")
            print(argv[-1], end="")
            return 0
        JOB.start(args.variant, echo=lambda line: print(line, flush=True))
    except (BuildError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    try:
        state = JOB.wait()
    except KeyboardInterrupt:
        JOB.cancel()
        state = JOB.wait()
    for f in JOB.files:
        print(f"  {os.path.join(firmware_dir(args.variant), f)}")
    return 0 if state == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
