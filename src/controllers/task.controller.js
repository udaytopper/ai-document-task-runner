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

module.exports = {
  submitTasks,
};