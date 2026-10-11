// HAP-Nodejs Garage Door opener accessory
//
// https://shop.pimoroni.com/products/automation-phat
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
// -- Preparation to use HAP-NodeJS as a library, rather than accessory factory as is now. Will allow for depreciation of HAP-NodeJS's Core.js
// -- Turn into accessory factory in HAP-NodeJS, so each garage door created has its own accessory
// -- external configuratiopn file
// -- rewrite to use "common" HomeKit device class
//
// bugs
// -- Bug if manually opened door and stopped between open/close then press close/open in HomeKit.. confused logic. Not sure be worked around
//
// Version 29/7/2024
// Mark Hulskamp

"use strict";

// Define HAP-NodeJS requirements
var HAP = require("hap-nodejs");

// Define nodejs module requirements
var fs = require("fs");
var os = require("os");
var util = require("util");
var EventEmitter = require("events");

// Define external lbrary requirements
var GPIO = require("rpio");

// Define our external module requirements
var HomeKitHistory = require("./HomeKitHistory");
var HomeKitDevice = require("./HomeKitDevice");
HomeKitDevice.HOMEKITHISTORY = HomeKitHistory;                  // History module for the device
const ACCESSORYNAME = "n0rt0nthec4t";                           // Used for manufacturer name of HomeKit device
const ACCESSORYPINCODE = "031-45-154";                          // HomeKit pairing code

// Garage door
const DOOREVENT = "DOOREVENT";                                  // Door status event tag

class GarageDoor extends HomeKitDevice {
    constructor(initialDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, HAP.MDNSAdvertiser.CIAO, initialDeviceData, globalEventEmitter);

        this.doorService = null;			// HomeKit service for this door
        this.movingTimer = 0;               // Timer for how long door has been moving, either close -> open OR open -> close
        this.currentDoorStatus = HAP.Characteristic.CurrentDoorState.STOPPED;
        this.lastDoorStatus = "unknown";    // Status of door in previous poll iteration
    }

    // Class functions
    addHomeKitServices(serviceName) {
        // Add this garage door to the "master" accessory and set properties
        this.doorService = this.HomeKitAccessory.addService(HAP.Service.GarageDoorOpener, "Garage Door", 1);
        this.doorService.addCharacteristic(HAP.Characteristic.StatusFault); // Used if the sensors report incorrect readings, such as both "high"

        if (this.deviceData.GPIO_PushButton != 0) {
            // Push button
            GPIO.open(this.deviceData.GPIO_PushButton, GPIO.OUTPUT, GPIO.LOW);
        }
        if (this.deviceData.GPIO_ClosedSensor != 0) {
            // Door closed sensor
            GPIO.open(this.deviceData.GPIO_ClosedSensor, GPIO.INPUT, GPIO.PULL_DOWN);
        }
        if (this.deviceData.GPIO_OpenSensor != 0) {
            // Door open sensor
            GPIO.open(this.deviceData.GPIO_OpenSensor, GPIO.INPUT, GPIO.PULL_DOWN);
        }
        if (this.deviceData.GPIO_ObstructionSensor != 0) {
            // Door obstruction sensor
            GPIO.open(this.deviceData.GPIO_ObstructionSensor, GPIO.INPUT, GPIO.PULL_DOWN);
        }

        // Setup callbacks for characteristics
        this.doorService.getCharacteristic(HAP.Characteristic.TargetDoorState).on(HAP.CharacteristicEventTypes.SET, (value, callback) => {this.setDoorPosition(value, callback)});
        this.doorService.getCharacteristic(HAP.Characteristic.CurrentDoorState).on(HAP.CharacteristicEventTypes.GET, (callback) => {this.getDoorPosition(callback)});

        // Setup linkage to EveHome app if configured todo so
        if (this.deviceData.EveApp == true && this.HomeKitHistory != null) {
            this.HomeKitHistory.linkToEveHome(this.HomeKitAccessory, this.doorService, { debug: true });
        }

        this.doorService.updateCharacteristic(HAP.Characteristic.StatusFault, HAP.Characteristic.StatusFault.NO_FAULT); // No fault with sensors yet
        this.doorService.updateCharacteristic(HAP.Characteristic.CurrentDoorState, HAP.Characteristic.CurrentDoorState.STOPPED);    // Door is stopped by default
        this.#doorStatusLoop(); // Do an initial door status update
        setInterval(this.#doorStatusLoop.bind(this), 500);  // Door status polling loop

        // Create extra details for output
        var postSetupDetails = [];
        this.deviceData.GPIO_ObstructionSensor != 0 && postSetupDetails.push("With obstruction detection");
        return postSetupDetails;
    }

    setDoorPosition(value, callback) {      
        // Set position of the door. (will either be open or closed)
        this.movingTimer = 0;   // Clear moving timer as we'll be initiating the door move
        if (value == HAP.Characteristic.TargetDoorState.CLOSED && this.isClosed() == false) {
            if (this.doorService.getCharacteristic(HAP.Characteristic.CurrentDoorState).value == HAP.Characteristic.CurrentDoorState.OPENING) {
                // Since door is "moving", press button to stop. Second press below will close ie: reverse
                this.pressButton();
                this.lastDoorStatus = "stopped";
            }
            // "Press" garage opener/closer button, and update HomeKit status to show door moving. 
            // the poll function will update to the closed status when sensor triggered
            this.pressButton();
        } else if (value == HAP.Characteristic.TargetDoorState.OPEN && this.isOpened() == false) {
            if (this.doorService.getCharacteristic(HAP.Characteristic.CurrentDoorState).value == HAP.Characteristic.CurrentDoorState.CLOSING) {
                // Since door is "moving", press button to stop. Second press below will close ie: reverse
                this.pressButton();
                this.lastDoorStatus = "stopped";
            }
            // "Press" garage opener/closer button, and update HomeKit status to show door moving. 
            // the poll function will update to the open status when sensor triggered
            this.pressButton();
        }
        if (typeof callback === "function") callback();  // do callback if defined
    }

    getDoorPosition(callback) {    
        var position = this.currentDoorStatus;
        if (typeof callback === "function") callback(null, position);  // do callback if defined

        return position;
    }

    pressButton() {
        if (this.deviceData.GPIO_PushButton == 0) {
            return;
        }

        // Simulate pressing the controller button
        // Write high out first to trigger relay, then wait defined millisecond period and put back to low to untrigger
        GPIO.write(this.deviceData.GPIO_PushButton, GPIO.HIGH);
        GPIO.msleep(500);
        GPIO.write(this.deviceData.GPIO_PushButton, GPIO.LOW);
        GPIO.msleep(500);
    }

    isOpened() {
        if (this.deviceData.GPIO_OpenSensor == 0) {
            return;
        }

        return (GPIO.read(this.deviceData.GPIO_OpenSensor) == GPIO.HIGH ? true : false);  // If high on sensor, means door is opened
    }

    isClosed() {
        if (this.deviceData.GPIO_ClosedSensor == 0) {
            return;
        }

        return (GPIO.read(this.deviceData.GPIO_ClosedSensor) == GPIO.HIGH ? true : false);  // If high on sensor, means door is closed
    }

    hasObstruction() {
        if (this.deviceData.GPIO_ObstructionSensor == 0) {
            return;
        }

        return (GPIO.read(this.deviceData.GPIO_ObstructionSensor) == GPIO.HIGH ? true : false); // If high, obstruction detected
    }

    messageHomeKitServices(messageType, messageData) {
        if (messageType == DOOREVENT) {
            if (messageData.status == "closed" && this.currentDoorStatus != HAP.Characteristic.CurrentDoorState.CLOSED) {
                // Closed
                outputLogging(ACCESSORYNAME, true, "Door on '%s' is closed", this.deviceData.description);
                this.doorService.updateCharacteristic(HAP.Characteristic.StatusFault, HAP.Characteristic.StatusFault.NO_FAULT);
                this.doorService.updateCharacteristic(HAP.Characteristic.CurrentDoorState, HAP.Characteristic.CurrentDoorState.CLOSED);
                this.doorService.updateCharacteristic(HAP.Characteristic.TargetDoorState, HAP.Characteristic.CurrentDoorState.CLOSED);
                this.currentDoorStatus = HAP.Characteristic.CurrentDoorState.CLOSED;

                if (this.HomeKitHistory != null) {
                    var historyEntry = this.HomeKitHistory.lastHistory(this.doorService);
                    if (historyEntry == null || (typeof historyEntry == "object" && historyEntry.status != 0)) {
                        // only log entry if last recorded entry is different, helps with restarts
                        this.HomeKitHistory.addHistory(this.doorService, {time: Math.floor(Date.now() / 1000), status: 0}); // closed
                    }
                }
            }

            if (messageData.status == "open" && this.currentDoorStatus != HAP.Characteristic.CurrentDoorState.OPEN) {
                // Open
                outputLogging(ACCESSORYNAME, true, "Door on '%s' is open", this.deviceData.description);
                this.doorService.updateCharacteristic(HAP.Characteristic.StatusFault, HAP.Characteristic.StatusFault.NO_FAULT);
                this.doorService.updateCharacteristic(HAP.Characteristic.CurrentDoorState, HAP.Characteristic.CurrentDoorState.OPEN);
                this.doorService.updateCharacteristic(HAP.Characteristic.TargetDoorState, HAP.Characteristic.CurrentDoorState.OPEN);
                this.currentDoorStatus = HAP.Characteristic.CurrentDoorState.OPEN;

                if (this.HomeKitHistory != null) {
                    var historyEntry = this.HomeKitHistory.lastHistory(this.doorService);
                    if (historyEntry == null || (typeof historyEntry == "object" && historyEntry.status != 1)) {
                        // only log entry if last recorded entry is different, helps with restarts
                        this.HomeKitHistory.addHistory(this.doorService, {time: Math.floor(Date.now() / 1000), status: 1}); // open
                    }
                }
            }
            
            if (messageData.status == "moving") {
                // Moving
                this.doorService.updateCharacteristic(HAP.Characteristic.StatusFault, HAP.Characteristic.StatusFault.NO_FAULT);
                if (messageData.last == "closed" && this.currentDoorStatus != HAP.Characteristic.CurrentDoorState.OPENING) {
                    // Since door was last closed, and now its moving, assume its opening
                    outputLogging(ACCESSORYNAME, true, "Door on '%s' is opening", this.deviceData.description);
                    this.doorService.updateCharacteristic(HAP.Characteristic.CurrentDoorState, HAP.Characteristic.CurrentDoorState.OPENING);
                    this.doorService.updateCharacteristic(HAP.Characteristic.TargetDoorState, HAP.Characteristic.CurrentDoorState.OPEN);
                    this.currentDoorStatus = HAP.Characteristic.CurrentDoorState.OPENING;
                }
                if (messageData.last == "open" && this.currentDoorStatus != HAP.Characteristic.CurrentDoorState.CLOSING) {
                    // Since door was last open, and now its moving, assume its closing
                    outputLogging(ACCESSORYNAME, true, "Door on '%s' is closing", this.deviceData.description);
                    this.doorService.updateCharacteristic(HAP.Characteristic.CurrentDoorState, HAP.Characteristic.CurrentDoorState.CLOSING);
                    this.doorService.updateCharacteristic(HAP.Characteristic.TargetDoorState, HAP.Characteristic.CurrentDoorState.CLOSED);
                    this.currentDoorStatus = HAP.Characteristic.CurrentDoorState.CLOSING;
                }
            }

            if (messageData.status == "stopped") {
                // Stopped
                if (this.currentDoorStatus != HAP.Characteristic.CurrentDoorState.STOPPED) {
                    outputLogging(ACCESSORYNAME, true, "Door on '%s' has stopped moving", this.deviceData.description);
                    this.doorService.updateCharacteristic(HAP.Characteristic.StatusFault, HAP.Characteristic.StatusFault.NO_FAULT);
                    this.doorService.updateCharacteristic(HAP.Characteristic.CurrentDoorState, HAP.Characteristic.CurrentDoorState.STOPPED);
                    this.doorService.updateCharacteristic(HAP.Characteristic.TargetDoorState, HAP.Characteristic.CurrentDoorState.OPEN);
                    this.currentDoorStatus = HAP.Characteristic.CurrentDoorState.STOPPED;

                    if (this.HomeKitHistory != null) {
                        var historyEntry = this.HomeKitHistory.lastHistory(this.doorService);
                        if (historyEntry == null || (typeof historyEntry == "object" && historyEntry.status != 1)) {
                            // only log entry if last recorded entry is different, helps with restarts
                            this.HomeKitHistory.addHistory(this.doorService, {time: Math.floor(Date.now() / 1000), status: 1}); // open
                        }
                    }
                }
            }
            
            if (messageData.status == "fault") {
                // Faulty sensors
                outputLogging(ACCESSORYNAME, true, "Door on '%s' is reporting faulty sensors", this.deviceData.description);
                this.doorService.updateCharacteristic(HAP.Characteristic.StatusFault, HAP.Characteristic.StatusFault.GENERAL_FAULT);
                this.doorService.updateCharacteristic(HAP.Characteristic.CurrentDoorState, HAP.Characteristic.CurrentDoorState.STOPPED);
                // What should current door status be???
            }

            if (messageData.status == "obstruction" || messageData.status == "clear") {
                // Door obstruction, either active or cleared
                this.doorService.updateCharacteristic(HAP.Characteristic.ObstructionDetected, (messageData.status == "obstruction" ? true : false));
                // <---- Implement. Do we stop door from being closed if obstructed? or just allow to open?? or not allow movement at all?
            }
        }
    }

    #doorStatusLoop() {
        var doorOpen = this.isOpened();
        var doorClosed = this.isClosed();
        var obstruction = this.hasObstruction();

        // Work out the current status of the door. This will either be "open", "closed", "moving", "stopped"
        // We'll send a message about its status once determined
        if (doorClosed == true && doorOpen == false) {
            // Door is fully closed
            this.movingTimer = 0;
            this.lastDoorStatus = "closed";
            this.eventEmitter.emit(this.deviceData.uuid, DOOREVENT, {"status" : "closed"});
        }
        if (doorClosed == false && doorOpen == true) {
            // Door is fully open
            this.movingTimer = 0;
            this.lastDoorStatus = "open";
            this.eventEmitter.emit(this.deviceData.uuid, DOOREVENT, {"status" : "open"});
        }
        if (doorClosed == false && doorOpen == false) {
            // Door is neither open or closed, so door is either moving or stopped.
            if (this.movingTimer == 0) {
                this.movingTimer = Date.now();  // Time we detected first movement from either open or closed

                if (this.lastDoorStatus == "stopped") {
                    // Detected movement after stopped state, ie: we've pressed the push button
                    // Stopped state is assumed to be door open, as neither detected open or closed
                    this.lastDoorStatus = "open";
                }
            }
            
            var duration = Math.floor(Date.now()) - this.movingTimer;
            if (this.lastDoorStatus == "unknown" || this.lastDoorStatus == "stopped" || this.lastDoorStatus == "open" && duration > this.deviceData.CloseTime || this.lastDoorStatus == "closed" && duration > this.deviceData.OpenTime) {
                // We haven't determined the last door state of either open or closed OR last status of either open or closed status and moving time has been exceeded for configured times
                // In this case we'll assume door has stopped
                this.lastDoorStatus = "stopped";
                this.eventEmitter.emit(this.deviceData.uuid, DOOREVENT, {"status" : "stopped"});
            } else {
                this.eventEmitter.emit(this.deviceData.uuid, DOOREVENT, {"status" : "moving", "last" : this.lastDoorStatus, "duration" : duration});
            }
        }
        if (doorClosed == true && doorOpen == true) {
            // Is reading both open and close, we'll assume fault with sensors
            this.eventEmitter.emit(this.deviceData.uuid, DOOREVENT, {"status" : "fault", "last" : this.lastDoorStatus});
        }

        if (obstruction != undefined) {
            // Since obstruction didn't return an undefined value, this means we have a configured obstruction sensor and its returned its status
            this.eventEmitter.emit(this.deviceData.uuid, DOOREVENT, {"status" : (obstruction == true ? "obstruction" : "clear")});
        }
    }
}


// Configuration class
//
// Handles system configuration file
const CONFIGURATIONFILE = "GarageDoor_config.json";         // Default configuration file name, located in current directory

class Configuration {
    constructor(configurationFiler) {
        this.loaded = false;                                // Have we loaded a configuration
        this.configurationFile = configurationFile;         // Configuration file path/name
        
        this.doors = [];                                    // Array of doors from configuration

        // Load configuration
        if (this.configurationFile == "" || fs.existsSync(this.configurationFile) == false) {
            return;
        }

        try {
            var config = JSON.parse(fs.readFileSync(this.configurationFile));
            this.loaded = true; // Loaded

            Object.entries(config).forEach(([doorName, doorConfig], index) => {
                var tempDoor = {};
                tempDoor.MacAddress = this.#getSystemMACAddress();
                tempDoor.Name = "Door " + (index + 1);
                tempDoor.PushButton = 0;
                tempDoor.ClosedSensor = 0;
                tempDoor.OpenSensor = 0;
                tempDoor.ObstructionSensor = 0;
                tempDoor.OpenTime = 0;
                tempDoor.CloseTime = 0;
                tempDoor.EveApp = false;
                tempDoor.SerialNumber = this.#crc32(tempDoor.MacAddress + index).toString();   // Create a random serial number by default
                tempDoor.Model = "HomeKit Garage Door";
                tempDoor.Manufacturer = ACCESSORYNAME;
                Object.entries(doorConfig).forEach(([key, value]) => {
                    if (key == "EveApp" && typeof value == "boolean") {
                        tempDoor.EveApp = value;
                    }
                    if (key == "PushButton" && typeof value == "number") {
                        tempDoor.PushButton = parseInt(value);
                    }
                    if (key == "ClosedSensor" && typeof value == "number") {
                        tempDoor.ClosedSensor = parseInt(value);
                    }
                    if (key == "OpenSensor" && typeof value == "number") {
                        tempDoor.OpenSensor = parseInt(value);
                    }
                    if (key == "ObstructionSensor" && typeof value == "number") {
                        tempDoor.ObstructionSensor = parseInt(value);
                    }
                    if (key == "SerialNumber" == true && typeof value == "string" && value != "") {
                        tempDoor.SerialNumber = value.trim();
                    }
                    if (key == "Model" == true && typeof value == "string" && value != "") {
                        tempDoor.Model = value.trim();
                    }
                    if (key == "Name" == true && typeof value == "string" && value != "") {
                        tempDoor.Name = HomeKitDevice.validateHomeKitName(value);
                    }
                    if (key == "Manufacturer" == true && typeof value == "string" && value != "") {
                        tempDoor.Manufacturer = value.trim();
                    }
                    if (key == "OpenTime" && typeof value == "number") {
                        if (value < 1000) value = value * 1000;  // If less 1000, assume seconds value passed in, so convert to milliseconds
                        tempDoor.OpenTime = value;
                    }
                    if (key == "CloseTime" && typeof value == "number") {
                        if (value < 1000) value = value * 1000;  // If less 1000, assume seconds value passed in, so convert to milliseconds
                        tempDoor.CloseTime = value;
                    }
                    if (key == "MacAddress" == true && typeof value == "string" && value != "") {
                        // Validate that the mac address is in format of xx:xx:xx:xx:xx:xx
                        if (HomeKitDevice.validMACAddress(value.trim()) == true) {
                            tempDoor.MacAddress = value.trim().toUpperCase();
                        }
                    }
                });

                this.doors.push(tempDoor);
            });
        }
        catch (error) {
        }
    }

    #getSystemMACAddress() {
        // todo - determine active connection, either wifi or ethernet.
        var systemMAC = "00:00:00:00:00:00";
        var networkInterfaces = os.networkInterfaces();
    
        Object.keys(networkInterfaces).forEach(network => {
            networkInterfaces[network].forEach(network => {
                if ((network.family.toUpperCase() == "IPV4" || network.internal == true) && network.mac != "00:00:00:00:00:00") {
                    // found a MAC address
                    systemMAC = network.mac.toUpperCase(); 
                }
            });
        });

        return systemMAC;
    }

    #crc32(valueToHash) {
        var crc32HashTable = [
            0x000000000, 0x077073096, -0x11f19ed4, -0x66f6ae46, 0x0076dc419, 0x0706af48f, -0x169c5acb, -0x619b6a5d, 
            0x00edb8832, 0x079dcb8a4, -0x1f2a16e2, -0x682d2678, 0x009b64c2b, 0x07eb17cbd, -0x1847d2f9, -0x6f40e26f, 
            0x01db71064, 0x06ab020f2, -0xc468eb8, -0x7b41be22, 0x01adad47d, 0x06ddde4eb, -0xb2b4aaf, -0x7c2c7a39, 
            0x0136c9856, 0x0646ba8c0, -0x29d0686, -0x759a3614, 0x014015c4f, 0x063066cd9, -0x5f0c29d, -0x72f7f20b, 
            0x03b6e20c8, 0x04c69105e, -0x2a9fbe1c, -0x5d988e8e, 0x03c03e4d1, 0x04b04d447, -0x2df27a03, -0x5af54a95, 
            0x035b5a8fa, 0x042b2986c, -0x2444362a, -0x534306c0, 0x032d86ce3, 0x045df5c75, -0x2329f231, -0x542ec2a7, 
            0x026d930ac, 0x051de003a, -0x3728ae80, -0x402f9eea, 0x021b4f4b5, 0x056b3c423, -0x30456a67, -0x47425af1, 
            0x02802b89e, 0x05f058808, -0x39f3264e, -0x4ef416dc, 0x02f6f7c87, 0x058684c11, -0x3e9ee255, -0x4999d2c3, 
            0x076dc4190, 0x001db7106, -0x672ddf44, -0x102aefd6, 0x071b18589, 0x006b6b51f, -0x60401b5b, -0x17472bcd, 
            0x07807c9a2, 0x00f00f934, -0x69f65772, -0x1ef167e8, 0x07f6a0dbb, 0x0086d3d2d, -0x6e9b9369, -0x199ca3ff, 
            0x06b6b51f4, 0x01c6c6162, -0x7a9acf28, -0xd9dffb2, 0x06c0695ed, 0x01b01a57b, -0x7df70b3f, -0xaf03ba9, 
            0x065b0d9c6, 0x012b7e950, -0x74414716, -0x3467784, 0x062dd1ddf, 0x015da2d49, -0x732c830d, -0x42bb39b, 
            0x04db26158, 0x03ab551ce, -0x5c43ff8c, -0x2b44cf1e, 0x04adfa541, 0x03dd895d7, -0x5b2e3b93, -0x2c290b05, 
            0x04369e96a, 0x0346ed9fc, -0x529877ba, -0x259f4730, 0x044042d73, 0x033031de5, -0x55f5b3a1, -0x22f28337, 
            0x05005713c, 0x0270241aa, -0x41f4eff0, -0x36f3df7a, 0x05768b525, 0x0206f85b3, -0x46992bf7, -0x319e1b61, 
            0x05edef90e, 0x029d9c998, -0x4f2f67de, -0x3828574c, 0x059b33d17, 0x02eb40d81, -0x4842a3c5, -0x3f459353, 
            -0x12477ce0, -0x65404c4a, 0x003b6e20c, 0x074b1d29a, -0x152ab8c7, -0x622d8851, 0x004db2615, 0x073dc1683, 
            -0x1c9cf4ee, -0x6b9bc47c, 0x00d6d6a3e, 0x07a6a5aa8, -0x1bf130f5, -0x6cf60063, 0x00a00ae27, 0x07d079eb1, 
            -0xff06cbc, -0x78f75c2e, 0x01e01f268, 0x06906c2fe, -0x89da8a3, -0x7f9a9835, 0x0196c3671, 0x06e6b06e7, 
            -0x12be48a, -0x762cd420, 0x010da7a5a, 0x067dd4acc, -0x6462091, -0x71411007, 0x017b7be43, 0x060b08ed5, 
            -0x29295c18, -0x5e2e6c82, 0x038d8c2c4, 0x04fdff252, -0x2e44980f, -0x5943a899, 0x03fb506dd, 0x048b2364b, 
            -0x27f2d426, -0x50f5e4b4, 0x036034af6, 0x041047a60, -0x209f103d, -0x579820ab, 0x0316e8eef, 0x04669be79, 
            -0x349e4c74, -0x43997ce6, 0x0256fd2a0, 0x05268e236, -0x33f3886b, -0x44f4b8fd, 0x0220216b9, 0x05505262f, 
            -0x3a45c442, -0x4d42f4d8, 0x02bb45a92, 0x05cb36a04, -0x3d280059, -0x4a2f30cf, 0x02cd99e8b, 0x05bdeae1d, 
            -0x649b3d50, -0x139c0dda, 0x0756aa39c, 0x0026d930a, -0x63f6f957, -0x14f1c9c1, 0x072076785, 0x005005713, 
            -0x6a40b57e, -0x1d4785ec, 0x07bb12bae, 0x00cb61b38, -0x6d2d7165, -0x1a2a41f3, 0x07cdcefb7, 0x00bdbdf21, 
            -0x792c2d2c, -0xe2b1dbe, 0x068ddb3f8, 0x01fda836e, -0x7e41e933, -0x946d9a5, 0x06fb077e1, 0x018b74777, 
            -0x77f7a51a, -0xf09590, 0x066063bca, 0x011010b5c, -0x709a6101, -0x79d5197, 0x0616bffd3, 0x0166ccf45, 
            -0x5ff51d88, -0x28f22d12, 0x04e048354, 0x03903b3c2, -0x5898d99f, -0x2f9fe909, 0x04969474d, 0x03e6e77db, 
            -0x512e95b6, -0x2629a524, 0x040df0b66, 0x037d83bf0, -0x564351ad, -0x2144613b, 0x047b2cf7f, 0x030b5ffe9, 
            -0x42420de4, -0x35453d76, 0x053b39330, 0x024b4a3a6, -0x452fc9fb, -0x3228f96d, 0x054de5729, 0x023d967bf, 
            -0x4c9985d2, -0x3b9eb548, 0x05d681b02, 0x02a6f2b94, -0x4bf441c9, -0x3cf3715f, 0x05a05df1b, 0x02d02ef8d
        ]
        var crc32 = 0xffffffff; // init crc32 hash;
        valueToHash = Buffer.from(valueToHash);    // convert value into buffer for processing
        for (var index = 0; index < valueToHash.length; index++) {
            crc32 = (crc32HashTable[(crc32 ^ valueToHash[index]) & 0xff] ^ crc32 >>> 8) & 0xffffffff;
        }
        crc32 ^= 0xffffffff;
        return crc32 >>> 0;    // return crc32
    }
}


// General functions
function outputLogging(accessoryName, useConsoleDebug, ...outputMessage) {
    var timeStamp = String(new Date().getFullYear()).padStart(4, "0") + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0") + " " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + ":" + String(new Date().getSeconds()).padStart(2, "0");
    if (useConsoleDebug == false) {
        console.log(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
    if (useConsoleDebug == true) {
        console.debug(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
}


// Startup code
var eventEmitter = new EventEmitter();  // Need a global event emitter. Will be used for messaging between our classes we create

outputLogging(ACCESSORYNAME, false, "Starting " +  __filename + " using HAP-NodeJS library v" + HAP.HAPLibraryVersion());

// Check to see if a configuration file was passed into use and validate if present
var configurationFile = __dirname + "/" + CONFIGURATIONFILE;
if (process.argv.slice(2).length == 1) {  // We only support/process one argument
    configurationFile = process.argv.slice(2)[0];   // Extract the file name from the argument passed in
    if (configurationFile.indexOf("/") == -1) {
        configurationFile = __dirname + "/" + configurationFile;
    }
}
if (fs.existsSync(configurationFile) == false) {
    // Configuration file, either by default name or specified on commandline is missing
    outputLogging(ACCESSORYNAME, false, "Specified configuration '%s' cannot be found", configurationFile);
    outputLogging(ACCESSORYNAME, false, "Exiting.");
    return;
}

// Have a configuration file, now load the configuration options
outputLogging(ACCESSORYNAME, false, "Configuration will be read from '%s'", configurationFile);
var config = new Configuration(configurationFile, eventEmitter); // Load configuration details from specified file.
if (config.loaded == false) {
    outputLogging(ACCESSORYNAME, false, "Configuration file '%s' contains invalid options", configurationFile);
    outputLogging(ACCESSORYNAME, false, "Exiting.");
    return;
}

if (config.loaded == true && config.doors.length > 0) {
    // Init the GPIO (RPIO) library. This only needs to be done once before using library functions
    GPIO.init({gpiomem: true});
    GPIO.init({mapping: "gpio"});

    // For each door in our configuration, create the HomeKit accessory
    config.doors.forEach((door) => {
        var deviceData = {};
        deviceData.uuid = door.MacAddress;
        deviceData.mac_address = door.MacAddress;
        deviceData.serial_number = door.SerialNumber;
        deviceData.software_version = HAP.HAPLibraryVersion();
        deviceData.description = door.Manufacturer;
        deviceData.location = "";
        deviceData.manufacturer = door.Manufacturer;
        deviceData.model = door.Model;
        deviceData.EveApp = door.EveApp;
        deviceData.GPIO_PushButton = door.PushButton;
        deviceData.GPIO_OpenSensor = door.OpenSensor;
        deviceData.GPIO_ClosedSensor = door.ClosedSensor;
        deviceData.GPIO_ObstructionSensor = door.ObstructionSensor;
        deviceData.OpenTime = door.OpenTime;
        deviceData.CloseTime = door.CloseTime;

        var tempDevice = new GarageDoor(deviceData, eventEmitter);
        tempDevice.add("Garage Door", HAP.Categories.GARAGE_DOOR_OPENER, true);
    });
}