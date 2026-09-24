// SPDX-FileCopyrightText: 2026 Nicola Tuveri <nicola@romen.dev>
// SPDX-License-Identifier: Apache-2.0

import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

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
  </interface>
</node>`;

export default class ScreenCoverExtension extends Extension {
    enable() {
        this._covers = new Map();
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/dev/romen/ScreenCover');
        // Monitor layout changed -> geometry is stale, drop all covers
        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this.ClearAll());
    }

    disable() {
        this.ClearAll();
        Main.layoutManager.disconnect(this._monitorsId);
        this._dbus.unexport();
        this._dbus = null;
        this._covers = null;
    }

    _monitor(connector) {
        const idx = global.backend.get_monitor_manager()
            .get_monitor_for_connector(connector);
        if (idx < 0)
            throw new Error(`No monitor with connector ${connector}`);
        return Main.layoutManager.monitors[idx];
    }

    _makeCover(connector, mon) {
        const cover = new St.Widget({
            style: 'background-color: black;',
            reactive: true,            // swallow clicks on this monitor
            clip_to_allocation: true,
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
        });
        Main.layoutManager.addTopChrome(cover, {affectsInputRegion: true});
        this._covers.set(connector, cover);
        return cover;
    }

    Black(connector) {
        const mon = this._monitor(connector);
        this.Clear(connector);
        this._makeCover(connector, mon);
    }

    Freeze(connector) {
        const mon = this._monitor(connector);  // throw early for bad names
        this._freeze(connector, mon).catch(e => logError(e, 'ScreenCover'));
    }

    async _freeze(connector, mon) {
        this.Clear(connector);
        // Grab the whole stage as a GPU texture (no file, no portal)
        const shooter = new Shell.Screenshot();
        const [content] = await shooter.screenshot_stage_to_content();
        if (!this._covers) return;  // disabled while we waited

        const cover = this._makeCover(connector, mon);
        // Show the full-stage image, offset so only this monitor's part is visible
        cover.add_child(new Clutter.Actor({
            content,
            x: -mon.x, y: -mon.y,
            width: global.stage.width, height: global.stage.height,
        }));
    }

    Toggle(mode, connector) {
        if (this._covers.has(connector))
            this.Clear(connector);
        else if (mode === 'freeze')
            this.Freeze(connector);
        else
            this.Black(connector);
    }

    Clear(connector) {
        const cover = this._covers.get(connector);
        if (!cover) return;
        Main.layoutManager.removeChrome(cover);
        cover.destroy();
        this._covers.delete(connector);
    }

    ClearAll() {
        for (const c of [...this._covers.keys()])
            this.Clear(c);
    }
}
