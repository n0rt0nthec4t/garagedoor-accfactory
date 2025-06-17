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
// Usage: node dist/index.js [optional-config.json]
//
// todo
// -- Get obstruction code working and verifed
//
// Code Version 2025/06/18
// Mark Hulskamp
'use strict';

// Define HAP-NodeJS module requirements
import HAP from '@homebridge/hap-nodejs';

// Define nodejs module requirements
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Import our modules
import GarageDoor from './door.js';

import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'garagedoor-accfactory';
HomeKitDevice.PLATFORM_NAME = 'GarageDoorAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

import Logger from './logger.js';
const log = Logger.withPrefix(HomeKitDevice.PLATFORM_NAME);

// Define constants
const { version } = createRequire(import.meta.url)('../package.json'); // Import the package.json file to get the version number
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const ACCESSORY_PINCODE = '031-45-154'; // Default HomeKit pairing code
const CONFIGURATION_FILE = 'GarageDoor.json'; // Default configuration file name

// General helper functions
function loadConfiguration(filename) {
  if (typeof filename !== 'string' || filename === '' || fs.existsSync(filename) === false) {
    return;
  }

  let config = undefined;

  try {
    let loadedConfig = JSON.parse(fs.readFileSync(filename, 'utf8').trim());

    config = {
      doors: [],
      options: {
        debug: false,
        eveHistory: true,
        hkPairingCode: ACCESSORY_PINCODE,
      },
    };

    Object.entries(loadedConfig).forEach(([key, value]) => {
      if (key === 'doors' && Array.isArray(value) === true) {
        // Validate doors section
        let unnamedCount = 1;
        value.forEach((door) => {
          let tempDoor = {
            hkUsername:
              typeof door?.hkUsername === 'string' && door.hkUsername !== ''
                ? door.hkUsername.trim()
                : crypto
                    .randomBytes(6)
                    .toString('hex')
                    .toUpperCase()
                    .split(/(..)/)
                    .filter((s) => s)
                    .join(':'),
            name:
              typeof door?.name === 'string' && door.name !== ''
                ? HomeKitDevice.makeValidHKName(door.name.trim())
                : 'Door ' + unnamedCount++,
            manufacturer: typeof door?.manufacturer === 'string' && door.manufacturer !== '' ? door.manufacturer.trim() : '',
            model: typeof door?.model === 'string' && door.model !== '' ? door.model.trim() : '',
            serialNumber:
              typeof door?.serialNumber === 'string' && door.serialNumber !== ''
                ? door.serialNumber.trim()
                : crc32(crypto.randomUUID().toUpperCase()).toString(),
            pushButton:
              isNaN(door?.pushButton) === false &&
              Number(door.pushButton) >= GarageDoor.MIN_GPIO_PIN &&
              Number(door.pushButton) <= GarageDoor.MAX_GPIO_PIN
                ? Number(door.pushButton)
                : undefined,
            closedSensor:
              isNaN(door?.closedSensor) === false &&
              Number(door.closedSensor) >= GarageDoor.MIN_GPIO_PIN &&
              Number(door.closedSensor) <= GarageDoor.MAX_GPIO_PIN
                ? Number(door.closedSensor)
                : undefined,
            openSensor:
              isNaN(door?.openSensor) === false &&
              Number(door.openSensor) >= GarageDoor.MIN_GPIO_PIN &&
              Number(door.openSensor) <= GarageDoor.MAX_GPIO_PIN
                ? Number(door.openSensor)
                : undefined,
            obstructionSensor:
              isNaN(door?.obstructionSensor) === false &&
              Number(door.obstructionSensor) >= GarageDoor.MIN_GPIO_PIN &&
              Number(door.obstructionSensor) <= GarageDoor.MAX_GPIO_PIN
                ? Number(door.obstructionSensor)
                : undefined,
            openTime: isNaN(door?.openTime) === false && Number(door.openTime) >= 0 && Number(door.openTime) <= 300 ? door.openTime : 30,
            closeTime:
              isNaN(door?.closeTime) === false && Number(door.closeTime) >= 0 && Number(door.closeTime) <= 300 ? door.closeTime : 30,
          };

          config.doors.push(tempDoor);
        });
      }
      if (key === 'options' && Array.isArray(value) === false && typeof value === 'object') {
        config.options.debug = value?.debug === true;
        config.options.eveHistory = value?.eveHistory === true;
        config.options.hkPairingCode =
          HomeKitDevice.HK_PIN_3_2_3.test(value?.hkPairingCode) === true || HomeKitDevice.HK_PIN_4_4.test(value?.hkPairingCode) === true
            ? value.hkPairingCode
            : ACCESSORY_PINCODE;
      }
    });

    // Write config backout!!
    fs.writeFileSync(filename, JSON.stringify(config, null, 3));

    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    // Empty
  }

  return config;
}

function crc32(valueToHash) {
  let crc32HashTable = [
    0x000000000, 0x077073096, -0x11f19ed4, -0x66f6ae46, 0x0076dc419, 0x0706af48f, -0x169c5acb, -0x619b6a5d, 0x00edb8832, 0x079dcb8a4,
    -0x1f2a16e2, -0x682d2678, 0x009b64c2b, 0x07eb17cbd, -0x1847d2f9, -0x6f40e26f, 0x01db71064, 0x06ab020f2, -0xc468eb8, -0x7b41be22,
    0x01adad47d, 0x06ddde4eb, -0xb2b4aaf, -0x7c2c7a39, 0x0136c9856, 0x0646ba8c0, -0x29d0686, -0x759a3614, 0x014015c4f, 0x063066cd9,
    -0x5f0c29d, -0x72f7f20b, 0x03b6e20c8, 0x04c69105e, -0x2a9fbe1c, -0x5d988e8e, 0x03c03e4d1, 0x04b04d447, -0x2df27a03, -0x5af54a95,
    0x035b5a8fa, 0x042b2986c, -0x2444362a, -0x534306c0, 0x032d86ce3, 0x045df5c75, -0x2329f231, -0x542ec2a7, 0x026d930ac, 0x051de003a,
    -0x3728ae80, -0x402f9eea, 0x021b4f4b5, 0x056b3c423, -0x30456a67, -0x47425af1, 0x02802b89e, 0x05f058808, -0x39f3264e, -0x4ef416dc,
    0x02f6f7c87, 0x058684c11, -0x3e9ee255, -0x4999d2c3, 0x076dc4190, 0x001db7106, -0x672ddf44, -0x102aefd6, 0x071b18589, 0x006b6b51f,
    -0x60401b5b, -0x17472bcd, 0x07807c9a2, 0x00f00f934, -0x69f65772, -0x1ef167e8, 0x07f6a0dbb, 0x0086d3d2d, -0x6e9b9369, -0x199ca3ff,
    0x06b6b51f4, 0x01c6c6162, -0x7a9acf28, -0xd9dffb2, 0x06c0695ed, 0x01b01a57b, -0x7df70b3f, -0xaf03ba9, 0x065b0d9c6, 0x012b7e950,
    -0x74414716, -0x3467784, 0x062dd1ddf, 0x015da2d49, -0x732c830d, -0x42bb39b, 0x04db26158, 0x03ab551ce, -0x5c43ff8c, -0x2b44cf1e,
    0x04adfa541, 0x03dd895d7, -0x5b2e3b93, -0x2c290b05, 0x04369e96a, 0x0346ed9fc, -0x529877ba, -0x259f4730, 0x044042d73, 0x033031de5,
    -0x55f5b3a1, -0x22f28337, 0x05005713c, 0x0270241aa, -0x41f4eff0, -0x36f3df7a, 0x05768b525, 0x0206f85b3, -0x46992bf7, -0x319e1b61,
    0x05edef90e, 0x029d9c998, -0x4f2f67de, -0x3828574c, 0x059b33d17, 0x02eb40d81, -0x4842a3c5, -0x3f459353, -0x12477ce0, -0x65404c4a,
    0x003b6e20c, 0x074b1d29a, -0x152ab8c7, -0x622d8851, 0x004db2615, 0x073dc1683, -0x1c9cf4ee, -0x6b9bc47c, 0x00d6d6a3e, 0x07a6a5aa8,
    -0x1bf130f5, -0x6cf60063, 0x00a00ae27, 0x07d079eb1, -0xff06cbc, -0x78f75c2e, 0x01e01f268, 0x06906c2fe, -0x89da8a3, -0x7f9a9835,
    0x0196c3671, 0x06e6b06e7, -0x12be48a, -0x762cd420, 0x010da7a5a, 0x067dd4acc, -0x6462091, -0x71411007, 0x017b7be43, 0x060b08ed5,
    -0x29295c18, -0x5e2e6c82, 0x038d8c2c4, 0x04fdff252, -0x2e44980f, -0x5943a899, 0x03fb506dd, 0x048b2364b, -0x27f2d426, -0x50f5e4b4,
    0x036034af6, 0x041047a60, -0x209f103d, -0x579820ab, 0x0316e8eef, 0x04669be79, -0x349e4c74, -0x43997ce6, 0x0256fd2a0, 0x05268e236,
    -0x33f3886b, -0x44f4b8fd, 0x0220216b9, 0x05505262f, -0x3a45c442, -0x4d42f4d8, 0x02bb45a92, 0x05cb36a04, -0x3d280059, -0x4a2f30cf,
    0x02cd99e8b, 0x05bdeae1d, -0x649b3d50, -0x139c0dda, 0x0756aa39c, 0x0026d930a, -0x63f6f957, -0x14f1c9c1, 0x072076785, 0x005005713,
    -0x6a40b57e, -0x1d4785ec, 0x07bb12bae, 0x00cb61b38, -0x6d2d7165, -0x1a2a41f3, 0x07cdcefb7, 0x00bdbdf21, -0x792c2d2c, -0xe2b1dbe,
    0x068ddb3f8, 0x01fda836e, -0x7e41e933, -0x946d9a5, 0x06fb077e1, 0x018b74777, -0x77f7a51a, -0xf09590, 0x066063bca, 0x011010b5c,
    -0x709a6101, -0x79d5197, 0x0616bffd3, 0x0166ccf45, -0x5ff51d88, -0x28f22d12, 0x04e048354, 0x03903b3c2, -0x5898d99f, -0x2f9fe909,
    0x04969474d, 0x03e6e77db, -0x512e95b6, -0x2629a524, 0x040df0b66, 0x037d83bf0, -0x564351ad, -0x2144613b, 0x047b2cf7f, 0x030b5ffe9,
    -0x42420de4, -0x35453d76, 0x053b39330, 0x024b4a3a6, -0x452fc9fb, -0x3228f96d, 0x054de5729, 0x023d967bf, -0x4c9985d2, -0x3b9eb548,
    0x05d681b02, 0x02a6f2b94, -0x4bf441c9, -0x3cf3715f, 0x05a05df1b, 0x02d02ef8d,
  ];
  let crc32 = 0xffffffff; // init crc32 hash;
  valueToHash = Buffer.from(valueToHash); // convert value into buffer for processing
  for (var index = 0; index < valueToHash.length; index++) {
    crc32 = (crc32HashTable[(crc32 ^ valueToHash[index]) & 0xff] ^ (crc32 >>> 8)) & 0xffffffff;
  }
  crc32 ^= 0xffffffff;
  return crc32 >>> 0; // return crc32
}

// Startup code
log.success(HomeKitDevice.PLUGIN_NAME + ' v' + version + ' (HAP v' + HAP.HAPLibraryVersion() + ') (Node v' + process.versions.node + ')');

// Check to see if a configuration file was passed into use and validate if present
let configurationFile = path.resolve(__dirname, CONFIGURATION_FILE);
let argFile = process.argv[2];
if (typeof argFile === 'string') {
  configurationFile = path.isAbsolute(argFile) ? argFile : path.resolve(process.cwd(), argFile);
}

if (fs.existsSync(configurationFile) === false) {
  // Configuration file, either by default name or specified on commandline is missing
  log.error('Specified configuration "%s" cannot be found', configurationFile);
  process.exit(1);
}

// Have a configuration file, now load the configuration options
let config = loadConfiguration(configurationFile);
if (config === undefined) {
  log.error('Configuration "%s" contains invalid JSON or structure', configurationFile);
  process.exit(1);
}

// Check to see we have atleast ONE door defined
if (config.doors.length < 1) {
  log.info('Configuration file does not have any doors defined. Please review configuration');
  process.exit(1);
}

log.info('Loaded configuration from "%s"', configurationFile);

// Enable debugging if configured
if (config?.options?.debug === true) {
  Logger.setDebugEnabled();
  log.warn('Debugging has been enabled');
}

// For each door in our configuration, create the HomeKit accessory
config.doors.forEach((door) => {
  let deviceData = {
    hkPairingCode: config.options.hkPairingCode,
    hkUsername: door.hkUsername,
    serialNumber: door.serialNumber,
    softwareVersion: version,
    manufacturer: door.manufacturer,
    model: door.model,
    description: (door.manufacturer + ' ' + door.model).trim() || 'Garage Door',
    eveHistory: config.options.eveHistory,
    pushButton: door.pushButton,
    openSensor: door.openSensor,
    closedSensor: door.closedSensor,
    obstructionSensor: door.obstructionSensor,
    openTime: door.openTime,
    closeTime: door.closeTime,
  };
  let tempDevice = new GarageDoor(undefined, HAP, log, deviceData);
  tempDevice.add('Garage Door', HAP.Categories.GARAGE_DOOR_OPENER, true);
});
