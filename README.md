<p align="center"><img src="icon.png" alt="Obsidian Anywhere" width="128"></p>

# Obsidian AnyWhere

Open Markdown files and folders from **anywhere** on your disk in [Obsidian](https://obsidian.md/), without **moving** or **copying** them.

**Linux only.** Windows and macOS are not supported.


## Features

- Open one or many external Markdown files from a file manager or terminal.
- Open complete external folders through a single temporary symlink.
- Focus an already-open file instead of creating a duplicate tab.
- Edit and save external files directly from Obsidian.
- Create files and subfolders inside linked folders.
- Rename linked files and folders.
- Detect external file/folder changes and reflect them in Obsidian.
- Delete linked items using the normal Obsidian Trash setting.
- Automatically clean up plugin-owned temporary links.
- Handle same-name collisions safely.
- Provide diagnostics, repair, refresh and orphan-cleanup commands.
- No `sudo` and no copying/importing of external content.

## How it works

Obsidian normally opens content inside a vault. Obsidian Anywhere creates a temporary symlink inside the vault:

1. Select an external file or folder and choose **Open With → Obsidian Anywhere**.
2. The opener creates a link under `<Vault>/External/`.
3. Obsidian Anywhere opens the requested file or reveals the linked folder.
4. Changes made through Obsidian affect the original external content.
5. Temporary links are removed when they are no longer needed or during cleanup.

A folder is represented by **one root symlink**; its children are never copied or individually linked.

## Requirements

- Linux with XDG desktop/MIME support
- [Obsidian 1.7.2 or newer](https://obsidian.md/) with Community plugins enabled
- `bash`
- `python3` 3.7+
- `xdg-open` and `xdg-mime` (`xdg-utils`)

The installer refuses to run as root and installs everything in user-local XDG locations.

## Install

```bash
git clone https://github.com/hadiyarloo/ObsidianAnyWhere.git
cd ObsidianAnyWhere
./install.sh
```

Optional dry run:

```bash
./install.sh --dry-run
```

Restart Obsidian after installation and ensure **Settings → Community plugins** is enabled.

### Installer options

| Option | Description |
|---|---|
| `--vault PATH` | Install into a specific vault |
| `--dry-run` | Show changes without applying them |
| `--reset` | Ignore the previously selected vault |
| `--yes`, `-y` | Automatically confirm prompts |
| `--no-mime` | Keep the existing Markdown default application |
| `--no-enable` | Do not enable the plugin automatically |

Running the installer again upgrades or repairs the existing installation while preserving configuration.

## Usage

### Files

Double-click an external `.md` file, or select several files and choose **Open With → Obsidian Anywhere**.

Each file gets its own request and tab. Already-open files are focused rather than duplicated.

### Folders

Choose **Open With → Obsidian Anywhere** on a folder.

The folder appears under:

```text
<Vault>/External/<folder-name>
```

Nested folders are supported to arbitrary depth. A folder containing the vault, or the vault itself, is refused to prevent recursive links.

### Terminal

```bash
~/.local/bin/obsidian-anywhere-open a.md b.md c.md
~/.local/bin/obsidian-anywhere-open ~/Projects/MyProject
~/.local/bin/obsidian-anywhere-open --check
```

## Working inside a linked folder

A linked folder is the original external folder accessed through one root symlink.

Supported operations from Obsidian:

- open, edit and save files
- create files and subfolders
- rename child files and folders
- delete files and folders
- work with deeply nested content

Changes are applied to the original external filesystem.

### Delete

Deletion follows Obsidian's normal **Deleted files** setting:

- Obsidian `.trash`
- system Trash
- permanent deletion

For nested items, Obsidian's normal deletion flow operates through the link.

For a linked root, the plugin applies the same selected Trash policy to the real original and then removes the temporary link. Cross-filesystem moves use a verified copy-then-remove operation when a direct move is impossible.

There is no separate delete policy.

### Rename

Renaming a linked root from inside Obsidian also renames the original and updates the link when the operation is unambiguous and safe.

Child file and folder renames are propagated to the original content.

### External changes

Changes made by a file manager, terminal, Git, synchronization tool or another application are detected periodically and reflected in Obsidian.

External changes include:

- file creation
- folder creation
- file deletion
- folder deletion
- file rename
- folder rename

*External Files: Refresh Linked Folders* performs an immediate refresh.

## Settings and commands

The plugin settings provide:

- selected vault
- external directory
- installation status
- opener and desktop integration status
- MIME association status
- tab-close cleanup
- shutdown cleanup
- startup restoration
- configurable cleanup grace period
- debug logging
- setup check
- installation repair
- diagnostics

The **Selected vault** and **External directory** can be changed with **Browse** and **Apply**.

Command palette commands include:

- External Files: Refresh Linked Folders
- External Files: Cleanup Orphaned Links
- External Files: Repair Tracked Links
- External Files: Show Tracked Links
- External Files: Show Pending Requests
- External Files: Diagnostics

Diagnostics show tracked links as `OPEN`, `CLOSED`, `BROKEN`, `PENDING` or `RETARGETED`.

## Safety

- Normal cleanup removes only symlinks created and tracked by the plugin.
- Removing a symlink never deletes its target.
- Delete operations initiated inside Obsidian follow the configured Obsidian deletion policy.
- Root deletion is handled separately to avoid deleting or trashing the symlink itself.
- Original files and folders are never overwritten during rename operations.
- Existing targets and ambiguous rename situations are refused.
- Repointed or untracked symlinks are not treated as plugin-owned links.
- Request records are validated before external paths are opened.
- The plugin never follows an unrelated symlink as its tracked original.

## What gets installed

| Location | Purpose |
|---|---|
| `<Vault>/.obsidian/plugins/obsidian-anywhere/` | Obsidian plugin |
| `~/.local/bin/obsidian-anywhere-open` | External opener |
| `~/.local/share/applications/obsidian-anywhere.desktop` | Desktop integration |
| `~/.local/share/obsidian-anywhere/icon.png` | Project icon |
| `~/.config/obsidian-anywhere/config.json` | Configuration |
| `~/.local/state/obsidian-anywhere/` | Logs |

The desktop entry supports Markdown files and folders. It does not become the default file manager for directories.

## Compatibility

- **Platform:** Linux desktop environments with XDG desktop/MIME support.
- **Obsidian:** 1.7.2+; verified by the author with Obsidian 1.13.7.
- **Sandboxed Obsidian:** Flatpak/Snap may restrict access to external paths.
- **Large folders:** folders containing more than 20,000 entries are not automatically watched.
- **Nested symlinks:** not followed.
- External changes are normally reflected after approximately 2–4 seconds.
- Some file-explorer refresh operations use Obsidian APIs that are not formally documented and may change in future releases.

## Known limitations

- Linux only.
- Renaming a linked root from outside Obsidian is not propagated back to the original.
- An external folder rename is represented as a delete/create change, so tabs opened inside that folder may need to be reopened.
- Cross-filesystem Trash operations require copying and verification before removing the original.
- Extended attributes, hard links and ownership are not preserved by cross-filesystem copy operations.
- Special filesystem objects such as sockets and device files are refused.
- Sandboxed Obsidian installations may require additional filesystem permissions.
- After an Obsidian crash, orphaned links can be cleaned on the next startup or with *Cleanup Orphaned Links*.

## Uninstall

```bash
./uninstall.sh --dry-run
./uninstall.sh
```

Options:

```text
--yes
--keep-config
--vault PATH
```

The uninstaller removes only resources created by Obsidian Anywhere, including its tracked links, plugin files, opener, desktop entry, icon, configuration and log.

It also removes only the plugin's own entries from `community-plugins.json` and `mimeapps.list`, restoring the previous Markdown default when possible.

Your Markdown files, vault content and other plugins are not removed.

## Troubleshooting

Check the installation:

```bash
~/.local/bin/obsidian-anywhere-open --check
```

View the log:

```bash
cat "${XDG_STATE_HOME:-$HOME/.local/state}/obsidian-anywhere/obsidian-anywhere.log"
```

Check the Markdown default application:

```bash
xdg-mime query default text/markdown
```

For detailed plugin state, use **External Files: Diagnostics** from the command palette.

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

This is an independent community project and is not affiliated with, endorsed by, or associated with Obsidian.md or Dynalist Inc.