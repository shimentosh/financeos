import "reflect-metadata";
import "./env.js";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { installProcessHandlers, reportError } from "./common/error-reporter.js";
import { configureHttpServer } from "./common/http-server.js";
import { AppLogger, logLevelsFor } from "./common/logger.js";
import { env } from "./env.js";

const logger = new AppLogger({ format: env.LOG_FORMAT, levels: logLevelsFor(env.NODE_ENV) });
installProcessHandlers(logger, "api");

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger });
  // Request ids, access log, CSRF origin check, Better Auth, body parsers, /api prefix.
  configureHttpServer(app, { appUrl: env.APP_URL, trustProxy: env.TRUST_PROXY, logger });
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
  logger.log(`FinanceOS API on http://localhost:${env.API_PORT}/api`, "Bootstrap");
}

bootstrap().catch(async (error: unknown) => {
  logger.fatal(`API failed to start: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined, "Bootstrap");
  await reportError(error, { level: "fatal", mechanism: "bootstrap", handled: false, tags: { service: "api" } });
  process.exit(1);
});
