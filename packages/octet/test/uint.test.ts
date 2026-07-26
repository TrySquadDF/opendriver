import { describe, expect, it } from 'bun:test';
import { u8, u16, u32, struct } from '../src';
import type { TypeDef } from '../src';

const BITS_IN_BYTE = 8;

interface UintSpec {
  name: string;
  be: TypeDef<number>;
  le: TypeDef<number>;
  size: number;
  sample: number;
  beBytes: number[];
  overflowIn: number;
}

// Порядок байт всегда явный: у u16/u32 нет «дефолтного» варианта,
// тестируем be/le по отдельности. u8 экспонирует be/le как самоссылки.
const SPECS: UintSpec[] = [
  {
    name: 'u8',
    be: u8.be,
    le: u8.le,
    size: 1,
    sample: 0xab,
    beBytes: [0xab],
    overflowIn: -1,
  },
  {
    name: 'u16',
    be: u16.be,
    le: u16.le,
    size: 2,
    sample: 0x1234,
    beBytes: [0x12, 0x34],
    overflowIn: 0x11234,
  },
  {
    name: 'u32',
    be: u32.be,
    le: u32.le,
    size: 4,
    sample: 0xdeadbeef,
    beBytes: [0xde, 0xad, 0xbe, 0xef],
    overflowIn: 0x1deadbeef,
  },
];

for (const spec of SPECS) {
  describe(`${spec.name} primitive`, () => {
    const { be, le, size, sample, beBytes, overflowIn } = spec;
    const maxValue = (2 ** (size * BITS_IN_BYTE)) - 1;

    it('exposes correct size on both endianness variants', () => {
      expect(be.size).toBe(size);
      expect(le.size).toBe(size);
    });

    it('is branded as an unsigned integer type', () => {
      expect(be.kind).toBe('uint');
      expect(le.kind).toBe('uint');
      expect(be.at(0).kind).toBe('uint');
    });

    it('at(offset) binds a field to the given offset', () => {
      const OFFSET = 2;
      const field = be.at(OFFSET);

      expect(field.offset).toBe(OFFSET);
      expect(field.size).toBe(size);
    });

    it('writes and reads back the value (round-trip)', () => {
      const buffer = new Uint8Array(size);

      be.write(buffer, 0, sample);
      expect(Array.from(buffer)).toEqual(beBytes);

      const readed = be.read(buffer, 0);
      expect(readed).toBe(sample);
    });

    it('field.encode/decode (from at()) match write/read', () => {
      const buffer = new Uint8Array(size);
      const field = be.at(0);

      field.encode(buffer, sample);
      expect(field.decode(buffer)).toBe(sample);
      expect(Array.from(buffer)).toEqual(beBytes);
    });

    it('respects big-endian byte order', () => {
      const buffer = new Uint8Array(size);

      be.write(buffer, 0, sample);
      expect(Array.from(buffer)).toEqual(beBytes);
      expect(be.read(buffer, 0)).toBe(sample);
    });

    it('respects little-endian byte order', () => {
      const buffer = new Uint8Array(size);
      const leBytes = [...beBytes].reverse();

      le.write(buffer, 0, sample);
      expect(Array.from(buffer)).toEqual(leBytes);
      expect(le.read(buffer, 0)).toBe(sample);
    });

    it('endian variants disagree on the same buffer (for multi-byte)', () => {
      const buffer = new Uint8Array(size);
      be.write(buffer, 0, sample);

      expect(be.read(buffer, 0)).toBe(sample);
      // Для multi-byte чтение того же буфера как LE даст ДРУГОЕ число —
      // доказывает, что endianness реально влияет на интерпретацию.
      // Для u8 (1 байт) варианты совпадают — это ожидаемо.
      if (size > 1) {
        expect(le.read(buffer, 0)).not.toBe(sample);
      } else {
        expect(le.read(buffer, 0)).toBe(sample);
      }
    });

    it('rejects values outside the unsigned bit width', () => {
      const buffer = new Uint8Array(size);

      expect(() => be.write(buffer, 0, overflowIn)).toThrow(RangeError);
      expect(Array.from(buffer)).toEqual(new Array<number>(size).fill(0));
    });

    it('clamps to the unsigned maximum, not beyond', () => {
      const buffer = new Uint8Array(size);
      be.write(buffer, 0, maxValue);
      expect(be.read(buffer, 0)).toBe(maxValue);
    });
  });
}

describe('endianness is mandatory for multi-byte integers', () => {
  it('u8 remains directly usable (byte order is meaningless for 1 byte)', () => {
    const buffer = new Uint8Array(1);
    u8.write(buffer, 0, 0x7f);
    expect(u8.read(buffer, 0)).toBe(0x7f);
    expect(u8.be).toBe(u8.le);
  });

  it('rejects a bare u16/u32 in a layout with an actionable message', () => {
    expect(() => struct({
      size: 2,
      // @ts-expect-error bare u16 has no codec — endianness must be explicit
      head: [['value', u16]] as const,
    })).toThrow(/explicit endianness.*u16\.be \/ u16\.le/);
  });
});
