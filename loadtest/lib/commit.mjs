import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { REPO, ROOT } from './common.mjs';
export function validateCommit(value) {
  if (!/^[0-9a-f]{7,40}$/.test(value ?? '')) throw new Error('--commit needs a 7–40 character lowercase hexadecimal SHA');
  return value;
}
export function resolveCommit(value, exec = execFileSync) {
  validateCommit(value);
  const git = args => exec('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
  const full = git(['rev-parse', '--verify', `${value}^{commit}`]);
  return { sha: git(['rev-parse', '--short=7', full]), full };
}
export async function validateArchive(value, { profiling = false, frontend = true, root = ROOT, resolve = resolveCommit } = {}) {
  const { sha, full } = resolve(value), base = path.join(root, '.baselines', sha);
  try {
    if ((await readFile(path.join(base, '.archive-sha'), 'utf8')).trim() !== full) throw new Error('Archive SHA mismatch');
    await stat(path.join(base, 'backend'));
    if (frontend) await stat(path.join(base, 'frontend', profiling ? 'dist-profiling' : 'dist', 'index.html'));
  } catch (error) {
    throw new Error(`Run loadtest/scripts/prepare_${profiling ? 'profiling' : 'commit'}.sh ${sha} first: ${error.message}`);
  }
  return { sha, full };
}
