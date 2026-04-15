/**
 * Structured Logger
 *
 * Lightweight structured logger with:
 * - Log levels (debug, info, warn, error)
 * - Contextual metadata (component, domain, operation)
 * - Environment-aware configuration (verbose in dev, quiet in prod)
 * - Consistent format across all components
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  component?: string;
  domain?: string;
  operation?: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: LogContext;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 
  (process.env.NODE_ENV === "production" ? "info" : "debug");

export class Logger {
  private level: LogLevel;
  private context: LogContext;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? DEFAULT_LEVEL;
    this.context = options.context ?? {};
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): Logger {
    return new Logger({
      level: this.level,
      context: { ...this.context, ...context },
    });
  }

  /**
   * Log at debug level (verbose development info)
   */
  debug(message: string, meta?: LogContext): void {
    this.log("debug", message, meta);
  }

  /**
   * Log at info level (normal operational messages)
   */
  info(message: string, meta?: LogContext): void {
    this.log("info", message, meta);
  }

  /**
   * Log at warn level (warning conditions)
   */
  warn(message: string, meta?: LogContext): void {
    this.log("warn", message, meta);
  }

  /**
   * Log at error level (error conditions)
   */
  error(message: string, meta?: LogContext | Error): void {
    if (meta instanceof Error) {
      this.log("error", message, { error: meta.message, stack: meta.stack });
    } else {
      this.log("error", message, meta);
    }
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, meta?: LogContext): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const context = { ...this.context, ...meta };
    const contextStr = Object.keys(context).length > 0 
      ? ` ${JSON.stringify(context)}`
      : "";

    const prefix = this.getPrefix(level);
    const output = `${timestamp} ${prefix} ${message}${contextStr}`;

    switch (level) {
      case "debug":
        console.debug(output);
        break;
      case "info":
        console.log(output);
        break;
      case "warn":
        console.warn(output);
        break;
      case "error":
        console.error(output);
        break;
    }
  }

  private getPrefix(level: LogLevel): string {
    switch (level) {
      case "debug":
        return "[DEBUG]";
      case "info":
        return "[INFO] ";
      case "warn":
        return "[WARN] ";
      case "error":
        return "[ERROR]";
    }
  }
}

/**
 * Create a logger instance
 */
export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}

/**
 * Default logger instance
 */
export const logger = createLogger();
