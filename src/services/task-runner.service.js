const config = require("../config");
const taskRepository = require("../repositories/task.repository");
const sleep = require("../utils/sleep");

let schedulerRunning = false;
let schedulerInterval = null;

/*
 * maxRetries represents retries after the initial attempt.
 *
 * For maxRetries = 2:
 * attempt 1 fails -> wait base delay
 * attempt 2 fails -> wait twice the base delay
 * attempt 3 fails -> permanently FAILED
 */
function calculateBackoffDelay(attemptCount) {
  return (
    config.baseRetryDelayMs *
    Math.pow(2, attemptCount - 1)
  );
}

/*
 * A configurable failure probability of:
 *
 * 0   -> always succeeds
 * 1   -> always fails
 * 0.2 -> approximately 20% of attempts fail
 */
async function simulateTask(task) {
  await sleep(task.duration_ms);

  const shouldFail =
    Math.random() < task.failure_probability;

  if (shouldFail) {
    throw new Error(
      "Simulated document-processing failure"
    );
  }

  return true;
}

async function executeTask(task) {
  try {
    console.log(
      `Starting task "${task.name}" ` +
        `(attempt ${task.attempt_count})`
    );

    await simulateTask(task);

    const completedAt = new Date().toISOString();

    const updated = taskRepository.markTaskSucceeded(
      task.id,
      completedAt
    );

    if (updated) {
      console.log(
        `Task succeeded: "${task.name}" ` +
          `(attempt ${task.attempt_count})`
      );
    }
  } catch (error) {
    const failedAt = new Date();
    const attemptsUsed = task.attempt_count;

    /*
     * Example:
     *
     * maxRetries = 2
     *
     * Attempt 1: 1 <= 2 -> retry
     * Attempt 2: 2 <= 2 -> retry
     * Attempt 3: 3 <= 2 -> permanent failure
     */
    const shouldRetry =
      attemptsUsed <= task.max_retries;

    if (shouldRetry) {
      const retryDelay =
        calculateBackoffDelay(attemptsUsed);

      const nextAttemptAt = new Date(
        failedAt.getTime() + retryDelay
      ).toISOString();

      const updated =
        taskRepository.markTaskForRetry(
          task.id,
          error.message,
          nextAttemptAt,
          failedAt.toISOString()
        );

      if (updated) {
        console.log(
          `Task "${task.name}" failed on attempt ` +
            `${attemptsUsed}. Retry scheduled in ` +
            `${retryDelay} ms.`
        );
      }

      return;
    }

    const updated = taskRepository.markTaskFailed(
      task.id,
      error.message,
      failedAt.toISOString()
    );

    if (updated) {
      console.log(
        `Task permanently failed: "${task.name}" ` +
          `after ${attemptsUsed} attempts.`
      );
    }
  }
}

/*
 * Run one scheduler cycle.
 *
 * The schedulerRunning lock prevents two polling cycles from selecting tasks
 * simultaneously in this Node.js process.
 */
async function scheduleReadyTasks() {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;

  try {
    const currentTime = new Date().toISOString();

    /*
     * Propagate BLOCKED status through the complete dependency chain.
     *
     * Example:
     * A fails -> B blocked -> C blocked
     *
     * The loop repeats until no additional tasks need to be blocked.
     */
    let blockedCount;

    do {
      blockedCount =
        taskRepository.blockTasksWithFailedDependencies(
          currentTime
        );
    } while (blockedCount > 0);

    /*
     * claimReadyTasks performs the following inside one SQLite transaction:
     *
     * 1. Count RUNNING tasks.
     * 2. Calculate available concurrency slots.
     * 3. Select ready tasks in FIFO order.
     * 4. Mark selected tasks RUNNING.
     */
    const claimedTasks =
      taskRepository.claimReadyTasks(
        config.concurrencyLimit,
        currentTime
      );

    /*
     * Do not await tasks one by one.
     *
     * Starting them independently allows tasks to run concurrently.
     * Their RUNNING states were already saved before execution began.
     */
    for (const task of claimedTasks) {
      executeTask(task).catch((error) => {
        console.error(
          `Unexpected execution error for task ${task.id}:`,
          error
        );
      });
    }
  } catch (error) {
    console.error("Scheduler cycle failed:", error);
  } finally {
    schedulerRunning = false;
  }
}

function startTaskRunner() {
  if (schedulerInterval) {
    return;
  }

  const recoveredAt = new Date().toISOString();

  const recoveredTasks =
    taskRepository.recoverRunningTasks(recoveredAt);

  if (recoveredTasks.length > 0) {
    console.log(
      `Recovered ${recoveredTasks.length} interrupted task(s)`
    );
  }

  console.log(
    "Task runner started with " +
      `concurrency limit ${config.concurrencyLimit} ` +
      `and polling interval ${config.schedulerIntervalMs} ms`
  );

  scheduleReadyTasks().catch((error) => {
    console.error(
      "Initial scheduler cycle failed:",
      error
    );
  });

  schedulerInterval = setInterval(() => {
    scheduleReadyTasks().catch((error) => {
      console.error(
        "Scheduled runner cycle failed:",
        error
      );
    });
  }, config.schedulerIntervalMs);
}

function stopTaskRunner() {
  if (!schedulerInterval) {
    return;
  }

  clearInterval(schedulerInterval);
  schedulerInterval = null;

  console.log("Task runner stopped");
}

module.exports = {
  calculateBackoffDelay,
  simulateTask,
  executeTask,
  scheduleReadyTasks,
  startTaskRunner,
  stopTaskRunner,
};