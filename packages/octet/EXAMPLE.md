```ts
import { struct, skip, u8, u16, data } from '@open-driver/octet';

// Octet knows nothing about the transport. Anything that lives outside
// the packet payload (framing bytes, channel identifiers, envelopes)
// belongs to your transport codec — capture such constants explicitly.
//
// For a given packet type these constants don't change, so the schema is
// compiled ONCE at module level. Do not call struct() inside a function
// on every packet: schema compilation (offset resolution, reference
// validation) is a setup step, not the hot path.
const CHANNEL_ID = 0x08;

export const ExamplePacket = struct({
  size: 22, // head(6) + body(10) + tail(6)

  // The engine computes the offsets itself: command=0, status=1, [skip]=2,
  // address=3, dataLength=5. `as const` is required — without it field
  // names are not inferred at the type level (command becomes unknown
  // instead of number).
  head: [
    ['command', u8],
    ['status', u8],
    skip(1),
    ['address', u16.be],   // byte order is always explicit: .be / .le
    ['dataLength', u8],
  ] as const,

  // Body starts at offset 6. The length field is looked up by the name
  // 'dataLength' and is filled with the actual payload length automatically.
  body: data({ lengthField: 'dataLength', maxLength: 10 }),

  // Tail starts at offset 16.
  tail: [
    skip(5),       // skip bytes 16..20
    ['crc', u8],   // offset 21
  ] as const,

  // calculate receives the buffer with the crc field zeroed out, plus the
  // field position. For an additive sum, zeroing is equivalent to excluding
  // the byte; for real CRC16/CRC32 it is not — exclude bytes via field.offset.
  checksum: {
    field: 'crc',
    calculate: (buffer) => {
      let crcSum = CHANNEL_ID; // out-of-payload bytes join the sum here
      for (const byte of buffer) crcSum += byte;
      return (0x55 - (crcSum & 0xFF)) & 0xFF;
    }
  }
});

// Usage: body is optional (no payload — no key),
// crc is overwritten with the computed value.
const bytes = ExamplePacket.encode({
  head: { command: 0x01, status: 0, address: 0x1a2b, dataLength: 0 },
  body: new Uint8Array([0xde, 0xad]),
  tail: { crc: 0 },
});

await transport.send(CHANNEL_ID, bytes);
```
