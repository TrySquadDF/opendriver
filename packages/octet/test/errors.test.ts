import { describe, expect, it } from 'bun:test';
import { PacketValidationError, data, struct, u16, u8 } from '../src';

// Контракт ошибок: форма PacketValidationError, поведение safe*-пары
// и throw-обёрток, сохранение исходной ошибки в cause.
describe('error contract', () => {
  it('returns PacketValidationError from safeEncode for invalid payload size', () => {
    const Packet = struct({
      size: 2,
      body: data({ maxLength: 2 }),
    });

    const result = Packet.safeEncode({
      body: new Uint8Array([1, 2, 3]),
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
        body: new Uint8Array([1, 2]),
      }),
    ).toThrow(PacketValidationError);

    expect(() => Packet.decode(new Uint8Array([1, 2]))).toThrow(PacketValidationError);
  });

  it('preserves the original error as cause in PacketValidationError', () => {
    const boom = new Error('calculate blew up');
    const Packet = struct({
      size: 2,
      head: [['kind', u8]] as const,
      tail: [['crc', u8]] as const,
      checksum: { field: 'crc', calculate: () => { throw boom; } },
    });

    const result = Packet.safeEncode({ head: { kind: 1 }, tail: { crc: 0 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.cause).toBe(boom);
    }
  });
});
