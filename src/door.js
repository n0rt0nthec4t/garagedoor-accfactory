// Part of garagedoor-accfactory
// Mark Hulskamp
'use strict';

// Define external module requirements
import GPIO from 'rpio';

// Define nodejs module requirements
import { setTimeout } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

export default class GarageDoor extends HomeKitDevice {
  static TYPE = 'GarageDoor';
  static VERSION = '2025.06.18'; // Code version

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
  static UNKNOWN = 'unknown';
  static FAULT = 'fault';

  // GPIO pin min/max
  static MIN_GPIO_PIN = 0;
  static MAX_GPIO_PIN = 26;

  doorService = undefined; // HomeKit service for this garage door
  currentDoorStatus = undefined;

  // Internal data only for this class
  #lastDoorStatus = undefined;
  #moveStartedTime = undefined;

  constructor(accessory, api, log, deviceData) {
    super(accessory, api, log, deviceData);

    // Init the GPIO (rpio) library. This only needs to be done once before using library functions
    GPIO.init({ gpiomem: true });
    GPIO.init({ mapping: 'gpio' });

    this.currentDoorStatus = GarageDoor.STOPPED;
    this.#lastDoorStatus = GarageDoor.UNKNOWN;
  }

  // Class functions
  onAdd() {
    // Setup the garagedoor service if not already present on the accessory
    this.doorService = this.addHKService(this.hap.Service.GarageDoorOpener, '', 1);
    this.doorService.setPrimaryService();
    this.addHKCharacteristic(this.doorService, this.hap.Characteristic.StatusFault);

    // Setup intial characteristic values
    this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
    this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);

    // Setup GPIO pins
    if (
      isNaN(this.deviceData?.pushButton) === true ||
      (Number(this.deviceData.pushButton) < GarageDoor.MIN_GPIO_PIN && Number(this.deviceData.pushButton > GarageDoor.MAX_GPIO_PIN))
    ) {
      this?.log?.warn?.('No relay valid pin specifed for door open/close button on "%s"', this.deviceData.description);
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
      this?.log?.debug?.('Setup obstruction sensor on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.openSensor);
    }

    // Setup callbacks for characteristics
    this.addHKCharacteristic(this.doorService, this.hap.Characteristic.TargetDoorState, {
      onSet: (value) => {
        this.setDoorPosition(value);
      },
    });
    this.addHKCharacteristic(this.doorService, this.hap.Characteristic.CurrentDoorState, {
      onGet: () => {
        let status = this.getDoorPosition();
        // Convert our internal string status into the HomeKit number value
        return this.hap.Characteristic.CurrentDoorState[status.toUpperCase()];
      },
    });

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      this.doorService !== undefined &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.doorService, {
        description: this.deviceData.description,
      });
    }
  }

  setDoorPosition(value) {
    // Set position of the door. (will either be open or closed)
    if ((value === this.hap.Characteristic.TargetDoorState.CLOSED || value === GarageDoor.CLOSE) && this.isClosed() === false) {
      if (this.currentDoorStatus === GarageDoor.OPENING) {
        // Since door is "moving", press button to stop. Second press below will close ie: reverse
        this.pressButton();
        this.currentDoorStatus = GarageDoor.STOPPED;
        this.#lastDoorStatus = GarageDoor.OPENING;
      }
      // "Press" garage opener/closer button, and update HomeKit status to show door moving.
      // the poll function will update to the closed status when sensor triggered
      this.pressButton();
    }
    if ((value === this.hap.Characteristic.TargetDoorState.OPEN || value === GarageDoor.OPEN) && this.isOpen() === false) {
      if (this.currentDoorStatus === GarageDoor.CLOSING) {
        // Since door is "moving", press button to stop. Second press below will close ie: reverse
        this.pressButton();
        this.currentDoorStatus = GarageDoor.STOPPED;
        this.#lastDoorStatus = GarageDoor.CLOSING;
      }
      // "Press" garage opener/closer button, and update HomeKit status to show door moving.
      // the poll function will update to the open status when sensor triggered
      this.pressButton();
    }
  }

  getDoorPosition() {
    return this.currentDoorStatus;
  }

  pressButton() {
    if (this.#validGPIOPin(this.deviceData?.pushButton) === false) {
      return;
    }

    // Simulate pressing the controller button
    // Write high out first to trigger relay, then wait defined millisecond period and put back to low to untrigger
    GPIO.write(this.deviceData.pushButton, GPIO.HIGH);
    GPIO.msleep(500);
    GPIO.write(this.deviceData.pushButton, GPIO.LOW);
    GPIO.msleep(500);

    this?.log?.debug?.('Button pressed for Door "%s"', this.deviceData.description);
  }

  isOpen() {
    if (this.#validGPIOPin(this.deviceData?.openSensor) === false) {
      return;
    }

    return GPIO.read(this.deviceData.openSensor) === GPIO.HIGH ? true : false; // If high on sensor, means door is opened
  }

  isClosed() {
    if (this.#validGPIOPin(this.deviceData?.closedSensor) === false) {
      return;
    }

    return GPIO.read(this.deviceData.closedSensor) === GPIO.HIGH ? true : false; // If high on sensor, means door is closed
  }

  hasObstruction() {
    if (this.#validGPIOPin(this.deviceData?.obstructionSensor) === false) {
      return;
    }

    return GPIO.read(this.deviceData.obstructionSensor) === GPIO.HIGH ? true : false; // If high, obstruction detected
  }

  onMessage(type, message) {
    if (type === GarageDoor.DOOR_EVENT && typeof message?.status === 'string') {
      if (message.status === GarageDoor.CLOSED && this.currentDoorStatus !== GarageDoor.CLOSED) {
        // Closed
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.CLOSED);
        this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.CLOSED);
        this.currentDoorStatus = GarageDoor.CLOSED;

        if (typeof this.historyService?.addHistory === 'function' && this.doorService !== undefined) {
          // Log door closed to history service if present
          let tempEntry = this.historyService.lastHistory(this.doorService);
          if (tempEntry?.status !== 0) {
            this.historyService.addHistory(this.doorService, { time: Math.floor(Date.now() / 1000), status: 0 }); // closed
          }
        }
        this?.log?.success?.('Door "%s" is closed', this.deviceData.description);
      }

      if (message.status === GarageDoor.OPENED && this.currentDoorStatus !== GarageDoor.OPENED) {
        // Open
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
        this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
        this.currentDoorStatus = GarageDoor.OPENED;

        if (typeof this.historyService?.addHistory === 'function' && this.doorService !== undefined) {
          // Log door opened to history service if present
          let tempEntry = this.historyService.lastHistory(this.doorService);
          if (tempEntry?.status !== 1) {
            this.historyService.addHistory(this.doorService, { time: Math.floor(Date.now() / 1000), status: 1 }); // open
          }
        }
        this?.log?.warn?.('Door "%s" is open', this.deviceData.description);
      }

      if (message.status === GarageDoor.MOVING) {
        // Moving
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        if (message.last === GarageDoor.CLOSED && this.currentDoorStatus !== GarageDoor.OPENING) {
          // Since door was last closed, and now its moving, assume its opening
          this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.OPENING);
          this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
          this.currentDoorStatus = GarageDoor.OPENING;
          this?.log?.debug?.('Door "%s" is opening', this.deviceData.description);
        }
        if (message.last === GarageDoor.OPENED && this.currentDoorStatus !== GarageDoor.CLOSING) {
          // Since door was last open, and now its moving, assume its closing
          this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.CLOSING);
          this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.CLOSED);
          this.currentDoorStatus = GarageDoor.CLOSING;
          this?.log?.debug?.('Door "%s" is closing', this.deviceData.description);
        }
      }

      if (message.status === GarageDoor.STOPPED) {
        // Stopped
        if (this.currentDoorStatus !== GarageDoor.STOPPED) {
          this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
          this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);
          this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
          this.currentDoorStatus = GarageDoor.STOPPED;

          if (typeof this.historyService?.addHistory === 'function' && this.doorService !== undefined) {
            // Log door opened to history service if present
            let tempEntry = this.historyService.lastHistory(this.doorService);
            if (tempEntry?.status !== 1) {
              this.historyService.addHistory(this.doorService, { time: Math.floor(Date.now() / 1000), status: 1 }); // open
            }
          }
          this?.log?.debug?.('Door "%s" has stopped moving', this.deviceData.description);
        }
      }

      if (message.status === GarageDoor.FAULT) {
        // Faulty sensors
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.GENERAL_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);
        // What should current door status be???
        this?.log?.error?.('Door "%s" is reporting fault with sensors', this.deviceData.description);
      }

      if (message.status === GarageDoor.OBSTRUCTION || message.status === 'clear') {
        // Door obstruction, either active or cleared
        this.doorService.updateCharacteristic(
          this.hap.Characteristic.ObstructionDetected,
          message.status === GarageDoor.OBSTRUCTION ? true : false,
        );
        this?.log?.warn?.('Door "%s" is reporting an obstruction', this.deviceData.description);
        // <---- Implement. Do we stop door from being closed if obstructed? or just allow to open?? or not allow movement at all?
      }
    }
  }

  onUpdate(deviceData) {
    let doorOpen = this.isOpen();
    let doorClosed = this.isClosed();
    let obstruction = this.hasObstruction();

    // Work out the current status of the door using configured sensors.
    // This will either be "open", "closed", "moving", "stopped"
    // We'll send a message about its status once determined
    if (doorClosed === true && doorOpen === false) {
      // Door is fully closed
      this.#moveStartedTime = undefined;
      this.#lastDoorStatus = GarageDoor.CLOSED;
      this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.CLOSED });
    }

    if (doorClosed === false && doorOpen === true) {
      // Door is fully open
      this.#moveStartedTime = undefined;
      this.#lastDoorStatus = GarageDoor.OPENED;
      this.message(this.uuid, GarageDoor.DOOR_EVENT, { status: GarageDoor.OPENED });
    }

    if (doorClosed === false && doorOpen === false) {
      // Door is neither open or closed, so door is either moving or stopped.
      if (this.#moveStartedTime === undefined) {
        this.#moveStartedTime = Date.now(); // Time we detected first movement from either open or closed

        if (this.#lastDoorStatus === GarageDoor.STOPPED) {
          // Detected movement after stopped state, ie: we've pressed the push button
          // Stopped state is assumed to be door open, as neither detected open or closed
          this.#lastDoorStatus = this.currentDoorStatus;
        }
      }

      // Reset timer if direction reversed during movement
      if (
        (this.#lastDoorStatus === GarageDoor.OPENING && this.currentDoorStatus === GarageDoor.CLOSING) ||
        (this.#lastDoorStatus === GarageDoor.CLOSING && this.currentDoorStatus === GarageDoor.OPENING)
      ) {
        this.#moveStartedTime = Date.now();
        this.#lastDoorStatus = this.currentDoorStatus;
      }

      let duration = Math.floor(Date.now()) - (this.#moveStartedTime !== undefined ? this.#moveStartedTime : 0);
      if (
        this.#lastDoorStatus === GarageDoor.UNKNOWN ||
        this.#lastDoorStatus === GarageDoor.STOPPED ||
        (this.#lastDoorStatus === GarageDoor.OPENED && duration > deviceData.closeTime * 1000) ||
        (this.#lastDoorStatus === GarageDoor.CLOSED && duration > deviceData.openTime * 1000)
      ) {
        // Since the door state isn't open or closed OR open or closed status and moving time has been exceeded for configured times
        // In this case we'll assume door has stopped
        this.#lastDoorStatus = GarageDoor.STOPPED;
        this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.STOPPED });
      } else {
        this.message(GarageDoor.DOOR_EVENT, {
          status: GarageDoor.MOVING,
          last: this.#lastDoorStatus,
          duration: duration,
        });
      }
    }

    if ((doorClosed === true && doorOpen === true) || doorClosed === undefined || doorOpen === undefined) {
      // Is reading both open and close OR no status, we'll assume fault with sensors
      this.message(GarageDoor.DOOR_EVENT, { status: GarageDoor.FAULT, last: this.#lastDoorStatus });
    }

    if (obstruction !== undefined) {
      // Since obstruction didn't return an undefined value, this means we have a configured obstruction sensor and its returned its status
      this.message(GarageDoor.DOOR_EVENT, { status: obstruction === true ? GarageDoor.OBSTRUCTION : 'clear' });
    }

    // Perform this again after a short period by issuing an device update message
    // The onUpdate function will only be called again from this message if some data has changed
    // We can force this by adding a "timestamp" field to the data object
    setTimeout(() => {
      this.message(HomeKitDevice.UPDATE, { lastDoorCheckTime: Date.now() });
    }, 1000);
  }

  #validGPIOPin(pin) {
    return isNaN(pin) === false && Number(pin) >= GarageDoor.MIN_GPIO_PIN && Number(pin) <= GarageDoor.MAX_GPIO_PIN;
  }
}
