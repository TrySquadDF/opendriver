# @open-driver/octet

A type-safe DSL for describing fixed-size binary structures — device
packets, protocol frames, firmware messages. A schema is compiled once —
field offsets are resolved ahead of time; encode/decode on the hot path
never re-parse the layout.

```ts
import { struct, u8, u16, data, magic } from '@open-driver/octet';

const SetDpiPacket = struct({
  size: 9,
  head: [
    magic(u8, 0xa5),       // sync byte: auto-written on encode, checked on decode
    ['command', u8],
    ['dpi', u16.le],       // byte order is always explicit
    ['length', u8],
  ] as const,              // `as const` is required for field name inference
  body: data({ lengthField: 'length', maxLength: 3 }),
  tail: [['crc', u8]] as const,
  checksum: {
    field: 'crc',
    calculate: (buf) => buf.reduce((s, b) => (s + b) & 0xff, 0),
  },
});

const bytes = SetDpiPacket.encode({
  head: { command: 0x04, dpi: 1600, length: 0 }, // length is overwritten with the body length
  body: new Uint8Array([1, 2]),
  tail: { crc: 0 },        // overwritten with the computed checksum
});
```

## Guarantees and semantics

Everything below is covered by tests (`test/`); this is the contract summary.

**Schema size is an invariant.** The sum of field sizes, `skip()` gaps and
the body must match `size` byte-for-byte, otherwise `struct()` throws at
schema compilation time. Reserved bytes are expressed only via an explicit
`skip(n)` — there are no silent divergences from the datasheet.

**Byte order is always explicit.** `u16`/`u32` have no default variant:
only `u16.be` / `u16.le`. A bare `u16` in a layout is both a type error and
a runtime error with an actionable message. `u8` is used directly
(`u8.be === u8.le` — self-references for uniformity in generated code).

**Encode is strict.** A missing field value, or a whole missing block with
declared fields, is an error (`Missing value for field "x" in "head"`) —
not a silent `0x00` sent to the device. The one exception is `body`: it may
be omitted, which means an empty payload.

**Magic constants.** `magic(u8, 0xa5)` is an unnamed layout entry, like
`skip()`: encode writes the constant automatically (it is not part of the
input), decode does not include it in the result — its value is guaranteed
by the schema. Out-of-range values (`magic(u8, 0x1ff)`) are rejected when
the schema is described, not at the first encode.

**Encode write order**: magic constants → head → body → tail → checksum
(so magic bytes participate in the sum). If the body has a `lengthField`,
the actual payload length overwrites whatever value the user passed in
head. Bytes in `skip()` regions and the body tail beyond the payload
remain zero.

**Decode validates, strictly in this order**: buffer size → magic
constants → checksum → fields. Magic before checksum: a packet of another
type with a valid CRC is diagnosed as `Magic mismatch` (wrong packet), not
as a confusing `CRC mismatch` — useful when dispatching `safeDecode`
across several schemas. Checksum before fields: a corrupted length byte is
reported as `CRC mismatch`, not as a random field error. The length read
from `lengthField` is validated against `maxLength` (protection against
corrupted or hostile packets). The returned `body` is an owned copy
(`slice`), not an alias of the input buffer. A body without a `lengthField`
is returned in full (`maxLength` bytes), padding included.

**Checksum.** `calculate(buffer, field)` receives the buffer with the
checksum field zeroed out, plus the field position `{ offset, size }`. For
additive sums, zeroing is equivalent to excluding the bytes; for polynomial
CRCs it is NOT — exclude the bytes yourself using
`field.offset`/`field.size`. The buffer passed to `calculate` is the live
working buffer (no copying): read anything, mutate nothing. After the
calculation the buffer state is restored; the input buffer of `decode` is
never observably mutated.

**Name references are validated at schema compilation.** `lengthField` and
`checksum.field` must point to an existing numeric field (`kind: 'uint'`);
a reference to a `data` field is a schema error, not silent packet
corruption. `checksum.field` is additionally typed with the schema's field
names — a typo does not compile.

**Errors.** `encode`/`decode` throw `PacketValidationError`;
`safeEncode`/`safeDecode` return `{ success, ... }` without throwing. The
original error is preserved in `error.cause` — a stack trace from inside
your `calculate` is never lost.

## What octet deliberately does NOT know

Octet is transport-agnostic. Anything that travels outside the packet
payload (framing bytes, channel identifiers, protocol envelopes) belongs
to your transport codec — capture it there (see `EXAMPLE.md`).
Only fixed-size structures are supported; nested structs, bitfields and
signed integers are not there yet (see the roadmap in issues).

## Development

```bash
bun test              # all tests
bun test checksum     # a single suite
bun run typecheck     # including type-level tests (test/types.check.ts)
bun run bench         # hot-path benchmarks (bench/codec.bench.ts)
```

Run the benchmark before and after touching `fields.ts` or `engine.ts`
and compare medians from the same machine and run. Numbers are only
comparable within a single machine; they are a regression tool, not
marketing material. (History: exactly this benchmark rejected a
"cleaner" DataView-based integer codec — it measured ~9x slower than
the manual shifts on primitives.)

Tests are sliced by behavior: `uint` / `data` / `magic` (protocol
constants) / `schema` (schema compilation errors) / `codec`
(encode/decode) / `checksum` / `errors` (error contract) / `property`
(deterministic fuzzing of round-trips and corruption detection).
