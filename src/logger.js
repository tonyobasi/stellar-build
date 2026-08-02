import pino from 'pino';

export function createLogger(config) {
  return pino({
    level: config.nodeEnv === 'test' ? 'silent' : process.env.LOG_LEVEL || 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        'req.headers["set-cookie"]',
        'res.headers["set-cookie"]'
      ],
      censor: '[REDACTED]'
    }
  });
}
