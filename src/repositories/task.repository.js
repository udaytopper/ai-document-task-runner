const database = require("../database/connection");
const TASK_STATUS = require("../constants/task-status");
const EVENT_TYPES = require("../constants/event-types");

const insertTaskStatement = database.prepare(`
  INSERT INTO tasks (
    id,
    name,
    status,
    duration_ms,
    failure_probability,
    attempt_count,
    max_retries,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDependencyStatement = database.prepare(`
  INSERT INTO task_dependencies (
    task_id,
    dependency_id
  )
  VALUES (?, ?)
`);

const insertEventStatement = database.prepare(`
  INSERT INTO task_events (
    task_id,
    event_type,
    from_status,
    to_status,
    message,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?)
`);

const findTaskByIdStatement = database.prepare(`
  SELECT *
  FROM tasks
  WHERE id = ?
`);

const findDependenciesStatement = database.prepare(`
  SELECT
    t.id,
    t.name,
    t.status
  FROM task_dependencies td
  JOIN tasks t ON t.id = td.dependency_id
  WHERE td.task_id = ?
  ORDER BY t.created_at ASC
`);

const findEventsStatement = database.prepare(`
  SELECT *
  FROM task_events
  WHERE task_id = ?
  ORDER BY id ASC
`);

function createTasks(tasks) {
  const insertTransaction = database.transaction((taskList) => {
    for (const task of taskList) {
      insertTaskStatement.run(
        task.id,
        task.name,
        TASK_STATUS.WAITING,
        task.durationMs,
        task.failureProbability,
        0,
        task.maxRetries,
        task.createdAt,
        task.createdAt
      );

      for (const dependencyId of task.dependencyIds) {
        insertDependencyStatement.run(task.id, dependencyId);
      }

      insertEventStatement.run(
        task.id,
        EVENT_TYPES.TASK_SUBMITTED,
        null,
        TASK_STATUS.WAITING,
        "Document-processing task was submitted",
        task.createdAt
      );
    }
  });

  insertTransaction(tasks);
}

function findAllTasks(status) {
  if (status) {
    return database
      .prepare(`
        SELECT *
        FROM tasks
        WHERE status = ?
        ORDER BY created_at ASC
      `)
      .all(status);
  }

  return database
    .prepare(`
      SELECT *
      FROM tasks
      ORDER BY created_at ASC
    `)
    .all();
}

function findTaskById(taskId) {
  return findTaskByIdStatement.get(taskId);
}

function findDependencies(taskId) {
  return findDependenciesStatement.all(taskId);
}

function findEvents(taskId) {
  return findEventsStatement.all(taskId);
}

module.exports = {
  createTasks,
  findAllTasks,
  findTaskById,
  findDependencies,
  findEvents,
};