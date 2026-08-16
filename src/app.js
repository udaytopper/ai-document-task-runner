const express = require("express");

const app = express();

app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "AI Document Processing Task Runner",
  });
});

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