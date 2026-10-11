// Exercise inline application shutdown without starting servers or exiting the test process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const shutdownSource = source.slice(source.indexOf('// Handle process shutdown'));

function setup(shutdownDoors, stopUI) {
  const exits = [];
  const errors = [];
  const context = vm.createContext({
    devices: (Array.isArray(shutdownDoors) === true ? shutdownDoors : [shutdownDoors]).map((shutdown) => ({ shutdown })),
    shuttingDown: false,
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

test('one door failure still waits for every other door before stopping the UI', async () => {
  let finishDoor;
  let stopped = false;
  const pendingDoor = new Promise((resolve) => {
    finishDoor = resolve;
  });
  const { shutdown, exits } = setup(
    [
      async () => {
        throw new Error('First door failed');
      },
      () => pendingDoor,
    ],
    async () => {
      stopped = true;
    },
  );
  const pending = shutdown('SIGTERM');
  await setImmediate();
  assert.equal(stopped, false);
  assert.deepEqual(exits, []);
  finishDoor();
  await pending;
  assert.equal(stopped, true);
  assert.deepEqual(exits, [1]);
});

for (const scenario of [
  { name: 'SIGINT during first publication', signal: 'SIGINT', publication: 1, code: 0 },
  { name: 'SIGTERM during second publication', signal: 'SIGTERM', publication: 2, code: 0 },
  { name: 'failed second publication', publication: 2, failPublication: true, code: 1 },
  { name: 'GPIO cleanup failure during SIGTERM', signal: 'SIGTERM', publication: 2, failClose: true, code: 1 },
]) {
  test(scenario.name + ' cleans up all owned doors and stops further setup', { timeout: 5000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'garagedoor-shutdown-'));
    const configuration = path.join(directory, 'config.json');
    const preload = path.join(directory, 'preload.mjs');
    fs.writeFileSync(
      configuration,
      JSON.stringify({
        doors: [16, 17, 18].map((pushButton) => ({ pushButton, manufacturer: 'Test', model: 'Test Door' })),
        options: { webUIPort: 0 },
      }),
    );
    // Run the real entry point, replacing only GPIO and publication boundaries.
    fs.writeFileSync(
      preload,
      'import GPIO from ' +
        JSON.stringify(new URL('../node_modules/rpio/lib/rpio.js', import.meta.url).href) +
        ';\n' +
        'import HAP from ' +
        JSON.stringify(new URL('../node_modules/@homebridge/hap-nodejs/dist/index.js', import.meta.url).href) +
        ';\n' +
        'GPIO.init = () => {}; GPIO.open = (pin) => console.log("GPIO_OPEN " + pin);\n' +
        'GPIO.read = () => GPIO.LOW; GPIO.write = () => {};\n' +
        'GPIO.close = (pin) => { console.log("GPIO_CLOSED " + pin);' +
        (scenario.failClose === true ? ' if (pin === 16) { throw new Error("Close failed"); }' : '') +
        ' };\n' +
        'HAP.Accessory.prototype.unpublish = async function() {};\n' +
        'let publications = 0; HAP.Accessory.prototype.publish = async function() {\n' +
        '  if (++publications === ' +
        scenario.publication +
        ') {\n' +
        (scenario.failPublication === true
          ? '    throw new Error("Publication failed");\n'
          : '    console.log("PUBLICATION_PENDING");\n    await new Promise(() => { setInterval(() => {}, 1000); });\n') +
        '  }\n};\n',
    );
    const child = spawn(
      process.execPath,
      ['--import', preload, fileURLToPath(new URL('../dist/index.js', import.meta.url)), configuration],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    let output = '';
    let errors = '';
    let sent = false;
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (scenario.signal !== undefined && sent === false && output.includes('PUBLICATION_PENDING') === true) {
        sent = true;
        child.kill(scenario.signal);
      }
    });
    const [code, exitSignal] = await exited;
    assert.equal(code, scenario.code, errors + output);
    assert.equal(exitSignal, null);
    assert.equal(sent, scenario.signal !== undefined);
    for (const pin of [16, 17].slice(0, scenario.publication)) {
      assert.equal(output.includes('GPIO_CLOSED ' + pin), true, output);
    }
    assert.equal(output.includes('GPIO_OPEN 18'), false, output);
    if (scenario.signal !== undefined) {
      assert.equal((output + errors).includes('Failed to start garage door controller'), false);
    }
  });
}
