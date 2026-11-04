import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './common.mjs';
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
export async function tone() {
  const dir = path.join(ROOT, '.media');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'tone.wav');
  const rate = 8000, frames = rate * 600, size = frames * 2;
  try { if ((await stat(target)).size === size + 44) return dir; } catch {}
  const b = Buffer.alloc(size + 44);
  b.write('RIFF'); b.writeUInt32LE(size + 36, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  await writeFile(target, b);
  return dir;
}
export async function staticServer(root, port, spa = false) {
  root = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      let target = path.resolve(root, `.${pathname}`);
      if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      let info;
      try { info = await stat(target); if (!info.isFile()) throw new Error(); }
      catch { if (!spa) { res.writeHead(404).end(); return; } target = path.join(root, 'index.html'); info = await stat(target); }
      res.setHeader('Content-Type', types[path.extname(target)] ?? 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');
      let start = 0, end = info.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
        if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
        status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }
      res.writeHead(status, { 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') res.end();
      else createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { close: () => new Promise((resolve, reject) => { server.close(err => err ? reject(err) : resolve()); server.closeAllConnections(); }) };
}
