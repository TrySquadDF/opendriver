/**
 * Type-level тесты. Файл НЕ исполняется (bun test берёт только *.test.ts),
 * но входит в `tsc -p tsconfig.json` — проверка происходит на typecheck'е.
 *
 * Правила файла:
 * - позитивные проверки — через Expect<Equal<...>>;
 * - негативные — через @ts-expect-error с комментарием, КАКАЯ ошибка ожидается
 *   (помните: @ts-expect-error гасит ЛЮБУЮ ошибку на строке — держите
 *   выражение на строке минимальным, чтобы не замаскировать опечатку);
 * - весь код обёрнут в неисполняемые замыкания.
 */
import { struct, u8, u16, u32, data, magic } from '../src';
import type { FieldDef } from '../src';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

const makePacket = () => struct({
  size: 5,
  head: [
    ['cmd', u8],
    ['value', u16.le],
  ] as const,
  tail: [
    ['seq', u8],
    ['crc', u8],
  ] as const,
  checksum: { field: 'crc', calculate: () => 0 },
});

// ── Вывод типов результата decode ────────────────────────────────────────────
type Decoded = ReturnType<ReturnType<typeof makePacket>['decode']>;

type _headIsTyped = Expect<Equal<Decoded['head'], { cmd: number; value: number }>>;
type _bodyIsBytes = Expect<Equal<Decoded['body'], Uint8Array>>;
type _tailIsTyped = Expect<Equal<Decoded['tail'], { seq: number; crc: number }>>;

// ── resolvedFields типизирован по именам и типам значений полей ─────────────
type Fields = ReturnType<typeof makePacket>['resolvedFields'];

type _fieldDefIsTyped = Expect<Equal<Fields['cmd'], FieldDef<number>>>;
const _unknownFieldIsError = () => {
  const P = makePacket();
  // @ts-expect-error 'nope' is not a field of this schema
  return P.resolvedFields.nope;
};

// ── PacketInput: body опционален, пустые блоки можно не передавать ──────────
const _bodyIsOptional = () =>
  makePacket().encode({ head: { cmd: 1, value: 2 }, tail: { seq: 0, crc: 0 } });

const _emptyBlocksAreOptional = () => {
  const P = struct({ size: 2, body: data({ maxLength: 2 }) });
  return P.encode({ body: new Uint8Array([1, 2]) });
};

// ── Обязательность полей на входе encode ─────────────────────────────────────
const _missingHeadFieldIsError = () =>
  // @ts-expect-error property 'value' is missing in head
  makePacket().encode({ head: { cmd: 1 }, tail: { seq: 0, crc: 0 } });

// ── Endianness обязателен для multi-byte ─────────────────────────────────────
const _bareU16IsError = () => struct({
  size: 2,
  // @ts-expect-error bare u16 has no codec — use u16.be / u16.le
  head: [['x', u16]] as const,
});

const _bareU32IsError = () => struct({
  size: 4,
  // @ts-expect-error bare u32 has no codec — use u32.be / u32.le
  head: [['x', u32]] as const,
});

// ── checksum.field типизирован именами полей схемы ──────────────────────────
const _checksumTypoIsError = () => struct({
  size: 2,
  head: [['kind', u8], ['crc', u8]] as const,
  checksum: {
    // @ts-expect-error 'crk' is not a field of this schema
    field: 'crk',
    calculate: () => 0,
  },
});

// ── magic: константы не участвуют ни во входе encode, ни в результате decode ─
const makeMagicPacket = () => struct({
  size: 5,
  head: [
    magic(u8, 0xa5),
    ['cmd', u8],
  ] as const,
  tail: [
    magic(u16.be, 0x0d0a),
    ['crc', u8],
  ] as const,
});

type MagicDecoded = ReturnType<ReturnType<typeof makeMagicPacket>['decode']>;
type _magicNotInHead = Expect<Equal<MagicDecoded['head'], { cmd: number }>>;
type _magicNotInTail = Expect<Equal<MagicDecoded['tail'], { crc: number }>>;

const _magicNotRequiredInInput = () =>
  makeMagicPacket().encode({ head: { cmd: 1 }, tail: { crc: 0 } });

// Блок только из констант — во входе не обязателен.
const _magicOnlyBlockIsOptional = () => {
  const P = struct({ size: 2, head: [magic(u16.be, 0xbeef)] as const });
  return P.encode({});
};

const _bareU16MagicIsError = () =>
  // @ts-expect-error bare u16 has no codec — use u16.be / u16.le
  magic(u16, 0xffff);

const _dataMagicIsError = () =>
  // @ts-expect-error magic requires an unsigned integer type
  magic(data({ maxLength: 2 }), 0);

// ── Дубликаты имён — ошибка типов ────────────────────────────────────────────
const _duplicateInHeadIsError = () =>
  // @ts-expect-error duplicate field names in "head"
  struct({ size: 2, head: [['a', u8], ['a', u8]] as const });

const _duplicateAcrossBlocksIsError = () =>
  // @ts-expect-error duplicate field names across "head" and "tail"
  struct({ size: 2, head: [['a', u8]] as const, tail: [['a', u8]] as const });
