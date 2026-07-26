import { describe, expect, it } from 'bun:test';
import {
  PacketValidationError,
  data,
  skip,
  struct,
  u16,
  u32,
  u8,
} from '../src';

const bytes = (buffer: Uint8Array) => Array.from(buffer);

const sumWithoutLast = (buffer: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    sum = (sum + buffer[i]!) & 0xff;
  }
  return sum;
};

describe('struct', () => {
  it('stores compiled field offsets and sizes from head, body, tail and skips', () => {
    const Packet = struct({
      size: 15,
      head: [
        ['sync', u8],
        skip(2),
        ['length', u16.be],
      ] as const,
      body: data({ lengthField: 'length', maxLength: 4 }),
      tail: [
        ['status', u8],
        skip(1),
        ['packetId', u32.le],
      ] as const,
    });

    expect(Packet.resolvedFields.sync).toMatchObject({ offset: 0, size: 1 });
    expect(Packet.resolvedFields.length).toMatchObject({ offset: 3, size: 2 });
    expect(Packet.resolvedFields.status).toMatchObject({ offset: 9, size: 1 });
    expect(Packet.resolvedFields.packetId).toMatchObject({ offset: 11, size: 4 });
    expect(Object.keys(Packet.resolvedFields)).toEqual([
      'sync',
      'length',
      'status',
      'packetId',
    ]);
  });

  it('encodes a full packet into the expected byte layout', () => {
    const Packet = struct({
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

  it('decodes a full packet back into head, body and tail values', () => {
    const Packet = struct({
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
      body: new Uint8Array(),
      tail: {},
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
      head: {},
      body: new Uint8Array([9, 8, 7]),
      tail: { marker: 0x1234 },
    });

    expect(bytes(encoded)).toEqual([9, 8, 7, 0x12, 0x34]);

    const decoded = Packet.decode(encoded);
    expect(decoded.head).toEqual({});
    expect(bytes(decoded.body)).toEqual([9, 8, 7]);
    expect(decoded.tail).toEqual({ marker: 0x1234 });
  });

  it('leaves omitted fields at zero during encode', () => {
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

    const encoded = Packet.encode({
      head: { a: 0x11 } as { a: number; b: number },
      body: new Uint8Array(),
      tail: { d: 0x44 } as { c: number; d: number },
    });

    expect(bytes(encoded)).toEqual([0x11, 0x00, 0x00, 0x44]);
  });

  it('uses an empty body when input body is omitted for a body schema', () => {
    const Packet = struct({
      size: 4,
      head: [['length', u8]] as const,
      body: data({ lengthField: 'length', maxLength: 3 }),
    });

    const encoded = Packet.encode({
      head: { length: 99 },
      body: undefined as unknown as Uint8Array,
      tail: {},
    });

    expect(bytes(encoded)).toEqual([0, 0, 0, 0]);
    expect(bytes(Packet.decode(encoded).body)).toEqual([]);
  });

  it('calculates checksum during encode and validates it during decode', () => {
    const Packet = struct({
      size: 5,
      head: [
        ['kind', u8],
        ['value', u16.be],
      ] as const,
      tail: [
        ['flags', u8],
        ['crc', u8],
      ] as const,
      checksum: {
        field: 'crc',
        calculate: sumWithoutLast,
      },
    });

    const encoded = Packet.encode({
      head: {
        kind: 0x10,
        value: 0x2030,
      },
      body: new Uint8Array(),
      tail: {
        flags: 0x40,
        crc: 0,
      },
    });

    expect(bytes(encoded)).toEqual([0x10, 0x20, 0x30, 0x40, 0xa0]);

    const decoded = Packet.decode(encoded);
    expect(decoded.head).toEqual({ kind: 0x10, value: 0x2030 });
    expect(decoded.tail).toEqual({ flags: 0x40, crc: 0xa0 });

    const tampered = new Uint8Array(encoded);
    tampered[1] = 0x21;
    expect(() => Packet.decode(tampered)).toThrow(PacketValidationError);
    expect(() => Packet.decode(tampered)).toThrow(/CRC mismatch/);
  });

  it('rejects a checksum config that points to a missing field', () => {
    expect(() =>
      struct({
        size: 1,
        head: [['kind', u8]] as const,
        checksum: {
          field: 'crc',
          calculate: sumWithoutLast,
        },
      }),
    ).toThrow(/Checksum field "crc" not found/);
  });

  it('returns PacketValidationError from safeEncode for invalid payload size', () => {
    const Packet = struct({
      size: 2,
      body: data({ maxLength: 2 }),
    });

    const result = Packet.safeEncode({
      head: {},
      body: new Uint8Array([1, 2, 3]),
      tail: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PacketValidationError);
      expect(result.error.name).toBe('PacketValidationError');
      expect(result.error.issues).toEqual(['Data length 3 exceeds max capacity 2']);
      expect(result.error.message).toBe('Data length 3 exceeds max capacity 2');
    }
  });

  it('returns PacketValidationError from safeDecode for invalid buffer size', () => {
    const Packet = struct({
      size: 2,
      head: [['kind', u16.be]] as const,
    });

    const result = Packet.safeDecode(new Uint8Array([0x12]));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PacketValidationError);
      expect(result.error.issues).toEqual(['Buffer size 1 does not match schema size 2']);
    }
  });

  it('throws PacketValidationError from encode and decode wrappers', () => {
    const Packet = struct({
      size: 1,
      body: data({ maxLength: 1 }),
    });

    expect(() =>
      Packet.encode({
        head: {},
        body: new Uint8Array([1, 2]),
        tail: {},
      }),
    ).toThrow(PacketValidationError);

    expect(() => Packet.decode(new Uint8Array([1, 2]))).toThrow(PacketValidationError);
  });

  it('rejects layouts that do not exactly match the declared packet size', () => {
    expect(() => struct({
      size: 1,
      head: [['value', u16.be]] as const,
    })).toThrow(/Compiled layout size 2 does not match schema size 1/);

    expect(() => struct({
      size: 2,
      head: [['value', u8]] as const,
    })).toThrow(/Represent reserved bytes explicitly with skip/);
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

  it('rejects a missing dynamic length field while compiling the schema', () => {
    expect(() => struct({
      size: 2,
      body: data({ lengthField: 'missing', maxLength: 2 }),
    })).toThrow(/Length field "missing" must exist in head/);
  });

  it('rejects duplicate field names across head and tail at runtime too', () => {
    expect(() => {
      // @ts-expect-error Verifies the runtime guard in addition to the type-level guard.
      struct({
        size: 2,
        head: [['same', u8]] as const,
        tail: [['same', u8]] as const,
      });
    }).toThrow(/Duplicate field name "same"/);
  });

  it('supports checksums wider than one byte', () => {
    const Packet = struct({
      size: 3,
      head: [['kind', u8]] as const,
      tail: [['crc', u16.be]] as const,
      checksum: {
        field: 'crc',
        calculate: () => 0x1234,
      },
    });

    const encoded = Packet.encode({
      head: { kind: 7 },
      body: new Uint8Array(),
      tail: { crc: 0 },
    });

    expect(bytes(encoded)).toEqual([7, 0x12, 0x34]);
    expect(Packet.decode(encoded).tail.crc).toBe(0x1234);
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

  it('keeps encode/decode working when methods are destructured', () => {
    const Packet = struct({ size: 1, head: [['value', u8]] as const });
    const { encode, decode } = Packet;
    const encoded = encode({ head: { value: 42 }, body: new Uint8Array(), tail: {} });

    expect(decode(encoded).head.value).toBe(42);
  });
});
