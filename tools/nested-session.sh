#!/bin/bash
# Run the script in a throwaway nested KWin, isolated from your real config.
#
#   tools/nested-session.sh            # windowed nested KWin you can click around in
#   tools/nested-session.sh --virtual  # headless (CI / smoke test)
#   OUTPUTS=2 tools/nested-session.sh  # two outputs
#
# Opens three KWrite windows, loads the script, and prints KWin's script log.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/ksm-nested.XXXX) # short path: Wayland socket paths max out at 108 bytes
mkdir -p "$work"/{config,data,cache,run}
chmod 700 "$work/run"
trap 'rm -rf "$work"' EXIT

backend=()
[[ ${1:-} == --virtual ]] && backend=(--virtual)

cat > "$work/session.sh" <<EOF
#!/bin/bash
export WAYLAND_DISPLAY=ksm-nested QT_QPA_PLATFORM=wayland
sleep 2
for n in one two three; do kwrite "$work/\$n.txt" >/dev/null 2>&1 & sleep 1.5; done
id=\$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadDeclarativeScript "$here/package/contents/ui/main.qml" kwin-stage-manager)
qdbus6 org.kde.KWin /Scripting/Script\$id org.kde.kwin.Script.run
${backend:+sleep 5; exit 0}
wait
EOF
chmod +x "$work/session.sh"

env -i LANG=C.UTF-8 HOME="$HOME" PATH="$PATH" USER="$USER" \
    XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" \
    XDG_CACHE_HOME="$work/cache" XDG_RUNTIME_DIR="$work/run" \
    WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
    QT_FORCE_STDERR_LOGGING=1 QT_LOGGING_RULES="js=true;qml=true" \
    dbus-run-session -- kwin_wayland "${backend[@]}" --output-count "${OUTPUTS:-1}" \
        --socket ksm-nested --width 1600 --height 900 \
        --exit-with-session "$work/session.sh" 2>&1 \
    | grep --line-buffered -E '^(qml|js):|stagemanager|main\.qml|StripWindow|StageTile|\.mjs'
