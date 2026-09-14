/**
 * ============================================================
 * LOGGING
 * ============================================================
 *
 * Two outputs from one logger call:
 *
 *   - Terminal: human-friendly, colorized, via pino-pretty
 *   - File (logs/application.log): structured NDJSON, one
 *     JSON object per line, for later debugging/analytics
 *
 * A custom "success" level sits between info(30) and warn(40)
 * so a completed step can be visually distinct from a plain
 * info line without abusing warn/error for good news.
 *
 * Usage elsewhere in the app:
 *   const logger = require("../logger/logger");
 *   logger.info("Browser launched");
 *   logger.success("CAPTCHA solved");
 *   logger.error({ err: error }, "Workflow failed");
 *
 * Do NOT log secrets (API keys, cookies) or the actual CAPTCHA
 * answer through this logger — see storage/dataset-store.js
 * for where a verified CAPTCHA answer is allowed to be recorded.
 */

const fs = require("fs");
const pino = require("pino");
const config = require("../config/config");

// Make sure the logs directory exists before pino's file
// transport tries to open a file inside it.
fs.mkdirSync(config.paths.logsDir, { recursive: true });

const customLevels = {
    success: 35
};

const transport = pino.transport({
    targets: [
        {
            // Terminal — pretty, colorized, human-facing
            target: "pino-pretty",
            level: config.logging.level,
            options: {
                colorize: true,
                translateTime: "HH:MM:ss",
                ignore: "pid,hostname",
                customLevels: "success:35",
                customColors: "success:green,trace:gray,debug:blue,info:cyan,warn:yellow,error:red,fatal:bgRed"
            }
        },
        {
            // File — structured NDJSON, machine-facing
            target: "pino/file",
            level: "trace",
            options: {
                destination: config.paths.logFile,
                mkdir: true
            }
        }
    ]
});

const logger = pino(
    {
        level: config.logging.level,
        customLevels,
        useOnlyCustomProps: false
    },
    transport
);

module.exports = logger;
