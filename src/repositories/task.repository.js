/*
 * Task cancellation
 */

function cancelTask(taskId, cancelledAt) {
  const cancelTransaction = database.transaction(() => {
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

    if (!cancellableStatuses.includes(task.status)) {
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
  });

  return cancelTransaction();
}

/*
 * Restart recovery
 */

function recoverRunningTasks(recoveredAt) {
  const recoveryTransaction = database.transaction(() => {
    const runningTasks = database
      .prepare(`
        SELECT id, name, status, attempt_count
        FROM tasks
        WHERE status = ?
        ORDER BY created_at ASC
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
  });

  return recoveryTransaction();
}

/*
 * Task status metrics
 */

function getTaskStatusCounts() {
  const rows = database
    .prepare(`
      SELECT status, COUNT(*) AS count
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