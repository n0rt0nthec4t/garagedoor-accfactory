// Part of garagedoor-accfactory
// Mark Hulskamp
'use strict';

// Define external module requirements
import GPIO from 'rpio';

// Define nodejs module requirements
import { setTimeout, setInterval } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

// Define constants
const PUSHBUTTON_DELAY = 500;
const DOOR_STATUS_INTERVAL = 1000;

export default class GarageDoor extends HomeKitDevice {
  static TYPE = 'GarageDoor';
  static VERSION = '2025.06.22'; // Code version

  static DOOR_EVENT = 'DOOREVENT'; // Door status event tag

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
  #doorStatusTimer = undefined;

  constructor(accessory, api, log, deviceData) {
    super(accessory, api, log, deviceData);

    // Init the GPIO (rpio) library. This only needs to be done once before using library functions
    GPIO.init({ gpiomem: true, mapping: 'gpio' });

    this.currentDoorStatus = GarageDoor.STOPPED;
    this.#lastDoorStatus = GarageDoor.UNKNOWN;
  }

  // Class functions
  onAdd() {
    // Setup the garagedoor service if not already present on the accessory
    this.doorService = this.addHKService(this.hap.Service.GarageDoorOpener, '', 1);
    this.doorService.setPrimaryService();

    // Setup GPIO pins
    if (this.#validGPIOPin(this.deviceData?.pushButton) === false) {
      // Invalid pushbutton pin specified
      this?.log?.warn?.('No valid relay pin specifed for door open/close button on "%s"', this.deviceData.description);
      this?.log?.warn?.('We will be unable to operate garage door');
    }

    if (this.#validGPIOPin(this.deviceData?.pushButton) === true) {
      // Push button
      GPIO.open(this.deviceData.pushButton, GPIO.OUTPUT, GPIO.LOW);
      this?.log?.debug?.('Setup open/close relay on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.pushButton);
    }

    if (this.#validGPIOPin(this.deviceData?.closedSensor) === true) {
      // Door closed sensor
      GPIO.open(this.deviceData.closedSensor, GPIO.INPUT, GPIO.PULL_DOWN);
      this.postSetupDetail('Door closed sensor');
      this?.log?.debug?.('Setup closed door sensor on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.closedSensor);
    }

    if (this.#validGPIOPin(this.deviceData?.openSensor) === true) {
      // Door open sensor
      GPIO.open(this.deviceData.openSensor, GPIO.INPUT, GPIO.PULL_DOWN);
      this.postSetupDetail('Door open sensor');
      this?.log?.debug?.('Setup open door sensor on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.openSensor);
    }

    if (this.#validGPIOPin(this.deviceData?.obstructionSensor) === true) {
      // Door obstruction sensor
      GPIO.open(this.deviceData.obstructionSensor, GPIO.INPUT, GPIO.PULL_DOWN);
      this.postSetupDetail('Obstruction sensor');
      this?.log?.debug?.(
        'Setup obstruction sensor on "%s" using GPIO pin "%s"',
        this.deviceData.description,
        this.deviceData.obstructionSensor,
      );

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
      initialValue: this.hap.Characteristic.CurrentDoorState[initial.toUpperCase()],
      onGet: () => {
        let key = (this.getDoorPosition() || 'stopped').toUpperCase();
        return this.hap.Characteristic.CurrentDoorState[key] !== undefined
          ? this.hap.Characteristic.CurrentDoorState[key]
          : this.hap.Characteristic.CurrentDoorState.STOPPED;
      },
    });

    this.addHKCharacteristic(this.doorService, this.hap.Characteristic.TargetDoorState, {
      initialValue:
        initial === GarageDoor.OPENED ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED,
      onSet: (value) => {
        this.setDoorPosition(value);
      },
    });

    this.addHKCharacteristic(this.doorService, this.hap.Characteristic.StatusFault, {
      initialValue: this.hap.Characteristic.StatusFault.NO_FAULT,
    });

    // Setup linkage to EveHome app if configured todo so
    this.setupEveHomeLink(this.doorService);

    // Push initial state to HomeKit to prevent stale status
    this.message(GarageDoor.DOOR_EVENT, { status: this.currentDoorStatus });

    // Kick off polling loop
    this.#pollDoorStatus();
    this.#doorStatusTimer = setInterval(() => {
      this.#pollDoorStatus();
    }, DOOR_STATUS_INTERVAL);
  }

  setDoorPosition(position) {
    let target = position === this.hap.Characteristic.TargetDoorState.OPEN ? GarageDoor.OPEN : GarageDoor.CLOSE;

    if (this.currentDoorStatus === target) {
      this?.log?.debug?.('Door "%s" already %s', this.deviceData.description, target);
      return;
    }

    let behavior = typeof this.deviceData?.buttonBehavior === 'string' ? this.deviceData.buttonBehavior : 'stop-then-reverse';

    let isReversal =
      (this.currentDoorStatus === GarageDoor.OPENING && target === GarageDoor.CLOSE) ||
      (this.currentDoorStatus === GarageDoor.CLOSING && target === GarageDoor.OPEN);

    if (isReversal) {
      this?.log?.info?.('Reversing door "%s" from %s to %s', this.deviceData.description, this.currentDoorStatus, target);

      this.#lastMovementDirection = target;
      this.#lastDoorStatus = target === GarageDoor.OPEN ? GarageDoor.CLOSED : GarageDoor.OPENED;

      if (behavior === 'auto-reverse' || behavior === 'always-toggle') {
        this.pressButton(1);
      } else {
        this.pressButton(2); // stop, then reverse
      }
      return;
    }

    // Normal operation
    this.pressButton();
  }

  getDoorPosition() {
    return this.currentDoorStatus;
  }

  async pressButton(times = 1) {
    if (this.#validGPIOPin(this.deviceData?.pushButton) !== true) {
      return;
    }

    for (let i = 0; i < times; i++) {
      GPIO.write(this.deviceData.pushButton, GPIO.HIGH);
      await new Promise((resolve) => setTimeout(resolve, PUSHBUTTON_DELAY));
      GPIO.write(this.deviceData.pushButton, GPIO.LOW);

      if (i + 1 < times) {
        await new Promise((resolve) => setTimeout(resolve, PUSHBUTTON_DELAY));
      }
    }

    this?.log?.debug?.('Button pressed %d time(s) for Door "%s"', times, this.deviceData.description);
  }

  isOpen() {
    let openStatus = undefined;

    if (this.#validGPIOPin(this.deviceData?.openSensor) === true) {
      openStatus = GPIO.read(this.deviceData.openSensor) === GPIO.HIGH ? true : false; // If high on sensor, means door is opened
    }
    return openStatus;
  }

  isClosed() {
    let closeStatus = undefined;

    if (this.#validGPIOPin(this.deviceData?.closedSensor) === true) {
      closeStatus = GPIO.read(this.deviceData.closedSensor) === GPIO.HIGH ? true : false; // If high on sensor, means door is closed
    }
    return closeStatus;
  }

  hasObstruction() {
    let obstructionStatus = undefined;
    if (this.#validGPIOPin(this.deviceData?.obstructionSensor) === true) {
      obstructionStatus = GPIO.read(this.deviceData.obstructionSensor) === GPIO.HIGH ? true : false; // If high, obstruction detected
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
          this.addHistory(this.doorService, { status: 0 }, { timegap: 2 });
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
          this.addHistory(this.doorService, { status: 1 }, { timegap: 2 });
          this?.log?.warn?.('Door "%s" is open', this.deviceData.description);
        }
        return;
      }

      if (message.status === GarageDoor.MOVING) {
        let direction = message.direction;
        if (direction !== GarageDoor.OPENING && direction !== GarageDoor.CLOSING) {
          direction = GarageDoor.CLOSING;
        }

        if (this.currentDoorStatus !== direction) {
          this.currentDoorStatus = direction;
          this.#lastMovementDirection = direction;

          this.doorService.updateCharacteristic(
            this.hap.Characteristic.CurrentDoorState,
            this.hap.Characteristic.CurrentDoorState[direction.toUpperCase()],
          );

          this.doorService.updateCharacteristic(
            this.hap.Characteristic.TargetDoorState,
            this.hap.Characteristic.TargetDoorState[direction.toUpperCase() === 'OPENING' ? 'OPEN' : 'CLOSED'],
          );

          this?.log?.debug?.('Door "%s" is %s', this.deviceData.description, direction);
        }
        return;
      }

      if (state === GarageDoor.STOPPED) {
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);

        if (this.currentDoorStatus !== GarageDoor.STOPPED) {
          this.currentDoorStatus = GarageDoor.STOPPED;
          this.addHistory(this.doorService, { status: 1 }, { timegap: 2 });
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

  #pollDoorStatus() {
    // Check obstruction if canfigured up front sensor if defined
    if (this.#validGPIOPin(this.deviceData?.obstructionSensor) === true) {
      let obstructed = this.hasObstruction() === true;
      this.message(GarageDoor.DOOR_EVENT, {
        status: obstructed ? GarageDoor.OBSTRUCTION : GarageDoor.CLEAR,
      });
    }

    let doorClosed = this.isClosed() === true;
    let doorOpen = this.isOpen() === true;

    // Door is fully closed
    if (doorClosed === true && doorOpen === false) {
      if (this.currentDoorStatus !== GarageDoor.CLOSED) {
        this.#lastDoorStatus = GarageDoor.CLOSED;
        this.#lastMovementDirection = GarageDoor.OPENING;
        this.#moveStartedTime = undefined;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.CLOSED });
      }
      return;
    }

    // Door is fully open
    if (doorOpen === true && doorClosed === false) {
      if (this.currentDoorStatus !== GarageDoor.OPENED) {
        this.#lastDoorStatus = GarageDoor.OPENED;
        this.#lastMovementDirection = GarageDoor.CLOSING;
        this.#moveStartedTime = undefined;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.OPENED });
      }
      return;
    }

    // Door is moving (neither sensor triggered)
    if (this.#moveStartedTime === undefined) {
      this.#moveStartedTime = Date.now();
    }

    let duration = Date.now() - this.#moveStartedTime;
    let direction = GarageDoor.CLOSING;

    // Infer movement direction by *previous physical state*
    if (this.#lastDoorStatus === GarageDoor.CLOSED) {
      direction = GarageDoor.OPENING;
    } else if (this.#lastDoorStatus === GarageDoor.OPENED) {
      direction = GarageDoor.CLOSING;
    } else if (this.#lastMovementDirection === GarageDoor.OPENING) {
      direction = GarageDoor.OPENING;
    }

    // Timeout fallback if sensor fails to confirm status
    if (direction === GarageDoor.OPENING && this.isOpen() !== true && duration >= this.deviceData.openTime * 1000) {
      this.#lastDoorStatus = GarageDoor.OPENED;
      this.#lastMovementDirection = GarageDoor.CLOSING;
      this.#moveStartedTime = undefined;
      this?.log?.warn?.(
        'Door "%s" assumed open after %ds (open sensor not triggered)',
        this.deviceData.description,
        this.deviceData.openTime,
      );
      this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.OPENED });
      return;
    }

    if (direction === GarageDoor.CLOSING && this.isClosed() !== true && duration >= this.deviceData.closeTime * 1000) {
      this.#lastDoorStatus = GarageDoor.CLOSED;
      this.#lastMovementDirection = GarageDoor.OPENING;
      this.#moveStartedTime = undefined;
      this?.log?.warn?.(
        'Door "%s" assumed closed after %ds (closed sensor not triggered)',
        this.deviceData.description,
        this.deviceData.closeTime,
      );
      this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.CLOSED });
      return;
    }

    this.message(GarageDoor.DOOR_EVENT, {
      status: GarageDoor.MOVING,
      direction: direction,
      duration: duration,
    });
  }

  #validGPIOPin(pin) {
    return isNaN(pin) === false && Number(pin) >= GarageDoor.MIN_GPIO_PIN && Number(pin) <= GarageDoor.MAX_GPIO_PIN;
  }
}
