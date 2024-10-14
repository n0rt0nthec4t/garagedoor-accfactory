<span align="center">

# HomeKit GarageDoor Opener System

[![version](https://img.shields.io/github/package-json/v/n0rt0nthec4t/GarageDoor_Accfactory)](https://img.shields.io/github/package-json/v/n0rt0nthec4t/GarageDoor_Accfactory)

</span>

## Parts

- Raspberry Pi Zero W
- Pimoroni automation phat (not sure if sold anymore?)

## Garage Door Configuration

The following options are available in GarageDoor_config.json **doors** object, which is a array of defined garage doors.

eg:
```
    "doors": [
        {
            "name" : "Garage Door",
            "manufacturer" : "A Door Company",
            "model" : "MT-1234",
            "serialNumber" : "1234567890",
            "pushButton" : 16,
            "closedSensor" : 26,
            "openSensor" : 20,
            "openTime" : 25,
            "closeTime" : 25
        }
    ]
```

| Name              | Description                                                                                   | Default    |
|-------------------|-----------------------------------------------------------------------------------------------|------------|
| closedSensor      | RPi GPIO pin for door closed sensor                                                           |            |
| closeTime         | Time (in seconds) for door to full close                                                      | 30         |
| hkUsername        | This is automatically generated. DO NOT CHANGE once populated                                 |            |
| manufacturer      | Manufacturer of the garage door opener                                                        |            |
| model             | Model of the garage door opener                                                               |            |
| name              | Name of this garage door                                                                      |            |
| pushButton        | RPi GPIO pin to 'push button' relay                                                           |            |
| openTime          | Time (in seconds) for door to full open                                                       | 30         |
| openSensor        | RPi GPIO pin for door opened sensor                                                           |            |
| obstructionSensor | RPi GPIO pin for door obstruction sensor (optional)                                           |            |
| serialNumber      | Serial Number of the garage door opener                                                       |            |

### Configuration Options

The following options are available in GarageDoor_config.json **options** object.

| Name              | Description                                                                                   | Default    |
|-------------------|-----------------------------------------------------------------------------------------------|------------|
| debug             | Detailed debugging                                                                            | false      |
| eveHistory        | Provide history in EveHome application where applicable                                       | true       |
| hkPairingCode     | HomeKit pairing code in format of "xxx-xx-xxx" or "xxxx-xxxx"                                 | 031-45-154 |