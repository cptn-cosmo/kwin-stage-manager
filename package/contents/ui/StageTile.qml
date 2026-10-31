// SPDX-License-Identifier: MIT
//
// One stage in the strip: up to three stacked live thumbnails plus the app
// icon. Click to switch. Dragging is handled by the strip (StripWindow.qml);
// the tile only reports where the pointer is.

import QtQuick
import org.kde.kwin
import org.kde.kirigami as Kirigami

Item {
    id: tile

    // Latest view data for this stage, or undefined once it left the strip.
    property var current
    // What we draw. Keeps the last known stage so the tile can still be seen
    // while its remove transition plays.
    property var stage
    property real aspect: 0.6
    property bool beingDragged: false

    signal activated
    signal dragStarted(point scenePos)
    signal dragMoved(point scenePos)
    signal dragFinished(point scenePos)

    onCurrentChanged: if (current) stage = current

    height: Math.round(width * aspect) + 12
    opacity: beingDragged ? 0.35 : 1
    Behavior on opacity { NumberAnimation { duration: 150 } }

    Item {
        id: visual
        width: tile.width
        height: tile.height
        scale: mouse.containsMouse && !tile.beingDragged ? 1.06 : 1
        Behavior on scale { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }

        Repeater {
            // windows[0] is the stage's most recent window: drawn on top.
            model: tile.stage ? tile.stage.windows : []
            delegate: WindowThumbnail {
                required property var modelData
                required property int index
                client: modelData
                z: -index
                x: index * 6
                y: index * 6
                width: visual.width - 12
                height: visual.height - 12
                opacity: 1 - index * 0.2
            }
        }

        Kirigami.Icon {
            source: tile.stage && tile.stage.windows.length ? tile.stage.windows[0].icon : ""
            width: Kirigami.Units.iconSizes.medium
            height: width
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            anchors.leftMargin: -4
            anchors.bottomMargin: -4
            z: 10
        }

        Rectangle {
            visible: tile.stage && tile.stage.count > 1
            z: 10
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            width: Math.max(height, countLabel.implicitWidth + 8)
            height: countLabel.implicitHeight + 4
            radius: height / 2
            color: Kirigami.Theme.highlightColor
            Text {
                id: countLabel
                anchors.centerIn: parent
                text: tile.stage ? tile.stage.count : ""
                color: Kirigami.Theme.highlightedTextColor
                font.pixelSize: 11
            }
        }
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.LeftButton
        preventStealing: true

        readonly property real threshold: 8
        property point pressPos
        property bool dragging: false

        onPressed: m => {
            pressPos = Qt.point(m.x, m.y);
            dragging = false;
        }
        onPositionChanged: m => {
            if (!pressed)
                return;
            const scene = tile.mapToItem(null, m.x, m.y);
            if (!dragging && Math.hypot(m.x - pressPos.x, m.y - pressPos.y) > threshold) {
                dragging = true;
                tile.dragStarted(scene);
            }
            if (dragging)
                tile.dragMoved(scene);
        }
        onReleased: m => {
            if (dragging) {
                dragging = false;
                tile.dragFinished(tile.mapToItem(null, m.x, m.y));
            } else {
                tile.activated();
            }
        }
        onCanceled: {
            if (dragging) {
                dragging = false;
                tile.dragFinished(Qt.point(-1, -1));
            }
        }
    }
}
