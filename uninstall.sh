#!/usr/bin/env bash
# Obsidian Anywhere - uninstaller.
#
# Removes ONLY what this project installed: the plugin files, the opener, the desktop entry, the
# Markdown association it created and its own configuration/log. It never deletes original Markdown
# files, normal vault files, other plugins, or any symlink the plugin was not tracking.

set -u

APP_ID="obsidian-anywhere"
APP_NAME="Obsidian Anywhere"
HELPER_NAME="obsidian-anywhere-open"
DESKTOP_NAME="obsidian-anywhere.desktop"
MIME_TYPES=("text/markdown" "text/x-markdown")

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
$APP_NAME uninstaller

Usage: ./uninstall.sh [options]

  --dry-run       Show what would be removed. Makes NO changes.
  --yes, -y       Do not ask for confirmation.
  --keep-config   Keep ~/.config/$APP_ID and the plugin's settings (data.json).
  --vault PATH    Also clean this vault (repeatable). The vault from the installation is always included.
  --help, -h      Show this help.

Best run while Obsidian is closed.
EOF
}

DRY_RUN=0; ASSUME_YES=0; KEEP_CONFIG=0; EXTRA_VAULTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --keep-config) KEEP_CONFIG=1; shift ;;
    --vault) [ $# -ge 2 ] || die "--vault needs a path"; EXTRA_VAULTS+=("$2"); shift 2 ;;
    --vault=*) EXTRA_VAULTS+=("${1#--vault=}"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

[ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to an existing directory"
[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not as root"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

xdg_dir() { case "${1:-}" in /*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac; }
CONFIG_HOME="$(xdg_dir "${XDG_CONFIG_HOME:-}" "$HOME/.config")"
DATA_HOME="$(xdg_dir "${XDG_DATA_HOME:-}" "$HOME/.local/share")"
STATE_HOME="$(xdg_dir "${XDG_STATE_HOME:-}" "$HOME/.local/state")"
BIN_HOME="$(xdg_dir "${XDG_BIN_HOME:-}" "$HOME/.local/bin")"

CONFIG_DIR="$CONFIG_HOME/$APP_ID"
CONFIG_FILE="$CONFIG_DIR/config.json"

json_get() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
try:
    v = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2], "")
except Exception:
    v = ""
print(v if isinstance(v, str) else "")
PY
}

canon_path() { python3 -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$1"; }

abs_or() { case "${1:-}" in /*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac; }

# Locations: use what the installation recorded, else the standard ones.
HELPER_FILE="$(abs_or "$(json_get "$CONFIG_FILE" helperPath)" "$BIN_HOME/$HELPER_NAME")"
DESKTOP_FILE="$(abs_or "$(json_get "$CONFIG_FILE" desktopFile)" "$DATA_HOME/applications/$DESKTOP_NAME")"
ICON_FILE="$(abs_or "$(json_get "$CONFIG_FILE" iconPath)" "$DATA_HOME/$APP_ID/icon.png")"
LOG_FILE="$(abs_or "$(json_get "$CONFIG_FILE" logFile)" "$STATE_HOME/$APP_ID/$APP_ID.log")"
APPS_DIR="$(dirname -- "$DESKTOP_FILE")"

VAULTS=()
add_vault() {
  local v="$1" x
  [ -n "$v" ] || return
  v="$(canon_path "$v")"
  for x in "${VAULTS[@]+"${VAULTS[@]}"}"; do [ "$x" = "$v" ] && return; done
  VAULTS+=("$v")
}
add_vault "$(json_get "$CONFIG_FILE" vaultPath)"
json_list() { # FILE KEY -> one string per line (list of strings)
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
try:
    v = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2], [])
except Exception:
    v = []
for x in (v if isinstance(v, list) else []):
    if isinstance(x, str) and x and "\n" not in x:
        print(x)
PY
}
while IFS= read -r v; do add_vault "$v"; done < <(json_list "$CONFIG_FILE" knownVaults)   # vaults chosen in the plugin settings
EXT_DIR="$(json_get "$CONFIG_FILE" externalDir)"
case "$EXT_DIR" in ""|*/*|.*|*[[:space:]]) EXT_DIR=External ;; esac
for v in "${EXTRA_VAULTS[@]+"${EXTRA_VAULTS[@]}"}"; do add_vault "$v"; done

is_managed() { [ -f "$1" ] && grep -q -- "$2" "$1" 2>/dev/null; }

desktop_exists() { # NAME -> 0 if some applications dir has it
  local d IFS=':'
  for d in "$DATA_HOME" ${XDG_DATA_DIRS:-/usr/local/share:/usr/share} "$DATA_HOME/flatpak/exports/share" /var/lib/flatpak/exports/share; do
    [ -f "$d/applications/$1" ] && return 0
  done
  return 1
}

prev_default() { # mime -> previously recorded default desktop file (may be empty)
  python3 - "$CONFIG_FILE" "$1" <<'PY' 2>/dev/null
import json, sys
try:
    p = json.load(open(sys.argv[1], encoding="utf-8")).get("previousMimeDefaults", {})
    v = p.get(sys.argv[2], "") if isinstance(p, dict) else ""
except Exception:
    v = ""
print(v if isinstance(v, str) else "")
PY
}

# ---- plan ----------------------------------------------------------------------------------------------------

say "$APP_NAME uninstall$([ "$DRY_RUN" = 1 ] && printf ' - DRY RUN (nothing will be changed)')"
say ""
say "This will remove (only files created by $APP_NAME):"
for v in "${VAULTS[@]+"${VAULTS[@]}"}"; do info "plugin files and tracked temporary links in: $v"; done
[ "${#VAULTS[@]}" -gt 0 ] || info "(no vault recorded; use --vault PATH to clean one)"
info "opener:         $HELPER_FILE"
info "desktop entry:  $DESKTOP_FILE"
info "icon:           $ICON_FILE"
info "Markdown association (only where it points to $DESKTOP_NAME)"
if [ "$KEEP_CONFIG" = 1 ]; then info "configuration and plugin settings: KEPT (--keep-config)"; else info "configuration:  $CONFIG_DIR   log: $LOG_FILE"; fi
say "Original Markdown files, normal vault files and other plugins are never touched."
say ""

if pgrep -x -i obsidian >/dev/null 2>&1; then warn "Obsidian is running. Close it first for a clean result (the plugin may re-create state while it runs)."; fi

if [ "$DRY_RUN" != 1 ] && [ "$ASSUME_YES" != 1 ]; then
  [ -t 0 ] || die "no terminal to confirm on - pass --yes"
  read -r -p "Continue? [y/N] " r || exit 1
  case "$r" in y|Y|yes|YES) ;; *) say "Cancelled."; exit 0 ;; esac
fi

FAILED=0
run_rm() { # path : remove a single file (dry-run aware)
  if [ "$DRY_RUN" = 1 ]; then info "would remove $1"; else rm -f -- "$1" && info "removed $1" || { warn "could not remove $1"; FAILED=1; }; fi
}
run_rmdir() { # remove a directory only if empty
  [ -d "$1" ] || return 0
  if [ "$DRY_RUN" = 1 ]; then info "would remove folder $1 if empty"; else rmdir -- "$1" 2>/dev/null && info "removed empty folder $1" || true; fi
}

# ---- vaults: tracked links, request records, plugin files, activation ----------------------------------------

clean_vault() { python3 - "$1" "$DRY_RUN" "$KEEP_CONFIG" "$EXT_DIR" <<'PY'
import json, os, sys

APP = "obsidian-anywhere"
vault, dry, keep, EXT = sys.argv[1], sys.argv[2] == "1", sys.argv[3] == "1", sys.argv[4]
pdir = os.path.join(vault, ".obsidian", "plugins", APP)
out = lambda m: print("  " + m)
would = "would " if dry else ""

def rm(path, what):
    if dry:
        out("would remove " + what)
        return
    try:
        os.unlink(path)
        out("removed " + what)
    except FileNotFoundError:
        pass
    except OSError as e:
        out("could not remove %s: %s" % (what, e))

def rmdir(path):
    if not os.path.isdir(path) or os.path.islink(path):
        return
    if dry:
        out("would remove folder %s if empty" % path)
        return
    try:
        os.rmdir(path)
        out("removed empty folder " + path)
    except OSError:
        pass

if not os.path.isdir(vault):
    out("vault folder not found, skipped: " + vault)
    sys.exit(0)

manifest = os.path.join(pdir, "manifest.json")
if os.path.isfile(manifest):
    try:
        mid = json.load(open(manifest, encoding="utf-8")).get("id")
    except (OSError, ValueError):
        mid = None
    if mid != APP:
        out("plugin folder does not belong to %s (manifest id %r); left untouched: %s" % (APP, mid, pdir))
        sys.exit(0)

# 1. temporary links: ONLY those the plugin recorded, and only if they still point at the recorded original
data_path = os.path.join(pdir, "data.json")
data = {}
try:
    with open(data_path, encoding="utf-8") as f:
        data = json.load(f)
except (OSError, ValueError):
    data = {}
links = data.get("links") if isinstance(data, dict) and isinstance(data.get("links"), dict) else {}
ext = os.path.join(vault, EXT)
if links and os.path.islink(ext):
    out(EXT + "/ is a symlink; tracked links skipped")
    links = {}
removed_links = 0
for rel, target in sorted(links.items()):
    parts = rel.split("/") if isinstance(rel, str) else []
    if len(parts) != 2 or parts[0] != EXT or parts[1] in ("", ".", "..") or "\0" in rel or not isinstance(target, str):
        out("ignored invalid tracked path: %r" % (rel,))
        continue
    p = os.path.join(ext, parts[1])
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        continue
    if not (st.st_mode & 0o170000) == 0o120000:
        out("kept %s (not a symlink)" % rel)
        continue
    actual = os.path.normpath(os.path.join(os.path.dirname(p), os.readlink(p)))
    if actual != os.path.normpath(target):
        out("kept %s (now points elsewhere: %s)" % (rel, actual))
        continue
    if dry:
        out("would remove tracked link %s (original stays: %s)" % (rel, target))
    else:
        try:
            os.unlink(p)
            out("removed tracked link %s (original untouched: %s)" % (rel, target))
        except OSError as e:
            out("could not remove %s: %s" % (rel, e))
            continue
    removed_links += 1

# 2. pending request records (ours only)
rdir = os.path.join(pdir, "requests")
if os.path.isdir(rdir) and not os.path.islink(rdir):
    for name in sorted(os.listdir(rdir)):
        p = os.path.join(rdir, name)
        if (name.startswith("request-") and name.endswith(".json")) or (name.startswith(".request-") and name.endswith(".tmp")):
            if os.path.isfile(p) and not os.path.islink(p):
                # A link the opener made for a request that Obsidian never picked up (so it was never
                # tracked): remove it too, but only if it still points at the recorded original.
                try:
                    with open(p, encoding="utf-8") as f:
                        rec = json.load(f)
                    rrel, rtarget = rec.get("vaultPath"), rec.get("target")
                    rparts = rrel.split("/") if isinstance(rrel, str) else []
                    if (rec.get("kind") == "external" and isinstance(rtarget, str) and len(rparts) == 2
                            and rparts[0] == EXT and rparts[1] not in ("", ".", "..")
                            and "\0" not in rrel and not os.path.islink(ext) and rrel not in links):
                        lp = os.path.join(ext, rparts[1])
                        if os.path.islink(lp) and os.path.normpath(os.path.join(ext, os.readlink(lp))) == os.path.normpath(rtarget):
                            if dry:
                                out("would remove untracked opener link %s (original stays: %s)" % (rrel, rtarget))
                            else:
                                os.unlink(lp)
                                out("removed untracked opener link %s (original untouched: %s)" % (rrel, rtarget))
                except (OSError, ValueError, AttributeError):
                    pass
                rm(p, "request record " + name)
    rmdir(rdir)

# 3. plugin files
for name in ("main.js", "manifest.json", "icon.png"):
    p = os.path.join(pdir, name)
    if os.path.isfile(p) and not os.path.islink(p):
        rm(p, "plugin file " + name)
if os.path.isfile(data_path):
    if keep:
        out("kept plugin settings (data.json)")
        if not dry and links:
            data["links"] = {}
            tmp = data_path + ".tmp-%d" % os.getpid()
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, data_path)
    else:
        rm(data_path, "plugin settings data.json")
rmdir(pdir)
if os.path.isdir(pdir) and not dry:
    left = sorted(os.listdir(pdir))
    if left:
        out("plugin folder still contains other files, left in place: " + ", ".join(left))

# 4. deactivate: drop only our id from community-plugins.json
cp = os.path.join(vault, ".obsidian", "community-plugins.json")
try:
    with open(cp, encoding="utf-8") as f:
        ids = json.load(f)
except (OSError, ValueError):
    ids = None
if isinstance(ids, list) and APP in ids:
    if dry:
        out("would remove %s from community-plugins.json" % APP)
    else:
        rest = [i for i in ids if i != APP]
        tmp = cp + ".tmp-%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rest, f, indent=2)
            f.write("\n")
        os.replace(tmp, cp)
        out("removed %s from community-plugins.json" % APP)

# 5. External/ only if it is empty
if os.path.isdir(ext) and not os.path.islink(ext):
    rmdir(ext)
PY
}

for v in "${VAULTS[@]+"${VAULTS[@]}"}"; do
  say "Vault: $v"
  clean_vault "$v" || FAILED=1
done

# ---- Markdown association --------------------------------------------------------------------------------------

restore_mime() {
  local m cur prev i=0 CURS=()
  if command -v xdg-mime >/dev/null 2>&1; then
    for m in "${MIME_TYPES[@]}"; do CURS[i]="$(xdg-mime query default "$m" 2>/dev/null || true)"; i=$((i + 1)); done
  fi

  # Remove our entry from mimeapps.list (only our own desktop file name; everything else is preserved).
  python3 - "$DESKTOP_NAME" "$DRY_RUN" "$CONFIG_HOME/mimeapps.list" "$DATA_HOME/applications/mimeapps.list" "${MIME_TYPES[@]}" <<'PY'
import os, sys
name, dry, *rest = sys.argv[1:]
dry = dry == "1"
files = [p for p in rest if p.endswith("mimeapps.list")]
mimes = [m for m in rest if "/" in m and not m.endswith("mimeapps.list")]
for path in files:
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().split("\n")
    except OSError:
        continue
    section, out, changed = "", [], False
    for line in lines:
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            section = s
        elif "=" in line and section in ("[Default Applications]", "[Added Associations]"):
            key, _, val = line.partition("=")
            if key.strip() in mimes:
                toks = [t for t in val.split(";") if t]
                if name in toks:
                    toks = [t for t in toks if t != name]
                    changed = True
                    if toks:
                        out.append("%s=%s;" % (key, ";".join(toks)))
                    continue
        out.append(line)
    if changed:
        if dry:
            print("  would remove %s entries from %s" % (name, path))
        else:
            tmp = path + ".tmp-%d" % os.getpid()
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(out))
            try:
                os.chmod(tmp, os.stat(path).st_mode & 0o777)
            except OSError:
                pass
            os.replace(tmp, path)
            print("  removed %s entries from %s" % (name, path))
PY

  # Give back the application that handled Markdown before, if we replaced it and it still exists.
  if [ "$DRY_RUN" != 1 ] && command -v xdg-mime >/dev/null 2>&1; then
    i=0
    for m in "${MIME_TYPES[@]}"; do
      if [ "${CURS[i]:-}" = "$DESKTOP_NAME" ]; then
        prev="$(prev_default "$m")"
        if [ -n "$prev" ] && [ "$prev" != "$DESKTOP_NAME" ] && desktop_exists "$prev"; then
          if xdg-mime default "$prev" "$m" >/dev/null 2>&1; then info "restored $m -> $prev"; else warn "could not restore $m -> $prev"; fi
        else
          info "$m: no previous default to restore (system default applies)"
        fi
      fi
      i=$((i + 1))
    done
  elif [ "$DRY_RUN" = 1 ]; then
    i=0
    for m in "${MIME_TYPES[@]}"; do
      if [ "${CURS[i]:-}" = "$DESKTOP_NAME" ]; then
        prev="$(prev_default "$m")"
        info "would restore $m -> ${prev:-(system default)}"
      fi
      i=$((i + 1))
    done
  fi
}

say "Markdown association:"
restore_mime

# ---- opener, desktop entry, icon, configuration, logs ----------------------------------------------------------------

say "System integration:"
if [ -e "$DESKTOP_FILE" ]; then
  if is_managed "$DESKTOP_FILE" "X-Obsidian-Anywhere-Managed"; then run_rm "$DESKTOP_FILE"; else info "kept $DESKTOP_FILE (not created by $APP_NAME)"; fi
fi
if [ -e "$HELPER_FILE" ]; then
  if is_managed "$HELPER_FILE" "obsidian-anywhere-managed"; then run_rm "$HELPER_FILE"; else info "kept $HELPER_FILE (not created by $APP_NAME)"; fi
fi
if [ -f "$ICON_FILE" ] || [ -L "$ICON_FILE" ]; then run_rm "$ICON_FILE"; fi
run_rmdir "$(dirname -- "$ICON_FILE")"
if [ "$DRY_RUN" != 1 ]; then command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true; fi

if [ "$KEEP_CONFIG" != 1 ]; then
  [ -f "$CONFIG_FILE" ] && run_rm "$CONFIG_FILE"
  run_rmdir "$CONFIG_DIR"
  [ -f "$LOG_FILE" ] && run_rm "$LOG_FILE"
  [ -f "$LOG_FILE.1" ] && run_rm "$LOG_FILE.1"
  run_rmdir "$(dirname -- "$LOG_FILE")"
fi

say ""
if [ "$DRY_RUN" = 1 ]; then say "Dry run finished. Nothing was changed."; exit 0; fi
if [ "$FAILED" = 0 ]; then say "Uninstalled."; else say "Uninstalled with problems - see the messages above."; fi
exit "$FAILED"
