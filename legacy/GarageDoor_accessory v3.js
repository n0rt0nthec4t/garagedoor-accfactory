// HAP-Nodejs Garage Door opener accessory
// Version 1/7/2018
// Mark Hulskamp

var JSONPackage = require('../package.json')
var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var GPIO = require('rpio');

// Defines for the accessory
const AccessoryName =  "Garage Door Opener";            // name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for paring 
const AccessoryUsername = "69:34:CC:5A:13:2A";          // MAC like address used by HomeKit to differentiate accessories. 
const AccessoryManufacturer = "Merlin";             	// manufacturer (optional)
const AccessoryModel = "Tiltmaster";                    // model (optional)
const AccessorySerialNumber = "MH20180701";             // serial number (optional) 
const AccessoryFirmwareRevision = JSONPackage.version;  // firmware revision (optional)

// Create the "garage door" object. This can be used as the template for multiple doors under
// the one accessory ie: left and right doors
function GarageDoorClass() {
    this.DoorService = null;            // Homekit service for this door
    this.cachedDoorState = null;        // Cached state of the door. usedto update homekit. Initally no value
    this.timerFunc = null;              // object to created timer for door moving
    this.GPIO_PushButton = 0;           // GPIO Pin Garage open/close button
    this.GPIO_ClosedSensor = 0;         // GPIO pin for closed sensor
    this.GPIO_OpenedSensor = 0;         // GPIO pin for opened sensor
    this.GPIO_ObstructionSensor = 0;    // GPIO pin for obstruction sensor (0 disabled)
    this.OpenTimeMS = 0;	    	    // Time for door to fully open in MS
    this.CloseTimeMS = 0;		        // Time for door to fully close in MS
}

GarageDoorClass.prototype = {
	addGarageDoor: function(homekitAccessory, thisServiceName, serviceNumber) {
        console.log("Setup GarageDoor '%s' on '%s'", thisServiceName, homekitAccessory.username);

		// Add this door to the "master" accessory and set properties
		this.DoorService = homekitAccessory.addService(Service.GarageDoorOpener, thisServiceName, serviceNumber); 

		// Initialise the GPIO input/output PINs for this door
		GPIO.init({gpiomem: true});
		GPIO.init({mapping: 'gpio'});
		if (this.GPIO_PushButton != 0) GPIO.open(this.GPIO_PushButton, GPIO.OUTPUT, GPIO.LOW);
		if (this.GPIO_ClosedSensor != 0) GPIO.open(this.GPIO_ClosedSensor, GPIO.INPUT); 
		if (this.GPIO_OpenedSensor != 0) GPIO.open(this.GPIO_OpenedSensor, GPIO.INPUT);

		// Setup for obstruction detection. 
		if (this.GPIO_ObstructionSensor != 0) {
			GPIO.open(this.GPIO_ObstructionSensor, GPIO.INPUT);

			// Setup callback of status of the "obstruction sensor" using real sensor
			this.DoorService.getCharacteristic(Characteristic.ObstructionDetected)
				.on('get', function(callback) {
				callback(null, GPIO.read(this.GPIO_ObstructionSensor) ? false : true);
			});

			console.log("Obstruction detection enabled on '%s'", homekitAccessory.username);
		}

		// Setup Homekit callback to get the current state of the door
		this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).on('get', this.getGarageDoorState.bind(this));

		// Setup Homekit callback to set the state of the door as the target
		this.DoorService.getCharacteristic(Characteristic.TargetDoorState).on('set', this.setGarageDoorState.bind(this));

		// setup sensor check interval for every 500ms
		setInterval(this.sensorState.bind(this), 500);
		return this.DoorService;   // Return object to this service
	},

	getGarageDoorState: function(callback) {      
		// Return position of the door by use of sensors, otherwise, the current status assumed by HomeKit
		// Characteristic.CurrentDoorState.OPEN = 0;
		// Characteristic.CurrentDoorState.CLOSED = 1;
		// Characteristic.CurrentDoorState.OPENING = 2;
		// Characteristic.CurrentDoorState.CLOSING = 3;
		// Characteristic.CurrentDoorState.STOPPED = 4;

		this.sensorState();
		callback(null, this.cachedDoorState);
	},
	
	setGarageDoorState: function(state, callback) {      
		// Set position of the door. (will either be open or closed)

		if (state == Characteristic.TargetDoorState.CLOSED) {
			if (this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.OPENING) {
				// Since door is "moving", press button to stop. Secodn press below will close ie: reverse
				this.pressButton(this.GPIO_PushButton, 500);
				this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.STOPPED);
				this.DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
			}
			// "Press" garage opener/closer button, and update HomeKit status to show door moving. 
			// the poll funtion will update to the closed status when sensor triggered
			this.pressButton(this.GPIO_PushButton, 500);
			this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.CLOSING);

			// Start moving door timer for closing
			clearTimeout(this.timerFunc);
			this.timerFunc = setTimeout(this.MovingTimer.bind(this), this.CloseTimeMS);
		} else if (state == Characteristic.TargetDoorState.OPEN) {
			if (this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).value  == Characteristic.CurrentDoorState.CLOSING) {
				// Since door is "moving", press button to stop. Secodn press below will close ie: reverse
				this.pressButton(this.GPIO_PushButton, 500);
				this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.STOPPED);
				this.DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);
			}
			// "Press" garage opener/closer button, and update HomeKit status to show door moving. 
			// the poll funtion will update to the closed status when sensor triggered
			this.pressButton(this.GPIO_PushButton, 500);
			this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.OPENING);

			// Start moving door timer for opening
			clearTimeout(this.timerFunc);
			this.timerFunc = setTimeout(this.MovingTimer.bind(this), this.OpenTimeMS);
        }
        callback();
	},
	
	sensorState: function() {
		// Determines status of the door but the sensors present and updates HomeKit to reflect this
		var currentOpenSensor = GPIO.read(this.GPIO_OpenedSensor);
		var currentCloseSensor = GPIO.read(this.GPIO_ClosedSensor);
		var currentObstructionSensor = 0;

		if (currentCloseSensor == 1 && currentOpenSensor == 0) {
			if (this.cachedDoorState != Characteristic.CurrentDoorState.CLOSED) {
				// determined the door is actually closed, so update the internal door status to this.
				// Update HomeKit also to reflect this
				this.cachedDoorState = Characteristic.CurrentDoorState.CLOSED;
				this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.CLOSED);
				this.DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
					
				// Clear moving door timeout for door closing
				clearTimeout(this.timerFunc);
			}
		} else if (currentOpenSensor == 1 && currentCloseSensor == 0) {
			if (this.cachedDoorState != Characteristic.CurrentDoorState.OPEN) {
				// determined the door is actually opened, so update the internal door status to this
				// Update HomeKit also to reflect this
				this.cachedDoorState = Characteristic.CurrentDoorState.OPEN;
				this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.OPEN);
				this.DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);

				// Clear moving door timer for door opening
				clearTimeout(this.timerFunc);
			}
		} else if (currentCloseSensor == 1 && currentOpenSensor == 1) {
			// door is neither open or closed, so now need to dtermined if we are transitioning from open -> closed, closed -> opened or stopped
			// stopped state will be determined by timeout ie: full door open/close time
			if (this.cachedDoorState == Characteristic.CurrentDoorState.CLOSED) {
				// since last status was closed, we'll assume transitioning to open
				// Update HomeKit also to reflect this
				this.cachedDoorState = Characteristic.CurrentDoorState.OPENING;
				this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.OPENING);
				this.DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);

				// Start moving door timer for opening
				clearTimeout(this.timerFunc);
				this.timerFunc = setTimeout(this.MovingTimer.bind(this), this.OpenTimeMS);
			} else if (this.cachedDoorState == Characteristic.CurrentDoorState.OPEN) {
				// since last status was closed, we'll assume transitioning to closed
				// Update HomeKit also to reflect this
				this.cachedDoorState = Characteristic.CurrentDoorState.CLOSING;
				this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.CLOSING);
				this.DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);

				// Start moving door timer for closing
				clearTimeout(this.timerFunc);
				this.timerFunc = setTimeout(this.MovingTimer.bind(this), this.CloseTimeMS);
			} 
		}
		
		// Handle checking the obstruction sensor if present
		if (this.GPIO_ObstructionSensor != 0) {
			currentObstructionSensor = GPIO.read(this.GPIO_ObstructionSensor);

			if (this.DoorService.getCharacteristic(Characteristic.ObstructionDetected).value != currentObstructionSensor)
			{
				// Obstruction sensor value changed, so update homekit
				this.DoorService.getCharacteristic(Characteristic.ObstructionDetected).setValue(currentObstructionSensor);
			}
			if (currentObstructionSensor == 1 && this.cachedDoorState == Characteristic.CurrentDoorState.CLOSING) {
				// Obstruction detected, so if door moving (closing), stop and set status
				// More coding needed.. Logic for stopping door etc
				this.cachedDoorState = Characteristic.CurrentDoorState.STOPPED;
			}
		}
	},

	MovingTimer: function () {
		// Used for timing door/open to work out of the door was stopped while opening or closing
		// should get trigger when open or close time exceeds the defined limits. If this happens, we assume
		// door has stopped. Set status of this. Will need to set "target door" state as the door reverses direction on stopped
		if (this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.OPENING) {
			// Door was opening
			this.DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);
		} else if (this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.CLOSING) {
			// Door was closing
			this.DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
		}
		this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.STOPPED);
		this.cachedDoorState = Characteristic.CurrentDoorState.STOPPED;
	},

	pressButton: function(GPIO_Pin, holdforMS) {
		// Simulate pressing the controller button
		// Write high out first to trigger relay, then wait defined milliseond periodand put back to low to untrigger	
		GPIO.write(GPIO_Pin, GPIO.HIGH);
		GPIO.msleep(holdforMS);
		GPIO.write(GPIO_Pin, GPIO.LOW);
	}
}

// Create the garage door opener accessory
var garageUUID = uuid.generate('hap-nodejs:accessories:garage_' + AccessoryName);
var garageAccessory = exports.accessory = new Accessory(AccessoryName, garageUUID);
garageAccessory.username = AccessoryUsername; 
garageAccessory.pincode = AccessoryPincode;
garageAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, AccessoryManufacturer);
garageAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, AccessoryModel);
garageAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, AccessorySerialNumber);
garageAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, AccessoryFirmwareRevision);

// Create the garage for the homekit garage door opener accessory
var GarageDoor = new GarageDoorClass();
GarageDoor.GPIO_PushButton = 23;
GarageDoor.GPIO_ClosedSensor = 24;
GarageDoor.GPIO_OpenedSensor = 25;
GarageDoor.CloseTimeMS = 22000;
GarageDoor.OpenTimeMS = 22000;
GarageDoor.addGarageDoor(garageAccessory, "Garage Door", 1);
