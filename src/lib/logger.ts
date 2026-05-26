/**
 * Centralized logging utility using Pino
 *
 * Features:
 * - Pretty output in development, JSON in production
 * - Log level controlled via LOG_LEVEL env var
 * - Child loggers with context (module, orgId, userId)
 *
 * Usage:
 *   import { logger } from "../lib/logger.ts";
 *   logger.info("Hello world");
 *   logger.error({ err }, "Something went wrong");
 *
 *   // With context
 *   import { createLogger } from "../lib/logger.ts";
 *   const log = createLogger("cron-engine");
 *   log.info({ jobId: "job_123" }, "Triggering job");
 */

import pino, { type Logger, type LoggerOptions } from "pino";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

function getLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  const validLevels: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];

  if (envLevel && validLevels.includes(envLevel)) {
    return envLevel;
  }

  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const isDevelopment = process.env.NODE_ENV !== "production";

const baseOptions: LoggerOptions = {
  level: getLogLevel(),
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      hostname: bindings.hostname,
    }),
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
};

function createBaseLogger(): Logger {
  if (isDevelopment) {
    return pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
          singleLine: false,
        },
      },
    });
  }

  return pino(baseOptions);
}

export const logger = createBaseLogger();

/**
 * Create a child logger with a module name.
 * @param module - The module/component name (e.g., "cron-engine", "channel-manager")
 */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}

/**
 * Create a request-scoped logger with user context.
 */
export function createRequestLogger(
  module: string,
  context: {
    userId?: string;
    orgId?: string;
    requestId?: string;
    [key: string]: unknown;
  },
): Logger {
  return logger.child({
    module,
    ...context,
  });
}

export type { Logger, LogLevel };

export default logger;
