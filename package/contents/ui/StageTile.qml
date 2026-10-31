// SPDX-License-Identifier: MIT
//
// One stage in the strip: up to three stacked live thumbnails plus the app
// icon. Click to switch; drag to the right to merge into the current stage.

import QtQuick
import org.kde.kwin
import org.kde.kirigami as Kirigami

Item {
    id: tile

    property var stage
    property real aspect: 0.6
    signal activated
    signal mergeRequested

    // How far (fraction of width) a drag must go before release merges.
    // Kept small so the pointer never has to leave the strip window: whether
    // KWin keeps delivering motion to an internal window after the pointer
    // leaves it during a press isn't something we want to depend on.
    readonly property real mergeThreshold: 0.35
    readonly property bool willMerge: visual.x > width * mergeThreshold

    height: Math.round(width * aspect) + 12

    Item {
        id: visual
        width: tile.width
        height: tile.height
        scale: mouse.containsMouse && !mouse.drag.active ? 1.05 : 1
        Behavior on scale { NumberAnimation { duration: 120 } }
        Behavior on x {
            enabled: !mouse.drag.active
            NumberAnimation { duration: 150; easing.type: Easing.OutCubic }
        }

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

        Rectangle {
            anchors.fill: parent
            z: 20
            radius: 6
            color: "transparent"
            border.width: 2
            border.color: Kirigami.Theme.highlightColor
            visible: tile.willMerge
        }
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.LeftButton
        drag.target: visual
        drag.axis: Drag.XAxis
        drag.minimumX: 0
        drag.maximumX: tile.width
        drag.filterChildren: true

        property bool dragged: false
        onPressed: dragged = false
        onPositionChanged: if (drag.active) dragged = true
        onReleased: {
            const merge = tile.willMerge;
            visual.x = 0;
            if (merge)
                tile.mergeRequested();
            else if (!dragged)
                tile.activated();
        }
    }
}
