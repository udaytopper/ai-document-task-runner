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

function findAllTasks() {
  return database
    .prepare(`
      SELECT *
      FROM tasks
      ORDER BY created_at ASC
    `)
    .all();
}

module.exports = {
  createTasks,
  findAllTasks,
};