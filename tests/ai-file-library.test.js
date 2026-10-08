'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const rows = [
    { id: 'folder_course', kind: 'folder', name: '课程', parentId: null },
    { id: 'file_text', kind: 'file', name: '讲义.txt', parentId: 'folder_course', size: 10 },
    { id: 'file_pdf', kind: 'file', name: '教材.pdf', parentId: null, size: 20 },
    { id: 'file_zip', kind: 'file', name: '资料.zip', parentId: null, size: 20 }
  ];
  let reads = 0, destroyed = 0;
  const ctx = { console, getMaxFocusCount: () => 3, localStorage: { getItem: () => null },
    window: { aiFileLibrary: { list: async () => rows, read: async () => { reads++; return { size: 10, text: async () => '甲乙丙丁戊己' }; } } },
    isTextFile: file => /\.txt$/.test(file.name),
    openPdfAttachment: async () => ({ pdf: { numPages: 2, destroy: async () => { destroyed++; },
      getPage: async page => ({ getTextContent: async () => ({ items: page === 1 ? [{ str: '第一行', hasEOL: true }, { str: '第二行', hasEOL: true }] : [] }) }) } })
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ai-tools.js'), 'utf8'), ctx);
  return { ctx, rows, reads: () => reads, destroyed: () => destroyed };
}

test('file tools are selectable, read only, and expose validated native schemas', () => {
  const { ctx } = harness();
  const tools = ctx.selectAiToolsForConversation({ _toolGroups: ['file'] }, false, false);
  assert.deepEqual([...tools], ['list_library_files', 'read_library_file']);
  assert.equal(ctx.selectAiToolsForConversation({ _toolGroups: ['note'] }, false, false).has('read_library_file'), false);
  assert.equal(ctx.getAiToolMetadata('read_library_file').effect, 'read');
  assert.equal(ctx.beginAiToolTransaction('read_library_file'), null);
  assert.equal(ctx.getAiToolJsonSchema('read_library_file').properties.fileId.type, 'string');
  assert.equal(ctx.getAiToolJsonSchema('read_library_file').required.includes('fileId'), true);
  for (const params of [{ fileId: '../secret' }, { fileId: 'file_text', offset: -1 }, { fileId: 'file_text', limit: 8001 }, { fileId: 'file_text', pdfPage: 1.5 }]) {
    assert.equal(ctx.validateAiToolCall('read_library_file', params).ok, false);
  }
  assert.equal(ctx.validateAiToolCall('list_library_files', { libraryFolderId: 123 }).ok, false);
  assert.equal(ctx.validateAiToolCall('list_library_files', { page: 1.5 }).ok, false);
});

test('library search returns paths, folder filters and paginated metadata', async () => {
  const { ctx } = harness();
  const result = await ctx.executeToolCallStructured('list_library_files', { search: '课程', pageSize: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.data.total, 2);
  assert.equal(result.data.hasMore, true);
  const folder = await ctx.executeToolCallStructured('list_library_files', { libraryFolderId: 'folder_course' });
  assert.equal(folder.data.items[0].path, '课程/讲义.txt');
  assert.equal((await ctx.executeToolCallStructured('list_library_files', { libraryFolderId: '' })).data.total, 3);
  assert.equal((await ctx.executeToolCallStructured('list_library_files', { libraryFolderId: 'folder_missing' })).ok, false);
});

test('text reads preserve content and return continuation offsets; unavailable files fail', async () => {
  const { ctx, rows, reads } = harness();
  const first = await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_text', limit: 3 });
  assert.equal(first.data.content, '甲乙丙');
  assert.equal(first.data.nextOffset, 3);
  const last = await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_text', offset: 3 });
  assert.equal(last.data.content, '丁戊己');
  assert.equal(last.data.hasMore, false);
  assert.equal(last.data.nextOffset, null);
  assert.equal((await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_missing' })).ok, false);
  assert.equal((await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_zip' })).ok, false);
  const before = reads();
  rows[1].size = 9 * 1024 * 1024;
  assert.equal((await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_text' })).ok, false);
  assert.equal(reads(), before);
  ctx.window.aiFileLibrary = null;
  assert.equal((await ctx.executeToolCallStructured('list_library_files', {})).ok, false);
});

test('PDF reads page text, indicates scans and always releases the document', async () => {
  const { ctx, destroyed } = harness();
  const first = await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_pdf', limit: 2 });
  assert.equal(first.data.nextOffset, 2);
  assert.equal(first.data.nextPage, null);
  const remainder = await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_pdf', offset: 2 });
  assert.equal(remainder.data.nextPage, 2);
  const scan = await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_pdf', pdfPage: 2 });
  assert.match(scan.data.hint, /扫描/);
  assert.equal(scan.data.nextPage, null);
  assert.equal((await ctx.executeToolCallStructured('read_library_file', { fileId: 'file_pdf', pdfPage: 3 })).ok, false);
  assert.equal(destroyed(), 4);
});

test('desktop library adapter resolves IDs through existing IPC and omits binary data', async () => {
  class TestFile extends Blob {
    constructor(parts, name, opts) { super(parts, opts); this.name = name; }
  }
  const window = { FileLibraryOrder: { compare() {}, organize() {} }, electronAPI: {
    filesList: async () => [{ id: 'file_desktop', name: '桌面.txt', size: 3, blob: 'private', parentId: null }],
    filesRead: async id => id === 'file_desktop' ? { name: '桌面.txt', data: new Uint8Array([97, 98, 99]) } : null
  } };
  const ctx = vm.createContext({ window, document: { getElementById: () => null }, File: TestFile, Uint8Array });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/file-library.js'), 'utf8'), ctx);
  const rows = await window.aiFileLibrary.list();
  assert.equal(rows[0].kind, 'file');
  assert.equal('blob' in rows[0], false);
  assert.equal(await (await window.aiFileLibrary.read('file_desktop')).text(), 'abc');
  assert.equal(await window.aiFileLibrary.read('file_missing'), null);
});
