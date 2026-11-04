import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, REPO } from './common.mjs';
import { adminQuery } from './database.mjs';
export async function environment(argv) {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'node_modules/playwright-core/browsers.json'), 'utf8'));
  const chromium = manifest.browsers.find(b => b.name === 'chromium');
  return {
    started_at: new Date().toISOString(), node: process.version,
    python: execFileSync(path.join(ROOT, '.venv/bin/python'), ['--version'], { encoding: 'utf8' }).trim(),
    chromium_version: null, chromium_expected_version: chromium.browserVersion,
    chromium_version_note: '실제 launch 시 browser.version() 기록; 봇 전용 실행은 null (브라우저 실행 안 함)',
    cpu_model: os.cpus()[0]?.model ?? null, cpu_cores: os.cpus().length,
    memory_bytes: os.totalmem(), os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    postgres: (await adminQuery('SELECT version()')).rows[0].version,
    git_reference_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    comparison_main: execFileSync('git', ['rev-parse', 'b86324b'], { cwd: REPO, encoding: 'utf8' }).trim(),
    argv, load_average_start: os.loadavg(), python_freeze: await readFile(path.join(ROOT, '.logs/python-freeze.txt'), 'utf8'),
  };
}
