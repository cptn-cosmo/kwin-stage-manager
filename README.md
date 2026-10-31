# Stage Manager for KWin 6

A macOS-style Stage Manager for Plasma 6 on Wayland, written as a declarative KWin script. One
group of windows (a *stage*) is on screen at a time. The other stages sit as live thumbnails in a
strip on the left edge. Click one to switch to it.

Tested against KWin 6.7.5 in a nested `kwin_wayland` session. That covered minimize and
hidden-desktop strategies, focus sync, grouping, maximize handling, fullscreen, two outputs and
unload cleanup.

## Design

**Data model** (`package/contents/code/stagemanager.mjs`)

- `stage = { id, ctx, members, lastUsed }`. `members` holds window ids (`String(window.internalId)`),
  most recently used first.
- `ctx = "<output name>|<virtual desktop id>"`. Every output/desktop pair has its own list of stages
  and one active stage. This gives independent stages per monitor, and stages don't leak across
  virtual desktops.
- `active: Map<ctx, stageId>` and `windowStage: Map<windowId, stageId>`.
- `affinity: Map<resourceClass, token>`. When you group apps, their classes share a token. A new
  window whose class has a token joins a stage that already holds one of those classes (session
  memory; optionally saved across sessions).
- **Invariant:** in every ctx, only members of the active stage are visible. Clicking the desktop
  *stashes* the ctx: it has no active stage and every stage sits in the strip.

**Event flow**

| KWin signal | Handler | Effect |
|---|---|---|
| `windowAdded` (deferred one tick) | `onWindowAdded` | classify; place in a new stage or its affinity stage; switch to it |
| `windowActivated` | `onWindowActivated` | if the window (or its transient's parent) is in another stage, switch to that stage; if it's the desktop, send the shown stage to the strip |
| `window.minimizedChanged` | `onMinimizedChanged` | something else unminimized a window we hid (taskbar), so treat it like focus |
| `windowRemoved` | `onWindowRemoved` | drop it; delete an empty stage; if it was active, bring back the most recent stage |
| `outputChanged` / `desktopsChanged` / `interactiveMoveResizeFinished` / `screensChanged` | `reconcile` (coalesced) | regroup members by their current ctx, split stages that span ctxs, restore the invariant |
| `windowAdded` / `maximizedChanged` / `fullScreenChanged` | `applyClearance` | keep new and maximized windows out from under the strip |
| `frameGeometryChanged` / `minimizedChanged` | `stripOverlapped` (QML) | slide the strip away while a shown window covers it |

`switchTo()` first shows and raises the target stage's windows, then hides every other stage in
the same ctx, so the desktop doesn't flash through. It stays "busy" until the next event-loop turn
so that the activations and minimize changes it causes itself don't feed back in.

**Hiding strategy.** All hiding goes through `createHider(kind, platform)`, which returns
`{hide(group), show(group), isHidden, forget, restoreAll, cleanupStale}`. A *group* is a window
plus its transients.

- `minimize` (default): sets `window.minimized`. Windows we hid are tracked separately from windows
  you minimized yourself, and only ours are restored.
- `desktop`: moves windows to a virtual desktop named "Stage Manager (hidden)", which is created on
  demand, and remembers each window's original desktops. Switching onto that desktop is bounced
  back. On start, any windows a crashed run left on it are rescued.

## Files

```
package/                              the KPackage that kpackagetool6 installs
├── metadata.json                     KWin/Script, X-Plasma-API: declarativescript
└── contents/
    ├── config/main.xml               KConfig schema (kwinrc, [Script-kwin-stage-manager])
    ├── code/stagemanager.mjs         all logic + KWin adapter, pure ES module
    └── ui/
        ├── main.qml                  entry point: config, shortcuts, one strip per output
        ├── StripWindow.qml           left-edge strip for one output
        ├── StageTile.qml             stacked live thumbnails, click / drag-to-merge
        └── config.ui                 settings page (generic scripted KCM)
tests/
├── fakes.mjs                         fake Workspace / Window / signals
└── stagemanager.test.mjs             node --test suite
tools/nested-session.sh               run it in an isolated nested KWin
PKGBUILD                              Arch package (git source, tag v$pkgver)
```

## Install / enable / uninstall

On Arch, build the package from the included PKGBUILD (installs to `/usr/share/kwin/scripts`):

```sh
makepkg -si
```

Or install into your user directory:

```sh
# install (use -u instead of -i to upgrade)
kpackagetool6 --type=KWin/Script -i package

# enable: System Settings → Window Management → KWin Scripts → "Stage Manager", or:
kwriteconfig6 --file kwinrc --group Plugins --key kwin-stage-managerEnabled true
qdbus6 org.kde.KWin /KWin reconfigure

# disable (restores every hidden window)
kwriteconfig6 --file kwinrc --group Plugins --key kwin-stage-managerEnabled false
qdbus6 org.kde.KWin /KWin reconfigure

# uninstall
kpackagetool6 --type=KWin/Script -r kwin-stage-manager
```

Settings live behind the gear icon next to the script in KWin Scripts. They take effect after you
turn the script off and on again.

**After upgrading, log out and back in.** KWin keeps compiled QML in memory for the life of the
process, so turning the script off and on again keeps running the old version.

| Key | Default | |
|---|---|---|
| `StripWidth` | 180 | px; also how far windows are kept from the left edge |
| `MaxVisibleStages` | 6 | stages shown in the strip |
| `HidingStrategy` | 0 | 0 = minimize, 1 = hidden virtual desktop |
| `AutoSwitchOnFocus` | true | switch stage when a hidden window gets focus |
| `MaximizedPolicy` | 0 | maximized/tiled windows under the strip: 0 = shrink, 1 = shift right, 2 = leave them (the strip slides away) |
| `KeepWindowsClear` | true | when a window opens or is maximized, move it out from under the strip |
| `GroupByClass` | true | new windows join the stage their app was grouped into |
| `FloatFixedSizeWindows` | true | windows that open fixed-size or always on top (1Password Quick Access, picture-in-picture) get no stage and float over every stage |
| `PersistGroups` | false | save those groups to `~/.config/kwin-stagemanagerrc` |
| `ShowStripOnStart` | true | |

## Shortcuts

Rebind them under System Settings → Shortcuts → KWin.

| Default | Action |
|---|---|
| Meta+Alt+G | Add the active window to the previous stage (the top of the strip) and show that stage |
| Meta+Alt+U | Move the active window out into its own stage (sent to the strip) |
| Meta+Alt+Tab | Switch to the previous stage |
| Meta+Alt+S | Show/hide the strip (hiding it also re-maximizes windows that were shrunk) |

Mouse:

- Click a thumbnail to switch to that stage.
- Drag a thumbnail out of the strip and release it over the highlighted area to add its windows to
  the current stage. Releasing it back over the strip cancels.
- Click the desktop to send the current stage to the strip.
- If you drag a window over the strip, the strip slides away and leaves a thin handle at the screen
  edge. Hover the edge to peek at it. Windows you place there yourself aren't moved back.

## Debugging

```sh
# live log (the script logs with a [stagemanager] prefix)
journalctl --user -f _COMM=kwin_wayland QT_CATEGORY=qml QT_CATEGORY=js

# reload after editing an installed copy
kpackagetool6 --type=KWin/Script -u package
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript kwin-stage-manager
qdbus6 org.kde.KWin /KWin reconfigure

# is it loaded?
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded kwin-stage-manager

# poke at windows interactively (pick "KWin" mode; uses the imperative JS API)
plasma-interactiveconsole --kwin
#   for (const w of workspace.windowList()) print(w.caption, w.minimized, w.output.name)

# safest way to iterate: a nested KWin with isolated config, doesn't touch your session
tools/nested-session.sh             # windowed
tools/nested-session.sh --virtual   # headless smoke test
OUTPUTS=2 tools/nested-session.sh   # multi-monitor

# unit tests for the logic
node --test tests/
```

If something goes wrong while the hidden-desktop strategy is on, disabling the script brings every
window back. If KWin crashed instead, re-enabling the script rescues windows stranded on the hidden
desktop, or you can move them back from the Overview.

## API notes (checked against libkwin 6.7.5)

Some of the requested names don't exist in **declarative** scripts:

- `workspace.windowList()` is only on the imperative JS workspace. Declarative scripts use
  `Workspace.windows`. The adapter accepts either.
- `registerShortcut()` is a method on imperative `Script` objects only. The declarative `KWin`
  singleton only has `readConfig`. Shortcuts here use the `ShortcutHandler` QML type, which
  registers the same kind of global shortcut.
- `KWin.WindowThumbnail` is just `WindowThumbnail` from `import org.kde.kwin`. Its property is
  `client`.
- There's no `writeConfig` for scripts, so cross-session memory uses `QtCore.Settings` with its own
  file.

Behavior I checked in a real KWin that the API docs don't promise:

- The strip, a KWin internal window, reports `normalWindow: true` and an empty `resourceClass`. It
  is excluded by its title.
- The strip lands in layer 9 (overlay), above fullscreen windows, so it hides itself while the
  visible stage on that output has a fullscreen window. KWin keeps windows created by scripts in
  that layer no matter what: `Qt.WindowStaysOnBottomHint` and setting `keepBelow` from a script are
  both ignored. So the strip can't sit below the KDE menu; it gets out of the way instead.
- `Qt.Tool` must not be used on the strip: it includes the `Qt.Popup` bit, and KWin then treats the
  strip as a popup that grabs focus and is dismissed by the next click elsewhere.
  `Qt.BypassWindowManagerHint` stops KWin from centering it on screen.
- Since KWin 6.8, `org.kde.kwin` exports an uncreatable `Window` type, so QtQuick's `Window` has to
  be imported under a qualifier.
- `WindowThumbnail` renders minimized windows and windows on other desktops.
- Setting `frameGeometry` on a maximized window keeps `maximizeMode == 3`.
- `Component.onDestruction` runs on `unloadScript`, so cleanup works.

## Known limitations and edge cases

- **Fullscreen apps and games.** The strip hides while a fullscreen window is on the visible stage,
  but stage switching still minimizes or moves the game. Some games (especially under Wine or
  Proton, or X11 games through XWayland) handle being minimized badly: they lose the mouse grab, drop
  the render context or pause. Add problem apps to a window rule with "Skip taskbar" to keep them out
  of stages, or use the hidden-desktop strategy, which doesn't minimize anything.
- **Apps that misbehave when minimized.** Some apps stop rendering (and their thumbnails go stale),
  throttle, or restore at the wrong size. Some Electron/Chromium apps pause video. The
  hidden-desktop strategy avoids minimizing, but has its own tradeoffs:
- **Hidden-desktop tradeoffs.** With default settings, Alt+Tab and the taskbar only list the current
  desktop, so parked windows vanish from both and focus-based auto-switching mostly happens from
  notifications. The extra desktop also shows up in the Pager and Overview. Minimize mode keeps
  Alt+Tab and the taskbar fully working.
- **Shrinking maximized windows.** KWin re-applies the full maximize geometry when the work area
  changes (panel resized, output reconfigured). The script re-checks on `maximizedChanged` but not on
  every work-area change, so a window can end up under the strip until it's next maximized or the
  stage is switched. Quick-tiled windows are treated like maximized ones and may lose their tile
  state when resized.
- **Multi-monitor.**
  - Each output has its own stages and strip, and a window dragged to another output becomes its own
    stage there.
  - Unplugging an output moves its stages to wherever KWin puts the windows. The stage holding the
    focused window wins, and the others go to the strip.
  - Outputs are identified by connector name (`DP-1`), so a dock that renames connectors can split
    stages.
  - KWin's optional per-output virtual desktops aren't handled; the global current desktop is used.
- **Windows on all desktops** are deliberately left alone: no stage, never hidden.
- **Floating windows.** A window that opens fixed-size (can't be resized or maximized) or always on
  top gets no stage: it floats over the shown stage and never switches or hides anything. 1Password's
  Quick Access is a plain normal window on KWin 6.8 whose only tell is its fixed size. Apps whose
  main window is fixed-size float too; turn off `FloatFixedSizeWindows` if that bothers you. This is
  decided when a window opens, so setting "keep above" on a staged window later doesn't change it.
- **Transient windows** follow their parent. A dialog with no parent (`normalWindow` false and no
  `transientFor`) is ignored and stays visible across switches.
- **New windows always switch stage.** A window that opens in the background still takes over the
  screen, like on macOS. Windows that start minimized don't.
- **Drag-to-merge.** While you drag a thumbnail, the strip window covers the whole output so the drag
  can reach the drop area. Dragging a real window onto a thumbnail isn't possible from a script.
- **Stage animations** come from the strip (sliding, thumbnails flying in and out). The windows
  themselves still use KWin's minimize animation, which flies toward the taskbar: scripts can't
  change a window's `iconGeometry`, so it can't be pointed at the strip.
- **Desktop click** relies on KWin activating the desktop window when you click the wallpaper. KWin
  also activates it when nothing else is left to focus (for example after you minimize the last
  shown window), and that sends the stage to the strip too.
- **Menus and popups.** The strip can't be in the desktop layer (see API notes), so when the KDE
  menu, a context menu, a tooltip, a notification or an OSD opens over it, it quickly slides away
  and returns once that closes. A popup type KWin doesn't report as a popup would be drawn under the
  strip.
- **The strip's edge handle** is 2 px wide and sits above windows, so it takes clicks in that strip
  of the screen while the strip is slid away.
- **Config changes** need the script restarted, because scripts aren't notified of config changes.
- **Startup.** Enabling the script hides every window except the active one, since each existing
  window becomes its own stage.
- **Crash recovery.** If KWin crashes in minimize mode, windows stay minimized; restore them from the
  taskbar.
