<span align="center">

# HomeKit Garage Door Opener System

[![version](https://img.shields.io/github/package-json/v/n0rt0nthec4t/garagedoor-accfactory)](https://img.shields.io/github/package-json/v/n0rt0nthec4t/garagedoor-accfactory)

</span>

## Parts

- Raspberry Pi supported by `rpio`, such as a Raspberry Pi Zero W
- Relay interface for the garage door opener's push button, such as a Pimoroni Automation pHAT
- Magnetic reed switches for open and closed position sensing
- Optional obstruction sensor

Use Node.js 22, 24 or 26. GPIO pins use BCM numbering. The controller supports
multiple doors, each with its own HomeKit accessory and optional Eve history.

## Garage Door Configuration

The following options are available in each entry of the **doors** array in
`garagedoor_config.json`. Configure at least one door. Each entry creates a separate
HomeKit accessory.

For example:

```json
{
  "doors": [
    {
      "name": "Garage Door",
      "manufacturer": "A Door Company",
      "model": "MT-1234",
      "pushButton": 16,
      "closedSensor": 26,
      "openSensor": 20,
      "openTime": 30,
      "closeTime": 30,
      "buttonBehavior": "stop-then-reverse"
    }
  ],
  "options": {
    "debug": false,
    "eveHistory": true,
    "hkPairingCode": "031-45-154",
    "webUIPort": 8581,
    "webUIBearerToken": ""
  }
}
```

| Name              | Description                                      | Default                    |
|-------------------|--------------------------------------------------|----------------------------|
| name              | Name of the HomeKit accessory                    | Door 1, Door 2…            |
| manufacturer      | Manufacturer of the garage door opener           | Empty; set before startup  |
| model             | Model of the garage door opener                  | Empty; set before startup  |
| hkUsername        | Automatically generated HomeKit username         | Generated on first startup |
| serialNumber      | Serial number of the garage door opener          | Generated on first startup |
| pushButton        | BCM GPIO pin for the push button relay           | Omitted                    |
| closedSensor      | BCM GPIO pin for the closed position sensor      | Omitted                    |
| openSensor        | BCM GPIO pin for the open position sensor        | Omitted                    |
| obstructionSensor | BCM GPIO pin for the obstruction sensor          | Omitted                    |
| openTime          | Opening duration in seconds, from 0 to 300       | 30                         |
| closeTime         | Closing duration in seconds, from 0 to 300       | 30                         |
| buttonBehavior    | Relay pulse behaviour when reversing movement   | stop-then-reverse          |

Set non-empty `manufacturer` and `model` values for accessory setup. HomeKit
usernames and generated serial numbers are saved atomically before accessories
are published. Keep those identities unchanged once the doors are paired.

GPIO pins must be integers from 0 to 26. Numeric strings are accepted. Each pin
must have one owner across all doors, including relay and sensor pins. Omit
unused sensor fields; `null`, booleans, empty strings and fractional pins are
rejected. Without a valid `pushButton` pin, the door cannot be actuated.

Open and closed sensors provide endpoint feedback. When an endpoint sensor is
omitted, the corresponding movement time provides a timed endpoint estimate.
Timed-only installations cannot recover the physical door position after restart.
Unreadable sensors, contradictory endpoint readings and detected obstructions
block door commands.

`stop-then-reverse` sends two relay pulses when reversing an active movement.
`auto-reverse` and `always-toggle` send one. Choose the behaviour that matches
your opener's push button control.

The Garage Doors page provides Add/Remove controls and editable door settings.
Web UI saves and restores validate the configuration before replacing the file.
Invalid GPIO assignments, port values, movement times, button behaviour and option
types leave the existing file unchanged. Startup uses the same validation, and
configuration validation or save failures stop startup with an error.

Saved changes take effect after restart. Shutdown waits for pending relay
operations, attempts cleanup for every configured GPIO pin and stops the Web UI
before exiting. Signals received during accessory setup stop further startup.
Startup and cleanup failures produce a nonzero exit status.

### Configuration Options

The following options are available in the **options** object in
`garagedoor_config.json`.

| Name             | Description                                             | Default    |
|------------------|---------------------------------------------------------|------------|
| debug            | Detailed debugging                                      | false      |
| eveHistory       | Provide door history in EveHome                         | true       |
| hkPairingCode    | HomeKit pairing code: "xxx-xx-xxx" or "xxxx-xxxx"          | 031-45-154 |
| webUIPort        | Web UI port; 0 disables the Web UI                       | 0          |
| webUIBearerToken | Web UI password; an empty value disables authentication  | Empty      |

When an `options` object is present, set `eveHistory` explicitly to `true` to enable
history.

Web ports must be integers from 0 to 65535. Numeric strings are accepted; invalid
port values are rejected. For example, `webUIPort: 8581` enables the UI at
`http://<pi-address>:8581`.

The UI provides configuration, pairing, logs, backup and restore. Its restart
action exits with status 1 so a process manager configured to restart on failure
can relaunch the application.
