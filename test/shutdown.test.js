// Exercise inline application shutdown without starting servers or exiting the test process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const shutdownSource = source.slice(source.indexOf('let shuttingDown ='), source.indexOf('// Register process signal handlers'));

function setup(shutdownDoors, stopUI) {
  const exits = [];
  const errors = [];
  const context = vm.createContext({
    HomeKitDevice: { shutdown: shutdownDoors },
    ui: { stop: stopUI },
    log: { warn: () => {}, error: (...args) => errors.push(args) },
    process: { exit: (code) => exits.push(code) },
  });
  vm.runInContext(shutdownSource, context);
  return { shutdown: context.shutdown, exits, errors };
}

test('shutdown waits for UI cleanup before exiting and ignores duplicate signals', async () => {
  let finishStop;
  let stops = 0;
  const stopping = new Promise((resolve) => {
    finishStop = resolve;
  });
  const { shutdown, exits } = setup(
    async () => {},
    () => {
      stops++;
      return stopping;
    },
  );
  const pending = shutdown('SIGTERM');
  await setImmediate();
  assert.equal(stops, 1);
  assert.deepEqual(exits, []);
  await shutdown('SIGINT');
  assert.equal(stops, 1);
  finishStop();
  await pending;
  assert.deepEqual(exits, [0]);
});

test('UI cleanup failure is reported and produces a failing exit status', async () => {
  const { shutdown, exits, errors } = setup(
    async () => {},
    async () => {
      throw new Error('UI cleanup failed');
    },
  );
  await shutdown('SIGTERM');
  assert.deepEqual(exits, [1]);
  assert.match(errors[0][0], /Failed to stop Web UI/);
  assert.match(errors[0][1], /UI cleanup failed/);
});

test('door cleanup failure does not skip UI cleanup', async () => {
  let stopped = false;
  const { shutdown, exits, errors } = setup(
    async () => {
      throw new Error('Door cleanup failed');
    },
    async () => {
      stopped = true;
    },
  );
  await shutdown('SIGTERM');
  assert.equal(stopped, true);
  assert.deepEqual(exits, [1]);
  assert.match(errors[0][0], /Failed to shut down garage doors/);
});
