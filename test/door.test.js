// Exercise the real GarageDoor and HomeKitDevice lifecycle with mocked GPIO and publication.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import HAP from '@homebridge/hap-nodejs';
import GPIO from 'rpio';
import GarageDoor from '../dist/door.js';
import HomeKitDevice from '../dist/HomeKitDevice.js';

HomeKitDevice.PLUGIN_NAME = 'garagedoor-test';
HomeKitDevice.PLATFORM_NAME = 'GarageDoorTest';
let identity = 0;

async function setup(t, options = {}, initial = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const values = new Map(Object.entries(initial).map(([pin, value]) => [Number(pin), value]));
  const writes = [];
  const failures = new Set();
  const closes = [];
  t.mock.method(GPIO, 'init', () => {});
  t.mock.method(GPIO, 'open', () => {});
  t.mock.method(GPIO, 'close', (pin) => closes.push(pin));
  t.mock.method(GPIO, 'read', (pin) => {
    if (failures.has(pin) === true) {
      throw new Error('Sensor read failed');
    }
    return values.get(pin) ?? GPIO.LOW;
  });
  t.mock.method(GPIO, 'write', (pin, value) => writes.push([pin, value]));
  class Accessory extends HAP.Accessory {
    async publish() {}
    async unpublish() {}
  }
  const door = new GarageDoor(
    undefined,
    { ...HAP, Accessory },
    {
      serialNumber: 'door-' + String(++identity),
      softwareVersion: 'test',
      manufacturer: 'Test',
      model: 'Test',
      description: 'Test Door',
      hkUsername: 'AA:BB:CC:DD:EE:FF',
      hkPairingCode: '031-45-154',
      pushButton: 16,
      openTime: 30,
      closeTime: 30,
      buttonBehavior: 'stop-then-reverse',
      ...options,
    },
  );
  t.mock.method(door, 'addTimer', () => {});
  assert.equal(await door.add({ hapAccessoryName: 'Test', hapCategory: HAP.Categories.GARAGE_DOOR_OPENER }), true);
  t.after(async () => {
    await door.shutdown();
    await door.remove();
  });
  const poll = () => door.message(HomeKitDevice.TIMER, { timer: GarageDoor.TIMER_DOOR_STATUS_POLL });
  const advance = async (milliseconds) => {
    t.mock.timers.tick(milliseconds);
    await setImmediate();
  };
  const command = async (target, pulses = 1) => {
    const pending = door.setDoorPosition(target);
    await setImmediate();
    for (let i = 0; i < pulses * 2 - 1; i++) {
      await advance(500);
    }
    await pending;
  };
  return { door, values, writes, failures, closes, poll, advance, command };
}

test('sensorless idle polling and completed trips preserve their resting state', async (t) => {
  const { door, poll, advance, command } = await setup(t);
  await advance(60000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.STOPPED);
  await command(HAP.Characteristic.TargetDoorState.OPEN);
  await advance(29999);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENING);
  await advance(1);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENED);
  await advance(60000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENED);
  await command(HAP.Characteristic.TargetDoorState.CLOSED);
  await advance(30000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.CLOSED);
  await advance(60000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.CLOSED);
});

test('physical endpoint departure is observed and completed sensor trips stay at rest', async (t) => {
  const { door, values, poll, advance } = await setup(t, { openSensor: 20, closedSensor: 26 }, { 26: GPIO.HIGH });
  values.set(26, GPIO.LOW);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENING);
  values.set(20, GPIO.HIGH);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENED);
  await advance(60000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENED);
});

test('the unsensed endpoint of a one-sensor installation does not invent a return trip', async (t) => {
  const { door, values, poll, advance, command } = await setup(t, { closedSensor: 26 }, { 26: GPIO.HIGH });
  await command(HAP.Characteristic.TargetDoorState.OPEN);
  values.set(26, GPIO.LOW);
  await advance(30000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENED);
  await advance(60000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENED);
});

test('same-target concurrent and sequential commands produce one pulse before polling', async (t) => {
  const { door, writes, advance } = await setup(t);
  const first = door.setDoorPosition(0);
  const second = door.setDoorPosition(0);
  await setImmediate();
  assert.deepEqual(writes, [[16, GPIO.HIGH]]);
  await advance(500);
  await Promise.all([first, second]);
  await door.setDoorPosition(0);
  assert.deepEqual(writes, [
    [16, GPIO.HIGH],
    [16, GPIO.LOW],
  ]);
});

test('a reversal receives a fresh timeout and two distinct relay pulses', async (t) => {
  const { door, writes, command, advance, poll } = await setup(t);
  await command(0);
  await advance(29000);
  await command(1, 2);
  assert.equal(writes.length, 6);
  await advance(1000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.CLOSING);
  await advance(29000);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.CLOSED);
});

test('an unreadable obstruction stays detected, blocks actuation, and recovers after a clear reading', async (t) => {
  const { door, failures, writes, values, poll, command } = await setup(t, { obstructionSensor: 21 }, { 21: GPIO.HIGH });
  failures.add(21);
  await poll();
  assert.equal(door.doorService.getCharacteristic(HAP.Characteristic.ObstructionDetected).value, true);
  assert.equal(door.getDoorPosition(), GarageDoor.FAULT);
  await assert.rejects(door.setDoorPosition(1));
  assert.equal(writes.length, 0);
  failures.clear();
  values.set(21, GPIO.LOW);
  await poll();
  await command(1);
  assert.equal(door.getDoorPosition(), GarageDoor.CLOSING);
});

test('position read failures and contradictory endpoints fault without pulsing', async (t) => {
  const { door, failures, values, writes, poll } = await setup(t, { openSensor: 20, closedSensor: 26 }, { 26: GPIO.HIGH });
  failures.add(20);
  await assert.rejects(door.setDoorPosition(0), /position sensors/);
  assert.equal(writes.length, 0);
  failures.clear();
  values.set(20, GPIO.HIGH);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.FAULT);
  await assert.rejects(door.setDoorPosition(0), /position sensors/);
});

test('relay activation failures reject, attempt release, and never report movement', async (t) => {
  const { door, writes } = await setup(t);
  t.mock.method(GPIO, 'write', (pin, value) => {
    writes.push([pin, value]);
    if (value === GPIO.HIGH) {
      throw new Error('Relay unavailable');
    }
  });
  await assert.rejects(door.setDoorPosition(0), /Relay unavailable/);
  assert.deepEqual(writes, [
    [16, GPIO.HIGH],
    [16, GPIO.LOW],
  ]);
  assert.equal(door.getDoorPosition(), GarageDoor.FAULT);
});

test('shutdown waits for relay release and later commands cannot actuate', async (t) => {
  const { door, writes, closes, advance } = await setup(t);
  const command = door.setDoorPosition(0);
  await setImmediate();
  const shutdown = door.shutdown();
  await setImmediate();
  assert.equal(closes.length, 0);
  await advance(500);
  await Promise.all([command, shutdown]);
  assert.deepEqual(writes, [
    [16, GPIO.HIGH],
    [16, GPIO.LOW],
  ]);
  assert.deepEqual(closes, [16]);
  await door.setDoorPosition(1);
  assert.equal(writes.length, 2);
});

test('shutdown reports GPIO close failures after attempting every configured pin', async (t) => {
  const { door, closes } = await setup(t, { closedSensor: 26, openSensor: 20, obstructionSensor: 21 });
  t.mock.method(GPIO, 'close', (pin) => {
    closes.push(pin);
    if (pin === 16) {
      throw new Error('Relay close failed');
    }
  });
  await assert.rejects(door.shutdown(), /Failed to release garage door GPIO pins/);
  assert.deepEqual(closes, [16, 26, 20, 21]);
});

test('polling before endpoint departure does not permit a duplicate command pulse', async (t) => {
  const { door, writes, poll, command } = await setup(t, { closedSensor: 26 }, { 26: GPIO.HIGH });
  await command(0);
  await poll();
  assert.equal(door.getDoorPosition(), GarageDoor.OPENING);
  await door.setDoorPosition(0);
  assert.equal(writes.length, 2);
});

test('an obstruction appearing between reversal pulses prevents the second pulse', async (t) => {
  const { door, writes, values, advance, command } = await setup(t, { obstructionSensor: 21 });
  await command(0);
  const reversing = door.setDoorPosition(1);
  const rejected = assert.rejects(reversing, /obstructed/);
  await setImmediate();
  await advance(500);
  values.set(21, GPIO.HIGH);
  await advance(500);
  await rejected;
  assert.equal(writes.length, 4);
  assert.equal(door.getDoorPosition(), GarageDoor.FAULT);
});

test('relay release failures reject instead of committing successful motion', async (t) => {
  const { door, advance } = await setup(t);
  t.mock.method(GPIO, 'write', (pin, value) => {
    if (value === GPIO.LOW) {
      throw new Error('Relay release failed');
    }
  });
  const rejected = assert.rejects(door.setDoorPosition(0), /Relay release failed/);
  await setImmediate();
  await advance(500);
  await rejected;
  assert.equal(door.getDoorPosition(), GarageDoor.FAULT);
  await assert.rejects(door.shutdown(), /Failed to release garage door GPIO pins/);
});

test('fresh endpoint readings prevent a stale resting state from ignoring CLOSE', async (t) => {
  const { door, values, writes, command } = await setup(t, { openSensor: 20, closedSensor: 26 }, { 26: GPIO.HIGH });
  values.set(26, GPIO.LOW);
  values.set(20, GPIO.HIGH);
  await command(1);
  assert.deepEqual(writes, [
    [16, GPIO.HIGH],
    [16, GPIO.LOW],
  ]);
  assert.equal(door.getDoorPosition(), GarageDoor.CLOSING);
});

test('arrival at an endpoint before polling uses one pulse instead of a reversal', async (t) => {
  const { door, values, writes, command } = await setup(t, { openSensor: 20, closedSensor: 26 }, { 26: GPIO.HIGH });
  await command(0);
  values.set(26, GPIO.LOW);
  values.set(20, GPIO.HIGH);
  await command(1);
  assert.equal(writes.length, 4);
  assert.equal(door.getDoorPosition(), GarageDoor.CLOSING);
});

test('a relay release fault stays latched until a release write succeeds', async (t) => {
  const { door, advance, poll, command } = await setup(t, { closedSensor: 26 }, { 26: GPIO.HIGH });
  let failRelease = true;
  let relayHigh = false;
  t.mock.method(GPIO, 'write', (pin, value) => {
    if (value === GPIO.LOW && failRelease === true) {
      throw new Error('Relay release failed');
    }
    relayHigh = value === GPIO.HIGH;
  });
  const rejected = assert.rejects(door.setDoorPosition(0), /Relay release failed/);
  await setImmediate();
  await advance(500);
  await rejected;
  await poll();
  assert.equal(relayHigh, true);
  assert.equal(door.getDoorPosition(), GarageDoor.FAULT);
  assert.equal(door.doorService.getCharacteristic(HAP.Characteristic.StatusFault).value, HAP.Characteristic.StatusFault.GENERAL_FAULT);
  await assert.rejects(door.setDoorPosition(0), /relay.*fault/);
  failRelease = false;
  await poll();
  assert.equal(relayHigh, false);
  assert.equal(door.getDoorPosition(), GarageDoor.CLOSED);
  await command(0);
  assert.equal(door.getDoorPosition(), GarageDoor.OPENING);
});
