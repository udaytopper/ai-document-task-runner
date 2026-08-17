const express = require("express");
const taskRoutes = require("./routes/task.routes");
const taskController = require("./controllers/task.controller");

const app = express();

app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "AI Document Processing Task Runner",
  });
});

app.get("/api/stats", taskController.getStats);

app.use("/api/tasks", taskRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.use((error, req, res, next) => {
  console.error(error);

  res.status(error.statusCode || 500).json({
    error: error.message || "Internal server error",
  });
});

module.exports = app;