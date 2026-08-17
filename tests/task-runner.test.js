const taskService = require(
  "../src/services/task.service"
);

const taskRepository = require(
  "../src/repositories/task.repository"
);

const {
  calculateBackoffDelay,
} = require("../src/services/task-runner.service");

const TASK_STATUS = require(
  "../src/constants/task-status"
);

const {
  resetDatabase,
} = require("./helpers/database");

beforeEach(() => {
  resetDatabase();
});

function createTask(clientId, dependencies = []) {
  return {
    clientId,
    name: clientId,
    durationMs: 1000,
    failureProbability: 0,
    maxRetries: 2,
    dependencies,
  };
}

function submitTasks(tasks) {
  const createdTasks = taskService.submitTasks(tasks);

  return new Map(
    createdTasks.map((task) => [
      task.clientId,
      task.id,
    ])
  );
}

function propagateBlockedTasks(currentTime) {
  let blockedCount;

  do {
    blockedCount =
      taskRepository.blockTasksWithFailedDependencies(
        currentTime
      );
  } while (blockedCount > 0);
}

describe("Task runner behavior", () => {
  test("a dependent task waits for its dependency", () => {
    const ids = submitTasks([
      createTask("extract"),
      createTask("classify", ["extract"]),
    ]);

    const now = new Date().toISOString();

    const firstClaim =
      taskRepository.claimReadyTasks(2, now);

    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0].id).toBe(
      ids.get("extract")
    );

    expect(
      taskRepository.findTaskById(
        ids.get("classify")
      ).status
    ).toBe(TASK_STATUS.WAITING);

    taskRepository.markTaskSucceeded(
      ids.get("extract"),
      new Date().toISOString()
    );

    const secondClaim =
      taskRepository.claimReadyTasks(
        2,
        new Date().toISOString()
      );

    expect(secondClaim).toHaveLength(1);
    expect(secondClaim[0].id).toBe(
      ids.get("classify")
    );
  });

  test("all dependencies must succeed before a task starts", () => {
    const ids = submitTasks([
      createTask("extract-text"),
      createTask("scan-malware"),
      createTask("classify", [
        "extract-text",
        "scan-malware",
      ]),
    ]);

    const firstClaim =
      taskRepository.claimReadyTasks(
        2,
        new Date().toISOString()
      );

    expect(firstClaim).toHaveLength(2);

    taskRepository.markTaskSucceeded(
      ids.get("extract-text"),
      new Date().toISOString()
    );

    const beforeSecondSuccess =
      taskRepository.claimReadyTasks(
        2,
        new Date().toISOString()
      );

    expect(beforeSecondSuccess).toHaveLength(0);

    taskRepository.markTaskSucceeded(
      ids.get("scan-malware"),
      new Date().toISOString()
    );

    const afterBothSucceeded =
      taskRepository.claimReadyTasks(
        2,
        new Date().toISOString()
      );

    expect(afterBothSucceeded).toHaveLength(1);
    expect(afterBothSucceeded[0].id).toBe(
      ids.get("classify")
    );
  });

  test("never claims more than the concurrency limit", () => {
    submitTasks([
      createTask("task-1"),
      createTask("task-2"),
      createTask("task-3"),
      createTask("task-4"),
      createTask("task-5"),
    ]);

    const firstClaim =
      taskRepository.claimReadyTasks(
        2,
        new Date().toISOString()
      );

    expect(firstClaim).toHaveLength(2);
    expect(
      taskRepository.countRunningTasks()
    ).toBe(2);

    const secondClaim =
      taskRepository.claimReadyTasks(
        2,
        new Date().toISOString()
      );

    expect(secondClaim).toHaveLength(0);
    expect(
      taskRepository.countRunningTasks()
    ).toBe(2);
  });

  test("ready tasks are claimed in FIFO order", () => {
    const ids = submitTasks([
      createTask("first"),
      createTask("second"),
      createTask("third"),
    ]);

    const claimed =
      taskRepository.claimReadyTasks(
        2,
        new Date().toISOString()
      );

    expect(claimed.map((task) => task.id)).toEqual([
      ids.get("first"),
      ids.get("second"),
    ]);
  });

  test("retry delay increases exponentially", () => {
    expect(calculateBackoffDelay(1)).toBe(10);
    expect(calculateBackoffDelay(2)).toBe(20);
    expect(calculateBackoffDelay(3)).toBe(40);
  });

  test("a retrying task waits until nextAttemptAt", () => {
    const ids = submitTasks([
      createTask("extract"),
    ]);

    const startedAt =
      "2026-08-17T10:00:00.000Z";

    const claimed =
      taskRepository.claimReadyTasks(
        1,
        startedAt
      );

    expect(claimed).toHaveLength(1);

    const nextAttemptAt =
      "2026-08-17T10:00:10.000Z";

    taskRepository.markTaskForRetry(
      ids.get("extract"),
      "Test failure",
      nextAttemptAt,
      "2026-08-17T10:00:01.000Z"
    );

    const tooEarly =
      taskRepository.claimReadyTasks(
        1,
        "2026-08-17T10:00:05.000Z"
      );

    expect(tooEarly).toHaveLength(0);

    const retryClaim =
      taskRepository.claimReadyTasks(
        1,
        "2026-08-17T10:00:10.000Z"
      );

    expect(retryClaim).toHaveLength(1);
    expect(retryClaim[0].attempt_count).toBe(2);
  });

  test("permanent failure blocks all dependents", () => {
    const ids = submitTasks([
      createTask("extract"),
      createTask("classify", ["extract"]),
      createTask("report", ["classify"]),
    ]);

    const now = new Date().toISOString();

    taskRepository.claimReadyTasks(1, now);

    taskRepository.markTaskFailed(
      ids.get("extract"),
      "Permanent test failure",
      new Date().toISOString()
    );

    propagateBlockedTasks(
      new Date().toISOString()
    );

    expect(
      taskRepository.findTaskById(
        ids.get("extract")
      ).status
    ).toBe(TASK_STATUS.FAILED);

    expect(
      taskRepository.findTaskById(
        ids.get("classify")
      ).status
    ).toBe(TASK_STATUS.BLOCKED);

    expect(
      taskRepository.findTaskById(
        ids.get("report")
      ).status
    ).toBe(TASK_STATUS.BLOCKED);
  });

  test("cancelling a task blocks its dependents", () => {
    const ids = submitTasks([
      createTask("extract"),
      createTask("classify", ["extract"]),
    ]);

    taskService.cancelTask(ids.get("extract"));

    propagateBlockedTasks(
      new Date().toISOString()
    );

    expect(
      taskRepository.findTaskById(
        ids.get("extract")
      ).status
    ).toBe(TASK_STATUS.CANCELLED);

    expect(
      taskRepository.findTaskById(
        ids.get("classify")
      ).status
    ).toBe(TASK_STATUS.BLOCKED);
  });

  test("running tasks return to waiting after restart recovery", () => {
    const ids = submitTasks([
      createTask("extract"),
    ]);

    taskRepository.claimReadyTasks(
      1,
      new Date().toISOString()
    );

    expect(
      taskRepository.findTaskById(
        ids.get("extract")
      ).status
    ).toBe(TASK_STATUS.RUNNING);

    const recoveredTasks =
      taskRepository.recoverRunningTasks(
        new Date().toISOString()
      );

    expect(recoveredTasks).toHaveLength(1);

    expect(
      taskRepository.findTaskById(
        ids.get("extract")
      ).status
    ).toBe(TASK_STATUS.WAITING);

    const events = taskRepository.findEvents(
      ids.get("extract")
    );

    expect(
      events.some(
        (event) =>
          event.event_type === "TASK_RECOVERED"
      )
    ).toBe(true);
  });
});