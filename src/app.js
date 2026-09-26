const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const { notFound, errorHandler } = require('./middleware/error');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      // Health checks from the ALB would flood the logs.
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  app.use('/health', healthRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
