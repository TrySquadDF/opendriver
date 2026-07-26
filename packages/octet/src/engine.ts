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

export interface ChecksumConfig {
  field: string;
  calculate: (buffer: Uint8Array) => number;
}

export interface PacketSchema<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[]
> {
  size: number;
  head?: THead;
  body?: DataFieldFactory;
  tail?: TTail;
  checksum?: ChecksumConfig;
}

export type InferPacketShape<
  THead extends readonly LayoutEntry[],
  TTail extends readonly LayoutEntry[]
> = {
  head: InferTupleFields<THead>;
  body: Uint8Array;
  tail: InferTupleFields<TTail>;
};

export class PacketValidationError extends Error {
  constructor(public issues: string[]) {
    super(issues.join('; '));
    this.name = 'PacketValidationError';
  }
}

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

  // Безопасный резолвер для DataField (возвращает строго FieldDef<number> | undefined)
  const resolveLengthField = (name: string): FieldDef<number> | undefined => {
    const field = resolvedFields[name];
    // Проверяем, что поле найдено и его тип number (так как у u8/u16 тип выводится как number)
    return field as FieldDef<number> | undefined;
  };

  const compileBlock = (block?: readonly LayoutEntry[]) => {
    if (!block) return;

    for (const entry of block) {

      if (isField(entry)) {
        const [name, type] = entry;
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

  compileBlock(schema.head);

  if (schema.body) {
    if (schema.body.lengthField && !resolveLengthField(schema.body.lengthField)) {
      throw new Error(
        `Schema Error: Length field "${schema.body.lengthField}" must exist in head before body.`,
      );
    }
    // Инъектируем резолвер через замыкание!
    bodyFieldDef = schema.body.at(currentOffset, resolveLengthField);
    currentOffset += bodyFieldDef.size;
  }

  compileBlock(schema.tail);

  if (currentOffset !== schema.size) {
    throw new Error(
      `Schema Error: Compiled layout size ${currentOffset} does not match schema size ${schema.size}. `
      + 'Represent reserved bytes explicitly with skip().',
    );
  }

  if (schema.checksum && !resolvedFields[schema.checksum.field]) {
    throw new Error(`Schema Error: Checksum field "${schema.checksum.field}" not found in layout.`);
  }

  const headKeys = extractFieldsKeys(schema.head)
  const tailKeys = extractFieldsKeys(schema.tail)
  const checksum = schema.checksum;
  const readonlyResolvedFields = Object.freeze(resolvedFields) as Readonly<Record<string, FieldDef<unknown>>>;

  const calculateChecksum = (buffer: Uint8Array): number => {
    if (!checksum) throw new Error('Schema Error: Checksum is not configured.');
    const checksumField = resolvedFields[checksum.field];
    if (!checksumField) throw new Error(`Schema Error: Checksum field "${checksum.field}" not found in layout.`);

    const input = buffer.slice();
    checksumField.encode(input, 0);
    const value = checksum.calculate(input);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Checksum must be a non-negative safe integer, got ${value}`);
    }
    return value;
  };

  function encodeBlock(fields: readonly string[], input: Record<string, unknown>, buffer: Uint8Array) {
    for (const key of fields) {
      const def = resolvedFields[key];
      if (!def) continue;
      const val = input[key];
      if (val !== undefined) {
        def.encode(buffer, val);
      }
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
      input: InferPacketShape<THead, TTail>
    ): { success: true; buffer: Uint8Array } | { success: false; error: PacketValidationError } {
      try {
        const buffer = new Uint8Array(schema.size);

        // `as Record<string, unknown>` — это безопасное расширение типа (widening),
        // так как любой объект с конкретными ключами совместим с Record<string, unknown>.
        if (schema.head) encodeBlock(headKeys, input.head as Record<string, unknown>, buffer);

        // Никаких @ts-ignore! bodyFieldDef.encode ожидает Uint8Array, и мы передаем Uint8Array.
        if (bodyFieldDef) {
          bodyFieldDef.encode(buffer, input.body ?? new Uint8Array(0));
        }

        // ?? as Record<string, unknown>
        if (schema.tail) encodeBlock(tailKeys, input.tail as Record<string, unknown>, buffer);

        if (schema.checksum) {
          const crcDef = resolvedFields[schema.checksum.field];
          if (crcDef) {
            const crcValue = calculateChecksum(buffer);
            crcDef.encode(buffer, crcValue);
          }
        }

        return { success: true, buffer };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { success: false, error: new PacketValidationError([message]) };
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

        if (schema.checksum) {
          const crcDef = resolvedFields[schema.checksum.field];
          if (crcDef) {
            const expectedCrc = crcDef.decode(buffer);
            if (typeof expectedCrc !== 'number') {
              throw new Error(`Checksum field "${schema.checksum.field}" must decode to a number`);
            }
            const actualCrc = calculateChecksum(buffer);
            if (expectedCrc !== actualCrc) {
              throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`);
            }
          }
        }

        return {
          success: true,
          data: { head, body, tail } as InferPacketShape<THead, TTail>
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { success: false, error: new PacketValidationError([message]) };
      }
    },

    encode(input: InferPacketShape<THead, TTail>): Uint8Array {
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
