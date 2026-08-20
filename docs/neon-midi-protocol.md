# Reloop Neon — MIDI protocol

Everything here was determined by watching MIDI in and out of the hardware, and
can be reproduced with nothing but a MIDI monitor and a way to send note
messages. No software was disassembled to produce this document.

Reloop's official [NEON MIDI Map][map] documents the buttons, encoders and the
small status LEDs — but **not** the RGB pads. That omission is why the question
"how do I set the pad colour on a Neon?" goes unanswered in most forum threads.
The pad colour section below is the missing piece.

[map]: https://www.reloop.com/media/custom/upload/Reloop-NEON_MIDI-Map.pdf

---

## Pad colour

```
9d  nn  vv
│   │   └─ velocity = (R << 4) | (G << 2) | B    each channel 0-3
│   └───── note number for the pad in the active mode
└───────── 97 98 99 9A = deck A B C D
```

The velocity byte is not an index into a palette. It is three 2-bit fields:

```
bit   6     5   4     3   2     1   0
      ─     R   R     G   G     B   B
    unused  red 0-3   green 0-3 blue 0-3
```

That gives **64 colours**. A channel at 3 is full output; at 0 it is dark.
"Full brightness" therefore means at least one channel sits at 3 — orange
`R3 G1 B0` is exactly as bright as pure red, the two bits of green are what
make it orange rather than dimmer.

This also explains the symptom that sends most people looking: a host that
sends velocity **127** for "LED on" produces `0b1111111`, whose low six bits are
all set, so the pad lights **white** and never anything else.

### Velocity values

Sliced by red level; green down the side, blue across the top.

**R=0**

| | B=0 | B=1 | B=2 | B=3 |
|---|---|---|---|---|
| **G=0** | 0 | 1 | 2 | 3 |
| **G=1** | 4 | 5 | 6 | 7 |
| **G=2** | 8 | 9 | 10 | 11 |
| **G=3** | 12 | 13 | 14 | 15 |

**R=1**

| | B=0 | B=1 | B=2 | B=3 |
|---|---|---|---|---|
| **G=0** | 16 | 17 | 18 | 19 |
| **G=1** | 20 | 21 | 22 | 23 |
| **G=2** | 24 | 25 | 26 | 27 |
| **G=3** | 28 | 29 | 30 | 31 |

**R=2**

| | B=0 | B=1 | B=2 | B=3 |
|---|---|---|---|---|
| **G=0** | 32 | 33 | 34 | 35 |
| **G=1** | 36 | 37 | 38 | 39 |
| **G=2** | 40 | 41 | 42 | 43 |
| **G=3** | 44 | 45 | 46 | 47 |

**R=3**

| | B=0 | B=1 | B=2 | B=3 |
|---|---|---|---|---|
| **G=0** | 48 | 49 | 50 | 51 |
| **G=1** | 52 | 53 | 54 | 55 |
| **G=2** | 56 | 57 | 58 | 59 |
| **G=3** | 60 | 61 | 62 | 63 |

Named colours used by this bridge:

| Name | Velocity | Hex | R G B |
|---|---|---|---|
| RED | 48 | 0x30 | 3 0 0 |
| ORANGE | 52 | 0x34 | 3 1 0 |
| AMBER | 56 | 0x38 | 3 2 0 |
| YELLOW | 60 | 0x3C | 3 3 0 |
| LIME | 44 | 0x2C | 2 3 0 |
| GREEN | 12 | 0x0C | 0 3 0 |
| MINT | 14 | 0x0E | 0 3 2 |
| CYAN | 15 | 0x0F | 0 3 3 |
| SKY | 11 | 0x0B | 0 2 3 |
| BLUE | 3 | 0x03 | 0 0 3 |
| PURPLE | 35 | 0x23 | 2 0 3 |
| MAGENTA | 51 | 0x33 | 3 0 3 |
| PINK | 54 | 0x36 | 3 1 2 |
| WHITE | 63 | 0x3F | 3 3 3 |
| DIM | 21 | 0x15 | 1 1 1 |
| OFF | 0 | 0x00 | 0 0 0 |

---

## Pad addresses

Eight consecutive notes per bank, pad 1 first. Which bank is live depends on
the performance mode selected on the unit.

| Layer | Sampler | Slicer | Hot Cue | Hot Loop |
|---|---|---|---|---|
| 1st | `00-07` | `08-0F` | `10-17` | `18-1F` |
| 1st + shift | `20-27` | `28-2F` | `30-37` | `38-3F` |
| 2nd + shift | `40-47` | `48-4F` | `50-57` | `58-5F` |
| 2nd | `60-67` | `68-6F` | `70-77` | `78-7F` |

Deck comes from the status byte: `97` A, `98` B, `99` C, `9A` D. So Hot Cue
pad 3 on deck B is `98 12 vv`.

Given a note, the mode base is `note & 0xF8` and the pad index is `note & 0x07`.

**Pads are read and written at the same address.** Reloop's own note for the
buttons — "MIDI IN = MIDI OUT" — holds for the pads too, which is why a naive
MIDI-learn mapping does light them, just always in one colour.

Pads are velocity sensitive and send aftertouch on `A7-AA` in the same note
ranges.

---

## The five status LEDs

The small elongated LEDs above each pad in the top row, and below each pad in
the bottom row. **These are not the RGB pads** — they are five fixed-colour
indicators per pad, and they are the only LEDs Reloop's MIDI map describes.

All on channel `9B`, five consecutive notes per pad, velocity controls
brightness only:

| Pad | Notes | | Pad | Notes |
|---|---|---|---|---|
| 1 | `20-24` | | 5 | `34-38` |
| 2 | `25-29` | | 6 | `39-3D` |
| 3 | `2A-2E` | | 7 | `3E-42` |
| 4 | `2F-33` | | 8 | `43-47` |

Colours are wired in hardware and cannot be changed: indicators 1-3 blue,
4 orange, 5 green.

---

## SysEx

| Message | Meaning |
|---|---|
| `F0 0A 40 F7` | sent by the unit when a slave is attached via the link cable |
| `F0 0A 00 F7` | enable decks 3 & 4 |
| `F0 0A 01 F7` | disable deck 4 |
| `F0 0A 02 F7` | disable decks 3 & 4 |

Two Neons joined by the link cable are addressed as four decks, but the host
must send `F0 0A 00 F7` to enable decks 3 & 4. Serato does this on its own.
Hosts that know nothing about Reloop's link protocol do not, which leaves the
slave unit inert — `neon-bridge --link` sends it for you.

### Two units: linked or separate

A linked pair enumerates as **one** MIDI device. The master aggregates both
units and presents them over its own USB connection; the decks are separated in
the status byte, not in the port list.

Giving each unit its own USB cable instead enumerates as **two** devices, both
reporting the same port name `NEON`. They must therefore be told apart by port
index, not by name.

Either way the units are distinguished by deck. Each one announces its current
deck as you press its DECK button — the status byte of everything it sends
moves through `93`/`94`/`95`/`96` for buttons and `97`/`98`/`99`/`9A` for pads.

Useful when driving two units: **a Neon stores LED state per deck and displays
only the active one.** Sending the full LED state for every deck to both units
therefore needs no routing — each unit shows the deck it is set to.

Do not use the link cable and two USB cables at the same time. One signal path
at a time.

---

## How this was determined

1. Reloop's published MIDI map gives the button, encoder and status-LED
   addresses, and the pad input addresses.
2. Sending note-on to a pad's own input address lights it — velocity 2, 8 and
   32 produced blue, green and red, which is a 2-bit-per-channel layout and
   not a palette index.
3. The reading was confirmed by predicting the secondary colours from it:
   `R+G` yellow, `R+B` magenta, `G+B` cyan, all three white.
4. Intermediate levels were confirmed by producing a colour no binary
   on/off scheme can reach — orange, `R3 G1 B0`.

Every step needs only a MIDI monitor and a way to send three bytes.
