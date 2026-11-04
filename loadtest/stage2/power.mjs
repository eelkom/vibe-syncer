import { execFileSync } from 'node:child_process';
export function parsePowerSource(text) {
  return text.split(/\r?\n/, 1)[0].trim().match(/^Now drawing from ['"]([^'"]+)['"]\s*$/)?.[1] ?? null;
}
export function readPowerSource(exec = execFileSync) {
  try {
    const source = parsePowerSource(exec('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }));
    return { source, error: source === null ? 'Unrecognized pmset -g batt first line' : null };
  } catch (error) { return { source: null, error: error.message.slice(0, 500) }; }
}
export function capturePower(record, phase, read = readPowerSource) {
  const power = read();
  record.power_source ??= { start: null, end: null };
  record.power_source_errors ??= { start: null, end: null };
  record.power_source[phase] = power.source;
  record.power_source_errors[phase] = power.error;
  return power.source;
}
export function warnBattery(source, warn = console.warn) {
  if (source === 'Battery Power') warn('WARNING: Battery Power — 전원을 연결하고 덮개를 연 상태로 측정하세요.');
}
