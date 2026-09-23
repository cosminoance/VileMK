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
import os
import shlex
import shutil
import subprocess
import sys
import threading
import time

from . import PROJECT_DIR, custom, keymap
from .workspace import WEST_YML

IMAGE = "zmkfirmware/zmk-build-arm:stable"
VOLUME = "vilemk-zmk"
CONTAINER = "vilemk-build"
STAGE_DIR = os.path.join(".zmk", "stage")
CONFIG_AT = "/zmk/config"
FIRMWARE = "firmware"
OUTPUTS = (".uf2", ".bin")
MAX_LINES = 50000


class BuildError(Exception):
    """A build that could not start, with a reason a user can act on."""


class Busy(BuildError):
    pass


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


def targets(name: str) -> list:
    """Every entry of the variant's build.yaml, as the build will run it.

    Any `KEYMAP_FILE` the entry carries is dropped (older variants name a
    `${GITHUB_WORKSPACE}` path) and the variant's own keymap is named instead,
    except on a `settings_reset` entry, which builds its own stub keymap.
    """
    name = custom.variant_slug(name)
    folder = custom.variant_dir(name)
    build = os.path.join(folder, "build.yaml")
    if not os.path.isfile(custom.variant_path(name)):
        raise BuildError(f"there is no variant named {name}")
    if not os.path.isfile(build):
        raise BuildError(f"variants/{name}/ has no build.yaml; save the variant "
                         f"again to write one")
    out, seen = [], set()
    for e in keymap.parse_build_yaml(keymap.read_text(build)):
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
    return out


def firmware_dir(name: str) -> str:
    return os.path.join(custom.variant_dir(name), FIRMWARE)


def firmware_files(name: str) -> list:
    folder = firmware_dir(name)
    if not os.path.isdir(folder):
        return []
    return sorted(f for f in os.listdir(folder) if f.endswith(OUTPUTS))


# ------------------------------------------------------------------- stage

def stage(name: str) -> str:
    """Copy `config/` plus the variant's keymap into `.zmk/stage/<name>/`.

    The copy is what the container sees at /zmk/config, read-only. The
    variant's keymap goes in as `<name>.keymap`, replacing a file of that name
    in the copy only.
    """
    if not os.path.isfile(WEST_YML):
        raise BuildError(f"there is no {WEST_YML}; run `make zmk` first")
    root = os.path.join(STAGE_DIR, name)
    shutil.rmtree(root, ignore_errors=True)
    shutil.copytree("config", os.path.join(root, "config"))
    shutil.copyfile(custom.variant_path(name),
                    os.path.join(root, "config", f"{name}.keymap"))
    os.makedirs(os.path.join(root, "out"), exist_ok=True)
    return os.path.abspath(root)


def script(tgts: list, owner: str = "") -> str:
    """The shell script the container runs. Every value is `shlex.quote`d.

    Each entry builds in a fresh directory, as CI does, and a failed entry does
    not stop the rest (CI's `fail-fast: false`). `owner` is `uid:gid` for the
    finished files, or blank to leave them as the container wrote them.
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


def command(root: str, body: str) -> list:
    """The `docker run` argv. Nothing else from the host is mounted."""
    return ["docker", "run", "--rm", "--name", CONTAINER,
            "--mount", f"type=volume,source={VOLUME},target=/zmk",
            "--mount", f"type=bind,source={os.path.join(root, 'config')},"
                       f"target={CONFIG_AT},readonly",
            "--mount", f"type=bind,source={os.path.join(root, 'out')},target=/out",
            IMAGE, "bash", "-c", body]


def _owner(status: dict) -> str:
    # Where the daemon maps ownership itself, a chown inside would fight it: under
    # rootless Docker 1000 inside is a subordinate id on the host. Windows has no
    # uid at all.
    if status.get("mapped") or not hasattr(os, "getuid"):
        return ""
    return f"{os.getuid()}:{os.getgid()}"


def _publish(name: str, root: str) -> list:
    """Replace `variants/<name>/firmware/`'s outputs with the ones just built."""
    dest = firmware_dir(name)
    os.makedirs(dest, exist_ok=True)
    for f in os.listdir(dest):
        if f.endswith(OUTPUTS):
            os.remove(os.path.join(dest, f))
    out = os.path.join(root, "out")
    for f in sorted(os.listdir(out)):
        shutil.move(os.path.join(out, f), os.path.join(dest, f))
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

    def start(self, name: str, echo=None) -> None:
        """Check, stage and launch in a thread. Raises before anything runs."""
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
        tgts = targets(name)
        root = stage(name)
        with self.lock:
            self.state, self.variant = "running", name
            self.lines, self.dropped, self.files = [], 0, []
            self.started, self.finished = time.time(), 0.0
            self.cancelled = False
        argv = command(root, script(tgts, _owner(status)))
        self.thread = threading.Thread(target=self._run,
                                       args=(name, root, tgts, argv, echo), daemon=True)
        self.thread.start()

    def _run(self, name, root, tgts, argv, echo) -> None:
        def say(line):
            self.log(line)
            if echo:
                echo(line)
        say(f"building {name}: " + ", ".join(t["artifact"] for t in tgts))
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
                files = _publish(name, root)
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
            root = os.path.abspath(os.path.join(STAGE_DIR, name))
            argv = command(root, script(tgts, _owner(docker_status())))
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
