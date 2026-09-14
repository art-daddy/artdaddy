#!/usr/bin/env bash
# Drive the shipped macOS app with real keystrokes and judge the result from real pixels.
#
# WHY THIS SHAPE: WKWebView has no CDP, so the Windows UI sweep cannot run here, and System
# Events is the only way to deliver genuine input. A build script runs in the BACKGROUND
# session, which has no display of its own - so this attaches to the console user's desktop
# over VNC, using the credentials Codemagic already issues for this build, and captures through
# the RFB protocol rather than screencapture (an ARD framebuffer is not a CoreGraphics display).
#
# The weakness is obvious - a keystroke that never arrives looks exactly like a feature that
# does nothing - so every step asserts the screen MOVED MORE THAN IT MOVES ON ITS OWN, and what
# the machine can host is established FIRST, so "this runner has no desktop" can never be
# reported as either a pass or an app failure.
set -uo pipefail

OUT=/tmp/macwalk
mkdir -p "$OUT"
FAIL=0
STEP=0
APP="${APP:-/Applications/artdaddy.app}"

# EX_CONFIG. The caller maps this to "this lane could not run here".
UNRUNNABLE=78

say()  { printf '\n=== %s ===\n' "$1"; }
fail() { echo "::error::$1"; FAIL=1; }
skip() { echo "::error::$1"; exit $UNRUNNABLE; }

# ---------------------------------------------------------------- session
say "attach to the console desktop"
[ -n "${CM_API_TOKEN:-}" ] || skip "CM_API_TOKEN not set: cannot ask for this build's VNC credentials."
[ -n "${CM_BUILD_ID:-}" ]  || skip "CM_BUILD_ID not set: not running inside a Codemagic build."

curl -s -H "x-auth-token: $CM_API_TOKEN" \
  "https://codemagic.io/api/v3/builds/$CM_BUILD_ID/remote-access" -o /tmp/ra.json

cat > /tmp/ra.py <<'PY'
import json
try:
    d = json.load(open('/tmp/ra.json'))
    v = (d.get('data') or d)['vnc']
    print(v['username'])
    print(v['password'])
except Exception:
    print(''); print('')
PY
python3 /tmp/ra.py > /tmp/ra.txt 2>/dev/null
VU=$(sed -n 1p /tmp/ra.txt)
PW=$(sed -n 2p /tmp/ra.txt)
[ -n "$PW" ] || skip "No VNC credentials returned - was this build started with remote access enabled?"
VUID=$(id -u "$VU")
echo "  console user: $VU (uid $VUID)"

PY=/tmp/vnv/bin/python
if [ ! -x "$PY" ]; then
  python3 -m venv /tmp/vnv >/dev/null 2>&1
  /tmp/vnv/bin/pip install --quiet vncdotool >/dev/null 2>&1
fi
[ -x "$PY" ] || skip "could not install vncdotool, so there is no way to read the screen."

cat > /tmp/vshot.py <<'PY'
import sys
from vncdotool import api
srv, user, pw, out = sys.argv[1:5]
try:
    c = api.connect(srv, username=(user or None), password=pw)
    c.timeout = 60
    c.refreshScreen()
    c.captureScreen(out)
    print('SHOT %dx%d' % c.screen.size)
except Exception as e:
    print('SHOTFAIL %s: %s' % (type(e).__name__, e))
finally:
    try:
        api.shutdown()
    except Exception:
        pass
PY

cat > /tmp/vcmp.py <<'PY'
import sys
from PIL import Image, ImageChops
# COUNT changed pixels; do not measure the bounding box. getbbox() spans ALL differences, so the
# menu-bar clock at top right plus one Dock pixel at bottom left reports an area covering most of
# the screen. That is why an idle app measured 2996 one moment and 105840 the next, and why one
# action scoring 9849 px twice was judged a pass and then a failure.
try:
    a = Image.open(sys.argv[1]).convert('RGB')
    b = Image.open(sys.argv[2]).convert('RGB')
    d = ImageChops.difference(a, b).convert('L')
    # Ignore near-identical pixels: JPEG-ish noise and subpixel antialiasing are not a UI change.
    print(sum(d.histogram()[24:]))
except Exception:
    print(-1)
PY

# The blue default button of a macOS alert, found by colour rather than coordinates so it
# survives any screen size. Centre band only: the menu bar and Dock are full of blue icons and a
# whole-screen centroid lands between them, on nothing. Lowest cluster only: the alert icon
# carries a blue badge that drags a naive centroid onto the button's top edge.
cat > /tmp/findblue.py <<'PY'
import sys
from PIL import Image
try:
    im = Image.open(sys.argv[1]).convert('RGB')
    w, h = im.size
    px = im.load()
    pts = []
    for y in range(int(h * 0.12), int(h * 0.75)):
        for x in range(int(w * 0.15), int(w * 0.85)):
            r, g, b = px[x, y]
            if b > 170 and b - r > 55 and b - g > 35:
                pts.append((x, y))
    if len(pts) < 150:
        print('')
    else:
        ymax = max(p[1] for p in pts)
        band = [p for p in pts if p[1] >= ymax - h * 0.05] or pts
        print('%d %d' % (sum(p[0] for p in band) // len(band),
                         sum(p[1] for p in band) // len(band)))
except Exception:
    print('')
PY

cat > /tmp/vclick.py <<'PY'
import sys, time
from vncdotool import api
srv, user, pw, x, y = sys.argv[1:6]
try:
    c = api.connect(srv, username=(user or None), password=pw)
    c.timeout = 60
    c.mouseMove(int(x), int(y))
    time.sleep(1)
    c.mousePress(1)
    time.sleep(3)
    print('CLICKED %s,%s' % (x, y))
except Exception as e:
    print('CLICKFAIL %s: %s' % (type(e).__name__, e))
finally:
    try:
        api.shutdown()
    except Exception:
        pass
PY

# Artifacts do NOT publish while remote access holds the machine for its ten minutes, and every
# real finding in this exercise came from opening a picture - so key frames also go out through
# the log, downscaled, to be decoded locally.
cat > /tmp/b64.py <<'PY'
import base64, io, sys
from PIL import Image
try:
    im = Image.open(sys.argv[1]).convert('RGB')
    im.thumbnail((720, 720))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=55)
    d = base64.b64encode(buf.getvalue()).decode()
    print('B64START %s %d' % (sys.argv[1], len(d)))
    for i in range(0, len(d), 200):
        print(d[i:i + 200])
    print('B64END')
except Exception as e:
    print('B64FAIL %s' % e)
PY
b64() { [ -s "$1" ] && "$PY" /tmp/b64.py "$1"; }

VNCSRV="localhost::5900"
grab() { rm -f "$1"; "$PY" /tmp/vshot.py "$VNCSRV" "$VU" "$PW" "$1" >/tmp/vshot.log 2>&1; [ -s "$1" ]; }
grab /tmp/_probe.png || skip "could not open a VNC session with this build's own credentials: $(sed -n 1,3p /tmp/vshot.log)"
echo "  connected: $(sed -n 1p /tmp/vshot.log)"

pgrep -u "$VU" -x Dock >/dev/null 2>&1 || skip "no Dock in $VU's session - that is a login screen, not a desktop."
echo "  Dock is running: a real desktop"

gui() { sudo -n launchctl asuser "$VUID" sudo -u "$VU" "$@"; }
DELIVERY=ok

# Notification banners are ~18k changed pixels landing at an arbitrary moment, and my own VNC
# reconnects raise one ("Viewer has disconnected") - which is almost certainly what produced the
# single passing shortcut in the first real run. Best effort: older keys, newer Focus modes.
gui defaults -currentHost write com.apple.notificationcenterui doNotDisturb -bool true 2>/dev/null
gui defaults -currentHost write com.apple.notificationcenterui doNotDisturbDate -date "2030-01-01 00:00:00 +0000" 2>/dev/null
gui killall NotificationCenter 2>/dev/null || true

# osascript BLOCKS while a consent alert waits, so every call is capped. An uncapped one burned
# a whole build and published no log at all.
osa() { # osa <secs> <applescript>
  local secs=$1
  gui osascript -e "$2" >/tmp/osa.out 2>&1 & local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid"; local rc=$?
  kill -9 "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return $rc
}

# ---------------------------------------------------------------- consent
say "automation permission"
if ! osa 20 'tell application "System Events" to return name of first process'; then
  echo "  System Events did not answer; looking for the consent alert"
  # Writing a TCC row does NOT suppress this - macOS validates csreq and ignores a NULL one.
  # The dialog IS the consent path, and System Events cannot dismiss it, being the thing it is
  # blocked on, so it gets clicked over VNC.
  gui osascript -e 'tell application "System Events" to return name of first process' >/dev/null 2>&1 &
  AE=$!
  sleep 12
  grab /tmp/consent.png || skip "could not photograph the screen while System Events was blocked."
  BTN=$("$PY" /tmp/findblue.py /tmp/consent.png)
  kill -9 $AE 2>/dev/null
  if [ -n "$BTN" ]; then
    echo "  alert default button at $BTN"
    "$PY" /tmp/vclick.py "$VNCSRV" "$VU" "$PW" $BTN
    sleep 4
  else
    echo "  no alert found on screen"
  fi
  osa 30 'tell application "System Events" to return name of first process' \
    || skip "System Events is still blocked after answering the alert - no input can be delivered."
fi
echo "  System Events is permitted"

# ---------------------------------------------------------------- helpers
SHOT=""
shot() {
  STEP=$((STEP + 1))
  local name; name="$(printf '%02d-%s' "$STEP" "$1")"
  SHOT="$OUT/$name.png"
  grab "$SHOT" || { sleep 3; grab "$SHOT"; } || { fail "capture failed at $name"; return 1; }
  echo "  shot $name.png"
}

# The floor an action has to beat, measured immediately before it with NO input. A bare "the
# bytes differ" test passes on the menu-bar clock ticking - 36 pixels in a corner - which is
# exactly how a screen that ignored every keystroke once got reported as responding.
AMB=0; FLOOR=2000
ambient() {
  local a b
  shot "$1-idle1" >/dev/null || return 1; a="$SHOT"
  sleep 4
  shot "$1-idle2" >/dev/null || return 1; b="$SHOT"
  AMB=$("$PY" /tmp/vcmp.py "$a" "$b")
  FLOOR=$(( AMB * 3 )); [ "$FLOOR" -lt 2000 ] && FLOOR=2000
}

# Did the action move the screen by more than the screen moves on its own?
moved() { # moved <before.png> <after.png> <message-if-not>
  local n; n=$("$PY" /tmp/vcmp.py "$1" "$2")
  if [ "$n" -gt "$FLOOR" ]; then
    echo "  moved $n px (ambient $AMB, floor $FLOOR)"
    return 0
  fi
  fail "$3 (moved $n px against an ambient floor of $FLOOR)"
  return 1
}

key() { # key <keystroke-applescript>
  # Check that the keystroke was DELIVERED. This used to discard both streams, so an
  # AppleScript error - `tell process "X"` failing to resolve the name, or the app not being
  # frontmost - typed nothing and looked exactly like a shortcut that does nothing. Every
  # "the pane did not toggle" verdict below is worthless without this.
  if ! osa 15 "tell application \"System Events\" to tell process \"$PROC\" to $1"; then
    fail "keystroke was not delivered ($1): $(sed -n '1,2p' /tmp/osa.out)"
    DELIVERY=broken
  fi
  sleep 2
}

# A keystroke the APP does not own, so it cannot be confused with the feature under test.
# Cmd+M is macOS's own minimise: if the window count does not drop, input is not reaching the
# app and nothing below this line is evidence about the app.
delivery_control() {
  local before after
  osa 12 "tell application \"System Events\" to return (count of windows of process \"$PROC\")"
  before=$(tr -dc '0-9' </tmp/osa.out)
  key 'keystroke "m" using {command down}'
  sleep 2
  osa 12 "tell application \"System Events\" to return (count of windows of process \"$PROC\")"
  after=$(tr -dc '0-9' </tmp/osa.out)
  echo "  windows before=$before after=$after"
  gui open -a "$APP"
  sleep 4
  osa 15 "tell application \"System Events\" to tell process \"$PROC\"
    set frontmost to true
  end tell" >/dev/null 2>&1
  sleep 2
  if [ -n "$before" ] && [ -n "$after" ] && [ "$after" -lt "$before" ]; then
    echo "  keystrokes reach the app (Cmd+M minimised it)"
    return 0
  fi
  fail "Cmd+M did not minimise the window - keystrokes are NOT reaching the app, so no shortcut result below is trustworthy"
  DELIVERY=broken
  return 1
}

# ---------------------------------------------------------------- launch
say "launch"
[ -d "$APP" ] || skip "$APP is not installed on this machine."
EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
PROC="$EXE"
gui open -a "$APP"
for i in $(seq 1 30); do
  sleep 2
  if osa 12 "tell application \"System Events\" to return (count of windows of process \"$PROC\")" \
     && ! grep -qx '0' /tmp/osa.out; then
    echo "  window appeared after $((i * 2))s"; break
  fi
done
pgrep -u "$VU" -x "$EXE" >/dev/null 2>&1 || { fail "the app is not running after launch"; exit 1; }

# Pin geometry so a pixel diff means what it says, run to run.
osa 15 "tell application \"System Events\" to tell process \"$PROC\"
  set frontmost to true
  set position of window 1 to {0, 0}
  set size of window 1 to {1280, 820}
end tell" >/dev/null 2>&1 || echo "  (could not pin the window; continuing)"
sleep 3
shot boot

say "do keystrokes actually reach the app?"
delivery_control

# ---------------------------------------------------------------- the walk
say "pane toggles (Cmd+0 library, Cmd+Alt+A chat, Cmd+Alt+0 inspector)"
ambient before-library
shot library-pre && P="$SHOT"
key 'keystroke "0" using {command down}'
shot library-hidden && A="$SHOT"
moved "$P" "$A" "Cmd+0 changed nothing - the library pane did not toggle"

ambient before-library-back
shot library-back-pre && P="$SHOT"
key 'keystroke "0" using {command down}'
shot library-back && B="$SHOT"
moved "$P" "$B" "Cmd+0 did not restore the library pane"

ambient before-chat
shot chat-pre && P="$SHOT"
key 'keystroke "a" using {command down, option down}'
shot chat-toggled && C="$SHOT"
moved "$P" "$C" "Cmd+Alt+A changed nothing - the chat pane did not toggle"

ambient before-inspector
shot inspector-pre && P="$SHOT"
key 'keystroke "0" using {command down, option down}'
shot inspector-toggled && D="$SHOT"
moved "$P" "$D" "Cmd+Alt+0 changed nothing - the inspector pane did not toggle"

say "timeline keys reach the app (no project open: these must not crash it)"
for k in 'keystroke " "' 'key code 115' 'key code 119' 'keystroke "+"' 'keystroke "-"'; do
  key "$k"
done
shot after-timeline-keys

say "still alive?"
if pgrep -u "$VU" -x "$EXE" >/dev/null 2>&1; then
  echo "  yes - survived $STEP interactions"
  ps -o pid,rss,command -p "$(pgrep -u "$VU" -x "$EXE" | head -1)" | tail -n1
else
  fail "the app died while being driven"
fi

gui osascript -e "tell application \"$EXE\" to quit" >/dev/null 2>&1
pkill -u "$VU" -x "$EXE" 2>/dev/null || true

echo
echo "screenshots in $OUT:"; ls -1 "$OUT"

# The app as it actually looked, through the log, because the artifact upload may not survive
# the remote-access hold.
say "frames"
b64 "$OUT/$(ls -1 "$OUT" | grep -- '-boot.png$' | head -1)"
b64 "$OUT/$(ls -1 "$OUT" | tail -1)"

# A harness that could not type is not a broken app. Report it as unrunnable so nobody "fixes"
# a shortcut on the strength of a keystroke that was never delivered - which is exactly what
# the first green-looking run invited.
if [ "$DELIVERY" = broken ]; then
  echo "::error::keystroke delivery failed, so the shortcut results above are UNTESTED, not failures"
  exit $UNRUNNABLE
fi
exit $FAIL
