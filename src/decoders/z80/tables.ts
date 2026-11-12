export interface Z80Instruction {
  readonly displacement: number;
  readonly immediate: number;
  readonly read: number;
  readonly write: number;
  readonly repeat: boolean;
  readonly mnemonic: string;
}

type InstructionTable = ReadonlyMap<number, Z80Instruction>;

function parse(source: string): InstructionTable {
  const table = new Map<number, Z80Instruction>();
  for (const line of source.trim().split('\n')) {
    const fields = line.trim().split('|');
    table.set(Number.parseInt(fields[0]!, 16), {
      displacement: Number(fields[1]),
      immediate: Number(fields[2]),
      read: Number(fields[3]),
      write: Number(fields[4]),
      repeat: fields[5] === '1',
      mnemonic: fields.slice(6).join('|'),
    });
  }
  return table;
}

const MAIN_DATA = `
00|0|0|0|0|0|NOP
01|0|2|0|0|0|LD BC,{i:04H}h
02|0|0|0|1|0|LD (BC),A
03|0|0|0|0|0|INC BC
04|0|0|0|0|0|INC B
05|0|0|0|0|0|DEC B
06|0|1|0|0|0|LD B,{i:02H}h
07|0|0|0|0|0|RLCA
08|0|0|0|0|0|EX AF,AF'
09|0|0|0|0|0|ADD HL,BC
0A|0|0|1|0|0|LD A,(BC)
0B|0|0|0|0|0|DEC BC
0C|0|0|0|0|0|INC C
0D|0|0|0|0|0|DEC C
0E|0|1|0|0|0|LD C,{i:02H}h
0F|0|0|0|0|0|RRCA
10|1|0|0|0|0|DJNZ \${j:+d}
11|0|2|0|0|0|LD DE,{i:04H}h
12|0|0|0|1|0|LD (DE),A
13|0|0|0|0|0|INC DE
14|0|0|0|0|0|INC D
15|0|0|0|0|0|DEC D
16|0|1|0|0|0|LD D,{i:02H}h
17|0|0|0|0|0|RLA
18|1|0|0|0|0|JR \${j:+d}
19|0|0|0|0|0|ADD HL,DE
1A|0|0|1|0|0|LD A,(DE)
1B|0|0|0|0|0|DEC DE
1C|0|0|0|0|0|INC E
1D|0|0|0|0|0|DEC E
1E|0|1|0|0|0|LD E,{i:02H}h
1F|0|0|0|0|0|RRA
20|1|0|0|0|0|JR NZ,\${j:+d}
21|0|2|0|0|0|LD HL,{i:04H}h
22|0|2|0|2|0|LD ({i:04H}h),HL
23|0|0|0|0|0|INC HL
24|0|0|0|0|0|INC H
25|0|0|0|0|0|DEC H
26|0|1|0|0|0|LD H,{i:02H}h
27|0|0|0|0|0|DAA
28|1|0|0|0|0|JR Z,\${j:+d}
29|0|0|0|0|0|ADD HL,HL
2A|0|2|2|0|0|LD HL,({i:04H}h)
2B|0|0|0|0|0|DEC HL
2C|0|0|0|0|0|INC L
2D|0|0|0|0|0|DEC L
2E|0|1|0|0|0|LD L,{i:02H}h
2F|0|0|0|0|0|CPL
30|1|0|0|0|0|JR NC,\${j:+d}
31|0|2|0|0|0|LD SP,{i:04H}h
32|0|2|0|1|0|LD ({i:04H}h),A
33|0|0|0|0|0|INC SP
34|0|0|1|1|0|INC (HL)
35|0|0|1|1|0|DEC (HL)
36|0|1|0|1|0|LD (HL),{i:02H}h
37|0|0|0|0|0|SCF
38|1|0|0|0|0|JR C,\${j:+d}
39|0|0|0|0|0|ADD HL,SP
3A|0|2|1|0|0|LD A,({i:04H}h)
3B|0|0|0|0|0|DEC SP
3C|0|0|0|0|0|INC A
3D|0|0|0|0|0|DEC A
3E|0|1|0|0|0|LD A,{i:02H}h
3F|0|0|0|0|0|CCF
40|0|0|0|0|0|LD B,B
41|0|0|0|0|0|LD B,C
42|0|0|0|0|0|LD B,D
43|0|0|0|0|0|LD B,E
44|0|0|0|0|0|LD B,H
45|0|0|0|0|0|LD B,L
46|0|0|1|0|0|LD B,(HL)
47|0|0|0|0|0|LD B,A
48|0|0|0|0|0|LD C,B
49|0|0|0|0|0|LD C,C
4A|0|0|0|0|0|LD C,D
4B|0|0|0|0|0|LD C,E
4C|0|0|0|0|0|LD C,H
4D|0|0|0|0|0|LD C,L
4E|0|0|1|0|0|LD C,(HL)
4F|0|0|0|0|0|LD C,A
50|0|0|0|0|0|LD D,B
51|0|0|0|0|0|LD D,C
52|0|0|0|0|0|LD D,D
53|0|0|0|0|0|LD D,E
54|0|0|0|0|0|LD D,H
55|0|0|0|0|0|LD D,L
56|0|0|1|0|0|LD D,(HL)
57|0|0|0|0|0|LD D,A
58|0|0|0|0|0|LD E,B
59|0|0|0|0|0|LD E,C
5A|0|0|0|0|0|LD E,D
5B|0|0|0|0|0|LD E,E
5C|0|0|0|0|0|LD E,H
5D|0|0|0|0|0|LD E,L
5E|0|0|1|0|0|LD E,(HL)
5F|0|0|0|0|0|LD E,A
60|0|0|0|0|0|LD H,B
61|0|0|0|0|0|LD H,C
62|0|0|0|0|0|LD H,D
63|0|0|0|0|0|LD H,E
64|0|0|0|0|0|LD H,H
65|0|0|0|0|0|LD H,L
66|0|0|1|0|0|LD H,(HL)
67|0|0|0|0|0|LD H,A
68|0|0|0|0|0|LD L,B
69|0|0|0|0|0|LD L,C
6A|0|0|0|0|0|LD L,D
6B|0|0|0|0|0|LD L,E
6C|0|0|0|0|0|LD L,H
6D|0|0|0|0|0|LD L,L
6E|0|0|1|0|0|LD L,(HL)
6F|0|0|0|0|0|LD L,A
70|0|0|0|1|0|LD (HL),B
71|0|0|0|1|0|LD (HL),C
72|0|0|0|1|0|LD (HL),D
73|0|0|0|1|0|LD (HL),E
74|0|0|0|1|0|LD (HL),H
75|0|0|0|1|0|LD (HL),L
76|0|0|0|0|0|HALT
77|0|0|0|1|0|LD (HL),A
78|0|0|0|0|0|LD A,B
79|0|0|0|0|0|LD A,C
7A|0|0|0|0|0|LD A,D
7B|0|0|0|0|0|LD A,E
7C|0|0|0|0|0|LD A,H
7D|0|0|0|0|0|LD A,L
7E|0|0|1|0|0|LD A,(HL)
7F|0|0|0|0|0|LD A,A
80|0|0|0|0|0|ADD A,B
81|0|0|0|0|0|ADD A,C
82|0|0|0|0|0|ADD A,D
83|0|0|0|0|0|ADD A,E
84|0|0|0|0|0|ADD A,H
85|0|0|0|0|0|ADD A,L
86|0|0|1|0|0|ADD A,(HL)
87|0|0|0|0|0|ADD A,A
88|0|0|0|0|0|ADC A,B
89|0|0|0|0|0|ADC A,C
8A|0|0|0|0|0|ADC A,D
8B|0|0|0|0|0|ADC A,E
8C|0|0|0|0|0|ADC A,H
8D|0|0|0|0|0|ADC A,L
8E|0|0|1|0|0|ADC A,(HL)
8F|0|0|0|0|0|ADC A,A
90|0|0|0|0|0|SUB B
91|0|0|0|0|0|SUB C
92|0|0|0|0|0|SUB D
93|0|0|0|0|0|SUB E
94|0|0|0|0|0|SUB H
95|0|0|0|0|0|SUB L
96|0|0|1|0|0|SUB (HL)
97|0|0|0|0|0|SUB A
98|0|0|0|0|0|SBC A,B
99|0|0|0|0|0|SBC A,C
9A|0|0|0|0|0|SBC A,D
9B|0|0|0|0|0|SBC A,E
9C|0|0|0|0|0|SBC A,H
9D|0|0|0|0|0|SBC A,L
9E|0|0|1|0|0|SBC A,(HL)
9F|0|0|0|0|0|SBC A,A
A0|0|0|0|0|0|AND B
A1|0|0|0|0|0|AND C
A2|0|0|0|0|0|AND D
A3|0|0|0|0|0|AND E
A4|0|0|0|0|0|AND H
A5|0|0|0|0|0|AND L
A6|0|0|1|0|0|AND (HL)
A7|0|0|0|0|0|AND A
A8|0|0|0|0|0|XOR B
A9|0|0|0|0|0|XOR C
AA|0|0|0|0|0|XOR D
AB|0|0|0|0|0|XOR E
AC|0|0|0|0|0|XOR H
AD|0|0|0|0|0|XOR L
AE|0|0|1|0|0|XOR (HL)
AF|0|0|0|0|0|XOR A
B0|0|0|0|0|0|OR B
B1|0|0|0|0|0|OR C
B2|0|0|0|0|0|OR D
B3|0|0|0|0|0|OR E
B4|0|0|0|0|0|OR H
B5|0|0|0|0|0|OR L
B6|0|0|1|0|0|OR (HL)
B7|0|0|0|0|0|OR A
B8|0|0|0|0|0|CP B
B9|0|0|0|0|0|CP C
BA|0|0|0|0|0|CP D
BB|0|0|0|0|0|CP E
BC|0|0|0|0|0|CP H
BD|0|0|0|0|0|CP L
BE|0|0|1|0|0|CP (HL)
BF|0|0|0|0|0|CP A
C0|0|0|2|0|0|RET NZ
C1|0|0|2|0|0|POP BC
C2|0|2|0|0|0|JP NZ,{i:04H}h
C3|0|2|0|0|0|JP {i:04H}h
C4|0|2|0|-2|0|CALL NZ,{i:04H}h
C5|0|0|0|-2|0|PUSH BC
C6|0|1|0|0|0|ADD A,{i:02H}h
C7|0|0|0|-2|0|RST 00h
C8|0|0|2|0|0|RET Z
C9|0|0|2|0|0|RET
CA|0|2|0|0|0|JP Z,{i:04H}h
CC|0|2|0|-2|0|CALL Z,{i:04H}h
CD|0|2|0|-2|0|CALL {i:04H}h
CE|0|1|0|0|0|ADC A,{i:02H}h
CF|0|0|0|-2|0|RST 08h
D0|0|0|2|0|0|RET NC
D1|0|0|2|0|0|POP DE
D2|0|2|0|0|0|JP NC,{i:04H}h
D3|0|1|0|1|0|OUT ({i:02H}h),A
D4|0|2|0|-2|0|CALL NC,{i:04H}h
D5|0|0|0|-2|0|PUSH DE
D6|0|1|0|0|0|SUB {i:02H}h
D7|0|0|0|-2|0|RST 10h
D8|0|0|2|0|0|RET C
D9|0|0|0|0|0|EXX
DA|0|2|0|0|0|JP C,{i:04H}h
DB|0|1|1|0|0|IN A,({i:02H}h)
DC|0|2|0|-2|0|CALL C,{i:04H}h
DE|0|1|0|0|0|SBC A,{i:02H}h
DF|0|0|0|-2|0|RST 18h
E0|0|0|2|0|0|RET PO
E1|0|0|2|0|0|POP HL
E2|0|2|0|0|0|JP PO,{i:04H}h
E3|0|0|2|2|0|EX (SP),HL
E4|0|2|0|-2|0|CALL PO,{i:04H}h
E5|0|0|0|-2|0|PUSH HL
E6|0|1|0|0|0|AND {i:02H}h
E7|0|0|0|-2|0|RST 20h
E8|0|0|2|0|0|RET PE
E9|0|0|0|0|0|JP (HL)
EA|0|2|0|0|0|JP PE,{i:04H}h
EB|0|0|0|0|0|EX DE,HL
EC|0|2|0|-2|0|CALL PE,{i:04H}h
EE|0|1|0|0|0|XOR {i:02H}h
EF|0|0|0|-2|0|RST 28h
F0|0|0|2|0|0|RET P
F1|0|0|2|0|0|POP AF
F2|0|2|0|0|0|JP P,{i:04H}h
F3|0|0|0|0|0|DI
F4|0|2|0|-2|0|CALL P,{i:04H}h
F5|0|0|0|-2|0|PUSH AF
F6|0|1|0|0|0|OR {i:02H}h
F7|0|0|0|-2|0|RST 30h
F8|0|0|2|0|0|RET M
F9|0|0|0|0|0|LD SP,HL
FA|0|2|0|0|0|JP M,{i:04H}h
FB|0|0|0|0|0|EI
FC|0|2|0|-2|0|CALL M,{i:04H}h
FE|0|1|0|0|0|CP {i:02H}h
FF|0|0|0|-2|0|RST 38h
`;

const EXTENDED_DATA = `
40|0|0|1|0|0|IN B,(C)
41|0|0|0|1|0|OUT (C),B
42|0|0|0|0|0|SBC HL,BC
43|0|2|0|2|0|LD ({i:04H}h),BC
44|0|0|0|0|0|NEG
45|0|0|2|0|0|RETN
46|0|0|0|0|0|IM 0
47|0|0|0|0|0|LD I,A
48|0|0|1|0|0|IN C,(C)
49|0|0|0|1|0|OUT (C),C
4A|0|0|0|0|0|ADC HL,BC
4B|0|2|2|0|0|LD BC,({i:04H}h)
4C|0|0|0|0|0|NEG
4D|0|0|2|0|0|RETI
4E|0|0|0|0|0|IM 0/1
4F|0|0|0|0|0|LD R,A
50|0|0|1|0|0|IN D,(C)
51|0|0|0|1|0|OUT (C),D
52|0|0|0|0|0|SBC HL,DE
53|0|2|0|2|0|LD ({i:04H}h),DE
54|0|0|0|0|0|NEG
55|0|0|2|0|0|RETN
56|0|0|0|0|0|IM 1
57|0|0|0|0|0|LD A,I
58|0|0|1|0|0|IN E,(C)
59|0|0|0|1|0|OUT (C),E
5A|0|0|0|0|0|ADC HL,DE
5B|0|2|2|0|0|LD DE,({i:04H}h)
5C|0|0|0|0|0|NEG
5D|0|0|2|0|0|RETN
5E|0|0|0|0|0|IM 2
5F|0|0|0|0|0|LD A,R
60|0|0|1|0|0|IN H,(C)
61|0|0|0|1|0|OUT (C),H
62|0|0|0|0|0|SBC HL,HL
63|0|2|0|2|0|LD ({i:04H}h),HL
64|0|0|0|0|0|NEG
65|0|0|2|0|0|RETN
66|0|0|0|0|0|IM 0
67|0|0|1|1|0|RRD
68|0|0|1|0|0|IN L,(C)
69|0|0|0|1|0|OUT (C),L
6A|0|0|0|0|0|ADC HL,HL
6B|0|2|2|0|0|LD HL,({i:04H}h)
6C|0|0|0|0|0|NEG
6D|0|0|2|0|0|RETN
6E|0|0|0|0|0|IM 0/1
6F|0|0|1|1|0|RLD
70|0|0|1|0|0|IN (C)
71|0|0|0|1|0|OUT (C),0
72|0|0|0|0|0|SBC HL,SP
73|0|2|0|2|0|LD ({i:04H}h),SP
74|0|0|0|0|0|NEG
75|0|0|2|0|0|RETN
76|0|0|0|0|0|IM 1
78|0|0|1|0|0|IN A,(C)
79|0|0|0|1|0|OUT (C),A
7A|0|0|0|0|0|ADC HL,SP
7B|0|2|2|0|0|LD SP,({i:04H}h)
7C|0|0|0|0|0|NEG
7D|0|0|2|0|0|RETN
7E|0|0|0|0|0|IM 2
A0|0|0|1|1|0|LDI
A1|0|0|1|0|0|CPI
A2|0|0|1|1|0|INI
A3|0|0|1|1|0|OUTI
A8|0|0|1|1|0|LDD
A9|0|0|1|0|0|CPD
AA|0|0|1|1|0|IND
AB|0|0|1|1|0|OUTD
B0|0|0|1|1|1|LDIR
B1|0|0|1|0|1|CPIR
B2|0|0|1|1|1|INIR
B3|0|0|1|1|1|OTIR
B8|0|0|1|1|1|LDDR
B9|0|0|1|0|1|CPDR
BA|0|0|1|1|1|INDR
BB|0|0|1|1|1|OTDR
`;

const INDEX_DATA = `
09|0|0|0|0|0|ADD {r},BC
19|0|0|0|0|0|ADD {r},DE
21|0|2|0|0|0|LD {r},{i:04H}h
22|0|2|0|2|0|LD ({i:04H}h),{r}
23|0|0|0|0|0|INC {r}
24|0|0|0|0|0|INC {r}h
25|0|0|0|0|0|DEC {r}h
26|0|1|0|0|0|LD {r}h,{i:02H}h
29|0|0|0|0|0|ADD {r},{r}
2A|0|2|2|0|0|LD {r},({i:04H}h)
2B|0|0|0|0|0|DEC {r}
2C|0|0|0|0|0|INC {r}l
2D|0|0|0|0|0|DEC {r}l
2E|0|1|0|0|0|LD {r}l,{i:02H}h
34|1|0|1|1|0|INC ({r}{d:+d})
35|1|0|1|1|0|DEC ({r}{d:+d})
36|1|1|0|1|0|LD ({r}{d:+d}),{i:02H}h
39|0|0|0|0|0|ADD {r},SP
44|0|0|0|0|0|LD B,{r}h
45|0|0|0|0|0|LD B,{r}l
46|1|0|1|0|0|LD B,({r}{d:+d})
4C|0|0|0|0|0|LD C,{r}h
4D|0|0|0|0|0|LD C,{r}l
4E|1|0|1|0|0|LD C,({r}{d:+d})
54|0|0|0|0|0|LD D,{r}h
55|0|0|0|0|0|LD D,{r}l
56|1|0|1|0|0|LD D,({r}{d:+d})
5C|0|0|0|0|0|LD E,{r}h
5D|0|0|0|0|0|LD E,{r}l
5E|1|0|1|0|0|LD E,({r}{d:+d})
60|0|0|0|0|0|LD {r}h,B
61|0|0|0|0|0|LD {r}h,C
62|0|0|0|0|0|LD {r}h,D
63|0|0|0|0|0|LD {r}h,E
64|0|0|0|0|0|LD {r}h,{r}h
65|0|0|0|0|0|LD {r}h,{r}l
66|1|0|1|0|0|LD H,({r}{d:+d})
67|0|0|0|0|0|LD {r}h,A
68|0|0|0|0|0|LD {r}l,B
69|0|0|0|0|0|LD {r}l,C
6A|0|0|0|0|0|LD {r}l,D
6B|0|0|0|0|0|LD {r}l,E
6C|0|0|0|0|0|LD {r}l,{r}h
6D|0|0|0|0|0|LD {r}l,{r}l
6E|1|0|1|0|0|LD L,({r}{d:+d})
6F|0|0|0|0|0|LD {r}l,A
70|1|0|0|1|0|LD ({r}{d:+d}),B
71|1|0|0|1|0|LD ({r}{d:+d}),C
72|1|0|0|1|0|LD ({r}{d:+d}),D
73|1|0|0|1|0|LD ({r}{d:+d}),E
74|1|0|0|1|0|LD ({r}{d:+d}),H
75|1|0|0|1|0|LD ({r}{d:+d}),L
77|1|0|0|1|0|LD ({r}{d:+d}),A
7C|0|0|0|0|0|LD A,{r}h
7D|0|0|0|0|0|LD A,{r}l
7E|1|0|1|0|0|LD A,({r}{d:+d})
84|0|0|0|0|0|ADD A,{r}h
85|0|0|0|0|0|ADD A,{r}l
86|1|0|1|0|0|ADD A,({r}{d:+d})
8C|0|0|0|0|0|ADC A,{r}h
8D|0|0|0|0|0|ADC A,{r}l
8E|1|0|1|0|0|ADC A,({r}{d:+d})
94|0|0|0|0|0|SUB {r}h
95|0|0|0|0|0|SUB {r}l
96|1|0|1|0|0|SUB ({r}{d:+d})
9C|0|0|0|0|0|SBC A,{r}h
9D|0|0|0|0|0|SBC A,{r}l
9E|1|0|1|0|0|SBC A,({r}{d:+d})
A4|0|0|0|0|0|AND {r}h
A5|0|0|0|0|0|AND {r}l
A6|1|0|1|0|0|AND ({r}{d:+d})
AC|0|0|0|0|0|XOR {r}h
AD|0|0|0|0|0|XOR {r}l
AE|1|0|1|0|0|XOR ({r}{d:+d})
B4|0|0|0|0|0|OR {r}h
B5|0|0|0|0|0|OR {r}l
B6|1|0|1|0|0|OR ({r}{d:+d})
BC|0|0|0|0|0|CP {r}h
BD|0|0|0|0|0|CP {r}l
BE|1|0|1|0|0|CP ({r}{d:+d})
E1|0|0|2|0|0|POP {r}
E3|0|0|2|2|0|EX (SP),{r}
E5|0|0|0|-2|0|PUSH {r}
E9|0|0|0|0|0|JP ({r})
F9|0|0|0|0|0|LD SP,{r}
`;

function createBitInstructions(): InstructionTable {
  const table = new Map<number, Z80Instruction>();
  const registers = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
  const operations = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];
  for (let opcode = 0; opcode < 0x100; opcode++) {
    const block = opcode >>> 6;
    const bit = (opcode >>> 3) & 7;
    const register = registers[opcode & 7]!;
    if (block === 0) {
      const memory = register === '(HL)' ? 1 : 0;
      table.set(opcode, {
        displacement: 0,
        immediate: 0,
        read: memory,
        write: memory,
        repeat: false,
        mnemonic: `${operations[bit]!} ${register}`,
      });
    } else if (block === 1) {
      table.set(opcode, {
        displacement: 0,
        immediate: 0,
        read: register === '(HL)' ? 1 : 0,
        write: 0,
        repeat: false,
        mnemonic: `BIT ${bit},${register}`,
      });
    } else {
      const operation = block === 3 ? 'SET' : 'RES';
      table.set(opcode, {
        displacement: 0,
        immediate: 0,
        read: register === '(HL)' ? 1 : 0,
        write: register === '(HL)' ? 1 : 0,
        repeat: false,
        mnemonic: `${operation} ${bit},${register}`,
      });
    }
  }
  return table;
}

function createIndexBitInstructions(): InstructionTable {
  const table = new Map<number, Z80Instruction>();
  const registers = ['B', 'C', 'D', 'E', 'H', 'L', '', 'A'];
  const operations = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];
  for (let opcode = 0; opcode < 0x100; opcode++) {
    const block = opcode >>> 6;
    const bit = (opcode >>> 3) & 7;
    const suffix = registers[opcode & 7]!;
    if (block === 0) {
      table.set(opcode, {
        displacement: 0,
        immediate: 0,
        read: 1,
        write: 1,
        repeat: false,
        mnemonic: `${operations[bit]!} ({r}{d:+d})${suffix ? `,${suffix}` : ''}`,
      });
    } else if (block === 1) {
      table.set(opcode, {
        displacement: 0,
        immediate: 0,
        read: 1,
        write: 0,
        repeat: false,
        mnemonic: `BIT ${bit},({r}{d:+d})`,
      });
    } else {
      table.set(opcode, {
        displacement: 0,
        immediate: 0,
        read: 1,
        write: 1,
        repeat: false,
        mnemonic: `${block === 3 ? 'SET' : 'RES'} ${bit},({r}{d:+d})${suffix ? `,${suffix}` : ''}`,
      });
    }
  }
  return table;
}

export const INSTRUCTION_TABLES: ReadonlyMap<
  number,
  { readonly table: InstructionTable; readonly indexRegister: string }
> = new Map([
  [0, { table: parse(MAIN_DATA), indexRegister: '' }],
  [0xed, { table: parse(EXTENDED_DATA), indexRegister: '' }],
  [0xcb, { table: createBitInstructions(), indexRegister: '' }],
  [0xdd, { table: parse(INDEX_DATA), indexRegister: 'IX' }],
  [0xfd, { table: parse(INDEX_DATA), indexRegister: 'IY' }],
  [0xddcb, { table: createIndexBitInstructions(), indexRegister: 'IX' }],
  [0xfdcb, { table: createIndexBitInstructions(), indexRegister: 'IY' }],
]);
