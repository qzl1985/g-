/**
 * pdfreader.js — PDF 文本提取（电费单识别用）
 *
 * 双通道：
 *   1) 懒加载 pdf.js（CDN）—— 对“文字可复制”的 PDF（含中文 ToUnicode）提取可靠；
 *   2) 零依赖兜底 —— 解析 PDF 流、用 DecompressionStream 解压 FlateDecode、
 *      抽取 (…)Tj / […]TJ 文本算子（对简单文本 PDF 有效，中文内嵌字体可能乱码）。
 *
 * 扫描件/图片型 PDF 无文字层，两通道都取不到 → 由界面引导改用「大模型视觉」或「录入表」。
 * 浏览器环境使用；返回 Promise<{text, via}>。
 */

const PdfReader = {
  async extractText(arrayBuffer) {
    // 通道1：pdf.js（更准，尤其中文）
    try {
      const t = await this._viaPdfjs(arrayBuffer);
      if (t && t.replace(/\s/g, '').length > 15) return { text: t, via: 'pdfjs' };
    } catch (e) { /* 加载失败/无网络则走兜底 */ }
    // 通道2：零依赖兜底
    try {
      const t = await this._zeroDep(arrayBuffer);
      return { text: t, via: 'builtin' };
    } catch (e) {
      return { text: '', via: 'none', error: e.message };
    }
  },

  _loadScript(src) {
    return new Promise((res, rej) => {
      if (typeof document === 'undefined') return rej(new Error('无 document'));
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('脚本加载失败'));
      document.head.appendChild(s);
    });
  },

  async _ensurePdfjs() {
    if (typeof window === 'undefined') throw new Error('非浏览器环境');
    if (window.pdfjsLib) return window.pdfjsLib;
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
    await this._loadScript(base + '/pdf.min.js');
    if (!window.pdfjsLib) throw new Error('pdf.js 未就绪');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + '/pdf.worker.min.js';
    return window.pdfjsLib;
  },

  async _viaPdfjs(ab) {
    const lib = await this._ensurePdfjs();
    const doc = await lib.getDocument({ data: ab.slice(0) }).promise;
    let out = '';
    const pages = Math.min(doc.numPages, 10);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent();
      out += c.items.map(it => it.str).join(' ') + '\n';
    }
    return out;
  },

  // 零依赖：抽取内容流中的文本算子
  async _zeroDep(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const latin1 = this._toLatin1(bytes);
    let text = '';
    // 找 stream...endstream
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(latin1))) {
      const start = m.index + m[0].length;
      let end = latin1.indexOf('endstream', start);
      if (end < 0) continue;
      const head = latin1.slice(Math.max(0, m.index - 300), m.index);
      // 优先按 /Length 精确截取压缩数据，避免把 endstream 前的换行并入
      const lenM = head.match(/\/Length\s+(\d+)/);
      let dataEnd = end;
      if (lenM) { const n = parseInt(lenM[1], 10); if (n > 0 && start + n <= end + 2) dataEnd = start + n; }
      else { while (dataEnd > start && (bytes[dataEnd - 1] === 10 || bytes[dataEnd - 1] === 13)) dataEnd--; }
      const raw = bytes.subarray(start, dataEnd);
      let content = '';
      if (/FlateDecode/.test(head)) {
        try { content = this._toLatin1(await this._inflate(raw)); } catch (e) { continue; }
      } else {
        content = this._toLatin1(raw);
      }
      text += this._extractOps(content);
    }
    return text;
  },

  _extractOps(content) {
    let out = '';
    // (字符串) Tj   以及  [(a)-12(b)] TJ
    const tj = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    const TJ = /\[((?:[^\[\]]|\\.)*)\]\s*TJ/g;
    let m;
    while ((m = tj.exec(content))) out += this._unescape(m[1]);
    while ((m = TJ.exec(content))) {
      const inner = m[1];
      const sre = /\(((?:\\.|[^\\()])*)\)/g; let s;
      while ((s = sre.exec(inner))) out += this._unescape(s[1]);
      out += ' ';
    }
    return out + '\n';
  },

  _unescape(s) {
    return s.replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, ' ')
            .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
  },

  async _inflate(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('无 DecompressionStream');
    // PDF FlateDecode 一般为 zlib(带头) → 'deflate'；个别为裸流 → 'deflate-raw' 兜底
    try { return await this._inflateWith(u8, 'deflate'); }
    catch (e) { return await this._inflateWith(u8, 'deflate-raw'); }
  },

  async _inflateWith(u8, fmt) {
    const ds = new DecompressionStream(fmt);
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  },

  _toLatin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
};

if (typeof module !== 'undefined') module.exports = { PdfReader };
