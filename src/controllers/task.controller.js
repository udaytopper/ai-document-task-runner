const taskService = require("../services/task.service");

function submitTasks(req, res, next) {
  try {
    const createdTasks = taskService.submitTasks(req.body.tasks);

    return res.status(201).json({
      message: "Tasks submitted successfully",
      tasks: createdTasks,
    });
  } catch (error) {
    return next(error);
  }
}

function getAllTasks(req, res, next) {
  try {
    const status = req.query.status
      ? req.query.status.toUpperCase()
      : undefined;

    const tasks = taskService.getAllTasks(status);

    return res.status(200).json({
      count: tasks.length,
      tasks,
    });
  } catch (error) {
    return next(error);
  }
}

function getTaskById(req, res, next) {
  try {
    const task = taskService.getTaskById(req.params.id);

    return res.status(200).json(task);
  } catch (error) {
    return next(error);
  }
}

function getTaskEvents(req, res, next) {
  try {
    const result = taskService.getTaskEvents(req.params.id);

    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
}

function cancelTask(req, res, next) {
  try {
    const task = taskService.cancelTask(req.params.id);

    return res.status(200).json({
      message: "Task cancelled successfully",
      task,
    });
  } catch (error) {
    return next(error);
  }
}

function getStats(req, res, next) {
  try {
    const stats = taskService.getStats();

    return res.status(200).json(stats);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  submitTasks,
  getAllTasks,
  getTaskById,
  getTaskEvents,
  cancelTask,
  getStats,
};