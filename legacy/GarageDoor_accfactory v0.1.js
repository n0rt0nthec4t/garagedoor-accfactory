// HAP-Nodejs Garage Door opener accessory
// Mark Hulskamp
//
// https://shop.pimoroni.com/products/automation-phat
// https://www.miniwebtool.com/mac-address-generator/ (Created mac address mirroring merlin/chamberlan range)
//
// GPIO Pin Assignments for pHAT board
// ------------------------------------
// GPIO26	Input 1
// GPIO20	Input 2
// GPIO21	Input 3
// GPIO5	Output 1
// GPIO12	Output 2
// GPIO6	Output 3
// GPIO16	Relay 1
//
// todo
// -- Get obstruction code working and verifed
//
// done
// -- Set accessory type icon for pairing. Requires change to HAP-NodeJS Core.js until present in main code
// -- Use MAC address in the range mirroring merlin/chamberlan devices
// -- updated to use npm version of hap-nodejs directory structure (11/4/2020)
// -- Preparation to use HAP-NodeJS as a library, rather than accessory factory as is now. Will allow for depreciation of HAP-NodeJS's Core.js
// -- Turn into accessory factory in HAP-NodeJS, so each garage door created has its own accessory
// -- external configuratiopn file
//
// bugs
// -- Bug if manually opened door and stopped between open/close then press close/open in HomeKit.. confused logic. Not sure be worked around
//
// Version 21/6/2022
// Mark Hulskamp

module.exports = accessories = [];

"use strict";


// Define HAP-NodeJS requirements
var HAPNodeJS = require("hap-nodejs");
var Accessory = HAPNodeJS.Accessory; 
var Service = HAPNodeJS.Service;
var Characteristic = HAPNodeJS.Characteristic;
var uuid = HAPNodeJS.uuid;
var MDNSAdvertiser = HAPNodeJS.MDNSAdvertiser;

// Define nodejs module requirements
var fs = require("fs");
var os = require('os');
var EventEmitter = require("events");

// Define external lbrary requirements
var GPIO = require("rpio");

// Define our external module requirements
var HomeKitHistory = require("./HomeKitHistory");


// Defines for the accessory
const AccessoryName =  "Garage Door";       // name of accessory
const AccessoryPincode = "031-45-154";      // pin code for pairing 


// Create the "garage door" object. This can be used as the template for multiple doors under
// the one accessory ie: left and right doors
function GarageDoorClass() {
    this.DoorService = null;			// HomeKit service for this door
    this.cachedDoorState = null;        // Cached state of the door. used to update HomeKit. Initally no value
    this.movingTimer = null;            // object to created timer for door moving
    this.GPIO_PushButton = null;        // GPIO Pin Garage open/close button
    this.GPIO_ClosedSensor = null;      // GPIO pin for closed sensor
    this.GPIO_OpenedSensor = null;      // GPIO pin for opened sensor
    this.GPIO_ObstructionSensor = null; // GPIO pin for obstruction sensor (0 disabled)
    this.OpenTimeMS = 0;	    	    // Time for door to fully open in MS
    this.CloseTimeMS = 0;		        // Time for door to fully close in MS
    this.events = new EventEmitter();   // For HomeKit updates
    this.historyService = null;         // History logging service
}


GarageDoorClass.prototype.addGarageDoor = function(HomeKitAccessory, thisServiceName, serviceNumber, data) {
    // Add this door to the "master" accessory and set properties
    this.DoorService = HomeKitAccessory.addService(Service.GarageDoorOpener, thisServiceName, serviceNumber);
    this.DoorService.addCharacteristic(Characteristic.StatusFault); // Used if the sensors report incorrect readings, such as both "high"

    // copy in config details
    this.GPIO_PushButton = data.PushButton;
    this.GPIO_ClosedSensor = data.ClosedSensor;
    this.GPIO_OpenedSensor = data.OpenSensor;
    this.OpenTimeMS = data.OpenTime;
    this.CloseTimeMS = data.CloseTime;
    this.GPIO_ObstructionSensor = data.ObstructionSensor;

    // Initialise the GPIO input/output PINs for this door
    GPIO.init({gpiomem: true});
    GPIO.init({mapping: 'gpio'});
    if (this.GPIO_PushButton != 0) GPIO.open(this.GPIO_PushButton, GPIO.OUTPUT, GPIO.LOW);
    if (this.GPIO_ClosedSensor != 0) GPIO.open(this.GPIO_ClosedSensor, GPIO.INPUT); 
    if (this.GPIO_OpenedSensor != 0) GPIO.open(this.GPIO_OpenedSensor, GPIO.INPUT);
    if (this.GPIO_ObstructionSensor != 0) GPIO.open(this.GPIO_ObstructionSensor, GPIO.INPUT);

    // Setup HomeKit callbacks
    this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).on('get', this.getGarageDoorState.bind(this));
    this.DoorService.getCharacteristic(Characteristic.TargetDoorState).on('set', this.setGarageDoorState.bind(this));

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {debug: false});
    this.historyService.linkToEveHome(HomeKitAccessory, this.DoorService);

    // Perform inital update of door status for HomeKit
    this.updateHomeKit(HomeKitAccessory, data);

    console.log("Setup GarageDoor '%s' on '%s'", thisServiceName, HomeKitAccessory.username, (this.GPIO_ObstructionSensor != 0 ? "Obstruction detection" : ""));
}

GarageDoorClass.prototype.getGarageDoorState = function(callback) {      
    // Return position of the door by use of sensors, otherwise, the current status assumed by HomeKit
    this.updateHomeKit(null, null);
    callback(null, this.cachedDoorState);
}
	
GarageDoorClass.prototype.setGarageDoorState = function(state, callback) {      
    // Set position of the door. (will either be open or closed)
    if ((state == Characteristic.TargetDoorState.CLOSED) && (GPIO.read(this.GPIO_ClosedSensor) == GPIO.LOW)) {
        if (this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.OPENING) {
            // Since door is "moving", press button to stop. Second press below will close ie: reverse
            clearTimeout(this.movingTimer);
            this.movingTimer = null;
            this.pressButton(this.GPIO_PushButton, 500);
            this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.STOPPED);
            this.DoorService.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.CLOSED);
        }
        // "Press" garage opener/closer button, and update HomeKit status to show door moving. 
        // the poll funtion will update to the closed status when sensor triggered
        this.pressButton(this.GPIO_PushButton, 500);
        this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSING);
    } else if ((state == Characteristic.TargetDoorState.OPEN) && (GPIO.read(this.GPIO_OpenedSensor) == GPIO.LOW)) {
        if (this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.CLOSING) {
            // Since door is "moving", press button to stop. Second press below will close ie: reverse
            clearTimeout(this.movingTimer);   
            this.movingTimer = null;
            this.pressButton(this.GPIO_PushButton, 500);
            this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.STOPPED);
            this.DoorService.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.OPEN);
        }
        // "Press" garage opener/closer button, and update HomeKit status to show door moving. 
        // the poll funtion will update to the open status when sensor triggered
        this.pressButton(this.GPIO_PushButton, 500);
        this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPENING);
    }
    callback();
}
    
GarageDoorClass.prototype.updateHomeKit = function(HomeKitAccessory, data) {
    // Determines status of the door by the sensors present and updates HomeKit to reflect this
    var currentOpenSensor = GPIO.read(this.GPIO_OpenedSensor);
    var currentCloseSensor = GPIO.read(this.GPIO_ClosedSensor);
    var sensorFault = false;    // No Sensor fault yet
    
    if (currentCloseSensor == GPIO.HIGH && currentOpenSensor == GPIO.LOW) {
        if (this.cachedDoorState != Characteristic.CurrentDoorState.CLOSED) {
            // Clear moving door timeout for door closing
            clearTimeout(this.movingTimer);
            this.movingTimer = null;
            
            // determined the door is actually closed, so update the internal door status to this.
            // Update HomeKit also to reflect this
            this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSED);
            this.DoorService.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.CLOSED);

            if (this.historyService != null) {
                var historyEntry = this.historyService.lastHistory(this.DoorService);
                if (historyEntry == null || (typeof historyEntry == "object" && historyEntry.status != 0)) {
                    // only log entry if last recorded entry is different
                    // helps with restarts
                    this.historyService.addHistory(this.DoorService, {time: Math.floor(new Date() / 1000), status: 0}); // closed
                }
            }

            this.cachedDoorState = Characteristic.CurrentDoorState.CLOSED;
        }
    } else if (currentCloseSensor == GPIO.LOW && currentOpenSensor == GPIO.HIGH) {
        if (this.cachedDoorState != Characteristic.CurrentDoorState.OPEN) {
            // Clear moving door timer for door opening
            clearTimeout(this.movingTimer);
            this.movingTimer = null;

            // determined the door is actually opened, so update the internal door status to this
            this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPEN);
            this.DoorService.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.OPEN);

            if (this.historyService != null) {
                var historyEntry = this.historyService.lastHistory(this.DoorService);
                if (historyEntry == null || (typeof historyEntry == "object" && historyEntry.status != 1)) {
                    // only log entry if last recorded entry is different
                    // helps with restarts
                    this.historyService.addHistory(this.DoorService, {time: Math.floor(new Date() / 1000), status: 1}); // opened
                }
            }

            this.cachedDoorState = Characteristic.CurrentDoorState.OPEN;
        }
    } else if (currentCloseSensor == GPIO.LOW && currentOpenSensor == GPIO.LOW) {
        // door is neither open or closed, so now need to determine if we are transitioning from open -> closed, closed -> opened or stopped
        // stopped state will be determined by timeout ie: full door open/close time
        if (this.cachedDoorState == Characteristic.CurrentDoorState.CLOSED) {
            // Clear moving door timeout
            clearTimeout(this.movingTimer);
            this.movingTimer = null;

            // since last status was closed, we'll assume transitioning to open
            // Update HomeKit also to reflect this
            this.cachedDoorState = Characteristic.CurrentDoorState.OPENING;
            this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPENING);
            this.DoorService.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.OPEN);

            // Start moving door timer for opening
            this.movingTimer = setTimeout(this.movingTimeout.bind(this), this.OpenTimeMS);
        } else if (this.cachedDoorState == Characteristic.CurrentDoorState.OPEN) {
            // Clear moving door timeout
            clearTimeout(this.movingTimer);
            this.movingTimer = null;

            // since last status was open, we'll assume transitioning to closed
            // Update HomeKit also to reflect this
            this.cachedDoorState = Characteristic.CurrentDoorState.CLOSING;
            this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSING);
            this.DoorService.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.CLOSED);

            // Start moving door timer for closing
            this.movingTimer = setTimeout(this.movingTimeout.bind(this), this.CloseTimeMS);
        }
    } else if (currentCloseSensor == GPIO.HIGH && currentOpenSensor == GPIO.HIGH) {
        // Sensors reading door is opened and closed. Would indicate a fault?
        sensorFault = true;
    }

    // Obstruction detection. Assumes if GPIO HIGH, there is an obstruction
    if (this.GPIO_ObstructionSensor != 0) {
        this.DoorService.updateCharacteristic(Characteristic.ObstructionDetected, (GPIO.read(this.GPIO_OpenedSensor) == GPIO.HIGH ? true : false));
    } else {
        this.DoorService.updateCharacteristic(Characteristic.ObstructionDetected, false);   // No obstruction detected as we don't have a sensor for it
    }

    this.DoorService.updateCharacteristic(Characteristic.StatusFault, (sensorFault == false ?  Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT));
}

GarageDoorClass.prototype.movingTimeout = function () {
    // Used for timeout of door open/close to work out if the door was stopped while opening or closing
    // should get triggered when opening or closing time exceeds the defined limits. If this happens, we assume
    // door has stopped. Set status of this. Will need to set "target door" state as the door reverses direction on stopped
    if (this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.OPENING) {
        // Door was opening
        this.DoorService.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.OPEN);
    } else if (this.DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.CLOSING) {
        // Door was closing
        this.DoorService.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.CLOSED);
    }
    this.DoorService.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.STOPPED);
    this.cachedDoorState = Characteristic.CurrentDoorState.STOPPED;
}

GarageDoorClass.prototype.pressButton = function(GPIO_Pin, holdforMS) {
    if (GPIO_Pin != 0) {
        // Simulate pressing the controller button
        // Write high out first to trigger relay, then wait defined millisecond period and put back to low to untrigger	
        GPIO.write(GPIO_Pin, GPIO.HIGH);
        GPIO.msleep(holdforMS);
        GPIO.write(GPIO_Pin, GPIO.LOW);
    }
}


// General functions
function __makeValidHomeKitName(name) {
    // Strip invalid characters to conform to HomeKit requirements
    // Ensure only letters or numbers at beginning/end of string
    return name.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
}

function getSystemMACAddress(maxTries, retryDelay) {
    // todo - determine active connection, either wifi or ethernet.
    var systemMAC = "";
    var tryCount = 0;
    var networkInterfaces = os.networkInterfaces();

    while (tryCount <= maxTries && systemMAC == "") {
        Object.keys(networkInterfaces).forEach(interface => {
            networkInterfaces[interface].forEach(interface => {
                if ((interface.family.toUpperCase() == "IPV4" || interface.internal == true) && interface.mac != "00:00:00:00:00:00") {
                    // found a MAC address
                    systemMAC = interface.mac.toUpperCase(); 
                }
            });
        });
        if (systemMAC == "") {
            // Didn't get a MAC address, so pause for retry delay before trying again
            tryCount++;
            GPIO.sleep(retryDelay);
        }
    }
    return systemMAC;
}


// Startup code
var configFile = __filename.split('_accfactory.js')[0] + "_config.json";
if (fs.existsSync(configFile) == true) {
    config = JSON.parse(fs.readFileSync(configFile));
    if (typeof config == "object") {
        config && Object.entries(config).forEach(([doorName, data]) => {
            // Validate configuration entires
            var doorData = {};
            doorData.Name = __makeValidHomeKitName(doorName);
            doorData.PushButton = 0;
            doorData.ClosedSensor = 0;
            doorData.OpenSensor = 0;
            doorData.OpenTime = 0;
            doorData.CloseTime = 0;
            doorData.ObstructionSensor = 0;
            doorData.serial_number = "serial";
            doorData.model = "model";
            doorData.manufacturer = "manufacturer";
            doorData.mac_address = getSystemMACAddress(5, 30000);  // retry 5 times, and 30secs delay between each try

            Object.entries(data).forEach(([key, value]) => {
                if (key.toUpperCase() == "PUSHBUTTON" && typeof value == "number") doorData.PushButton = value;
                if (key.toUpperCase() == "CLOSEDSENSOR" && typeof value == "number") doorData.ClosedSensor = value;
                if (key.toUpperCase() == "OPENSENSOR" && typeof value == "number") doorData.OpenSensor = value;
                if (key.toUpperCase() == "OBSTRUCTIONSENSOR" && typeof value == "number") doorData.ObstructionSensor = value;
                if (key.toUpperCase() == "OPENTIME" && typeof value == "number") {
                    if (value < 1000) value = value * 1000;  // If less 1000, assume seconds value passed in, so convert to milliseconds
                    doorData.OpenTime = value;   // Global doorbell press cooldown time
                }
                if (key.toUpperCase() == "CLOSETIME" && typeof value == "number") {
                    if (value < 1000) value = value * 1000;  // If less 1000, assume seconds value passed in, so convert to milliseconds
                    doorData.CloseTime = value;   // Global doorbell press cooldown time
                }              
                if (key.toUpperCase() == "MAC_ADDRESS" && typeof value == "string") doorData.mac_address = value.toUpperCase();
                if (key.toUpperCase() == "SERIAL_NUMBER" && typeof value == "string") doorData.serial_number = value;
                if (key.toUpperCase() == "MODEL" && typeof value == "string") doorData.model = value;
                if (key.toUpperCase() == "NAME" && typeof value == "string") doorData.Name = __makeValidHomeKitName(value);
                if (key.toUpperCase() == "MANUFACTURER" && typeof value == "string") doorData.manufacturer = value;
            });

            var tempAccessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:garage_" + doorData.serial_number));
            tempAccessory.username = doorData.mac_address;
            tempAccessory.pincode = AccessoryPincode;
            tempAccessory.category = Accessory.Categories.GARAGE_DOOR_OPENER;	// Garge door type accessory
            tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, doorData.manufacturer);
            tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, doorData.model);
            tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, doorData.serial_number);
            tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, HAPNodeJS.HAPLibraryVersion());

            tempAccessory.__thisObject = new GarageDoorClass(); // Store the object
            tempAccessory.__thisObject.addGarageDoor(tempAccessory, doorData.Name, 1, doorData);

            accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
            //tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser:  MDNSAdvertiser.CIAO});    // Publish accessory on local network

            // refresh HomeKit status every 500ms
            setInterval(tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject, tempAccessory, doorData), 500); 
        });
    }
} else {
    console.log("Configuration file '%s'", configFile, "cannot be located");
}
