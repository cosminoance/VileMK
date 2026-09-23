#!/usr/bin/env python3
"""Bump the patch number in version/version.json, and mirror it into pyproject.

version/version.json is the single source of truth. pyproject.toml's `version`
is a copy this script keeps in step, so a wheel carries the same number as the
tag.

    python3 version_increase.py --current   # print the version, do not touch it
    python3 version_increase.py             # x.y.z -> x.y.(z+1)

The version in the file is the one the *next* merge to main is tagged as: CI
tags it, then runs this. So a pull request's changelog entry goes in
changelog/<the version currently in version.json>.md.

A minor or major bump is a hand edit of version/version.json in a pull request;
CI always tags what it finds and then adds one to the patch.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION_FILE = ROOT / "version" / "version.json"
PYPROJECT = ROOT / "pyproject.toml"


def read() -> str:
    version = json.loads(VERSION_FILE.read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"{VERSION_FILE}: {version!r} is not x.y.z")
    return version


def bump(version: str) -> str:
    major, minor, patch = version.split(".")
    return f"{major}.{minor}.{int(patch) + 1}"


def write(version: str) -> None:
    VERSION_FILE.write_text(json.dumps({"version": version}, indent=2) + "\n")
    text = PYPROJECT.read_text()
    new, count = re.subn(r'(?m)^version = ".*"$', f'version = "{version}"', text, count=1)
    if count != 1:
        sys.exit(f"{PYPROJECT}: no `version = \"...\"` line to update")
    PYPROJECT.write_text(new)


def main() -> None:
    if "--current" in sys.argv[1:]:
        print(read())
        return
    version = bump(read())
    write(version)
    print(version)


if __name__ == "__main__":
    main()
