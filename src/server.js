const app = require("./app");
const config = require("./config");
require("./database/connection");

const server = app.listen(config.port, () => {
  console.log(
    `AI Document Task Runner running at http://localhost:${config.port}`
  );
});

function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);

  server.close(() => {
    console.log("Server stopped");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));