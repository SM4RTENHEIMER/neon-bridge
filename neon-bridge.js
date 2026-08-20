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
//  With more than one Neon connected, all of them are merged behind a single
//  virtual device by default. The units are already told apart by the deck in
//  their status byte, and each Neon stores LED state per deck while showing
//  only the active one — so LED output can simply go to every unit and land in
//  the right place. Pass --separate for one virtual device per unit instead.
//
//  Flags:  --show      print the colour assignment and exit, without touching MIDI
//          --monitor   log every message passing through
//          --rb        launch rekordbox once the virtual ports exist
//          --link      send the SysEx that enables decks 3+4 on a daisy-chained pair
//          --separate  give each connected Neon its own virtual device
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

// Hot cues get one colour each, by pad number. This is rekordbox's own colour
// set, in rekordbox's own order (Pink Red Orange Yellow Green Aqua Blue Purple),
// so the pads line up with what the software shows instead of being one slot off.
const HOTCUE = [C.PINK, C.RED, C.ORANGE, C.YELLOW, C.GREEN, C.CYAN, C.BLUE, C.PURPLE];

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

// Mirrored to a file so a running bridge can be inspected from outside.
// The previous session's log is kept rather than overwritten — whatever went
// wrong last time is usually only visible in the log from last time.
const LOGFILE = path.join(__dirname, 'bridge.local.log');
const LOGDIR  = path.join(__dirname, 'logs');
const KEEP    = 20;
let rotatedTo = null;

try {
  if (fs.existsSync(LOGFILE) && fs.statSync(LOGFILE).size > 0) {
    fs.mkdirSync(LOGDIR, { recursive: true });
    const d = fs.statSync(LOGFILE).mtime;
    const two = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` +
                  `_${two(d.getHours())}${two(d.getMinutes())}`;
    let name = `bridge-${stamp}.log`;
    for (let n = 2; fs.existsSync(path.join(LOGDIR, name)); n++)
      name = `bridge-${stamp}-${n}.log`;
    fs.renameSync(LOGFILE, path.join(LOGDIR, name));
    rotatedTo = name;

    // Keep the newest KEEP, drop the rest.
    const old = fs.readdirSync(LOGDIR)
      .filter(f => /^bridge-.*\.log$/.test(f))
      .sort()
      .slice(0, -KEEP);
    for (const f of old) fs.unlinkSync(path.join(LOGDIR, f));
  }
  fs.writeFileSync(LOGFILE, '');
} catch {}
const say = s => {
  console.log(s);
  try { fs.appendFileSync(LOGFILE, s + '\n'); } catch {}
};

// Message traffic always goes to the log file, but only to the terminal with
// --monitor. Capped so a long session cannot fill the disk.
let traced = 0;
const TRACE_CAP = 5000;
const trace = s => {
  if (MONITOR) console.log(s);
  if (traced < TRACE_CAP) {
    try { fs.appendFileSync(LOGFILE, s + '\n'); } catch {}
    if (++traced === TRACE_CAP) {
      try { fs.appendFileSync(LOGFILE, `\n[trace stopped after ${TRACE_CAP} messages]\n`); } catch {}
    }
  }
};

// Which deck a unit is on, read from the status byte of anything it sends.
const DECK_OF = {0x93:'A', 0x94:'B', 0x95:'C', 0x96:'D',
                 0x97:'A', 0x98:'B', 0x99:'C', 0x9A:'D'};
const unitDeck = [];        // unit index -> 'A'|'B'|'C'|'D'

function reportDecks() {
  const seen = unitDeck.filter(Boolean);
  if (seen.length < 2) return;
  const clash = seen.length !== new Set(seen).size;
  say('\n  decks: ' + unitDeck.map((d, i) => `unit ${i+1} = ${d || '?'}`).join(', ') +
      (clash ? '\n  !! two units are on the same deck — press a BANK/DECK button on one of them' : ''));
}

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

// Two Neons report the same port name, so outputs must be paired with inputs
// by position among the Neon ports — matching on name gives every unit the
// same output port, and only one of them ever lights.
const scanOut = new midi.Output();
const outPorts = [];
for (let i = 0; i < scanOut.getPortCount(); i++)
  if (isNeon(scanOut.getPortName(i))) outPorts.push(i);
devices.forEach((d, n) => { d.out = outPorts[n]; });

if (outPorts.length !== devices.length)
  console.warn(`warning: ${devices.length} Neon inputs but ${outPorts.length} outputs — ` +
               'some units will not light');

if (devices.length === 0) {
  console.error('No Neon found. Is it plugged in?');
  process.exit(1);
}
for (const d of devices) if (d.out === undefined) {
  console.error('A Neon input has no matching output port. Unplug and replug it.');
  process.exit(1);
}

// ─────────────────────────── build the bridges ───────────────────────────
const hex = m => m.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

let heardFromRb = false;

// One virtual device fed by one or more physical units.
function createBridge(virtualName, units) {
  const mappingFile = path.join(MAPPING_DIR, `${virtualName}.midi.csv`);

  const toRb = new midi.Output(), fromRb = new midi.Input();
  toRb.openVirtualPort(virtualName);
  fromRb.openVirtualPort(virtualName);
  fromRb.ignoreTypes(false, true, true);

  const ports = units.map((u, i) => {
    const from = new midi.Input(), to = new midi.Output();
    from.openPort(u.in);
    to.openPort(u.out);
    from.ignoreTypes(false, true, true);
    const tag = units.length > 1 ? `[unit ${i + 1}] ` : '';
    from.on('message', (dt, m) => {          // merged: every unit feeds one port
      toRb.sendMessage(m);
      const deck = DECK_OF[m[0]];
      if (deck && unitDeck[i] !== deck) { unitDeck[i] = deck; reportDecks(); }

      // A button press on 93-96 is a deck or performance-mode change: the unit
      // has just rearranged its own LEDs, so put the state back.
      if (m[0] >= 0x93 && m[0] <= 0x96 && m[2] > 0) {
        clearTimeout(replayTimer[i]);
        replayTimer[i] = setTimeout(() => replay(i), 200);
      }

      trace(`${tag}neon ${hex(m)}  ->  rb`);
    });
    return to;
  });

  // rekordbox only sends LED state when something changes. A Neon rearranges
  // its LEDs in hardware when you press a DECK or performance-mode button, and
  // rekordbox never hears about it — so the pads go dark and stay dark. Keeping
  // the last value sent for every address lets the bridge restore it.
  const lastSent = new Map();
  const raw  = m => { for (const to of ports) to.sendMessage(m); };
  const send = m => {                       // cache only what rekordbox drives
    if (m.length === 3 && (m[0] & 0xF0) === 0x90) lastSent.set(`${m[0]},${m[1]}`, m[2]);
    raw(m);
  };

  const replayTimer = [];
  const replay = i => {
    const to = ports[i];
    if (!to || !lastSent.size) return;
    const msgs = [...lastSent].map(([key, vel]) => {
      const [st, note] = key.split(',').map(Number);
      return [st, note, vel];
    });
    // Paced in small batches: a burst of several hundred messages is enough to
    // overrun the controller's buffer, and dropped messages look like dead pads.
    const BATCH = 24;
    (function pump(n) {
      for (let k = n; k < Math.min(n + BATCH, msgs.length); k++) to.sendMessage(msgs[k]);
      if (n + BATCH < msgs.length) setTimeout(() => pump(n + BATCH), 8);
    })(0);
    say(`  unit ${i + 1} changed deck or mode — restored ${msgs.length} LED states`);
  };

  let lookup = readMapping(mappingFile);

  const colorAt = (status, note) => {
    const hit = lookup.get(`${status},${note}`);
    if (hit) return hit.color;
    const mode = MODE[note & 0xF8];                 // fallback: by hardware mode
    return (DECKS.includes(status) && mode) ? MODE_PALETTE[mode][note & 0x07] : null;
  };

  fromRb.on('message', (dt, m) => {
    if (!heardFromRb) { heardFromRb = true; say('\n  rekordbox is sending — mapping is live.'); }
    const [status, note, vel] = m;
    const isOn  = (status & 0xF0) === 0x90;
    const isOff = (status & 0xF0) === 0x80;

    if (m.length === 3 && (isOn || isOff)) {
      const st = isOff ? (status | 0x10) : status;  // note off -> note on, vel 0
      const color = colorAt(st, note);
      if (color !== null) {
        const out = (isOff || vel === 0) ? 0 : color;
        send([st, note, out]);
        trace(`rb ${hex(m)}  ->  neon ${hex([st, note, out])}   ${out ? (COLOR_NAME[out] || out) : 'off'}`);
        return;
      }
    }
    send(m);                                        // everything else passes through
    trace(`rb ${hex(m)}  ->  neon (unchanged)`);
  });

  const allOff = () => {                    // not cached: this is not real state
    lastSent.clear();
    for (const deck of DECKS)
      for (const base of MODE_BASES)
        for (let i = 0; i < 8; i++) raw([deck, base + i, 0]);
    for (let p = 0x20; p <= 0x47; p++) raw([0x9B, p, 0]);    // status LEDs
  };

  // Reloop's link protocol: tells a daisy-chained pair that decks 3+4 exist.
  const enableDecks34 = () => send([0xF0, 0x0A, 0x00, 0xF7]);

  const summary = () => {
    const feeds = units.length > 1 ? ` (${units.length} units merged)` : '';
    console.log(`  "${virtualName}"${feeds}`);
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
        console.log(`\nmapping changed — ${lookup.size} pads re-coloured`);
      }
    });
  } catch {}

  return { allOff, enableDecks34, summary };
}

// Merged by default; --separate gives each unit its own virtual device.
const bridges = process.argv.includes('--separate')
  ? devices.map((d, i) => createBridge(i === 0 ? 'NEON Bridge' : `NEON Bridge ${i + 1}`, [d]))
  : [createBridge('NEON Bridge', devices)];

// ─────────────────────────── start up, shut down ───────────────────────────
for (const b of bridges) b.allOff();

if (process.argv.includes('--link')) {
  for (const b of bridges) b.enableDecks34();
  console.log('link mode: sent F0 0A 00 F7 — decks 3+4 enabled\n');
}

if (rotatedTo) say(`previous log kept as logs/${rotatedTo}\n`);
say(`bridge running — ${devices.length} Neon${devices.length > 1 ? 's' : ''} connected:\n`);
for (const b of bridges) { b.summary(); console.log(); }

// rekordbox enumerates MIDI devices at launch, so the order cannot be fixed later.
if (process.argv.includes('--rb')) {
  require('child_process')
    .spawn('open', ['-a', 'rekordbox'], { detached: true, stdio: 'ignore' })
    .unref();
  say('launching rekordbox — the virtual ports are up.\n');
}

setTimeout(() => {
  if (heardFromRb) return;
  say('\n  nothing received from rekordbox yet. Check that:');
  say('   - rekordbox was started AFTER this bridge');
  say('   - Preferences > Controller > MIDI has a mapping on "NEON Bridge"');
  say('   - a track with hot cues is loaded on the deck your unit is set to');
}, 20000);

console.log('ctrl-c to stop.' + (MONITOR ? '  monitor on.\n' : '\n'));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const b of bridges) b.allOff();
  setTimeout(() => { console.log('\nbridge stopped.'); process.exit(0); }, 150);
});
