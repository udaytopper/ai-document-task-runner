const express = require("express");
const taskController = require("../controllers/task.controller");

const router = express.Router();

router.post("/", taskController.submitTasks);
router.get("/", taskController.getAllTasks);

router.post(
  "/:id/cancel",
  taskController.cancelTask
);

router.get(
  "/:id/events",
  taskController.getTaskEvents
);

router.get(
  "/:id",
  taskController.getTaskById
);

module.exports = router;