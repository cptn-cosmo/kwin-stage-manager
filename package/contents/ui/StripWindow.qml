// SPDX-License-Identifier: MIT
//
// The left-edge strip for one output.

import QtQuick
// Qualified on purpose: since KWin 6.8, org.kde.kwin exports its own
// (uncreatable) `Window` type, which shadows QtQuick's when imported later.
import QtQuick.Window as QQW
import org.kde.kwin
import "../code/stagemanager.mjs" as SM

QQW.Window {
    id: strip

    property var output
    property var manager
    property int revision
    property int stripWidth: 180
    property bool shown: true

    readonly property int pad: 14
    readonly property bool fullscreenBelow: {
        revision;
        return manager && output ? manager.hasFullscreen(String(output.name)) : false;
    }
    readonly property var stages: {
        revision;
        return manager && output ? manager.stripStages(String(output.name)) : [];
    }
    // Usable area of this output (panels excluded).
    readonly property rect area: {
        revision;
        if (!output)
            return Qt.rect(0, 0, 0, 0);
        try {
            return Workspace.clientArea(KWin.MaximizeArea, output, Workspace.currentDesktop);
        } catch (e) {
            return output.geometry;
        }
    }

    title: SM.STRIP_TITLE
    color: "transparent"
    // The window only covers the tiles, not the whole edge, so clicks on the
    // empty part of the strip area still reach the desktop.
    flags: Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus | Qt.Tool
    visible: shown && !fullscreenBelow && stages.length > 0 && area.width > 0

    width: stripWidth
    height: Math.min(area.height, column.implicitHeight + 2 * pad)
    x: area.x
    y: area.y + Math.max(0, (area.height - height) / 2)

    Column {
        id: column
        x: strip.pad
        y: strip.pad
        width: strip.width - 2 * strip.pad
        spacing: strip.pad

        Repeater {
            model: strip.stages
            delegate: StageTile {
                required property var modelData
                stage: modelData
                width: column.width
                aspect: strip.output ? strip.output.geometry.height / Math.max(1, strip.output.geometry.width) : 0.6
                onActivated: if (strip.manager) strip.manager.switchTo(stage.id)
                onMergeRequested: if (strip.manager) strip.manager.mergeIntoActive(stage.id)
            }
        }
    }
}
