// 내 컴퓨터에서만 쓰는 시험용 서버 (Vercel에서는 쓰이지 않음)
//   npm run dev  →  http://localhost:3000
// public/ 폴더를 보여 주고, /api/* 는 api/index.js 로 보낸다. 데이터는 메모리에만 있어서 끄면 사라진다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import handler from '../api/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
const extraHeaders = vercel.headers.flatMap((h) => h.headers); // 보안 헤더도 똑같이 붙여서 시험

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

export function createDevServer() {
  return http.createServer(async (req, res) => {
    for (const h of extraHeaders) res.setHeader(h.key, h.value);
    const pathname = new URL(req.url, 'http://local').pathname;
    if (pathname.startsWith('/api/')) return handler(req, res);

    const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }
    try {
      const data = await readFile(file);
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.USE_MEMORY_DB = process.env.USE_MEMORY_DB || '1'; // 로컬 실행은 항상 메모리 DB
  const port = Number(process.env.PORT || 3000);
  createDevServer().listen(port, () => console.log(`http://localhost:${port}  (메모리 DB — 끄면 데이터가 사라집니다)`));
}
