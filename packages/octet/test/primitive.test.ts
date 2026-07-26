import { describe, expect, it } from 'bun:test';
import { u8, u16, u32, data, skip, struct } from '../src';

const BITS_IN_BYTE = 8;

interface PrimitiveSpec {
  name: string;
  type: typeof u8;
  size: number;
  sample: number;
  beBytes: number[];
  overflowIn: number;
}

const SPECS: PrimitiveSpec[] = [
  {
    name: 'u8',
    type: u8,
    size: 1,
    sample: 0xab,
    beBytes: [0xab],
    overflowIn: -1,
  },
  {
    name: 'u16',
    type: u16,
    size: 2,
    sample: 0x1234,
    beBytes: [0x12, 0x34],
    overflowIn: 0x11234,
  },
  {
    name: 'u32',
    type: u32,
    size: 4,
    sample: 0xdeadbeef,
    beBytes: [0xde, 0xad, 0xbe, 0xef],
    overflowIn: 0x1deadbeef,
  },
];

for (const spec of SPECS) {
  describe(`${spec.name} primitive`, () => {
    const { type, size, sample, beBytes, overflowIn } = spec;
    const maxValue = (2 ** (size * BITS_IN_BYTE)) - 1;

    it('exposes correct size and endianness variants', () => {
      expect(type.size).toBe(size);
      expect(type.be.size).toBe(size);
      expect(type.le.size).toBe(size);
    });

    it('at(offset) binds a field to the given offset', () => {
      const OFFSET = 2;
      const field = type.at(OFFSET);

      expect(field.offset).toBe(OFFSET);
      expect(field.size).toBe(size);
    });

    it('writes and reads back the value (round-trip)', () => {
      const buffer = new Uint8Array(size);

      type.write(buffer, 0, sample);
      expect(Array.from(buffer)).toEqual(beBytes);

      const readed = type.read(buffer, 0);
      expect(readed).toBe(sample);
    });

    it('field.encode/decode (from at()) match write/read', () => {
      const buffer = new Uint8Array(size);
      const field = type.at(0);

      field.encode(buffer, sample);
      expect(field.decode(buffer)).toBe(sample);
      expect(Array.from(buffer)).toEqual(beBytes);
    });

    it('respects big-endian byte order', () => {
      const buffer = new Uint8Array(size);

      type.be.write(buffer, 0, sample);
      expect(Array.from(buffer)).toEqual(beBytes);
      expect(type.be.read(buffer, 0)).toBe(sample);
    });

    it('respects little-endian byte order', () => {
      const buffer = new Uint8Array(size);
      const leBytes = [...beBytes].reverse();

      type.le.write(buffer, 0, sample);
      expect(Array.from(buffer)).toEqual(leBytes);
      expect(type.le.read(buffer, 0)).toBe(sample);
    });

    it('endian variants disagree on the same buffer (for multi-byte)', () => {
      const buffer = new Uint8Array(size);
      type.be.write(buffer, 0, sample);

      expect(type.be.read(buffer, 0)).toBe(sample);
      // Для multi-byte чтение того же буфера как LE даст ДРУГОЕ число —
      // доказывает, что endianness реально влияет на интерпретацию.
      // Для u8 (1 байт) варианты совпадают — это ожидаемо.
      if (size > 1) {
        expect(type.le.read(buffer, 0)).not.toBe(sample);
      } else {
        expect(type.le.read(buffer, 0)).toBe(sample);
      }
    });

    it('rejects values outside the unsigned bit width', () => {
      const buffer = new Uint8Array(size);

      expect(() => type.write(buffer, 0, overflowIn)).toThrow(RangeError);
      expect(Array.from(buffer)).toEqual(new Array<number>(size).fill(0));
    });

    it('clamps to the unsigned maximum, not beyond', () => {
      const buffer = new Uint8Array(size);
      type.write(buffer, 0, maxValue);
      expect(type.read(buffer, 0)).toBe(maxValue);
    });
  });
}

describe('skip', () => {
  it('produces a { skip } marker for the given byte count', () => {
    expect(skip(0)).toEqual({ skip: 0 });
    expect(skip(5)).toEqual({ skip: 5 });
  });

  it('does not expose a field name (marker-only, not an array)', () => {
    const entry = skip(2);
    expect(Array.isArray(entry)).toBe(false);
    expect(entry).toEqual({ skip: 2 });
  });

  it('advances the offset without writing a field in a struct', () => {
    const P = struct({
      size: 1 + 2 + 1,
      head: [
        ['before', u8],
        skip(2),
        ['after', u8],
      ] as const,
    });

    const buf = P.encode({ head: { before: 0xaa, after: 0xbb }, body: new Uint8Array(), tail: {} });
    // before@0, [skip @1..2], after@3
    expect(Array.from(buf)).toEqual([0xaa, 0, 0, 0xbb]);
    expect(P.decode(buf).head.before).toBe(0xaa);
    expect(P.decode(buf).head.after).toBe(0xbb);
  });
});

describe('data() field', () => {
  describe('core factory', () => {
    it('exposes size and maxLength equal to opts.maxLength', () => {
      const d = data({ maxLength: 8 });
      expect(d.size).toBe(8);

      expect(d.maxLength).toBe(8);
      expect(d.at(0).maxLength).toBe(8);
    });

    it('write/read round-trip copies bytes at the given offset', () => {
      const d = data({ maxLength: 4 });
      const buf = new Uint8Array(8);
      const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

      d.write(buf, 2, payload);
      expect(Array.from(buf)).toEqual([0, 0, 0xaa, 0xbb, 0xcc, 0xdd, 0, 0]);
      expect(Array.from(d.read(buf, 2))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    });

    it('read returns maxLength bytes regardless of actual payload', () => {
      const d = data({ maxLength: 4 });
      const buf = new Uint8Array([0x11, 0x22, 0x00, 0x00]);

      expect(Array.from(d.read(buf, 0))).toEqual([0x11, 0x22, 0x00, 0x00]);
    });
  });

  describe('overflow guard', () => {
    it('throws when payload exceeds maxLength', () => {
      const d = data({ maxLength: 2 });
      const tooBig = new Uint8Array([1, 2, 3]);

      expect(() => d.write(new Uint8Array(3), 0, tooBig)).toThrow(/exceeds max capacity/);
    });

    it('accepts payload exactly at maxLength boundary', () => {
      const d = data({ maxLength: 3 });
      const buf = new Uint8Array(3);
      const exact = new Uint8Array([1, 2, 3]);

      expect(() => d.write(buf, 0, exact)).not.toThrow();
      expect(Array.from(buf)).toEqual([1, 2, 3]);
    });
  });

  describe('at() — field binding', () => {
    it('binds to offset and exposes maxLength', () => {
      const d = data({ maxLength: 4 });
      const field = d.at(5);

      expect(field.offset).toBe(5);
      expect(field.size).toBe(4);
      expect(field.maxLength).toBe(4);
    });

    it('encode/decode round-trip without a lengthField', () => {
      const d = data({ maxLength: 4 });
      const field = d.at(0);
      const buf = new Uint8Array(4);
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

      field.encode(buf, payload);
      expect(Array.from(buf)).toEqual([0xde, 0xad, 0xbe, 0xef]);
      expect(Array.from(field.decode(buf))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });
  });

  describe('lengthField resolver', () => {
    // layout'а: [len: u8][payload: data(maxLength 4)]
    const makeLayout = () => {
      const lenField = u8.at(0);
      const payloadField = data({ lengthField: 'len', maxLength: 4 }).at(
        1,
        (name) => (name === 'len' ? lenField : undefined),
      );
      return { lenField, payloadField };
    };

    it('encode writes the payload length into the referenced field', () => {
      const { lenField, payloadField } = makeLayout();
      const buf = new Uint8Array(5); // len + 4 payload
      const payload = new Uint8Array([0xaa, 0xbb]); // length 2

      payloadField.encode(buf, payload);

      // len auto-filled to 2
      expect(lenField.decode(buf)).toBe(2);
      expect(Array.from(buf)).toEqual([2, 0xaa, 0xbb, 0, 0]);
    });

    it('decode trims the payload to the stored length', () => {
      const { payloadField } = makeLayout();
      const buf = new Uint8Array([3, 0x01, 0x02, 0x03, 0xff]); // len=3, last byte is garbage

      const decoded = payloadField.decode(buf);

      expect(Array.from(decoded)).toEqual([0x01, 0x02, 0x03]);
    });

    it('decode with length 0 returns an empty Uint8Array', () => {
      const { payloadField } = makeLayout();
      const buf = new Uint8Array([0, 0xaa, 0xbb, 0xcc, 0xdd]);

      expect(Array.from(payloadField.decode(buf))).toEqual([]);
    });

    it('ignores lengthField when no resolver is provided (fixed-size fallback)', () => {
      const field = data({ lengthField: 'len', maxLength: 4 }).at(1);
      const buf = new Uint8Array([9, 0xaa, 0xbb, 0xcc, 0xdd]);

      expect(Array.from(field.decode(buf))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    });
  });
});
