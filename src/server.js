const app = require("./app");
const config = require("./config");
require("./database/connection");

const {
  startTaskRunner,
  stopTaskRunner,
} = require("./services/task-runner.service");

const server = app.listen(config.port, () => {
  console.log(
    `AI Document Task Runner running at http://localhost:${config.port}`
  );

  startTaskRunner();
});

function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);

  stopTaskRunner();

  server.close(() => {
    console.log("Server stopped");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));