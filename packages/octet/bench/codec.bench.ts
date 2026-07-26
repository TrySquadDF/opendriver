/**
 * Бенчи горячего пути. Запуск: `bun run bench` (или node с транспиляцией).
 *
 * Гоняйте до и после любых правок в fields.ts / engine.ts.
 * История: ровно такой замер отклонил «улучшение» ручных сдвигов на
 * DataView — оно оказалось ~9x медленнее на примитивах и ~2x на пакете.
 */
import { struct, u8, u16, u32, data } from '../src';
import { bench, consume, flushBlackhole } from './harness';

// ── Типовой пакет: head + динамический body + tail + аддитивный checksum ────
const Packet = struct({
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
      let s = 0;
      for (let i = 0; i < buf.length; i++) s = (s + buf[i]!) & 0xff;
      return s;
    },
  },
});

const NoChecksum = struct({
  size: 10,
  head: [
    ['cmd', u8],
    ['length', u8],
    ['param', u16.le],
  ] as const,
  body: data({ lengthField: 'length', maxLength: 4 }),
  tail: [
    ['seq', u8],
    ['pad', u8],
  ] as const,
});

const input = {
  head: { cmd: 1, length: 0, param: 0x1234 },
  body: new Uint8Array([1, 2, 3]),
  tail: { seq: 9, crc: 0 },
};
const inputNoCrc = {
  head: { cmd: 1, length: 0, param: 0x1234 },
  body: new Uint8Array([1, 2, 3]),
  tail: { seq: 9, pad: 0 },
};

const encoded = Packet.encode(input);
const encodedNoCrc = NoChecksum.encode(inputNoCrc);
const corrupted = new Uint8Array(encoded);
corrupted[1] = (corrupted[1]! + 1) & 0xff;

console.log('--- primitives ---');
const pbuf = new Uint8Array(8);
bench('u8 write+read', () => {
  u8.write(pbuf, 0, 0x7f);
  consume(u8.read(pbuf, 0));
});
bench('u16.le write+read', () => {
  u16.le.write(pbuf, 0, 0x1234);
  consume(u16.le.read(pbuf, 0));
});
bench('u32.be write+read', () => {
  u32.be.write(pbuf, 0, 0xdeadbeef);
  consume(u32.be.read(pbuf, 0));
});

console.log('--- codec hot path ---');
bench('encode (checksum)', () => consume(Packet.encode(input)));
bench('decode (checksum verify)', () => consume(Packet.decode(encoded)));
bench('roundtrip encode+decode (checksum)', () => consume(Packet.decode(Packet.encode(input))));
bench('encode (no checksum)', () => consume(NoChecksum.encode(inputNoCrc)));
bench('decode (no checksum)', () => consume(NoChecksum.decode(encodedNoCrc)));

console.log('--- error path ---');
// Путь ошибки тоже горячий в реальности: битые пакеты от устройства —
// норма, safeDecode на них не должен быть на порядки дороже успеха.
bench('safeDecode of corrupted packet (CRC fail)', () => consume(Packet.safeDecode(corrupted).success));

console.log('--- setup (NOT the hot path) ---');
// «Компилируйте схему один раз»: по замерам struct() стоит лишь ~3x encode,
// но на каждый пакет его всё равно нельзя — он аллоцирует замыкания и
// объекты полей (GC-трафик) и лишает JIT мономорфных путей encode/decode.
bench('struct() schema compilation', () => {
  consume(struct({
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
    checksum: { field: 'crc', calculate: () => 0 },
  }));
}, { warmupIters: 5_000, batch: 2_000 });

flushBlackhole();
