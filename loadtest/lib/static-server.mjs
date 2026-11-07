import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat, access, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ROOT } from './common.mjs';
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
export async function tone() {
  const ffmpeg = '/opt/homebrew/bin/ffmpeg';
  try { await access(ffmpeg, constants.X_OK); }
  catch { throw new Error(`Media generation requires executable ffmpeg: ${ffmpeg}`); }
  const dir = path.join(ROOT, '.media');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'tone.webm');
  try { if ((await stat(target)).size > 0) return dir; } catch {}
  const partial = path.join(dir, 'tone.partial.webm');
  try {
    await promisify(execFile)(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1:d=600',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=600',
      '-t', '600', '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-r', '1',
      '-c:a', 'libopus', '-ac', '1', '-b:a', '32k', partial,
    ]);
    await rename(partial, target);
  } catch (error) { throw new Error(`ffmpeg tone.webm generation failed: ${error.message}`); }
  return dir;
}
// Keep tone.webm and its cache unchanged for all existing scenarios.
export async function syncMedia() {
  const dir = await tone();
  for (const [name, seconds] of [['short', 20], ['long', 900]]) {
    const target = path.join(dir, `${name}.webm`);
    try { if ((await stat(target)).size > 0) continue; } catch {}
    const partial = path.join(dir, `${name}.partial.webm`);
    try {
      await promisify(execFile)('/opt/homebrew/bin/ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'lavfi', '-i', `color=c=black:s=16x16:r=1:d=${seconds}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
        '-t', String(seconds), '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-r', '1',
        '-c:a', 'libopus', '-ac', '1', '-b:a', '32k', partial,
      ]);
      await rename(partial, target);
    } catch (error) { throw new Error(`ffmpeg ${name}.webm generation failed: ${error.message}`); }
  }
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
