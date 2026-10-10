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
vm.runInContext(source.slice(source.indexOf('function loadConfiguration('), source.indexOf('// Startup code')), context);
const loadConfiguration = context.loadConfiguration;

function fixture(t, config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'garagedoor-config-test-'));
  const filename = path.join(directory, 'config.json');
  fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, filename };
}

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
