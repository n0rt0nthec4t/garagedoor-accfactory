var Accessory = require('../').Accessory;
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var GPIO = require('rpio');
var qrcode = require('qrcode-terminal');

// Defines
const GPIO_PushButton = 23;   		// GPIO Pin Garage button
const GPIO_ClosedSensor = 24;		// GPIO pin for closed sensor
const GPIO_OpenedSensor = 25;		// GPIO pin for opened sensor
const GPIO_ObstructionSensor = 0;	// GPIO pin for obstruction sensor (0 disabled)
const doorOpenTimeMS = 22000;		// Time for door to fully open in MS
const doorCloseTimeMS = 22000;		// Time for door to fully close in MS


// here's a fake hardware device that we'll expose to HomeKit
var FAKE_GARAGEDOOR = {
	name: "Garage Door", //name of accessory
	pincode: "031-45-155", // pin code for paring 
	username: "69:34:CC:5A:13:2A", // MAC like address used by HomeKit to differentiate accessories. 
	manufacturer: "Merlin", //manufacturer (optional)
	model: "Tiltmaster", //model (optional)
	serialnumber: "MH20180614", //serial number (optional)

	doorStatus: null, 
	timerFunc: null,

	getDoorState: function() {      
		// Return position of the door by use of sensors, otherwise, teh current status assumed by HomeKit
		// Characteristic.CurrentDoorState.OPEN = 0;
		// Characteristic.CurrentDoorState.CLOSED = 1;
		// Characteristic.CurrentDoorState.OPENING = 2;
		// Characteristic.CurrentDoorState.CLOSING = 3;
		// Characteristic.CurrentDoorState.STOPPED = 4


		FAKE_GARAGEDOOR.sensorState();	// update stored door state based on sensor reading
		return FAKE_GARAGEDOOR.doorStatus;
	},
	
	setDoorState: function(state) {      
		// Set position of the door. (will either be open or closed)

		if (state == Characteristic.TargetDoorState.CLOSED) {
			if (GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.OPENING) {
				// Since door is "moving", press button to stop. Secodn press below will close ie: reverse
				FAKE_GARAGEDOOR.pressButton(GPIO_PushButton, 500);
				GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.STOPPED);
				GarageDoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
			}
			// "Press" garage opener/closer button, and update HomeKit status to show door moving. 
			// the poll funtion will update to the closed status when sensor triggered
			FAKE_GARAGEDOOR.pressButton(GPIO_PushButton, 500);
			GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.CLOSING);

			// Start moving door timer for closing
			clearTimeout(FAKE_GARAGEDOOR.timerFunc);
			FAKE_GARAGEDOOR.timerFunc = setTimeout(FAKE_GARAGEDOOR.doorMoveTime, doorCloseTimeMS);
		} else if (state == Characteristic.TargetDoorState.OPEN) {
			if (GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).value  == Characteristic.CurrentDoorState.CLOSING) {
				// Since door is "moving", press button to stop. Secodn press below will close ie: reverse
				FAKE_GARAGEDOOR.pressButton(GPIO_PushButton, 500);
				GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.STOPPED);
				GarageDoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);
			}
			// "Press" garage opener/closer button, and update HomeKit status to show door moving. 
			// the poll funtion will update to the closed status when sensor triggered
			FAKE_GARAGEDOOR.pressButton(GPIO_PushButton, 500);
			GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.OPENING);

			// Start moving door timer for opening
			clearTimeout(FAKE_GARAGEDOOR.timerFunc);
			FAKE_GARAGEDOOR.timerFunc = setTimeout(FAKE_GARAGEDOOR.doorMoveTime, doorOpenTimeMS);
		}
	},

	identify: function() { 
		//identify the accessory
	},

	
	sensorState: function() {
		// Determines status of the door but the sensors present and updates HomeKit to reflect this
		var currentOpenSensor = GPIO.read(GPIO_OpenedSensor);
		var currentCloseSensor = GPIO.read(GPIO_ClosedSensor);
		var currentObstructionSensor = 0;

		if (currentCloseSensor == 1 && currentOpenSensor == 0) {
			if (FAKE_GARAGEDOOR.doorStatus != Characteristic.CurrentDoorState.CLOSED) {
				// determined the door is actually closed, so update the internal door status to this.
				// Update HomeKit also to reflect this
				FAKE_GARAGEDOOR.doorStatus = Characteristic.CurrentDoorState.CLOSED;
				GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.CLOSED);
				GarageDoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
				
				// Clear timeout for door closing
				clearTimeout(FAKE_GARAGEDOOR.timerFunc);
			}
		} else if(currentOpenSensor == 1 && currentCloseSensor == 0) {
			if (FAKE_GARAGEDOOR.doorStatus != Characteristic.CurrentDoorState.OPEN) {
				// determined the door is actually opened, so update the internal door status to this
				// Update HomeKit also to reflect this
				FAKE_GARAGEDOOR.doorStatus = Characteristic.CurrentDoorState.OPEN;
				GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.OPEN);
				GarageDoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);

				// Clear timeout for door opening
				clearTimeout(FAKE_GARAGEDOOR.timerFunc);
			}
		} else if (currentCloseSensor == 1 && currentOpenSensor == 1) {
			// door is neither open or closed, so now need to dtermined if we are transitioning from open -> closed, closed -> opened or stopped
			// stopped state will be determined by timeout ie: full door open/close time
			if (FAKE_GARAGEDOOR.doorStatus == Characteristic.CurrentDoorState.CLOSED) {
				// since last status was closed, we'll assume transitioning to open
				// Update HomeKit also to reflect this
				FAKE_GARAGEDOOR.doorStatus = Characteristic.CurrentDoorState.OPENING;
				GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.OPENING);
				GarageDoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);

				// Start moving door timer for opening
				clearTimeout(FAKE_GARAGEDOOR.timerFunc);
				FAKE_GARAGEDOOR.timerFunc = setTimeout(FAKE_GARAGEDOOR.doorMoveTime, doorOpenTimeMS);
			} else if (FAKE_GARAGEDOOR.doorStatus == Characteristic.CurrentDoorState.OPEN) {
				// since last status was closed, we'll assume transitioning to closed
				// Update HomeKit also to reflect this
				FAKE_GARAGEDOOR.doorStatus = Characteristic.CurrentDoorState.CLOSING;
				GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).setValue(Characteristic.CurrentDoorState.CLOSING);
				GarageDoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);

				// Start moving door timer for closing
				clearTimeout(FAKE_GARAGEDOOR.timerFunc);
				FAKE_GARAGEDOOR.timerFunc = setTimeout(FAKE_GARAGEDOOR.doorMoveTime, doorCloseTimeMS);
			} 
		}
		
		// Handle checking the obstruction sensor if present
		if (GPIO_ObstructionSensor != 0) {
			currentObstructionSensor = GPIO.read(GPIO_ObstructionSensor);

			if (GarageDoorService.getCharacteristic(Characteristic.ObstructionDetected).value != currentObstructionSensor)
			{
				// Obstruction sensor value changed, so update homekit
				GarageDoorService.getCharacteristic(Characteristic.ObstructionDetected).setValue(currentObstructionSensor);
			}
			if (currentObstructionSensor == 1) {
				// Obstruction detected, so if door moving, stop and set status
				if (FAKE_GARAGEDOOR.doorStatus == Characteristic.CurrentDoorState.CLOSING || FAKE_GARAGEDOOR.doorStatus == Characteristic.CurrentDoorState.OPENING) {
					FAKE_GARAGEDOOR.doorStatus = Characteristic.CurrentDoorState.STOPPED;

					// stop door.. need to think on this logic as button
				}
			}
		}
	},

	doorMoveTime: function () {
		// Used for timing door/open to work out of the door was stopped while opening or closing
		// should get trigger when open or close time exceeds the defined limits. If this happens, we assume
		// door has stopped. Set status of this. Will need to set "target door" state as the door reverse direction on stopped
		FAKE_GARAGEDOOR.doorStatus = Characteristic.CurrentDoorState.STOPPED;
		if (GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.OPENING) {
			// Door was opening
			GarageDoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);
		} else if (GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.CLOSING) {
			// Door was closing
			GarageDoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
		}
		GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState).usetValue(FAKE_GARAGEDOOR.doorStatus);
	},

	pressButton: function(button, ms) {
		// Simulate pressing the controller button. Parameter "ms" defines the delay in milliseconds
		// Write high out first to trigger relay, then wait and put back to low to untrigger	
		GPIO.write(button, GPIO.HIGH);
		GPIO.msleep(ms);
		GPIO.write(button, GPIO.LOW);
	}
}

var garageUUID = uuid.generate('hap-nodejs:accessories:garage_' + FAKE_GARAGEDOOR.name);
var garageAccessory = exports.accessory = new Accessory(FAKE_GARAGEDOOR.name, garageUUID);

// Add properties for publishing (in case we're using Core.js and not BridgedCore.js)
garageAccessory.username = FAKE_GARAGEDOOR.username;
garageAccessory.pincode = FAKE_GARAGEDOOR.pincode;
garageAccessory
	.getService(Service.AccessoryInformation)
	.setCharacteristic(Characteristic.Manufacturer, FAKE_GARAGEDOOR.manufacturer)
	.setCharacteristic(Characteristic.Model, FAKE_GARAGEDOOR.model)
	.setCharacteristic(Characteristic.SerialNumber, FAKE_GARAGEDOOR.serialnumber);

// Publish accessory so we can generate QRcode for adding
//garageAccessory.publish({username:FAKE_GARAGEDOOR.username, pincode:FAKE_GARAGEDOOR.pincode, category:Accessory.Categories.GARAGE_DOOR_OPENER}, false);
//console.log("Setup Code:");
//qrcode.generate(garageAccessory.setupURI(),{small: true});

// listen for the "identify" event for this Accessory
garageAccessory
	.on('identify', function(paired, callback) {
	FAKE_GARAGEDOOR.identify();
	callback();
});

// Init GPIO pins
GPIO.init({gpiomem: true});
GPIO.init({mapping: 'gpio'});
GPIO.open(GPIO_PushButton, GPIO.OUTPUT, GPIO.LOW);

GPIO.open(GPIO_ClosedSensor, GPIO.INPUT);
GPIO.open(GPIO_OpenedSensor, GPIO.INPUT);

var GarageDoorService = garageAccessory.addService(Service.GarageDoorOpener, FAKE_GARAGEDOOR.name);
garageAccessory.setPrimaryService(GarageDoorService);

// Setup callback to get the current state of the door
GarageDoorService.getCharacteristic(Characteristic.CurrentDoorState)
        .on('get', function(callback) {
        callback(null, FAKE_GARAGEDOOR.getDoorState());
});

// Setup callback to set the state of the door as the target
GarageDoorService.getCharacteristic(Characteristic.TargetDoorState)
        .on('set', function(value, callback) {
		FAKE_GARAGEDOOR.setDoorState(value);
        callback();
});

// Setup for obstruction detection. 
if (GPIO_ObstructionSensor != 0) {
	GPIO.open(GPIO_ObstructionSensor, GPIO.INPUT);

	// Setup callback of status of the "obstruction sensor" using real sensor
	GarageDoorService.getCharacteristic(Characteristic.ObstructionDetected)
		.on('get', function(callback) {
		callback(null, GPIO.read(GPIO_ObstructionSensor) ? false : true);
	});

	console.log("Enabling door obstruction sensor");
}

// setup sensor check interval for every 500ms
setInterval(FAKE_GARAGEDOOR.sensorState, 500);






