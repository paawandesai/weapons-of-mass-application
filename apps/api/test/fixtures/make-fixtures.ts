/**
 * Regenerates the resume fixtures (fictional person) next to this file:
 *   pnpm --filter @wma/api exec tsx test/fixtures/make-fixtures.ts
 * resume.pdf via pdf-lib, resume.docx as a hand-built minimal zip, not-a-resume.png as a 1x1 PNG.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const RESUME_LINES = [
  'Mara Quill',
  'Senior Backend Engineer, Porto, Portugal',
  'mara.quill@example.com',
  'EXPERIENCE',
  'Google, Staff Software Engineer, 2021-03 to present',
  'Acme Corp, Software Engineer, 2018-06 to 2021-02',
  'EDUCATION',
  'University of Porto, BSc Computer Science, 2014-2018',
  'SKILLS',
  'TypeScript, PostgreSQL, Kubernetes',
];

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

async function pdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedStandardFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  RESUME_LINES.forEach((line, i) =>
    page.drawText(line, { x: 50, y: 780 - i * 22, size: 12, font }),
  );
  return doc.save();
}

function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function docx(): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const paras = RESUME_LINES.map((l) => `<w:p><w:r><w:t>${esc(l)}</w:t></w:r></w:p>`).join('');
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`,
  });
}

writeFileSync(here('resume.pdf'), await pdf());
writeFileSync(here('resume.docx'), docx());
writeFileSync(
  here('not-a-resume.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);
console.log('fixtures written');
