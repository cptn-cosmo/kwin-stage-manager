// Minimal stand-ins for the KWin objects the logic touches.

export class Signal {
    constructor() {
        this.handlers = [];
    }
    connect(fn) {
        this.handlers.push(fn);
    }
    disconnect(fn) {
        this.handlers = this.handlers.filter(h => h !== fn);
    }
    emit(...args) {
        for (const h of this.handlers.slice()) h(...args);
    }
}

let nextId = 1;

export class FakeWindow {
    constructor(ws, opts = {}) {
        this.ws = ws;
        this.internalId = "{w" + nextId++ + "}";
        this.resourceClass = opts.cls || "app";
        this.caption = opts.caption || this.resourceClass;
        this.captionNormal = this.caption;
        this.normalWindow = opts.normalWindow !== false;
        this.specialWindow = false;
        this.skipTaskbar = !!opts.skipTaskbar;
        this.managed = true;
        this.deleted = false;
        this.transient = !!opts.transientFor;
        this.transientFor = opts.transientFor || null;
        this.output = opts.output || ws.screens[0];
        this._desktops = [opts.desktop || ws.currentDesktop];
        this.onAllDesktops = false;
        this._minimized = !!opts.minimized;
        this.maximizeMode = opts.maximizeMode || 0;
        this.fullScreen = false;
        this.moveable = true;
        this.resizeable = true;
        this.move = false;
        this.resize = false;
        this.frameGeometry = opts.geometry || { x: 400, y: 100, width: 800, height: 600 };
        for (const s of ["outputChanged", "desktopsChanged", "skipTaskbarChanged", "interactiveMoveResizeFinished",
                         "minimizedChanged", "maximizedChanged", "fullScreenChanged"])
            this[s] = new Signal();
    }
    get minimized() {
        return this._minimized;
    }
    set minimized(v) {
        if (v === this._minimized) return;
        this._minimized = v;
        this.minimizedChanged.emit();
        // KWin moves focus away from a window that gets minimized.
        if (v && this.ws.activeWindow === this) this.ws.setActive(null);
    }
    get desktops() {
        return this._desktops;
    }
    set desktops(v) {
        this._desktops = v.slice();
        this.desktopsChanged.emit();
    }
    setMaximize() {}
}

export class FakeWorkspace {
    constructor() {
        this.screens = [{ name: "DP-1" }, { name: "DP-2" }];
        this.desktops = [{ id: "d1", name: "Desktop 1" }, { id: "d2", name: "Desktop 2" }];
        this.currentDesktop = this.desktops[0];
        this.windows = [];
        this.stackingOrder = [];
        this._active = null;
        this.windowAdded = new Signal();
        this.windowRemoved = new Signal();
        this.windowActivated = new Signal();
        this.currentDesktopChanged = new Signal();
        this.screensChanged = new Signal();
        this.raised = [];
    }
    get activeWindow() {
        return this._active;
    }
    set activeWindow(w) {
        this.setActive(w);
    }
    setActive(w) {
        if (this._active === w) return;
        this._active = w;
        this.windowActivated.emit(w);
    }
    raiseWindow(w) {
        this.raised.push(w);
        this.stackingOrder = this.stackingOrder.filter(x => x !== w).concat([w]);
    }
    createDesktop(pos, name) {
        this.desktops.splice(pos, 0, { id: "d" + (this.desktops.length + 1) + "-" + name, name });
    }
    removeDesktop(d) {
        this.desktops = this.desktops.filter(x => x !== d);
    }
    clientArea(_opt, _w) {
        return { x: 0, y: 0, width: 1920, height: 1080 };
    }
    // test helpers
    open(opts = {}) {
        const w = new FakeWindow(this, opts);
        this.windows.push(w);
        this.stackingOrder.push(w);
        return w;
    }
    add(opts = {}) {
        const w = this.open(opts);
        this.windowAdded.emit(w);
        if (!w.minimized && !w.transient) this.setActive(w);
        return w;
    }
    close(w) {
        this.windows = this.windows.filter(x => x !== w);
        this.stackingOrder = this.stackingOrder.filter(x => x !== w);
        w.deleted = true;
        this.windowRemoved.emit(w);
        if (this._active === w) this.setActive(null);
    }
}

// A deferred-call queue we drain by hand, standing in for Qt.callLater.
export function makeEnv(ws) {
    const queue = [];
    const env = {
        workspace: ws,
        kwin: { MaximizeArea: 2 },
        rect: (x, y, width, height) => ({ x, y, width, height }),
        defer: fn => queue.push(fn),
        log: () => {},
        flush() {
            for (let i = 0; i < 100 && queue.length; i++) {
                const batch = queue.splice(0);
                for (const fn of batch) fn();
            }
        },
    };
    return env;
}
