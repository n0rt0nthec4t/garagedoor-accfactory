# Change Log

All notable changes to `garagedoor-accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## v0.2.0 (2026/10/11)

### Changed

- Updated `HomeKitUI` to code version `2026.10.11`
- Updated `HomeKitDevice` to code version `2026.10.11`, including shutdown completion and cancelled accessory setup fixes

### Fixed

- Rejected fractional Web UI ports during configuration loading and server startup; port 0 continues to disable the UI
- Validated door configuration before Web UI saves and restores, preserving the existing file when GPIO assignments or settings are invalid; startup uses the same checks
- Registered shutdown handlers before accessory setup, stopped further startup after signals, and awaited every owned door before exit; GPIO cleanup failures now produce a failing exit status without skipping other doors or Web UI cleanup

## v0.1.15 (2026/10/10)

### Added

- Regression tests for door control, sensor and relay failures, shutdown completion, GPIO ownership, and configuration persistence, runnable with `npm test`

### Changed

- Limited formatting and linting to application source files and project tests, leaving Git submodules untouched
- Updated `@homebridge/hap-nodejs` to `^2.2.3` and aligned the declared `hap-nodejs` engine requirement
- Updated `chalk` to `^6.0.1`
- Updated `express` to `^5.3.0`
- Updated `@types/node` to `^26.6.5`
- Updated `@typescript-eslint/parser` to `^8.71.1`
- Updated `eslint` to `^10.12.0`
- Updated `prettier` to `^3.9.9`
- Updated `prettier-eslint` to `^17.1.2`
- Updated `HomeKitDevice` to code version `2026.10.10`
- Updated `HomeKitHistory` to code version `2026.10.09`
- Updated `HomeKitUI` to code version `2026.10.09`
- Invalid or conflicting GPIO assignments now stop startup with an error; pins must be integers from 0 to 26, each pin must have one owner across all doors, and unused sensor fields must be omitted

### Fixed

- Restored accessory setup with the current HomeKitDevice `add()` API, including configured Eve history and Web UI accessory registration
- Prevented overlapping relay operations and duplicate pulses from repeated door commands; shutdown waits for pending commands
- Preserved timed-only endpoint states until another command and restarted movement timing after successful commands and reversals
- Blocked actuation when configured sensors cannot be read or endpoint sensors disagree, preserving detected obstructions across read failures
- Reported relay activation and release failures to HomeKit and retained control faults until a relay release write succeeds
- Preserved existing configuration during failed saves and stopped startup when generated pairing identities could not be persisted
- Used fresh endpoint sensor readings when choosing command pulses, avoiding ignored commands and unnecessary reversals
- Waited for Web UI cleanup before process exit and reported shutdown failures with a nonzero exit status

## v0.1.14 (2026/08/20)

- Updated `@homebridge/hap-nodejs` to `^2.2.2` and aligned the declared `hap-nodejs` engine requirement
- Updated runtime and development dependencies, including Chalk, ESLint, Prettier, and TypeScript tooling
- Added Node.js 26 runtime support and aligned the Node.js type definitions
- Updated `HomeKitDevice` and `HomeKitHistory` modules
- Refreshed transitive dependencies to resolve all reported npm security advisories

## v0.1.13 (2026/05/10)

- Updated `hap-nodejs` requirement to `^2.1.6`
- Updated `HomeKitDevice`, `HomeKitHistory`, and `HomeKitUI` modules
- Updated `GarageDoor` to use the latest `HomeKitDevice` constructor, shared logger setup, and service/characteristic helper method names
- Added Web UI bearer token preservation and authentication wiring
- Improved garage door safety handling for obstruction and sensor fault states
- Added timed-only door state fallback for installations without open/closed sensors

## v0.1.9 (2026/04/29)

- Updated `HomeKitUI` module

## v0.1.7 (2026/04/28)

- Added schema-driven configuration UI with dynamic form rendering
- General UI/UX improvements

## v0.1.6 (2026/03/05)

- General code cleanup and stability improvements
- Refactored `GarageDoor` to use updated `HomeKitDevice` module

## v0.1.5 (2025/10/18)

- Fixed door open/close logic if already in the requested state
- Updated dependancies

## v0.1.4 (2025/06/21)

- More accurate door status detection when using the physical button
- Reversing the door direction (e.g. from opening to closing) now works reliably
- HomeKit always shows the correct door state, even during mid-motion changes
- Improved button handling so the system knows when and how often to press, no extra delay logic needed outside

## v0.1.3 (2025/06/21)

- Improved door movement detection when fully opened/closed via physical control

## v0.1.2 (2025/06/18)

- Updated to use new history functions in `HomeKitDevice` module

## v0.1.0 (2025/06/18)

- Updated for `hap-nodejs@2.0.0`
- Refactored `GarageDoor` to use updated `HomeKitDevice` module
- Improved door state handling and sensor logic

## v0.0.11 (2025/06/15)

- Minor refinements to configuration loading and naming
- Refined door movement and reversal logic for accurate HomeKit status updates.
- Movement timer now resets on direction change to ensure correct stop detection.
- Minor code cleanups and internal state consistency improvements.

## v0.0.2

- General code cleanup and bug fixes

## v0.0.1

- Inital commit of source code
