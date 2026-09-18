// src/utils/logger.js
//
// Structured logging, replacing scattered console.log/console.error
// calls. Pretty-printed in development, plain JSON in
// production/staging so log aggregators (Datadog, CloudWatch, Loki,
// etc.) can parse it. Every log line carries a `service` field so
// this app's logs are identifiable once you're aggregating logs from
// more than one service.

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  base: { service: 'swiftpay' },

  // Defense-in-depth, same rationale as auditLog.service.js's metadata
  // redaction: individual call sites being careful is not a systemic
  // guarantee. Wildcards (`*`) match the field name at any depth/key in
  // logged objects, so e.g. `logger.info({ payload: { destinationAccountNumber } })`
  // is caught even though the field isn't at the top level. `censor`
  // shows the last 4 characters, same convention as the audit log, so
  // logs stay useful for cross-referencing without exposing the full
  // value (see audit report, Medium #25 and the "legacy sensitive
  // handling" follow-up).
  redact: {
    paths: [
      'accountNumber', '*.accountNumber', '*.*.accountNumber',
      'destinationAccountNumber', '*.destinationAccountNumber', '*.*.destinationAccountNumber',
      'cardNumber', '*.cardNumber', '*.*.cardNumber',
      'cvv', '*.cvv', '*.*.cvv',
      'pin', '*.pin', '*.*.pin',
      'password', '*.password', '*.*.password',
      'passwordHash', '*.passwordHash', '*.*.passwordHash',
      'secret', '*.secret', '*.*.secret',
      'webhookSecret', '*.webhookSecret', '*.*.webhookSecret',
      'token', '*.token', '*.*.token',
      'apiKey', '*.apiKey', '*.*.apiKey',
      'backupCode', '*.backupCode', '*.*.backupCode',
    ],
    censor: (value) => {
      const str = String(value ?? '');
      return str.length <= 4 ? '[redacted]' : `***${str.slice(-4)}`;
    },
  },

  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
      },
});

module.exports = logger;
