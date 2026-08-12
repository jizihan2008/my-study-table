// 本地静态服务器（PWA 预览用）：node dev-server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found: ' + p);
  }
  // no-store：开发时禁止浏览器缓存（否则启发式缓存会导致改了代码刷新仍是旧版本）
  res.writeHead(200, {
    'Content-Type': mime[path.extname(fp)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(fp).pipe(res);
}).listen(8080, () => console.log('serving http://localhost:8080'));
