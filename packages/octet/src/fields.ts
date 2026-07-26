import { BYTE_MASK, BITS_IN_BYTE } from "./bytes/consts";

// Runtime-бренд типа поля. Позволяет engine'у проверять, что ссылки по имени
// (lengthField, checksum.field) указывают на числовое поле, а не на data-блок.
// Без этой проверки lenField.encode(buf, number) на data-поле — тихий no-op
// (Uint8Array.prototype.set(number) ничего не пишет), и пакет уходит битым.
export type FieldKind = 'uint' | 'data';

export interface FieldDef<TType> {
  readonly kind: FieldKind;
  readonly offset: number;
  readonly size: number;
  encode(buffer: Uint8Array, value: TType): void;
  decode(buffer: Uint8Array): TType;
}

export interface TypeDef<TType> {
  readonly kind: FieldKind;
  readonly size: number;
  write(buffer: Uint8Array, offset: number, value: TType): void;
  read(buffer: Uint8Array, offset: number): TType;
  at(offset: number): FieldDef<TType>;
}

export interface DataFieldDef extends FieldDef<Uint8Array> {
  readonly maxLength: number;
}

// Пара BE/LE без «дефолтного» порядка байт. Порядок всегда указывается явно:
// u16.be / u16.le. Неявный дефолт (раньше — BE) — источник многочасовой отладки:
// HID/USB-протоколы почти всегда little-endian.
export interface EndianTypeDef<TType> {
  readonly be: TypeDef<TType>;
  readonly le: TypeDef<TType>;
}

export interface DataFieldFactory extends TypeDef<Uint8Array> {
  readonly lengthField?: string;
  readonly maxLength: number;
  at(offset: number, resolveLengthField?: (name: string) => FieldDef<number> | undefined): DataFieldDef;
}

export type LayoutEntry = readonly [name: string, type: TypeDef<unknown>] | { skip: number };

// Предикат: является ли запись layout'а полем (tuple), а не skip-маркером.
// Вынесен отдельно, чтобы в рекурсивных conditional types TS корректно сужал
// union LayoutEntry и skip-маркеры не ложно матчились под tuple-паттерн.
export type IsField<E> = E extends readonly [string, unknown] ? true : false;

// Извлекает имя поля, если запись — поле. Для skip возвращает never.
export type FieldName<E> = E extends readonly [infer Name extends string, unknown]
  ? Name
  : never;

export type ExtractFieldsKeys<T extends readonly unknown[]> =
  T extends readonly [infer First, ...infer Rest extends readonly unknown[]]
    ? IsField<First> extends true
      ? FieldName<First> | ExtractFieldsKeys<Rest>
      : ExtractFieldsKeys<Rest>
  : never;

// true, если в блоке нет дубликатов имён.
// Вычисляется рекурсивно: для пустого блока → true, при встрече дубля → false.
// Использует IsField-предикат, чтобы skip-маркеры корректно пропускались
// (union LayoutEntry не приводил к ложному матчу tuple-паттерна).
export type HasUniqueNames<T extends readonly LayoutEntry[]> =
  T extends readonly [infer First, ...infer Rest extends readonly LayoutEntry[]]
    ? IsField<First> extends true
      ? FieldName<First> extends ExtractFieldsKeys<Rest>
        ? false
        : HasUniqueNames<Rest>
      : HasUniqueNames<Rest>
    : true;

// На call site (где tuple конкретен) даёт `unknown` при уникальных именах,
// либо требование несуществующего свойства { "duplicate ...": never }.
// Пересечение схемы с этим типом в сигнатуре definePacket превращает
// дубликат в ошибку «property ... is missing» (TS error) с понятным сообщением.
export type Guard<T extends readonly LayoutEntry[], Msg extends string> =
  HasUniqueNames<T> extends true ? unknown : { readonly [K in Msg]: never };

export type BitwiseIntSize = 1 | 2 | 4;

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${value}`);
  }
}

function assertBufferRange(buffer: Uint8Array, offset: number, size: number): void {
  assertNonNegativeInteger(offset, 'Offset');

  if (offset + size > buffer.length) {
    throw new RangeError(
      `Field range [${offset}, ${offset + size}) exceeds buffer length ${buffer.length}`,
    );
  }
}

function createType<TType>(
  kind: FieldKind,
  size: number,
  writer: (buf: Uint8Array, offset: number, value: TType) => void,
  reader: (buf: Uint8Array, offset: number) => TType
): TypeDef<TType> {
  return {
    kind,
    size,
    write: (buffer, offset, value) => {
      assertBufferRange(buffer, offset, size);
      writer(buffer, offset, value);
    },
    read: (buffer, offset) => {
      assertBufferRange(buffer, offset, size);
      return reader(buffer, offset);
    },
    at: (offset) => {
      assertNonNegativeInteger(offset, 'Offset');

      return Object.freeze({
        kind,
        offset,
        size,
        encode: (buffer: Uint8Array, value: TType) => {
          assertBufferRange(buffer, offset, size);
          writer(buffer, offset, value);
        },
        decode: (buffer: Uint8Array) => {
          assertBufferRange(buffer, offset, size);
          return reader(buffer, offset);
        },
      });
    },
  };
}

// Ручные сдвиги, НЕ DataView — осознанное решение по замерам:
// `new DataView(...)` на каждый read/write ~9x медленнее сдвигов, а для
// драйвера с 1000 Гц polling'ом кодек — горячий путь. Корректность сдвигов
// (включая знаковый `<<` на старшем байте u32 с коррекцией `>>> 0`)
// закрыта property-тестами: test/property.test.ts.
function createUintType(size: BitwiseIntSize, isBE: boolean): TypeDef<number> {
  // 2**32 и 2**32 - 1 представимы в double точно, спецкейс не нужен.
  const maxValue = 2 ** (size * BITS_IN_BYTE) - 1;

  // Для u16 BE: start=8, step=-8 (сдвиги: 8, 0)
  // Для u16 LE: start=0, step=8  (сдвиги: 0, 8)
  const startShift = isBE ? (size - 1) * BITS_IN_BYTE : 0;
  const step = isBE ? -BITS_IN_BYTE : BITS_IN_BYTE;

  return createType<number>(
    'uint',
    size,
    (buf, off, val) => {
      if (!Number.isSafeInteger(val) || val < 0 || val > maxValue) {
        throw new RangeError(
          `Unsigned ${size * BITS_IN_BYTE}-bit value must be an integer from 0 to ${maxValue}, got ${val}`,
        );
      }

      let shift = startShift;
      for (let i = 0; i < size; i++) {
        buf[off + i] = (val >>> shift) & BYTE_MASK;
        shift += step;
      }
    },

    (buf, off) => {
      let val = 0;
      let shift = startShift;
      for (let i = 0; i < size; i++) {
        val |= (buf[off + i] ?? 0) << shift;
        shift += step;
      }
      return val >>> 0;
    }
  );
}

function createEndianPair(size: BitwiseIntSize): EndianTypeDef<number> {
  return Object.freeze({
    be: createUintType(size, true),
    le: createUintType(size, false),
  });
}

export const data = (opts: { lengthField?: string; maxLength: number }): DataFieldFactory => {
  const maxLength = opts.maxLength;
  const lengthField = opts.lengthField;

  assertNonNegativeInteger(maxLength, 'Data maxLength');
  if (lengthField !== undefined && lengthField.length === 0) {
    throw new Error('Data lengthField must not be empty');
  }

  const write: (buf: Uint8Array, offset: number, val: Uint8Array) => void = (buf, offset, val) => {
    assertBufferRange(buf, offset, maxLength);
    if (!(val instanceof Uint8Array)) {
      throw new TypeError(`Data field expects a Uint8Array payload, got ${typeof val}`);
    }
    if (val.length > maxLength) {
      throw new Error(`Data length ${val.length} exceeds max capacity ${maxLength}`);
    }
    buf.set(val, offset);
  };

  const read: (buf: Uint8Array, offset: number) => Uint8Array = (buf, offset) => {
    assertBufferRange(buf, offset, maxLength);
    return buf.slice(offset, offset + maxLength);
  };

  return {
    kind: 'data',
    size: maxLength,
    // Условный спред — совместимость с exactOptionalPropertyTypes:
    // отсутствие ключа вместо явного undefined.
    ...(lengthField !== undefined ? { lengthField } : {}),
    maxLength,
    write,
    read,

    at: (offset, resolveLengthField) => {
      assertNonNegativeInteger(offset, 'Offset');

      return Object.freeze({
        kind: 'data' as const,
        offset,
        size: maxLength,
        maxLength,
        encode: (buf: Uint8Array, val: Uint8Array) => {
          write(buf, offset, val);
          if (lengthField && resolveLengthField) {
            const lenField = resolveLengthField(lengthField);
            if (!lenField) {
              throw new Error(`Length field "${lengthField}" was not found`);
            }
            lenField.encode(buf, val.length);
          }
        },
        decode: (buf: Uint8Array) => {
          assertBufferRange(buf, offset, maxLength);
          if (lengthField && resolveLengthField) {
            const lenField = resolveLengthField(lengthField);
            if (lenField) {
              const len = lenField.decode(buf);
              if (!Number.isSafeInteger(len) || len < 0 || len > maxLength) {
                throw new RangeError(
                  `Data length ${len} from field "${lengthField}" exceeds max capacity ${maxLength}`,
                );
              }
              return buf.slice(offset, offset + len);
            }
          }

          return read(buf, offset);
        }
      });
    },
  };
};

export const skip = (bytes: number): LayoutEntry => {
  assertNonNegativeInteger(bytes, 'Skip size');
  return Object.freeze({ skip: bytes });
};

export const isField = (e: LayoutEntry): e is readonly [string, TypeDef<unknown>] => Array.isArray(e);
export const extractFieldsKeys = (fields: readonly LayoutEntry[] | undefined) => fields?.filter(isField).map(e => e[0]) || []

// u8 — один байт, порядок байт не имеет смысла; be/le — самоссылки,
// чтобы сгенерированный/шаблонный код мог единообразно писать `.le`.
const u8Type = createUintType(1, true);
export const u8: TypeDef<number> & EndianTypeDef<number> = Object.freeze({
  ...u8Type,
  be: u8Type,
  le: u8Type,
});

// ВНИМАНИЕ: у u16/u32 больше нет неявного порядка байт.
// `['x', u16]` — ошибка компиляции; пишите `['x', u16.le]` или `['x', u16.be]`.
export const u16: EndianTypeDef<number> = createEndianPair(2);
export const u32: EndianTypeDef<number> = createEndianPair(4);
