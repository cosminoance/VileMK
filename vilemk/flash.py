"""Copy a built `.uf2` onto a keyboard in its UF2 bootloader.

A board in its bootloader (double-tap reset on a nice!nano) shows up as a small
USB drive with `INFO_UF2.TXT` at its root. Copying a `.uf2` onto it flashes the
board, which then reboots and the drive goes away. This finds such drives among
what the OS has already mounted; it never mounts anything itself.
"""

from __future__ import annotations

import glob
import os
import re
import string
import sys

from . import firmware

INFO = "INFO_UF2.TXT"
LINUX_FS = {"vfat", "msdos", "fat", "exfat"}


class FlashError(Exception):
    pass


def _mounts() -> list:
    if sys.platform == "win32":
        return [f"{c}:\\" for c in string.ascii_uppercase[2:]
                if os.path.exists(f"{c}:\\")]
    if sys.platform == "darwin":
        return glob.glob("/Volumes/*")
    out = []
    try:
        with open("/proc/mounts", encoding="utf-8", errors="replace") as f:
            for line in f:
                cols = line.split()
                if len(cols) >= 3 and cols[2] in LINUX_FS:
                    # /proc/mounts escapes spaces and the like as \040
                    out.append(re.sub(r"\\([0-7]{3})",
                                      lambda m: chr(int(m.group(1), 8)), cols[1]))
    except OSError:
        pass
    return out


def _board(info: str) -> str:
    try:
        with open(info, encoding="utf-8", errors="replace") as f:
            for line in f:
                key, _, value = line.partition(":")
                if key.strip().lower() == "board-id":
                    return value.strip()
    except OSError:
        pass
    return ""


def drives() -> list:
    """-> [{path, board}] for every mounted UF2 bootloader drive."""
    out = []
    for m in _mounts():
        info = os.path.join(m, INFO)
        if os.path.isfile(info):
            out.append({"path": m, "board": _board(info)})
    return out


def flash(name: str, file: str, drive: str) -> None:
    """Copy `variants/<name>/firmware/<file>` onto `drive`.

    `drive` must be one `drives()` reports now, so the page cannot name an
    arbitrary folder. The board may reboot before the copy is closed, which
    surfaces as an I/O error; a drive that is gone by then took the file.
    """
    if file not in firmware.firmware_files(name):
        raise FlashError(f"{name} has no firmware file {file}")
    if not file.endswith(".uf2"):
        raise FlashError(f"{file} is not a .uf2; flash it with the board's own tool")
    if drive not in {d["path"] for d in drives()}:
        raise FlashError("the keyboard's drive is no longer there; put it in its "
                         "bootloader again")
    src = os.path.join(firmware.firmware_dir(name), file)
    with open(src, "rb") as f:
        data = f.read()
    try:
        with open(os.path.join(drive, file), "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
    except OSError as exc:
        if os.path.isfile(os.path.join(drive, INFO)):
            raise FlashError(f"could not copy {file}: {exc}") from None
