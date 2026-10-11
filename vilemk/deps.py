"""Get pyserial without a manual install step.

If it does not import, create `.venv/` in the checkout with the standard `venv`
module, install pyserial there, and run the same command again with that Python.
Paths come from `venv` itself, so this is the same on Linux, macOS and Windows.
"""

from __future__ import annotations

import os
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
        sys.exit(f"could not install pyserial into {VENV}: {e}\n"
                 f"install it yourself with: {sys.executable} -m pip install pyserial")
    env = dict(os.environ, PYTHONPATH=PROJECT_DIR + os.pathsep + os.environ.get("PYTHONPATH", ""))
    try:
        sys.exit(subprocess.run([py, *_rerun_args()], env=env).returncode)
    except KeyboardInterrupt:
        sys.exit(130)
