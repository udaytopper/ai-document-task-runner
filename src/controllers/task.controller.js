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

module.exports = {
  submitTasks,
  getAllTasks,
  getTaskById,
  getTaskEvents,
};