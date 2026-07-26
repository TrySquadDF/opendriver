import { describe, expect, it } from 'bun:test';
import { u8, data } from '../src';

describe('data() field', () => {
  describe('core factory', () => {
    it('exposes size and maxLength equal to opts.maxLength', () => {
      const d = data({ maxLength: 8 });
      expect(d.size).toBe(8);

      expect(d.maxLength).toBe(8);
      expect(d.at(0).maxLength).toBe(8);
    });

    it('is branded as a data field', () => {
      const d = data({ maxLength: 8 });
      expect(d.kind).toBe('data');
      expect(d.at(0).kind).toBe('data');
    });

    it('omits the lengthField key entirely when not configured', () => {
      // exactOptionalPropertyTypes: отсутствие ключа, а не явный undefined.
      expect(Object.hasOwn(data({ maxLength: 4 }), 'lengthField')).toBe(false);
      expect(data({ lengthField: 'len', maxLength: 4 }).lengthField).toBe('len');
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

    it('rejects non-Uint8Array payloads loudly (no silent no-op)', () => {
      const d = data({ maxLength: 4 });
      const buf = new Uint8Array(4);

      // buf.set(number) — тихий no-op в JS; библиотека обязана кричать.
      expect(() => d.write(buf, 0, 42 as unknown as Uint8Array)).toThrow(TypeError);
      expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
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
