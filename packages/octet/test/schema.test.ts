import { describe, expect, it } from 'bun:test';
import { data, skip, struct, u16, u32, u8 } from '../src';

const sumWithoutLast = (buffer: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    sum = (sum + buffer[i]!) & 0xff;
  }
  return sum;
};

// Всё, что struct() проверяет в момент КОМПИЛЯЦИИ схемы (до первого пакета).
// Правило файла: каждый тест здесь либо проверяет resolvedFields,
// либо ожидает `Schema Error` из вызова struct().
describe('schema compilation', () => {
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

  it('rejects a missing dynamic length field while compiling the schema', () => {
    expect(() => struct({
      size: 2,
      body: data({ lengthField: 'missing', maxLength: 2 }),
    })).toThrow(/Length field "missing" must exist in head/);
  });

  it('rejects a lengthField that points to a non-numeric (data) field', () => {
    // Раньше: lenField.encode(buf, number) на data-поле — тихий no-op,
    // длина не записывалась, пакет уходил битым без единой ошибки.
    expect(() => struct({
      size: 5,
      head: [['len', data({ maxLength: 1 })]] as const,
      body: data({ lengthField: 'len', maxLength: 4 }),
    })).toThrow(/Length field "len" must be an unsigned integer/);
  });

  it('rejects a checksum config that points to a missing field (type- and runtime-level)', () => {
    expect(() =>
      struct({
        size: 1,
        head: [['kind', u8]] as const,
        checksum: {
          // @ts-expect-error checksum.field типизирован именами полей схемы
          field: 'crc',
          calculate: sumWithoutLast,
        },
      }),
    ).toThrow(/Checksum field "crc" not found/);
  });

  it('rejects a checksum field that points to a non-numeric (data) field', () => {
    // Раньше: encode тихо собирал пакет БЕЗ контрольной суммы.
    expect(() => struct({
      size: 2,
      head: [['kind', u8]] as const,
      tail: [['crc', data({ maxLength: 1 })]] as const,
      checksum: { field: 'crc', calculate: () => 7 },
    })).toThrow(/Checksum field "crc" must be an unsigned integer/);
  });
});

describe('skip marker', () => {
  it('produces a { skip } marker for the given byte count', () => {
    expect(skip(0)).toEqual({ skip: 0 });
    expect(skip(5)).toEqual({ skip: 5 });
  });

  it('does not expose a field name (marker-only, not an array)', () => {
    const entry = skip(2);
    expect(Array.isArray(entry)).toBe(false);
    expect(entry).toEqual({ skip: 2 });
  });
});
