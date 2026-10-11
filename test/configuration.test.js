// Validate persisted identities and config failure handling using isolated temporary files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import vm from 'node:vm';
import { URL } from 'node:url';
import GarageDoor from '../dist/door.js';
import HomeKitDevice from '../dist/HomeKitDevice.js';

// Evaluate the actual inline loader without running index.js accessory publication or GPIO setup.
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = vm.createContext({ fs, crypto, Buffer, GarageDoor, HomeKitDevice, ACCESSORY_PINCODE: '031-45-154' });
vm.runInContext(source.slice(source.indexOf('function validateConfiguration('), source.indexOf('// Runtime state')), context);
const loadConfiguration = context.loadConfiguration;
const validateConfiguration = context.validateConfiguration;

function fixture(t, config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'garagedoor-config-test-'));
  const filename = path.join(directory, 'config.json');
  fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, filename };
}

test('web ports require integers in range and zero disables the UI', (t) => {
  for (const [port, expected] of [
    [0, 0],
    [1, 1],
    [65535, 65535],
    ['8581', 8581],
  ]) {
    const { filename } = fixture(t, { doors: [], options: { webUIPort: port } });
    assert.equal(loadConfiguration(filename).options.webUIPort, expected);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).options.webUIPort, expected);
  }
});

test('invalid editable values are rejected before startup writes or Web UI persistence', (t) => {
  const invalidConfigs = [
    ...[8581.5, '8581.5', -1, 65536, 'invalid', null, true, '', [], {}].map((webUIPort) => ({
      doors: [],
      options: { webUIPort },
    })),
    ...[null, [], false].map((options) => ({ doors: [], options })),
    { doors: [], options: { debug: 'true' } },
    { doors: [], options: { eveHistory: 1 } },
    { doors: [], options: { hkPairingCode: 'invalid' } },
    { doors: [], options: { webUIBearerToken: false } },
    ...[-1, 301, 'invalid', null, false, '', []].map((openTime) => ({ doors: [{ openTime }] })),
    { doors: [{ closeTime: 301 }] },
    { doors: [{ buttonBehavior: 'invalid' }] },
    { doors: [{ name: false }] },
    { doors: [{ pushButton: 16 }, { openSensor: '16' }] },
    { doors: [{ closedSensor: 16.5 }] },
    { doors: [null] },
    { doors: 'invalid' },
  ];
  for (const config of invalidConfigs) {
    const { filename } = fixture(t, config);
    const before = fs.readFileSync(filename, 'utf8');
    assert.throws(() => validateConfiguration(config), { name: 'TypeError' });
    assert.throws(() => loadConfiguration(filename), { name: 'TypeError' });
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
  }
});

test('validation leaves valid submitted configuration and generated identities untouched', (t) => {
  const config = {
    doors: [{ pushButton: '16', openSensor: 0, openTime: '25', closeTime: 25.5, buttonBehavior: 'auto-reverse' }],
    options: { webUIPort: '65535', debug: false, eveHistory: true, hkPairingCode: '031-45-154', webUIBearerToken: 'secret' },
  };
  const before = JSON.stringify(config);
  const { filename } = fixture(t, config);
  t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('Validation must not write');
  });
  t.mock.method(crypto, 'randomBytes', () => {
    throw new Error('Validation must not generate identities');
  });
  assert.equal(validateConfiguration(config), undefined);
  assert.equal(JSON.stringify(config), before);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.equal(validateConfiguration({ doors: [] }), undefined);
});

test('Web UI registers the shared validator for saves and restores', async () => {
  let options;
  class MockHomeKitUI {
    constructor(settings) {
      options = settings;
    }

    async start() {}
  }
  const uiContext = vm.createContext({
    HomeKitUI: MockHomeKitUI,
    config: { options: { webUIPort: 8581 } },
    version: '0.2.0',
    configurationFile: 'config.json',
    CONFIG_SCHEMA_FILE: 'schema.json',
    accessories: [],
    HAP: {},
    log: {},
    Logger: {},
    validateConfiguration,
    ui: undefined,
    shuttingDown: false,
  });
  const start = source.indexOf('// Start HomeKit Web UI');
  const end = source.indexOf('} catch (error) {', start);
  await vm.runInContext('(async () => {' + source.slice(start, end) + '})()', uiContext);
  assert.equal(options.onValidateConfig, validateConfiguration);
  assert.throws(() => options.onValidateConfig({ doors: [{ pushButton: 16, openSensor: 16 }] }), /already assigned/);
});

test('generated pairing identities survive reloading and private file permissions are retained', (t) => {
  const { filename } = fixture(t, { doors: [{ pushButton: '16', openSensor: 0 }] });
  const first = loadConfiguration(filename);
  const second = loadConfiguration(filename);
  assert.equal(first.doors[0].pushButton, 16);
  assert.equal(first.doors[0].openSensor, 0);
  assert.equal(second.doors[0].hkUsername, first.doors[0].hkUsername);
  assert.equal(second.doors[0].serialNumber, first.doors[0].serialNumber);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});

test('invalid optional GPIO values are rejected without altering the config', (t) => {
  for (const invalid of [null, false, true, '', ' ', 16.5, -1, 27, [], {}]) {
    const { filename } = fixture(t, { doors: [{ openSensor: invalid }] });
    const before = fs.readFileSync(filename, 'utf8');
    assert.throws(() => loadConfiguration(filename), /Invalid GPIO pin for openSensor/);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
  }
});

test('malformed structures cannot be rewritten as empty configuration', (t) => {
  for (const invalid of [null, [], {}, { doors: [null] }, { doors: 'invalid' }]) {
    const { filename } = fixture(t, invalid);
    const before = fs.readFileSync(filename, 'utf8');
    assert.throws(() => loadConfiguration(filename), { name: 'TypeError' });
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
  }
});

test('temporary write failure aborts loading and preserves the previous file', (t) => {
  const { filename, directory } = fixture(t, { doors: [{ pushButton: 16 }] });
  const before = fs.readFileSync(filename, 'utf8');
  t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('Disk unavailable');
  });
  assert.throws(() => loadConfiguration(filename), /Disk unavailable/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('rename failure aborts loading and removes the completed temporary file', (t) => {
  const { filename, directory } = fixture(t, { doors: [{ pushButton: 16 }] });
  const before = fs.readFileSync(filename, 'utf8');
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('Rename unavailable');
  });
  assert.throws(() => loadConfiguration(filename), /Rename unavailable/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('atomic saves follow the existing configuration symlink', (t) => {
  const { filename, directory } = fixture(t, { doors: [{ pushButton: 16 }] });
  const alias = path.join(directory, 'alias.json');
  fs.symlinkSync(filename, alias);
  const config = loadConfiguration(alias);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).doors[0].hkUsername, config.doors[0].hkUsername);
});

test('a relay and sensor cannot share a pin, including numeric-string aliases', (t) => {
  const { filename } = fixture(t, { doors: [{ pushButton: 16, closedSensor: '16' }] });
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => loadConfiguration(filename), /GPIO pin 16 is already assigned/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});

test('different doors cannot claim the same GPIO pin', (t) => {
  const { filename } = fixture(t, {
    doors: [
      { name: 'First', pushButton: 16 },
      { name: 'Second', pushButton: 16 },
    ],
  });
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => loadConfiguration(filename), /GPIO pin 16 is already assigned to door 1 pushButton/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});
