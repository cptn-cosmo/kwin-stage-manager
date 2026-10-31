// SPDX-License-Identifier: MIT
//
// Stage Manager for KWin 6 (Wayland). Entry point of the declarative script.
// All stage logic lives in ../code/stagemanager.mjs; this file reads config,
// registers shortcuts and creates one strip window per output.

import QtQuick
import QtCore
import org.kde.kwin
import "../code/stagemanager.mjs" as SM

Item {
    id: root

    property var manager: null
    property var detach: null
    // Bumped whenever the model changes; strip bindings depend on it.
    property int revision: 0
    // Bumped on window geometry changes (strip overlap only).
    property int geomRevision: 0
    property bool stripVisible: cfg.stripVisible
    readonly property bool persistGroups: String(KWin.readConfig("PersistGroups", false)) === "true"

    readonly property var cfg: SM.normalizeConfig({
        StripWidth: KWin.readConfig("StripWidth", 180),
        MaxVisibleStages: KWin.readConfig("MaxVisibleStages", 6),
        HidingStrategy: KWin.readConfig("HidingStrategy", 0),
        AutoSwitchOnFocus: KWin.readConfig("AutoSwitchOnFocus", true),
        MaximizedPolicy: KWin.readConfig("MaximizedPolicy", 0),
        KeepWindowsClear: KWin.readConfig("KeepWindowsClear", true),
        GroupByClass: KWin.readConfig("GroupByClass", true),
        ShowStripOnStart: KWin.readConfig("ShowStripOnStart", true),
    })

    // Cross-session memory of which window classes were grouped together.
    // KWin scripts can read their config but not write it, so this goes to a
    // file of our own via QtCore.Settings (needs Qt >= 6.5 for `location`).
    Settings {
        id: store
        location: StandardPaths.writableLocation(StandardPaths.GenericConfigLocation) + "/kwin-stagemanagerrc"
        category: "Groups"
        property string affinity: "{}"
    }

    function loadAffinity() {
        if (!persistGroups)
            return null;
        try {
            return JSON.parse(store.affinity);
        } catch (e) {
            return null;
        }
    }

    function saveAffinity() {
        if (!persistGroups || !manager)
            return;
        store.affinity = JSON.stringify(manager.exportAffinity());
        store.sync();
    }

    Component.onCompleted: {
        const platform = SM.createKWinPlatform({
            workspace: Workspace,
            kwin: KWin,
            rect: Qt.rect,
            defer: fn => Qt.callLater(fn),
            log: msg => console.info(msg),
        });
        const sm = new SM.StageManager(platform, cfg, loadAffinity());
        sm.onChanged(what => {
            if (what === "geometry") {
                root.geomRevision++;
                return;
            }
            root.revision++;
            if (what === "affinity")
                root.saveAffinity();
        });
        detach = SM.attachToWorkspace(sm, Workspace);
        manager = sm;
        sm.start();
        console.info("[stagemanager] started, strategy:", cfg.strategy, "stages:", sm.stages.size);
    }

    // UNCERTAIN: relies on KWin destroying the QML root when the script is
    // unloaded (disabling it in System Settings, kpackagetool6 -r, or a
    // KWin restart). Verified for unloadScript over D-Bus; a KWin crash skips
    // this, which is why the hidden-desktop strategy cleans up on start.
    Component.onDestruction: {
        if (detach)
            detach();
        if (manager)
            manager.shutdown();
    }

    // registerShortcut() exists only for imperative JS scripts; declarative
    // scripts get the ShortcutHandler type instead. Both register a global
    // shortcut under "KWin" in System Settings > Shortcuts.
    ShortcutHandler {
        name: "Stage Manager: Add Window to Previous Stage"
        text: "Stage Manager: Add active window to previous stage"
        sequence: "Meta+Alt+G"
        onActivated: if (root.manager) root.manager.addActiveToPrevious()
    }
    ShortcutHandler {
        name: "Stage Manager: Remove Window from Stage"
        text: "Stage Manager: Move active window to its own stage"
        sequence: "Meta+Alt+U"
        onActivated: if (root.manager) root.manager.splitActive()
    }
    ShortcutHandler {
        name: "Stage Manager: Previous Stage"
        text: "Stage Manager: Switch to previous stage"
        sequence: "Meta+Alt+Tab"
        onActivated: if (root.manager) root.manager.switchToPrevious(Workspace.activeScreen ? Workspace.activeScreen.name : "")
    }
    ShortcutHandler {
        name: "Stage Manager: Toggle Strip"
        text: "Stage Manager: Show/hide the stage strip"
        sequence: "Meta+Alt+S"
        onActivated: {
            root.stripVisible = !root.stripVisible;
            if (root.manager)
                root.manager.setStripVisible(root.stripVisible);
        }
    }

    Instantiator {
        model: Workspace.screens
        delegate: StripWindow {
            required property var modelData
            output: modelData
            manager: root.manager
            revision: root.revision
            geomRevision: root.geomRevision
            stripWidth: root.cfg.stripWidth
            shown: root.stripVisible
        }
    }
}
