export const MAX_CV_BYTES = 5 * 1024 * 1024;

export interface ValidatedCareerCv {
  bytes: Uint8Array;
  extension: 'pdf' | 'doc' | 'docx';
  mime: string;
  filename: string;
}

const MAX_ZIP_ENTRIES = 256;
const MAX_EXPANDED_PART_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_METADATA_BYTES = 256 * 1024;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const WORD_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const OFFICE_DOCUMENT_RELATIONSHIPS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const WORD_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const FORBIDDEN_PDF_ACTION_NAME =
  /\/(?:JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|RichMedia|XFA)(?=$|[^!-~]|[()<>/{}%]|\[|\])/i;

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid CV document');
}

function safeFilename(name: string, extension: ValidatedCareerCv['extension']): string {
  const basename = name.replace(/\\/g, '/').split('/').pop() || 'CV';
  const stem = basename
    .slice(0, basename.lastIndexOf('.'))
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .slice(0, 100)
    .trim();
  return `${stem || 'CV'}.${extension}`;
}

function validPdf(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder();
  const header = decoder.decode(bytes.subarray(0, 16));
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(header)) return false;
  const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  // PDF permits these exact whitespace bytes following its end marker.
  const trailer = new RegExp(
    String.raw`startxref\s+(\d+)\s+%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$`
  ).exec(tail);
  if (!trailer) return false;
  const offset = Number(trailer[1]);
  if (!Number.isSafeInteger(offset) || offset < 8 || offset >= bytes.length - 20) return false;
  const xref = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + 1024)));
  if (!/^(?:xref\s|\d+\s+\d+\s+obj\s*<<[\s\S]*?\/Type\s*\/XRef\b)/.test(xref)) return false;
  // PDF names may escape their bytes. Encryption dictionaries remain outside
  // encrypted streams, so reject their marker conservatively anywhere in a CV.
  const text = decoder
    .decode(bytes)
    .replace(/#([0-9a-f]{2})/gi, (_, value: string) =>
      String.fromCharCode(Number.parseInt(value, 16))
    );
  // Fail closed on active PDF name tokens, including #xx-escaped spellings.
  // Match PDF name delimiters so /JS does not accidentally match /JScript.
  return (
    /\/Root\s+\d+\s+\d+\s+R\b/.test(text) &&
    !/\/Encrypt\b/.test(text) &&
    !FORBIDDEN_PDF_ACTION_NAME.test(text)
  );
}

interface CompoundEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

function validDoc(bytes: Uint8Array): boolean {
  requireValid(bytes.length >= 512);
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  requireValid(signature.every((value, index) => bytes[index] === value));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(26, true);
  const shift = view.getUint16(30, true);
  requireValid((version === 3 && shift === 9) || (version === 4 && shift === 12));
  requireValid(view.getUint16(28, true) === 0xfffe && view.getUint16(32, true) === 6);
  requireValid(view.getUint32(56, true) === 4096);
  const sectorSize = 2 ** shift;
  requireValid(bytes.length % sectorSize === 0 && bytes.length > sectorSize);
  const sectorCount = bytes.length / sectorSize - 1;
  const wordsPerSector = sectorSize / 4;
  const fatCount = view.getUint32(44, true);
  requireValid(fatCount > 0 && fatCount <= sectorCount);
  const sectorOffset = (sector: number) => {
    requireValid(sector < sectorCount);
    return (sector + 1) * sectorSize;
  };
  const fatSectors: number[] = [];
  const reservedSectors = new Set<number>();
  const addFatSector = (sector: number) => {
    if (sector === FREE_SECTOR) return;
    sectorOffset(sector);
    requireValid(!reservedSectors.has(sector));
    reservedSectors.add(sector);
    fatSectors.push(sector);
  };
  for (let i = 0; i < 109; i++) addFatSector(view.getUint32(76 + i * 4, true));
  const difatCount = view.getUint32(72, true);
  requireValid(difatCount <= sectorCount);
  let difat = view.getUint32(68, true);
  for (let i = 0; i < difatCount; i++) {
    const offset = sectorOffset(difat);
    requireValid(!reservedSectors.has(difat));
    reservedSectors.add(difat);
    for (let word = 0; word < wordsPerSector - 1; word++) {
      addFatSector(view.getUint32(offset + word * 4, true));
    }
    difat = view.getUint32(offset + sectorSize - 4, true);
  }
  requireValid(difatCount === 0 || difat === END_OF_CHAIN);
  requireValid(fatSectors.length === fatCount && fatCount * wordsPerSector >= sectorCount);
  const fatNext = (sector: number) =>
    view.getUint32(
      sectorOffset(fatSectors[Math.floor(sector / wordsPerSector)]) + (sector % wordsPerSector) * 4,
      true
    );
  const usedSectors = new Set(reservedSectors);
  const fatChain = (start: number, maximum: number): number[] => {
    const chain: number[] = [];
    let sector = start;
    while (sector !== END_OF_CHAIN) {
      sectorOffset(sector);
      requireValid(chain.length < maximum && !usedSectors.has(sector));
      usedSectors.add(sector);
      chain.push(sector);
      sector = fatNext(sector);
    }
    return chain;
  };
  const readFatStream = (start: number, size: number): Uint8Array => {
    requireValid(size <= bytes.length);
    if (size === 0) return new Uint8Array();
    const count = Math.ceil(size / sectorSize);
    const chain = fatChain(start, count);
    requireValid(chain.length === count);
    const data = new Uint8Array(size);
    chain.forEach((sector, i) => {
      const offset = sectorOffset(sector);
      data.set(
        bytes.subarray(offset, offset + Math.min(sectorSize, size - i * sectorSize)),
        i * sectorSize
      );
    });
    return data;
  };
  const directorySectors = fatChain(view.getUint32(48, true), (256 * 1024) / sectorSize);
  requireValid(directorySectors.length > 0);
  const entries: CompoundEntry[] = [];
  for (const sector of directorySectors) {
    for (let at = sectorOffset(sector); at < sectorOffset(sector) + sectorSize; at += 128) {
      const type = bytes[at + 66];
      const nameLength = view.getUint16(at + 64, true);
      requireValid(type === 0 || type === 1 || type === 2 || type === 5);
      requireValid(type === 0 || (nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0));
      let name = '';
      if (type !== 0) {
        requireValid(view.getUint16(at + nameLength - 2, true) === 0);
        name = new TextDecoder('utf-16le', { fatal: true }).decode(
          bytes.subarray(at, at + nameLength - 2)
        );
        requireValid(!new RegExp(String.raw`[\x00/\\:!]`).test(name));
        requireValid(
          !/^(?:Macros|VBA|_VBA_PROJECT|PROJECT|EncryptedPackage|EncryptionInfo|ObjectPool)$/i.test(
            name
          )
        );
      }
      const sizeLow = view.getUint32(at + 120, true);
      const sizeHigh = view.getUint32(at + 124, true);
      requireValid(type === 0 || sizeHigh === 0);
      entries.push({
        name,
        type,
        left: view.getUint32(at + 68, true),
        right: view.getUint32(at + 72, true),
        child: view.getUint32(at + 76, true),
        start: view.getUint32(at + 116, true),
        size: sizeLow,
      });
    }
  }
  const root = entries[0];
  requireValid(root?.type === 5 && root.name === 'Root Entry');
  const parents = new Map<number, number>();
  const pending = [{ index: root.child, parent: 0 }];
  const names = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (next.index === FREE_SECTOR) continue;
    const entry = entries[next.index];
    requireValid(entry && (entry.type === 1 || entry.type === 2) && !parents.has(next.index));
    parents.set(next.index, next.parent);
    const nameKey = `${next.parent}/${entry.name.toLowerCase()}`;
    requireValid(!names.has(nameKey));
    names.add(nameKey);
    pending.push(
      { index: entry.left, parent: next.parent },
      { index: entry.right, parent: next.parent }
    );
    if (entry.type === 1) pending.push({ index: entry.child, parent: next.index });
    else requireValid(entry.child === FREE_SECTOR);
  }
  requireValid(entries.filter((entry) => entry.type !== 0).length === parents.size + 1);
  const miniFatCount = view.getUint32(64, true);
  requireValid(miniFatCount <= sectorCount);
  const miniFat = readFatStream(view.getUint32(60, true), miniFatCount * sectorSize);
  const miniView = new DataView(miniFat.buffer);
  const miniStream = readFatStream(root.start, root.size);
  const usedMiniSectors = new Set<number>();
  const readMiniStream = (start: number, size: number): Uint8Array => {
    const data = new Uint8Array(size);
    let sector = start;
    let written = 0;
    while (written < size) {
      requireValid(sector * 4 + 4 <= miniFat.length && sector * 64 + 64 <= miniStream.length);
      requireValid(!usedMiniSectors.has(sector));
      usedMiniSectors.add(sector);
      const length = Math.min(64, size - written);
      data.set(miniStream.subarray(sector * 64, sector * 64 + length), written);
      written += length;
      sector = miniView.getUint32(sector * 4, true);
    }
    requireValid(size === 0 || sector === END_OF_CHAIN);
    return data;
  };
  let wordDocument: Uint8Array | undefined;
  const tables = new Set<string>();
  for (let index = 1; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type !== 2) continue;
    requireValid(entry.size <= bytes.length);
    const data =
      entry.size < 4096
        ? readMiniStream(entry.start, entry.size)
        : readFatStream(entry.start, entry.size);
    if (parents.get(index) !== 0) continue;
    if (entry.name === 'WordDocument') wordDocument = data;
    if ((entry.name === '0Table' || entry.name === '1Table') && data.length) tables.add(entry.name);
  }
  requireValid(wordDocument && wordDocument.length >= 68);
  const fib = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);
  requireValid(fib.getUint16(0, true) === 0xa5ec);
  requireValid(fib.getUint16(2, true) >= 0xc1 && fib.getUint16(2, true) <= 0x112);
  const flags = fib.getUint16(10, true);
  requireValid((flags & 0x0100) === 0);
  return tables.has(flags & 0x0200 ? '1Table' : '0Table');
}

interface ZipEntry {
  name: string;
  method: number;
  compressed: Uint8Array;
  expandedSize: number;
  checksum: number;
}

function archiveName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 240 &&
    !new RegExp(String.raw`[\x00-\x20\x7f\\:%?#]`).test(name) &&
    !name.startsWith('/') &&
    name
      .split('/')
      .every(
        (segment, index, all) =>
          segment !== '.' && segment !== '..' && (segment !== '' || index === all.length - 1)
      )
  );
}

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  requireValid(bytes.length >= 22);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireValid(view.getUint32(0, true) === 0x04034b50);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  requireValid(end >= 0);
  requireValid(view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0);
  const count = view.getUint16(end + 10, true);
  requireValid(count > 0 && count <= MAX_ZIP_ENTRIES && view.getUint16(end + 8, true) === count);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  requireValid(directoryOffset + directorySize === end);
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = directoryOffset;
  let expandedTotal = 0;
  const validateExtra = (start: number, length: number) => {
    const limit = start + length;
    requireValid(limit <= bytes.length);
    while (start < limit) {
      requireValid(start + 4 <= limit);
      const type = view.getUint16(start, true);
      const size = view.getUint16(start + 2, true);
      requireValid(type !== 1 && type !== 0x9901);
      start += 4 + size;
      requireValid(start <= limit);
    }
  };
  for (let i = 0; i < count; i++) {
    requireValid(offset + 46 <= end && view.getUint32(offset, true) === 0x02014b50);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const expandedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    requireValid((flags & ~0x080e) === 0 && (method === 0 || method === 8));
    requireValid(view.getUint16(offset + 34, true) === 0);
    requireValid(offset + 46 + nameLength + extraLength + commentLength <= end);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    requireValid(archiveName(name) && !names.has(name.toLowerCase()));
    names.add(name.toLowerCase());
    requireValid(!/(?:^|\/)(?:vba[^/]*|activeX|embeddings)(?:\/|\.|$)/i.test(name));
    validateExtra(offset + 46 + nameLength, extraLength);
    expandedTotal += expandedSize;
    requireValid(
      expandedSize <= MAX_EXPANDED_PART_BYTES && expandedTotal <= MAX_EXPANDED_TOTAL_BYTES
    );
    requireValid(
      localOffset + 30 <= directoryOffset && view.getUint32(localOffset, true) === 0x04034b50
    );
    requireValid(
      view.getUint16(localOffset + 6, true) === flags &&
        view.getUint16(localOffset + 8, true) === method
    );
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    requireValid(dataOffset + compressedSize <= directoryOffset);
    requireValid(
      decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) === name
    );
    validateExtra(localOffset + 30 + localNameLength, localExtraLength);
    let localEnd = dataOffset + compressedSize;
    if (flags & 8) {
      requireValid(localEnd + 12 <= directoryOffset);
      if (view.getUint32(localEnd, true) === 0x08074b50) localEnd += 4;
      requireValid(localEnd + 12 <= directoryOffset);
      requireValid(view.getUint32(localEnd, true) === checksum);
      requireValid(view.getUint32(localEnd + 4, true) === compressedSize);
      requireValid(view.getUint32(localEnd + 8, true) === expandedSize);
      localEnd += 12;
    } else {
      requireValid(view.getUint32(localOffset + 14, true) === checksum);
      requireValid(view.getUint32(localOffset + 18, true) === compressedSize);
      requireValid(view.getUint32(localOffset + 22, true) === expandedSize);
    }
    requireValid(method !== 0 || compressedSize === expandedSize);
    if (name.endsWith('/')) requireValid(compressedSize === 0 && expandedSize === 0);
    ranges.push([localOffset, localEnd]);
    entries.push({
      name,
      method,
      compressed: bytes.subarray(dataOffset, dataOffset + compressedSize),
      expandedSize,
      checksum,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  requireValid(offset === end);
  ranges.sort((left, right) => left[0] - right[0]);
  let nextOffset = 0;
  for (const [start, finish] of ranges) {
    requireValid(start === nextOffset);
    nextOffset = finish;
  }
  requireValid(nextOffset === directoryOffset);
  return entries;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

async function expandEntry(entry: ZipEntry): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (entry.method === 0) bytes = entry.compressed;
  else {
    bytes = new Uint8Array(entry.expandedSize);
    // eslint-disable-next-line no-undef -- BufferSource is a DOM TypeScript type.
    const input = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(entry.compressed.slice().buffer);
        controller.close();
      },
    });
    const reader = input.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    let offset = 0;
    let complete = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        requireValid(offset + value.byteLength <= entry.expandedSize);
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      requireValid(offset === entry.expandedSize);
    } finally {
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  let checksum = 0xffffffff;
  for (const value of bytes) checksum = CRC_TABLE[(checksum ^ value) & 0xff] ^ (checksum >>> 8);
  requireValid((checksum ^ 0xffffffff) >>> 0 === entry.checksum);
  return bytes;
}

function xmlText(bytes: Uint8Array): string {
  requireValid(bytes.length <= MAX_XML_BYTES);
  const encoding =
    (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
      ? 'utf-16le'
      : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)
        ? 'utf-16be'
        : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  requireValid(!new RegExp(String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f]`).test(text));
  requireValid(!/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text));
  return text;
}

function xmlEntities(value: string): string {
  const entities = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi;
  requireValid(!value.replace(entities, '').includes('&'));
  return value.replace(entities, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
    };
    if (named[entity]) return named[entity];
    const numeric = entity.slice(2, -1);
    const point = numeric[0] === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
    requireValid(
      Number.isInteger(point) &&
        point > 0 &&
        point <= 0x10ffff &&
        !(point >= 0xd800 && point <= 0xdfff)
    );
    return String.fromCodePoint(point);
  });
}

interface XmlElement {
  local: string;
  namespace: string;
  attributes: Map<string, string>;
  depth: number;
}

// A bounded event reader for the small XML parts we validate. It does not
// resolve entities, load resources, create a DOM, or execute processing instructions.
function readXml(text: string, visit: (element: XmlElement) => void): void {
  const namePattern = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
  const startPattern = new RegExp(`^(${namePattern})([\\s\\S]*)$`);
  const attributePattern = new RegExp(
    `\\s+(${namePattern})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`,
    'y'
  );
  const stack: Array<{ name: string; namespaces: Map<string, string> }> = [];
  let roots = 0;
  let tags = 0;
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf('<', position);
    const plain = text.slice(position, start < 0 ? text.length : start);
    xmlEntities(plain);
    requireValid(stack.length > 0 || plain.trim() === '');
    if (start < 0) break;
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      requireValid(end >= 0 && !text.slice(start + 4, end).includes('--'));
      position = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', start)) {
      const end = text.indexOf(']]>', start + 9);
      requireValid(stack.length > 0 && end >= 0);
      position = end + 3;
      continue;
    }
    if (text.startsWith('<?', start)) {
      const end = text.indexOf('?>', start + 2);
      requireValid(roots === 0 && end >= 0 && /^<\?xml\s/.test(text.slice(start, start + 7)));
      position = end + 2;
      continue;
    }
    let end = start + 1;
    let quote = '';
    for (; end < text.length; end++) {
      const character = text[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      requireValid(end - start <= 8192);
    }
    requireValid(end < text.length && ++tags <= 100000);
    let token = text.slice(start + 1, end);
    position = end + 1;
    if (token.startsWith('/')) {
      const closing = token.slice(1).trim();
      requireValid(stack.length > 0 && stack.pop()!.name === closing);
      continue;
    }
    const selfClosing = token.endsWith('/');
    if (selfClosing) token = token.slice(0, -1);
    const match = startPattern.exec(token);
    requireValid(match);
    const name = match[1];
    const remainder = match[2];
    const attributes = new Map<string, string>();
    let at = 0;
    while (at < remainder.length && remainder.slice(at).trim() !== '') {
      attributePattern.lastIndex = at;
      const attribute = attributePattern.exec(remainder);
      requireValid(attribute && !attributes.has(attribute[1]) && attributes.size < 64);
      attributes.set(attribute[1], xmlEntities(attribute[2] ?? attribute[3]));
      at = attributePattern.lastIndex;
    }
    const namespaces = new Map(
      stack.at(-1)?.namespaces ?? [['xml', 'http://www.w3.org/XML/1998/namespace']]
    );
    for (const [attribute, value] of attributes) {
      if (attribute === 'xmlns') namespaces.set('', value);
      if (attribute.startsWith('xmlns:')) namespaces.set(attribute.slice(6), value);
    }
    const colon = name.indexOf(':');
    const prefix = colon < 0 ? '' : name.slice(0, colon);
    requireValid(colon < 0 || namespaces.has(prefix));
    for (const attribute of attributes.keys()) {
      const separator = attribute.indexOf(':');
      requireValid(
        separator < 0 ||
          attribute.startsWith('xmlns:') ||
          namespaces.has(attribute.slice(0, separator))
      );
    }
    if (!stack.length) requireValid(++roots === 1);
    requireValid(stack.length < 64);
    visit({
      local: colon < 0 ? name : name.slice(colon + 1),
      namespace: namespaces.get(prefix) ?? '',
      attributes,
      depth: stack.length,
    });
    if (!selfClosing) stack.push({ name, namespaces });
  }
  requireValid(roots === 1 && stack.length === 0);
}

function relationshipTarget(name: string, target: string): string {
  requireValid(
    target.length <= 1024 &&
      !new RegExp(String.raw`[\x00-\x20\\?#%]`).test(target) &&
      !/^[A-Za-z][\w+.-]*:/.test(target)
  );
  const source = name === '_rels/.rels' ? '' : name.replace(/\/_rels\//i, '/').slice(0, -5);
  const segments = target.startsWith('/')
    ? []
    : source
        .slice(0, source.lastIndexOf('/') + 1)
        .split('/')
        .filter(Boolean);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') requireValid(segments.pop() !== undefined);
    else segments.push(segment);
  }
  return segments.join('/');
}

async function validDocx(bytes: Uint8Array): Promise<boolean> {
  const entries = zipEntries(bytes);
  const files = new Set(
    entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name)
  );
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
    requireValid(files.has(name));
  const documents = new Map<string, string>();
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const isMetadata = entry.name === '[Content_Types].xml' || /\.rels$/i.test(entry.name);
    requireValid(!isMetadata || entry.expandedSize <= MAX_PACKAGE_METADATA_BYTES);
    const data = await expandEntry(entry);
    if (/\.(?:xml|rels)$/i.test(entry.name)) {
      const text = xmlText(data);
      if (isMetadata || entry.name === 'word/document.xml') documents.set(entry.name, text);
    }
  }
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  readXml(documents.get('[Content_Types].xml')!, (element) => {
    requireValid(element.namespace === CONTENT_TYPES_NS);
    if (element.depth === 0) requireValid(element.local === 'Types');
    else {
      requireValid(
        element.depth === 1 && (element.local === 'Default' || element.local === 'Override')
      );
      const type = element.attributes.get('ContentType');
      requireValid(
        type &&
          !/macroenabled|vba|activex|oleobject|application\/zip|text\/html|image\/svg|x-msdownload/i.test(
            type
          )
      );
      const key = element.attributes.get(element.local === 'Default' ? 'Extension' : 'PartName');
      requireValid(key);
      const destination = element.local === 'Default' ? defaults : overrides;
      requireValid(!destination.has(key));
      destination.set(key, type);
    }
  });
  requireValid(overrides.get('/word/document.xml') === WORD_CONTENT_TYPE);
  for (const name of files) {
    if (name === '[Content_Types].xml') continue;
    requireValid(overrides.has('/' + name) || defaults.has(name.slice(name.lastIndexOf('.') + 1)));
  }
  let mainRelationships = 0;
  for (const [name, text] of documents) {
    if (!/\.rels$/i.test(name)) continue;
    const ids = new Set<string>();
    readXml(text, (element) => {
      requireValid(element.namespace === PACKAGE_REL_NS);
      if (element.depth === 0) {
        requireValid(element.local === 'Relationships');
        return;
      }
      requireValid(element.depth === 1 && element.local === 'Relationship');
      const id = element.attributes.get('Id');
      const type = element.attributes.get('Type');
      const target = element.attributes.get('Target');
      requireValid(id && type && target && !ids.has(id));
      ids.add(id);
      requireValid(
        !/(?:vbaProject|vbaData|attachedTemplate|aFChunk|oleObject|package|control|activeX)$/i.test(
          type
        )
      );
      const mode = element.attributes.get('TargetMode');
      if (mode === 'External') {
        requireValid(
          type.endsWith('/hyperlink') &&
            /^(?:https?:\/\/|mailto:)/i.test(target) &&
            !new RegExp(String.raw`[\x00-\x20]`).test(target)
        );
      } else {
        requireValid(mode === undefined || mode === 'Internal');
        const resolved = relationshipTarget(name, target);
        requireValid(files.has(resolved));
        if (name === '_rels/.rels' && OFFICE_DOCUMENT_RELATIONSHIPS.has(type)) {
          requireValid(resolved === 'word/document.xml');
          mainRelationships++;
        }
      }
    });
  }
  requireValid(mainRelationships === 1);
  let bodies = 0;
  readXml(documents.get('word/document.xml')!, (element) => {
    if (element.depth === 0)
      requireValid(element.local === 'document' && WORD_NAMESPACES.has(element.namespace));
    if (element.depth === 1 && element.local === 'body' && WORD_NAMESPACES.has(element.namespace))
      bodies++;
  });
  return bodies === 1;
}

/**
 * Identify supported CV formats and reject bounded structural/active-content
 * hazards. This is not an antivirus or a complete Office/PDF conformance parser;
 * callers must keep documents private and serve them only as attachments.
 */
export async function validateCareerCv(file: File): Promise<ValidatedCareerCv | null> {
  try {
    if (!(file instanceof File) || file.size === 0 || file.size > MAX_CV_BYTES) return null;
    const extension = /\.([a-z]+)$/i.exec(file.name.trim())?.[1].toLowerCase();
    if (extension !== 'pdf' && extension !== 'doc' && extension !== 'docx') return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== file.size || bytes.length === 0 || bytes.length > MAX_CV_BYTES)
      return null;
    const valid =
      extension === 'pdf'
        ? validPdf(bytes)
        : extension === 'doc'
          ? validDoc(bytes)
          : await validDocx(bytes);
    if (!valid) return null;
    const mime =
      extension === 'pdf'
        ? 'application/pdf'
        : extension === 'doc'
          ? 'application/msword'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return { bytes, extension, mime, filename: safeFilename(file.name.trim(), extension) };
  } catch {
    return null;
  }
}
