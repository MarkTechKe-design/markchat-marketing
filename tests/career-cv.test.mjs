import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { MAX_CV_BYTES, validateCareerCv } from '../src/lib/server/career-cv.ts';

const fixture = (extension) =>
  readFileSync(new URL(`./fixtures/careers/sample-cv.${extension}`, import.meta.url));
const file = (bytes, name = 'Applicant-CV.docx', type = '') => new File([bytes], name, { type });
const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
const rootRelationships = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Sample applicant</w:t></w:r></w:p></w:body></w:document>`;
const parts = () => [
  { name: '[Content_Types].xml', text: contentTypes },
  { name: '_rels/.rels', text: rootRelationships },
  { name: 'word/document.xml', text: documentXml },
];

// Independent fixture writer using the ZIP APPNOTE layout; malformed options
// intentionally exercise validation of the archive instead of a ZIP library.
function zip(entries, { descriptor = false, stored = false } = {}) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const data = Buffer.from(entry.text ?? '');
    const compressed = stored ? data : deflateRawSync(data);
    const checksum = crc32(data);
    const flags = entry.flags ?? (descriptor ? 8 : 0);
    const declaredSize = entry.declaredSize ?? data.length;
    const method = entry.method ?? (stored ? 0 : 8);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(descriptor ? 0 : checksum, 14);
    header.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
    header.writeUInt32LE(descriptor ? 0 : declaredSize, 22);
    header.writeUInt16LE(localName.length, 26);
    const tail = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      tail.writeUInt32LE(0x08074b50);
      tail.writeUInt32LE(checksum, 4);
      tail.writeUInt32LE(compressed.length, 8);
      tail.writeUInt32LE(declaredSize, 12);
    }
    locals.push(header, localName, compressed, tail);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.offset ?? offset, 42);
    directory.push(central, name);
    offset += header.length + localName.length + compressed.length + tail.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

for (const [extension, mime] of [
  ['pdf', 'application/pdf'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]) {
  test(`accepts a real exported ${extension.toUpperCase()} CV and returns verified metadata`, async () => {
    const bytes = fixture(extension);
    const result = await validateCareerCv(file(bytes, `Sample CV.${extension}`, 'text/plain'));
    assert.ok(result, 'The real document should validate even with an untrusted MIME claim');
    assert.equal(result.extension, extension);
    assert.equal(result.mime, mime);
    assert.equal(result.filename, `Sample CV.${extension}`);
    assert.deepEqual(result.bytes, new Uint8Array(bytes));
  });
}

test('rejects empty and oversized CVs before returning any bytes', async () => {
  assert.equal(await validateCareerCv(file('', 'empty.pdf')), null);
  assert.equal(await validateCareerCv(file(Buffer.alloc(MAX_CV_BYTES + 1), 'large.pdf')), null);
});

test('requires an allowed extension matching the actual document format', async () => {
  for (const [bytes, name] of [
    [fixture('pdf'), 'cv.exe'],
    [fixture('pdf'), 'cv.doc'],
    [fixture('docx'), 'cv.pdf'],
    [fixture('doc'), 'cv.docx'],
    [Buffer.from('<html>CV</html>'), 'cv.doc'],
  ]) {
    assert.equal(await validateCareerCv(file(bytes, name)), null, name);
  }
});

test('normalizes filenames into safe bounded attachment basenames', async () => {
  const result = await validateCareerCv(
    file(fixture('pdf'), '../../CV\\Jane\r\n"<>\u202eApplicant.PDF')
  );
  assert.ok(result);
  assert.match(result.filename, /\.pdf$/);
  assert.doesNotMatch(result.filename, /[\r\n"<>/\\\u202e]/);
  assert.ok(result.filename.length <= 120);
  const long = await validateCareerCv(file(fixture('pdf'), 'x'.repeat(400) + '.pdf'));
  assert.ok(long && long.filename.length <= 120);
});

test('rejects a PDF header without a PDF body and trailer', async () => {
  for (const bytes of ['%PDF-1.7', '%PDF-1.7\nmalicious text\n%%EOF', '%PDF-1.7\n%%EOF']) {
    assert.equal(await validateCareerCv(file(bytes, 'cv.pdf')), null);
  }
});

test('rejects truncated and encrypted PDFs, including escaped encryption names', async () => {
  const original = fixture('pdf');
  assert.equal(
    await validateCareerCv(file(original.subarray(0, original.length - 100), 'cv.pdf')),
    null
  );
  for (const key of ['/Encrypt', '/En#63rypt']) {
    const text = original.toString('latin1').replace('/Root ', `${key} 1 0 R /Root `);
    assert.equal(await validateCareerCv(file(Buffer.from(text, 'latin1'), 'cv.pdf')), null);
  }
});

test('rejects CFB magic with fake WordDocument text instead of a real directory stream', async () => {
  const spoof = Buffer.alloc(1024);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(spoof);
  Buffer.from('WordDocument', 'utf16le').copy(spoof, 600);
  assert.equal(await validateCareerCv(file(spoof, 'cv.doc')), null);
});

test('rejects non-Word, encrypted and macro-bearing compound documents', async () => {
  const original = fixture('doc');
  const wordName = Buffer.from('WordDocument', 'utf16le');
  const directoryOffset = original.indexOf(wordName);
  assert.ok(directoryOffset > 0, 'Expected a real Word directory entry in the fixture');
  const nonWord = Buffer.from(original);
  Buffer.from('ExcelSheet  ', 'utf16le').copy(nonWord, directoryOffset);
  assert.equal(await validateCareerCv(file(nonWord, 'cv.doc')), null);

  const encrypted = Buffer.from(original);
  const fib = encrypted.indexOf(Buffer.from([0xec, 0xa5]));
  assert.ok(fib > 0, 'Expected a real Word FIB');
  encrypted.writeUInt16LE(encrypted.readUInt16LE(fib + 10) | 0x0100, fib + 10);
  assert.equal(await validateCareerCv(file(encrypted, 'cv.doc')), null);

  const macro = Buffer.from(original);
  const summary = macro.indexOf(Buffer.from('\u0005SummaryInformation', 'utf16le'));
  assert.ok(summary > 0, 'Expected a summary directory entry');
  macro.fill(0, summary, summary + 64);
  Buffer.from('Macros\0', 'utf16le').copy(macro, summary);
  macro.writeUInt16LE(14, summary + 64);
  macro[summary + 66] = 1;
  assert.equal(await validateCareerCv(file(macro, 'cv.doc')), null);
});

test('rejects invalid compound sector references and cyclic directory chains', async () => {
  const original = fixture('doc');
  const outside = Buffer.from(original);
  outside.writeUInt32LE(0x7fffffff, 48);
  assert.equal(await validateCareerCv(file(outside, 'cv.doc')), null);
  const cyclic = Buffer.from(original);
  const directorySector = cyclic.readUInt32LE(48);
  const fatSector = cyclic.readUInt32LE(76);
  cyclic.writeUInt32LE(directorySector, (fatSector + 1) * 512 + directorySector * 4);
  assert.equal(await validateCareerCv(file(cyclic, 'cv.doc')), null);
});

test('accepts both stored and deflated DOCX packages and streamed data descriptors', async () => {
  for (const options of [{ stored: true }, {}, { descriptor: true }]) {
    assert.ok(await validateCareerCv(file(zip(parts(), options))), JSON.stringify(options));
  }
});

test('rejects ZIP magic and unrelated or incomplete ZIP archives', async () => {
  for (const bytes of [
    Buffer.from('PK\x03\x04not a document'),
    zip([{ name: 'notes.txt', text: 'Hello' }]),
    zip(parts().filter((part) => part.name !== '_rels/.rels')),
    zip(parts().filter((part) => part.name !== 'word/document.xml')),
  ]) {
    assert.equal(await validateCareerCv(file(bytes)), null);
  }
});

test('requires real Word XML and package relationships instead of matching filenames', async () => {
  for (const [name, text] of [
    [
      '[Content_Types].xml',
      contentTypes.replace('wordprocessingml.document.main', 'spreadsheetml.sheet.main'),
    ],
    [
      '_rels/.rels',
      rootRelationships.replace('Target="word/document.xml"', 'Target="missing.xml"'),
    ],
    ['word/document.xml', '<html>not a Word document</html>'],
    ['word/document.xml', documentXml.replace('</w:body>', '</w:broken>')],
    [
      'word/document.xml',
      documentXml.replace('wordprocessingml/2006/main', 'attacker.invalid/namespace'),
    ],
  ]) {
    const entries = parts().map((part) => (part.name === name ? { ...part, text } : part));
    assert.equal(await validateCareerCv(file(zip(entries))), null, name);
  }
});

test('rejects macros, encrypted ZIP entries and embedded active packages', async () => {
  for (const extra of [
    { name: 'word/vbaProject.bin', text: 'macro' },
    { name: 'word/embeddings/oleObject1.bin', text: 'embedded object' },
    { name: 'word/activeX/activeX1.xml', text: '<control/>' },
  ]) {
    assert.equal(await validateCareerCv(file(zip([...parts(), extra]))), null, extra.name);
  }
  const macroTypes = parts().map((part) =>
    part.name === '[Content_Types].xml'
      ? {
          ...part,
          text: part.text.replace(
            'wordprocessingml.document.main',
            'ms-word.document.macroEnabled.main'
          ),
        }
      : part
  );
  assert.equal(await validateCareerCv(file(zip(macroTypes))), null);
  for (const flags of [1, 0x40, 0x2000]) {
    assert.equal(
      await validateCareerCv(file(zip(parts().map((part) => ({ ...part, flags }))))),
      null
    );
  }
});

test('rejects duplicate, traversing and mismatched archive entry names', async () => {
  for (const extra of [
    { name: 'word/document.xml', text: documentXml },
    { name: 'WORD/DOCUMENT.XML', text: documentXml },
    { name: '../escape.xml', text: '<x/>' },
    { name: '/escape.xml', text: '<x/>' },
    { name: 'word\\escape.xml', text: '<x/>' },
    { name: 'word/%2e%2e/escape.xml', text: '<x/>' },
    { name: 'word/extra.xml', localName: 'word/other.xml', text: '<x/>' },
  ]) {
    assert.equal(await validateCareerCv(file(zip([...parts(), extra]))), null, extra.name);
  }
});

test('rejects corrupt compressed bytes, false expanded sizes and archive bombs', async () => {
  const corrupt = zip(parts());
  corrupt[30 + Buffer.byteLength('[Content_Types].xml') + 8] ^= 0x40;
  assert.equal(await validateCareerCv(file(corrupt)), null);
  const lying = parts().map((part) => ({ ...part, declaredSize: 1 }));
  assert.equal(await validateCareerCv(file(zip(lying))), null);
  assert.equal(
    await validateCareerCv(
      file(
        zip([
          ...parts(),
          { name: 'word/huge.xml', text: 'x'.repeat(9 * 1024 * 1024), declaredSize: 8 },
        ])
      )
    ),
    null
  );
  const manyEntries = [
    ...parts(),
    ...Array.from({ length: 300 }, (_, i) => ({ name: `word/part${i}.xml`, text: '<x/>' })),
  ];
  assert.equal(await validateCareerCv(file(zip(manyEntries))), null);
});

test('rejects overlapping local entries, split archives and ZIP64 sentinels', async () => {
  const overlap = parts();
  overlap[2].offset = 0;
  assert.equal(await validateCareerCv(file(zip(overlap))), null);
  for (const mutate of [
    (bytes) => bytes.writeUInt16LE(1, bytes.length - 18),
    (bytes) => bytes.writeUInt16LE(0xffff, bytes.length - 12),
    (bytes) => bytes.writeUInt32LE(0xffffffff, bytes.length - 6),
  ]) {
    const bytes = zip(parts());
    mutate(bytes);
    assert.equal(await validateCareerCv(file(bytes)), null);
  }
});

test('rejects XML entity declarations and external document-template relationships', async () => {
  const entities = parts().map((part) =>
    part.name === 'word/document.xml'
      ? {
          ...part,
          text: '<!DOCTYPE document [<!ENTITY payload SYSTEM "file:///etc/passwd">]>' + documentXml,
        }
      : part
  );
  assert.equal(await validateCareerCv(file(zip(entities))), null);
  const relationships = `
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="evil" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.invalid/template.dotm" TargetMode="External"/>
  </Relationships>`;
  assert.equal(
    await validateCareerCv(
      file(zip([...parts(), { name: 'word/_rels/document.xml.rels', text: relationships }]))
    ),
    null
  );
});

test('inspects relationship parts even when their extension is uppercase', async () => {
  const entries = parts();
  entries[0].text = contentTypes.replace(
    '</Types>',
    '<Default Extension="RELS" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'
  );
  entries.push({
    name: 'word/_rels/document.xml.RELS',
    text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="evil" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.invalid/template.dotm" TargetMode="External"/></Relationships>`,
  });
  assert.equal(await validateCareerCv(file(zip(entries))), null);
});

test('accepts normal CV hyperlinks and UTF-16 Word document XML', async () => {
  const entries = parts();
  entries[2].text = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(documentXml.replace('UTF-8', 'UTF-16'), 'utf16le'),
  ]);
  entries.push({
    name: 'word/_rels/document.xml.rels',
    text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="portfolio" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/portfolio" TargetMode="External"/></Relationships>`,
  });
  assert.ok(await validateCareerCv(file(zip(entries))));
});
