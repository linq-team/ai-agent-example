export interface ContactDetails {
  first_name: string;
  last_name?: string;
  phone_number: string;
}

export interface ContactPhoto {
  bytes: Buffer;
  type: 'JPEG' | 'PNG' | 'GIF';
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

// Fold at 75 UTF-8 octets without splitting a Unicode code point. The leading
// space on a continuation line counts toward its limit (RFC 2425/2426).
function foldLine(value: string): string {
  const lines: string[] = [];
  let line = '';
  let length = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (length + size > 75) {
      lines.push(line);
      line = ' ';
      length = 1;
    }
    line += char;
    length += size;
  }
  lines.push(line);
  return lines.join('\r\n');
}

export function detectContactPhoto(bytes: Buffer): ContactPhoto {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { bytes, type: 'PNG' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, type: 'JPEG' };
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return { bytes, type: 'GIF' };
  throw new Error('Contact photo must be a PNG, JPEG, or GIF image');
}

export function createVCard(contact: ContactDetails, photo?: ContactPhoto): Buffer {
  if (!/^\+[1-9]\d{1,14}$/.test(contact.phone_number)) throw new Error('Contact phone must use E.164 format');
  if (!contact.first_name.trim()) throw new Error('Contact first name is required');
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeText(contact.last_name ?? '')};${escapeText(contact.first_name)};;;`,
    `FN:${escapeText([contact.first_name, contact.last_name].filter(Boolean).join(' '))}`,
    `TEL;TYPE=CELL:${contact.phone_number}`,
  ];
  // Embed the photo: saving the contact must not depend on an expiring URL.
  if (photo) lines.push(`PHOTO;ENCODING=b;TYPE=${photo.type}:${photo.bytes.toString('base64')}`);
  lines.push('END:VCARD');
  return Buffer.from(lines.map(foldLine).join('\r\n') + '\r\n', 'utf8');
}
