// Итоги голосования в Excel (.xlsx) без внешних библиотек.
// Баллы считаются формулой Excel: голоса участника / всего голосов × 160, с округлением до целого.

import zlib from 'node:zlib';

const esc = (s) =>
  String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

// ---------- минимальный ZIP (deflate) ----------

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------- ячейки ----------

const str = (ref, v, style = 0) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
const num = (ref, v, style = 0) => `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>`;
const fml = (ref, f, cached, style = 0) => `<c r="${ref}"${style ? ` s="${style}"` : ''}><f>${esc(f)}</f><v>${cached}</v></c>`;
const row = (n, cells) => `<row r="${n}">${cells.join('')}</row>`;

// Стили: 0 — обычный, 1 — жирный, 2 — число 0.00, 3 — жирное число 0.00, 4 — жирный заголовок с заливкой.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDF7EE"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * @param {{ title: string, finishedAt: string, candidates: {name: string, votes: number}[] }} data
 * @returns {Buffer}
 */
export function resultsXlsx({ title, finishedAt, candidates }) {
  // Участники в порядке голосования, № — их номер в голосовании (как в протоколе). Без сортировки по голосам.
  const list = candidates.map((c, i) => ({ ...c, num: i + 1 }));
  const total = list.reduce((s, c) => s + c.votes, 0);
  const first = 4;
  const last = first + list.length - 1;
  const totalRow = last + 1;
  const points = (v) => (total ? Math.round((v / total) * 160) : 0);

  const rows = [
    row(1, [str('A1', title, 5)]),
    row(2, [str('A2', `Итоги на ${finishedAt}`)]),
    row(3, ['№', 'Участник', 'Голоса', 'Баллы (из 160)'].map((h, i) => str(`${'ABCD'[i]}3`, h, 4))),
    ...list.map((c, i) => {
      const r = first + i;
      return row(r, [
        num(`A${r}`, c.num),
        str(`B${r}`, c.name),
        num(`C${r}`, c.votes),
        fml(`D${r}`, `IF($C$${totalRow}=0,0,ROUND(C${r}/$C$${totalRow}*160,0))`, points(c.votes)),
      ]);
    }),
    row(totalRow, [
      str(`B${totalRow}`, 'Всего голосов', 1),
      fml(`C${totalRow}`, `SUM(C${first}:C${last})`, total, 1),
      fml(`D${totalRow}`, `SUM(D${first}:D${last})`, list.reduce((n, c) => n + points(c.votes), 0), 1),
    ]),
  ];

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="10" customWidth="1"/><col min="4" max="4" width="16" customWidth="1"/></cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;

  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Итоги" sheetId="1" r:id="rId1"/></sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    'xl/worksheets/sheet1.xml': sheet,
    'xl/styles.xml': STYLES,
  });
}
