const database = require("../database/connection");
const TASK_STATUS = require("../constants/task-status");
const EVENT_TYPES = require("../constants/event-types");

/*
 * Prepared statements
 */

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
    dependency.id,
    dependency.name,
    dependency.status
  FROM task_dependencies td
  JOIN tasks dependency
    ON dependency.id = td.dependency_id
  WHERE td.task_id = ?
  ORDER BY dependency.created_at ASC
`);

const findEventsStatement = database.prepare(`
  SELECT *
  FROM task_events
  WHERE task_id = ?
  ORDER BY id ASC
`);

/*
 * Task creation
 */

function createTasks(tasks) {
  const insertTransaction = database.transaction((taskList) => {
    /*
     * Insert every task first.
     *
     * This is necessary because one task may depend on another task that
     * appears later in the submitted array. All referenced task IDs must
     * exist before dependency rows are inserted.
     */
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
    }

    /*
     * After all tasks exist, insert dependencies and activity events.
     */
    for (const task of taskList) {
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

/*
 * Task query functions
 */

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

/*
 * Scheduler query functions
 */

function countRunningTasks() {
  const result = database
    .prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE status = ?
    `)
    .get(TASK_STATUS.RUNNING);

  return result.count;
}

function findReadyTasks(limit, currentTime) {
  if (limit <= 0) {
    return [];
  }

  return database
    .prepare(`
      SELECT task.*
      FROM tasks task
      WHERE
        (
          task.status = ?
          OR (
            task.status = ?
            AND task.next_attempt_at IS NOT NULL
            AND task.next_attempt_at <= ?
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM task_dependencies td
          JOIN tasks dependency
            ON dependency.id = td.dependency_id
          WHERE td.task_id = task.id
            AND dependency.status != ?
        )
      ORDER BY task.created_at ASC, task.id ASC
      LIMIT ?
    `)
    .all(
      TASK_STATUS.WAITING,
      TASK_STATUS.RETRY_WAIT,
      currentTime,
      TASK_STATUS.SUCCEEDED,
      limit
    );
}

/*
 * Atomically calculate available slots and change ready tasks to RUNNING.
 *
 * Because better-sqlite3 transactions are synchronous, no second scheduler
 * operation can enter between counting RUNNING tasks and claiming new tasks.
 */
function claimReadyTasks(concurrencyLimit, currentTime) {
  const claimTransaction = database.transaction(() => {
    const runningCount = countRunningTasks();

    const availableSlots = Math.max(
      0,
      concurrencyLimit - runningCount
    );

    if (availableSlots === 0) {
      return [];
    }

    const readyTasks = findReadyTasks(
      availableSlots,
      currentTime
    );

    if (readyTasks.length === 0) {
      return [];
    }

    const updateTaskStatement = database.prepare(`
      UPDATE tasks
      SET
        status = ?,
        attempt_count = attempt_count + 1,
        started_at = ?,
        next_attempt_at = NULL,
        error_message = NULL,
        updated_at = ?
      WHERE id = ?
        AND status IN (?, ?)
    `);

    const claimedTasks = [];

    for (const task of readyTasks) {
      const previousStatus = task.status;

      const result = updateTaskStatement.run(
        TASK_STATUS.RUNNING,
        currentTime,
        currentTime,
        task.id,
        TASK_STATUS.WAITING,
        TASK_STATUS.RETRY_WAIT
      );

      /*
       * The guarded update prevents accidentally claiming a task whose state
       * changed after it was selected.
       */
      if (result.changes === 0) {
        continue;
      }

      const attemptCount = task.attempt_count + 1;

      insertEventStatement.run(
        task.id,
        EVENT_TYPES.TASK_STARTED,
        previousStatus,
        TASK_STATUS.RUNNING,
        `Attempt ${attemptCount} started`,
        currentTime
      );

      claimedTasks.push({
        ...task,
        status: TASK_STATUS.RUNNING,
        attempt_count: attemptCount,
        started_at: currentTime,
        next_attempt_at: null,
        error_message: null,
        updated_at: currentTime,
      });
    }

    return claimedTasks;
  });

  return claimTransaction();
}

/*
 * Task completion functions
 */

function markTaskSucceeded(taskId, completedAt) {
  const updateTransaction = database.transaction(() => {
    const task = findTaskByIdStatement.get(taskId);

    if (!task || task.status !== TASK_STATUS.RUNNING) {
      return false;
    }

    const result = database
      .prepare(`
        UPDATE tasks
        SET
          status = ?,
          completed_at = ?,
          next_attempt_at = NULL,
          error_message = NULL,
          updated_at = ?
        WHERE id = ?
          AND status = ?
      `)
      .run(
        TASK_STATUS.SUCCEEDED,
        completedAt,
        completedAt,
        taskId,
        TASK_STATUS.RUNNING
      );

    if (result.changes === 0) {
      return false;
    }

    insertEventStatement.run(
      taskId,
      EVENT_TYPES.TASK_SUCCEEDED,
      TASK_STATUS.RUNNING,
      TASK_STATUS.SUCCEEDED,
      `Task succeeded on attempt ${task.attempt_count}`,
      completedAt
    );

    return true;
  });

  return updateTransaction();
}

function markTaskForRetry(
  taskId,
  errorMessage,
  nextAttemptAt,
  updatedAt
) {
  const updateTransaction = database.transaction(() => {
    const task = findTaskByIdStatement.get(taskId);

    if (!task || task.status !== TASK_STATUS.RUNNING) {
      return false;
    }

    const result = database
      .prepare(`
        UPDATE tasks
        SET
          status = ?,
          next_attempt_at = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
          AND status = ?
      `)
      .run(
        TASK_STATUS.RETRY_WAIT,
        nextAttemptAt,
        errorMessage,
        updatedAt,
        taskId,
        TASK_STATUS.RUNNING
      );

    if (result.changes === 0) {
      return false;
    }

    insertEventStatement.run(
      taskId,
      EVENT_TYPES.ATTEMPT_FAILED,
      TASK_STATUS.RUNNING,
      TASK_STATUS.RETRY_WAIT,
      `Attempt ${task.attempt_count} failed: ${errorMessage}`,
      updatedAt
    );

    insertEventStatement.run(
      taskId,
      EVENT_TYPES.RETRY_SCHEDULED,
      TASK_STATUS.RETRY_WAIT,
      TASK_STATUS.RETRY_WAIT,
      `Retry scheduled for ${nextAttemptAt}`,
      updatedAt
    );

    return true;
  });

  return updateTransaction();
}

function markTaskFailed(taskId, errorMessage, completedAt) {
  const updateTransaction = database.transaction(() => {
    const task = findTaskByIdStatement.get(taskId);

    if (!task || task.status !== TASK_STATUS.RUNNING) {
      return false;
    }

    const result = database
      .prepare(`
        UPDATE tasks
        SET
          status = ?,
          completed_at = ?,
          next_attempt_at = NULL,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
          AND status = ?
      `)
      .run(
        TASK_STATUS.FAILED,
        completedAt,
        errorMessage,
        completedAt,
        taskId,
        TASK_STATUS.RUNNING
      );

    if (result.changes === 0) {
      return false;
    }

    insertEventStatement.run(
      taskId,
      EVENT_TYPES.ATTEMPT_FAILED,
      TASK_STATUS.RUNNING,
      TASK_STATUS.FAILED,
      `Attempt ${task.attempt_count} failed: ${errorMessage}`,
      completedAt
    );

    insertEventStatement.run(
      taskId,
      EVENT_TYPES.TASK_FAILED,
      TASK_STATUS.RUNNING,
      TASK_STATUS.FAILED,
      `Task permanently failed after ${task.attempt_count} attempts`,
      completedAt
    );

    return true;
  });

  return updateTransaction();
}

/*
 * Blocking propagation
 */

function blockTasksWithFailedDependencies(currentTime) {
  const blockTransaction = database.transaction(() => {
    const tasksToBlock = database
      .prepare(`
        SELECT DISTINCT
          task.id,
          task.status
        FROM tasks task
        JOIN task_dependencies td
          ON td.task_id = task.id
        JOIN tasks dependency
          ON dependency.id = td.dependency_id
        WHERE task.status IN (?, ?)
          AND dependency.status IN (?, ?, ?)
      `)
      .all(
        TASK_STATUS.WAITING,
        TASK_STATUS.RETRY_WAIT,
        TASK_STATUS.FAILED,
        TASK_STATUS.BLOCKED,
        TASK_STATUS.CANCELLED
      );

    if (tasksToBlock.length === 0) {
      return 0;
    }

    const updateTaskStatement = database.prepare(`
      UPDATE tasks
      SET
        status = ?,
        completed_at = ?,
        next_attempt_at = NULL,
        error_message = ?,
        updated_at = ?
      WHERE id = ?
        AND status IN (?, ?)
    `);

    let blockedCount = 0;

    for (const task of tasksToBlock) {
      const message =
        "Task blocked because one or more dependencies did not succeed";

      const result = updateTaskStatement.run(
        TASK_STATUS.BLOCKED,
        currentTime,
        message,
        currentTime,
        task.id,
        TASK_STATUS.WAITING,
        TASK_STATUS.RETRY_WAIT
      );

      if (result.changes === 0) {
        continue;
      }

      insertEventStatement.run(
        task.id,
        EVENT_TYPES.TASK_BLOCKED,
        task.status,
        TASK_STATUS.BLOCKED,
        message,
        currentTime
      );

      blockedCount += 1;
    }

    return blockedCount;
  });

  return blockTransaction();
}

module.exports = {
  createTasks,
  findAllTasks,
  findTaskById,
  findDependencies,
  findEvents,
  countRunningTasks,
  findReadyTasks,
  claimReadyTasks,
  markTaskSucceeded,
  markTaskForRetry,
  markTaskFailed,
  blockTasksWithFailedDependencies,
};