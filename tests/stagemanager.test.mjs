// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    StageManager, createKWinPlatform, attachToWorkspace, classify, normalizeConfig,
    Strategy, MaximizedPolicy, HIDDEN_DESKTOP_NAME,
} from "../package/contents/code/stagemanager.mjs";
import { FakeWorkspace, makeEnv } from "./fakes.mjs";

function setup(config = {}, before) {
    const ws = new FakeWorkspace();
    const env = makeEnv(ws);
    if (before) before(ws);
    const platform = createKWinPlatform(env);
    const sm = new StageManager(platform, config);
    attachToWorkspace(sm, ws);
    sm.start();
    env.flush();
    const add = opts => {
        const w = ws.add(opts);
        env.flush();
        return w;
    };
    return { ws, env, sm, add };
}

const visible = ws => ws.windows.filter(w => !w.minimized && w.desktops[0].name !== HIDDEN_DESKTOP_NAME);

test("classify ignores panels, skip-taskbar and our own strip", () => {
    const ws = new FakeWorkspace();
    const p = createKWinPlatform(makeEnv(ws));
    assert.equal(classify(ws.open(), p), "manage");
    assert.equal(classify(ws.open({ normalWindow: false }), p), "ignore");
    assert.equal(classify(ws.open({ skipTaskbar: true }), p), "ignore");
    assert.equal(classify(ws.open({ caption: "KWin Stage Manager Strip" }), p), "ignore");
    const parent = ws.open();
    assert.equal(classify(ws.open({ transientFor: parent, normalWindow: false }), p), "transient");
});

test("normalizeConfig accepts string-typed QVariants", () => {
    const c = normalizeConfig({ StripWidth: "220", AutoSwitchOnFocus: "false", HidingStrategy: "1" });
    assert.equal(c.stripWidth, 220);
    assert.equal(c.autoSwitch, false);
    assert.equal(c.strategy, Strategy.HiddenDesktop);
    assert.equal(c.maxStages, 6);
});

test("each new window gets its own stage and hides the previous one", () => {
    const { ws, sm, add } = setup();
    const a = add({ cls: "konsole" });
    const b = add({ cls: "firefox" });
    assert.equal(sm.stages.size, 2);
    assert.deepEqual(visible(ws), [b]);
    assert.equal(a.minimized, true);
    assert.deepEqual(sm.stripStages("DP-1").map(s => s.windows[0]), [a]);
});

test("existing windows at startup: active window's stage stays visible", () => {
    let a, b;
    const { ws, sm } = setup({}, ws => {
        a = ws.open({ cls: "a" });
        b = ws.open({ cls: "b" });
        ws._active = a;
    });
    assert.equal(sm.stages.size, 2);
    assert.deepEqual(visible(ws), [a]);
    assert.equal(b.minimized, true);
});

test("focusing a hidden window switches to its stage", () => {
    const { ws, env, add } = setup();
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    ws.setActive(a); // e.g. Alt+Tab
    env.flush();
    assert.deepEqual(visible(ws), [a]);
    assert.equal(b.minimized, true);
});

test("auto-switch disabled: focused window shows but stage doesn't change", () => {
    const { ws, env, sm, add } = setup({ autoSwitch: false });
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    ws.setActive(a);
    env.flush();
    assert.equal(a.minimized, false);
    assert.equal(b.minimized, false);
    assert.equal(sm.active.get("DP-1|d1"), sm.stageOfWindow(b).id);
});

test("restoring a hidden window from the taskbar switches to its stage", () => {
    const { ws, env, add } = setup();
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    a.minimized = false; // taskbar click unminimizes without (yet) activating
    env.flush();
    assert.equal(b.minimized, true);
    assert.equal(ws.activeWindow, a);
});

test("user-minimized windows stay minimized when their stage returns", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a" });
    const a2 = add({ cls: "a2" });
    sm.addActiveToPrevious(); // a2 joins a
    env.flush();
    a2.minimized = true; // user minimizes one window of the group
    env.flush();
    const b = add({ cls: "b" });
    sm.switchTo(sm.stageOfWindow(a).id);
    env.flush();
    assert.equal(a.minimized, false);
    assert.equal(a2.minimized, true);
    assert.equal(b.minimized, true);
});

test("closing the last window of the active stage brings back the previous stage", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    ws.close(b);
    env.flush();
    assert.equal(sm.stages.size, 1);
    assert.equal(a.minimized, false);
    assert.equal(ws.activeWindow, a);
});

test("closing a window in a background stage deletes the empty stage", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    ws.close(a);
    env.flush();
    assert.equal(sm.stages.size, 1);
    assert.deepEqual(visible(ws), [b]);
});

test("transients follow their parent and don't get stages", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a" });
    const dlg = add({ cls: "a", transientFor: a, normalWindow: false });
    assert.equal(sm.stages.size, 1);
    add({ cls: "b" });
    assert.equal(a.minimized, true);
    assert.equal(dlg.minimized, true);
    ws.setActive(dlg);
    env.flush();
    assert.equal(a.minimized, false);
    assert.equal(dlg.minimized, false);
});

test("add active window to previous stage groups them and remembers the class", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "konsole" });
    const b = add({ cls: "kate" });
    assert.equal(sm.addActiveToPrevious(), true);
    env.flush();
    assert.equal(sm.stages.size, 1);
    assert.equal(sm.stageOfWindow(a), sm.stageOfWindow(b));
    assert.deepEqual(new Set(visible(ws)), new Set([a, b]));

    // Session memory: a new kate window joins the konsole+kate stage.
    add({ cls: "other" });
    const b2 = add({ cls: "kate" });
    assert.equal(sm.stageOfWindow(b2), sm.stageOfWindow(a));
    assert.deepEqual(sm.exportAffinity().konsole, sm.exportAffinity().kate);
});

test("affinity off: same class still gets a new stage", () => {
    const { sm, env, add } = setup({ groupByClass: false });
    add({ cls: "konsole" });
    add({ cls: "kate" });
    sm.addActiveToPrevious();
    env.flush();
    add({ cls: "kate" });
    assert.equal(sm.stages.size, 2);
});

test("merging a strip stage into the active stage", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    sm.mergeIntoActive(sm.stageOfWindow(a).id);
    env.flush();
    assert.equal(sm.stages.size, 1);
    assert.deepEqual(new Set(visible(ws)), new Set([a, b]));
    assert.equal(ws.activeWindow, b);
});

test("split sends the active window to the strip", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    sm.addActiveToPrevious();
    env.flush();
    ws.setActive(b);
    assert.equal(sm.splitActive(), true);
    env.flush();
    assert.equal(sm.stages.size, 2);
    assert.deepEqual(visible(ws), [a]);
    assert.equal(sm.stripStages("DP-1")[0].windows[0], b);
    assert.equal(sm.affinity.has("b"), false);
});

test("strip is most-recent-first and capped at maxStages", () => {
    const { sm, add } = setup({ maxStages: 2 });
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    const c = add({ cls: "c" });
    add({ cls: "d" });
    const strip = sm.stripStages("DP-1");
    assert.equal(strip.length, 2);
    assert.equal(strip[0].windows[0], c);
    assert.equal(strip[1].windows[0], b);
    assert.ok(a);
});

test("stages are independent per output", () => {
    const { ws, sm, add } = setup();
    const left = add({ cls: "a", output: ws.screens[0] });
    const right = add({ cls: "b", output: ws.screens[1] });
    assert.deepEqual(new Set(visible(ws)), new Set([left, right]));
    assert.equal(sm.stripStages("DP-1").length, 0);
    assert.equal(sm.stripStages("DP-2").length, 0);
});

test("moving one window to another output splits it into a stage there", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    sm.addActiveToPrevious();
    env.flush();
    const other = add({ cls: "c", output: ws.screens[1] });
    ws.setActive(b);
    env.flush();
    b.output = ws.screens[1];
    b.outputChanged.emit();
    env.flush();
    assert.equal(sm.stageOfWindow(b).ctx, "DP-2|d1");
    assert.equal(sm.stageOfWindow(a).ctx, "DP-1|d1");
    assert.equal(a.minimized, false); // remaining group still shown on DP-1
    assert.equal(other.minimized, true); // b's stage took over DP-2
    assert.equal(b.minimized, false);
});

test("pinning a window to all desktops releases it", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a" });
    add({ cls: "b" });
    a.onAllDesktops = true;
    a.desktopsChanged.emit();
    env.flush();
    assert.equal(sm.stageOfWindow(a), null);
    assert.equal(a.minimized, false);
    assert.equal(sm.stages.size, 1);
});

test("hidden-desktop strategy parks windows and restores their desktop", () => {
    const { ws, env, sm, add } = setup({ strategy: Strategy.HiddenDesktop });
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    const hidden = ws.desktops.find(d => d.name === HIDDEN_DESKTOP_NAME);
    assert.ok(hidden);
    assert.deepEqual(a.desktops, [hidden]);
    assert.equal(a.minimized, false);
    assert.equal(sm.stages.size, 2, "parking must not split the stage");
    ws.setActive(a);
    env.flush();
    assert.equal(a.desktops[0].id, "d1");
    assert.deepEqual(b.desktops, [hidden]);
    sm.shutdown();
    assert.equal(b.desktops[0].id, "d1");
    assert.equal(ws.desktops.some(d => d.name === HIDDEN_DESKTOP_NAME), false);
});

test("hidden-desktop strategy rescues windows left over from a crashed run", () => {
    let orphan;
    const { ws } = setup({ strategy: Strategy.HiddenDesktop }, ws => {
        ws.createDesktop(2, HIDDEN_DESKTOP_NAME);
        orphan = ws.open({ cls: "x", desktop: ws.desktops[2] });
    });
    assert.equal(orphan.desktops[0].id, "d1");
    assert.equal(ws.windows.length, 1);
});

test("shutdown restores everything", () => {
    const { ws, sm, add } = setup();
    add({ cls: "a" });
    add({ cls: "b" });
    add({ cls: "c" });
    sm.shutdown();
    assert.equal(visible(ws).length, 3);
});

test("windows are kept clear of the strip", () => {
    const { env, sm, add } = setup({ stripWidth: 200 });
    const floating = add({ cls: "a", geometry: { x: 50, y: 10, width: 600, height: 400 } });
    env.flush();
    assert.deepEqual(floating.frameGeometry, { x: 200, y: 10, width: 600, height: 400 });

    const max = add({ cls: "b", maximizeMode: 3, geometry: { x: 0, y: 0, width: 1920, height: 1080 } });
    env.flush();
    assert.deepEqual(max.frameGeometry, { x: 200, y: 0, width: 1720, height: 1080 });
    assert.ok(sm.adjusted.has(String(max.internalId)));
});

test("maximized policy: offset and ignore", () => {
    const off = setup({ stripWidth: 200, maximizedPolicy: MaximizedPolicy.Offset });
    const w1 = off.add({ maximizeMode: 3, geometry: { x: 0, y: 0, width: 1920, height: 1080 } });
    off.env.flush();
    assert.deepEqual(w1.frameGeometry, { x: 200, y: 0, width: 1920, height: 1080 });

    const ign = setup({ stripWidth: 200, maximizedPolicy: MaximizedPolicy.Ignore });
    const w2 = ign.add({ maximizeMode: 3, geometry: { x: 0, y: 0, width: 1920, height: 1080 } });
    ign.env.flush();
    assert.equal(w2.frameGeometry.x, 0);
});

test("hidden strip leaves geometry alone", () => {
    const { env, sm, add } = setup({ stripWidth: 200 });
    sm.setStripVisible(false);
    const w = add({ geometry: { x: 0, y: 0, width: 500, height: 500 } });
    env.flush();
    assert.equal(w.frameGeometry.x, 0);
});

test("persisted affinities load", () => {
    const ws = new FakeWorkspace();
    const env = makeEnv(ws);
    const sm = new StageManager(createKWinPlatform(env), {}, { konsole: 4, kate: 4 });
    attachToWorkspace(sm, ws);
    sm.start();
    const a = ws.add({ cls: "konsole" });
    env.flush();
    const b = ws.add({ cls: "kate" });
    env.flush();
    assert.equal(sm.stageOfWindow(a), sm.stageOfWindow(b));
    assert.equal(sm.nextToken, 5);
});

test("strip reports fullscreen on the visible stage", () => {
    const { sm, env, add } = setup();
    add({ cls: "a" });
    const g = add({ cls: "game" });
    assert.equal(sm.hasFullscreen("DP-1"), false);
    g.fullScreen = true;
    g.fullScreenChanged.emit();
    env.flush();
    assert.equal(sm.hasFullscreen("DP-1"), true);
    assert.equal(sm.hasFullscreen("DP-2"), false);
});

// The Plasma desktop: on all desktops, not a normal window.
function addDesktop(ws, env) {
    const d = ws.open({ cls: "plasmashell", normalWindow: false, desktopWindow: true });
    d.onAllDesktops = true;
    ws.windowAdded.emit(d);
    env.flush();
    return d;
}

test("clicking the desktop sends the shown stage to the strip", () => {
    const { ws, env, sm, add } = setup();
    const desk = addDesktop(ws, env);
    const a = add({ cls: "a" });
    const b = add({ cls: "b" });
    ws.setActive(desk);
    env.flush();
    assert.equal(visible(ws).filter(w => !w.desktopWindow).length, 0);
    assert.deepEqual(sm.stripStages("DP-1").map(s => s.windows[0]), [b, a]);

    // picking a stage from the strip brings it back
    sm.switchTo(sm.stageOfWindow(a).id);
    env.flush();
    assert.deepEqual(visible(ws).filter(w => !w.desktopWindow), [a]);
    assert.equal(sm.stashed.size, 0);
});

test("a new window after a desktop click opens normally", () => {
    const { ws, env, sm, add } = setup();
    const desk = addDesktop(ws, env);
    add({ cls: "a" });
    ws.setActive(desk);
    env.flush();
    const b = add({ cls: "b" });
    assert.deepEqual(visible(ws).filter(w => !w.desktopWindow), [b]);
    assert.equal(sm.stripStages("DP-1").length, 1);
});

test("dropping a stage while nothing is shown just shows it", () => {
    const { ws, env, sm, add } = setup();
    const desk = addDesktop(ws, env);
    const a = add({ cls: "a" });
    ws.setActive(desk);
    env.flush();
    assert.equal(sm.mergeIntoActive(sm.stageOfWindow(a).id), true);
    env.flush();
    assert.equal(a.minimized, false);
});

test("a stage whose windows were all minimized by hand comes back restored", () => {
    const { ws, env, sm, add } = setup();
    const desk = addDesktop(ws, env);
    const a = add({ cls: "a" });
    a.minimized = true; // user minimizes the only window; KWin focuses the desktop
    ws.setActive(desk);
    env.flush();
    sm.switchTo(sm.stageOfWindow(a).id);
    env.flush();
    assert.equal(a.minimized, false);
});

test("strip overlap follows the shown stage's windows", () => {
    const { ws, env, sm, add } = setup();
    const a = add({ cls: "a", geometry: { x: 400, y: 0, width: 500, height: 500 } });
    env.flush();
    assert.equal(sm.stripOverlapped("DP-1", 0, 180), false);
    a.frameGeometry = { x: 100, y: 0, width: 500, height: 500 }; // user drags it over the strip
    assert.equal(sm.stripOverlapped("DP-1", 0, 180), true);
    add({ cls: "b", geometry: { x: 400, y: 0, width: 500, height: 500 } });
    assert.equal(sm.stripOverlapped("DP-1", 0, 180), false, "a is hidden now");
    assert.ok(ws);
});

test("windows moved over the strip by hand stay put across switches", () => {
    const { ws, env, sm, add } = setup({ stripWidth: 200 });
    const a = add({ cls: "a", geometry: { x: 400, y: 0, width: 500, height: 500 } });
    env.flush();
    a.frameGeometry = { x: 50, y: 0, width: 500, height: 500 };
    a.interactiveMoveResizeFinished.emit();
    env.flush();
    add({ cls: "b" });
    sm.switchTo(sm.stageOfWindow(a).id);
    env.flush();
    assert.equal(a.frameGeometry.x, 50);
    assert.ok(ws);
});
