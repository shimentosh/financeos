import "reflect-metadata";
import "./load-env.js";
import { NestFactory } from "@nestjs/core";
import { installProcessHandlers, reportError } from "./common/error-reporter.js";
import { AppLogger, logLevelsFor } from "./common/logger.js";

// A worker-only process: the same modules, no HTTP server. Run it alongside
// API instances started with RUN_WORKER_IN_PROCESS=false.
process.env.EW_WORKER_PROCESS = "1";

const logger = new AppLogger({ format: process.env.LOG_FORMAT === "json" ? "json" : "text", levels: logLevelsFor(process.env.NODE_ENV) });
installProcessHandlers(logger, "worker");

async function main() {
  const { AppModule } = await import("./app.module.js");
  const app = await NestFactory.createApplicationContext(AppModule, { logger });
  app.enableShutdownHooks();
  logger.log("FinanceOS worker running", "Worker");
}

main().catch(async (error: unknown) => {
  logger.fatal(`Worker failed to start: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined, "Worker");
  await reportError(error, { level: "fatal", mechanism: "bootstrap", handled: false, tags: { service: "worker" } });
  process.exit(1);
});
