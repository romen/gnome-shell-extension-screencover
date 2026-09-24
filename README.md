# Screen Cover

A GNOME Shell extension to **black out** or **freeze** individual
monitors, without turning them off.

Turning a monitor off is not always an option: with daisy-chained
DisplayPort (MST) setups, powering down one screen can disrupt the
others. Screen Cover keeps every output enabled and instead draws an
overlay on the screens you choose:

- **Black** covers the screen with solid black.
- **Freeze** captures what the screen currently shows and keeps
  displaying that image, while everything underneath keeps running
  normally.

Your other screens stay fully usable, and keyboard focus is never taken away.

## Features

- Top-bar menu listing every connected output, identified by name,
  connector and vendor/model
- Per-screen **Black** and **Freeze** toggles
- Connector names shown as on-screen labels while the menu is open, so
  you can tell the screens apart
- Optional **Keep top bar visible** mode, so the menu stays reachable on
  a covered primary screen
- Double-click a covered screen to uncover it
- D-Bus interface for scripts and keyboard shortcuts

## Requirements

- GNOME Shell 48 (tested). The extension uses the module format
  introduced in GNOME 45 and will not run on older versions.
- Tested on Wayland. X11 sessions (GNOME 48 and older) are untested:
  covers should work, but the menu may grey out outputs whose X11 names
  differ from the kernel's connector names.

## Installation

### From a release

Download the `.shell-extension.zip` from the [releases page](https://github.com/romen/gnome-shell-extension-screencover/releases), then:

```sh
gnome-extensions install screencover@romen.dev.shell-extension.zip
```

Log out and back in (GNOME on Wayland only discovers new extensions at login), then enable it:

```sh
gnome-extensions enable screencover@romen.dev
```

### From source

```sh
git clone https://github.com/romen/gnome-shell-extension-screencover.git
cd gnome-shell-extension-screencover
gnome-extensions pack . --extra-source=LICENSE --force
gnome-extensions install --force screencover@romen.dev.shell-extension.zip
```

Then log out, log back in, and enable it as above.

## Usage

Click the monitor icon in the top bar. The menu shows one row per
connected output, with a **Black** and a **Freeze** button.
While the menu is open, each screen displays its connector name (e.g.
`DP-2`) as a label.

- Clicking a button again uncovers the screen. Switching directly
  between Black and Freeze also works.
- **Clear all** removes every cover at once.
- **Keep top bar visible** places covers underneath the top bar instead
  of over it.
  With this off (the default), covering the primary screen also hides
  the top bar and the extension's icon.
  The setting is remembered across sessions.
- **Double-click** any covered screen to uncover it.
  This is the quickest way back when the top bar is hidden.

Outputs that the kernel reports as connected but GNOME is not using are
shown greyed out.

### Behaviour while a screen is covered

- The mouse pointer is still visible when moved onto a covered screen.
- Clicks on a covered screen are blocked, so hidden windows cannot be
  clicked by accident.
- Keyboard input is unaffected; you keep working on your other screens
  as usual.
- If the monitor layout changes (a monitor is plugged in or removed, or
  the resolution changes), all covers are removed.

## D-Bus interface

All actions are available on the session bus, which makes them easy to
bind to keyboard shortcuts.

| | |
|---|---|
| Bus name | `org.gnome.Shell` |
| Object path | `/dev/romen/ScreenCover` |
| Interface | `dev.romen.ScreenCover` |

| Method | Arguments | Effect |
|---|---|---|
| `Black` | `s connector` | Black out a screen |
| `Freeze` | `s connector` | Freeze a screen |
| `Toggle` | `s mode`, `s connector` | Toggle `black` or `freeze` on a screen |
| `Clear` | `s connector` | Uncover a screen |
| `ClearAll` | | Uncover all screens |
| `SetKeepTopBar` | `b keep` | Set the "Keep top bar visible" option |

Examples:

```sh
# Toggle freeze on DP-2
gdbus call --session --dest org.gnome.Shell --object-path /dev/romen/ScreenCover \
  --method dev.romen.ScreenCover.Toggle freeze DP-2

# Uncover everything
gdbus call --session --dest org.gnome.Shell --object-path /dev/romen/ScreenCover \
  --method dev.romen.ScreenCover.ClearAll
```

### Keyboard shortcuts

In **Settings → Keyboard → Keyboard Shortcuts → Custom Shortcuts**, add
a shortcut with one of the commands above. Shortcuts keep working while
screens are covered, so a `ClearAll` shortcut makes a reliable "undo
everything" key.

### Finding connector names

Connector names are shown in the menu and as on-screen labels while the
menu is open. From a terminal, list the connected outputs with:

```sh
for p in /sys/class/drm/card*-*; do
  [ "$(cat "$p/status")" = connected ] && { n=${p##*/}; echo "${n#card*-}"; }
done
```

## Configuration

Settings are stored in `~/.config/screencover@romen.dev/config.json`.
Currently the only option is `keepTopBar`, which is set from the menu or
via D-Bus.

## Development

GNOME Shell on Wayland cannot reload extension code in a running
session: after editing `extension.js`, changes only take effect after
logging out and back in.

To follow the extension's log messages:

```sh
journalctl --user -f -o cat | grep -i screencover
```

The extension relies on a few GNOME Shell internals (the stage
screenshot API and the monitor labeler used by the Displays settings
panel).
These have been stable across releases, but they are the first things to
check when adding support for a new GNOME version.

## License

Licensed under the [Apache License 2.0](LICENSE).
