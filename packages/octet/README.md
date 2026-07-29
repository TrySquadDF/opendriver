# @open-driver/octet

> [!WARNING]
> Octet is designed for fixed-size binary structures. If your format has a
> dynamic layout or an unknown total size, this library may not be a good fit.

Octet is a small TypeScript library for describing fixed-size binary
structures and converting them to and from `Uint8Array`.

Define a schema once, then use it to encode and decode messages:

```ts
import { data, magic, struct, u8, u16 } from '@open-driver/octet';

const Message = struct({
  size: 9,
  head: [
    magic(u8, 0xa5),
    ['type', u8],
    ['sequence', u16.le],
    ['length', u8],
  ] as const,
  body: data({ lengthField: 'length', maxLength: 3 }),
  tail: [['checksum', u8]] as const,
  checksum: {
    field: 'checksum',
    calculate: (buffer) =>
      buffer.reduce((sum, byte) => (sum + byte) & 0xff, 0),
  },
});

const encoded = Message.encode({
  head: { type: 1, sequence: 42, length: 0 },
  body: new Uint8Array([10, 20]),
  tail: { checksum: 0 },
});

const decoded = Message.decode(encoded);
```

Octet takes care of field offsets, byte order, payload length, constants and
checksums. The schema is validated when it is created, so layout mistakes are
reported before encoding or decoding begins.

## Building blocks

- `u8`, `u16.le`, `u16.be`, `u32.le`, `u32.be` define unsigned integers.
- `data()` defines a byte payload.
- `magic()` defines a constant byte or integer.
- `skip()` reserves bytes in the structure.
- `struct()` compiles the schema and returns `encode`, `decode`, `safeEncode`
  and `safeDecode`.

Multi-byte integers always require an explicit byte order. The declared
fields, payload and reserved bytes must add up to the schema's `size`.

`encode` and `decode` throw `PacketValidationError` when validation fails.
Their safe variants return a result object instead.

## Scope

Octet only describes binary data. It does not depend on a particular
transport, device type or protocol. Reading, writing and framing messages stay
in the surrounding application.

At the moment, schemas are fixed-size. Nested structures, bitfields and signed
integers are not supported.

## Development

```bash
bun test
bun run typecheck
bun run build
bun run bench
```
