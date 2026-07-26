import { describe, expect, it } from 'bun:test';
import { PacketValidationError, skip, struct, u16, u8 } from '../src';

const bytes = (buffer: Uint8Array) => Array.from(buffer);

const sumWithoutLast = (buffer: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    sum = (sum + buffer[i]!) & 0xff;
  }
  return sum;
};

describe('checksum', () => {
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
      tail: { crc: 0 },
    });

    expect(bytes(encoded)).toEqual([7, 0x12, 0x34]);
    expect(Packet.decode(encoded).tail.crc).toBe(0x1234);
  });

  it('passes the checksum field position to calculate (real CRCs need to exclude bytes)', () => {
    let seen: { offset: number; size: number } | undefined;
    const Packet = struct({
      size: 4,
      head: [['kind', u8]] as const,
      tail: [skip(1), ['crc', u16.be]] as const,
      checksum: {
        field: 'crc',
        calculate: (_buf, field) => {
          seen = field;
          return 0xbeef;
        },
      },
    });

    Packet.encode({ head: { kind: 1 }, tail: { crc: 0 } });
    expect(seen).toEqual({ offset: 2, size: 2 });
  });

  it('decode does not mutate the caller\'s buffer (in-place zeroing is restored)', () => {
    const Packet = struct({
      size: 3,
      head: [['kind', u8], ['value', u8]] as const,
      tail: [['crc', u8]] as const,
      checksum: {
        field: 'crc',
        calculate: (buf) => {
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum = (sum + buf[i]!) & 0xff;
          return sum;
        },
      },
    });

    const encoded = Packet.encode({ head: { kind: 1, value: 2 }, tail: { crc: 0 } });
    const snapshot = bytes(encoded);

    Packet.decode(encoded);
    // Расчёт checksum зануляет поле на месте — но обязан восстановить его.
    expect(bytes(encoded)).toEqual(snapshot);
  });

  it('restores the caller\'s buffer even when calculate throws during decode', () => {
    const Packet = struct({
      size: 2,
      head: [['kind', u8]] as const,
      tail: [['crc', u8]] as const,
      checksum: {
        field: 'crc',
        calculate: () => { throw new Error('boom'); },
      },
    });

    const buf = new Uint8Array([0x11, 0x99]);
    const snapshot = bytes(buf);

    expect(Packet.safeDecode(buf).success).toBe(false);
    expect(bytes(buf)).toEqual(snapshot);
  });

  it('zeroes the checksum field in the buffer passed to calculate', () => {
    let seenBytes: number[] = [];
    const Packet = struct({
      size: 3,
      head: [['kind', u8], ['value', u8]] as const,
      tail: [['crc', u8]] as const,
      checksum: {
        field: 'crc',
        calculate: (buf) => {
          seenBytes = bytes(buf);
          return 0x42;
        },
      },
    });

    // Пользователь передал crc: 0x99 — в calculate поле обязано прийти
    // занулённым, иначе сумма зависела бы от мусора на месте crc.
    Packet.encode({ head: { kind: 1, value: 2 }, tail: { crc: 0x99 } });
    expect(seenBytes).toEqual([1, 2, 0]);
  });
});
