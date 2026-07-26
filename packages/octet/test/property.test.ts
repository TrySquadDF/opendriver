import { describe, expect, it } from 'bun:test';
import { data, struct, u16, u32, u8 } from '../src';
import type { TypeDef } from '../src';

// Property-тесты: инварианты на случайных входах ловят класс ошибок
// со сдвигами/границами, который example-based тесты пропускают.
// PRNG детерминирован (mulberry32 + фиксированный seed) — прогоны
// воспроизводимы; при падении итерация видна в сообщении ассерта.
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SEED = 0x0c7e701;
const ITERATIONS = 250;

describe('property: uint round-trips', () => {
  const cases: Array<[string, TypeDef<number>, number]> = [
    ['u8', u8, 0xff],
    ['u16.be', u16.be, 0xffff],
    ['u16.le', u16.le, 0xffff],
    ['u32.be', u32.be, 0xffff_ffff],
    ['u32.le', u32.le, 0xffff_ffff],
  ];

  for (const [name, type, max] of cases) {
    it(`${name}: read(write(x)) === x for random x in [0, ${max}]`, () => {
      const rand = mulberry32(SEED);
      const buffer = new Uint8Array(type.size);

      for (let i = 0; i < ITERATIONS; i++) {
        const value = Math.floor(rand() * (max + 1));
        type.write(buffer, 0, value);
        const back = type.read(buffer, 0);
        // Сообщение с итерацией и значением — чтобы падение было воспроизводимо.
        if (back !== value) {
          throw new Error(`${name} round-trip failed at iteration ${i}: wrote ${value}, read ${back}`);
        }
      }
    });
  }
});

describe('property: packet round-trips', () => {
  const makePacket = () => struct({
    size: 10,
    head: [
      ['cmd', u8],
      ['length', u8],
      ['param', u16.le],
    ] as const,
    body: data({ lengthField: 'length', maxLength: 4 }),
    tail: [
      ['seq', u8],
      ['crc', u8],
    ] as const,
    checksum: {
      field: 'crc',
      calculate: (buf) => {
        let sum = 0;
        for (const byte of buf) sum = (sum + byte) & 0xff;
        return (0x55 - sum) & 0xff;
      },
    },
  });

  it('decode(encode(x)) deeply equals x for random valid inputs', () => {
    const rand = mulberry32(SEED);
    const Packet = makePacket();

    for (let i = 0; i < ITERATIONS; i++) {
      const bodyLength = Math.floor(rand() * 5); // 0..4
      const body = new Uint8Array(bodyLength);
      for (let b = 0; b < bodyLength; b++) body[b] = Math.floor(rand() * 256);

      const input = {
        head: {
          cmd: Math.floor(rand() * 256),
          // length перезаписывается кодеком реальной длиной body —
          // передаём мусор и проверяем, что он не влияет на результат.
          length: Math.floor(rand() * 256),
          param: Math.floor(rand() * 0x10000),
        },
        body,
        tail: {
          seq: Math.floor(rand() * 256),
          crc: 0,
        },
      };

      const decoded = Packet.decode(Packet.encode(input));

      expect(decoded.head.cmd).toBe(input.head.cmd);
      expect(decoded.head.param).toBe(input.head.param);
      expect(decoded.head.length).toBe(bodyLength);
      expect(Array.from(decoded.body)).toEqual(Array.from(body));
      expect(decoded.tail.seq).toBe(input.tail.seq);
    }
  });

  it('any single-byte corruption is rejected by the additive checksum', () => {
    const rand = mulberry32(SEED ^ 0xffff);
    const Packet = makePacket();

    for (let i = 0; i < ITERATIONS; i++) {
      const body = new Uint8Array([1, 2, 3]);
      const encoded = Packet.encode({
        head: { cmd: Math.floor(rand() * 256), length: 0, param: Math.floor(rand() * 0x10000) },
        body,
        tail: { seq: Math.floor(rand() * 256), crc: 0 },
      });

      // Портим один случайный байт на гарантированно другое значение.
      const tampered = new Uint8Array(encoded);
      const pos = Math.floor(rand() * tampered.length);
      const delta = 1 + Math.floor(rand() * 255); // 1..255 → значение точно меняется
      tampered[pos] = (tampered[pos]! + delta) & 0xff;

      const result = Packet.safeDecode(tampered);
      if (result.success) {
        throw new Error(
          `corruption at byte ${pos} (iteration ${i}) was not detected: `
          + `[${Array.from(encoded)}] → [${Array.from(tampered)}]`,
        );
      }
    }
  });
});
