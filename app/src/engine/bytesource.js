// ByteSource 介面：{ name, size, readAt(offset, len) => Promise<Uint8Array>,
//   stream(chunkSize) => AsyncGenerator<Uint8Array> }。
// 兩個環境實作：tests/helpers/node_source.mjs（node:fs）、
// src/engine/tauri_source.js（fs plugin）。本檔提供格式層包裝（zip 成員）。

export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function isZip(header) {
  return ZIP_MAGIC.every((b, i) => header[i] === b);
}

export function looksLikeHealthData(header) {
  // 真實匯出檔開頭有數 KB DTD，根元素可能在 4KB 之外（Python 同款判定）
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(header.subarray(0, 65536));
  return head.includes("<HealthData") || head.includes("<!DOCTYPE HealthData");
}

// 讀 zip central directory，找第一個非 cda 的 .xml 成員。
// 檔名解碼：一律以 UTF-8 解原始位元組（等價 Python cp437→utf-8 還原的結果）。
export async function findZipXmlMember(source) {
  const tailLen = Math.min(65558, source.size);
  const tail = await source.readAt(source.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i; break;
    }
  }
  if (eocd < 0) return null;
  const dv = new DataView(tail.buffer, tail.byteOffset);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const cd = await source.readAt(cdOffset, cdSize);
  const cdv = new DataView(cd.buffer, cd.byteOffset);
  let p = 0;
  while (p + 46 <= cdSize && cdv.getUint32(p, true) === 0x02014b50) {
    const method = cdv.getUint16(p + 10, true);
    const compSize = cdv.getUint32(p + 20, true);
    // +24 是 central directory 的未壓縮大小；0xFFFFFFFF 是 zip64 的溢位標記
    // （真值在 extra field，本層不解）。zip64 或欄位為 0 一律以 0 表示「不可得」，
    // 呼叫端據此不顯示百分比：進度寧可不顯示，也不顯示假的
    const rawUncomp = cdv.getUint32(p + 24, true);
    const nameLen = cdv.getUint16(p + 28, true);
    const extraLen = cdv.getUint16(p + 30, true);
    const cmtLen = cdv.getUint16(p + 32, true);
    const lho = cdv.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8", { fatal: false })
      .decode(cd.subarray(p + 46, p + 46 + nameLen));
    const lower = name.toLowerCase();
    if (lower.endsWith(".xml") && !lower.includes("cda")) {
      return {
        name, method, compSize, localHeaderOffset: lho,
        uncompSize: rawUncomp === 0xFFFFFFFF ? 0 : rawUncomp,
      };
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

// 把 zip 成員包成 ByteSource 樣式的串流（僅 stream；deflate 不支援 readAt）
export async function zipMemberStream(source, member, chunkSize = 4 * 1024 * 1024) {
  const lh = await source.readAt(member.localHeaderOffset, 30);
  const ldv = new DataView(lh.buffer, lh.byteOffset);
  const dataStart = member.localHeaderOffset + 30
    + ldv.getUint16(26, true) + ldv.getUint16(28, true);
  if (member.method === 0) {
    // stored：直接切片串流
    return (async function* () {
      for (let off = 0; off < member.compSize; off += chunkSize) {
        yield source.readAt(dataStart + off,
          Math.min(chunkSize, member.compSize - off));
      }
    })();
  }
  if (member.method !== 8) throw new Error(`不支援的 zip 壓縮法：${member.method}`);
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  (async () => {
    try {
      for (let off = 0; off < member.compSize; off += chunkSize) {
        const buf = await source.readAt(dataStart + off,
          Math.min(chunkSize, member.compSize - off));
        await writer.write(buf);
      }
      await writer.close();
    } catch (e) {
      await writer.abort(e).catch(() => {});
    }
  })();
  const reader = ds.readable.getReader();
  return (async function* () {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  })();
}
