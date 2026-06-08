/**
 * xlsx.js — 极简 .xlsx 读取（零依赖）
 *
 * .xlsx 本质是 ZIP(含 XML)。本模块用浏览器内置的 DecompressionStream('deflate-raw')
 * 解压，手写解析 ZIP 中央目录与工作表/共享字符串 XML（正则，不依赖 DOMParser）。
 * 仅取第一个工作表，返回二维字符串数组（行×列），供 LoadParser 识别。
 *
 * 用法：await XlsxReader.read(arrayBuffer) → string[][]
 * 注意：需要运行环境支持 DecompressionStream（现代浏览器 / Node 18+）。
 */

const XlsxReader = {
  supported() {
    return typeof DecompressionStream !== 'undefined' &&
           typeof Blob !== 'undefined' && typeof Response !== 'undefined';
  },

  async read(arrayBuffer) {
    if (!this.supported()) {
      throw new Error('当前浏览器不支持解析 Excel，请改用 CSV，或在较新浏览器/电脑上重试。');
    }
    const buf = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    const entries = this._centralDir(buf, dv);

    const getText = async (name) => {
      const e = entries[name];
      if (!e) return null;
      const data = await this._entryData(buf, dv, e);
      return new TextDecoder('utf-8').decode(data);
    };

    const sharedXml = await getText('xl/sharedStrings.xml');
    const shared = sharedXml ? this._sharedStrings(sharedXml) : [];

    let sheetXml = await getText('xl/worksheets/sheet1.xml');
    if (!sheetXml) {
      const name = Object.keys(entries).find(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
      if (name) sheetXml = await getText(name);
    }
    if (!sheetXml) throw new Error('xlsx 中未找到工作表');
    return this._sheetRows(sheetXml, shared);
  },

  // ---- ZIP 中央目录 ----
  _centralDir(buf, dv) {
    let p = -1;
    const minI = Math.max(0, buf.length - 22 - 65536);
    for (let i = buf.length - 22; i >= minI; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { p = i; break; }
    }
    if (p < 0) throw new Error('不是有效的 xlsx(zip) 文件');
    const cdOffset = dv.getUint32(p + 16, true);
    const count = dv.getUint16(p + 10, true);
    const entries = {};
    let o = cdOffset;
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(o, true) !== 0x02014b50) break;
      const method = dv.getUint16(o + 10, true);
      const compSize = dv.getUint32(o + 20, true);
      const nameLen = dv.getUint16(o + 28, true);
      const extraLen = dv.getUint16(o + 30, true);
      const commentLen = dv.getUint16(o + 32, true);
      const localOff = dv.getUint32(o + 42, true);
      const name = new TextDecoder().decode(buf.subarray(o + 46, o + 46 + nameLen));
      entries[name] = { method, compSize, localOff };
      o += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  },

  async _entryData(buf, dv, e) {
    if (dv.getUint32(e.localOff, true) !== 0x04034b50) throw new Error('ZIP 本地头无效');
    const nameLen = dv.getUint16(e.localOff + 26, true);
    const extraLen = dv.getUint16(e.localOff + 28, true);
    const start = e.localOff + 30 + nameLen + extraLen;
    const comp = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return comp;            // 未压缩
    if (e.method === 8) return await this._inflateRaw(comp);
    throw new Error('不支持的压缩方式: ' + e.method);
  },

  async _inflateRaw(u8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  },

  // ---- XML 解析 ----
  _sharedStrings(xml) {
    const out = [];
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g;
    let m;
    while ((m = re.exec(xml))) {
      const si = m[1] || '';
      let s = ''; let tm;
      const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      while ((tm = tre.exec(si))) s += this._dec(tm[1]);
      out.push(s);
    }
    return out;
  },

  _sheetRows(xml, shared) {
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cc;
      while ((cc = cRe.exec(rm[1]))) {
        const attrs = cc[1] || '';
        const inner = cc[2] || '';
        const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
        const t = (attrs.match(/t="([^"]+)"/) || [])[1];
        let val = '';
        if (t === 's') {
          const vi = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          val = (vi != null) ? (shared[+vi] || '') : '';
        } else if (t === 'inlineStr') {
          const im = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          val = im ? this._dec(im[1]) : '';
        } else {
          const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
          val = vm ? this._dec(vm[1]) : '';
        }
        const ci = ref ? this._colIdx(ref) : cells.length;
        cells[ci] = val;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      rows.push(cells);
    }
    return rows;
  },

  _colIdx(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  },

  _dec(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
};

if (typeof module !== 'undefined') module.exports = { XlsxReader };
