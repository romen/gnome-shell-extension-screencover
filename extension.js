// SPDX-FileCopyrightText: 2026 Nicola Tuveri <nicola@romen.dev>
// SPDX-License-Identifier: Apache-2.0

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DBUS_PATH = '/dev/romen/ScreenCover';

const IFACE = `
<node>
  <interface name="dev.romen.ScreenCover">
    <method name="Black"><arg type="s" direction="in" name="connector"/></method>
    <method name="Freeze"><arg type="s" direction="in" name="connector"/></method>
    <method name="Toggle">
      <arg type="s" direction="in" name="mode"/>
      <arg type="s" direction="in" name="connector"/>
    </method>
    <method name="Clear"><arg type="s" direction="in" name="connector"/></method>
    <method name="ClearAll"/>
    <method name="SetKeepTopBar"><arg type="b" direction="in" name="keep"/></method>
  </interface>
</node>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Connector names (e.g. "DP-2") that the kernel reports as connected. */
function connectedOutputs() {
    const names = new Set();
    const decoder = new TextDecoder();
    const children = Gio.File.new_for_path('/sys/class/drm').enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null);

    let info;
    while ((info = children.next_file(null)) !== null) {
        const entry = info.get_name();
        const match = entry.match(/^card\d+-(.+)$/);
        if (!match)
            continue;
        try {
            const [, bytes] = GLib.file_get_contents(`/sys/class/drm/${entry}/status`);
            if (decoder.decode(bytes).trim() === 'connected')
                names.add(match[1]);
        } catch (e) {
            // No status file for this entry; skip it
        }
    }
    children.close(null);

    return [...names].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
}

/**
 * Vendor/product info per connector, from Mutter's DisplayConfig D-Bus API.
 * Must be async: Mutter runs in this same process, a sync call would deadlock.
 */
function mutterMonitors() {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig',
            'GetCurrentState',
            null, null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [, monitors] = conn.call_finish(res).recursiveUnpack();
                    const map = new Map();
                    for (const [[connector, vendor, product], , props] of monitors) {
                        map.set(connector, {
                            vendor,
                            product,
                            name: props['display-name'] || `${vendor} ${product}`,
                        });
                    }
                    resolve(map);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/** Capture the whole stage (all monitors) as a GPU texture. */
function captureStage() {
    const shooter = new Shell.Screenshot();
    return new Promise((resolve, reject) => {
        shooter.screenshot_stage_to_content((obj, res) => {
            try {
                const [content] = obj.screenshot_stage_to_content_finish(res);
                resolve(content);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function wait(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/** St.BoxLayout switched from `vertical` to `orientation` in GNOME 48. */
function makeVertical(box) {
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
}

/** Path of the config file: ~/.config/<uuid>/config.json */
function configPath(uuid) {
    return GLib.build_filenamev([GLib.get_user_config_dir(), uuid, 'config.json']);
}

function loadConfig(uuid) {
    try {
        const [, bytes] = GLib.file_get_contents(configPath(uuid));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return {};
    }
}

function saveConfig(uuid, config) {
    try {
        const path = configPath(uuid);
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, JSON.stringify(config, null, 2));
    } catch (e) {
        logError(e, 'ScreenCover: saving config');
    }
}

// ---------------------------------------------------------------------------
// Top-bar indicator
// ---------------------------------------------------------------------------

const Indicator = GObject.registerClass(
class ScreenCoverIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Screen Cover');
        this._ext = ext;
        this._rows = new Map();
        this._destroyed = false;
        this.connect('destroy', () => {
            this._destroyed = true;
        });

        this.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        }));

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._keepBarItem = new PopupMenu.PopupSwitchMenuItem(
            'Keep top bar visible', this._ext.keepTopBar);
        this._keepBarItem.connect('toggled',
            (_item, state) => this._ext.setKeepTopBar(state));
        this.menu.addMenuItem(this._keepBarItem);
        this.menu.addAction('Clear all', () => this._ext.ClearAll());

        // Rebuild the list every time the menu opens
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.refresh().catch(e => logError(e, 'ScreenCover'));
        });
    }

    async refresh() {
        const connected = connectedOutputs();
        let details = new Map();
        try {
            details = await mutterMonitors();
        } catch (e) {
            logError(e, 'ScreenCover: GetCurrentState failed');
        }
        if (this._destroyed)
            return;

        this._section.removeAll();
        this._rows.clear();

        if (connected.length === 0) {
            this._section.addMenuItem(new PopupMenu.PopupMenuItem(
                'No connected outputs found', {reactive: false}));
            return;
        }
        for (const connector of connected)
            this._section.addMenuItem(this._makeRow(connector, details.get(connector)));
        this.sync();
        this.syncOptions();
    }

    _makeRow(connector, detail) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});

        const text = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        makeVertical(text);
        text.add_child(new St.Label({text: detail?.name ?? 'Unknown monitor'}));
        text.add_child(new St.Label({
            text: detail
                ? `${connector} · ${detail.vendor} ${detail.product}`
                : `${connector} · not active in GNOME`,
            style: 'font-size: 0.85em;',
        }));
        item.add_child(text);

        // Outputs Mutter doesn't know about can't be covered
        const usable = Boolean(detail);
        const makeButton = (label, mode) => {
            const button = new St.Button({
                label,
                style_class: 'button',
                style: 'margin-left: 6px;',
                toggle_mode: true,
                can_focus: usable,
                reactive: usable,
                opacity: usable ? 255 : 110,
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', () => this._ext.toggleFromMenu(mode, connector));
            return button;
        };

        const black = makeButton('Black', 'black');
        const freeze = makeButton('Freeze', 'freeze');
        item.add_child(black);
        item.add_child(freeze);
        this._rows.set(connector, {black, freeze});
        return item;
    }

    /** Make the toggle buttons reflect the actual cover state. */
    sync() {
        for (const [connector, {black, freeze}] of this._rows) {
            const mode = this._ext.modeOf(connector);
            black.checked = mode === 'black';
            freeze.checked = mode === 'freeze';
        }
    }

    /** Make the option switches reflect the current config. */
    syncOptions() {
        this._keepBarItem.setToggleState(this._ext.keepTopBar);
    }
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default class ScreenCoverExtension extends Extension {
    enable() {
        this._covers = new Map(); // connector -> {actor, mode}
        // Must be loaded before the indicator is created
        this._config = {keepTopBar: false, ...loadConfig(this.uuid)};

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, DBUS_PATH);

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Monitor layout changed -> geometry is stale, drop all covers
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this.ClearAll();
            if (this._indicator.menu.isOpen)
                this._indicator.refresh().catch(e => logError(e, 'ScreenCover'));
        });
    }

    disable() {
        Main.layoutManager.disconnect(this._monitorsId);
        this.ClearAll();
        this._indicator.destroy();
        this._indicator = null;
        this._dbus.unexport();
        this._dbus = null;
        this._covers = null;
        this._config = null;
    }

    // ----- State -----

    modeOf(connector) {
        return this._covers?.get(connector)?.mode ?? null;
    }

    get keepTopBar() {
        return Boolean(this._config?.keepTopBar);
    }

    setKeepTopBar(keep) {
        this._config.keepTopBar = Boolean(keep);
        saveConfig(this.uuid, this._config);
        for (const {actor} of this._covers.values())
            this._restack(actor);
        this._indicator?.syncOptions();
    }

    // ----- Covers -----

    _monitor(connector) {
        const idx = global.backend.get_monitor_manager()
            .get_monitor_for_connector(connector);
        if (idx < 0)
            throw new Error(`No monitor with connector ${connector}`);
        return Main.layoutManager.monitors[idx];
    }

    /** Place a cover above or below the top bar, per the keepTopBar option. */
    _restack(actor) {
        const group = Main.layoutManager.uiGroup;
        if (this.keepTopBar)
            group.set_child_below_sibling(actor, Main.layoutManager.panelBox);
        else
            group.set_child_below_sibling(actor, global.top_window_group);
    }

    _addCover(connector, mode, mon) {
        const actor = new St.Widget({
            style: 'background-color: black;',
            reactive: true, // swallow clicks on this monitor
            clip_to_allocation: true,
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
        });
        // Escape hatch: double-click a covered screen to uncover it
        actor.connect('button-press-event', (_actor, event) => {
            if (event.get_click_count() === 2)
                this.Clear(connector);
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.addTopChrome(actor, {affectsInputRegion: true});
        this._restack(actor);
        this._covers.set(connector, {actor, mode});
        this._indicator?.sync();
        return actor;
    }

    async _freeze(connector, mon, delayMs) {
        const hadCover = this._covers.has(connector);
        this.Clear(connector);
        // Give the stage time to repaint without the menu / old cover
        const delay = Math.max(delayMs, hadCover ? 100 : 0);
        if (delay)
            await wait(delay);

        const content = await captureStage();
        if (!this._covers)
            return; // disabled while waiting

        this.Clear(connector);
        const actor = this._addCover(connector, 'freeze', mon);
        // Full-stage image, offset so only this monitor's part is visible
        actor.add_child(new Clutter.Actor({
            content,
            x: -mon.x, y: -mon.y,
            width: global.stage.width, height: global.stage.height,
        }));
    }

    toggleFromMenu(mode, connector) {
        try {
            if (mode === 'freeze' && this.modeOf(connector) !== 'freeze') {
                const mon = this._monitor(connector);
                // The menu is on the primary monitor: close it first so it
                // doesn't end up in the frozen image
                let delay = 0;
                if (mon.index === Main.layoutManager.primaryIndex) {
                    this._indicator.menu.close();
                    delay = 300;
                }
                this._freeze(connector, mon, delay).catch(e => logError(e, 'ScreenCover'));
            } else {
                this.Toggle(mode, connector);
            }
        } catch (e) {
            logError(e, 'ScreenCover');
        }
        this._indicator?.sync();
    }

    // ----- D-Bus methods -----

    Black(connector) {
        const mon = this._monitor(connector);
        this.Clear(connector);
        this._addCover(connector, 'black', mon);
    }

    Freeze(connector) {
        const mon = this._monitor(connector); // throws early for bad names
        this._freeze(connector, mon, 0).catch(e => logError(e, 'ScreenCover'));
    }

    Toggle(mode, connector) {
        if (this.modeOf(connector) === mode)
            this.Clear(connector);
        else if (mode === 'freeze')
            this.Freeze(connector);
        else
            this.Black(connector);
    }

    Clear(connector) {
        const cover = this._covers?.get(connector);
        if (!cover)
            return;
        Main.layoutManager.removeChrome(cover.actor);
        cover.actor.destroy();
        this._covers.delete(connector);
        this._indicator?.sync();
    }

    ClearAll() {
        if (!this._covers)
            return;
        for (const connector of [...this._covers.keys()])
            this.Clear(connector);
    }

    SetKeepTopBar(keep) {
        this.setKeepTopBar(keep);
    }
}
