// GarageDoor
// Part of garagedoor-accfactory
//
// Handles HomeKit garage door integration using GPIO-connected
// relay outputs and optional door position sensors.
//
// Features:
// - HomeKit GarageDoorOpener service support
// - GPIO-controlled push button/relay activation
// - Optional open/closed end-stop sensors
// - Optional obstruction sensor support
// - Timed movement fallback for sensorless installations
// - Door movement direction inference and reversal handling
// - HomeKit status synchronisation and Eve history support
//
// Supports both:
// - Fully sensor-based installations
// - Timed-only installations using openTime/closeTime
//
// Lifecycle hooks used:
// - onAdd()
// - onMessage()
// - onTimer()
// - onShutdown()
//
// Note:
// - Timed-only installations cannot recover true physical door state after process restart
// - Sensor-based installations can still use timing as fallback for movement inference if desired
// - GPIO pin numbers must be specified in BCM mode (not physical pin numbers)
//
// Code version 2026.10.11
// Mark Hulskamp
'use strict';

// Define external module requirements
import GPIO from 'rpio';

// Define nodejs module requirements
import { setTimeout } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

// Define constants
const PUSHBUTTON_DELAY = 500;
const DOOR_STATUS_INTERVAL = 1000;

export default class GarageDoor extends HomeKitDevice {
  static TYPE = 'GarageDoor';
  static VERSION = '2026.10.10'; // Code version

  static DOOR_EVENT = 'door-event'; // Door status event tag
  static TIMER_DOOR_STATUS_POLL = 'door-status-poll'; // Timer handle for door status polling

  // Define door states
  static OPEN = 'open';
  static OPENED = 'opened';
  static CLOSE = 'close';
  static CLOSED = 'closed';
  static OPENING = 'opening';
  static CLOSING = 'closing';
  static STOPPED = 'stopped';
  static MOVING = 'moving';
  static OBSTRUCTION = 'obstruction';
  static CLEAR = 'clear';
  static UNKNOWN = 'unknown';
  static FAULT = 'fault';

  // GPIO pin min/max
  static MIN_GPIO_PIN = 0;
  static MAX_GPIO_PIN = 26;

  doorService = undefined; // HomeKit service for this garage door
  currentDoorStatus = undefined;

  // Internal data only for this class
  #lastMovementDirection = undefined; // Track last inferred direction (OPENING or CLOSING)
  #lastDoorStatus = undefined;
  #lastObstructionStatus = undefined;
  #moveStartedTime = undefined;
  #relayFault = false; // Retain output failures until a release write succeeds
  #motionActive = false; // Only time observed departures or successfully commanded movement
  #obstructionDetected = false;

  constructor(accessory, api, deviceData) {
    super(accessory, api, deviceData);

    // Init the GPIO (rpio) library. This only needs to be done once before using library functions
    GPIO.init({ gpiomem: true, mapping: 'gpio' });

    this.currentDoorStatus = GarageDoor.STOPPED;
    this.#lastDoorStatus = GarageDoor.UNKNOWN;
  }

  // Class functions
  async onAdd() {
    // Setup the garagedoor service if not already present on the accessory and link it to the Eve app if configured to do so
    this.doorService = this.addService(this.hap.Service.GarageDoorOpener, '', 1, {});
    this.doorService.setPrimaryService();

    // Setup GPIO pins
    if (this.#validGPIOPin(this.deviceData?.pushButton) === false) {
      // Invalid pushbutton pin specified
      this?.log?.warn?.('No valid relay pin specified for door open/close button on "%s"', this.deviceData.description);
      this?.log?.warn?.('We will be unable to operate garage door');
    }

    if (this.#validGPIOPin(this.deviceData?.pushButton) === true) {
      // Push button
      try {
        GPIO.open(this.deviceData.pushButton, GPIO.OUTPUT, GPIO.LOW);
        this?.log?.debug?.('Setup open/close relay on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.pushButton);
      } catch (error) {
        this?.log?.error?.('Failed to setup pushButton GPIO pin "%s": %s', this.deviceData.pushButton, String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.closedSensor) === true) {
      // Door closed sensor
      try {
        GPIO.open(this.deviceData.closedSensor, GPIO.INPUT, GPIO.PULL_DOWN);
        this.postSetupDetail('Door closed sensor');
        this?.log?.debug?.(
          'Setup closed door sensor on "%s" using GPIO pin "%s"',
          this.deviceData.description,
          this.deviceData.closedSensor,
        );
      } catch (error) {
        this?.log?.error?.('Failed to setup closedSensor GPIO pin "%s": %s', this.deviceData.closedSensor, String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.openSensor) === true) {
      // Door open sensor
      try {
        GPIO.open(this.deviceData.openSensor, GPIO.INPUT, GPIO.PULL_DOWN);
        this.postSetupDetail('Door open sensor');
        this?.log?.debug?.('Setup open door sensor on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.openSensor);
      } catch (error) {
        this?.log?.error?.('Failed to setup openSensor GPIO pin "%s": %s', this.deviceData.openSensor, String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.obstructionSensor) === true) {
      // Door obstruction sensor
      try {
        GPIO.open(this.deviceData.obstructionSensor, GPIO.INPUT, GPIO.PULL_DOWN);
        this.postSetupDetail('Obstruction sensor');
        this?.log?.debug?.(
          'Setup obstruction sensor on "%s" using GPIO pin "%s"',
          this.deviceData.description,
          this.deviceData.obstructionSensor,
        );
      } catch (error) {
        this?.log?.error?.('Failed to setup obstructionSensor GPIO pin "%s": %s', this.deviceData.obstructionSensor, String(error));
      }

      this.#obstructionDetected = this.hasObstruction() === true;

      this.addCharacteristic(this.doorService, this.hap.Characteristic.ObstructionDetected, {
        initialValue: this.#obstructionDetected === true,
      });
    }

    const doorClosed = this.isClosed();
    const doorOpen = this.isOpen();
    const obstruction = this.hasObstruction();
    let initial = GarageDoor.STOPPED;
    // Configured sensor failures must be visible before the accessory is published.
    if (
      this.#sensorReadFailed('closedSensor', doorClosed) === true ||
      this.#sensorReadFailed('openSensor', doorOpen) === true ||
      this.#sensorReadFailed('obstructionSensor', obstruction) === true ||
      (doorClosed === true && doorOpen === true)
    ) {
      initial = GarageDoor.FAULT;
    } else if (doorClosed === true) {
      initial = GarageDoor.CLOSED;
      this.postSetupDetail('Door is closed');
    } else if (doorOpen === true) {
      initial = GarageDoor.OPENED;
      this.postSetupDetail('Door is open');
    } else {
      this.postSetupDetail('Door is between opened/closed');
    }

    this.currentDoorStatus = initial;
    this.#lastDoorStatus = initial;

    // Setup characteristics
    this.addCharacteristic(this.doorService, this.hap.Characteristic.CurrentDoorState, {
      initialValue: this.#mapCurrentDoorState(initial),
      onGet: () => this.#mapCurrentDoorState(this.getDoorPosition()),
    });

    this.addCharacteristic(this.doorService, this.hap.Characteristic.TargetDoorState, {
      initialValue:
        initial === GarageDoor.OPENED ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED,
      onSet: async (value) => {
        await this.setDoorPosition(value);
      },
    });

    this.addCharacteristic(this.doorService, this.hap.Characteristic.StatusFault, {
      initialValue: this.hap.Characteristic.StatusFault.NO_FAULT,
    });

    // Push initial state to HomeKit to prevent stale status
    await this.message(GarageDoor.DOOR_EVENT, { status: this.currentDoorStatus });

    // Start periodic door status polling via parent class timer system
    this.addTimer(GarageDoor.TIMER_DOOR_STATUS_POLL, {
      delay: 0,
      interval: DOOR_STATUS_INTERVAL,
    });
  }

  setDoorPosition(position) {
    // Use the shared lifecycle queue so commands, polling, and shutdown cannot overlap GPIO work.
    return this.set({ targetDoorState: position });
  }

  async onSet(message) {
    if (Object.hasOwn(message, 'targetDoorState') === true) {
      await this.#setDoorPosition(message.targetDoorState);
    }
  }

  async #setDoorPosition(position) {
    if (position !== this.hap.Characteristic.TargetDoorState.OPEN && position !== this.hap.Characteristic.TargetDoorState.CLOSED) {
      throw new TypeError('Invalid target door state');
    }
    const opening = position === this.hap.Characteristic.TargetDoorState.OPEN;
    const direction = opening === true ? GarageDoor.OPENING : GarageDoor.CLOSING;
    const final = opening === true ? GarageDoor.OPENED : GarageDoor.CLOSED;
    const doorOpen = this.isOpen();
    const doorClosed = this.isClosed();
    if (
      this.#sensorReadFailed('openSensor', doorOpen) === true ||
      this.#sensorReadFailed('closedSensor', doorClosed) === true ||
      (doorOpen === true && doorClosed === true)
    ) {
      await this.#reportFault();
      throw new Error('Door position sensors are unavailable or contradictory');
    }
    if (this.#relayFault === true) {
      throw new Error('Door relay is reporting a fault');
    }
    // Fresh endpoints take precedence over cached state, except while awaiting departure from the starting endpoint.
    await this.#updateEndpoint(doorClosed, doorOpen);
    if (this.currentDoorStatus === GarageDoor.FAULT) {
      throw new Error('Door is reporting a fault');
    }
    await this.#checkObstruction();

    if (this.currentDoorStatus === final || (this.#motionActive === true && this.#lastMovementDirection === direction)) {
      return;
    }
    const reversing = this.#motionActive === true && this.#lastMovementDirection !== direction;
    const behavior = typeof this.deviceData.buttonBehavior === 'string' ? this.deviceData.buttonBehavior : 'stop-then-reverse';
    const presses = reversing === true && behavior === 'stop-then-reverse' ? 2 : 1;
    try {
      await this.#pressButton(presses);
    } catch (error) {
      // A partially executed reversal or failed relay pulse cannot establish a reliable movement state.
      await this.#reportFault();
      throw error;
    }
    this.#motionActive = true;
    this.#moveStartedTime = Date.now();
    this.#lastMovementDirection = direction;
    this.#lastDoorStatus = opening === true ? GarageDoor.CLOSED : GarageDoor.OPENED;
    await this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.MOVING, direction });
  }

  #sensorReadFailed(field, value) {
    return this.#validGPIOPin(this.deviceData[field]) === true && value === undefined;
  }

  async #checkObstruction() {
    const obstruction = this.hasObstruction();
    if (this.#sensorReadFailed('obstructionSensor', obstruction) === true) {
      await this.#reportFault();
      throw new Error('Obstruction sensor is unavailable');
    }
    if (obstruction === true || this.#obstructionDetected === true) {
      throw new Error('Door is obstructed');
    }
  }

  async #reportFault() {
    this.#motionActive = false;
    this.#moveStartedTime = undefined;
    this.#lastDoorStatus = GarageDoor.FAULT;
    this.#lastMovementDirection = undefined;
    await this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.FAULT });
  }

  getDoorPosition() {
    return this.currentDoorStatus;
  }

  isOpen() {
    let openStatus = undefined;

    if (this.#validGPIOPin(this.deviceData?.openSensor) === true) {
      try {
        openStatus = GPIO.read(this.deviceData.openSensor) === GPIO.HIGH;
      } catch (error) {
        this?.log?.warn?.('Error reading openSensor GPIO pin "%s": %s', this.deviceData.openSensor, String(error));
      }
    }
    return openStatus;
  }

  isClosed() {
    let closeStatus = undefined;

    if (this.#validGPIOPin(this.deviceData?.closedSensor) === true) {
      try {
        closeStatus = GPIO.read(this.deviceData.closedSensor) === GPIO.HIGH;
      } catch (error) {
        this?.log?.warn?.('Error reading closedSensor GPIO pin "%s": %s', this.deviceData.closedSensor, String(error));
      }
    }
    return closeStatus;
  }

  hasObstruction() {
    let obstructionStatus = undefined;
    if (this.#validGPIOPin(this.deviceData?.obstructionSensor) === true) {
      try {
        obstructionStatus = GPIO.read(this.deviceData.obstructionSensor) === GPIO.HIGH;
      } catch (error) {
        this?.log?.warn?.('Error reading obstructionSensor GPIO pin "%s": %s', this.deviceData.obstructionSensor, String(error));
      }
    }
    return obstructionStatus;
  }

  onMessage(type, message) {
    if (type === GarageDoor.DOOR_EVENT && typeof message?.status === 'string') {
      const state = message.status;

      if (state === GarageDoor.CLOSED) {
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.CLOSED);
        this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.TargetDoorState.CLOSED);

        if (this.currentDoorStatus !== GarageDoor.CLOSED) {
          this.currentDoorStatus = GarageDoor.CLOSED;
          this.history(this.doorService, { status: 0 }, { timegap: 2 });
          this?.log?.success?.('Door "%s" is closed', this.deviceData.description);
        }
        return;
      }

      if (state === GarageDoor.OPENED) {
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
        this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.TargetDoorState.OPEN);

        if (this.currentDoorStatus !== GarageDoor.OPENED) {
          this.currentDoorStatus = GarageDoor.OPENED;
          this.history(this.doorService, { status: 1 }, { timegap: 2 });
          this?.log?.warn?.('Door "%s" is open', this.deviceData.description);
        }
        return;
      }

      if (message.status === GarageDoor.MOVING) {
        let direction = message.direction;

        // Normalise direction
        if (direction !== GarageDoor.OPENING && direction !== GarageDoor.CLOSING) {
          direction = this.#lastMovementDirection;
        }
        if (direction !== GarageDoor.OPENING && direction !== GarageDoor.CLOSING) {
          direction = GarageDoor.CLOSING; // final fallback only if we truly have nothing
        }

        // Only log if direction changed
        let directionChanged = this.currentDoorStatus !== direction;

        // Even if internal state matches, it's usually worth pushing HK updates to avoid stale UI
        this.currentDoorStatus = direction;
        this.#lastMovementDirection = direction;

        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.#mapCurrentDoorState(direction));

        this.doorService.updateCharacteristic(
          this.hap.Characteristic.TargetDoorState,
          direction === GarageDoor.OPENING ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED,
        );

        if (directionChanged === true) {
          this?.log?.debug?.('Door "%s" is %s', this.deviceData.description, direction);
        }
        return;
      }

      if (state === GarageDoor.STOPPED) {
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);

        if (this.currentDoorStatus !== GarageDoor.STOPPED) {
          this.currentDoorStatus = GarageDoor.STOPPED;
          this.history(this.doorService, { status: 1 }, { timegap: 2 });
          this?.log?.debug?.('Door "%s" has stopped moving', this.deviceData.description);
        }
        return;
      }

      if (state === GarageDoor.FAULT) {
        this.currentDoorStatus = GarageDoor.FAULT;
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.GENERAL_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);
        this?.log?.error?.('Door "%s" is reporting a control or sensor fault', this.deviceData.description);
        return;
      }

      if (state === GarageDoor.OBSTRUCTION) {
        this.#obstructionDetected = true;
        this.doorService.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, true);

        if (this.#lastObstructionStatus === false) {
          this?.log?.warn?.('Door "%s" is reporting an obstruction', this.deviceData.description);
        }

        this.#lastObstructionStatus = true;
        return;
      }

      if (state === GarageDoor.CLEAR) {
        this.#obstructionDetected = false;
        this.doorService.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, false);

        if (this.#lastObstructionStatus === true) {
          this?.log?.success?.('Door "%s" obstruction has cleared', this.deviceData.description);
        }

        this.#lastObstructionStatus = false;
        return;
      }
    }
  }

  async onTimer(message) {
    // Handle timer events dispatched by the parent class timer system
    if (message?.timer === GarageDoor.TIMER_DOOR_STATUS_POLL) {
      await this.#pollDoorStatus();
    }
  }

  async onShutdown() {
    // Finish all pin cleanup attempts before surfacing failures to the application.
    const errors = [];
    if (this.#relayFault === true) {
      try {
        GPIO.write(this.deviceData.pushButton, GPIO.LOW);
        this.#relayFault = false;
      } catch (error) {
        errors.push(error);
        this?.log?.error?.('Failed to release relay during shutdown: %s', String(error));
      }
    }
    // Clean up GPIO pins on shutdown
    if (this.#validGPIOPin(this.deviceData?.pushButton) === true) {
      try {
        this?.log?.debug?.('Closing pushButton GPIO pin: %s', this.deviceData.pushButton);
        GPIO.close(this.deviceData.pushButton);
      } catch (error) {
        errors.push(error);
        this?.log?.debug?.('Error closing pushButton GPIO pin: %s', String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.closedSensor) === true) {
      try {
        this?.log?.debug?.('Closing closedSensor GPIO pin: %s', this.deviceData.closedSensor);
        GPIO.close(this.deviceData.closedSensor);
      } catch (error) {
        errors.push(error);
        this?.log?.debug?.('Error closing closedSensor GPIO pin: %s', String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.openSensor) === true) {
      try {
        this?.log?.debug?.('Closing openSensor GPIO pin: %s', this.deviceData.openSensor);
        GPIO.close(this.deviceData.openSensor);
      } catch (error) {
        errors.push(error);
        this?.log?.debug?.('Error closing openSensor GPIO pin: %s', String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.obstructionSensor) === true) {
      try {
        this?.log?.debug?.('Closing obstructionSensor GPIO pin: %s', this.deviceData.obstructionSensor);
        GPIO.close(this.deviceData.obstructionSensor);
      } catch (error) {
        errors.push(error);
        this?.log?.debug?.('Error closing obstructionSensor GPIO pin: %s', String(error));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to release garage door GPIO pins');
    }
  }

  async #updateEndpoint(doorClosed, doorOpen) {
    if (doorClosed === true || doorOpen === true) {
      const state = doorClosed === true ? GarageDoor.CLOSED : GarageDoor.OPENED;
      const opening = this.#lastMovementDirection === GarageDoor.OPENING;
      const target = opening === true ? GarageDoor.OPENED : GarageDoor.CLOSED;
      const timeout = opening === true ? this.deviceData.openTime : this.deviceData.closeTime;
      if (this.#motionActive === true && state !== target && Date.now() - this.#moveStartedTime < timeout * 1000) {
        // An opener can take time to leave its endpoint after the pulse; keep the command pending to avoid a second toggle.
        await this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.MOVING, direction: this.#lastMovementDirection });
        return true;
      }
      this.#motionActive = false;
      this.#moveStartedTime = undefined;
      this.#lastDoorStatus = state;
      this.#lastMovementDirection = undefined;
      await this.message(GarageDoor.DOOR_EVENT, { status: state });
      return true;
    }

    return false;
  }

  async #pollDoorStatus() {
    if (this.#relayFault === true) {
      // Position sensors cannot establish output health. Retry release before clearing a control fault.
      try {
        GPIO.write(this.deviceData.pushButton, GPIO.LOW);
        this.#relayFault = false;
      } catch (error) {
        this?.log?.error?.('Failed to release relay for "%s": %s', this.deviceData.description, String(error));
        await this.#reportFault();
        return;
      }
    }
    const obstruction = this.hasObstruction();
    const doorClosed = this.isClosed();
    const doorOpen = this.isOpen();

    // Missing optional sensors differ from configured sensors that could not be read.
    // Keep the previous obstruction visible until the configured sensor reports a clear reading.
    if (
      this.#sensorReadFailed('obstructionSensor', obstruction) === true ||
      this.#sensorReadFailed('closedSensor', doorClosed) === true ||
      this.#sensorReadFailed('openSensor', doorOpen) === true ||
      (doorClosed === true && doorOpen === true)
    ) {
      await this.#reportFault();
      return;
    }
    await this.message(GarageDoor.DOOR_EVENT, {
      status: obstruction === true ? GarageDoor.OBSTRUCTION : GarageDoor.CLEAR,
    });

    if ((await this.#updateEndpoint(doorClosed, doorOpen)) === true) {
      return;
    }

    if (this.currentDoorStatus === GarageDoor.FAULT) {
      this.#lastDoorStatus = GarageDoor.STOPPED;
      await this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.STOPPED });
    }

    if (this.#motionActive === false) {
      // Infer a physical-button trip only from the departure of an observed endpoint sensor.
      // A timed-only endpoint gives no evidence that another movement has started.
      if (this.#lastDoorStatus === GarageDoor.CLOSED && doorClosed === false) {
        this.#lastMovementDirection = GarageDoor.OPENING;
      } else if (this.#lastDoorStatus === GarageDoor.OPENED && doorOpen === false) {
        this.#lastMovementDirection = GarageDoor.CLOSING;
      } else {
        return;
      }
      this.#motionActive = true;
      this.#moveStartedTime = Date.now();
    }

    const direction = this.#lastMovementDirection;
    const duration = Date.now() - this.#moveStartedTime;
    const opening = direction === GarageDoor.OPENING;
    const timeout = opening === true ? this.deviceData.openTime : this.deviceData.closeTime;
    if (duration >= timeout * 1000) {
      const sensor = opening === true ? this.deviceData.openSensor : this.deviceData.closedSensor;
      const state = this.#validGPIOPin(sensor) === true ? GarageDoor.STOPPED : opening === true ? GarageDoor.OPENED : GarageDoor.CLOSED;
      this.#motionActive = false;
      this.#moveStartedTime = undefined;
      this.#lastMovementDirection = undefined;
      this.#lastDoorStatus = state;
      await this.message(GarageDoor.DOOR_EVENT, { status: state });
      return;
    }
    await this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.MOVING, direction, duration });
  }

  static isValidGPIOPin(pin) {
    // Preserve numeric-string configuration support without coercing empty or boolean values into GPIO 0.
    return (
      (typeof pin === 'number' || (typeof pin === 'string' && pin.trim() !== '')) &&
      Number.isInteger(Number(pin)) === true &&
      Number(pin) >= GarageDoor.MIN_GPIO_PIN &&
      Number(pin) <= GarageDoor.MAX_GPIO_PIN
    );
  }

  #validGPIOPin(pin) {
    return GarageDoor.isValidGPIOPin(pin);
  }

  #mapCurrentDoorState(state) {
    return state === GarageDoor.OPENED
      ? this.hap.Characteristic.CurrentDoorState.OPEN
      : state === GarageDoor.CLOSED
        ? this.hap.Characteristic.CurrentDoorState.CLOSED
        : state === GarageDoor.OPENING
          ? this.hap.Characteristic.CurrentDoorState.OPENING
          : state === GarageDoor.CLOSING
            ? this.hap.Characteristic.CurrentDoorState.CLOSING
            : this.hap.Characteristic.CurrentDoorState.STOPPED;
  }

  async #pressButton(times = 1) {
    if (this.#validGPIOPin(this.deviceData?.pushButton) !== true) {
      throw new Error('No valid relay pin configured');
    }

    for (let i = 0; i < times; i++) {
      try {
        // Recheck safety before each pulse, including the second pulse of a reversal.
        await this.#checkObstruction();
        try {
          try {
            GPIO.write(this.deviceData.pushButton, GPIO.HIGH);
            await new Promise((resolve) => setTimeout(resolve, PUSHBUTTON_DELAY));
          } finally {
            // Always attempt relay release, even if activation failed.
            GPIO.write(this.deviceData.pushButton, GPIO.LOW);
          }
        } catch (error) {
          this.#relayFault = true;
          throw error;
        }
      } catch (error) {
        this?.log?.error?.('Error writing to pushButton GPIO pin "%s": %s', this.deviceData.pushButton, String(error));
        throw error;
      }

      if (i + 1 < times) {
        await new Promise((resolve) => setTimeout(resolve, PUSHBUTTON_DELAY));
      }
    }

    this?.log?.debug?.('Button pressed %d time(s) for Door "%s"', times, this.deviceData.description);
  }
}
