import pino, { type Logger } from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: AppConfig): Logger {
  const options: pino.LoggerOptions = {
    level: config.logLevel,
    base: { service: "douyin-vault" },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      req(request: { method?: string; url?: string; remoteAddress?: string; remotePort?: number }) {
        return {
          method: request.method,
          url: String(request.url ?? "").split("?")[0],
          remoteAddress: request.remoteAddress,
          remotePort: request.remotePort,
        };
      },
    },
    redact: {
      paths: [
        "req.headers.cookie",
        "req.headers.authorization",
        "req.headers['x-api-key']",
        "req.headers['x-csrf-token']",
        "*.cookie",
        "*.token",
        "*.apiKey",
        "*.password",
        "*.qrDataUrl",
        "*.verificationUrl",
        "*.mediaUrl",
        "*.shareUrl",
        "*.url",
        "*.authorization",
      ],
      censor: "[redacted]",
    },
  };
  if (config.logPretty) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,service",
          singleLine: true,
          messageFormat: "[{service}] {msg}",
        },
      },
    });
  }
  return pino(options);
}

export type { Logger };
