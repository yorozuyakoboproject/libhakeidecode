import type { WaveformEncoder } from '../../build/roundtrip.js';
import { createEncoder as createSpiEncoder } from '../spi/encoder.js';
import type { SPICase } from '../spi/generator.js';
import type { Max72xxCase } from './generator.js';

export function createEncoder(config: Max72xxCase): WaveformEncoder<number> {
  const options = config.chain?.[0]?.options;
  if (!options) throw new Error('MAX72xx requires an SPI chain');
  const spi = createSpiEncoder({ ...config, options } as SPICase);
  return {
    *push(data) {
      const words = data.map((byte) => {
        if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new RangeError('MAX72xx byte is out of range');
        return { mosi: byte };
      });
      yield* spi.push(words);
    },
    *finish() {
      yield* spi.finish();
    },
  };
}
