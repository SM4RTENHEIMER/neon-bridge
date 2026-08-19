# rekordbox custom MIDI mapping — file format and limits

Notes on how rekordbox stores a custom MIDI mapping, and on one hard limit that
affects every third-party controller with RGB pads.

Everything here was observed from the outside: write a mapping file, import it,
and read back what rekordbox wrote. No software was disassembled. Every claim
below can be reproduced with a text editor and the IMPORT button.

Observed on rekordbox 7 (macOS). The directory name still says `rekordbox6`.

---

## Where mappings live

```
~/Library/Application Support/Pioneer/rekordbox6/MidiMappings/<device>.midi.csv
```

This is the live store, not just an export target. rekordbox creates one file
per MIDI device it has seen, rewrites the file when you remap, and reads it
back at startup. Watching this file is a reliable way to react to a user's
mapping changes.

Line endings are CRLF. The first line is a header:

```
@file,1,<device name>
```

---

## Row format

Fifteen comma-separated columns:

| # | Column | Example |
|---|---|---|
| 0 | function name | `PAD1_HotCue` |
| 1 | deck number | `2` (often blank) |
| 2 | control type | `DdjSxPad` |
| 3 | Input | `9311` |
| 4-7 | InputDeck1-4 | `9710` |
| 8 | Output | `9311` |
| 9-12 | OutputDeck1-4 | `9710` |
| 13 | flags | `Fast;Blink=500;Priority=50;` |
| 14 | comment | |

MIDI messages are **exactly four hex characters**: status byte and first data
byte. Deck-independent controls use columns 3 and 8; deck-specific ones use the
numbered columns.

```
PAD1_HotCue,,DdjSxPad,,9710,,,,,9710,,,,Fast;,
Browse,,Rotary,B604,,,,,,,,,,,
Cue,,Button,,9709,,,,,9709,,,,Fast;Blink=500;Priority=50;,
```

Because rekordbox rewrites the file on import, a round-trip is a cheap way to
find out what the parser accepts: write a value, import, read it back.

### Control types

Verified by round-trip — these survive an import unchanged:

`Button` · `Toggle` · `Value` · `RawValue` · `KnobSlider` · `KnobSliderHiRes` ·
`Difference` · `Rotary` · `RotaryAsKnob` · `JogRotate` · `JogRotateAbsPos` ·
`JogTimestamp` · `JogTouch` · `Indicator` · `IndicatorHiRes` · `JogIndicator` ·
`JogIndicatorHiRes` · `Parameter` · `DdjSxPad` · `DdjSx2Pad` · `DdjSzPad` ·
`DdjRxPad` · `DdjRzPad`

Writing `Pad` gets silently rewritten to `DdjSxPad` on import. This is the
"type keeps changing back" behaviour reported on the forums; the plain `Pad`
type is not reachable from the CSV.

### Flags

Seen in files rekordbox writes itself: `RO;` `Fast;` `Dual;` `Blink=<ms>`
`Value=<n>` `Min=<n>` `Max=<n>` `Priority=<n>`. Unrecognised flags survive a
round-trip untouched, so their presence in a file is not evidence that they do
anything.

---

## The limit: output value cannot be chosen

**rekordbox always sends velocity 127 for "on" and 0 for "off". There is no way
to make it send a different value.**

This matters because controllers with RGB pads generally encode colour in the
value byte. If the host can only send 127, the pad can only ever show whatever
127 means on that hardware — one fixed colour.

Ten separate attempts, all producing 127:

| Attempt | Result |
|---|---|
| type `DdjSxPad` | 127 |
| type `DdjSx2Pad` | 127 |
| type `DdjSzPad` | 127 |
| type `DdjRxPad` | 127 |
| type `DdjRzPad` | 127 |
| type `Indicator` | 127 |
| type `IndicatorHiRes` | 127 |
| type `Toggle` / `Button` / `Value` | 127 |
| flags `Max=44` / `Value=44` / `Blink=44` | 127 |
| three-byte output `97102C` | truncated to `102C` on import |

That last row is the decisive one. The output field is a fixed 16 bits — status
and note. Writing a third byte does not add a velocity; rekordbox keeps the low
two bytes and discards the rest, producing a broken message.

The five `Ddj*Pad` types exist because Pioneer's own Serato-era controllers had
RGB pads, but whatever those types do for first-party hardware, they emit a
plain 127 to a generic MIDI device.

Searching the function list for a colour-carrying output — something like
`PAD1_HotCueColor` — turns up nothing. **The hot cue colour never leaves
rekordbox over MIDI.**

---

## What this means for third-party RGB pads

Colour has to be decided outside rekordbox. The workable shape is a translating
virtual MIDI device between rekordbox and the hardware:

```
controller ──────► bridge ──────► virtual device ──► rekordbox
controller ◄─ colour ─ bridge ◄─── virtual device ◄── rekordbox
```

rekordbox maps to the virtual device and keeps sending 127; the bridge replaces
that with whatever value the hardware needs. This repository is one
implementation for the Reloop Neon, but the approach applies to any controller
whose pad colour lives in the value byte.

Since the mapping file names the *function* behind every address, a bridge can
colour by what a pad does rather than where it sits — and re-read the file when
you remap.

Two ordering constraints worth knowing:

- rekordbox enumerates MIDI devices at launch. A virtual device created
  afterwards will not appear until rekordbox is restarted.
- Leave the real controller mapped in rekordbox as well and it will keep
  driving the hardware directly, overwriting the bridge. Clear that mapping by
  importing a file containing only the `@file` header.
