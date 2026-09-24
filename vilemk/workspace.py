"""Fetched board data in `.zmk/`, and `config/west.yml`, the record of what is in it.

Standard library only: no `west` and no `git` on the host. A repository is read
through GitHub's API (a ref to a commit) and its tarball (the files at that
commit), so only GitHub URLs work.

    python3 -m vilemk.workspace show
    python3 -m vilemk.workspace update zmk [--url URL] [--ref REF]
    python3 -m vilemk.workspace catalog
    python3 -m vilemk.workspace add <github-url> [--ref REF] [--name NAME]
    python3 -m vilemk.workspace remove <name>

The pinning rule: the ref asked for is resolved to a commit once, and the commit
is what `west.yml` records as `revision`. The ref goes in west's own `userdata`
field, which west ignores, so an update knows what to resolve again and the build
container's `west update` fetches exactly the commit that was designed against.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

from . import PROJECT_DIR
from .keymap import _yaml_uncomment, _yaml_unquote

ZMK_DIR = ".zmk"
WEST_YML = os.path.join("config", "west.yml")

ZMK_URL = "https://github.com/zmkfirmware/zmk"
ZMK_REF = "v0.3"
# Every path the design-time code reads out of ZMK. The rest of the repo is
# only needed by a build, which fetches its own copy.
ZMK_PREFIXES = ("app/boards", "app/dts", "app/include/dt-bindings")

LICENSE_RE = re.compile(r"^(LICEN[CS]E|COPYING)(\.\w+)?$", re.I)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][\w.-]*$")
GITHUB_RE = re.compile(
    r"^(?:https?://(?:www\.)?github\.com/|git@github\.com:)"
    r"(?P<owner>[\w.-]+)/(?P<repo>[\w.-]+?)(?:\.git)?/?$")

TIMEOUT = 60
UA = "vilemk"

# One fetch at a time: two would race on the same temp dir and west.yml.
_LOCK = threading.Lock()


class WorkspaceError(Exception):
    """A fetch or update that did not happen, with a reason a user can act on."""


class Busy(WorkspaceError):
    pass


# ---------------------------------------------------------------- GitHub

def parse_github(url: str):
    """`https://github.com/o/r(.git)` or `git@github.com:o/r` -> (owner, repo)."""
    m = GITHUB_RE.match((url or "").strip())
    if not m:
        raise WorkspaceError(f"{url!r} is not a GitHub repository URL. Only GitHub "
                             f"is supported: there is no git on the host, so each "
                             f"host would need its own download format.")
    return m.group("owner"), m.group("repo")


def _get(url: str, accept: str = ""):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               **({"Accept": accept} if accept else {})})
    return urllib.request.urlopen(req, timeout=TIMEOUT)


def resolve(owner: str, repo: str, ref: str) -> str:
    """A branch, tag or commit -> the commit SHA it names right now.

    Unauthenticated, so GitHub allows 60 of these an hour. A typo in the ref
    fails here, before anything is downloaded.
    """
    ref = (ref or "").strip()
    if not ref:
        raise WorkspaceError("no ref given: name a branch, a tag or a commit")
    url = (f"https://api.github.com/repos/{owner}/{repo}/commits/"
           f"{urllib.parse.quote(ref, safe='/')}")
    try:
        with _get(url, "application/vnd.github.sha") as resp:
            sha = resp.read().decode("ascii", "replace").strip()
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 422):
            raise WorkspaceError(f"{owner}/{repo} has no branch, tag or commit "
                                 f"{ref!r}, or the repository does not exist") from None
        if exc.code in (403, 429):
            raise WorkspaceError("GitHub's rate limit for unauthenticated requests "
                                 "(60 an hour) is used up; try again later") from None
        raise WorkspaceError(f"GitHub answered {exc.code} for {owner}/{repo}@{ref}") \
            from None
    except (urllib.error.URLError, OSError) as exc:
        raise WorkspaceError(f"could not reach GitHub: {getattr(exc, 'reason', exc)}") \
            from None
    if not SHA_RE.match(sha):
        raise WorkspaceError(f"GitHub returned something that is not a commit for "
                             f"{owner}/{repo}@{ref}")
    return sha


def _wanted(rel: str, prefixes) -> bool:
    if prefixes is None:
        return True
    if "/" not in rel and LICENSE_RE.match(rel):
        return True           # the licence travels with whatever is kept
    return any(rel == p or rel.startswith(p + "/") for p in prefixes)


def _safe_rel(name: str):
    """A member name without its `<repo>-<sha>/` top directory, or None to skip it.

    `requires-python >= 3.9` predates tarfile's extraction filters, so every
    member is extracted by hand and anything that could leave `dest` is refused
    here: absolute paths, `..`, and (in `fetch`) links and device files.
    """
    parts = name.replace("\\", "/").split("/")[1:]
    parts = [p for p in parts if p not in ("", ".")]
    if not parts or name.startswith("/") or ".." in parts:
        return None
    return "/".join(parts)


def fetch(owner: str, repo: str, sha: str, dest: str, prefixes=None) -> int:
    """Download `owner/repo` at `sha` and put it at `dest`, keeping only `prefixes`.

    Extracts into a temp dir beside `dest` and swaps it in with a rename, so the
    old copy stays until the new one is complete and a failed fetch leaves a
    working tree. Returns the number of files written.
    """
    parent = os.path.dirname(os.path.abspath(dest))
    os.makedirs(parent, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=f".{os.path.basename(dest)}.new-", dir=parent)
    os.chmod(tmp, 0o755)        # mkdtemp's 0700 would stick to `dest` after the rename
    count = 0
    try:
        url = f"https://codeload.github.com/{owner}/{repo}/tar.gz/{sha}"
        try:
            resp = _get(url)
        except urllib.error.HTTPError as exc:
            raise WorkspaceError(f"downloading {owner}/{repo}@{sha[:7]} failed "
                                 f"({exc.code})") from None
        except (urllib.error.URLError, OSError) as exc:
            raise WorkspaceError(f"could not reach GitHub: "
                                 f"{getattr(exc, 'reason', exc)}") from None
        with resp, tarfile.open(fileobj=resp, mode="r|gz") as tar:
            for m in tar:
                rel = _safe_rel(m.name)
                if rel is None or not _wanted(rel, prefixes):
                    continue
                out = os.path.join(tmp, *rel.split("/"))
                if m.isdir():
                    os.makedirs(out, exist_ok=True)
                elif m.isfile():
                    os.makedirs(os.path.dirname(out), exist_ok=True)
                    src = tar.extractfile(m)
                    with open(out, "wb") as fh:
                        shutil.copyfileobj(src, fh)
                    os.chmod(out, 0o644 | (m.mode & 0o111))
                    count += 1
                # links, devices and fifos are skipped: nothing read here needs one
        if not count:
            raise WorkspaceError(f"{owner}/{repo}@{sha[:7]} has none of "
                                 f"{', '.join(prefixes or ['its files'])}")
        old = None
        if os.path.exists(dest):
            old = tempfile.mkdtemp(prefix=f".{os.path.basename(dest)}.old-", dir=parent)
            os.rmdir(old)
            os.rename(dest, old)
        os.rename(tmp, dest)
        tmp = None
        if old:
            shutil.rmtree(old, ignore_errors=True)
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise WorkspaceError(f"reading the download of {owner}/{repo} failed: {exc}") \
            from None
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    return count


# ------------------------------------------------------------------ YAML
# Enough YAML for `west.yml` and `*.zmk.yml`: block maps and lists, flow lists,
# `|`/`>` block scalars, quoted and plain scalars. Nothing is typed; every
# scalar stays a string.

def _lines(text: str):
    out = []
    for raw in text.splitlines():
        line = _yaml_uncomment(raw).rstrip()
        if line.strip() and line.strip() not in ("---", "..."):
            out.append((len(line) - len(line.lstrip()), line.strip(), raw))
    return out


def _scalar(val: str):
    val = val.strip()
    if val.startswith("[") and val.endswith("]"):
        return [_yaml_unquote(v) for v in val[1:-1].split(",") if v.strip()]
    return _yaml_unquote(val)


def _key(body: str):
    m = re.match(r"^(\"[^\"]*\"|'[^']*'|[^:]+?)[ \t]*:(?:[ \t]+(.*)|$)", body)
    return (_yaml_unquote(m.group(1)), (m.group(2) or "").strip()) if m else (None, None)


def _block(lines, i, indent):
    if lines[i][1].startswith("- ") or lines[i][1] == "-":
        return _seq(lines, i, indent)
    return _map(lines, i, indent)


def _seq(lines, i, indent):
    items = []
    while i < len(lines) and lines[i][0] == indent and \
            (lines[i][1].startswith("- ") or lines[i][1] == "-"):
        rest = lines[i][1][1:].strip()
        if not rest:
            i += 1
            if i < len(lines) and lines[i][0] > indent:
                val, i = _block(lines, i, lines[i][0])
            else:
                val = ""
        elif _key(rest)[0] is not None and not rest.startswith(("\"", "'")):
            # `- key: val` opens a map whose keys sit where `key` does
            at = indent + len(lines[i][1]) - len(rest)
            lines[i] = (at, rest, lines[i][2])
            val, i = _map(lines, i, at)
        else:
            val, i = _scalar(rest), i + 1
        items.append(val)
    return items, i


def _map(lines, i, indent):
    out = {}
    while i < len(lines) and lines[i][0] == indent:
        key, val = _key(lines[i][1])
        if key is None:
            i += 1
            continue
        i += 1
        if val in ("|", ">") or re.match(r"^[|>][+-]?\d*$", val or ""):
            parts = []
            while i < len(lines) and lines[i][0] > indent:
                parts.append(lines[i][2].strip())
                i += 1
            out[key] = ("\n" if val.startswith("|") else " ").join(parts)
        elif val:
            out[key] = _scalar(val)
        elif i < len(lines) and (lines[i][0] > indent or
                                 (lines[i][0] == indent and lines[i][1].startswith("-"))):
            out[key], i = _block(lines, i, lines[i][0])
        else:
            out[key] = ""
    return out, i


def parse_yaml(text: str):
    lines = _lines(text)
    if not lines:
        return {}
    return _block(lines, 0, lines[0][0])[0]


PLAIN_RE = re.compile(r"^[A-Za-z_/.][\w./:@+~-]*$")
YAML_WORDS = {"true", "false", "yes", "no", "on", "off", "null", "~", "y", "n"}


def _emit_scalar(v) -> str:
    s = str(v)
    if PLAIN_RE.match(s) and s.lower() not in YAML_WORDS:
        return s
    return json.dumps(s)        # a JSON string is a valid YAML double-quoted one


def dump_yaml(obj, indent: int = 0) -> str:
    pad = " " * indent
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and v:
                out.append(f"{pad}{k}:")
                out.append(dump_yaml(v, indent + 2))
            else:
                empty = {dict: "{}", list: "[]"}.get(type(v))
                out.append(f"{pad}{k}: {empty or _emit_scalar(v)}")
    else:
        for v in obj:
            if isinstance(v, dict) and v:
                first, *rest = dump_yaml(v, indent + 2).split("\n")
                out.append(f"{pad}- {first.lstrip()}")
                out.extend(rest)
            elif isinstance(v, list):
                out.append(f"{pad}-")
                out.append(dump_yaml(v, indent + 2))
            else:
                out.append(f"{pad}- {_emit_scalar(v)}")
    return "\n".join(out)


# -------------------------------------------------------------- *.zmk.yml

ZMK_YML_KEYS = ("id", "name", "type", "arch", "url", "requires", "exposes",
                "features", "siblings")
ZMK_YML_LISTS = ("requires", "exposes", "features", "siblings")


def parse_zmk_yml(text: str) -> dict:
    """The fields of a board or shield's metadata file that adding one needs."""
    raw = parse_yaml(text)
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k in ZMK_YML_KEYS:
        v = raw.get(k)
        if k in ZMK_YML_LISTS:
            out[k] = [str(x) for x in v] if isinstance(v, list) else ([v] if v else [])
        else:
            out[k] = v if isinstance(v, str) else ""
    return out


def catalog(zmk_dir: str = ZMK_DIR):
    """Every board, shield and interconnect ZMK and the installed modules describe.

    `source` is `zmk` or the module's directory name; `keymap` says whether the
    entry ships a default keymap, which is what makes it offerable as a keyboard.
    """
    roots = [("zmk", os.path.join(zmk_dir, "zmk", "app", "boards"))]
    mods = os.path.join(zmk_dir, "modules")
    if os.path.isdir(mods):
        roots += [(m, os.path.join(mods, m)) for m in sorted(os.listdir(mods))]
    out = []
    for source, root in roots:
        for dirpath, dirs, files in os.walk(root):
            dirs.sort()
            for fn in sorted(files):
                if not fn.endswith(".zmk.yml"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    meta = parse_zmk_yml(open(path, encoding="utf-8").read())
                except (OSError, UnicodeDecodeError):
                    continue
                if not meta.get("id"):
                    continue
                meta.update(source=source, dir=dirpath,
                            keymap=os.path.isfile(os.path.join(dirpath,
                                                               meta["id"] + ".keymap")))
                out.append(meta)
    return out


# ---------------------------------------------------------------- west.yml

WEST_HEADER = """\
# Written by VileMK. `revision` is the commit that was fetched into .zmk/ and
# the commit a build compiles; `userdata.ref` is the branch or tag it came from,
# which is what an update resolves again.
"""


def default_manifest() -> dict:
    return {"manifest": {
        "projects": [{"name": "zmk", "url": ZMK_URL, "revision": ZMK_REF,
                      "import": "app/west.yml", "userdata": {"ref": ZMK_REF}}],
        "self": {"path": "config"}}}


def west_yml_read(path: str = WEST_YML) -> dict:
    """The manifest, or the default one (ZMK at v0.3) when there is no file yet."""
    try:
        text = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        return default_manifest()
    data = parse_yaml(text)
    if not isinstance(data, dict) or not isinstance(data.get("manifest"), dict):
        raise WorkspaceError(f"{path} has no `manifest:` section")
    data["manifest"].setdefault("projects", [])
    return data


def west_yml_write(data: dict, path: str = WEST_YML) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(WEST_HEADER + dump_yaml(data) + "\n")
    os.replace(tmp, path)


def project(data: dict, name: str):
    for p in data["manifest"].get("projects") or []:
        if isinstance(p, dict) and p.get("name") == name:
            return p
    return None


def project_info(data: dict, name: str) -> dict:
    """A project's URL, the ref it follows and the revision it is at.

    `url` falls back to the remote's `url-base` + name, `revision` to the
    manifest's default, and `ref` to `revision` for a project VileMK has not
    pinned yet (one written by hand or by zmk-cli).
    """
    m = data["manifest"]
    p = project(data, name) or {}
    url = p.get("url") or ""
    if not url and p.get("remote"):
        for r in m.get("remotes") or []:
            if isinstance(r, dict) and r.get("name") == p["remote"]:
                url = f"{r.get('url-base', '').rstrip('/')}/{p.get('repo-path') or name}"
    rev = p.get("revision") or (m.get("defaults") or {}).get("revision") or ""
    ud = p.get("userdata") if isinstance(p.get("userdata"), dict) else {}
    ref = ud.get("ref") or ("" if SHA_RE.match(rev) else rev)
    return {"name": name, "url": url, "ref": ref, "revision": rev,
            "pinned": bool(SHA_RE.match(rev))}


def zmk_info(zmk_dir: str = ZMK_DIR) -> dict:
    """What the settings panel shows for ZMK. Never raises."""
    try:
        info = project_info(west_yml_read(), "zmk")
    except (WorkspaceError, OSError, UnicodeDecodeError) as exc:
        info = {"name": "zmk", "url": "", "ref": "", "revision": "", "pinned": False,
                "error": str(exc)}
    info["url"] = info["url"] or ZMK_URL
    info["ref"] = info["ref"] or ZMK_REF
    info["fetched"] = os.path.isdir(os.path.join(zmk_dir, "zmk", "app", "boards"))
    info["default_url"], info["default_ref"] = ZMK_URL, ZMK_REF
    return info


# ----------------------------------------------------------------- install

def _pin(data: dict, name: str, url: str, ref: str, sha: str, **extra) -> None:
    p = project(data, name)
    if p is None:
        p = {"name": name}
        data["manifest"]["projects"].append(p)
    # An explicit url replaces `remote`: the file then says where it came from
    # without a lookup, and a changed url is not overridden by the remote's.
    p.pop("remote", None)
    p.pop("repo-path", None)
    new = {"name": name, "url": url, "revision": sha}
    new.update({k: v for k, v in p.items() if k not in new and k != "userdata"})
    new.update(extra)
    ud = dict(p.get("userdata") or {}) if isinstance(p.get("userdata"), dict) else {}
    ud["ref"] = ref
    new["userdata"] = ud
    p.clear()
    p.update(new)


def install_zmk(url: str = "", ref: str = "", zmk_dir: str = ZMK_DIR) -> dict:
    """Fetch ZMK's board data at `ref` and pin it in west.yml.

    Blank `url` / `ref` keep what west.yml has, so no arguments means "update":
    resolve the stored ref again. Only `.zmk/zmk/` and west.yml are written.
    """
    if not _LOCK.acquire(blocking=False):
        raise Busy("another fetch is running")
    try:
        data = west_yml_read()
        cur = project_info(data, "zmk")
        url = (url or cur["url"] or ZMK_URL).strip().rstrip("/")
        ref = (ref or cur["ref"] or ZMK_REF).strip()
        owner, repo = parse_github(url)
        sha = resolve(owner, repo, ref)
        files = fetch(owner, repo, sha, os.path.join(zmk_dir, "zmk"), ZMK_PREFIXES)
        _pin(data, "zmk", url, ref, sha, **{"import": "app/west.yml"})
        west_yml_write(data)
        return {**project_info(data, "zmk"), "was": cur["revision"], "files": files}
    finally:
        _LOCK.release()


def install_module(name: str, zmk_dir: str = ZMK_DIR) -> dict:
    """Fetch a module listed in west.yml into `.zmk/modules/<name>/` and pin it.

    The whole repository is kept: modules are small (zmk-eyelash-sofle is 768K)
    and a keyboard's files are wherever the vendor put them.
    """
    if not NAME_RE.match(name or "") or name == "zmk":
        raise WorkspaceError(f"{name!r} is not a module name")
    if not _LOCK.acquire(blocking=False):
        raise Busy("another fetch is running")
    try:
        data = west_yml_read()
        if project(data, name) is None:
            raise WorkspaceError(f"{name} is not in {WEST_YML}")
        cur = project_info(data, name)
        if not cur["ref"]:
            raise WorkspaceError(f"{name} is pinned to a commit with no ref to follow; "
                                 f"set userdata.ref in {WEST_YML}")
        owner, repo = parse_github(cur["url"])
        sha = resolve(owner, repo, cur["ref"])
        files = fetch(owner, repo, sha, os.path.join(zmk_dir, "modules", name))
        path = (project(data, name) or {}).get("path") or f"modules/{name}"
        _pin(data, name, cur["url"], cur["ref"], sha, path=path)
        west_yml_write(data)
        return {**project_info(data, name), "was": cur["revision"], "files": files}
    finally:
        _LOCK.release()


def add_module(url: str, ref: str = "main", name: str = "",
               zmk_dir: str = ZMK_DIR) -> dict:
    """Fetch a module from GitHub into `.zmk/modules/<name>/` and add it to west.yml.

    `name` defaults to the repository name. Resolve, fetch, write, in that
    order: a bad URL or ref fails before anything is downloaded, and west.yml
    only gains the project once its files are in place.
    """
    url = (url or "").strip().rstrip("/")
    ref = (ref or "").strip() or "main"
    owner, repo = parse_github(url)
    url = f"https://github.com/{owner}/{repo}"
    name = (name or "").strip() or repo
    if not NAME_RE.match(name) or name == "zmk":
        raise WorkspaceError(f"{name!r} cannot be a module name")
    if not _LOCK.acquire(blocking=False):
        raise Busy("another fetch is running")
    try:
        data = west_yml_read()
        if project(data, name) is not None:
            raise WorkspaceError(f"{name} is already in {WEST_YML}; update it instead")
        for p in data["manifest"]["projects"]:
            other = project_info(data, p.get("name", "")) if isinstance(p, dict) else {}
            if other.get("url", "").lower().removesuffix(".git") == url.lower():
                raise WorkspaceError(f"{url} is already in {WEST_YML} as {other['name']}")
        sha = resolve(owner, repo, ref)
        files = fetch(owner, repo, sha, os.path.join(zmk_dir, "modules", name))
        _pin(data, name, url, ref, sha, path=f"modules/{name}")
        west_yml_write(data)
        return {**project_info(data, name), "was": "", "files": files}
    finally:
        _LOCK.release()


def remove_module(name: str, zmk_dir: str = ZMK_DIR) -> dict:
    """Drop a module from west.yml and delete `.zmk/modules/<name>/`.

    Whether anything still uses it is the caller's question
    (`keyboards.remove_module`); this only undoes `add_module`.
    """
    if not NAME_RE.match(name or "") or name == "zmk":
        raise WorkspaceError(f"{name!r} is not a module name")
    if not _LOCK.acquire(blocking=False):
        raise Busy("another fetch is running")
    try:
        data = west_yml_read()
        dest = os.path.join(zmk_dir, "modules", name)
        listed = project(data, name) is not None
        if not listed and not os.path.isdir(dest):
            raise WorkspaceError(f"{name} is not in {WEST_YML}")
        if listed:
            data["manifest"]["projects"] = [
                p for p in data["manifest"]["projects"]
                if not (isinstance(p, dict) and p.get("name") == name)]
            west_yml_write(data)
        shutil.rmtree(dest, ignore_errors=True)
        return {"name": name, "listed": listed}
    finally:
        _LOCK.release()


def modules(zmk_dir: str = ZMK_DIR) -> list:
    """Every project in west.yml but ZMK, with `fetched` for `.zmk/modules/<name>/`."""
    try:
        data = west_yml_read()
    except (WorkspaceError, OSError, UnicodeDecodeError):
        return []
    out = []
    for p in data["manifest"]["projects"]:
        name = p.get("name", "") if isinstance(p, dict) else ""
        if not name or name == "zmk":
            continue
        info = project_info(data, name)
        info["fetched"] = os.path.isdir(os.path.join(zmk_dir, "modules", name))
        out.append(info)
    return out


# ----------------------------------------------------------------- command

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("show", help="what west.yml pins, per project")
    up = sub.add_parser("update", help="resolve a project's ref again and fetch it")
    up.add_argument("name", help="`zmk` or a module name from west.yml")
    up.add_argument("--url", default="", help="zmk only: switch repository")
    up.add_argument("--ref", default="", help="zmk only: switch branch or tag")
    sub.add_parser("catalog", help="every *.zmk.yml in .zmk/")
    ad = sub.add_parser("add", help="fetch a module from GitHub and add it to west.yml")
    ad.add_argument("url")
    ad.add_argument("--ref", default="main", help="branch, tag or commit (default main)")
    ad.add_argument("--name", default="", help="default: the repository name")
    rm = sub.add_parser("remove", help="drop a module from west.yml and .zmk/modules/")
    rm.add_argument("name")
    args = ap.parse_args()
    os.chdir(PROJECT_DIR)

    try:
        if args.cmd == "show":
            data = west_yml_read()
            for p in data["manifest"]["projects"]:
                i = project_info(data, p.get("name", ""))
                pin = i["revision"][:12] if i["pinned"] else f"{i['revision']} (not pinned)"
                print(f"{i['name']:<24} {pin:<24} ref={i['ref'] or '-'}  {i['url']}")
        elif args.cmd == "update":
            if args.name == "zmk":
                r = install_zmk(args.url, args.ref)
            elif args.url or args.ref:
                ap.error("--url and --ref only apply to zmk")
            else:
                r = install_module(args.name)
            was = r["was"][:12] if SHA_RE.match(r["was"]) else r["was"] or "nothing"
            print(f"{r['name']}: {r['ref']} -> {r['revision'][:12]} "
                  f"(was {was}), {r['files']} files")
        elif args.cmd == "add":
            r = add_module(args.url, args.ref, args.name)
            print(f"{r['name']}: {r['ref']} -> {r['revision'][:12]}, {r['files']} files")
        elif args.cmd == "remove":
            remove_module(args.name)
            print(f"removed {args.name}")
        else:
            for e in catalog():
                print(f"{e['source']:<20} {e['type']:<12} {e['id']:<28}"
                      f"{' keymap' if e['keymap'] else ''}")
    except WorkspaceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
