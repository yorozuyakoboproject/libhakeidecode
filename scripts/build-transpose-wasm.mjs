import wabtFactory from 'wabt';
import { writeFile } from 'node:fs/promises';
const stages = [
  [16, 0x0000ffff],
  [8, 0x00ff00ff],
  [4, 0x0f0f0f0f],
  [2, 0x33333333],
  [1, 0x55555555],
];
const get = (name) => `(local.get $${name})`;
const scalar = ['(func (export "transpose_scalar") (param $words i32)'];
const simd = ['(func (export "transpose_simd") (param $words i32)'];
for (const [lines, count, type] of [
  [scalar, 32, 'i32'],
  [simd, 8, 'v128'],
]) {
  lines.push('  (local $input i32) (local $wordByte i32) (local $stride i32)');
  lines.push('  ' + Array.from({ length: 32 }, (_, i) => `(local $p${i} i32)`).join(' '));
  lines.push(`  (local $t ${type}) ` + Array.from({ length: count }, (_, i) => `(local $a${i} ${type})`).join(' '));
  lines.push('  (local.set $stride (i32.shl (local.get $words) (i32.const 2)))');
  for (let ch = 0; ch < 32; ch++)
    lines.push(`  (local.set $p${ch} (i32.add (i32.const 262144) (i32.mul (local.get $stride) (i32.const ${ch}))))`);
  lines.push('  (if (i32.eqz (local.get $words)) (then (return)))', '  (loop $tiles');
  for (let i = 0; i < count; i++)
    lines.push(
      `    (local.set $a${i} (${type === 'i32' ? 'i32' : 'v128'}.load offset=${i * (type === 'i32' ? 4 : 16)} (local.get $input)))`,
    );
}
for (const [shift, mask] of stages)
  for (let a = 0; a < 32; a++) {
    if (a & shift) continue;
    const b = a + shift;
    scalar.push(
      `    (local.set $t (i32.and (i32.xor (i32.shr_u ${get('a' + a)} (i32.const ${shift})) ${get('a' + b)}) (i32.const ${mask})))`,
      `    (local.set $a${a} (i32.xor ${get('a' + a)} (i32.shl ${get('t')} (i32.const ${shift}))))`,
      `    (local.set $a${b} (i32.xor ${get('a' + b)} ${get('t')}))`,
    );
  }
for (const [shift, mask] of stages.slice(0, 3))
  for (let a = 0; a < 8; a++) {
    const distance = shift / 4;
    if (a & distance) continue;
    const b = a + distance;
    simd.push(
      `    (local.set $t (v128.and (v128.xor (i32x4.shr_u ${get('a' + a)} (i32.const ${shift})) ${get('a' + b)}) (v128.const i32x4 ${mask} ${mask} ${mask} ${mask})))`,
      `    (local.set $a${a} (v128.xor ${get('a' + a)} (i32x4.shl ${get('t')} (i32.const ${shift}))))`,
      `    (local.set $a${b} (v128.xor ${get('a' + b)} ${get('t')}))`,
    );
  }
for (const [shift, mask] of stages.slice(3)) {
  const permutation = shift === 2 ? '8 9 10 11 12 13 14 15 0 1 2 3 4 5 6 7' : '4 5 6 7 0 1 2 3 12 13 14 15 8 9 10 11';
  const laneMasks = shift === 2 ? `${mask} ${mask} 0 0` : `${mask} 0 ${mask} 0`;
  for (let a = 0; a < 8; a++) {
    const value = get('a' + a),
      shuffle = (x) => `(i8x16.shuffle ${permutation} ${x} ${x})`;
    simd.push(
      `    (local.set $t (v128.and (v128.xor (i32x4.shr_u ${value} (i32.const ${shift})) ${shuffle(value)}) (v128.const i32x4 ${laneMasks})))`,
      `    (local.set $a${a} (v128.xor ${value} (v128.xor (i32x4.shl ${get('t')} (i32.const ${shift})) ${shuffle(get('t'))})))`,
    );
  }
}
for (let ch = 0; ch < 32; ch++) {
  const pointer = `(i32.add ${get('p' + ch)} ${get('wordByte')})`;
  scalar.push(`    (i32.store ${pointer} ${get('a' + ch)})`);
  simd.push(`    (v128.store32_lane ${ch % 4} ${pointer} ${get('a' + Math.floor(ch / 4))})`);
}
for (const lines of [scalar, simd])
  lines.push(
    '    (local.set $input (i32.add (local.get $input) (i32.const 128)))',
    '    (local.set $wordByte (i32.add (local.get $wordByte) (i32.const 4)))',
    '    (br_if $tiles (i32.lt_u (local.get $wordByte) (local.get $stride)))',
    '  )',
    ')',
  );
const simd4 = [
  '(func (export "transpose_simd4") (param $words i32)',
  '  (local $input i32) (local $wordByte i32) (local $stride i32)',
  '  (local $t v128) (local $l0 v128) (local $l1 v128) (local $l2 v128) (local $l3 v128)',
  '  ' + Array.from({ length: 32 }, (_, i) => `(local $a${i} v128) (local $p${i} i32)`).join(' '),
  '  (local.set $stride (i32.shl (local.get $words) (i32.const 2)))',
];
for (let ch = 0; ch < 32; ch++)
  simd4.push(`  (local.set $p${ch} (i32.add (i32.const 262144) (i32.mul (local.get $stride) (i32.const ${ch}))))`);
simd4.push('  (if (i32.eqz (local.get $words)) (then (return)))', '  (loop $tiles');
const shuffle = (a, b, lanes) =>
  `(i8x16.shuffle ${lanes.flatMap((lane) => [lane * 4, lane * 4 + 1, lane * 4 + 2, lane * 4 + 3]).join(' ')} ${get(a)} ${get(b)})`;
for (let group = 0; group < 8; group++) {
  for (let tile = 0; tile < 4; tile++)
    simd4.push(
      `    (local.set $a${group * 4 + tile} (v128.load offset=${tile * 128 + group * 16} (local.get $input)))`,
    );
  const a = group * 4;
  simd4.push(
    `    (local.set $l0 ${shuffle('a' + a, 'a' + (a + 1), [0, 4, 1, 5])})`,
    `    (local.set $l1 ${shuffle('a' + (a + 2), 'a' + (a + 3), [0, 4, 1, 5])})`,
    `    (local.set $l2 ${shuffle('a' + a, 'a' + (a + 1), [2, 6, 3, 7])})`,
    `    (local.set $l3 ${shuffle('a' + (a + 2), 'a' + (a + 3), [2, 6, 3, 7])})`,
    `    (local.set $a${a} ${shuffle('l0', 'l1', [0, 1, 4, 5])})`,
    `    (local.set $a${a + 1} ${shuffle('l0', 'l1', [2, 3, 6, 7])})`,
    `    (local.set $a${a + 2} ${shuffle('l2', 'l3', [0, 1, 4, 5])})`,
    `    (local.set $a${a + 3} ${shuffle('l2', 'l3', [2, 3, 6, 7])})`,
  );
}
for (const [shift, mask] of stages)
  for (let a = 0; a < 32; a++) {
    if (a & shift) continue;
    const b = a + shift;
    simd4.push(
      `    (local.set $t (v128.and (v128.xor (i32x4.shr_u ${get('a' + a)} (i32.const ${shift})) ${get('a' + b)}) (v128.const i32x4 ${mask} ${mask} ${mask} ${mask})))`,
      `    (local.set $a${a} (v128.xor ${get('a' + a)} (i32x4.shl ${get('t')} (i32.const ${shift}))))`,
      `    (local.set $a${b} (v128.xor ${get('a' + b)} ${get('t')}))`,
    );
  }
for (let ch = 0; ch < 32; ch++)
  simd4.push(`    (v128.store (i32.add ${get('p' + ch)} ${get('wordByte')}) ${get('a' + ch)})`);
simd4.push(
  '    (local.set $input (i32.add (local.get $input) (i32.const 512)))',
  '    (local.set $wordByte (i32.add (local.get $wordByte) (i32.const 16)))',
  '    (br_if $tiles (i32.lt_u (local.get $wordByte) (local.get $stride)))',
  '  )',
  ')',
);
const wabt = await wabtFactory();
const binaries = {};
for (const [name, lines] of [
  ['scalar', scalar],
  ['simd', [...simd, ...simd4]],
]) {
  const wat = '(module\n(memory (export "memory") 8 8)\n' + lines.join('\n') + '\n)\n';
  const module = wabt.parseWat('transpose32-' + name + '.wat', wat, { simd: true });
  module.resolveNames();
  module.validate({ simd: true });
  const { buffer } = module.toBinary({ canonicalize_lebs: true, write_debug_names: false });
  binaries[name] = Buffer.from(buffer).toString('base64');
  module.destroy();
  console.log(`${name}: ${buffer.length} bytes`);
}
const source =
  Object.entries(binaries)
    .map(([name, base64]) => `export const TRANSPOSE32_${name.toUpperCase()}_BASE64 = '${base64}';`)
    .join('\n') + '\n';
await writeFile(new URL('../src/web/data/transpose32-wasm-binary.ts', import.meta.url), source);
