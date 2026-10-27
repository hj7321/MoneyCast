import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const DEFAULT_STATIC_DIRECTORY = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function error(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(message);
}

/** Serve only files whose resolved real path stays inside the web build. */
export async function serveWeb(request: IncomingMessage, response: ServerResponse, url: URL, directory: string): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return error(response, 405, 'GET 또는 HEAD 요청만 지원합니다.');
  }
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return error(response, 400, '올바르지 않은 경로입니다.'); }
  if (/[\\\0:]/.test(pathname)) return error(response, 400, '올바르지 않은 경로입니다.');
  if (pathname.split('/').some(segment => segment.startsWith('.'))) return error(response, 404, '파일을 찾을 수 없습니다.');
  let root: string;
  try { root = await realpath(directory); } catch { return error(response, 503, '웹 빌드가 없습니다. 프로젝트 폴더에서 npm run build를 실행해 주세요.'); }
  let candidate = resolve(root, `.${pathname}`);
  if (!inside(root, candidate)) return error(response, 403, '허용되지 않은 경로입니다.');
  try {
    if ((await stat(candidate)).isDirectory()) candidate = resolve(candidate, 'index.html');
  } catch {
    // SPA routes without a file extension share the application entry point.
    if (!extname(pathname)) candidate = resolve(root, 'index.html');
  }
  let safePath: string;
  let size: number;
  try {
    safePath = await realpath(candidate);
    if (!inside(root, safePath)) return error(response, 403, '허용되지 않은 경로입니다.');
    if (relative(root, safePath).split(sep).some(segment => segment.startsWith('.'))) return error(response, 404, '파일을 찾을 수 없습니다.');
    const info = await stat(safePath);
    if (!info.isFile()) return error(response, 404, '파일을 찾을 수 없습니다.');
    size = info.size;
  } catch { return error(response, 404, '파일을 찾을 수 없습니다.'); }
  const extension = extname(safePath).toLowerCase();
  const immutable = /[.-][a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(safePath) && extension !== '.html';
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream', 'Content-Length': size,
    'Cache-Control': extension === '.html' ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(safePath);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}
