const { randomUUID } = require("crypto");
const detectCycle = require("../utils/cycle-detector");
const taskRepository = require("../repositories/task.repository");

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

module.exports = {
  submitTasks,
  validateTasks,
};