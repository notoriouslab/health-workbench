// central directory 的「未壓縮大小」讀取驗證。fixture 刻意用 Python zipfile 產
// （與被測程式異源：自家 writer 產的 zip 只能證明「我寫的跟我讀的一致」），
// 再手工把欄位改成 zip64 標記，驗「不可得」訊號真的傳得出來。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findZipXmlMember } from "../../src/engine/bytesource.js";
import { nodeFileSource } from "../helpers/node_source.mjs";

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="zh_TW">\n'
  + '  <Record type="HKQuantityTypeIdentifierBodyMass" value="70" unit="kg"/>\n'
  + '  <Record type="HKQuantityTypeIdentifierHeight" value="170" unit="cm"/>\n'
  + "</HealthData>\n";
const XML_BYTES = new TextEncoder().encode(XML).length;

// fixture A：三成員 zip（非 cda 的 .xml 排在最前，符合真實匯出的成員順序）
function makeZip() {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-zipsize-"));
  const zipPath = path.join(dir, "export.zip");
  execFileSync("python3", ["-c", [
    "import sys, zipfile",
    "xml = sys.argv[2]",
    "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:",
    "    z.writestr('export/data.xml', xml)",
    "    z.writestr('export/route.gpx', '<gpx></gpx>')",
    "    z.writestr('export/export_cda.xml', '<ClinicalDocument/>')",
  ].join("\n"), zipPath, XML]);
  return { dir, zipPath };
}

test("central directory 讀出未壓縮大小（Python zipfile 產的 zip）", async () => {
  const { zipPath } = makeZip();
  const member = await findZipXmlMember(await nodeFileSource(zipPath));
  assert.equal(member.name, "export/data.xml");
  assert.equal(member.uncompSize, XML_BYTES);
  assert.ok(member.compSize > 0, `compSize 應大於 0，實得 ${member.compSize}`);
});

test("未壓縮大小為 zip64 標記時回 0（不可得）", async () => {
  const { dir, zipPath } = makeZip();
  const buf = readFileSync(zipPath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const target = new TextEncoder().encode("export/data.xml");
  let patched = 0;
  for (let p = 0; p + 46 <= buf.length; p++) {
    if (dv.getUint32(p, true) !== 0x02014b50) continue;
    const nameLen = dv.getUint16(p + 28, true);
    if (nameLen !== target.length) continue;
    if (!target.every((b, i) => buf[p + 46 + i] === b)) continue;
    dv.setUint32(p + 24, 0xFFFFFFFF, true);
    patched += 1;
  }
  assert.equal(patched, 1, "應恰好改到一筆 central directory 記錄");
  const zip64Path = path.join(dir, "export_zip64.zip");
  writeFileSync(zip64Path, buf);

  const member = await findZipXmlMember(await nodeFileSource(zip64Path));
  assert.equal(member.name, "export/data.xml");
  assert.equal(member.uncompSize, 0);
});
