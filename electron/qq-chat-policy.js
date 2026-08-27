'use strict';

async function resolveQQChatChunks({ exportRoot, manifest, fs, path, isPathInside, maxChunkBytes, maxTotalBytes }) {
  const chunksDirName = String(manifest?.chunked?.chunksDir || 'chunks').trim();
  if (!chunksDirName) throw new Error('manifest.json 格式不正确（chunksDir 不能为空）');
  const chunksDir = path.resolve(exportRoot, chunksDirName);
  const realExportRoot = await fs.promises.realpath(exportRoot);
  const realChunksDir = await fs.promises.realpath(chunksDir);
  if (!isPathInside(realExportRoot, realChunksDir)) throw new Error('chunks 目录必须位于所选导出文件夹内');
  const chunksStat = await fs.promises.lstat(chunksDir);
  if (!chunksStat.isDirectory() || chunksStat.isSymbolicLink()) throw new Error('chunks 必须是导出目录中的普通文件夹');

  const chunkFiles = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of manifest.chunked.chunks) {
    if (!entry || typeof entry !== 'object') throw new Error('manifest.json 的分片清单包含无效条目');
    const relative = typeof entry.relativePath === 'string'
      ? entry.relativePath
      : path.join(chunksDirName, String(entry.fileName || ''));
    if (!relative || path.isAbsolute(relative)) throw new Error('分片路径必须是 chunks 目录下的相对路径');
    const fullPath = path.resolve(exportRoot, relative);
    if (path.extname(fullPath).toLowerCase() !== '.jsonl') throw new Error('分片文件必须使用 .jsonl 扩展名');
    if (!fs.existsSync(fullPath)) throw new Error('找不到消息分片：' + relative);
    const realPath = await fs.promises.realpath(fullPath);
    if (!isPathInside(realChunksDir, realPath)) throw new Error('分片文件必须位于 chunks 目录内');
    const stat = await fs.promises.lstat(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('分片文件必须是普通 .jsonl 文件');
    if (stat.size > maxChunkBytes) throw new Error('单个消息分片超过 32 MB，拒绝读取');
    totalBytes += stat.size;
    if (totalBytes > maxTotalBytes) throw new Error('消息分片总大小超过 512 MB，拒绝读取');
    if (!seen.has(realPath)) { seen.add(realPath); chunkFiles.push(realPath); }
  }
  if (chunkFiles.length === 0) throw new Error('chunks 目录中未找到消息文件');
  return { chunkFiles, totalBytes, realChunksDir };
}

module.exports = { resolveQQChatChunks };
