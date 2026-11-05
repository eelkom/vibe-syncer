"""Opt-in stage2 telemetry; bounded histograms, one JSONL write per second."""
import asyncio
from collections import Counter
import json
import math
import time


class Aggregate:
    bounds = (.1, .25, .5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000, 2000, 4000, 8000, 16000, 32000, math.inf)

    def __init__(self):
        self.count = 0
        self.total = self.maximum = 0.0
        self.histogram = Counter()

    def add(self, value):
        self.count += 1
        self.total += value
        self.maximum = max(self.maximum, value)
        self.histogram[next(bound for bound in self.bounds if value <= bound)] += 1

    def result(self):
        seen = 0
        p95 = None
        for bound in self.bounds:
            seen += self.histogram[bound]
            if self.count and seen >= math.ceil(self.count * .95):
                p95 = min(bound, self.maximum)
                break
        return dict(count=self.count, sum_ms=self.total, max_ms=self.maximum, p95_ms_approx=p95)


def install(app, engine, manager_class, target):
    state = dict(lag=Aggregate(), broadcast=Aggregate(), connections=Aggregate(), connections_max=0)
    original = manager_class.broadcast_to_room

    async def measured(self, room_id, message):
        connections = len(self.active_connections.get(room_id, []))
        state['connections_max'] = max(state['connections_max'], connections)
        state['connections'].add(connections)
        start = time.perf_counter()
        try:
            return await original(self, room_id, message)
        finally:
            state['broadcast'].add((time.perf_counter() - start) * 1000)
    manager_class.broadcast_to_room = measured
    task = None
    stream = None

    def flush():
        record = dict(t=int(time.time() * 1000), event_loop=state['lag'].result(),
                      broadcast=state['broadcast'].result(), connections_max=state['connections_max'],
                      connections={key.replace('_ms', ''): value for key, value in state['connections'].result().items()},
                      pool=dict(checked_out=engine.pool.checkedout(), overflow=engine.pool.overflow()))
        stream.write(json.dumps(record) + '\n')
        stream.flush()
        state.update(lag=Aggregate(), broadcast=Aggregate(), connections=Aggregate(), connections_max=0)

    async def sample():
        loop = asyncio.get_running_loop()
        due, emit = loop.time() + .1, loop.time() + 1
        while True:
            await asyncio.sleep(max(0, due - loop.time()))
            now = loop.time()
            state['lag'].add(max(0, (now - due) * 1000))
            due = now + .1
            if now >= emit:
                flush()
                emit = now + 1

    async def start():
        nonlocal task, stream
        target.parent.mkdir(parents=True, exist_ok=True)
        stream = target.open('x', buffering=1)
        task = asyncio.create_task(sample())

    async def stop():
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if stream:
            flush()
            stream.close()
    app.router.add_event_handler('startup', start)
    app.router.add_event_handler('shutdown', stop)
