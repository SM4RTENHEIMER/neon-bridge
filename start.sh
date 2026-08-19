#!/bin/zsh
# Starts the bridge and then rekordbox — in that order, every time.
#
# rekordbox enumerates MIDI devices at launch. If the bridge is not already
# running, the virtual device does not exist and rekordbox will never see it.

MM="$HOME/Library/Application Support/Pioneer/rekordbox6/MidiMappings"
HERE="$(cd "$(dirname "$0")" && pwd)"

# One bridge at a time. Two would create two virtual ports with the same name.
pkill -f "$HERE/neon-bridge.js" 2>/dev/null && echo "stopped a bridge that was already running"

if pgrep -x rekordbox >/dev/null; then
  answer=$(osascript -e 'display dialog "rekordbox is already running.

The bridge has to start BEFORE rekordbox — otherwise rekordbox cannot see the virtual device and the pads stay white.

I can quit rekordbox, start the bridge, and open rekordbox again." buttons {"Cancel","Quit and restart"} default button 2 with title "NEON Bridge" with icon caution' 2>/dev/null)
  if [[ "$answer" != *"Quit and restart"* ]]; then
    echo "cancelled."
    exit 0
  fi
  echo "quitting rekordbox..."
  osascript -e 'tell application "rekordbox" to quit' 2>/dev/null
  for i in {1..60}; do
    pgrep -x rekordbox >/dev/null || break
    sleep 0.5
  done
  if pgrep -x rekordbox >/dev/null; then
    echo "rekordbox did not quit — it may be waiting on a dialog. Close it and run again."
    exit 1
  fi
fi

# Clear the physical NEON mapping so rekordbox stops painting the pads white
# behind the bridge's back.
[ -d "$MM" ] && printf '@file,1,NEON\r\n' > "$MM/NEON.midi.csv"

exec node "$HERE/neon-bridge.js" --rb "$@"
