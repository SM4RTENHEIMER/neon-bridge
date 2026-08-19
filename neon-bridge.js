#!/usr/bin/env node
//
//  neon-bridge — real pad colours for the Reloop Neon in rekordbox
//
//  rekordbox can only say "on" (velocity 127) and "off" (0). The Neon wants
//  velocity = (R<<4)|(G<<2)|B with each channel 0-3. This bridge sits in
//  between and translates, so the colour is decided here instead.
//
//      NEON ──────────► bridge ──────────► "NEON Bridge" ──► rekordbox
//      NEON ◄── colour ─ bridge ◄────────── "NEON Bridge" ◄── rekordbox
//
//  Colour follows the FUNCTION, not the address: the bridge reads rekordbox's
//  own mapping file and looks up the function name. Remap in rekordbox and the
//  bridge notices by itself.
//
//  Flags:  --show     print the colour assignment and exit, without touching MIDI
//          --monitor  log every message passing through
//          --rb       launch rekordbox once the virtual ports exist
//          --link     send the SysEx that enables decks 3+4 on a daisy-chained pair
//
const midi = require('@julusian/midi');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─────────────────────────── colours ───────────────────────────
// Each channel runs 0-3, giving 64 colours. See docs/neon-midi-protocol.md
const c = (r, g, b) => (r << 4) | (g << 2) | b;

// Every colour runs at full intensity: at least one channel sits at 3.
// DIM is the one deliberate exception — it marks unassigned pads.
const C = {
  RED:  c(3,0,0), ORANGE: c(3,1,0), AMBER:  c(3,2,0), YELLOW:  c(3,3,0),
  LIME: c(2,3,0), GREEN:  c(0,3,0), MINT:   c(0,3,2), CYAN:    c(0,3,3),
  SKY:  c(0,2,3), BLUE:   c(0,0,3), PURPLE: c(2,0,3), MAGENTA: c(3,0,3),
  PINK: c(3,1,2), WHITE:  c(3,3,3), DIM:    c(1,1,1), OFF:     0
};
const COLOR_NAME = Object.fromEntries(Object.entries(C).map(([k, v]) => [v, k]));

// Catches it immediately if a colour is ever edited below full intensity.
for (const [name, v] of Object.entries(C)) {
  if (name === 'DIM' || name === 'OFF') continue;
  if (Math.max((v >> 4) & 3, (v >> 2) & 3, v & 3) !== 3)
    console.warn(`warning: colour ${name} is not at full intensity`);
}

// Hot cues get one colour each, by pad number.
const HOTCUE = [C.RED, C.ORANGE, C.YELLOW, C.GREEN, C.CYAN, C.BLUE, C.PURPLE, C.MAGENTA];

// ─── Rules: rekordbox function name -> colour. First match wins. Edit freely. ───
const RULES = [
  [/^PAD(\d+)_HotCue/,        m => HOTCUE[(+m[1] - 1) % 8]],
  [/^PAD\d+_PadFx[12]/,       () => C.MAGENTA],
  [/^PAD\d+_SlicerLoop/,      () => C.SKY],
  [/^PAD\d+_Slicer/,          () => C.CYAN],
  [/^PAD\d+_BeatJump/,        () => C.BLUE],
  [/^PAD\d+_Sampler/,         () => C.PINK],

  // STEMS — matching the colours rekordbox shows on screen.
  [/^ActivePartVocal/,        () => C.GREEN],
  [/^ActivePartInst/,         () => C.RED],
  [/^ActivePartBass/,         () => C.PURPLE],
  [/^ActivePartDrums/,        () => C.BLUE],
  [/^PartIsolator/,           () => C.SKY],

  // transport
  [/^PlayPause/,              () => C.GREEN],
  [/^Cue$/,                   () => C.ORANGE],
  [/^CueLoop|^Capture/,       () => C.AMBER],
  [/^Sync/,                   () => C.YELLOW],
  [/^Master/,                 () => C.WHITE],
  [/^Slip|^Censor|^Reverse/,  () => C.PURPLE],
  [/^Loop|^BeatLoop|^ReTrigger/, () => C.CYAN],
  [/^Quantize|^KeyLock|^MasterTempo/, () => C.MINT],
  [/^Load|^Browse|^Back|^Forward|^AddToTagList/, () => C.SKY],
  [/^NoFunction/,             () => C.DIM]
];

// Fallback for pads absent from the mapping — coloured by hardware mode.
const MODE_PALETTE = {
  HotCue:  HOTCUE,
  Slicer:  [C.CYAN, C.CYAN, C.SKY, C.SKY, C.BLUE, C.BLUE, C.PURPLE, C.PURPLE],
  Sampler: [C.MAGENTA, C.PINK, C.PURPLE, C.SKY, C.MINT, C.GREEN, C.YELLOW, C.ORANGE],
  HotLoop: [C.GREEN, C.GREEN, C.MINT, C.MINT, C.LIME, C.LIME, C.YELLOW, C.YELLOW]
};

// The Neon's note numbers per pad mode. base = note & 0xF8, pad = note & 0x07.
const MODE = {
  0x00:'Sampler', 0x08:'Slicer', 0x10:'HotCue', 0x18:'HotLoop',   // layer 1
  0x20:'Sampler', 0x28:'Slicer', 0x30:'HotCue', 0x38:'HotLoop',   // layer 1 + shift
  0x40:'Sampler', 0x48:'Slicer', 0x50:'HotCue', 0x58:'HotLoop',   // layer 2 + shift
  0x60:'Sampler', 0x68:'Slicer', 0x70:'HotCue', 0x78:'HotLoop'    // layer 2
};
const DECKS = [0x97, 0x98, 0x99, 0x9A];   // deck A-D
const MODE_BASES = Object.keys(MODE).map(Number);

const MAPPING_DIR = path.join(os.homedir(),
  'Library/Application Support/Pioneer/rekordbox6/MidiMappings');

// ─────────────────────────── read rekordbox's mapping ───────────────────────────
function colorFor(fn) {
  for (const [re, give] of RULES) {
    const m = fn.match(re);
    if (m) return give(m);
  }
  return null;
}

// Returns Map("151,16" -> {color, fn}) built from the function names in the CSV.
function readMapping(file) {
  const lookup = new Map();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return lookup; }

  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('@file')) continue;
    const col = line.split(',');
    const fn = col[0];
    if (!fn) continue;
    const color = colorFor(fn);
    if (color === null) continue;

    for (const field of col.slice(8, 13)) {        // Output + OutputDeck1-4
      if (!/^[0-9A-Fa-f]{4}$/.test(field)) continue;
      const status = parseInt(field.slice(0, 2), 16);
      const note   = parseInt(field.slice(2, 4), 16);
      if (!DECKS.includes(status)) continue;        // pad addresses only
      lookup.set(`${status},${note}`, { color, fn });
    }
  }
  return lookup;
}

function printTable(lookup, indent = '  ') {
  const rows = [...lookup.entries()].sort((a, b) => {
    const [sa, na] = a[0].split(',').map(Number), [sb, nb] = b[0].split(',').map(Number);
    return sa - sb || na - nb;
  });
  for (const [key, v] of rows) {
    const [st, note] = key.split(',').map(Number);
    const mode = MODE[note & 0xF8] || '?';
    console.log(`${indent}${st.toString(16).toUpperCase()} ${note.toString(16).toUpperCase().padStart(2,'0')}  ` +
      `${mode.padEnd(8)} pad ${(note & 7) + 1}   ${v.fn.padEnd(20)} ${COLOR_NAME[v.color] || v.color}`);
  }
}

// --show: print the colour assignment without opening any MIDI port.
if (process.argv.includes('--show')) {
  for (const name of ['NEON Bridge', 'NEON Bridge 2']) {
    const file = path.join(MAPPING_DIR, `${name}.midi.csv`);
    if (!fs.existsSync(file)) continue;
    const lookup = readMapping(file);
    console.log(`\n${name} — ${lookup.size} pads coloured`);
    printTable(lookup);
  }
  process.exit(0);
}

// ─────────────────────────── find the hardware ───────────────────────────
const MONITOR = process.argv.includes('--monitor');
const isNeon = name => /neon/i.test(name) && !/bridge/i.test(name);

// Must happen BEFORE any virtual port exists, or the bridge finds itself.
const scan = new midi.Input();
const devices = [];
for (let i = 0; i < scan.getPortCount(); i++)
  if (isNeon(scan.getPortName(i))) devices.push({ in: i, name: scan.getPortName(i) });
scan.closePort();

const scanOut = new midi.Output();
for (const d of devices)
  for (let i = 0; i < scanOut.getPortCount(); i++)
    if (scanOut.getPortName(i) === d.name) { d.out = i; break; }

if (devices.length === 0) {
  console.error('No Neon found. Is it plugged in?');
  process.exit(1);
}

// ─────────────────────────── one bridge per device ───────────────────────────
const hex = m => m.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const bridges = [];

devices.forEach((device, n) => {
  const virtualName = n === 0 ? 'NEON Bridge' : `NEON Bridge ${n + 1}`;
  const mappingFile = path.join(MAPPING_DIR, `${virtualName}.midi.csv`);

  const fromNeon = new midi.Input(),  toNeon = new midi.Output();
  const fromRb   = new midi.Input(),  toRb   = new midi.Output();

  fromNeon.openPort(device.in);
  toNeon.openPort(device.out);
  fromNeon.ignoreTypes(false, true, true);
  toRb.openVirtualPort(virtualName);
  fromRb.openVirtualPort(virtualName);
  fromRb.ignoreTypes(false, true, true);

  let lookup = readMapping(mappingFile);
  const tag = devices.length > 1 ? `[${n + 1}] ` : '';

  const colorAt = (status, note) => {
    const hit = lookup.get(`${status},${note}`);
    if (hit) return hit.color;
    const mode = MODE[note & 0xF8];                 // fallback: by hardware mode
    return (DECKS.includes(status) && mode) ? MODE_PALETTE[mode][note & 0x07] : null;
  };

  fromRb.on('message', (dt, m) => {
    const [status, note, vel] = m;
    const isOn  = (status & 0xF0) === 0x90;
    const isOff = (status & 0xF0) === 0x80;

    if (m.length === 3 && (isOn || isOff)) {
      const st = isOff ? (status | 0x10) : status;  // note off -> note on, vel 0
      const color = colorAt(st, note);
      if (color !== null) {
        const out = (isOff || vel === 0) ? 0 : color;
        toNeon.sendMessage([st, note, out]);
        if (MONITOR) console.log(`${tag}rb ${hex(m)}  ->  neon ${hex([st, note, out])}   ${out ? (COLOR_NAME[out] || out) : 'off'}`);
        return;
      }
    }
    toNeon.sendMessage(m);                          // everything else passes through
    if (MONITOR) console.log(`${tag}rb ${hex(m)}  ->  neon (unchanged)`);
  });

  fromNeon.on('message', (dt, m) => {
    toRb.sendMessage(m);
    if (MONITOR) console.log(`${tag}neon ${hex(m)}  ->  rb`);
  });

  const allOff = () => {
    for (const deck of DECKS)
      for (const base of MODE_BASES)
        for (let i = 0; i < 8; i++) toNeon.sendMessage([deck, base + i, 0]);
    for (let p = 0x20; p <= 0x47; p++) toNeon.sendMessage([0x9B, p, 0]);  // status LEDs
  };

  // Reloop's link protocol: tells a daisy-chained pair that decks 3+4 exist.
  const enableDecks34 = () => toNeon.sendMessage([0xF0, 0x0A, 0x00, 0xF7]);

  const summary = () => {
    if (lookup.size === 0) {
      console.log(`   ${mappingFile.replace(os.homedir(), '~')}`);
      console.log('   (no mapping found — using mode palettes)');
      return;
    }
    console.log(`   ${lookup.size} pads coloured from your mapping:`);
    printTable(lookup, '     ');
  };

  // rekordbox rewrites this file whenever you remap, so re-read it when it changes.
  try {
    fs.watchFile(mappingFile, { interval: 2000 }, () => {
      const fresh = readMapping(mappingFile);
      if (fresh.size) {
        lookup = fresh;
        console.log(`\n${tag}mapping changed — ${lookup.size} pads re-coloured`);
      }
    });
  } catch {}

  bridges.push({ allOff, enableDecks34, summary, virtualName, deviceName: device.name });
});

// ─────────────────────────── start up, shut down ───────────────────────────
for (const b of bridges) b.allOff();

if (process.argv.includes('--link')) {
  for (const b of bridges) b.enableDecks34();
  console.log('link mode: sent F0 0A 00 F7 — decks 3+4 enabled\n');
}

console.log(`bridge running — ${bridges.length} device${bridges.length > 1 ? 's' : ''}:\n`);
for (const b of bridges) {
  console.log(`  ${b.deviceName}  ->  "${b.virtualName}"`);
  b.summary();
  console.log();
}

// rekordbox enumerates MIDI devices at launch, so the order cannot be fixed later.
if (process.argv.includes('--rb')) {
  require('child_process')
    .spawn('open', ['-a', 'rekordbox'], { detached: true, stdio: 'ignore' })
    .unref();
  console.log('launching rekordbox — the virtual ports are up.\n');
}

console.log('ctrl-c to stop.' + (MONITOR ? '  monitor on.\n' : '\n'));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const b of bridges) b.allOff();
  setTimeout(() => { console.log('\nbridge stopped.'); process.exit(0); }, 150);
});
