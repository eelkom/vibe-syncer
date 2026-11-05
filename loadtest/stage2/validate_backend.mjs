// Browser-free implementation check; writes diagnostics only to ignored .logs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ROOT, sleep, until } from '../lib/common.mjs';
import { createDatabase, dropDatabase } from '../lib/database.mjs';
import { startServer } from '../lib/server.mjs';
import { seedStage2 } from './seed.mjs';
import { startBots } from './bots.mjs';
import { monitorServer } from './monitor.mjs';
import { resolveCommit, validateArchive } from '../lib/commit.mjs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--commit')) throw new Error('Usage: validate_backend.mjs [--commit <sha>]');
const { sha } = resolveCommit(args[1] ?? 'b86324b');
await validateArchive(sha, { frontend: false });
const database = `loadtest_stage2_validation_${process.pid}`;
let server, bots, monitor, created = false;
const report = { kind: 'browser-free-validation', commit: sha, phases: [], errors: [], forced: 0 };
try {
  await createDatabase(database); created = true;
  const first = path.join(ROOT, '.logs', `${database}-1.jsonl`);
  server = await startServer(sha, database, 250, first); monitor = monitorServer(server, first);
  const seed = await seedStage2(database); bots = await startBots();
  await bots.admit({ room: seed.room.room_code, count: 3 });
  await until(() => bots.status.connected === 3, 60000, 'three real bot admissions');
  await bots.traffic({ mode: 'steady', seconds: 3 }); await sleep(4000);
  const before = await bots.snapshot(); assert.equal(before.sent.length, 6); assert.equal(before.control.length, 6);
  report.phases.push({ admission: before.connected, sent: before.sent.length, control_received: before.control.length, event_loop: before.event_loop });
  if ((await server.stop()).forced) report.forced++;
  await monitor.stop(); const firstMetrics = await monitor.result(); report.server_before = firstMetrics;
  assert.ok(firstMetrics.instrument.some(r => r.broadcast.count > 0 && r.pool.checked_out >= 0));
  await sleep(3000);
  const second = path.join(ROOT, '.logs', `${database}-2.jsonl`);
  server = await startServer(sha, database, 250, second); monitor = monitorServer(server, second);
  await until(() => bots.status.connected + bots.status.gave_up === 3, 120000, 'bot full jitter reconnect');
  const after = await bots.snapshot(); report.phases.push({ reconnected: after.connected, gave_up: after.gave_up, closes: after.bots.map(b => b.closes), event_loop: after.event_loop });
  assert.equal(after.connected + after.gave_up, 3); report.service_failure = after.gave_up > 0; await sleep(1500);
} catch (error) { report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  if (bots) { try { report.bots = await bots.stop(); } catch (error) { report.errors.push(error.message); await bots.kill(); } }
  if (server) { if ((await server.stop()).forced) report.forced++; }
  if (monitor) { await monitor.stop(); report.server_after = await monitor.result(); }
  if (created) await dropDatabase(database);
  const target = path.join(ROOT, '.logs', `${database}.json`); await writeFile(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: target, phases: report.phases, errors: report.errors, forced: report.forced }));
}
