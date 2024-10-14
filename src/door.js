// Code version 15/10/2024
// Mark Hulskamp
'use strict';

// Define external module requirements
import GPIO from 'rpio';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { setTimeout } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

export default class GarageDoor extends HomeKitDevice {
  static DOOREVENT = 'DOOREVENT'; // Door status event tag

  doorService = undefined; // HomeKit service for this garage door
  currentDoorStatus = undefined;

  // Internal data only for this class
  #eventEmitter = undefined;
  #lastDoorStatus = undefined;
  #moveStartedTime = undefined;

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);

    // Init the GPIO (rpio) library. This only needs to be done once before using library functions
    GPIO.init({ gpiomem: true });
    GPIO.init({ mapping: 'gpio' });

    // Validate if eventEmitter object passed to us is an instance of EventEmitter
    if (eventEmitter instanceof EventEmitter === true) {
      this.#eventEmitter = eventEmitter;
    }

    this.currentDoorStatus = 'stopped';
    this.#lastDoorStatus = 'unknown';
  }

  // Class functions
  addServices() {
    // Create extra details for output
    let postSetupDetails = [];

    // Setup the garagedoor service if not already present on the accessory
    this.doorService = this.accessory.getService(this.hap.Service.GarageDoorOpener);
    if (this.doorService === undefined) {
      this.doorService = this.accessory.addService(this.hap.Service.GarageDoorOpener, '', 1);
    }
    if (this.doorService.testCharacteristic(this.hap.Characteristic.StatusFault) === false) {
      // Used if the sensors report incorrect readings, such as both "high"
      this.doorService.addCharacteristic(this.hap.Characteristic.StatusFault);
    }
    this.doorService.setPrimaryService();

    // Setup intial characteristic values
    this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
    this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);

    // Setup GPIO pins
    if (this.deviceData.pushButton === undefined || (this.deviceData.pushButton < 0 && this.deviceData.pushButton > 26)) {
      this?.log?.warn && this.log.warn('No relay valid pin specifed for door open/close button on "%s"', this.deviceData.description);
      this?.log?.warn && this.log.warn('We will be unable to operated garage door');
    }

    if (this.deviceData.pushButton !== undefined && this.deviceData.pushButton >= 0 && this.deviceData.pushButton <= 26) {
      // Push button
      GPIO.open(this.deviceData.pushButton, GPIO.OUTPUT, GPIO.LOW);
      this?.log?.debug &&
        this.log.debug('Setup open/close relay on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.pushButton);
    }

    if (this.deviceData.closedSensor !== undefined && this.deviceData.closedSensor >= 0 && this.deviceData.closedSensor <= 26) {
      // Door closed sensor
      GPIO.open(this.deviceData.closedSensor, GPIO.INPUT, GPIO.PULL_DOWN);
      postSetupDetails.push('Door closed sensor');
      this?.log?.debug &&
        this.log.debug('Setup closed door sensor on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.closedSensor);
    }
    if (this.deviceData.openSensor !== undefined && this.deviceData.openSensor >= 0 && this.deviceData.openSensor <= 26) {
      // Door open sensor
      GPIO.open(this.deviceData.openSensor, GPIO.INPUT, GPIO.PULL_DOWN);
      postSetupDetails.push('Door open sensor');
      this?.log?.debug &&
        this.log.debug('Setup open door sensor on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.openSensor);
    }

    if (
      this.deviceData.obstructionSensor !== undefined &&
      this.deviceData.obstructionSensor >= 0 &&
      this.deviceData.obstructionSensor <= 26
    ) {
      // Door obstruction sensor
      GPIO.open(this.deviceData.obstructionSensor, GPIO.INPUT, GPIO.PULL_DOWN);
      postSetupDetails.push('Obstruction sensor');
      this?.log?.debug &&
        this.log.debug('Setup obstruction sensor on "%s" using GPIO pin "%s"', this.deviceData.description, this.deviceData.openSensor);
    }

    // Setup callbacks for characteristics
    this.doorService.getCharacteristic(this.hap.Characteristic.TargetDoorState).onSet((value) => {
      this.setDoorPosition(value);
    });
    this.doorService.getCharacteristic(this.hap.Characteristic.CurrentDoorState).onGet(() => {
      let status = this.getDoorPosition();
      // Convert our internal string status into the HomeKit number value
      return this.hap.Characteristic.CurrentDoorState[status.toUpperCase()];
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

    return postSetupDetails;
  }

  setDoorPosition(value) {
    // Set position of the door. (will either be open or closed)
    if ((value === this.hap.Characteristic.TargetDoorState.CLOSED || value === 'close') && this.isClosed() === false) {
      if (this.currentDoorState === 'opening') {
        // Since door is "moving", press button to stop. Second press below will close ie: reverse
        this.pressButton();
        this.#lastDoorStatus = 'stopped';
      }
      // "Press" garage opener/closer button, and update HomeKit status to show door moving.
      // the poll function will update to the closed status when sensor triggered
      this.pressButton();
    }
    if ((value === this.hap.Characteristic.TargetDoorState.OPEN || value === 'open') && this.isOpen() === false) {
      if (this.currentDoorState === 'closing') {
        // Since door is "moving", press button to stop. Second press below will close ie: reverse
        this.pressButton();
        this.#lastDoorStatus = 'stopped';
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
    if (this.deviceData.pushButton === undefined) {
      return;
    }

    // Simulate pressing the controller button
    // Write high out first to trigger relay, then wait defined millisecond period and put back to low to untrigger
    GPIO.write(this.deviceData.pushButton, GPIO.HIGH);
    GPIO.msleep(500);
    GPIO.write(this.deviceData.pushButton, GPIO.LOW);
    GPIO.msleep(500);
  }

  isOpen(openSensor) {
    if (this.deviceData.openSensor === undefined && openSensor === undefined) {
      return;
    }

    if (openSensor === undefined && this.deviceData.openSensor !== undefined) {
      openSensor = this.deviceData.openSensor;
    }
    return GPIO.read(openSensor) === GPIO.HIGH ? true : false; // If high on sensor, means door is opened
  }

  isClosed(closedSensor) {
    if (this.deviceData.closedSensor === undefined && closedSensor === undefined) {
      return;
    }

    if (closedSensor === undefined && this.deviceData.closedSensor !== undefined) {
      closedSensor = this.deviceData.closedSensor;
    }
    return GPIO.read(closedSensor) === GPIO.HIGH ? true : false; // If high on sensor, means door is closed
  }

  hasObstruction(obstructionSensor) {
    if (this.deviceData.obstructionSensor === undefined && obstructionSensor === undefined) {
      return;
    }

    if (obstructionSensor === undefined && this.deviceData.obstructionSensor !== undefined) {
      obstructionSensor = this.deviceData.obstructionSensor;
    }
    return GPIO.read(obstructionSensor) === GPIO.HIGH ? true : false; // If high, obstruction detected
  }

  messageServices(type, message) {
    if (type === GarageDoor.DOOREVENT) {
      if (message.status === 'closed' && this.currentDoorStatus !== 'closed') {
        // Closed
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.CLOSED);
        this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.CLOSED);
        this.currentDoorStatus = 'closed';

        if (typeof this.historyService?.addHistory === 'function' && this.doorService !== undefined) {
          // Log door closed to history service if present
          let tempEntry = this.historyService.lastHistory(this.doorService);
          if (tempEntry?.status !== 0) {
            this.historyService.addHistory(this.doorService, { time: Math.floor(Date.now() / 1000), status: 0 }); // closed
          }
        }
        this?.log?.success && this.log.success('Door "%s" is closed', this.deviceData.description);
      }

      if (message.status === 'open' && this.currentDoorStatus !== 'open') {
        // Open
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
        this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
        this.currentDoorStatus = 'open';

        if (typeof this.historyService?.addHistory === 'function' && this.doorService !== undefined) {
          // Log door opened to history service if present
          let tempEntry = this.historyService.lastHistory(this.doorService);
          if (tempEntry?.status !== 1) {
            this.historyService.addHistory(this.doorService, { time: Math.floor(Date.now() / 1000), status: 1 }); // open
          }
        }
        this?.log?.warn && this.log.warn('Door "%s" is open', this.deviceData.description);
      }

      if (message.status === 'moving') {
        // Moving
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
        if (message.last === 'closed' && this.currentDoorStatus !== 'opening') {
          // Since door was last closed, and now its moving, assume its opening
          this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.OPENING);
          this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
          this.currentDoorStatus = 'opening';
          this?.log?.debug && this.log.debug('Door "%s" is opening', this.deviceData.description);
        }
        if (message.last === 'open' && this.currentDoorStatus !== 'closing') {
          // Since door was last open, and now its moving, assume its closing
          this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.CLOSING);
          this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.CLOSED);
          this.currentDoorStatus = 'closing';
          this?.log?.debug && this.log.debug('Door "%s" is closing', this.deviceData.description);
        }
      }

      if (message.status === 'stopped') {
        // Stopped
        if (this.currentDoorStatus !== 'stopped') {
          this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
          this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);
          this.doorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.hap.Characteristic.CurrentDoorState.OPEN);
          this.currentDoorStatus = 'stopped';

          if (typeof this.historyService?.addHistory === 'function' && this.doorService !== undefined) {
            // Log door opened to history service if present
            let tempEntry = this.historyService.lastHistory(this.doorService);
            if (tempEntry?.status !== 1) {
              this.historyService.addHistory(this.doorService, { time: Math.floor(Date.now() / 1000), status: 1 }); // open
            }
          }
          this?.log?.debug && this.log.debug('Door "%s" has stopped moving', this.deviceData.description);
        }
      }

      if (message.status === 'fault') {
        // Faulty sensors
        this.doorService.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.GENERAL_FAULT);
        this.doorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.hap.Characteristic.CurrentDoorState.STOPPED);
        // What should current door status be???
        this?.log?.error && this.log.error('Door "%s" is reporting fault with sensors', this.deviceData.description);
      }

      if (message.status === 'obstruction' || message.status === 'clear') {
        // Door obstruction, either active or cleared
        this.doorService.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, message.status === 'obstruction' ? true : false);
        this?.log?.warn && this.log.warn('Door "%s" is reporting an obstruction', this.deviceData.description);
        // <---- Implement. Do we stop door from being closed if obstructed? or just allow to open?? or not allow movement at all?
      }
    }
  }

  updateServices(deviceData) {
    let doorOpen = this.isOpen(deviceData.openSensor);
    let doorClosed = this.isClosed(deviceData.closeSensor);
    let obstruction = this.hasObstruction(deviceData.obstructionSensor);

    // Work out the current status of the door using configured sensors.
    // This will either be "open", "closed", "moving", "stopped"
    // We'll send a message about its status once determined
    if (doorClosed === true && doorOpen === false) {
      // Door is fully closed
      this.#moveStartedTime = undefined;
      this.#lastDoorStatus = 'closed';
      if (this.#eventEmitter !== undefined) {
        this.#eventEmitter.emit(this.uuid, GarageDoor.DOOREVENT, { status: 'closed' });
      }
    }
    if (doorClosed === false && doorOpen === true) {
      // Door is fully open
      this.#moveStartedTime = undefined;
      this.#lastDoorStatus = 'open';
      if (this.#eventEmitter !== undefined) {
        this.#eventEmitter.emit(this.uuid, GarageDoor.DOOREVENT, { status: 'open' });
      }
    }
    if (doorClosed === false && doorOpen === false) {
      // Door is neither open or closed, so door is either moving or stopped.
      if (this.#moveStartedTime === undefined) {
        this.#moveStartedTime = Date.now(); // Time we detected first movement from either open or closed

        if (this.#lastDoorStatus === 'stopped') {
          // Detected movement after stopped state, ie: we've pressed the push button
          // Stopped state is assumed to be door open, as neither detected open or closed
          this.#lastDoorStatus = 'open';
        }
      }

      let duration = Math.floor(Date.now()) - (this.#moveStartedTime !== undefined ? this.#moveStartedTime : 0);
      if (
        this.#lastDoorStatus === 'unknown' ||
        this.#lastDoorStatus === 'stopped' ||
        (this.#lastDoorStatus === 'open' && duration > deviceData.closeTime * 1000) ||
        (this.#lastDoorStatus === 'closed' && duration > deviceData.openTime * 1000)
      ) {
        // Since the door state isn't open or closed OR open or closed status and moving time has been exceeded for configured times
        // In this case we'll assume door has stopped
        this.#lastDoorStatus = 'stopped';
        if (this.#eventEmitter !== undefined) {
          this.#eventEmitter.emit(this.uuid, GarageDoor.DOOREVENT, { status: 'stopped' });
        }
      } else {
        if (this.#eventEmitter !== undefined) {
          this.#eventEmitter.emit(this.uuid, GarageDoor.DOOREVENT, {
            status: 'moving',
            last: this.#lastDoorStatus,
            duration: duration,
          });
        }
      }
    }
    if (doorClosed === true && doorOpen === true) {
      // Is reading both open and close, we'll assume fault with sensors
      if (this.#eventEmitter !== undefined) {
        this.#eventEmitter.emit(this.uuid, GarageDoor.DOOREVENT, { status: 'fault', last: this.#lastDoorStatus });
      }
    }

    if (obstruction !== undefined) {
      // Since obstruction didn't return an undefined value, this means we have a configured obstruction sensor and its returned its status
      if (this.#eventEmitter !== undefined) {
        this.#eventEmitter.emit(this.uuid, GarageDoor.DOOREVENT, { status: obstruction === true ? 'obstruction' : 'clear' });
      }
    }

    // Perform this again after a short period by issuing an device update message
    // The updateServices function will only be called again from this message if some data has changed
    // We can force this by adding a "timestamp" field to the data object
    setTimeout(() => {
      this.#eventEmitter.emit(this.uuid, HomeKitDevice.UPDATE, { lastDoorCheckTime: Date.now() });
    }, 1000);
  }
}
