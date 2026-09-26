const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: config.logLevel,
  // Defence in depth: strip anything secret-looking even if someone logs it by mistake.
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      'passwordHash',
      'password_hash',
      'token',
      '*.password',
      '*.passwordHash',
      '*.password_hash',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
