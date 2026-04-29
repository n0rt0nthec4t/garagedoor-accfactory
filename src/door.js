// Part of garagedoor-accfactory
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
  static VERSION = '2026.04.28'; // Code version

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

  constructor(accessory, api, log, deviceData) {
    super(accessory, api, log, deviceData);

    // Init the GPIO (rpio) library. This only needs to be done once before using library functions
    GPIO.init({ gpiomem: true, mapping: 'gpio' });

    this.currentDoorStatus = GarageDoor.STOPPED;
    this.#lastDoorStatus = GarageDoor.UNKNOWN;
  }

  // Class functions
  onAdd() {
    // Setup the garagedoor service if not already present on the accessory and link it to the Eve app if configured to do so
    this.doorService = this.addHKService(this.hap.Service.GarageDoorOpener, '', 1, {});
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

      this.addHKCharacteristic(this.doorService, this.hap.Characteristic.ObstructionDetected, {
        initialValue: this.hasObstruction() === true,
      });
    }

    let initial = GarageDoor.STOPPED;

    // Infer physical initial state
    if (this.isClosed() === true) {
      initial = GarageDoor.CLOSED;
      this.#lastMovementDirection = GarageDoor.OPENING;
      this.postSetupDetail('Door is closed');
    }

    if (this.isClosed() !== true && this.isOpen() === true) {
      initial = GarageDoor.OPENED;
      this.#lastMovementDirection = GarageDoor.CLOSING;
      this.postSetupDetail('Door is open');
    }

    if (initial === GarageDoor.STOPPED) {
      this.#lastMovementDirection = GarageDoor.OPENING;
      this.postSetupDetail('Door is between opened/closed');
    }

    this.currentDoorStatus = initial;
    this.#lastDoorStatus = initial;

    // Setup characteristics
    this.addHKCharacteristic(this.doorService, this.hap.Characteristic.CurrentDoorState, {
      initialValue: this.#mapCurrentDoorState(initial),
      onGet: () => this.#mapCurrentDoorState(this.getDoorPosition()),
    });

    this.addHKCharacteristic(this.doorService, this.hap.Characteristic.TargetDoorState, {
      initialValue:
        initial === GarageDoor.OPENED ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED,
      onSet: async (value) => {
        await this.setDoorPosition(value);
      },
    });

    this.addHKCharacteristic(this.doorService, this.hap.Characteristic.StatusFault, {
      initialValue: this.hap.Characteristic.StatusFault.NO_FAULT,
    });

    // Push initial state to HomeKit to prevent stale status
    this.message(GarageDoor.DOOR_EVENT, { status: this.currentDoorStatus });

    // Start periodic door status polling via parent class timer system
    this.addTimer(GarageDoor.TIMER_DOOR_STATUS_POLL, {
      delay: 0,
      interval: DOOR_STATUS_INTERVAL,
    });
  }

  async setDoorPosition(position) {
    // Map HomeKit target to direction and final state
    let targetDir = position === this.hap.Characteristic.TargetDoorState.OPEN ? GarageDoor.OPEN : GarageDoor.CLOSE;
    let targetFinal = targetDir === GarageDoor.OPEN ? GarageDoor.OPENED : GarageDoor.CLOSED;
    let behavior = typeof this.deviceData?.buttonBehavior === 'string' ? this.deviceData.buttonBehavior : 'stop-then-reverse';

    // Already fully there, no action needed
    if (this.currentDoorStatus === targetFinal) {
      this?.log?.debug?.('Door "%s" already %s', this.deviceData.description, targetDir);
      return;
    }

    // Already moving toward requested direction, no actioned needed (prevents accidental STOP)
    if (
      (this.currentDoorStatus === GarageDoor.OPENING && targetDir === GarageDoor.OPEN) ||
      (this.currentDoorStatus === GarageDoor.CLOSING && targetDir === GarageDoor.CLOSE) ||
      (this.currentDoorStatus === GarageDoor.MOVING && this.#lastMovementDirection === targetDir)
    ) {
      this.#lastMovementDirection = targetDir;
      this?.log?.debug?.('Door "%s" already moving toward %s', this.deviceData.description, targetFinal);
      return;
    }

    // Moving the wrong way, reversal using configured behavior
    if (
      (this.currentDoorStatus === GarageDoor.OPENING && targetDir === GarageDoor.CLOSE) ||
      (this.currentDoorStatus === GarageDoor.CLOSING && targetDir === GarageDoor.OPEN) ||
      (this.currentDoorStatus === GarageDoor.MOVING && this.#lastMovementDirection && this.#lastMovementDirection !== targetDir)
    ) {
      this?.log?.info?.('Reversing door "%s" from %s to %s (%s)', this.deviceData.description, this.currentDoorStatus, targetDir, behavior);

      this.#lastMovementDirection = targetDir;
      this.#lastDoorStatus = targetFinal === GarageDoor.OPENED ? GarageDoor.CLOSED : GarageDoor.OPENED;

      if (behavior === 'auto-reverse' || behavior === 'always-toggle') {
        await this.#pressButton(1); // single press
      } else {
        await this.#pressButton(2); // stop-then-reverse: explicit double press
      }
      return;
    }

    // From STOPPED/UNKNOWN or resting opposite final state , set baseline then go
    if (
      this.currentDoorStatus === GarageDoor.STOPPED ||
      this.currentDoorStatus === GarageDoor.UNKNOWN ||
      this.currentDoorStatus === (targetFinal === GarageDoor.OPENED ? GarageDoor.CLOSED : GarageDoor.OPENED)
    ) {
      this.#lastMovementDirection = targetDir;
      this.#lastDoorStatus = targetFinal === GarageDoor.OPENED ? GarageDoor.CLOSED : GarageDoor.OPENED;
      this?.log?.debug?.('Starting door "%s" toward %s', this.deviceData.description, targetFinal);
      await this.#pressButton(1);
      return;
    }

    // Unsafe/blocked states → do not actuate
    if (this.currentDoorStatus === GarageDoor.OBSTRUCTION || this.currentDoorStatus === GarageDoor.FAULT) {
      this?.log?.warn?.('Door "%s" is %s; ignoring setDoorPosition(%s)', this.deviceData.description, this.currentDoorStatus, targetDir);
      return;
    }

    // Fallback: press once toward desired state
    this.#lastMovementDirection = targetDir;
    this.#lastDoorStatus = targetFinal === GarageDoor.OPENED ? GarageDoor.CLOSED : GarageDoor.OPENED;
    await this.#pressButton(1);
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
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.GENERAL_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);
        this?.log?.error?.('Door "%s" is reporting fault with sensors', this.deviceData.description);
        return;
      }

      if (state === GarageDoor.OBSTRUCTION) {
        this.doorService.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, true);

        if (this.#lastObstructionStatus === false) {
          this?.log?.warn?.('Door "%s" is reporting an obstruction', this.deviceData.description);
        }

        this.#lastObstructionStatus = true;
        return;
      }

      if (state === GarageDoor.CLEAR) {
        this.doorService.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, false);

        if (this.#lastObstructionStatus === true) {
          this?.log?.success?.('Door "%s" obstruction cleared', this.deviceData.description);
        }

        this.#lastObstructionStatus = false;
        return;
      }
    }
  }

  async onTimer(message) {
    // Handle timer events dispatched by the parent class timer system
    if (message?.timer === GarageDoor.TIMER_DOOR_STATUS_POLL) {
      this.#pollDoorStatus();
    }
  }

  async onShutdown() {
    // Clean up GPIO pins on shutdown
    if (this.#validGPIOPin(this.deviceData?.pushButton) === true) {
      try {
        this?.log?.debug?.('Closing pushButton GPIO pin: %s', this.deviceData.pushButton);
        GPIO.close(this.deviceData.pushButton);
      } catch (error) {
        this?.log?.debug?.('Error closing pushButton GPIO pin: %s', String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.closedSensor) === true) {
      try {
        this?.log?.debug?.('Closing closedSensor GPIO pin: %s', this.deviceData.closedSensor);
        GPIO.close(this.deviceData.closedSensor);
      } catch (error) {
        this?.log?.debug?.('Error closing closedSensor GPIO pin: %s', String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.openSensor) === true) {
      try {
        this?.log?.debug?.('Closing openSensor GPIO pin: %s', this.deviceData.openSensor);
        GPIO.close(this.deviceData.openSensor);
      } catch (error) {
        this?.log?.debug?.('Error closing openSensor GPIO pin: %s', String(error));
      }
    }

    if (this.#validGPIOPin(this.deviceData?.obstructionSensor) === true) {
      try {
        this?.log?.debug?.('Closing obstructionSensor GPIO pin: %s', this.deviceData.obstructionSensor);
        GPIO.close(this.deviceData.obstructionSensor);
      } catch (error) {
        this?.log?.debug?.('Error closing obstructionSensor GPIO pin: %s', String(error));
      }
    }
  }

  #pollDoorStatus() {
    // Check obstruction sensor
    this.message(GarageDoor.DOOR_EVENT, {
      status: this.hasObstruction() === true ? GarageDoor.OBSTRUCTION : GarageDoor.CLEAR,
    });

    let doorClosed = this.isClosed() === true;
    let doorOpen = this.isOpen() === true;

    // Fully closed
    if (doorClosed === true && doorOpen === false) {
      if (this.currentDoorStatus !== GarageDoor.CLOSED) {
        this.#lastDoorStatus = GarageDoor.CLOSED;
        this.#lastMovementDirection = GarageDoor.OPENING;
        this.#moveStartedTime = undefined;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.CLOSED });
      }
      return;
    }

    // Fully open
    if (doorOpen === true && doorClosed === false) {
      if (this.currentDoorStatus !== GarageDoor.OPENED) {
        this.#lastDoorStatus = GarageDoor.OPENED;
        this.#lastMovementDirection = GarageDoor.CLOSING;
        this.#moveStartedTime = undefined;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.OPENED });
      }
      return;
    }

    // Door in motion or mid-way
    if (this.#moveStartedTime === undefined) {
      this.#moveStartedTime = Date.now();
    }

    // If previously STOPPED, suppress further direction inference until next change
    if (this.#lastDoorStatus === GarageDoor.STOPPED) {
      return;
    }

    let duration = Date.now() - this.#moveStartedTime;
    let direction = GarageDoor.CLOSING;

    // Infer direction
    if (this.#lastDoorStatus === GarageDoor.CLOSED) {
      direction = GarageDoor.OPENING;
    }
    if (this.#lastDoorStatus === GarageDoor.OPENED) {
      direction = GarageDoor.CLOSING;
    }
    if (this.#lastMovementDirection === GarageDoor.OPENING) {
      direction = GarageDoor.OPENING;
    }

    // Timeout fallback for OPENING
    if (direction === GarageDoor.OPENING && duration >= this.deviceData.openTime * 1000) {
      this.#moveStartedTime = undefined;

      if (doorOpen === true && doorClosed === false) {
        this.#lastDoorStatus = GarageDoor.OPENED;
        this.#lastMovementDirection = GarageDoor.CLOSING;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.OPENED });
      } else {
        this?.log?.warn?.(
          'Door "%s" stopped before open sensor triggered (timeout %ds)',
          this.deviceData.description,
          this.deviceData.openTime,
        );
        this.#lastDoorStatus = GarageDoor.STOPPED;
        this.#lastMovementDirection = undefined;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.STOPPED });
      }
      return;
    }

    // Timeout fallback for CLOSING
    if (direction === GarageDoor.CLOSING && duration >= this.deviceData.closeTime * 1000) {
      this.#moveStartedTime = undefined;

      if (doorClosed === true && doorOpen === false) {
        this.#lastDoorStatus = GarageDoor.CLOSED;
        this.#lastMovementDirection = GarageDoor.OPENING;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.CLOSED });
      } else {
        this?.log?.warn?.(
          'Door "%s" stopped before closed sensor triggered (timeout %ds)',
          this.deviceData.description,
          this.deviceData.closeTime,
        );
        this.#lastDoorStatus = GarageDoor.STOPPED;
        this.#lastMovementDirection = undefined;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.STOPPED });
      }
      return;
    }

    // Door has since stabilized (late sensor update)
    if (doorOpen === true && doorClosed === false) {
      if (this.currentDoorStatus !== GarageDoor.OPENED) {
        this.#lastDoorStatus = GarageDoor.OPENED;
        this.#lastMovementDirection = GarageDoor.CLOSING;
        this.#moveStartedTime = undefined;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.OPENED });
      }
      return;
    }

    if (doorClosed === true && doorOpen === false) {
      if (this.currentDoorStatus !== GarageDoor.CLOSED) {
        this.#lastDoorStatus = GarageDoor.CLOSED;
        this.#lastMovementDirection = GarageDoor.OPENING;
        this.#moveStartedTime = undefined;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.CLOSED });
      }
      return;
    }

    // Still in motion
    this.message(GarageDoor.DOOR_EVENT, {
      status: GarageDoor.MOVING,
      direction: direction,
      duration: duration,
    });
  }

  #validGPIOPin(pin) {
    return Number.isFinite(Number(pin)) === true && Number(pin) >= GarageDoor.MIN_GPIO_PIN && Number(pin) <= GarageDoor.MAX_GPIO_PIN;
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
      return;
    }

    for (let i = 0; i < times; i++) {
      try {
        GPIO.write(this.deviceData.pushButton, GPIO.HIGH);
        await new Promise((resolve) => setTimeout(resolve, PUSHBUTTON_DELAY));
        GPIO.write(this.deviceData.pushButton, GPIO.LOW);
      } catch (error) {
        this?.log?.error?.('Error writing to pushButton GPIO pin "%s": %s', this.deviceData.pushButton, String(error));
        return;
      }

      if (i + 1 < times) {
        await new Promise((resolve) => setTimeout(resolve, PUSHBUTTON_DELAY));
      }
    }

    this?.log?.debug?.('Button pressed %d time(s) for Door "%s"', times, this.deviceData.description);
  }
}
