require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT) || 3000,
  concurrencyLimit: Number(process.env.CONCURRENCY_LIMIT) || 2,
  schedulerIntervalMs:
    Number(process.env.SCHEDULER_INTERVAL_MS) || 500,
  baseRetryDelayMs:
    Number(process.env.BASE_RETRY_DELAY_MS) || 1000,
};