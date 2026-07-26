import { describe, expect, it } from 'bun:test';
import { data, skip, struct, u16, u32, u8 } from '../src';

const bytes = (buffer: Uint8Array) => Array.from(buffer);

// Общая схема для encode/decode-тестов: head + динамический body + tail.
// Единственная разделяемая фикстура файла — используется там, где тесты
// проверяют РАЗНЫЕ стороны одного и того же layout'а.
const makeTestPacket = () => struct({
  size: 13,
  head: [
    ['sync', u8],
    ['length', u8],
    ['command', u16.be],
  ] as const,
  body: data({ lengthField: 'length', maxLength: 4 }),
  tail: [
    ['status', u8],
    ['packetId', u32.le],
  ] as const,
});

describe('codec: encode', () => {
  it('encodes a full packet into the expected byte layout', () => {
    const Packet = makeTestPacket();

    const encoded = Packet.encode({
      head: {
        sync: 0xa5,
        length: 0,
        command: 0x1234,
      },
      body: new Uint8Array([0xde, 0xad, 0xbe]),
      tail: {
        status: 0x7f,
        packetId: 0xcafebabe,
      },
    });

    expect(bytes(encoded)).toEqual([
      0xa5,
      0x03,
      0x12,
      0x34,
      0xde,
      0xad,
      0xbe,
      0x00,
      0x7f,
      0xbe,
      0xba,
      0xfe,
      0xca,
    ]);
  });

  it('uses an empty body when input body is omitted for a body schema', () => {
    const Packet = struct({
      size: 4,
      head: [['length', u8]] as const,
      body: data({ lengthField: 'length', maxLength: 3 }),
    });

    const encoded = Packet.encode({
      head: { length: 99 },
      // body опционален на уровне типов: отсутствие = пустой payload.
    });

    expect(bytes(encoded)).toEqual([0, 0, 0, 0]);
    expect(bytes(Packet.decode(encoded).body)).toEqual([]);
  });

  it('throws on a missing field value instead of silently encoding zero', () => {
    const Packet = struct({
      size: 4,
      head: [
        ['a', u8],
        ['b', u8],
      ] as const,
      tail: [
        ['c', u8],
        ['d', u8],
      ] as const,
    });

    // Раньше пропущенное поле тихо становилось 0x00 и улетало в устройство.
    const result = Packet.safeEncode({
      head: { a: 0x11 } as { a: number; b: number },
      tail: { c: 0x33, d: 0x44 },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/Missing value for field "b" in "head"/);
    }
  });

  it('throws when a whole block with declared fields is missing', () => {
    const Packet = struct({
      size: 1,
      head: [['a', u8]] as const,
    });

    const result = Packet.safeEncode({} as { head: { a: number } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/Missing "head" block/);
    }
  });
});

describe('codec: decode', () => {
  it('decodes a full packet back into head, body and tail values', () => {
    const Packet = makeTestPacket();

    const decoded = Packet.decode(new Uint8Array([
      0xa5,
      0x02,
      0x12,
      0x34,
      0xde,
      0xad,
      0xff,
      0xee,
      0x7f,
      0xbe,
      0xba,
      0xfe,
      0xca,
    ]));

    expect(decoded.head).toEqual({
      sync: 0xa5,
      length: 2,
      command: 0x1234,
    });
    expect(bytes(decoded.body)).toEqual([0xde, 0xad]);
    expect(decoded.tail).toEqual({
      status: 0x7f,
      packetId: 0xcafebabe,
    });
  });

  it('rejects a dynamic body length that exceeds its capacity', () => {
    const Packet = struct({
      size: 4,
      head: [['length', u8]] as const,
      body: data({ lengthField: 'length', maxLength: 2 }),
      tail: [['crc', u8]] as const,
    });

    expect(() => Packet.decode(new Uint8Array([3, 0xaa, 0xbb, 0xcc])))
      .toThrow(/Data length 3 .* exceeds max capacity 2/);
  });

  it('returns owned body bytes and keeps prototype-like field names', () => {
    const Packet = struct({
      size: 2,
      head: [['__proto__', u8]] as const,
      body: data({ maxLength: 1 }),
    });
    const buffer = new Uint8Array([0x11, 0x22]);

    const decoded = Packet.decode(buffer);
    buffer[1] = 0xff;

    expect(Object.hasOwn(decoded.head, '__proto__')).toBe(true);
    expect(decoded.head.__proto__).toBe(0x11);
    expect(bytes(decoded.body)).toEqual([0x22]);
  });
});

describe('codec: layout variants', () => {
  it('round-trips a packet with fixed-size body when no length field is used', () => {
    const Packet = struct({
      size: 8,
      head: [['kind', u16.be]] as const,
      body: data({ maxLength: 4 }),
      tail: [['crc', u16.le]] as const,
    });

    const input = {
      head: { kind: 0xabcd },
      body: new Uint8Array([1, 2, 3, 4]),
      tail: { crc: 0x1234 },
    };

    const encoded = Packet.encode(input);
    expect(bytes(encoded)).toEqual([0xab, 0xcd, 1, 2, 3, 4, 0x34, 0x12]);

    const decoded = Packet.decode(encoded);
    expect(decoded.head).toEqual(input.head);
    expect(bytes(decoded.body)).toEqual([1, 2, 3, 4]);
    expect(decoded.tail).toEqual(input.tail);
  });

  it('supports layouts with only a head block', () => {
    const Packet = struct({
      size: 7,
      head: [
        ['op', u8],
        ['value', u16.le],
        ['serial', u32.be],
      ] as const,
    });

    const encoded = Packet.encode({
      head: {
        op: 0x10,
        value: 0x2030,
        serial: 0x40506070,
      },
    });

    expect(bytes(encoded)).toEqual([0x10, 0x30, 0x20, 0x40, 0x50, 0x60, 0x70]);
    expect(Packet.decode(encoded)).toEqual({
      head: {
        op: 0x10,
        value: 0x2030,
        serial: 0x40506070,
      },
      body: new Uint8Array(),
      tail: {},
    });
  });

  it('supports layouts with only body and tail blocks', () => {
    const Packet = struct({
      size: 5,
      body: data({ maxLength: 3 }),
      tail: [['marker', u16.be]] as const,
    });

    const encoded = Packet.encode({
      body: new Uint8Array([9, 8, 7]),
      tail: { marker: 0x1234 },
    });

    expect(bytes(encoded)).toEqual([9, 8, 7, 0x12, 0x34]);

    const decoded = Packet.decode(encoded);
    expect(decoded.head).toEqual({});
    expect(bytes(decoded.body)).toEqual([9, 8, 7]);
    expect(decoded.tail).toEqual({ marker: 0x1234 });
  });

  it('advances the offset over skip() without writing a field', () => {
    const P = struct({
      size: 1 + 2 + 1,
      head: [
        ['before', u8],
        skip(2),
        ['after', u8],
      ] as const,
    });

    const buf = P.encode({ head: { before: 0xaa, after: 0xbb } });
    // before@0, [skip @1..2], after@3
    expect(Array.from(buf)).toEqual([0xaa, 0, 0, 0xbb]);
    expect(P.decode(buf).head.before).toBe(0xaa);
    expect(P.decode(buf).head.after).toBe(0xbb);
  });

  it('keeps encode/decode working when methods are destructured', () => {
    const Packet = struct({ size: 1, head: [['value', u8]] as const });
    const { encode, decode } = Packet;
    const encoded = encode({ head: { value: 42 } });

    expect(decode(encoded).head.value).toBe(42);
  });
});
