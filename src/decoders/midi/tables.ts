export type Triplet = readonly [string, string, string];
export type Pair = readonly [string, string];

const names = (source: string): string[] =>
  source
    .trim()
    .split('\n')
    .map((line) => line.slice(line.indexOf('=') + 1));

const triples = (source: string): ReadonlyMap<number, Triplet> =>
  new Map(
    source
      .trim()
      .split('\n')
      .map((line) => {
        const [key, first, second, third] = line.split('|');
        return [Number(key), [first, second, third] as Triplet] as const;
      }),
  );

export const STATUS_BYTES = triples(`
0x80|note off|note off|N off
0x90|note on|note on|N on
0xa0|polyphonic key pressure / aftertouch|key pressure|KP
0xb0|control change|ctrl chg|CC
0xc0|program change|prgm chg|PC
0xd0|channel pressure / aftertouch|channel pressure|CP
0xe0|pitch bend change|pitch bend|PB
0xf0|system exclusive|SysEx|SE
0xf1|MIDI time code quarter frame|MIDI time code|MIDI time
0xf2|song position pointer|song position|song pos
0xf3|song select|song select|song sel
0xf4|undefined 0xf4|undef 0xf4|undef
0xf5|undefined 0xf5|undef 0xf5|undef
0xf6|tune request|tune request|tune req
0xf7|end of system exclusive (EOX)|end of SysEx|EOX
0xf8|timing clock|timing clock|clock
0xf9|undefined 0xf9|undef 0xf9|undef
0xfa|start|start|s
0xfb|continue|continue|cont
0xfc|stop|stop|st
0xfd|undefined 0xfd|undef 0xfd|undef
0xfe|active sensing|active sensing|sensing
0xff|system reset|reset|rst
`);

export const CONTROL_FUNCTIONS = triples(`
0x00|bank select MSB|bank MSB|bank-M
0x01|modulation wheel/lever MSB|modulation MSB|mod-M
0x02|breath controller MSB|breath MSB|breath-M
0x04|foot controller MSB|foot MSB|foot-M
0x05|portamento time MSB|portamento MSB|porta-M
0x06|data entry MSB|data entry MSB|data-M
0x07|channel volume MSB (formerly main volume)|channel volume MSB|ch vol-M
0x08|balance MSB|bal MSB|bal-M
0x0a|pan MSB|pan MSB|pan-M
0x0b|expression controller MSB|expression MSB|expr-M
0x0c|effect control 1 MSB|effect 1 MSB|eff-1-M
0x0d|effect control 2 MSB|effect 2 MSB|eff-2-M
0x10|general purpose controller 1 MSB|GP ctrl 1 MSB|GPC-1-M
0x11|general purpose controller 2 MSB|GP ctrl 2 MSB|GPC-2-M
0x12|general purpose controller 3 MSB|GP ctrl 3 MSB|GPC-3-M
0x13|general purpose controller 4 MSB|GP ctrl 4 MSB|GPC-4-M
0x20|bank select LSB|bank LSB|bank-L
0x21|modulation wheel/lever LSB|modulation LSB|mod-L
0x22|breath controller LSB|breath LSB|breath-L
0x24|foot controller LSB|foot LSB|foot-L
0x25|portamento time LSB|portamento LSB|porta-L
0x26|data entry LSB|data entry LSB|data-L
0x27|channel volume LSB (formerly main volume)|channel volume LSB|ch vol-L
0x28|balance LSB|bal LSB|bal-L
0x2a|pan LSB|pan LSB|pan-L
0x2b|expression controller LSB|expression LSB|expr-L
0x2c|effect control 1 LSB|effect 1 LSB|eff-1-L
0x2d|effect control 2 LSB|effect 2 LSB|eff-2-L
0x30|general purpose controller 1 LSB|GP ctrl 1 LSB|GPC-1-L
0x31|general purpose controller 2 LSB|GP ctrl 2 LSB|GPC-2-L
0x32|general purpose controller 3 LSB|GP ctrl 3 LSB|GPC-3-L
0x33|general purpose controller 4 LSB|GP ctrl 4 LSB|GPC-4-L
0x40|damper pedal (sustain)|sustain|sust
0x41|portamento on/off|porta on/off|porta on/off
0x42|sostenuto|sostenuto|sostenuto
0x43|soft pedal|soft pedal|soft pedal
0x44|legato footswitch|legato switch|legato
0x45|hold 2|hold 2|hold 2
0x46|sound controller 1 (default: sound variation)|sound ctrl 1|snd ctrl 1
0x47|sound controller 2 (default: timbre / harmonic intensity)|sound ctrl 2|snd ctrl 2
0x48|sound controller 3 (default: release time)|sound ctrl 3|snd ctrl 3
0x49|sound controller 4 (default: attack time)|sound ctrl 4|snd ctrl 4
0x4a|sound controller 5 (default: brightness)|sound ctrl 5|snd ctrl 5
0x4b|sound controller 6 (GM2 default: decay time)|sound ctrl 6|snd ctrl 6
0x4c|sound controller 7 (GM2 default: vibrato rate)|sound ctrl 7|snd ctrl 7
0x4d|sound controller 8 (GM2 default: vibrato depth)|sound ctrl 8|snd ctrl 8
0x4e|sound controller 9 (GM2 default: vibrato delay)|sound ctrl 9|snd ctrl 9
0x4f|sound controller 10|sound ctrl 10|snd ctrl 10
0x50|general purpose controller 5|GP controller 5|GPC-5
0x51|general purpose controller 6|GP controller 6|GPC-6
0x52|general purpose controller 7|GP controller 7|GPC-7
0x53|general purpose controller 8|GP controller 8|GPC-8
0x54|portamento control|portamento ctrl|porta ctrl
0x5b|effects 1 depth (formerly external effects depth)|effects 1 depth|eff 1 depth
0x5c|effects 2 depth (formerly tremolo depth)|effects 2 depth|eff 2 depth
0x5d|effects 3 depth (formerly chorus depth)|effects 3 depth|eff 3 depth
0x5e|effects 4 depth (formerly celeste/detune depth)|effects 4 depth|eff 4 depth
0x5f|effects 5 depth (formerly phaser depth)|effects 5 depth|eff 5 depth
0x60|data increment|data inc|data++
0x61|data decrement|data dec|data--
0x62|Non-Registered Parameter Number LSB|NRPN LSB|NRPN-L
0x63|Non-Registered Parameter Number MSB|NRPN MSB|NRPN-M
0x64|Registered Parameter Number LSB|RPN LSB|RPN-L
0x65|Registered Parameter Number MSB|RPN MSB|RPN-M
0x78|all sound off|all snd off|snd off
0x79|reset all controllers|reset all ctrls|reset ctrls
0x7a|local control|local ctrl|local ctrl
0x7b|all notes off|notes off|notes off
0x7c|omni mode off|omni off|omni off
0x7d|omni mode on|omni on|omni on
0x7e|mono mode on|mono on|mono
0x7f|poly mode on|poly on|poly
`);

export const GM_INSTRUMENTS = names(`
1=Acoustic Grand Piano
2=Bright Acoustic Piano
3=Electric Grand Piano
4=Honky-tonk Piano
5=Electric Piano 1
6=Electric Piano 2
7=Harpsichord
8=Clavi
9=Celesta
10=Glockenspiel
11=Music Box
12=Vibraphone
13=Marimba
14=Xylophone
15=Tubular Bells
16=Dulcimer
17=Drawbar Organ
18=Percussive Organ
19=Rock Organ
20=Church Organ
21=Reed Organ
22=Accordion
23=Harmonica
24=Tango Accordion
25=Acoustic Guitar (nylon)
26=Acoustic Guitar (steel)
27=Electric Guitar (jazz)
28=Electric Guitar (clean)
29=Electric Guitar (muted)
30=Overdriven Guitar
31=Distortion Guitar
32=Guitar harmonics
33=Acoustic Bass
34=Electric Bass (finger)
35=Electric Bass (pick)
36=Fretless Bass
37=Slap Bass 1
38=Slap Bass 2
39=Synth Bass 1
40=Synth Bass 2
41=Violin
42=Viola
43=Cello
44=Contrabass
45=Tremolo Strings
46=Pizzicato Strings
47=Orchestral Harp
48=Timpani
49=String Ensemble 1
50=String Ensemble 2
51=SynthStrings 1
52=SynthStrings 2
53=Choir Aahs
54=Voice Oohs
55=Synth Voice
56=Orchestra Hit
57=Trumpet
58=Trombone
59=Tuba
60=Muted Trumpet
61=French Horn
62=Brass Section
63=SynthBrass 1
64=SynthBrass 2
65=Soprano Sax
66=Alto Sax
67=Tenor Sax
68=Baritone Sax
69=Oboe
70=English Horn
71=Bassoon
72=Clarinet
73=Piccolo
74=Flute
75=Recorder
76=Pan Flute
77=Blown Bottle
78=Shakuhachi
79=Whistle
80=Ocarina
81=Lead 1 (square)
82=Lead 2 (sawtooth)
83=Lead 3 (calliope)
84=Lead 4 (chiff)
85=Lead 5 (charang)
86=Lead 6 (voice)
87=Lead 7 (fifths)
88=Lead 8 (bass + lead)
89=Pad 1 (new age)
90=Pad 2 (warm)
91=Pad 3 (polysynth)
92=Pad 4 (choir)
93=Pad 5 (bowed)
94=Pad 6 (metallic)
95=Pad 7 (halo)
96=Pad 8 (sweep)
97=FX 1 (rain)
98=FX 2 (soundtrack)
99=FX 3 (crystal)
100=FX 4 (atmosphere)
101=FX 5 (brightness)
102=FX 6 (goblins)
103=FX 7 (echoes)
104=FX 8 (sci-fi)
105=Sitar
106=Banjo
107=Shamisen
108=Koto
109=Kalimba
110=Bag pipe
111=Fiddle
112=Shanai
113=Tinkle Bell
114=Agogo
115=Steel Drums
116=Woodblock
117=Taiko Drum
118=Melodic Tom
119=Synth Drum
120=Reverse Cymbal
121=Guitar Fret Noise
122=Breath Noise
123=Seashore
124=Bird Tweet
125=Telephone Ring
126=Helicopter
127=Applause
128=Gunshot
`);

export const DRUM_KIT: Readonly<Record<number, string>> = {
  1: 'GM Standard Kit',
  9: 'GS Room Kit',
  17: 'GS Power Kit',
  25: 'GS Power Kit',
  26: 'GS TR-808 Kit',
  33: 'GS Jazz Kit',
  41: 'GS Brush Kit',
  49: 'GS Orchestra Kit',
  57: 'GS Sound FX Kit',
  128: 'GS CM-64/CM-32 Kit',
};

export const QUARTER_FRAME_TYPE: readonly Pair[] = [
  ['frame count LS nibble', 'frame LSN'],
  ['frame count MS nibble', 'frame MSN'],
  ['seconds LS nibble', 'sec LSN'],
  ['seconds MS nibble', 'sec MSN'],
  ['minutes LS nibble', 'min LSN'],
  ['minutes MS nibble', 'min MSN'],
  ['hours LS nibble', 'hrs LSN'],
  ['hours MS nibble and SMPTE type', 'hrs MSN'],
];

export const SMPTE_TYPE: readonly string[] = ['24 fps', '25 fps', '30 fps (drop-frame)', '30 fps (non-drop)'];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(note: number): string {
  return NOTE_NAMES[note % 12]! + (Math.floor(note / 12) - 1);
}

export const PERCUSSION_NOTES: ReadonlyMap<number, string> = new Map(
  `
35=Acoustic Bass Drum
36=Bass Drum 1
37=Side Stick
38=Acoustic Snare
39=Hand Clap
40=Electric Snare
41=Low Floor Tom
42=Closed Hi Hat
43=High Floor Tom
44=Pedal Hi-Hat
45=Low Tom
46=Open Hi-Hat
47=Low-Mid Tom
48=Hi Mid Tom
49=Crash Cymbal 1
50=High Tom
51=Ride Cymbal 1
52=Chinese Cymbal
53=Ride Bell
54=Tambourine
55=Splash Cymbal
56=Cowbell
57=Crash Cymbal 2
58=Vibraslap
59=Ride Cymbal 2
60=Hi Bongo
61=Low Bongo
62=Mute Hi Conga
63=Open Hi Conga
64=Low Conga
65=High Timbale
66=Low Timbale
67=High Agogo
68=Low Agogo
69=Cabasa
70=Maracas
71=Short Whistle
72=Long Whistle
73=Short Guiro
74=Long Guiro
75=Claves
76=Hi Wood Block
77=Low Wood Block
78=Mute Cuica
79=Open Cuica
80=Mute Triangle
81=Open Triangle
`
    .trim()
    .split('\n')
    .map((line) => {
      const index = line.indexOf('=');
      return [Number(line.slice(0, index)), line.slice(index + 1)] as const;
    }),
);

export const SYSEX_MANUFACTURERS: ReadonlyMap<string, string> = new Map(
  `
01=Sequential
02=IDP
03=Voyetra/Octave-Plateau
04=Moog
05=Passport Designs
06=Lexicon
07=Kurzweil
08=Fender
09=Gulbransen
0a=AKG Acoustics
0b=Voyce Music
0c=Waveframe Corp
0d=ADA Signal Processors
0e=Garfield Electronics
0f=Ensoniq
10=Oberheim
11=Apple Computer
12=Grey Matter Response
13=Digidesign
14=Palm Tree Instruments
15=JLCooper Electronics
16=Lowrey
17=Adams-Smith
18=Emu Systems
19=Harmony Systems
1a=ART
1b=Baldwin
1c=Eventide
1d=Inventronics
1f=Clarity
00,00,01=Time Warner Interactive
00,00,07=Digital Music Corp.
00,00,08=IOTA Systems
00,00,09=New England Digital
00,00,0a=Artisyn
00,00,0b=IVL Technologies
00,00,0c=Southern Music Systems
00,00,0d=Lake Butler Sound Company
00,00,0e=Alesis
00,00,10=DOD Electronics
00,00,11=Studer-Editech
00,00,14=Perfect Fretworks
00,00,15=KAT
00,00,16=Opcode
00,00,17=Rane Corp.
00,00,18=Anadi Inc.
00,00,19=KMX
00,00,1a=Allen & Heath Brenell
00,00,1b=Peavy Electronics
00,00,1c=360 Systems
00,00,1d=Spectrum Design and Development
00,00,1e=Marquis Music
00,00,1f=Zeta Systems
00,00,20=Axxes
00,00,21=Orban
00,00,24=KTI
00,00,25=Breakaway Technologies
00,00,26=CAE
00,00,29=Rocktron Corp.
00,00,2a=PianoDisc
00,00,2b=Cannon Research Group
00,00,2d=Rogers Instrument Corp.
00,00,2e=Blue Sky Logic
00,00,2f=Encore Electronics
00,00,30=Uptown
00,00,31=Voce
00,00,32=CTI Audio, Inc. (Music. Intel Dev.)
00,00,33=S&S Research
00,00,34=Broderbund Software, Inc.
00,00,35=Allen Organ Co.
00,00,37=Music Quest
00,00,38=APHEX
00,00,39=Gallien Krueger
00,00,3a=IBM
00,00,3c=Hotz Instruments Technologies
00,00,3d=ETA Lighting
00,00,3e=NSI Corporation
00,00,3f=Ad Lib, Inc.
00,00,40=Richmond Sound Design
00,00,41=Microsoft
00,00,42=The Software Toolworks
00,00,43=Niche/RJMG
00,00,44=Intone
00,00,47=GT Electronics / Groove Tubes
00,00,49=Timeline Vista
00,00,4a=Mesa Boogie
00,00,4c=Sequoia Development
00,00,4d=Studio Electronics
00,00,4e=Euphonix
00,00,4f=InterMIDI, Inc.
00,00,50=MIDI Solutions
00,00,51=3DO Company
00,00,52=Lightwave Research
00,00,53=Micro-W
00,00,54=Spectral Synthesis
00,00,55=Lone Wolf
00,00,56=Studio Technologies
00,00,57=Peterson EMP
00,00,58=Atari
00,00,59=Marion Systems
00,00,5a=Design Event
00,00,5b=Winjammer Software
00,00,5c=AT&T Bell Labs
00,00,5e=Symetrix
00,00,5f=MIDI the World
00,00,60=Desper Products
00,00,61=Micros'N MIDI
00,00,62=Accordians Intl
00,00,63=EuPhonics
00,00,64=Musonix
00,00,65=Turtle Beach Systems
00,00,66=Mackie Designs
00,00,67=Compuserve
00,00,68=BES Technologies
00,00,69=QRS Music Rolls
00,00,6a=P G Music
00,00,6b=Sierra Semiconductor
00,00,6c=EpiGraf Audio Visual
00,00,6d=Electronics Deiversified
00,00,6e=Tune 1000
00,00,6f=Advanced Micro Devices
00,00,70=Mediamation
00,00,71=Sabine Music
00,00,72=Woog Labs
00,00,73=Micropolis
00,00,74=Ta Horng Musical Inst.
00,00,75=eTek (formerly Forte)
00,00,76=Electrovoice
00,00,77=Midisoft
00,00,78=Q-Sound Labs
00,00,79=Westrex
00,00,7a=NVidia
00,00,7b=ESS Technology
00,00,7c=MediaTrix Peripherals
00,00,7d=Brooktree
00,00,7e=Otari
00,00,7f=Key Electronics
00,01,01=Crystalake Multimedia
00,01,02=Crystal Semiconductor
00,01,03=Rockwell Semiconductor
20=Passac
21=SIEL
22=Synthaxe
24=Hohner
25=Twister
26=Solton
27=Jellinghaus MS
28=Southworth Music Systems
29=PPG
2a=JEN
2b=SSL Limited
2c=Audio Veritrieb
2f=Elka
30=Dynacord
31=Viscount
33=Clavia Digital Instruments
34=Audio Architecture
35=GeneralMusic Corp.
39=Soundcraft Electronics
3b=Wersi
3c=Avab Elektronik Ab
3d=Digigram
3e=Waldorf Electronics
3f=Quasimidi
00,20,00=Dream
00,20,01=Strand Lighting
00,20,02=Amek Systems
00,20,04=Böhm Electronic
00,20,06=Trident Audio
00,20,07=Real World Studio
00,20,09=Yes Technology
00,20,0a=Audiomatica
00,20,0b=Bontempi/Farfisa
00,20,0c=F.B.T. Elettronica
00,20,0d=MidiTemp
00,20,0e=LA Audio (Larking Audio)
00,20,0f=Zero 88 Lighting Limited
00,20,10=Micon Audio Electronics GmbH
00,20,11=Forefront Technology
00,20,13=Kenton Electronics
00,20,15=ADB
00,20,16=Marshall Products
00,20,17=DDA
00,20,18=BSS
00,20,19=MA Lighting Technology
00,20,1a=Fatar
00,20,1b=QSC Audio
00,20,1c=Artisan Classic Organ
00,20,1d=Orla Spa
00,20,1e=Pinnacle Audio
00,20,1f=TC Electronics
00,20,20=Doepfer Musikelektronik
00,20,21=Creative Technology Pte
00,20,22=Minami/Seiyddo
00,20,23=Goldstar
00,20,24=Midisoft s.a.s di M. Cima
00,20,25=Samick
00,20,26=Penny and Giles
00,20,27=Acorn Computer
00,20,28=LSC Electronics
00,20,29=Novation EMS
00,20,2a=Samkyung Mechatronics
00,20,2b=Medeli Electronics
00,20,2c=Charlie Lab
00,20,2d=Blue Chip Music Tech
00,20,2e=BEE OH Corp
40=Kawai
41=Roland
42=Korg
43=Yamaha
44=Casio
46=Kamiya Studio
47=Akai
48=Japan Victor
49=Mesosha
4a=Hoshino Gakki
4b=Fujitsu Elect
4c=Sony
4d=Nisshin Onpa
4e=TEAC
50=Matsushita Electric
51=Fostex
52=Zoom
53=Midori Electronics
54=Matsushita Communication Industrial
55=Suzuki Musical Inst. Mfg.
7d=Non-Commercial
7e=Universal Non-Realtime
7f=Universal Realtime
`
    .trim()
    .split('\n')
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)] as const;
    }),
);
