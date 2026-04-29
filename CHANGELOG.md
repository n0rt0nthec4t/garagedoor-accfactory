# Change Log

All notable changes to `garagedoor-accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

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
