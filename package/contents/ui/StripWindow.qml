// SPDX-License-Identifier: MIT
//
// The left-edge strip for one output.
//
// The window spans the strip column (full height of the usable area). While a
// window of the shown stage covers that column, the strip slides away and the
// window shrinks to a 2 px handle; hovering the handle peeks the strip back
// in. While a thumbnail is dragged the window temporarily covers the whole
// output, so the drag can reach the drop zone over the current stage.

import QtQuick
// Qualified on purpose: since KWin 6.8, org.kde.kwin exports its own
// (uncreatable) `Window` type, which shadows QtQuick's when imported later.
import QtQuick.Window as QQW
import org.kde.kwin
import org.kde.kirigami as Kirigami
import "../code/stagemanager.mjs" as SM

QQW.Window {
    id: strip

    property var output
    property var manager
    property int revision
    // Bumped on window moves/resizes; only the overlap check depends on it.
    property int geomRevision
    property int stripWidth: 180
    property bool shown: true

    readonly property int pad: 14
    readonly property int handleWidth: 2
    readonly property int duration: 260

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
    readonly property bool overlapped: {
        revision;
        geomRevision;
        return manager && output ? manager.stripOverlapped(String(output.name), area.x, area.x + stripWidth) : false;
    }

    // --- show / hide -------------------------------------------------------
    property bool peeking: false
    readonly property bool hasContent: shown && !fullscreenBelow && stages.length > 0
    readonly property bool revealed: hasContent && (!overlapped || peeking || dragging)
    // 0 = slid out, 1 = fully in. Everything visual follows this.
    property real reveal: revealed ? 1 : 0
    Behavior on reveal { NumberAnimation { duration: strip.duration; easing.type: Easing.OutCubic } }

    onOverlappedChanged: if (!overlapped) peeking = false

    Timer {
        id: unpeek
        interval: 350
        onTriggered: if (!hover.hovered && !strip.dragging) strip.peeking = false
    }

    title: SM.STRIP_TITLE
    color: "transparent"
    // No Qt.Tool: it contains the Qt.Popup bit, which makes KWin treat the
    // strip as a popup that grabs focus and is dismissed by the next click
    // elsewhere. Without it KWin reports popupWindow false, wantsInput false,
    // and still keeps the strip in the overlay layer (checked on 6.8.2).
    // BypassWindowManagerHint keeps KWin's placement from centering the strip
    // on screen (KWin's own OSD uses it the same way).
    flags: Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus | Qt.BypassWindowManagerHint
    readonly property bool wanted: hasContent || reveal > 0.001
    visible: wanted
    // If anything outside QML hides the window (KWin or the QPA), Qt replaces
    // our binding with a plain false and the strip never returns. Put it back.
    onVisibleChanged: {
        if (!visible && wanted)
            Qt.callLater(() => {
                strip.visible = Qt.binding(() => strip.wanted);
            });
    }

    x: area.x
    y: area.y
    height: area.height
    width: dragging ? area.width : (reveal > 0.001 || !overlapped ? stripWidth : handleWidth)

    // --- stage list, kept in a ListModel so the view can animate changes ----
    property var stageById: ({})
    ListModel { id: stageModel }

    onStagesChanged: syncModel()
    Component.onCompleted: syncModel()

    function syncModel() {
        const map = {};
        const ids = [];
        for (const s of stages) {
            map[s.id] = s;
            ids.push(s.id);
        }
        stageById = map;
        for (let i = stageModel.count - 1; i >= 0; i--)
            if (ids.indexOf(stageModel.get(i).sid) < 0)
                stageModel.remove(i);
        for (let i = 0; i < ids.length; i++) {
            let j = -1;
            for (let k = i; k < stageModel.count; k++)
                if (stageModel.get(k).sid === ids[i]) {
                    j = k;
                    break;
                }
            if (j < 0)
                stageModel.insert(i, { sid: ids[i] });
            else if (j !== i)
                stageModel.move(j, i, 1);
        }
    }

    // --- dragging a stage onto the current one ------------------------------
    property bool dragging: false
    property var dragStage: null
    property point dragPos
    readonly property bool dropActive: dragging && dragPos.x > stripWidth
    readonly property real tileWidth: stripWidth - 2 * pad
    readonly property real aspect: output ? output.geometry.height / Math.max(1, output.geometry.width) : 0.6

    function beginDrag(stage, pos) {
        dragStage = stage;
        dragPos = pos;
        dragging = true;
    }
    function endDrag(pos) {
        const stage = dragStage;
        const drop = pos.x > stripWidth;
        dragging = false;
        dragStage = null;
        if (drop && stage && manager)
            manager.mergeIntoActive(stage.id);
    }

    Item {
        id: root
        anchors.fill: parent

        HoverHandler {
            id: hover
            onHoveredChanged: {
                if (hovered && strip.overlapped)
                    strip.peeking = true;
                else if (!hovered)
                    unpeek.restart();
            }
        }

        Item {
            id: content
            width: strip.stripWidth
            height: parent.height
            x: -(1 - strip.reveal) * (strip.stripWidth + 10)
            opacity: strip.reveal

            ListView {
                id: list
                x: strip.pad
                width: strip.tileWidth
                height: Math.min(contentHeight, parent.height - 2 * strip.pad)
                anchors.verticalCenter: parent.verticalCenter
                interactive: false
                spacing: strip.pad
                model: stageModel

                delegate: StageTile {
                    required property int sid
                    width: list.width
                    aspect: strip.aspect
                    current: strip.stageById[sid]
                    beingDragged: strip.dragging && strip.dragStage && strip.dragStage.id === sid
                    onActivated: if (strip.manager) strip.manager.switchTo(sid)
                    onDragStarted: pos => strip.beginDrag(stage, pos)
                    onDragMoved: pos => strip.dragPos = pos
                    onDragFinished: pos => strip.endDrag(pos)
                }

                // A stage you leave flies in from the screen; a stage you pick
                // flies out toward it, roughly like macOS.
                add: Transition {
                    ParallelAnimation {
                        NumberAnimation { property: "opacity"; from: 0; to: 1; duration: strip.duration }
                        NumberAnimation { property: "scale"; from: 1.35; to: 1; duration: strip.duration + 60; easing.type: Easing.OutCubic }
                        NumberAnimation { property: "x"; from: strip.stripWidth; to: 0; duration: strip.duration + 60; easing.type: Easing.OutCubic }
                    }
                }
                remove: Transition {
                    ParallelAnimation {
                        NumberAnimation { property: "opacity"; to: 0; duration: strip.duration }
                        NumberAnimation { property: "scale"; to: 1.35; duration: strip.duration; easing.type: Easing.InCubic }
                        NumberAnimation { property: "x"; to: strip.stripWidth; duration: strip.duration; easing.type: Easing.InCubic }
                    }
                }
                displaced: Transition {
                    NumberAnimation { properties: "x,y"; duration: strip.duration; easing.type: Easing.OutCubic }
                    // in case an add/remove animation was interrupted
                    NumberAnimation { properties: "opacity,scale"; to: 1; duration: strip.duration }
                }
                move: Transition {
                    NumberAnimation { properties: "x,y"; duration: strip.duration; easing.type: Easing.OutCubic }
                }
            }
        }

        // Drop target over the current stage while dragging.
        Rectangle {
            visible: strip.dragging
            x: strip.stripWidth + 24
            y: 24
            width: parent.width - x - 24
            height: parent.height - 48
            radius: 18
            color: Qt.alpha(Kirigami.Theme.highlightColor, strip.dropActive ? 0.22 : 0.08)
            border.width: 2
            border.color: Qt.alpha(Kirigami.Theme.highlightColor, strip.dropActive ? 0.9 : 0.35)
            Behavior on color { ColorAnimation { duration: 120 } }

            Text {
                anchors.centerIn: parent
                text: strip.dropActive ? "Release to add to this stage" : "Drag here to add to this stage"
                color: "white"
                style: Text.Outline
                styleColor: Qt.alpha("black", 0.5)
                font.pixelSize: 18
            }
        }

        // The thumbnail under the pointer.
        Item {
            id: ghost
            visible: strip.dragging
            width: strip.tileWidth
            height: Math.round(width * strip.aspect)
            x: strip.dragPos.x - width / 2
            y: strip.dragPos.y - height / 2
            scale: strip.dropActive ? 1.25 : 1
            Behavior on scale { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }

            WindowThumbnail {
                anchors.fill: parent
                client: strip.dragStage && strip.dragStage.windows.length ? strip.dragStage.windows[0] : null
            }
        }
    }
}
