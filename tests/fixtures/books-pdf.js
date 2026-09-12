'use strict';

// 生成一个最小可用的多页 PDF（纯文本），供教材学习 tab 的 e2e 测试使用。
// 只依赖 Node 内置能力，避免测试引入额外依赖。
function buildTestPdf(pageCount = 3) {
  const objects = [];
  const kidRefs = [];
  const fontId = 3 + pageCount * 2;
  for (let i = 0; i < pageCount; i++) kidRefs.push(`${3 + i * 2} 0 R`);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kidRefs.join(' ')}] /Count ${pageCount} >>`;
  for (let i = 0; i < pageCount; i++) {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 24 Tf 72 760 Td (Test Page ${i + 1}) Tj ET`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// 在渲染进程里注入一本教材 + 其 PDF 字节（Electron 下走 IndexedDB 的 BookPdfStore）
async function seedStudyBook(page, { bookId = 99001, chapterId = 99002, pageCount = 3, title = '全屏测试教材' } = {}) {
  const pdfBase64 = buildTestPdf(pageCount).toString('base64');
  await page.evaluate(async ({ b64, bookId, chapterId, pageCount, title }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    localStorage.setItem('study_books_v1', JSON.stringify([{
      id: bookId,
      title,
      filePath: '',
      totalPages: pageCount,
      chapters: [{ id: chapterId, title: '第一章 测试', startPage: 1, endPage: pageCount }],
      kb: { status: 'none' }
    }]));
    localStorage.setItem('study_bk_active_book', String(bookId));
    localStorage.setItem('study_bk_active_chapter', String(chapterId));
    localStorage.setItem('study_bk_active_tab', 'study');
    await window.BookPdfStore.put(bookId, bytes, 'e2e-test.pdf');
  }, { b64: pdfBase64, bookId, chapterId, pageCount, title });
}

// 打开「教材 → 学习」tab 并等待内嵌 PDF 渲染完成
async function openStudyTab(page, { bookId = 99001, chapterId = 99002, pageCount = 3, title = '全屏测试教材' } = {}) {
  await seedStudyBook(page, { bookId, chapterId, pageCount, title });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);
  await page.evaluate(() => switchTab('books'));
  await page.waitForSelector('#booksApp', { state: 'visible', timeout: 15000 });
  await page.waitForSelector('.bk-study-pdf-canvas', { state: 'attached', timeout: 15000 });
  await page.waitForFunction(() => {
    const indicator = document.getElementById('bkStudyPdfIndicator');
    return !!indicator && /\/\s*\d+/.test(indicator.textContent || '');
  }, null, { timeout: 15000 });
}

module.exports = { buildTestPdf, seedStudyBook, openStudyTab };
