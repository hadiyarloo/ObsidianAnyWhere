#!/usr/bin/env bash
# Obsidian Anywhere - installer (Linux, user-level, no sudo).
#
#   ./install.sh                     detect Obsidian + vaults, install everything
#   ./install.sh --vault "/path"     use this vault
#   ./install.sh --dry-run           show what would happen, change nothing
#
# Safe to run repeatedly (install = upgrade = repair). See --help.

set -u

APP_ID="obsidian-anywhere"
APP_NAME="Obsidian Anywhere"
VERSION="1.0.0"
HELPER_NAME="obsidian-anywhere-open"
DESKTOP_NAME="obsidian-anywhere.desktop"
MIME_TYPES=("text/markdown" "text/x-markdown")
PLUGIN_FILES=("main.js" "manifest.json" "icon.png")

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

# ---- output helpers --------------------------------------------------------------------------------

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; WARNINGS+=("$*"); }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
WARNINGS=()

usage() {
  cat <<EOF
$APP_NAME installer $VERSION

Usage: ./install.sh [options]

  --vault PATH   Install into this vault instead of auto-detecting one.
  --dry-run      Show what would be done. Makes NO changes.
  --reset        Ignore the vault stored in an earlier installation and choose again.
  --yes, -y      Answer "yes" to confirmations (never chooses a vault for you).
  --no-mime      Do not change the default application for Markdown files.
  --no-enable    Do not add the plugin to the vault's community-plugins.json.
  --help, -h     Show this help.

Everything is installed in your home directory (XDG locations). No sudo is used.
EOF
}

# ---- options ---------------------------------------------------------------------------------------

DRY_RUN=0; ASSUME_YES=0; RESET=0; NO_MIME=0; NO_ENABLE=0; VAULT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vault)     [ $# -ge 2 ] || die "--vault needs a path"; VAULT_ARG="$2"; shift 2 ;;
    --vault=*)   VAULT_ARG="${1#--vault=}"; shift ;;
    --dry-run|-n) DRY_RUN=1; shift ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    --reset)     RESET=1; shift ;;
    --no-mime)   NO_MIME=1; shift ;;
    --no-enable) NO_ENABLE=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1 (try --help)" ;;
  esac
done

# ---- environment / XDG locations ---------------------------------------------------------------------

[ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to an existing directory"
[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not as root (everything is installed under your home directory)"

xdg_dir() { case "${1:-}" in /*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac; }
CONFIG_HOME="$(xdg_dir "${XDG_CONFIG_HOME:-}" "$HOME/.config")"
DATA_HOME="$(xdg_dir "${XDG_DATA_HOME:-}" "$HOME/.local/share")"
STATE_HOME="$(xdg_dir "${XDG_STATE_HOME:-}" "$HOME/.local/state")"
BIN_HOME="$(xdg_dir "${XDG_BIN_HOME:-}" "$HOME/.local/bin")"

CONFIG_DIR="$CONFIG_HOME/$APP_ID"
CONFIG_FILE="$CONFIG_DIR/config.json"
APPS_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$APPS_DIR/$DESKTOP_NAME"
APP_DATA_DIR="$DATA_HOME/$APP_ID"
ICON_FILE="$APP_DATA_DIR/icon.png"
STATE_DIR="$STATE_HOME/$APP_ID"
LOG_FILE="$STATE_DIR/$APP_ID.log"
HELPER_FILE="$BIN_HOME/$HELPER_NAME"

# ---- prerequisites -------------------------------------------------------------------------------------

command -v python3 >/dev/null 2>&1 || die "python3 is required (used for JSON handling and by the opener)"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' || die "python3 3.7 or newer is required"
command -v xdg-open >/dev/null 2>&1 || warn "xdg-open not found (package xdg-utils): the opener cannot wake Obsidian without it"
HAVE_XDG_MIME=1
command -v xdg-mime >/dev/null 2>&1 || { HAVE_XDG_MIME=0; warn "xdg-mime not found (package xdg-utils): the Markdown association cannot be registered"; }

for f in "${PLUGIN_FILES[@]}"; do
  [ -f "$SCRIPT_DIR/$f" ] || die "missing $f next to install.sh - run the installer from the project folder"
done
python3 - "$SCRIPT_DIR/manifest.json" "$APP_ID" <<'PY' || die "manifest.json is invalid or has the wrong plugin id"
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
sys.exit(0 if m.get("id") == sys.argv[2] else 1)
PY

# ---- embedded python helpers -----------------------------------------------------------------------------

read -r -d '' PY_VAULTS <<'PY' || true
import json, os, sys
home = os.path.expanduser("~")
xdg = os.environ.get("XDG_CONFIG_HOME", "")
cfg_home = xdg if xdg and os.path.isabs(xdg) else os.path.join(home, ".config")
files = [
    os.path.join(cfg_home, "obsidian", "obsidian.json"),
    os.path.join(home, ".config", "obsidian", "obsidian.json"),
    os.path.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
    os.path.join(home, "snap", "obsidian", "current", ".config", "obsidian", "obsidian.json"),
]
found, seen_files = [], set()
for f in files:
    rf = os.path.realpath(f)
    if rf in seen_files:
        continue
    seen_files.add(rf)
    try:
        with open(f, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        continue
    vaults = data.get("vaults") if isinstance(data, dict) else None
    if not isinstance(vaults, dict):
        continue
    for vid, info in vaults.items():
        p = info.get("path") if isinstance(info, dict) else None
        if not isinstance(p, str) or not p or "\t" in p or "\n" in p or not os.path.isdir(p):
            continue
        ts = info.get("ts") if isinstance(info.get("ts"), (int, float)) else 0
        found.append((vid, p, ts, bool(info.get("open"))))
mode = sys.argv[1] if len(sys.argv) > 1 else "list"
if mode == "lookup":
    want = os.path.realpath(sys.argv[2])
    for vid, p, ts, op in found:
        if os.path.realpath(p) == want:
            print(vid)
            break
else:
    out, seen = [], set()
    for vid, p, ts, op in sorted(found, key=lambda v: (not v[3], -v[2])):
        rp = os.path.realpath(p)
        if rp in seen:
            continue
        seen.add(rp)
        print("%s\t%s\t%d\t%d" % (vid, p, ts, 1 if op else 0))
PY

json_get() { # file key -> string value or empty
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
try:
    v = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2], "")
except Exception:
    v = ""
print(v if isinstance(v, str) else "")
PY
}

canon_path() {
  python3 -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$1"
}

# ---- Obsidian detection ---------------------------------------------------------------------------------

OBS_EXEC=""; OBS_KIND=""; OBS_HANDLER=""

detect_obsidian() {
  local c p d name line f dir
  if c="$(command -v obsidian 2>/dev/null)" && [ -n "$c" ]; then
    OBS_EXEC="$c"; OBS_KIND="found on PATH"
  fi
  if [ -z "$OBS_EXEC" ]; then
    for p in /opt/Obsidian/obsidian /opt/obsidian/obsidian /usr/bin/obsidian /usr/local/bin/obsidian /snap/bin/obsidian "$BIN_HOME/obsidian"; do
      if [ -x "$p" ]; then OBS_EXEC="$p"; OBS_KIND="executable"; break; fi
    done
  fi
  if [ -z "$OBS_EXEC" ] && command -v flatpak >/dev/null 2>&1 && flatpak info md.obsidian.Obsidian >/dev/null 2>&1; then
    OBS_EXEC="flatpak run md.obsidian.Obsidian"; OBS_KIND="Flatpak"
  fi
  if [ -z "$OBS_EXEC" ]; then
    local dirs="$DATA_HOME:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}:$DATA_HOME/flatpak/exports/share:/var/lib/flatpak/exports/share"
    local IFS=':'
    for d in $dirs; do
      for name in obsidian.desktop md.obsidian.Obsidian.desktop; do
        f="$d/applications/$name"
        if [ -f "$f" ]; then
          line="$(sed -n 's/^Exec=//p' "$f" | head -n 1 | sed -e 's/ *%[a-zA-Z]//g')"
          if [ -n "$line" ]; then OBS_EXEC="$line"; OBS_KIND="desktop entry"; break 2; fi
        fi
      done
    done
  fi
  if [ -z "$OBS_EXEC" ]; then
    for dir in "$HOME/Applications" "$HOME/AppImages" "$HOME/Downloads" "$HOME/.local/bin" "$HOME/bin" "$HOME/opt"; do
      for f in "$dir"/[Oo]bsidian*.AppImage; do
        if [ -x "$f" ]; then OBS_EXEC="$f"; OBS_KIND="AppImage"; break 2; fi
      done
    done
  fi
  if [ "$HAVE_XDG_MIME" = 1 ]; then
    OBS_HANDLER="$(xdg-mime query default x-scheme-handler/obsidian 2>/dev/null || true)"
  fi
}

# ---- vault detection / selection ----------------------------------------------------------------------------

VAULT_IDS=(); VAULT_PATHS=()
detect_vaults() {
  local vid vpath vts vopen
  while IFS=$'\t' read -r vid vpath vts vopen; do
    [ -n "${vid:-}" ] && [ -n "${vpath:-}" ] || continue
    VAULT_IDS+=("$vid"); VAULT_PATHS+=("$vpath")
  done < <(python3 -c "$PY_VAULTS" list 2>/dev/null)
}

interactive() { [ -t 0 ]; }

confirm() { # prompt -> 0 if yes
  [ "$ASSUME_YES" = 1 ] && return 0
  interactive || return 1
  local r
  read -r -p "$1 [y/N] " r || return 1
  case "$r" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

VAULT=""; VAULT_REASON=""

prompt_manual_vault() {
  local p
  interactive || die "no vault detected - pass one with: ./install.sh --vault \"/path/to/Vault\""
  while true; do
    read -r -e -p "Path of your Obsidian vault: " p || die "no input"
    [ -n "$p" ] || { say "Please enter a path."; continue; }
    p="$(canon_path "$p")"
    if [ ! -d "$p" ]; then say "Not a directory: $p"; continue; fi
    VAULT="$p"; VAULT_REASON="entered manually"
    return
  done
}

choose_vault() {
  local n=${#VAULT_PATHS[@]} i reply
  say "Several Obsidian vaults were found:"
  for ((i = 0; i < n; i++)); do printf '  %d) %s\n' $((i + 1)) "${VAULT_PATHS[i]}"; done
  printf '  m) enter a path manually\n'
  while true; do
    read -r -p "Install into which vault? [1] " reply || die "no input"
    reply="${reply:-1}"
    case "$reply" in
      m|M) prompt_manual_vault; return ;;
      ''|*[!0-9]*) say "Enter a number from 1 to $n, or m." ;;
      *) if [ "$reply" -ge 1 ] && [ "$reply" -le "$n" ]; then
           VAULT="${VAULT_PATHS[reply - 1]}"; VAULT_REASON="chosen from the list"; return
         fi
         say "Enter a number from 1 to $n, or m." ;;
    esac
  done
}

select_vault() {
  local existing=""
  [ "$RESET" = 1 ] || existing="$(json_get "$CONFIG_FILE" vaultPath)"
  if [ -n "$VAULT_ARG" ]; then
    VAULT="$(canon_path "$VAULT_ARG")"
    [ -d "$VAULT" ] || die "vault path is not a directory: $VAULT"
    VAULT_REASON="given with --vault"
  elif [ -n "$existing" ] && [ -d "$existing" ]; then
    VAULT="$existing"; VAULT_REASON="kept from the existing installation (--vault PATH or --reset to change)"
  elif [ "${#VAULT_PATHS[@]}" -eq 1 ]; then
    VAULT="${VAULT_PATHS[0]}"; VAULT_REASON="the only vault Obsidian knows about"
  elif [ "${#VAULT_PATHS[@]}" -gt 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      VAULT="${VAULT_PATHS[0]}"
      VAULT_REASON="most recently used of ${#VAULT_PATHS[@]} vaults (a real run would ask you to choose)"
    elif interactive; then
      choose_vault
    else
      die "several vaults found and no terminal to ask on - pass one with: ./install.sh --vault \"/path/to/Vault\""
    fi
  else
    if [ "$DRY_RUN" = 1 ]; then VAULT=""; VAULT_REASON="no vault detected (a real run would ask for a path)"
    else prompt_manual_vault; fi
  fi
}

# ---- generated files -------------------------------------------------------------------------------------------

write_helper() { # $1 = destination path (already a temp file)
cat > "$1" <<'OA_HELPER_EOF'
#!/usr/bin/env python3
# obsidian-anywhere-managed: opener
#
# Obsidian Anywhere - Linux opener. Installed and updated by install.sh; do not edit.
#
# Invoked by the desktop entry with the file the user opened (%f). It
#   * accepts plain paths and file:// URIs,
#   * decides whether the file is inside the configured vault (open as-is) or outside (temporary link),
#   * creates/reuses ONLY a symlink <vault>/External/<name> -> original (never a copy, import, move or hard link),
#   * writes a uniquely named request record for the plugin (atomic rename),
#   * wakes/raises the configured vault through obsidian://open?vault=<id>.
# All user-specific values come from the generated configuration:
#   ${XDG_CONFIG_HOME:-$HOME/.config}/obsidian-anywhere/config.json

import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import time
import uuid
from urllib.parse import quote, unquote_to_bytes

VERSION = "1.0.0"
APP = "obsidian-anywhere"
EXTERNAL_DIR = "External"
LOG_MAX_BYTES = 1024 * 1024


class Fatal(Exception):
    pass


def home():
    return os.path.expanduser("~")


def xdg(var, *fallback):
    v = os.environ.get(var, "")
    return v if v and os.path.isabs(v) else os.path.join(home(), *fallback)


def config_path():
    o = os.environ.get("OBSIDIAN_ANYWHERE_CONFIG", "")
    if o and os.path.isabs(o):
        return o
    return os.path.join(xdg("XDG_CONFIG_HOME", ".config"), APP, "config.json")


class Log:
    """Quiet by default: errors and warnings only. Debug when config 'debug' is true."""

    def __init__(self):
        self.path = os.path.join(xdg("XDG_STATE_HOME", ".local", "state"), APP, APP + ".log")
        self.debug_on = os.environ.get("OBSIDIAN_ANYWHERE_DEBUG") == "1"

    def configure(self, cfg):
        p = cfg.get("logFile")
        if isinstance(p, str) and os.path.isabs(p):
            self.path = p
        if cfg.get("debug") is True:
            self.debug_on = True

    def _write(self, level, msg):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            try:
                if os.path.getsize(self.path) > LOG_MAX_BYTES:
                    os.replace(self.path, self.path + ".1")
            except OSError:
                pass
            with open(self.path, "a", encoding="utf-8", errors="replace") as f:
                f.write("%s [opener] %s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), level, msg))
        except OSError:
            pass

    def error(self, msg):
        sys.stderr.write("obsidian-anywhere: %s\n" % msg)
        self._write("ERROR", msg)

    def warn(self, msg):
        self._write("WARN", msg)

    def debug(self, msg):
        if self.debug_on:
            self._write("DEBUG", msg)


def notify(msg, icon):
    exe = shutil.which("notify-send")
    if not exe:
        return
    try:
        subprocess.run([exe, "-a", "Obsidian Anywhere", "-i", icon or "dialog-error", "Obsidian Anywhere", msg],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        pass


def load_config():
    global EXTERNAL_DIR
    path = config_path()
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        raise Fatal("not configured: %s not found (run install.sh)" % path)
    except (OSError, ValueError) as e:
        raise Fatal("cannot read %s: %s" % (path, e))
    if not isinstance(cfg, dict):
        raise Fatal("%s is not a JSON object" % path)
    vault = cfg.get("vaultPath")
    if not isinstance(vault, str) or not os.path.isabs(vault):
        raise Fatal("%s has no absolute vaultPath (run install.sh)" % path)
    if not os.path.isdir(vault):
        raise Fatal("vault folder does not exist: %s (run install.sh)" % vault)
    name = cfg.get("externalDir")      # optional: folder (directly inside the vault) that holds the links
    if isinstance(name, str) and name and name == name.strip() and not name.startswith(".") and not any(c in name for c in "/\\\0"):
        EXTERNAL_DIR = name
    plugin_dir = cfg.get("pluginDir")
    if not isinstance(plugin_dir, str) or not os.path.isabs(plugin_dir):
        plugin_dir = os.path.join(vault, ".obsidian", "plugins", APP)
    return cfg, vault, plugin_dir


def obsidian_config_files():
    return [
        os.path.join(xdg("XDG_CONFIG_HOME", ".config"), "obsidian", "obsidian.json"),
        os.path.join(home(), ".config", "obsidian", "obsidian.json"),
        os.path.join(home(), ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
        os.path.join(home(), "snap", "obsidian", "current", ".config", "obsidian", "obsidian.json"),
    ]


def find_vault_id(vault):
    """Vault id as registered by Obsidian, looked up by path (only used if the config has none)."""
    want = os.path.realpath(vault)
    for f in obsidian_config_files():
        try:
            with open(f, encoding="utf-8") as fh:
                vaults = json.load(fh).get("vaults")
        except (OSError, ValueError, AttributeError):
            continue
        if not isinstance(vaults, dict):
            continue
        for vid, info in vaults.items():
            p = info.get("path") if isinstance(info, dict) else None
            if isinstance(p, str) and os.path.realpath(p) == want:
                return vid
    return ""


def uri_to_path(uri):
    rest = uri[5:]  # after "file:"
    if rest.startswith("//"):
        host, _, tail = rest[2:].partition("/")
        if host not in ("", "localhost"):
            raise ValueError("file URI names a remote host: %s" % host)
        rest = "/" + tail
    return os.fsdecode(unquote_to_bytes(rest))


def normalize_arg(raw):
    """Plain path or file:// URI -> filesystem path. Never evaluates anything."""
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"" and not os.path.lexists(raw):
        raw = raw[1:-1]  # tolerate a launcher that passed its own quotes
    if raw.lower().startswith("file:/"):
        raw = uri_to_path(raw)
    if "\0" in raw:
        raise ValueError("path contains a NUL byte")
    return os.path.abspath(raw)


def link_names(name, real):
    """Collision-safe candidate names: plain name first, then name__<sha256(original path)[:8]>."""
    yield name
    digest = hashlib.sha256(os.fsencode(real)).hexdigest()
    for n in (8, 16, 32, 64):
        tag = digest[:n]
        if "." in name:
            base, ext = name.rsplit(".", 1)
            yield "%s__%s.%s" % (base, tag, ext)
        else:
            yield "%s__%s" % (name, tag)


def claim(link, real):
    """Create the link, or reuse it if it already points at this exact original. Never overwrites."""
    for _ in range(3):
        try:
            st = os.lstat(link)
        except FileNotFoundError:
            try:
                os.symlink(real, link)
                return "created"
            except FileExistsError:
                continue
        if stat.S_ISLNK(st.st_mode) and os.path.realpath(link) == real:
            try:
                if os.utime in os.supports_follow_symlinks:
                    os.utime(link, None, follow_symlinks=False)  # refresh mtime: "just (re)created by the opener"
            except OSError:
                pass
            return "reused"
        return "taken"  # different symlink, regular file, folder: not ours to touch
    return "taken"


def make_link(vault, name, real):
    ext = os.path.join(vault, EXTERNAL_DIR)
    if os.path.islink(ext):
        raise Fatal("%s is a symlink; refusing to create links through it" % ext)
    os.makedirs(ext, exist_ok=True)
    if not os.path.isdir(ext):
        raise Fatal("%s exists but is not a folder" % ext)
    for cand in link_names(name, real):
        link = os.path.join(ext, cand)
        result = claim(link, real)
        if result in ("created", "reused"):
            return link, result
    raise Fatal("could not find a free link name for %s" % name)


def write_request(req_dir, kind, rel, target, is_dir=False):
    os.makedirs(req_dir, exist_ok=True)
    now = int(time.time() * 1000)
    rid = "%013d-%d-%s" % (now, os.getpid(), uuid.uuid4().hex[:6])
    rec = {"id": rid, "vaultPath": rel, "kind": kind, "requestedAt": now, "helper": VERSION}
    if target:
        rec["target"] = target
    if is_dir:
        rec["dir"] = True
    tmp = os.path.join(req_dir, ".request-%s.tmp" % rid)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.rename(tmp, os.path.join(req_dir, "request-%s.json" % rid))
    return rid


def handle(raw, vault, plugin_dir, log):
    path = normalize_arg(raw)
    if not os.path.exists(path):
        raise Fatal("file does not exist: %s" % path)
    is_dir = os.path.isdir(path)
    if not is_dir and not os.path.isfile(path):
        raise Fatal("not a regular file or folder: %s" % path)
    real = os.path.realpath(path)
    try:
        os.fsencode(real).decode("utf-8")
    except UnicodeDecodeError:
        raise Fatal("file name is not valid UTF-8, Obsidian cannot open it: %r" % real)

    vreal = os.path.realpath(vault).rstrip(os.sep)
    if is_dir and (vreal == real or vreal.startswith(real.rstrip(os.sep) + os.sep)):
        raise Fatal("this folder contains the vault (or is the vault); linking it would create a loop: %s" % real)
    if real.startswith(vreal + os.sep):
        kind, rel, target = "internal", real[len(vreal) + 1:], None
        log.debug("internal %s: %s" % ("folder" if is_dir else "file", rel))
    else:
        link, how = make_link(vault, os.path.basename(real), real)
        kind, rel, target = "external", "%s/%s" % (EXTERNAL_DIR, os.path.basename(link)), real
        log.debug("external %s %s: link %s (%s)" % ("folder" if is_dir else "file", real, rel, how))

    rid = write_request(os.path.join(plugin_dir, "requests"), kind, rel, target, is_dir)
    log.debug("request %s kind=%s path=%s" % (rid, kind, rel))


def wake(cfg, vault, log):
    """Wake/raise the running Obsidian on the configured vault. Names no file to open."""
    vid = cfg.get("vaultId")
    if not isinstance(vid, str) or not vid:
        vid = find_vault_id(vault) or os.path.basename(os.path.realpath(vault))
    uri = "obsidian://open?vault=" + quote(vid, safe="")
    log.debug("uri=%s" % uri)

    opener = shutil.which("xdg-open")
    if opener:
        err = open(log.path, "a") if log.debug_on and os.path.isdir(os.path.dirname(log.path)) else subprocess.DEVNULL
        try:
            p = subprocess.Popen([opener, uri], stdin=subprocess.DEVNULL, stdout=err, stderr=err, start_new_session=True)
            try:
                rc = p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                log.debug("xdg-open still running after 15s; leaving it")
                return True
            if rc == 0:
                return True
            log.warn("xdg-open exited with status %s" % rc)
        except OSError as e:
            log.warn("xdg-open failed: %s" % e)

    exe = cfg.get("obsidianExec")
    if isinstance(exe, str) and exe.strip():
        try:
            subprocess.Popen(shlex.split(exe) + [uri], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            return True
        except (OSError, ValueError) as e:
            log.error("could not start Obsidian (%s): %s" % (exe, e))
    log.error("could not ask Obsidian to open the vault; request records are still queued for the plugin")
    return False


def check():
    ok = True

    def line(good, label, detail):
        nonlocal ok
        ok = ok and good
        print("%-4s %-16s %s" % ("OK" if good else "FAIL", label, detail))

    try:
        cfg, vault, plugin_dir = load_config()
    except Fatal as e:
        line(False, "config", str(e))
        return 1
    line(True, "config", config_path())
    line(True, "vault", vault)
    line(os.path.isdir(plugin_dir), "plugin folder", plugin_dir)
    line(os.access(vault, os.W_OK), "vault writable", vault)
    line(shutil.which("xdg-open") is not None or bool(cfg.get("obsidianExec")), "wake command", shutil.which("xdg-open") or str(cfg.get("obsidianExec") or "missing"))
    vid = cfg.get("vaultId") or find_vault_id(vault)
    line(True, "vault id", vid or "unknown (falls back to the vault folder name)")
    return 0 if ok else 1


def main(argv):
    args = argv[1:]
    if args[:1] == ["--version"]:
        print("obsidian-anywhere-open " + VERSION)
        return 0
    if args[:1] == ["--check"]:
        return check()
    if args[:1] in (["--help"], ["-h"]):
        print("usage: obsidian-anywhere-open [--check | --version] [--] [FILE-or-FOLDER-or-file-URI ...]")
        return 0
    if args[:1] == ["--"]:
        args = args[1:]

    log = Log()
    try:
        cfg, vault, plugin_dir = load_config()
    except Fatal as e:
        log.error(str(e))
        notify(str(e), None)
        return 2
    log.configure(cfg)
    icon = cfg.get("iconPath") if isinstance(cfg.get("iconPath"), str) else None

    if not os.path.isdir(plugin_dir):
        msg = "plugin folder missing: %s (run install.sh)" % plugin_dir
        log.error(msg)
        notify(msg, icon)
        return 2

    failed = 0
    for raw in args:
        try:
            handle(raw, vault, plugin_dir, log)
        except (Fatal, ValueError, OSError) as e:
            failed += 1
            log.error("%s: %s" % (raw, e))
            notify(str(e), icon)
    if len(args) == failed and args:
        return 1
    if not args:
        log.debug("no file argument: only waking the vault")
    wake(cfg, vault, log)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
OA_HELPER_EOF
}

write_desktop() { # $1 = destination (temp file); uses HELPER_FILE / ICON_FILE / DESKTOP_NAME
  OA_HELPER="$HELPER_FILE" OA_ICON="$ICON_FILE" python3 - "$1" <<'PY'
import os, sys

def exec_arg(p):
    # Desktop Entry spec: quote reserved characters; inside quotes escape " ` $ \ ; then double every backslash.
    if p and all(c.isalnum() or c in "/._-+" for c in p):
        return p
    out = []
    for c in p:
        if c == "\\":
            out.append("\\" * 4)
        elif c in '"`$':
            out.append("\\\\" + c)
        elif c == "%":
            out.append("%%")
        else:
            out.append(c)
    return '"' + "".join(out) + '"'

text = """[Desktop Entry]
Version=1.0
Type=Application
Name=Obsidian Anywhere
GenericName=Markdown opener
Comment=Open Markdown files and folders from anywhere in Obsidian through a temporary Vault link
Exec={exec_} %F
Icon={icon}
Terminal=false
StartupNotify=false
MimeType=text/markdown;text/x-markdown;inode/directory;
Categories=Utility;TextEditor;
X-Obsidian-Anywhere-Managed=true
""".format(exec_=exec_arg(os.environ["OA_HELPER"]), icon=os.environ["OA_ICON"])
with open(sys.argv[1], "w", encoding="utf-8") as f:
    f.write(text)
PY
}

write_config() { # merges into the existing config; $OA_* env carries the values
  python3 - "$CONFIG_FILE" "$RESET" <<'PY'
import json, os, sys, time
path, reset = sys.argv[1], sys.argv[2] == "1"
old, unreadable = {}, False
try:
    with open(path, encoding="utf-8") as f:
        old = json.load(f)
    if not isinstance(old, dict):
        old, unreadable = {}, True
except FileNotFoundError:
    pass
except (OSError, ValueError):
    unreadable = True
if unreadable:
    sys.stderr.write("existing config was unreadable and is regenerated\n")
now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
cfg = {}
if not reset:
    cfg.update(old)
prev = dict(old.get("previousMimeDefaults") or {}) if isinstance(old.get("previousMimeDefaults"), dict) else {}
for line in os.environ.get("OA_PREV", "").splitlines():
    mime, sep, val = line.partition("=")
    if sep and mime and mime not in prev:      # remember the FIRST non-ours default only
        prev[mime] = val
cfg.update({
    "schema": 1,
    "version": os.environ["OA_VERSION"],
    "vaultPath": os.environ["OA_VAULT"],
    "vaultId": os.environ.get("OA_VAULT_ID", ""),
    "pluginDir": os.environ["OA_PLUGIN_DIR"],
    "helperPath": os.environ["OA_HELPER"],
    "desktopFile": os.environ["OA_DESKTOP"],
    "iconPath": os.environ["OA_ICON"],
    "obsidianExec": os.environ.get("OA_OBS_EXEC", ""),
    "logFile": os.environ["OA_LOG"],
    "installedAt": old.get("installedAt") if isinstance(old.get("installedAt"), str) else now,
    "updatedAt": now,
    "previousMimeDefaults": prev,
})
if not isinstance(cfg.get("debug"), bool):
    cfg["debug"] = False
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".tmp-%d" % os.getpid()
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
PY
}

enable_plugin() { # add the plugin id to <vault>/.obsidian/community-plugins.json (merge, never drop others)
  python3 - "$VAULT/.obsidian/community-plugins.json" "$APP_ID" <<'PY'
import json, os, sys
path, pid = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    data = []
except (OSError, ValueError):
    sys.stderr.write("community-plugins.json is not valid JSON; left untouched\n")
    sys.exit(3)
if not isinstance(data, list):
    sys.stderr.write("community-plugins.json is not a list; left untouched\n")
    sys.exit(3)
if pid in data:
    print("already")
    sys.exit(0)
data.append(pid)
tmp = path + ".tmp-%d" % os.getpid()
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
print("added")
PY
}

install_file() { # src dst mode   (atomic: temp file in the destination folder, then rename)
  local src="$1" dst="$2" mode="$3" tmp
  tmp="$(dirname -- "$dst")/.$(basename -- "$dst").oa-tmp.$$"
  cp -f -- "$src" "$tmp" && chmod "$mode" "$tmp" && mv -f -- "$tmp" "$dst" || { rm -f -- "$tmp"; return 1; }
}

is_managed() { # file marker -> 0 if the file exists and carries our marker
  [ -f "$1" ] && grep -q -- "$2" "$1" 2>/dev/null
}

# ---- run: detect ---------------------------------------------------------------------------------------------------

detect_obsidian
detect_vaults
select_vault

PLUGIN_DIR=""
[ -n "$VAULT" ] && PLUGIN_DIR="$VAULT/.obsidian/plugins/$APP_ID"

VAULT_ID=""
[ -n "$VAULT" ] && VAULT_ID="$(python3 -c "$PY_VAULTS" lookup "$VAULT" 2>/dev/null | head -n 1)"

EXISTING=0; OLD_VERSION=""
if [ -n "$VAULT" ] && { [ -f "$CONFIG_FILE" ] || [ -f "$PLUGIN_DIR/manifest.json" ] || is_managed "$HELPER_FILE" "obsidian-anywhere-managed"; }; then
  EXISTING=1
  OLD_VERSION="$(json_get "$PLUGIN_DIR/manifest.json" version)"
fi

CUR_MIME=(); PREV_MIME_LINES=""
if [ "$HAVE_XDG_MIME" = 1 ]; then
  i=0
  for m in "${MIME_TYPES[@]}"; do
    CUR_MIME[i]="$(xdg-mime query default "$m" 2>/dev/null || true)"
    if [ "${CUR_MIME[i]}" != "$DESKTOP_NAME" ]; then PREV_MIME_LINES+="$m=${CUR_MIME[i]}"$'\n'; fi
    i=$((i + 1))
  done
fi

# ---- dry run ---------------------------------------------------------------------------------------------------------

if [ "$DRY_RUN" = 1 ]; then
  say "$APP_NAME $VERSION - DRY RUN (nothing will be changed)"
  say ""
  say "Obsidian:"
  if [ -n "$OBS_EXEC" ]; then info "$OBS_EXEC ($OBS_KIND)"; else info "not found"; fi
  info "obsidian:// handler: ${OBS_HANDLER:-none registered}"
  say "Vaults detected: ${#VAULT_PATHS[@]}"
  for p in "${VAULT_PATHS[@]+"${VAULT_PATHS[@]}"}"; do info "$p"; done
  say "Selected vault:"
  info "${VAULT:-none} - $VAULT_REASON"
  if [ -n "$VAULT" ]; then info "vault id: ${VAULT_ID:-not registered in Obsidian (looked up again at runtime)}"; fi
  if [ "$EXISTING" = 1 ]; then say "Existing installation: yes (version ${OLD_VERSION:-unknown}) - would upgrade/repair, user settings preserved"; else say "Existing installation: no"; fi
  say ""
  say "Would install / write:"
  if [ -n "$VAULT" ]; then
    info "plugin   $PLUGIN_DIR/{main.js,manifest.json,icon.png}"
    [ "$NO_ENABLE" = 1 ] || info "enable   add \"$APP_ID\" to $VAULT/.obsidian/community-plugins.json"
  fi
  info "opener   $HELPER_FILE"
  info "desktop  $DESKTOP_FILE"
  info "icon     $ICON_FILE"
  info "config   $CONFIG_FILE"
  info "log dir  $STATE_DIR"
  say ""
  say "MIME associations that would change:"
  if [ "$NO_MIME" = 1 ]; then info "none (--no-mime)"
  elif [ "$HAVE_XDG_MIME" != 1 ]; then info "none (xdg-mime not available)"
  else
    i=0
    for m in "${MIME_TYPES[@]}"; do
      if [ "${CUR_MIME[i]}" = "$DESKTOP_NAME" ]; then info "$m: already $DESKTOP_NAME"; else info "$m: ${CUR_MIME[i]:-(no default)} -> $DESKTOP_NAME"; fi
      i=$((i + 1))
    done
  fi
  exit 0
fi

# ---- install ---------------------------------------------------------------------------------------------------------------

[ -n "$VAULT" ] || die "no vault selected"

say "$APP_NAME $VERSION"
if [ "$EXISTING" = 1 ]; then
  say "Existing installation found (plugin ${OLD_VERSION:-unknown}): upgrading/repairing. Your settings and state are preserved."
fi
say "Vault: $VAULT ($VAULT_REASON)"
if [ -n "$OBS_EXEC" ]; then say "Obsidian: $OBS_EXEC ($OBS_KIND)"; else warn "Obsidian was not found on this system; installing anyway. Install Obsidian and open the vault once."; fi
if [ -z "$VAULT_ID" ]; then warn "this folder is not registered as a vault in Obsidian yet; open it once in Obsidian (Open folder as vault) and re-run ./install.sh"; fi

if [ ! -d "$VAULT/.obsidian" ]; then
  warn "$VAULT has no .obsidian folder (Obsidian has never opened it)"
  confirm "Create $VAULT/.obsidian/plugins and continue?" || die "aborted"
fi

ST_PLUGIN="FAILED"; ST_OPENER="FAILED"; ST_DESKTOP="FAILED"; ST_MIME="FAILED"; ST_CONFIG="FAILED"; ST_ENABLE="SKIPPED"

# 1. configuration (first, so uninstall can always restore the previous Markdown defaults)
mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$APP_DATA_DIR" "$BIN_HOME" "$APPS_DIR" || die "cannot create user directories"
if OA_PREV="$PREV_MIME_LINES" OA_VERSION="$VERSION" OA_VAULT="$VAULT" OA_VAULT_ID="$VAULT_ID" OA_PLUGIN_DIR="$PLUGIN_DIR" \
   OA_HELPER="$HELPER_FILE" OA_DESKTOP="$DESKTOP_FILE" OA_ICON="$ICON_FILE" OA_OBS_EXEC="$OBS_EXEC" OA_LOG="$LOG_FILE" write_config; then
  ST_CONFIG="OK"
else
  warn "could not write $CONFIG_FILE"
fi

# 2. plugin
if mkdir -p "$PLUGIN_DIR/requests"; then
  ST_PLUGIN="OK"
  for f in "${PLUGIN_FILES[@]}"; do
    if ! install_file "$SCRIPT_DIR/$f" "$PLUGIN_DIR/$f" 644 || ! cmp -s "$SCRIPT_DIR/$f" "$PLUGIN_DIR/$f"; then
      ST_PLUGIN="FAILED"; warn "could not install $f into $PLUGIN_DIR"
    fi
  done
else
  warn "cannot create $PLUGIN_DIR"
fi

# 3. enable in the vault
if [ "$NO_ENABLE" = 1 ]; then
  ST_ENABLE="SKIPPED"
elif [ "$ST_PLUGIN" = "OK" ]; then
  if res="$(enable_plugin)"; then ST_ENABLE="OK"; ENABLE_NOTE="$res"; else ST_ENABLE="FAILED"; warn "could not add $APP_ID to community-plugins.json - enable the plugin in Obsidian's settings instead"; fi
fi

# 4. opener
if [ -e "$HELPER_FILE" ] && ! is_managed "$HELPER_FILE" "obsidian-anywhere-managed"; then
  warn "$HELPER_FILE exists and was not created by $APP_NAME; not overwriting it"
else
  tmp="$BIN_HOME/.$HELPER_NAME.oa-tmp.$$"
  if write_helper "$tmp" && chmod 755 "$tmp" \
     && python3 -c 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$tmp" \
     && mv -f -- "$tmp" "$HELPER_FILE"; then
    ST_OPENER="OK"
  else
    rm -f -- "$tmp"; warn "could not install the opener at $HELPER_FILE"
  fi
fi

# 5. icon + desktop entry
if ! install_file "$SCRIPT_DIR/icon.png" "$ICON_FILE" 644; then warn "could not install the icon"; fi
if [ -e "$DESKTOP_FILE" ] && ! is_managed "$DESKTOP_FILE" "X-Obsidian-Anywhere-Managed"; then
  warn "$DESKTOP_FILE exists and was not created by $APP_NAME; not overwriting it"
else
  tmp="$APPS_DIR/.$DESKTOP_NAME.oa-tmp.$$"
  if write_desktop "$tmp" && chmod 644 "$tmp" && mv -f -- "$tmp" "$DESKTOP_FILE"; then
    ST_DESKTOP="OK"
    if command -v desktop-file-validate >/dev/null 2>&1 && ! desktop-file-validate "$DESKTOP_FILE" >/dev/null 2>&1; then
      warn "desktop-file-validate reported problems in $DESKTOP_FILE"
    fi
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  else
    rm -f -- "$tmp"; warn "could not write the desktop entry"
  fi
fi

# 6. Markdown association
if [ "$NO_MIME" = 1 ]; then
  ST_MIME="SKIPPED"
elif [ "$HAVE_XDG_MIME" != 1 ]; then
  ST_MIME="FAILED"
elif [ "$ST_DESKTOP" != "OK" ]; then
  ST_MIME="FAILED"; warn "Markdown association skipped because the desktop entry is not in place"
else
  if xdg-mime default "$DESKTOP_NAME" "${MIME_TYPES[@]}" >/dev/null 2>&1; then
    ST_MIME="OK"
    i=0
    for m in "${MIME_TYPES[@]}"; do
      got="$(xdg-mime query default "$m" 2>/dev/null || true)"
      [ "$got" = "$DESKTOP_NAME" ] || { ST_MIME="FAILED"; warn "$m is still handled by ${got:-nothing}"; }
      i=$((i + 1))
    done
  else
    warn "xdg-mime could not set the default application"
  fi
fi

# 7. validate the opener end to end (reads the generated configuration)
if [ "$ST_OPENER" = "OK" ] && [ "$ST_CONFIG" = "OK" ]; then
  if ! "$HELPER_FILE" --check >/dev/null 2>&1; then
    ST_OPENER="FAILED"; warn "the opener's self-check failed - run: $HELPER_FILE --check"
  fi
elif [ "$ST_OPENER" = "OK" ]; then
  ST_OPENER="FAILED"
fi

# ---- summary --------------------------------------------------------------------------------------------------------------------

BAD=0
for s in "$ST_PLUGIN" "$ST_OPENER" "$ST_DESKTOP" "$ST_CONFIG"; do [ "$s" = "OK" ] || BAD=1; done
[ "$ST_MIME" = "FAILED" ] && BAD=1
[ "$ST_ENABLE" = "FAILED" ] && BAD=1

say ""
if [ "$BAD" = 0 ]; then say "Installed successfully."; else say "Installation finished with problems."; fi
say ""
say "Vault:"
say "$VAULT"
say ""
say "Plugin:"
say "$ST_PLUGIN"
say ""
say "Opener:"
say "$ST_OPENER"
say ""
say "Desktop integration:"
say "$ST_DESKTOP"
say ""
say "Markdown association:"
say "$ST_MIME"
if [ "$ST_ENABLE" != "SKIPPED" ]; then
  say ""
  say "Plugin enabled in vault:"
  say "$ST_ENABLE"
fi
say ""
if [ "$BAD" = 0 ]; then
  say "Next:"
  say "Restart Obsidian (make sure Community plugins are turned on), then double-click any .md file outside the Vault."
  case ":$PATH:" in *":$BIN_HOME:"*) ;; *) say "(Note: $BIN_HOME is not on your PATH; the desktop entry uses the full path, so this is fine.)" ;; esac
  if pgrep -x -i obsidian >/dev/null 2>&1; then say "(Obsidian is currently running: restart it so it loads the plugin.)"; fi
  exit 0
fi
say "See the warnings above. Re-running ./install.sh is safe once the problem is fixed."
exit 1
