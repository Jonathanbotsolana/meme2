const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('../../config/config');

// Ensure log directory exists
if (!fs.existsSync(config.logging.directory)) {
  fs.mkdirSync(config.logging.directory, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(config.logging.directory, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(config.logging.directory, 'combined.log'),
    }),
    new winston.transports.File({
      filename: path.join(config.logging.directory, 'trades.log'),
      level: 'info',
    }),
  ],
});

module.exports = logger;