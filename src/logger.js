// Module: Logger
//
// Shared logger for standalone HAP-NodeJS applications.
// Inspired by the Homebridge logger, but simplified for direct application use.\
//
// Taken from https://github.com/homebridge/homebridge/blob/latest/src/logger.ts
// Converted back to JS for using under HAP-NodeJS library directly
//
// Provides terminal logging, colour formatting, in-memory history, and live log
// listeners for web UI streaming.
//
// Responsibilities:
// - Provide prefixed log functions for each application/module
// - Format messages using util.format(...) style placeholders
// - Colour terminal output by log level
// - Keep recent log history in memory
// - Notify listeners when new log entries are written
// - Support HomeKitUI or other consumers without scraping stdout/stderr
//
// Notes:
// - All logger instances share one global history/listener pipeline
// - Prefixes are instance-specific and used only for formatting
// - Debug logging is disabled by default
//
// Code version 2026.04.27
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import console from 'node:console';
import util from 'node:util';

// Define external module requirements
import chalk from 'chalk';
import { AnsiUp } from 'ansi_up';

// Define log level constants
export const LogLevel = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

// Define our logger class
export default class Logger {
  // Shared logger state
  static #ansi = new AnsiUp(); // ANSI/chalk output to HTML converter for UI consumers
  static #debugEnabled = false; // Debug logging disabled by default
  static #history = []; // Recent log history shared by all logger instances
  static #listeners = new Set(); // Live log listeners used by HomeKitUI or other consumers
  static #maxHistory = 500; // Maximum log entries retained in memory
  static #timestampEnabled = true; // Timestamp logging enabled by default

  static internal = new Logger();

  prefix = undefined;

  constructor(prefix = undefined) {
    // Store an optional prefix for this logger instance. The prefix is only used for
    // display formatting; all entries still flow into the shared logger pipeline.
    this.prefix = typeof prefix === 'string' && prefix !== '' ? prefix : undefined;

    // Use inline HTML styles for ANSI conversion so the browser does not need to
    // know the exact chalk/ANSI class mapping.
    Logger.#ansi.use_classes = false;
  }

  static withPrefix(prefix) {
    // Create a lightweight logger instance for this prefix. No cache is required
    // because all instances share the same static history/listener backend.
    let logger = new Logger(prefix);

    // Return a callable function so this works like the Homebridge logger:
    // log('message'), log.info(...), log.warn(...), etc.
    let log = logger.info.bind(logger);

    // Bind all methods to preserve "this" when consumers call log.warn(...) or pass
    // the methods around as callbacks.
    log.info = logger.info.bind(logger);
    log.success = logger.success.bind(logger);
    log.warn = logger.warn.bind(logger);
    log.error = logger.error.bind(logger);
    log.debug = logger.debug.bind(logger);
    log.log = logger.log.bind(logger);

    // Expose prefix for code that expects the logger function to carry it.
    log.prefix = logger.prefix;

    return log;
  }

  static setDebugEnabled(enabled = true) {
    // Debug logs can be noisy, so they are globally controlled.
    Logger.#debugEnabled = enabled === true;
  }

  static setTimestampEnabled(enabled = true) {
    // Timestamps are global so all logger instances use the same format behaviour.
    Logger.#timestampEnabled = enabled === true;
  }

  static setMaxHistory(maxHistory) {
    // Allow callers to tune the in-memory log buffer size without needing file logs.
    if (Number.isFinite(Number(maxHistory)) === true && Number(maxHistory) > 0) {
      Logger.#maxHistory = Number(maxHistory);

      // If the buffer was reduced, trim existing history immediately.
      while (Logger.#history.length > Logger.#maxHistory) {
        Logger.#history.shift();
      }
    }
  }

  static history() {
    // Return a copy so consumers cannot mutate internal logger state.
    return [...Logger.#history];
  }

  static addListener(listener) {
    // Register a live log listener. Used by HomeKitUI to stream new log entries.
    if (typeof listener === 'function') {
      Logger.#listeners.add(listener);
    }
  }

  static removeListener(listener) {
    // Remove a live listener when a web client disconnects or UI stops.
    Logger.#listeners.delete(listener);
  }

  static clearHistory() {
    // Clear the in-memory log buffer only. This does not affect terminal output.
    Logger.#history = [];
  }

  static forceColor() {
    // Force basic ANSI colour support. Useful when running under environments where
    // chalk does not detect colour support automatically.
    chalk.level = 1;
  }

  info(message, ...parameters) {
    this.log(LogLevel.INFO, message, ...parameters);
  }

  success(message, ...parameters) {
    this.log(LogLevel.SUCCESS, message, ...parameters);
  }

  warn(message, ...parameters) {
    this.log(LogLevel.WARN, message, ...parameters);
  }

  error(message, ...parameters) {
    this.log(LogLevel.ERROR, message, ...parameters);
  }

  debug(message, ...parameters) {
    this.log(LogLevel.DEBUG, message, ...parameters);
  }

  log(level, message, ...parameters) {
    // Debug messages are ignored unless debug has been explicitly enabled.
    if (level === LogLevel.DEBUG && Logger.#debugEnabled !== true) {
      return;
    }

    // Normalise invalid levels back to info so custom callers cannot break output.
    if (Object.values(LogLevel).includes(level) === false) {
      level = LogLevel.INFO;
    }

    // util.format keeps existing logger behaviour for "%s", "%d", objects, etc.
    let plainMessage = util.format(message, ...parameters);
    let terminalMessage = plainMessage;

    // Apply level colour to the message body only. Prefix and timestamp are added
    // afterwards so they can have their own consistent colours.
    let loggingFunction = console.log;
    switch (level) {
      case LogLevel.SUCCESS:
        terminalMessage = chalk.green(terminalMessage);
        break;

      case LogLevel.WARN:
        terminalMessage = chalk.yellow(terminalMessage);
        loggingFunction = console.error;
        break;

      case LogLevel.ERROR:
        terminalMessage = chalk.red(terminalMessage);
        loggingFunction = console.error;
        break;

      case LogLevel.DEBUG:
        terminalMessage = chalk.gray(terminalMessage);
        break;

      default:
        break;
    }

    // Add optional prefix after colourising the message. This mirrors the original
    // Homebridge-style output.
    if (this.prefix !== undefined) {
      terminalMessage = getLogPrefix(this.prefix) + ' ' + terminalMessage;
      plainMessage = '[' + this.prefix + '] ' + plainMessage;
    }

    // Add timestamp last so the complete terminal line matches what appears in the
    // console, while plainMessage remains suitable for searching/filtering.
    if (Logger.#timestampEnabled === true) {
      let date = new Date();
      let timestamp = '[' + date.toLocaleString() + '] ';

      terminalMessage = chalk.white(timestamp) + terminalMessage;
      plainMessage = timestamp + plainMessage;
    }

    // Write to the terminal first to preserve normal logging behaviour.
    loggingFunction(terminalMessage);

    // Store and emit the final formatted entry for UI consumers.
    this.#addHistory(level, terminalMessage, plainMessage);
  }

  #addHistory(level, terminalMessage, plainMessage) {
    // Build one structured log entry. The HTML field lets HomeKitUI render chalk
    // colours without needing to parse terminal output itself.
    let entry = {
      time: new Date().toISOString(),
      level,
      prefix: this.prefix,
      message: plainMessage,
      terminal: terminalMessage,
      html: Logger.#ansi.ansi_to_html(terminalMessage),
    };

    Logger.#history.push(entry);

    // Keep memory bounded.
    while (Logger.#history.length > Logger.#maxHistory) {
      Logger.#history.shift();
    }

    // Notify listeners safely. One bad listener must not break logging.
    Logger.#listeners.forEach((listener) => {
      try {
        listener(entry);
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    });
  }
}

export function getLogPrefix(prefix) {
  // Return a coloured Homebridge-style prefix.
  return chalk.cyan('[' + prefix + ']');
}
