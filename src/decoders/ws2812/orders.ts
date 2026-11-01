function permutations(chars: string): readonly string[] {
  if (chars.length < 2) return [chars];
  return chars
    .split('')
    .flatMap((char, index) => permutations(chars.slice(0, index) + chars.slice(index + 1)).map((rest) => char + rest));
}

export const WIRE_ORDERS = Object.freeze([...permutations('RGB'), ...permutations('RGBW')]);
export const TEXT_ORDERS = Object.freeze([...permutations('RGB'), ...permutations('RGBW')]);
