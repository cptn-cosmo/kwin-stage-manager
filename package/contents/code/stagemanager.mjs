// SPDX-License-Identifier: MIT
//
// Stage Manager for KWin 6 — core logic.
//
// This module holds no QML and no direct reference to KWin globals. Everything
// KWin-specific goes through a `platform` object (see createKWinPlatform at the
// bottom), so the logic can be unit-tested under Node with fake windows
// (tests/stagemanager.test.mjs).
//
// Written for the QML V4 engine: ES2017-ish only. No class fields, no private
// members, no top-level await.

export const Strategy = Object.freeze({ Minimize: "minimize", HiddenDesktop: "desktop" });
export const MaximizedPolicy = Object.freeze({ Shrink: 0, Offset: 1, Ignore: 2 });

export const STRIP_TITLE = "KWin Stage Manager Strip";
export const HIDDEN_DESKTOP_NAME = "Stage Manager (hidden)";

// KWin::MaximizeMode bits. MaximizeHorizontal = 2, MaximizeFull = 3.
const MAXIMIZE_HORIZONTAL = 2;

export function defaultConfig() {
    return {
        stripWidth: 180,
        maxStages: 6,
        strategy: Strategy.Minimize,
        autoSwitch: true,
        maximizedPolicy: MaximizedPolicy.Shrink,
        keepClear: true,
        groupByClass: true,
        stripVisible: true,
    };
}

// readConfig() hands back QVariants whose JS type depends on how the value was
// stored (a bool written by the KCM may come back as the string "true").
export function normalizeConfig(raw) {
    const d = defaultConfig();
    const int = (v, def) => {
        const n = parseInt(v, 10);
        return isNaN(n) ? def : n;
    };
    const bool = (v, def) => {
        if (v === undefined || v === null || v === "") return def;
        if (typeof v === "string") return v.toLowerCase() === "true";
        return !!v;
    };
    return {
        stripWidth: Math.max(80, int(raw.StripWidth, d.stripWidth)),
        maxStages: Math.max(1, int(raw.MaxVisibleStages, d.maxStages)),
        strategy: int(raw.HidingStrategy, 0) === 1 ? Strategy.HiddenDesktop : Strategy.Minimize,
        autoSwitch: bool(raw.AutoSwitchOnFocus, d.autoSwitch),
        maximizedPolicy: Math.min(2, Math.max(0, int(raw.MaximizedPolicy, d.maximizedPolicy))),
        keepClear: bool(raw.KeepWindowsClear, d.keepClear),
        groupByClass: bool(raw.GroupByClass, d.groupByClass),
        stripVisible: bool(raw.ShowStripOnStart, d.stripVisible),
    };
}

// "manage"    — a top-level app window; gets a stage.
// "transient" — dialog/child with a parent; follows the parent's stage.
// "ignore"    — panels, notifications, OSDs, popups, skip-taskbar windows, ours.
export function classify(w, platform) {
    if (!w || w.deleted) return "ignore";
    if (platform && platform.isOwnWindow(w)) return "ignore";
    if (w.transient && w.transientFor) return "transient";
    if (!w.normalWindow || w.specialWindow || w.skipTaskbar) return "ignore";
    // `managed` is false for override-redirect/unmanaged X11 windows.
    if (w.managed === false) return "ignore";
    return "manage";
}

// Windows that should appear above the strip: the KDE menu (an applet popup),
// context menus, tooltips, notifications, OSDs. KWin keeps script-created
// windows like our strip in the overlay layer no matter what (Qt flags and
// keepBelow are both ignored, checked on 6.8.2), so instead of putting the
// strip under these we move it out of their way.
export function isAboveStrip(w, platform) {
    if (!w || w.deleted || w.desktopWindow) return false;
    if (platform && platform.isOwnWindow(w)) return false;
    return !!(w.appletPopup || w.popupWindow || w.dropdownMenu || w.popupMenu || w.tooltip || w.comboBox ||
        w.notification || w.criticalNotification || w.onScreenDisplay);
}

export function rootOf(w) {
    let r = w;
    for (let i = 0; i < 16 && r && r.transient && r.transientFor; i++) r = r.transientFor;
    return r;
}

// ---------------------------------------------------------------------------
// Hiding strategies. Everything that hides or shows a window goes through the
// object returned here, so switching strategy means changing one argument.
//
// Both take a "group": [root, ...transients].
// ---------------------------------------------------------------------------
export function createHider(kind, platform) {
    if (kind === Strategy.HiddenDesktop) return createDesktopHider(platform);
    return createMinimizeHider(platform);
}

function createMinimizeHider(platform) {
    const hidden = new Set();
    return {
        kind: Strategy.Minimize,
        isHidden(w) {
            return hidden.has(platform.id(w));
        },
        hide(group) {
            // Parent first. KWin minimizes transients along with their main
            // window, so by the time we reach them they're usually already
            // minimized and we skip them. Restoring the parent brings them back.
            for (const w of group) {
                if (w.minimized) continue; // already minimized (by the user or by KWin)
                hidden.add(platform.id(w));
                w.minimized = true;
            }
        },
        show(group) {
            for (const w of group) {
                if (!hidden.delete(platform.id(w))) continue;
                w.minimized = false;
            }
        },
        forget(w) {
            hidden.delete(platform.id(w));
        },
        originalDesktopId() {
            return undefined;
        },
        restoreAll(windows) {
            for (const w of windows) this.show([w]);
            hidden.clear();
        },
        cleanupStale() {},
    };
}

function createDesktopHider(platform) {
    const saved = new Map(); // id -> VirtualDesktop[] the window was on
    return {
        kind: Strategy.HiddenDesktop,
        isHidden(w) {
            return saved.has(platform.id(w));
        },
        hide(group) {
            // Children first: if KWin syncs a transient's desktops to its parent
            // we'd otherwise record the hidden desktop as its "original" one.
            const target = platform.ensureHiddenDesktop();
            if (!target) return;
            for (let i = group.length - 1; i >= 0; i--) {
                const w = group[i];
                const id = platform.id(w);
                if (saved.has(id)) continue;
                const desks = platform.desktopsOf(w);
                if (desks.length === 1 && desks[0] === target) continue;
                saved.set(id, desks);
                w.desktops = [target];
            }
        },
        show(group) {
            for (const w of group) {
                const id = platform.id(w);
                const desks = saved.get(id);
                if (!desks) continue;
                saved.delete(id);
                w.desktops = desks.length ? desks : [platform.currentDesktop()];
            }
        },
        forget(w) {
            saved.delete(platform.id(w));
        },
        originalDesktopId(w) {
            const desks = saved.get(platform.id(w));
            if (!desks) return undefined;
            return desks.length === 1 ? desks[0].id : null;
        },
        restoreAll(windows) {
            for (const w of windows) this.show([w]);
            saved.clear();
            platform.removeHiddenDesktop();
        },
        // A previous run that crashed or was killed can leave windows on the
        // hidden desktop. Bring them back before we start.
        cleanupStale() {
            const hiddenDesk = platform.findHiddenDesktop();
            if (!hiddenDesk) return;
            for (const w of platform.windows()) {
                const desks = platform.desktopsOf(w);
                if (desks.length === 1 && desks[0] === hiddenDesk) w.desktops = [platform.currentDesktop()];
            }
        },
    };
}

// ---------------------------------------------------------------------------
// StageManager
//
// Data model:
//   stage   = { id, ctx, members: [windowId, ...] (most recently used first), lastUsed }
//   ctx     = "<outputName>|<virtualDesktopId>": the scope a stage lives in.
//             Each (output, desktop) pair has its own stage list and active stage.
//   active  = Map ctx -> stageId
//   affinity= Map resourceClass -> group token (remembers grouping by class)
//
// Invariant: in each ctx, only members of the active stage are visible. A ctx
// can also have no active stage ("stashed": you clicked the desktop), in
// which case every stage there sits in the strip.
// ---------------------------------------------------------------------------
export class StageManager {
    constructor(platform, config, persisted) {
        this.platform = platform;
        this.config = Object.assign(defaultConfig(), config || {});
        this.hider = createHider(this.config.strategy, platform);

        this.stages = new Map();
        this.windowStage = new Map(); // managed window id -> stage id
        this.windows = new Map(); // id -> window, every window we track (managed + candidates)
        this.active = new Map();
        this.affinity = new Map();
        this.adjusted = new Set(); // ids of maximized windows we resized for the strip
        this.stashed = new Set(); // ctxs whose stages were all sent to the strip
        this.above = new Map(); // id -> window that the strip must stay clear of (menus, popups, ...)
        this.connections = new Map(); // id -> [[signal, handler], ...]

        this.clock = 0;
        this.nextStageId = 1;
        this.nextToken = 1;
        this.busy = 0;
        this.reconcilePending = false;
        this.listeners = [];

        if (persisted && typeof persisted === "object") {
            for (const cls in persisted) {
                const t = parseInt(persisted[cls], 10);
                if (isNaN(t)) continue;
                this.affinity.set(cls, t);
                this.nextToken = Math.max(this.nextToken, t + 1);
            }
        }
    }

    // ----- observers -------------------------------------------------------
    onChanged(fn) {
        this.listeners.push(fn);
    }
    emit(what) {
        for (const fn of this.listeners) {
            try {
                fn(what);
            } catch (e) {
                this.platform.log("listener failed: " + e);
            }
        }
    }

    // ----- lifecycle -------------------------------------------------------
    start() {
        this.hider.cleanupStale();
        const all = this.platform.windows();
        for (const w of all) this.track(w);
        for (const w of all) this.trackAbove(w);
        for (const w of all) if (classify(w, this.platform) === "manage") this.adopt(w);

        // Pick the initial active stage per ctx: the active window's stage
        // where it applies, otherwise the stage owning the topmost window.
        const aw = this.managedRoot(this.platform.activeWindow());
        const picked = new Map();
        if (aw) {
            const st = this.stageOfWindow(aw);
            picked.set(st.ctx, st.id);
        }
        const stack = this.platform.stackingOrder(); // bottom -> top
        for (let i = stack.length - 1; i >= 0; i--) {
            const id = this.platform.id(stack[i]);
            const sid = this.windowStage.get(id);
            if (sid === undefined || stack[i].minimized) continue;
            const st = this.stages.get(sid);
            if (!picked.has(st.ctx)) picked.set(st.ctx, sid);
        }
        for (const [ctx, sid] of picked) this.switchTo(sid, { focus: aw && this.windowStage.get(this.platform.id(aw)) === sid ? aw : null, noFocus: true });
        this.emit("start");
    }

    shutdown() {
        for (const [, list] of this.connections) for (const [sig, fn] of list) safeDisconnect(sig, fn);
        this.connections.clear();
        const ws = [];
        for (const [, w] of this.windows) ws.push(w);
        this.hider.restoreAll(ws);
        for (const id of this.adjusted) {
            const w = this.windows.get(id);
            if (w) this.platform.remaximize(w);
        }
        this.adjusted.clear();
    }

    // ----- tracking --------------------------------------------------------
    track(w) {
        const id = this.platform.id(w);
        if (this.windows.has(id)) return;
        if (classify(w, this.platform) !== "manage") return;
        this.windows.set(id, w);
        const reconcile = () => this.scheduleReconcile();
        const list = [
            [w.outputChanged, reconcile],
            [w.desktopsChanged, reconcile],
            [w.skipTaskbarChanged, reconcile],
            // No clearance after a user move: if you put a window over the
            // strip on purpose, the strip slides away instead (see stripOverlapped).
            [w.interactiveMoveResizeFinished, reconcile],
            [w.frameGeometryChanged, () => this.emit("geometry")],
            [w.minimizedChanged, () => this.onMinimizedChanged(w)],
            [w.maximizedChanged, () => this.scheduleClearance(w)],
            [w.fullScreenChanged, () => {
                this.scheduleClearance(w);
                this.emit("fullscreen");
            }],
        ];
        for (const [sig, fn] of list) safeConnect(sig, fn);
        this.connections.set(id, list);
    }

    untrack(w) {
        const id = this.platform.id(w);
        const list = this.connections.get(id);
        if (list) for (const [sig, fn] of list) safeDisconnect(sig, fn);
        this.connections.delete(id);
        this.windows.delete(id);
        this.adjusted.delete(id);
        this.hider.forget(w);
    }

    // Place a managed window into a stage (by class affinity or a fresh one).
    adopt(w) {
        const id = this.platform.id(w);
        if (this.windowStage.has(id)) return this.stages.get(this.windowStage.get(id));
        const ctx = this.effectiveCtx(w);
        if (ctx === null) return null;
        let st = null;
        if (this.config.groupByClass) {
            const token = this.affinity.get(w.resourceClass);
            if (token !== undefined) st = this.findStageByToken(ctx, token, id);
        }
        if (!st) st = this.newStage(ctx);
        st.members.unshift(id);
        this.windowStage.set(id, st.id);
        return st;
    }

    newStage(ctx) {
        const st = { id: this.nextStageId++, ctx: ctx, members: [], lastUsed: ++this.clock };
        this.stages.set(st.id, st);
        return st;
    }

    deleteStage(st) {
        this.stages.delete(st.id);
        if (this.active.get(st.ctx) === st.id) this.active.delete(st.ctx);
    }

    removeMember(st, id) {
        const i = st.members.indexOf(id);
        if (i >= 0) st.members.splice(i, 1);
        this.windowStage.delete(id);
    }

    findStageByToken(ctx, token, exceptId) {
        let best = null;
        for (const [, st] of this.stages) {
            if (st.ctx !== ctx) continue;
            const hit = st.members.some(m => {
                if (m === exceptId) return false;
                const mw = this.windows.get(m);
                return mw && this.affinity.get(mw.resourceClass) === token;
            });
            if (hit && (!best || st.lastUsed > best.lastUsed)) best = st;
        }
        return best;
    }

    // ----- queries ---------------------------------------------------------
    ctxOf(w) {
        const out = this.platform.outputName(w);
        const desk = this.platform.desktopIdOf(w);
        if (!out || desk === null || desk === undefined) return null;
        return out + "|" + desk;
    }

    // Like ctxOf, but sees through our own hiding (a window parked on the
    // hidden desktop still belongs to its original desktop), and ignores
    // windows mid-drag so a stage doesn't split while you move it.
    effectiveCtx(w) {
        const id = this.platform.id(w);
        const sid = this.windowStage.get(id);
        if (sid !== undefined && (w.move || w.resize)) return this.stages.get(sid).ctx;
        const orig = this.hider.originalDesktopId(w);
        if (orig === undefined) return this.ctxOf(w);
        const out = this.platform.outputName(w);
        if (!out || orig === null) return null;
        return out + "|" + orig;
    }

    currentCtx(outputName) {
        return outputName + "|" + this.platform.currentDesktopId(outputName);
    }

    stageOfWindow(w) {
        const sid = this.windowStage.get(this.platform.id(w));
        return sid === undefined ? null : this.stages.get(sid);
    }

    managedRoot(w) {
        if (!w) return null;
        const r = rootOf(w);
        return this.windowStage.has(this.platform.id(r)) ? r : null;
    }

    stagesIn(ctx) {
        const out = [];
        for (const [, st] of this.stages) if (st.ctx === ctx) out.push(st);
        out.sort((a, b) => b.lastUsed - a.lastUsed);
        return out;
    }

    // Non-active stages in a ctx, most recently used first. This is what the strip shows.
    recentStages(ctx) {
        const act = this.active.get(ctx);
        return this.stagesIn(ctx).filter(s => s.id !== act);
    }

    // View model for the strip on one output.
    stripStages(outputName) {
        const ctx = this.currentCtx(outputName);
        return this.recentStages(ctx)
            .slice(0, this.config.maxStages)
            .map(st => {
                const wins = st.members.map(m => this.windows.get(m)).filter(Boolean);
                return {
                    id: st.id,
                    windows: wins.slice(0, 3),
                    count: wins.length,
                    title: wins.length ? String(wins[0].captionNormal || wins[0].caption || "") : "",
                };
            });
    }

    // The strip sits in KWin's overlay layer (above fullscreen windows), so it
    // hides itself while the visible stage on its output has a fullscreen window.
    hasFullscreen(outputName) {
        const st = this.stages.get(this.active.get(this.currentCtx(outputName)));
        if (!st) return false;
        return st.members.some(m => {
            const w = this.windows.get(m);
            return w && w.fullScreen && !w.minimized;
        });
    }

    // What covers the strip column [x0, x1) on this output:
    //   0 nothing, 1 a window of the shown stage (strip slides away, as on
    //   macOS), 2 a menu/popup/notification (strip gets out of the way fast).
    stripCover(outputName, x0, x1) {
        const hits = w => {
            const g = w.frameGeometry;
            return g.x < x1 - 0.5 && g.x + g.width > x0 + 0.5;
        };
        for (const [, w] of this.above)
            if (!w.hidden && this.platform.outputName(w) === outputName && hits(w)) return 2;
        const st = this.stages.get(this.active.get(this.currentCtx(outputName)));
        if (!st) return 0;
        const covered = st.members.some(m => {
            const w = this.windows.get(m);
            if (!w || w.minimized || this.hider.isHidden(w)) return false;
            return hits(w) || this.platform.transientsOf(w).some(t => !t.minimized && hits(t));
        });
        return covered ? 1 : 0;
    }

    stripOverlapped(outputName, x0, x1) {
        return this.stripCover(outputName, x0, x1) !== 0;
    }

    trackAbove(w) {
        if (!isAboveStrip(w, this.platform)) return;
        const id = this.platform.id(w);
        if (this.above.has(id)) return;
        const fn = () => this.emit("geometry");
        safeConnect(w.frameGeometryChanged, fn);
        this.above.set(id, w);
        this.connections.set(id, [[w.frameGeometryChanged, fn]]);
        this.emit("geometry");
    }

    groupFor(w) {
        return [w].concat(this.platform.transientsOf(w));
    }

    // ----- switching -------------------------------------------------------
    // opts.focus:   window to activate afterwards (default: the stage's most recent visible window)
    // opts.noFocus: don't touch focus unless opts.focus is given
    switchTo(stageId, opts) {
        opts = opts || {};
        const st = this.stages.get(stageId);
        if (!st) return;
        this.busy++;
        try {
            // Show the target first and hide the rest second, so the desktop
            // doesn't flash through between the two.
            for (let i = st.members.length - 1; i >= 0; i--) {
                const w = this.windows.get(st.members[i]);
                if (!w) continue;
                this.hider.show(this.groupFor(w));
                if (!w.minimized) this.platform.raise(w);
            }
            // A stage whose windows were all minimized by hand would come back
            // empty; activating it should show something, so restore them.
            const members = st.members.map(m => this.windows.get(m)).filter(Boolean);
            if (members.length && members.every(w => w.minimized)) {
                for (const w of members) {
                    w.minimized = false;
                    this.platform.raise(w);
                }
            }
            for (const other of this.stagesIn(st.ctx)) {
                if (other.id === st.id) continue;
                for (const m of other.members) {
                    const w = this.windows.get(m);
                    if (w) this.hider.hide(this.groupFor(w));
                }
            }
            this.active.set(st.ctx, st.id);
            this.stashed.delete(st.ctx);
            st.lastUsed = ++this.clock;

            let focus = opts.focus || null;
            if (!focus && !opts.noFocus) {
                for (const m of st.members) {
                    const w = this.windows.get(m);
                    if (w && !w.minimized) {
                        focus = w;
                        break;
                    }
                }
            }
            if (focus && this.platform.activeWindow() !== focus) this.platform.activate(focus);
        } finally {
            // Hiding/showing makes KWin emit windowActivated/minimizedChanged,
            // some of it after we return. Stay "busy" until the event loop turns.
            this.platform.defer(() => {
                this.busy--;
            });
        }
        this.emit("switch");
    }

    // Clicking the desktop: send the shown stage to the strip so the desktop
    // is clear. The ctx then has no active stage until one is picked.
    stash(ctx) {
        const st = this.stages.get(this.active.get(ctx));
        this.stashed.add(ctx);
        if (!st) return;
        this.hideAllIn(ctx);
        this.active.delete(ctx);
        st.lastUsed = ++this.clock;
        this.emit("stash");
    }

    hideAllIn(ctx) {
        this.busy++;
        try {
            for (const st of this.stagesIn(ctx))
                for (const m of st.members) {
                    const w = this.windows.get(m);
                    if (w) this.hider.hide(this.groupFor(w));
                }
        } finally {
            this.platform.defer(() => {
                this.busy--;
            });
        }
    }

    switchToPrevious(outputName) {
        const ctx = this.ctxForCommand(outputName);
        if (!ctx) return;
        const prev = this.recentStages(ctx)[0];
        if (prev) this.switchTo(prev.id);
    }

    ctxForCommand(outputName) {
        const aw = this.managedRoot(this.platform.activeWindow());
        if (aw) return this.stageOfWindow(aw).ctx;
        return outputName ? this.currentCtx(outputName) : null;
    }

    // ----- grouping --------------------------------------------------------
    // Moves the active window into the most recently used other stage in its
    // ctx, then switches to that stage so the new group is on screen.
    addActiveToPrevious() {
        const w = this.managedRoot(this.platform.activeWindow());
        if (!w) return false;
        const id = this.platform.id(w);
        const from = this.stageOfWindow(w);
        const to = this.recentStages(from.ctx).find(s => s.id !== from.id);
        if (!to) return false;
        this.moveWindow(id, from, to);
        this.switchTo(to.id, { focus: w });
        return true;
    }

    // Drag a strip thumbnail onto the current stage: every window of `srcId`
    // joins the active stage of the same ctx.
    mergeIntoActive(srcId) {
        const src = this.stages.get(srcId);
        if (!src) return false;
        const dstId = this.active.get(src.ctx);
        const dst = this.stages.get(dstId);
        if (dst === src) return false;
        if (!dst) {
            // Nothing on screen (desktop was clicked): dropping just shows it.
            this.switchTo(src.id);
            return true;
        }
        const focus = this.platform.activeWindow();
        for (const id of src.members.slice().reverse()) this.moveWindow(id, src, dst);
        this.switchTo(dst.id, { focus: focus, noFocus: true });
        return true;
    }

    // Pull the active window out into a stage of its own; it goes to the top of
    // the strip and the rest of its old stage stays on screen.
    splitActive() {
        const w = this.managedRoot(this.platform.activeWindow());
        if (!w) return false;
        const from = this.stageOfWindow(w);
        if (from.members.length < 2) return false;
        const id = this.platform.id(w);
        this.removeMember(from, id);
        const st = this.newStage(from.ctx);
        st.members.push(id);
        this.windowStage.set(id, st.id);
        if (this.affinity.delete(w.resourceClass)) this.emit("affinity");
        this.switchTo(from.id);
        return true;
    }

    moveWindow(id, from, to) {
        this.removeMember(from, id);
        to.members.unshift(id);
        this.windowStage.set(id, to.id);
        if (!from.members.length) this.deleteStage(from);
        this.unifyAffinity(to);
    }

    // All classes in a stage share one token, so a new window of any of those
    // classes joins this stage instead of starting its own.
    unifyAffinity(st) {
        const classes = [];
        for (const m of st.members) {
            const w = this.windows.get(m);
            if (w && w.resourceClass && classes.indexOf(w.resourceClass) < 0) classes.push(w.resourceClass);
        }
        if (classes.length < 2) return;
        let token;
        for (const c of classes) if (this.affinity.has(c)) token = this.affinity.get(c);
        if (token === undefined) token = this.nextToken++;
        const old = new Set();
        for (const c of classes) if (this.affinity.has(c)) old.add(this.affinity.get(c));
        for (const [c, t] of this.affinity) if (old.has(t)) this.affinity.set(c, token);
        for (const c of classes) this.affinity.set(c, token);
        this.emit("affinity");
    }

    exportAffinity() {
        const o = {};
        for (const [c, t] of this.affinity) o[c] = t;
        return o;
    }

    // ----- events ----------------------------------------------------------
    onWindowAdded(w) {
        this.trackAbove(w);
        this.track(w);
        if (classify(w, this.platform) !== "manage") return;
        const st = this.adopt(w);
        if (!st) return;
        if (w.minimized) {
            // Started minimized: file it under its stage, leave it alone.
            this.emit("added");
            return;
        }
        this.switchTo(st.id, { focus: w });
        this.scheduleClearance(w);
    }

    onWindowRemoved(w) {
        const id = this.platform.id(w);
        if (this.above.delete(id)) {
            this.untrack(w);
            this.emit("geometry");
            return;
        }
        const st = this.stageOfWindow(w);
        this.untrack(w);
        if (!st) return;
        this.removeMember(st, id);
        if (st.members.length) {
            this.emit("removed");
            return;
        }
        const wasActive = this.active.get(st.ctx) === st.id;
        this.deleteStage(st);
        if (wasActive) {
            const next = this.stagesIn(st.ctx)[0];
            if (next) {
                this.switchTo(next.id);
                return;
            }
        }
        this.emit("removed");
    }

    onWindowActivated(w) {
        if (this.busy || !w) return;
        if (w.desktopWindow) {
            // KWin activates the desktop window when you click the wallpaper
            // (and when nothing else is left to focus).
            const out = this.platform.outputName(w);
            if (out) this.stash(this.currentCtx(out));
            return;
        }
        const r = this.managedRoot(w);
        if (!r) return;
        const id = this.platform.id(r);
        const st = this.stageOfWindow(r);
        // keep per-stage recency so the strip shows the last-used window on top
        const i = st.members.indexOf(id);
        if (i > 0) {
            st.members.splice(i, 1);
            st.members.unshift(id);
        }
        if (this.active.get(st.ctx) === st.id) {
            this.emit("focus");
            return;
        }
        if (this.config.autoSwitch) {
            this.switchTo(st.id, { focus: w });
        } else {
            // Auto-switch off: let the window show on top of the current stage
            // without changing membership. It's hidden again on the next switch.
            this.hider.show(this.groupFor(r));
        }
    }

    onMinimizedChanged(w) {
        if (this.busy) return;
        this.emit("geometry");
        if (w.minimized) return;
        if (this.hider.kind === Strategy.Minimize && this.hider.isHidden(w)) {
            // Restored by someone else (taskbar, script, Overview). Treat it as
            // a request for this window, the same as focusing it.
            this.hider.forget(w);
            this.onWindowActivated(w);
        }
    }

    onCurrentDesktopChanged() {
        this.emit("desktop");
    }

    onScreensChanged() {
        this.scheduleReconcile();
        this.emit("screens");
    }

    // ----- reconcile: outputs / desktops / manageability changed -----------
    scheduleReconcile() {
        if (this.reconcilePending) return;
        this.reconcilePending = true;
        this.platform.defer(() => {
            this.reconcilePending = false;
            if (this.busy) {
                this.scheduleReconcile();
                return;
            }
            this.reconcile();
        });
    }

    reconcile() {
        const touched = new Set();

        for (const st of Array.from(this.stages.values())) {
            const groups = new Map(); // ctx -> [ids] (MRU order kept)
            for (const id of st.members.slice()) {
                const w = this.windows.get(id);
                const ctx = w && classify(w, this.platform) === "manage" ? this.effectiveCtx(w) : null;
                if (ctx === null) {
                    // Pinned to all desktops, now skip-taskbar, etc. Stop managing.
                    this.removeMember(st, id);
                    if (w) this.hider.show(this.groupFor(w));
                    touched.add(st.ctx);
                    continue;
                }
                if (!groups.has(ctx)) groups.set(ctx, []);
                groups.get(ctx).push(id);
            }
            if (!st.members.length) {
                this.deleteStage(st);
                touched.add(st.ctx);
                continue;
            }
            if (groups.size === 1 && groups.has(st.ctx)) continue;

            // The group holding the stage's most recent window keeps the stage.
            const keepCtx = Array.from(groups.keys()).find(c => groups.get(c).indexOf(st.members[0]) >= 0);
            for (const [ctx, ids] of groups) {
                touched.add(ctx);
                if (ctx === keepCtx) continue;
                const ns = this.newStage(ctx);
                ns.lastUsed = st.lastUsed;
                for (const id of ids) {
                    this.removeMember(st, id);
                    ns.members.push(id);
                    this.windowStage.set(id, ns.id);
                }
            }
            if (keepCtx !== st.ctx) {
                touched.add(st.ctx);
                if (this.active.get(st.ctx) === st.id) this.active.delete(st.ctx);
                st.ctx = keepCtx;
            }
        }

        // Windows we track but don't manage yet (e.g. just un-pinned from all desktops).
        for (const [id, w] of this.windows) {
            if (this.windowStage.has(id) || classify(w, this.platform) !== "manage") continue;
            const st = this.adopt(w);
            if (st) touched.add(st.ctx);
        }

        // Restore the one-visible-stage invariant where things moved.
        const aw = this.managedRoot(this.platform.activeWindow());
        const awStage = aw ? this.stageOfWindow(aw) : null;
        for (const ctx of touched) {
            let target = null;
            if (awStage && awStage.ctx === ctx) target = awStage.id;
            else if (this.stages.has(this.active.get(ctx))) target = this.active.get(ctx);
            else if (!this.stashed.has(ctx)) {
                const s = this.stagesIn(ctx)[0];
                if (s) target = s.id;
            }
            if (target !== null) this.switchTo(target, { noFocus: true });
            else {
                this.active.delete(ctx);
                this.hideAllIn(ctx);
            }
        }
        if (touched.size) this.emit("reconcile");
    }

    // ----- keeping windows clear of the strip -------------------------------
    setStripVisible(v) {
        this.config.stripVisible = !!v;
        if (v) {
            for (const [, sid] of this.active) {
                const st = this.stages.get(sid);
                if (st) for (const m of st.members) this.scheduleClearance(this.windows.get(m));
            }
        } else {
            for (const id of this.adjusted) {
                const w = this.windows.get(id);
                if (w) this.platform.remaximize(w);
            }
            this.adjusted.clear();
        }
        this.emit("strip");
    }

    scheduleClearance(w) {
        if (!w) return;
        this.platform.defer(() => this.applyClearance(w));
    }

    // Returns the rect to apply, or null. Pure apart from reading w.
    clearanceFor(w, area) {
        if (!this.config.stripVisible || !this.config.keepClear) return null;
        if (w.fullScreen || w.minimized || this.hider.isHidden(w)) return null;
        const g = w.frameGeometry;
        const left = area.x + this.config.stripWidth;
        if (g.x >= left - 0.5) return null;
        const right = area.x + area.width;
        // Quick-tiled windows (`tile` is set) count as edge-attached, like
        // maximized ones. `tile` exists in KWin 6.x; older builds return undefined.
        const edgeAttached = (w.maximizeMode & MAXIMIZE_HORIZONTAL) !== 0 || !!w.tile;
        if (edgeAttached) {
            if (this.config.maximizedPolicy === MaximizedPolicy.Ignore) return null;
            if (this.config.maximizedPolicy === MaximizedPolicy.Offset)
                return { x: left, y: g.y, width: g.width, height: g.height, maximized: true };
            return { x: left, y: g.y, width: Math.max(1, g.x + g.width - left), height: g.height, maximized: true };
        }
        if (!w.moveable) return null;
        let width = g.width;
        if (left + width > right && w.resizeable) width = Math.max(1, right - left);
        return { x: left, y: g.y, width: width, height: g.height, maximized: false };
    }

    applyClearance(w) {
        const id = this.platform.id(w);
        if (!this.windows.has(id) || !this.windowStage.has(id)) return;
        const st = this.stageOfWindow(w);
        if (this.active.get(st.ctx) !== st.id) return;
        const r = this.clearanceFor(w, this.platform.maximizeArea(w));
        if (!r) return;
        this.platform.setGeometry(w, r);
        if (r.maximized) this.adjusted.add(id);
    }
}

function safeConnect(sig, fn) {
    if (sig && typeof sig.connect === "function") sig.connect(fn);
}
function safeDisconnect(sig, fn) {
    try {
        if (sig && typeof sig.disconnect === "function") sig.disconnect(fn);
    } catch (e) {
        // the window may already be gone
    }
}

// ---------------------------------------------------------------------------
// KWin adapter. Built from main.qml, which passes in the QML globals because an
// ES module can't see Workspace/KWin/Qt by itself.
//
//   env = { workspace: Workspace, kwin: KWin, rect: Qt.rect, defer: Qt.callLater, log }
// ---------------------------------------------------------------------------
export function createKWinPlatform(env) {
    const ws = env.workspace;
    const KW = env.kwin;
    const toArray = list => {
        const out = [];
        if (!list) return out;
        for (let i = 0; i < list.length; i++) out.push(list[i]);
        return out;
    };
    const p = {
        id(w) {
            // internalId is a QUuid; String() gives "{xxxxxxxx-...}".
            return String(w.internalId);
        },
        // Declarative scripts get `Workspace.windows` (a QQmlListProperty).
        // `windowList()` exists only on the imperative JS-script workspace
        // (QtScriptWorkspaceWrapper), checked against libkwin 6.7.
        windows() {
            if (ws.windows !== undefined) return toArray(ws.windows);
            return toArray(ws.windowList());
        },
        stackingOrder() {
            return toArray(ws.stackingOrder);
        },
        activeWindow() {
            return ws.activeWindow;
        },
        activate(w) {
            ws.activeWindow = w;
        },
        raise(w) {
            ws.raiseWindow(w);
        },
        // Our strip is a KWin internal window: on 6.7 it reports normalWindow
        // true and an empty resourceClass, so the title is the only reliable tell.
        isOwnWindow(w) {
            return w.caption === STRIP_TITLE;
        },
        outputName(w) {
            return w.output ? String(w.output.name) : "";
        },
        desktopsOf(w) {
            return toArray(w.desktops);
        },
        // null = on all desktops (or none): we leave those windows alone.
        desktopIdOf(w) {
            if (w.onAllDesktops) return null;
            const d = toArray(w.desktops);
            if (d.length !== 1) return null;
            const hidden = p.findHiddenDesktop();
            if (hidden && d[0] === hidden) return null;
            return String(d[0].id);
        },
        currentDesktop() {
            return ws.currentDesktop;
        },
        // KWin 6 can track a current desktop per output (currentDesktopForScreen),
        // but by default all outputs share one. We use the global one.
        currentDesktopId() {
            return ws.currentDesktop ? String(ws.currentDesktop.id) : "";
        },
        transientsOf(w) {
            return p.windows().filter(t => t !== w && t.transient && rootOf(t) === w);
        },
        findHiddenDesktop() {
            return toArray(ws.desktops).find(d => d.name === HIDDEN_DESKTOP_NAME) || null;
        },
        ensureHiddenDesktop() {
            let d = p.findHiddenDesktop();
            if (d) return d;
            // createDesktop(position, name) returns void in the scripting API,
            // so look the desktop up by name afterwards.
            ws.createDesktop(ws.desktops.length, HIDDEN_DESKTOP_NAME);
            d = p.findHiddenDesktop();
            if (!d) env.log("could not create hidden desktop");
            return d;
        },
        removeHiddenDesktop() {
            const d = p.findHiddenDesktop();
            if (d) ws.removeDesktop(d);
        },
        maximizeArea(w) {
            return ws.clientArea(KW.MaximizeArea, w);
        },
        setGeometry(w, r) {
            // UNCERTAIN: on a maximized window this sets the geometry while
            // maximizeMode stays MaximizeFull. KWin 6.7 keeps it, but a later
            // workarea change (panel resize, output change) may re-apply the
            // full maximize geometry. We re-check on maximizedChanged.
            w.frameGeometry = env.rect(r.x, r.y, r.width, r.height);
        },
        remaximize(w) {
            if (w.maximizeMode === 3) {
                w.setMaximize(false, false);
                w.setMaximize(true, true);
            }
        },
        defer(fn) {
            env.defer(fn);
        },
        log(msg) {
            env.log("[stagemanager] " + msg);
        },
    };
    return p;
}

// Wire KWin's workspace signals to a StageManager. Returns a disconnect function.
export function attachToWorkspace(sm, ws) {
    let lastDesktop = ws.currentDesktop;
    const handlers = [
        [ws.windowAdded, w => {
            // Menus and popups count right away; everything else waits a tick.
            sm.trackAbove(w);
            sm.platform.defer(() => {
                if (!w.deleted) sm.onWindowAdded(w);
            });
        }],
        [ws.windowRemoved, w => sm.onWindowRemoved(w)],
        [ws.windowActivated, w => sm.onWindowActivated(w)],
        [ws.currentDesktopChanged, () => {
            // Don't let anyone navigate onto the hidden desktop.
            const hidden = sm.hider.kind === Strategy.HiddenDesktop ? sm.platform.findHiddenDesktop() : null;
            if (hidden && ws.currentDesktop === hidden && lastDesktop && lastDesktop !== hidden) {
                ws.currentDesktop = lastDesktop;
                return;
            }
            lastDesktop = ws.currentDesktop;
            sm.onCurrentDesktopChanged();
        }],
        [ws.screensChanged, () => sm.onScreensChanged()],
    ];
    for (const [sig, fn] of handlers) safeConnect(sig, fn);
    return () => {
        for (const [sig, fn] of handlers) safeDisconnect(sig, fn);
    };
}
