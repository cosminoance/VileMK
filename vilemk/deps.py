"""Get pyserial without a manual install step.

If it does not import, create `.venv/` in the checkout with the standard `venv`
module, install pyserial there, and run the same command again with that Python.
Paths come from `venv` itself, so this is the same on Linux, macOS and Windows.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import venv

from . import PROJECT_DIR

VENV = os.path.join(PROJECT_DIR, ".venv")
REQUIRES = ["pyserial>=3.5"]


def _python() -> str:
    sub = "Scripts" if os.name == "nt" else "bin"
    exe = "python.exe" if os.name == "nt" else "python"
    return os.path.join(VENV, sub, exe)


def _in_venv() -> bool:
    return os.path.abspath(sys.prefix) == os.path.abspath(VENV)


def _rerun_args() -> list:
    """The command that started us, as `python -m <module> ...` when it was one."""
    spec = getattr(sys.modules.get("__main__"), "__spec__", None)
    if spec and spec.name:
        return ["-m", spec.name.removesuffix(".__main__"), *sys.argv[1:]]
    return sys.argv


def _install_help(err) -> str:
    """What to tell a user whose .venv could not be set up, for their system."""
    lines = [f"could not install pyserial into {VENV}: {err}",
             "VileMK needs it to talk to a keyboard over USB. To fix it:"]
    if shutil.which("apt-get"):
        v = f"{sys.version_info.major}.{sys.version_info.minor}"
        lines.append(f"  1. sudo apt install python3-venv python3-pip  "
                     f"(or python{v}-venv)")
    elif shutil.which("dnf"):
        lines.append("  1. sudo dnf install python3-pip")
    elif shutil.which("pacman"):
        lines.append("  1. sudo pacman -S python-pip")
    else:
        lines.append("  1. check that your Python came with pip and venv "
                     "(the installer from https://www.python.org/ has both)")
    lines += [f"  2. delete the folder {VENV}",
              ("  3. double-click start.bat again" if os.name == "nt"
               else "  3. run 'make design' again"),
              f"or install pyserial for this Python: {sys.executable} -m pip install pyserial"]
    return "\n".join(lines)


def ensure():
    try:
        import serial  # noqa: F401
        return
    except ImportError:
        pass
    if _in_venv():
        sys.exit(f"pyserial is missing from {VENV}; delete that folder and start again")
    py = _python()
    try:
        if not os.path.exists(py):
            print(f"First run: creating {VENV} for pyserial", file=sys.stderr)
            venv.create(VENV, with_pip=True)
        subprocess.run([py, "-m", "pip", "install", "--quiet", *REQUIRES], check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        sys.exit(_install_help(e))
    env = dict(os.environ, PYTHONPATH=PROJECT_DIR + os.pathsep + os.environ.get("PYTHONPATH", ""))
    try:
        sys.exit(subprocess.run([py, *_rerun_args()], env=env).returncode)
    except KeyboardInterrupt:
        sys.exit(130)
