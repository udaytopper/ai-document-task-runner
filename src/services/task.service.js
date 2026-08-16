const { randomUUID } = require("crypto");
const detectCycle = require("../utils/cycle-detector");
const taskRepository = require("../repositories/task.repository");
const TASK_STATUS = require("../constants/task-status");

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw createValidationError(
      "The tasks property must be a non-empty array"
    );
  }

  const clientIds = new Set();

  for (const task of tasks) {
    if (
      typeof task.clientId !== "string" ||
      task.clientId.trim() === ""
    ) {
      throw createValidationError(
        "Every task must have a non-empty clientId"
      );
    }

    if (clientIds.has(task.clientId)) {
      throw createValidationError(
        `Duplicate clientId: ${task.clientId}`
      );
    }

    clientIds.add(task.clientId);
  }

  for (const task of tasks) {
    if (
      typeof task.name !== "string" ||
      task.name.trim() === ""
    ) {
      throw createValidationError(
        `Task ${task.clientId} must have a non-empty name`
      );
    }

    if (
      !Number.isInteger(task.durationMs) ||
      task.durationMs < 100 ||
      task.durationMs > 30000
    ) {
      throw createValidationError(
        `Task ${task.clientId} durationMs must be an integer between 100 and 30000`
      );
    }

    if (
      typeof task.failureProbability !== "number" ||
      task.failureProbability < 0 ||
      task.failureProbability > 1
    ) {
      throw createValidationError(
        `Task ${task.clientId} failureProbability must be between 0 and 1`
      );
    }

    if (
      !Number.isInteger(task.maxRetries) ||
      task.maxRetries < 0 ||
      task.maxRetries > 10
    ) {
      throw createValidationError(
        `Task ${task.clientId} maxRetries must be an integer between 0 and 10`
      );
    }

    if (
      task.dependencies !== undefined &&
      !Array.isArray(task.dependencies)
    ) {
      throw createValidationError(
        `Task ${task.clientId} dependencies must be an array`
      );
    }

    const dependencies = task.dependencies || [];
    const uniqueDependencies = new Set(dependencies);

    if (dependencies.length !== uniqueDependencies.size) {
      throw createValidationError(
        `Task ${task.clientId} contains duplicate dependencies`
      );
    }

    for (const dependencyId of dependencies) {
      if (!clientIds.has(dependencyId)) {
        throw createValidationError(
          `Task ${task.clientId} depends on unknown task ${dependencyId}`
        );
      }

      if (dependencyId === task.clientId) {
        throw createValidationError(
          `Task ${task.clientId} cannot depend on itself`
        );
      }
    }
  }
}

function submitTasks(inputTasks) {
  validateTasks(inputTasks);

  const normalizedTasks = inputTasks.map((task) => ({
    ...task,
    clientId: task.clientId.trim(),
    name: task.name.trim(),
    dependencies: task.dependencies || [],
  }));

  const cycle = detectCycle(normalizedTasks);

  if (cycle) {
    throw createValidationError(
      `Circular dependency detected: ${cycle.join(" -> ")}`
    );
  }

  const idByClientId = new Map();

  for (const task of normalizedTasks) {
    idByClientId.set(task.clientId, randomUUID());
  }

  const createdAt = new Date().toISOString();

  const tasksToSave = normalizedTasks.map((task) => ({
    id: idByClientId.get(task.clientId),
    clientId: task.clientId,
    name: task.name,
    durationMs: task.durationMs,
    failureProbability: task.failureProbability,
    maxRetries: task.maxRetries,
    dependencyIds: task.dependencies.map((dependencyClientId) =>
      idByClientId.get(dependencyClientId)
    ),
    createdAt,
  }));

  taskRepository.createTasks(tasksToSave);

  return tasksToSave.map((task) => ({
    clientId: task.clientId,
    id: task.id,
    name: task.name,
  }));
}

const validStatuses = new Set(Object.values(TASK_STATUS));

function createNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function mapTask(task) {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    durationMs: task.duration_ms,
    failureProbability: task.failure_probability,
    attemptCount: task.attempt_count,
    maxRetries: task.max_retries,
    nextAttemptAt: task.next_attempt_at,
    errorMessage: task.error_message,
    createdAt: task.created_at,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    updatedAt: task.updated_at,
  };
}

function getAllTasks(status) {
  if (status && !validStatuses.has(status)) {
    throw createValidationError(
      `Invalid status. Allowed values: ${[...validStatuses].join(", ")}`
    );
  }

  return taskRepository.findAllTasks(status).map(mapTask);
}

function getTaskById(taskId) {
  const task = taskRepository.findTaskById(taskId);

  if (!task) {
    throw createNotFoundError(`Task not found: ${taskId}`);
  }

  const dependencies = taskRepository
    .findDependencies(taskId)
    .map((dependency) => ({
      id: dependency.id,
      name: dependency.name,
      status: dependency.status,
    }));

  return {
    ...mapTask(task),
    dependencies,
  };
}

function getTaskEvents(taskId) {
  const task = taskRepository.findTaskById(taskId);

  if (!task) {
    throw createNotFoundError(`Task not found: ${taskId}`);
  }

  const events = taskRepository.findEvents(taskId).map((event) => ({
    id: event.id,
    eventType: event.event_type,
    fromStatus: event.from_status,
    toStatus: event.to_status,
    message: event.message,
    createdAt: event.created_at,
  }));

  return {
    taskId,
    taskName: task.name,
    events,
  };
}

module.exports = {
  submitTasks,
  validateTasks,
  getAllTasks,
  getTaskById,
  getTaskEvents,
};