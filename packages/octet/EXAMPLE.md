```ts
import { struct, skip, u8, u16, data } from '@open-driver/octet';

export const createExamplePacket = (reportId: number) => struct({
  size: 22, // head(6) + body(10) + tail(6)

  // Движок сам посчитает смещения: command=0, status=1, [skip]=2,
  // address=3, dataLength=5. `as const` обязателен — без него имена полей
  // не выводятся на уровне типов (command станет unknown вместо number).
  head: [
    ['command', u8],
    ['status', u8],
    skip(1),
    ['address', u16.be],
    ['dataLength', u8],
  ] as const,

  // Body начнётся с оффсета 6. Поле длины ищется по имени 'dataLength'.
  body: data({ lengthField: 'dataLength', maxLength: 10 }),

  // tail начнётся с оффсета 16.
  tail: [
    skip(5),       // пропускаем байты 16..20
    ['crc', u8],   // оффсет 21
  ] as const,

  // В WebHID Report ID передаётся вне payload, поэтому device codec
  // захватывает его явно. Сам octet ничего не знает о HID.
  checksum: {
    field: 'crc',
    calculate: (buffer) => {
      let crcSum = reportId;
      for (const byte of buffer) crcSum += byte;
      return (0x55 - (crcSum & 0xFF)) & 0xFF;
    }
  }
});
```
