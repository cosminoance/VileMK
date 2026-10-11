"""Talk to a keyboard over ZMK Studio's USB serial channel.

The keyboard must run a build with `snippet: studio-rpc-usb-uart` and
`CONFIG_ZMK_STUDIO=y`. Reads work locked; writes need a `&studio_unlock` key
pressed first. Changes stay pending on the keyboard until `save`.

    python3 -m vilemk.studio ports
    python3 -m vilemk.studio keymap
    python3 -m vilemk.studio set LAYER POSITION BEHAVIOR [PARAM1 [PARAM2]]
    python3 -m vilemk.studio save
"""

from __future__ import annotations

import argparse
import sys
import threading
import time

from . import deps

deps.ensure()

import serial  # noqa: E402
from serial.tools import list_ports  # noqa: E402

SOF, ESC, EOF = 0xAB, 0xAC, 0xAD
TIMEOUT = 2.0


class StudioError(Exception):
    pass


class Gone(StudioError):
    """The port failed under us, usually the keyboard was unplugged."""


# Framing: SOF, payload with SOF/ESC/EOF bytes prefixed by ESC, EOF.

def frame(payload: bytes) -> bytes:
    out = bytearray([SOF])
    for b in payload:
        if b in (SOF, ESC, EOF):
            out.append(ESC)
        out.append(b)
    out.append(EOF)
    return bytes(out)


class Deframer:
    def __init__(self):
        self.buf: bytearray | None = None
        self.esc = False

    def feed(self, data: bytes) -> list:
        """Returns the payloads completed by `data`."""
        done = []
        for b in data:
            if self.buf is None:
                if b == SOF:
                    self.buf = bytearray()
            elif self.esc:
                self.buf.append(b)
                self.esc = False
            elif b == ESC:
                self.esc = True
            elif b == EOF:
                done.append(bytes(self.buf))
                self.buf = None
            elif b == SOF:
                self.buf = bytearray()
            else:
                self.buf.append(b)
        return done


# Protobuf, only what the Studio messages use: varints, sint32 and nested messages.

def _varint(n: int) -> bytes:
    n &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _zigzag(n: int) -> int:
    return (n << 1) ^ (n >> 31)


def _unzigzag(n: int) -> int:
    return (n >> 1) ^ -(n & 1)


def vint(field: int, n: int) -> bytes:
    return _varint(field << 3) + _varint(n)


def sint(field: int, n: int) -> bytes:
    return vint(field, _zigzag(n))


def msg(field: int, body: bytes) -> bytes:
    return _varint(field << 3 | 2) + _varint(len(body)) + body


def decode(data: bytes) -> dict:
    """{field: [value, ...]}; length-delimited fields stay bytes."""
    out: dict = {}
    i = 0
    while i < len(data):
        key, i = _read_varint(data, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            v, i = _read_varint(data, i)
        elif wire == 2:
            n, i = _read_varint(data, i)
            v, i = data[i:i + n], i + n
        elif wire == 5:
            v, i = int.from_bytes(data[i:i + 4], "little"), i + 4
        elif wire == 1:
            v, i = int.from_bytes(data[i:i + 8], "little"), i + 8
        else:
            raise StudioError(f"unsupported wire type {wire}")
        out.setdefault(field, []).append(v)
    return out


def _read_varint(data: bytes, i: int):
    n = shift = 0
    while True:
        if i >= len(data):
            raise StudioError("truncated message")
        b = data[i]
        i += 1
        n |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            return n, i


def _packed(vals: list) -> list:
    """A repeated varint field, packed (bytes) or not (ints)."""
    out = []
    for v in vals:
        if isinstance(v, bytes):
            i = 0
            while i < len(v):
                n, i = _read_varint(v, i)
                out.append(n)
        else:
            out.append(v)
    return out


def _one(d: dict, field: int, default=None):
    return d[field][-1] if field in d else default


def _str(d: dict, field: int) -> str:
    return _one(d, field, b"").decode("utf-8", "replace")


# Subsystem field numbers in studio.Request / RequestResponse.
CORE, BEHAVIORS, KEYMAP = 3, 4, 5
META = 2
META_ERRORS = {0: "generic error", 1: "keyboard is locked: press its &studio_unlock key",
               2: "request not supported", 3: "keyboard could not decode the request",
               4: "keyboard could not encode the response"}
SET_BINDING = {1: "invalid location", 2: "invalid behavior", 3: "invalid parameters"}
SAVE_ERRORS = {1: "generic error", 2: "not supported", 3: "no space"}
ADD_LAYER_ERRORS = {1: "generic error", 2: "no reserved layer left: add one in the keymap and flash"}
REMOVE_LAYER_ERRORS = {1: "generic error", 2: "invalid layer index"}
RESTORE_LAYER_ERRORS = {1: "generic error", 2: "invalid layer id", 3: "invalid index"}
LAYER_PROPS_ERRORS = {1: "generic error", 2: "invalid layer id"}
MOVE_LAYER_ERRORS = {1: "generic error", 2: "invalid layer", 3: "invalid destination"}


class Client:
    def __init__(self, port: str, timeout: float = TIMEOUT):
        try:
            self.ser = serial.Serial(port, timeout=0.1, exclusive=True)
        except serial.SerialException as e:
            raise StudioError(f"{port}: {e}") from e
        self.port = port
        self.timeout = timeout
        self.next_id = 1
        self.deframer = Deframer()
        self.notifications: list = []

    def close(self):
        self.ser.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def call(self, subsystem: int, body: bytes) -> bytes:
        """Sends one request and returns the subsystem response body."""
        rid = self.next_id
        self.next_id += 1
        try:
            self.ser.write(frame(vint(1, rid) + msg(subsystem, body)))
            return self._wait(rid, subsystem)
        except serial.SerialException as e:
            raise Gone(f"{self.port}: {e}") from e

    def _wait(self, rid: int, subsystem: int) -> bytes:
        end = time.monotonic() + self.timeout
        while time.monotonic() < end:
            for p in self.deframer.feed(self.ser.read(256)):
                resp = decode(p)
                if 2 in resp:
                    self.notifications.append(decode(resp[2][-1]))
                    continue
                rr = decode(_one(resp, 1, b""))
                if _one(rr, 1, 0) != rid:
                    continue
                if META in rr:
                    meta = decode(rr[META][-1])
                    code = _one(meta, 2)
                    if code is not None:
                        raise StudioError(META_ERRORS.get(code, f"error {code}"))
                    raise StudioError("no response")
                if subsystem not in rr:
                    raise StudioError("response for another subsystem")
                return rr[subsystem][-1]
        raise StudioError(f"{self.port}: no answer in {self.timeout:g}s")

    def _req(self, subsystem: int, field: int, body: bytes | None = None) -> dict:
        req = vint(field, 1) if body is None else msg(field, body)
        resp = decode(self.call(subsystem, req))
        if field not in resp:
            raise StudioError("unexpected response")
        return resp

    # core

    def device_info(self) -> dict:
        d = decode(self._req(CORE, 1)[1][-1])
        return {"name": _str(d, 1), "serial": _one(d, 2, b"").hex()}

    def unlocked(self) -> bool:
        return self._req(CORE, 2)[2][-1] == 1

    def reset_settings(self) -> bool:
        return bool(self._req(CORE, 4)[4][-1])

    # behaviors

    def behavior_ids(self) -> list:
        return _packed(decode(self._req(BEHAVIORS, 1)[1][-1]).get(1, []))

    def behavior(self, bid: int) -> dict:
        d = decode(self._req(BEHAVIORS, 2, vint(1, bid))[2][-1])
        return {"id": _one(d, 1, 0), "name": _str(d, 2),
                "metadata": [_param_set(decode(m)) for m in d.get(3, [])]}

    def behaviors(self) -> list:
        return [self.behavior(b) for b in self.behavior_ids()]

    # keymap

    def keymap(self) -> dict:
        d = decode(self._req(KEYMAP, 1)[1][-1])
        return {"layers": [_layer(decode(l)) for l in d.get(1, [])],
                "available_layers": _one(d, 2, 0),
                "max_layer_name_length": _one(d, 3, 0)}

    def set_binding(self, layer_id: int, position: int, behavior: int,
                    param1: int = 0, param2: int = 0):
        binding = sint(1, behavior) + vint(2, param1) + vint(3, param2)
        body = vint(1, layer_id) + vint(2, position) + msg(3, binding)  # key_position is int32, not sint32
        code = self._req(KEYMAP, 2, body)[2][-1]
        if code:
            raise StudioError(SET_BINDING.get(code, f"error {code}"))

    def unsaved(self) -> bool:
        return bool(self._req(KEYMAP, 3)[3][-1])

    def save(self):
        d = decode(self._req(KEYMAP, 4)[4][-1])
        if 2 in d and d[2][-1]:
            raise StudioError("save failed: " + SAVE_ERRORS.get(d[2][-1], str(d[2][-1])))

    def discard(self):
        self._req(KEYMAP, 5)

    def _result(self, field: int, body: bytes, errors: dict) -> dict:
        """A `oneof result {ok = 1; err = 2}` reply: the decoded ok, or StudioError."""
        d = decode(self._req(KEYMAP, field, body)[field][-1])
        if 2 in d and d[2][-1]:
            raise StudioError(errors.get(d[2][-1], f"error {d[2][-1]}"))
        ok = _one(d, 1, b"")
        return decode(ok) if isinstance(ok, bytes) else {}

    def move_layer(self, start: int, dest: int) -> dict:
        """Move the layer at index `start` to `dest`: the keymap as it is after."""
        d = self._result(8, vint(1, start) + vint(2, dest), MOVE_LAYER_ERRORS)
        return {"layers": [_layer(decode(l)) for l in d.get(1, [])],
                "available_layers": _one(d, 2, 0),
                "max_layer_name_length": _one(d, 3, 0)}

    def add_layer(self) -> dict:
        """Turn on the next reserved layer: {index, layer}."""
        d = self._result(9, b"", ADD_LAYER_ERRORS)
        return {"index": _one(d, 1, 0), "layer": _layer(decode(_one(d, 2, b"")))}

    def remove_layer(self, index: int):
        self._result(10, vint(1, index), REMOVE_LAYER_ERRORS)

    def restore_layer(self, layer_id: int, at: int) -> dict:
        return _layer(self._result(11, vint(1, layer_id) + vint(2, at),
                                   RESTORE_LAYER_ERRORS))

    def set_layer_name(self, layer_id: int, name: str):
        code = self._req(KEYMAP, 12, vint(1, layer_id) + msg(2, name.encode()))[12][-1]
        if code:
            raise StudioError(LAYER_PROPS_ERRORS.get(code, f"error {code}"))

    def physical_layouts(self) -> dict:
        d = decode(self._req(KEYMAP, 6)[6][-1])
        return {"active": _one(d, 1, 0),
                "layouts": [_layout(decode(l)) for l in d.get(2, [])]}


def _binding(d: dict) -> dict:
    return {"behavior": _unzigzag(_one(d, 1, 0)), "param1": _one(d, 2, 0),
            "param2": _one(d, 3, 0)}


def _layer(d: dict) -> dict:
    return {"id": _one(d, 1, 0), "name": _str(d, 2),
            "bindings": [_binding(decode(b)) for b in d.get(3, [])]}


def _layout(d: dict) -> dict:
    keys = []
    for k in d.get(2, []):
        a = decode(k)
        keys.append({n: _unzigzag(_one(a, f, 0)) for f, n in
                     enumerate(("width", "height", "x", "y", "r", "rx", "ry"), 1)})
    return {"name": _str(d, 1), "keys": keys}


def _param_value(d: dict) -> dict:
    out = {"name": _str(d, 1)}
    if 2 in d:
        out["nil"] = True
    elif 3 in d:
        out["constant"] = d[3][-1]
    elif 4 in d:
        r = decode(d[4][-1])
        out["range"] = [_signed(_one(r, 1, 0)), _signed(_one(r, 2, 0))]
    elif 5 in d:
        h = decode(d[5][-1])
        out["hid_usage"] = {"keyboard_max": _one(h, 1, 0), "consumer_max": _one(h, 2, 0)}
    elif 6 in d:
        out["layer_id"] = True
    return out


def _signed(n: int) -> int:
    """int32 sent as a 64-bit varint."""
    return n - (1 << 64) if n >= 1 << 63 else n


def _param_set(d: dict) -> dict:
    return {"param1": [_param_value(decode(v)) for v in d.get(1, [])],
            "param2": [_param_value(decode(v)) for v in d.get(2, [])]}


class Session:
    """One open keyboard shared by the server's request threads."""

    def __init__(self):
        self.client: Client | None = None
        self.info: dict | None = None
        self.behaviors: list | None = None
        self.lock = threading.Lock()

    def status(self) -> dict:
        return {"port": self.client.port if self.client else None, "info": self.info}

    def ports(self) -> list:
        """Ports answering as Studio; the open one is listed without probing it."""
        with self.lock:
            out = []
            for port in candidates():
                if self.client and port == self.client.port:
                    out.append({"port": port, **self.info})
                    continue
                try:
                    with Client(port, 0.5) as c:
                        out.append({"port": port, **c.device_info()})
                except StudioError:
                    continue
            return out

    def connect(self, port: str | None) -> dict:
        with self.lock:
            self._close()
            c = connect(port)
            try:
                self.info = c.device_info()
            except StudioError:
                c.close()
                raise
            self.client = c
            return self.status()

    def disconnect(self):
        with self.lock:
            self._close()

    def _close(self):
        if self.client:
            self.client.close()
        self.client = self.info = self.behaviors = None

    def run(self, fn):
        """fn(client) under the lock; a dead port closes the session."""
        with self.lock:
            if not self.client:
                raise NotConnected("no keyboard connected")
            try:
                return fn(self.client)
            except Gone:
                self._close()
                raise

    def behavior_list(self) -> list:
        """Read once per connection: ids differ between firmware builds."""
        def read(c):
            if self.behaviors is None:
                self.behaviors = c.behaviors()
            return self.behaviors
        return self.run(read)


class NotConnected(StudioError):
    pass


def candidates() -> list:
    """USB serial ports only; Studio has no other serial transport."""
    return sorted(p.device for p in list_ports.comports() if p.vid is not None)


def find(timeout: float = 0.5) -> list:
    """[(port, device info)] for every serial port that answers as ZMK Studio."""
    found = []
    for port in candidates():
        try:
            with Client(port, timeout) as c:
                found.append((port, c.device_info()))
        except StudioError:
            continue
    return found


def connect(port: str | None) -> Client:
    if port:
        return Client(port)
    found = find()
    if not found:
        raise StudioError("no keyboard answered; is it connected over USB with a Studio build?")
    if len(found) > 1:
        raise StudioError("several keyboards answered, pick one with --port: "
                          + ", ".join(p for p, _ in found))
    return Client(found[0][0])


def _names(c: Client) -> dict:
    return {b["id"]: b["name"] for b in c.behaviors()}


def _behavior_id(c: Client, ref: str) -> int:
    if ref.lstrip("-").isdigit():
        return int(ref)
    want = ref.lower()
    for b in c.behaviors():
        if b["name"].lower() == want:
            return b["id"]
    raise StudioError(f"no behavior named {ref!r}; see `behaviors`")


def _layer_id(km: dict, ref: str) -> int:
    layers = km["layers"]
    for l in layers:
        if l["name"] == ref:
            return l["id"]
    if ref.isdigit() and int(ref) < len(layers):
        return layers[int(ref)]["id"]
    raise StudioError(f"no layer {ref!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial device (default: probe every serial port)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ports", help="list serial ports that answer as ZMK Studio")
    sub.add_parser("info", help="device name, serial number, lock state")
    sub.add_parser("behaviors", help="behaviors the firmware offers, with ids")
    sub.add_parser("keymap", help="every layer's bindings")
    sub.add_parser("layouts", help="physical layouts")
    s = sub.add_parser("set", help="bind a key (pending until save)")
    s.add_argument("layer", help="layer name or index")
    s.add_argument("position", type=int)
    s.add_argument("behavior", help="behavior name (e.g. 'Key Press') or id")
    s.add_argument("param1", nargs="?", type=lambda v: int(v, 0), default=0)
    s.add_argument("param2", nargs="?", type=lambda v: int(v, 0), default=0)
    sub.add_parser("save", help="write pending changes to the keyboard's flash")
    sub.add_parser("discard", help="drop pending changes")
    sub.add_parser("reset", help="erase every Studio change stored on the keyboard")
    a = ap.parse_args()

    try:
        if a.cmd == "ports":
            found = find()
            for port, info in found:
                print(f"{port}\t{info['name']}\t{info['serial']}")
            if not found:
                print("no keyboard answered", file=sys.stderr)
                return 1
            return 0
        with connect(a.port) as c:
            if a.cmd == "info":
                info = c.device_info()
                print(f"port      {c.port}\nname      {info['name']}\n"
                      f"serial    {info['serial']}\n"
                      f"unlocked  {'yes' if c.unlocked() else 'no'}\n"
                      f"unsaved   {'yes' if c.unsaved() else 'no'}")
            elif a.cmd == "behaviors":
                for b in c.behaviors():
                    print(f"{b['id']:>4}  {b['name']}")
            elif a.cmd == "keymap":
                names = _names(c)
                km = c.keymap()
                for i, l in enumerate(km["layers"]):
                    print(f"layer {i} (id {l['id']}) {l['name']}")
                    for pos, b in enumerate(l["bindings"]):
                        print(f"  {pos:>3}  {names.get(b['behavior'], b['behavior'])}"
                              f" {b['param1']:#x} {b['param2']:#x}")
                print(f"{km['available_layers']} more layers available")
            elif a.cmd == "layouts":
                pl = c.physical_layouts()
                for i, l in enumerate(pl["layouts"]):
                    mark = "*" if i == pl["active"] else " "
                    print(f"{mark} {i}  {l['name']}  ({len(l['keys'])} keys)")
            elif a.cmd == "set":
                layer = _layer_id(c.keymap(), a.layer)
                c.set_binding(layer, a.position, _behavior_id(c, a.behavior),
                              a.param1, a.param2)
                print("set; pending until `save`")
            elif a.cmd == "save":
                c.save()
                print("saved")
            elif a.cmd == "discard":
                c.discard()
                print("discarded")
            elif a.cmd == "reset":
                print("reset" if c.reset_settings() else "reset failed")
    except StudioError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
