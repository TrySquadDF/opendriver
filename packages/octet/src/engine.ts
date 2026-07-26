import type {
  TypeDef,
  FieldDef,
  DataFieldFactory,
  DataFieldDef,
  LayoutEntry,
  Guard,
  ExtractFieldsKeys,
} from './fields';

import { isField, extractFieldsKeys } from './fields'

type AssertUniqueHead<T extends readonly LayoutEntry[]> = Guard<T, '⚠ duplicate field names in "head"'>;
type AssertUniqueTail<T extends readonly LayoutEntry[]> = Guard<T, '⚠ duplicate field names in "tail"'>;
type AssertNoCrossBlockDuplicates<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[],
> = [ExtractFieldsKeys<THead> & ExtractFieldsKeys<TTail>] extends [never]
  ? unknown
  : { readonly '⚠ duplicate field names across "head" and "tail"': never };

type InferField<T> = T extends TypeDef<infer R> ? R : never;

type InferTupleFields<T extends readonly LayoutEntry[]> = {
  [K in T[number] as K extends readonly [infer Name extends string, unknown] ? Name : never]:
    K extends readonly [unknown, infer Type] ? InferField<Type> : never;
};

// FieldDef'ы блока, типизированные по именам и типам значений полей.
type InferFieldDefs<T extends readonly LayoutEntry[]> = {
  [K in T[number] as K extends readonly [infer Name extends string, unknown] ? Name : never]:
    K extends readonly [unknown, infer Type] ? FieldDef<InferField<Type>> : never;
};

// `unknown` в пересечении — нейтральный элемент; защищает от «отравления»
// индексной сигнатурой, когда блок не задан (generic-массив вместо tuple).
type BlockFieldDefs<T extends readonly LayoutEntry[]> =
  [ExtractFieldsKeys<T>] extends [never] ? unknown : InferFieldDefs<T>;

// Публичная карта полей codec'а: typo в имени и обращение к skip-байтам —
// ошибки типов; деградирует до Record при неконкретных tuple (нет as const).
type ResolvedFields<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[],
> = [ExtractFieldsKeys<THead> | ExtractFieldsKeys<TTail>] extends [never]
  ? Readonly<Record<string, FieldDef<unknown>>>
  : Readonly<BlockFieldDefs<THead> & BlockFieldDefs<TTail>>;

// Имя поля для checksum, выведенное из layout'а. Если tuple не конкретен
// (нет `as const`) — деградирует до string, а не до never.
type FieldNameOf<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[],
> = [ExtractFieldsKeys<THead> | ExtractFieldsKeys<TTail>] extends [never]
  ? string
  : ExtractFieldsKeys<THead> | ExtractFieldsKeys<TTail>;

export interface ChecksumConfig<TField extends string = string> {
  field: TField;
  // Второй аргумент — позиция checksum-поля в буфере. Нужен для настоящих
  // CRC (CRC16/CRC32): там «занулить поле» и «исключить байты из расчёта» —
  // НЕ одно и то же. Буфер приходит с занулённым checksum-полем; если ваш
  // протокол требует исключения байтов, используйте offset/size для среза.
  //
  // КОНТРАКТ: buffer — живой рабочий буфер (без копирования, см.
  // calculateChecksum). Читать можно всё, МУТИРОВАТЬ НЕЛЬЗЯ.
  calculate: (buffer: Uint8Array, field: { offset: number; size: number }) => number;
}

export interface PacketSchema<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[]
> {
  size: number;
  head?: THead;
  body?: DataFieldFactory;
  tail?: TTail;
  checksum?: ChecksumConfig<FieldNameOf<THead, TTail>>;
}

// Форма для encode: body опционален (нет body — пустой payload),
// пустые head/tail можно не передавать вовсе.
export type PacketInput<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[]
> = ([ExtractFieldsKeys<THead>] extends [never]
      ? { head?: Record<string, unknown> }
      : { head: InferTupleFields<THead> })
  & { body?: Uint8Array }
  & ([ExtractFieldsKeys<TTail>] extends [never]
      ? { tail?: Record<string, unknown> }
      : { tail: InferTupleFields<TTail> });

// Форма результата decode: все блоки присутствуют всегда.
export type InferPacketShape<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[]
> = {
  head: InferTupleFields<THead>;
  body: Uint8Array;
  tail: InferTupleFields<TTail>;
};

export class PacketValidationError extends Error {
  constructor(public issues: string[], options?: { cause?: unknown }) {
    super(issues.join('; '), options);
    this.name = 'PacketValidationError';
  }
}

const toValidationError = (e: unknown): PacketValidationError => {
  if (e instanceof PacketValidationError) return e;
  const message = e instanceof Error ? e.message : String(e);
  // cause сохраняет исходный стек — иначе программные ошибки внутри
  // calculate()/схемы становятся неотлаживаемыми.
  return new PacketValidationError([message], { cause: e });
};

export function struct<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[]
>(schema: PacketSchema<THead, TTail>
  & AssertUniqueHead<THead>
  & AssertUniqueTail<TTail>
  & AssertNoCrossBlockDuplicates<THead, TTail>) {

  if (!Number.isSafeInteger(schema.size) || schema.size < 0) {
    throw new RangeError(`Schema size must be a non-negative safe integer, got ${schema.size}`);
  }

  const resolvedFields: Record<string, FieldDef<unknown>> = Object.create(null) as Record<string, FieldDef<unknown>>;

  let currentOffset = 0;
  let bodyFieldDef: DataFieldDef | undefined;

  // Резолвер для DataField. Проверяет kind: ссылка на data-поле раньше
  // приводила к тихому no-op при записи длины (buf.set(number)) — пакет
  // уходил битым без единой ошибки.
  const resolveLengthField = (name: string): FieldDef<number> | undefined => {
    const field = resolvedFields[name];
    if (!field) return undefined;
    if (field.kind !== 'uint') {
      throw new Error(
        `Schema Error: Length field "${name}" must be an unsigned integer (u8/u16.le/…), got a "${field.kind}" field.`,
      );
    }
    return field as FieldDef<number>;
  };

  const compileBlock = (blockName: 'head' | 'tail', block?: readonly LayoutEntry[]) => {
    if (!block) return;

    for (const entry of block) {

      if (isField(entry)) {
        const [name, type] = entry;
        if (typeof (type as Partial<TypeDef<unknown>>)?.at !== 'function') {
          throw new Error(
            `Schema Error: Field "${name}" in "${blockName}" has no codec. `
            + 'Multi-byte integers require explicit endianness: use u16.be / u16.le (u32.be / u32.le).',
          );
        }
        if (Object.hasOwn(resolvedFields, name)) {
          throw new Error(`Schema Error: Duplicate field name "${name}".`);
        }
        resolvedFields[name] = type.at(currentOffset);

        currentOffset += type.size;
      } else {
        currentOffset += entry.skip;
      }
    }
  };

  compileBlock('head', schema.head);

  if (schema.body) {
    // Валидируем ссылку на length-поле в момент компиляции схемы,
    // включая его kind (см. resolveLengthField).
    if (schema.body.lengthField && !resolveLengthField(schema.body.lengthField)) {
      throw new Error(
        `Schema Error: Length field "${schema.body.lengthField}" must exist in head before body.`,
      );
    }
    // Инъектируем резолвер через замыкание!
    bodyFieldDef = schema.body.at(currentOffset, resolveLengthField);
    currentOffset += bodyFieldDef.size;
  }

  compileBlock('tail', schema.tail);

  if (currentOffset !== schema.size) {
    throw new Error(
      `Schema Error: Compiled layout size ${currentOffset} does not match schema size ${schema.size}. `
      + 'Represent reserved bytes explicitly with skip().',
    );
  }

  let checksumFieldDef: FieldDef<number> | undefined;
  if (schema.checksum) {
    const field = resolvedFields[schema.checksum.field];
    if (!field) {
      throw new Error(`Schema Error: Checksum field "${schema.checksum.field}" not found in layout.`);
    }
    if (field.kind !== 'uint') {
      // Раньше encode на data-поле тихо пропускал запись checksum —
      // пакет уходил без контрольной суммы. Теперь это ошибка схемы.
      throw new Error(
        `Schema Error: Checksum field "${schema.checksum.field}" must be an unsigned integer (u8/u16.le/…), got a "${field.kind}" field.`,
      );
    }
    checksumFieldDef = field as FieldDef<number>;
  }

  const headKeys = extractFieldsKeys(schema.head)
  const tailKeys = extractFieldsKeys(schema.tail)
  const checksum = schema.checksum;
  const readonlyResolvedFields = Object.freeze(resolvedFields) as ResolvedFields<THead, TTail>;

  const calculateChecksum = (buffer: Uint8Array): number => {
    if (!checksum || !checksumFieldDef) throw new Error('Schema Error: Checksum is not configured.');
    const { offset, size } = checksumFieldDef;

    // Без копии всего буфера: зануляем поле НА МЕСТЕ, считаем, восстанавливаем.
    // Полная копия на каждый encode И decode — лишний GC-трафик на 1000 Гц
    // polling'а. Сохраняем только 1–4 байта самого поля; finally гарантирует,
    // что буфер вызывающего вернётся в исходное состояние даже если
    // calculate бросит исключение.
    const saved = buffer.slice(offset, offset + size);
    buffer.fill(0, offset, offset + size);
    try {
      const value = checksum.calculate(buffer, { offset, size });
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`Checksum must be a non-negative safe integer, got ${value}`);
      }
      return value;
    } finally {
      buffer.set(saved, offset);
    }
  };

  function encodeBlock(
    blockName: 'head' | 'tail',
    keys: readonly string[],
    input: Record<string, unknown> | undefined,
    buffer: Uint8Array,
  ) {
    if (keys.length === 0) return;
    if (input === undefined || input === null) {
      throw new Error(`Missing "${blockName}" block: expected fields ${keys.map(k => `"${k}"`).join(', ')}.`);
    }
    for (const key of keys) {
      const def = resolvedFields[key];
      if (!def) continue;
      const val = input[key];
      if (val === undefined) {
        // Раньше пропущенное поле тихо кодировалось нулём — 0x00 улетал
        // в устройство как валидная команда. Теперь это ошибка.
        throw new Error(`Missing value for field "${key}" in "${blockName}".`);
      }
      def.encode(buffer, val);
    }
  }

  function decodeBlock(fields: readonly string[], buffer: Uint8Array): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of fields) {
      const def = resolvedFields[key];
      if (def) {
        Object.defineProperty(result, key, {
          value: def.decode(buffer),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return result;
  }

  const codec = {
    resolvedFields: readonlyResolvedFields,

    safeEncode(
      input: PacketInput<THead, TTail>
    ): { success: true; buffer: Uint8Array } | { success: false; error: PacketValidationError } {
      try {
        const buffer = new Uint8Array(schema.size);
        const blocks = input as { head?: Record<string, unknown>; body?: Uint8Array; tail?: Record<string, unknown> };

        encodeBlock('head', headKeys, blocks.head, buffer);

        if (bodyFieldDef) {
          bodyFieldDef.encode(buffer, blocks.body ?? new Uint8Array(0));
        }

        encodeBlock('tail', tailKeys, blocks.tail, buffer);

        if (checksum && checksumFieldDef) {
          const crcValue = calculateChecksum(buffer);
          checksumFieldDef.encode(buffer, crcValue);
        }

        return { success: true, buffer };
      } catch (e) {
        return { success: false, error: toValidationError(e) };
      }
    },

    safeDecode(
      buffer: Uint8Array
    ): { success: true; data: InferPacketShape<THead, TTail> } | { success: false; error: PacketValidationError } {
      try {
        if (buffer.length !== schema.size) {
          throw new Error(`Buffer size ${buffer.length} does not match schema size ${schema.size}`);
        }

        // `as InferTupleFields<THead>` — это безопасное сужение типа (narrowing),
        // так как decodeBlock возвращает Record<string, unknown>, а мы знаем структуру из схемы.
        const head = (schema.head ? decodeBlock(headKeys, buffer) : {}) as InferTupleFields<THead>;

        // Явная аннотация: subarray возвращает Uint8Array<ArrayBufferLike>,
        // что шире, чем выводимый из `new Uint8Array(0)` тип.
        let body: Uint8Array = new Uint8Array(0);
        if (bodyFieldDef) {
          body = bodyFieldDef.decode(buffer);
        }

        const tail = (schema.tail ? decodeBlock(tailKeys, buffer) : {}) as InferTupleFields<TTail>;

        if (checksum && checksumFieldDef) {
          const expectedCrc = checksumFieldDef.decode(buffer);
          const actualCrc = calculateChecksum(buffer);
          if (expectedCrc !== actualCrc) {
            throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`);
          }
        }

        return {
          success: true,
          data: { head, body, tail } as InferPacketShape<THead, TTail>
        };
      } catch (e) {
        return { success: false, error: toValidationError(e) };
      }
    },

    encode(input: PacketInput<THead, TTail>): Uint8Array {
      const res = codec.safeEncode(input);
      if (!res.success) throw res.error;
      return res.buffer;
    },

    decode(buffer: Uint8Array): InferPacketShape<THead, TTail> {
      const res = codec.safeDecode(buffer);
      if (!res.success) throw res.error;
      return res.data;
    }
  };

  return codec;
}
