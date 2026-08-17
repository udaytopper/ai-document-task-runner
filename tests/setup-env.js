process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = ":memory:";
process.env.CONCURRENCY_LIMIT = "2";
process.env.SCHEDULER_INTERVAL_MS = "10000";
process.env.BASE_RETRY_DELAY_MS = "10";