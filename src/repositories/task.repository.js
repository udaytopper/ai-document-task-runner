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
  ORDER BY dependency.created_at ASC,
           dependency.rowid ASC
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
  const insertTransaction = database.transaction(
    (taskList) => {
      /*
       * Insert all tasks first so dependency foreign keys can
       * reference tasks appearing later in the submitted array.
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
       * After all tasks exist, insert dependencies and events.
       */
      for (const task of taskList) {
        for (const dependencyId of task.dependencyIds) {
          insertDependencyStatement.run(
            task.id,
            dependencyId
          );
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
    }
  );

  insertTransaction(tasks);
}

/*
 * Task queries
 */

function findAllTasks(status) {
  if (status) {
    return database
      .prepare(`
        SELECT *
        FROM tasks
        WHERE status = ?
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(status);
  }

  return database
    .prepare(`
      SELECT *
      FROM tasks
      ORDER BY created_at ASC, rowid ASC
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
 * Scheduler queries
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

/*
 * Finds tasks that are allowed to start.
 *
 * A task is ready when:
 * 1. It is WAITING, or its retry delay has passed.
 * 2. Every dependency has SUCCEEDED.
 *
 * Step 3 FIFO correction:
 * rowid preserves insertion order when created_at is equal.
 */
function findReadyTasks(limit, currentTime) {
  if (!Number.isInteger(limit) || limit <= 0) {
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
      ORDER BY task.created_at ASC,
               task.rowid ASC
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
 * Atomically:
 * 1. Counts currently running tasks.
 * 2. Calculates available concurrency slots.
 * 3. Finds ready tasks.
 * 4. Changes those tasks to RUNNING.
 */
function claimReadyTasks(
  concurrencyLimit,
  currentTime
) {
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
        completed_at = NULL,
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
        completed_at: null,
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
 * Successful task completion
 */

function markTaskSucceeded(taskId, completedAt) {
  const updateTransaction = database.transaction(
    () => {
      const task = findTaskByIdStatement.get(taskId);

      if (
        !task ||
        task.status !== TASK_STATUS.RUNNING
      ) {
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
    }
  );

  return updateTransaction();
}

/*
 * Failed attempt that still has retries remaining
 */

function markTaskForRetry(
  taskId,
  errorMessage,
  nextAttemptAt,
  updatedAt
) {
  const updateTransaction = database.transaction(
    () => {
      const task = findTaskByIdStatement.get(taskId);

      if (
        !task ||
        task.status !== TASK_STATUS.RUNNING
      ) {
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
    }
  );

  return updateTransaction();
}

/*
 * Permanent task failure
 */

function markTaskFailed(
  taskId,
  errorMessage,
  completedAt
) {
  const updateTransaction = database.transaction(
    () => {
      const task = findTaskByIdStatement.get(taskId);

      if (
        !task ||
        task.status !== TASK_STATUS.RUNNING
      ) {
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
    }
  );

  return updateTransaction();
}

/*
 * Failed dependency propagation
 */

function blockTasksWithFailedDependencies(
  currentTime
) {
  const blockTransaction = database.transaction(
    () => {
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
    }
  );

  return blockTransaction();
}

/*
 * Task cancellation
 */

function cancelTask(taskId, cancelledAt) {
  const cancelTransaction = database.transaction(
    () => {
      const task = findTaskByIdStatement.get(taskId);

      if (!task) {
        return {
          outcome: "NOT_FOUND",
        };
      }

      const cancellableStatuses = [
        TASK_STATUS.WAITING,
        TASK_STATUS.RETRY_WAIT,
      ];

      if (
        !cancellableStatuses.includes(task.status)
      ) {
        return {
          outcome: "NOT_ALLOWED",
          status: task.status,
        };
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
            AND status IN (?, ?)
        `)
        .run(
          TASK_STATUS.CANCELLED,
          cancelledAt,
          cancelledAt,
          taskId,
          TASK_STATUS.WAITING,
          TASK_STATUS.RETRY_WAIT
        );

      if (result.changes === 0) {
        return {
          outcome: "NOT_ALLOWED",
          status: task.status,
        };
      }

      insertEventStatement.run(
        taskId,
        EVENT_TYPES.TASK_CANCELLED,
        task.status,
        TASK_STATUS.CANCELLED,
        "Task was cancelled before execution",
        cancelledAt
      );

      return {
        outcome: "CANCELLED",
        status: TASK_STATUS.CANCELLED,
      };
    }
  );

  return cancelTransaction();
}

/*
 * Restart recovery
 */

function recoverRunningTasks(recoveredAt) {
  const recoveryTransaction = database.transaction(
    () => {
      const runningTasks = database
        .prepare(`
          SELECT
            id,
            name,
            status,
            attempt_count
          FROM tasks
          WHERE status = ?
          ORDER BY created_at ASC, rowid ASC
        `)
        .all(TASK_STATUS.RUNNING);

      if (runningTasks.length === 0) {
        return [];
      }

      const updateStatement = database.prepare(`
        UPDATE tasks
        SET
          status = ?,
          started_at = NULL,
          completed_at = NULL,
          next_attempt_at = NULL,
          error_message = NULL,
          updated_at = ?
        WHERE id = ?
          AND status = ?
      `);

      const recoveredTasks = [];

      for (const task of runningTasks) {
        const result = updateStatement.run(
          TASK_STATUS.WAITING,
          recoveredAt,
          task.id,
          TASK_STATUS.RUNNING
        );

        if (result.changes === 0) {
          continue;
        }

        insertEventStatement.run(
          task.id,
          EVENT_TYPES.TASK_RECOVERED,
          TASK_STATUS.RUNNING,
          TASK_STATUS.WAITING,
          "Interrupted task returned to WAITING after service restart",
          recoveredAt
        );

        recoveredTasks.push({
          ...task,
          status: TASK_STATUS.WAITING,
        });
      }

      return recoveredTasks;
    }
  );

  return recoveryTransaction();
}

/*
 * Task statistics
 */

function getTaskStatusCounts() {
  const rows = database
    .prepare(`
      SELECT
        status,
        COUNT(*) AS count
      FROM tasks
      GROUP BY status
    `)
    .all();

  const counts = {
    [TASK_STATUS.RUNNING]: 0,
    [TASK_STATUS.WAITING]: 0,
    [TASK_STATUS.RETRY_WAIT]: 0,
    [TASK_STATUS.SUCCEEDED]: 0,
    [TASK_STATUS.FAILED]: 0,
    [TASK_STATUS.BLOCKED]: 0,
    [TASK_STATUS.CANCELLED]: 0,
  };

  for (const row of rows) {
    counts[row.status] = row.count;
  }

  return counts;
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
  cancelTask,
  recoverRunningTasks,
  getTaskStatusCounts,
};