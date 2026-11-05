import { distribution } from './stats.mjs';
export function receiveControl(control, buffer, t = Date.now()) {
  // String matching only: keep the high-volume receive path free of JSON parsing.
  for (const match of buffer.toString().matchAll(/c-([bg]\d*)-(\d+)-(\d+)/g)) {
    const row = control.get(match[0]);
    if (row) row[0]++;
    else control.set(match[0], [1, t]);
  }
}
export const controlRows = control => [...control].map(([marker, [count, first]]) => [marker, count, first]);
export function controlDelivery(sent, control, sentAt = new Map()) {
  const received = new Map(control.map(row => [row[0], row[2]])), values = [];
  for (const marker of new Set(sent)) {
    const first = received.get(marker), start = sentAt.get(marker) ?? Number(marker.match(/-(\d+)$/)?.[1]);
    if (Number.isFinite(first) && Number.isFinite(start)) values.push(first - start);
  }
  return { control_delivery_ms: distribution(values), control_delivery_values_ms: values, control_delivery_count: values.length };
}
