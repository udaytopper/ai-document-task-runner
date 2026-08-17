const request = require("supertest");
const app = require("../src/app");
const { resetDatabase } = require("./helpers/database");

beforeEach(() => {
  resetDatabase();
});

function createTask(overrides = {}) {
  return {
    clientId: "extract",
    name: "extract_text",
    durationMs: 1000,
    failureProbability: 0,
    maxRetries: 2,
    dependencies: [],
    ...overrides,
  };
}

describe("Task API", () => {
  test("health endpoint returns a successful response", async () => {
    const response = await request(app)
      .get("/health")
      .expect(200);

    expect(response.body).toEqual({
      status: "healthy",
      service: "AI Document Processing Task Runner",
    });
  });

  test("submits a valid task workflow", async () => {
    const response = await request(app)
      .post("/api/tasks")
      .send({
        tasks: [
          createTask(),
          createTask({
            clientId: "classify",
            name: "classify_document",
            dependencies: ["extract"],
          }),
        ],
      })
      .expect(201);

    expect(response.body.message).toBe(
      "Tasks submitted successfully"
    );

    expect(response.body.tasks).toHaveLength(2);
    expect(response.body.tasks[0].id).toEqual(
      expect.any(String)
    );
    expect(response.body.tasks[1].id).toEqual(
      expect.any(String)
    );
  });

  test("rejects circular dependencies", async () => {
    const response = await request(app)
      .post("/api/tasks")
      .send({
        tasks: [
          createTask({
            clientId: "task-a",
            dependencies: ["task-b"],
          }),
          createTask({
            clientId: "task-b",
            name: "classify_document",
            dependencies: ["task-a"],
          }),
        ],
      })
      .expect(400);

    expect(response.body.error).toContain(
      "Circular dependency detected"
    );
  });

  test("rejects a dependency that does not exist", async () => {
    const response = await request(app)
      .post("/api/tasks")
      .send({
        tasks: [
          createTask({
            dependencies: ["missing-task"],
          }),
        ],
      })
      .expect(400);

    expect(response.body.error).toContain(
      "depends on unknown task"
    );
  });

  test("gets one task with its dependencies", async () => {
    const submission = await request(app)
      .post("/api/tasks")
      .send({
        tasks: [
          createTask(),
          createTask({
            clientId: "classify",
            name: "classify_document",
            dependencies: ["extract"],
          }),
        ],
      })
      .expect(201);

    const classifyTask = submission.body.tasks.find(
      (task) => task.clientId === "classify"
    );

    const response = await request(app)
      .get(`/api/tasks/${classifyTask.id}`)
      .expect(200);

    expect(response.body.status).toBe("WAITING");
    expect(response.body.attemptCount).toBe(0);
    expect(response.body.dependencies).toHaveLength(1);
    expect(response.body.dependencies[0].name).toBe(
      "extract_text"
    );
  });

  test("returns task activity history", async () => {
    const submission = await request(app)
      .post("/api/tasks")
      .send({
        tasks: [createTask()],
      })
      .expect(201);

    const taskId = submission.body.tasks[0].id;

    const response = await request(app)
      .get(`/api/tasks/${taskId}/events`)
      .expect(200);

    expect(response.body.taskId).toBe(taskId);
    expect(response.body.events).toHaveLength(1);

    expect(response.body.events[0]).toMatchObject({
      eventType: "TASK_SUBMITTED",
      fromStatus: null,
      toStatus: "WAITING",
    });
  });

  test("filters tasks by status", async () => {
    await request(app)
      .post("/api/tasks")
      .send({
        tasks: [createTask()],
      })
      .expect(201);

    const response = await request(app)
      .get("/api/tasks?status=waiting")
      .expect(200);

    expect(response.body.count).toBe(1);
    expect(response.body.tasks[0].status).toBe(
      "WAITING"
    );
  });

  test("returns 404 for an unknown task", async () => {
    const response = await request(app)
      .get("/api/tasks/not-a-real-task")
      .expect(404);

    expect(response.body.error).toContain(
      "Task not found"
    );
  });

  test("cancels a waiting task", async () => {
    const submission = await request(app)
      .post("/api/tasks")
      .send({
        tasks: [createTask()],
      })
      .expect(201);

    const taskId = submission.body.tasks[0].id;

    const response = await request(app)
      .post(`/api/tasks/${taskId}/cancel`)
      .expect(200);

    expect(response.body.message).toBe(
      "Task cancelled successfully"
    );

    expect(response.body.task.status).toBe(
      "CANCELLED"
    );
  });

  test("returns current task statistics", async () => {
    await request(app)
      .post("/api/tasks")
      .send({
        tasks: [
          createTask(),
          createTask({
            clientId: "classify",
            name: "classify_document",
            dependencies: ["extract"],
          }),
        ],
      })
      .expect(201);

    const response = await request(app)
      .get("/api/stats")
      .expect(200);

    expect(response.body).toMatchObject({
      running: 0,
      waiting: 2,
      retryWaiting: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      concurrencyLimit: 2,
    });
  });
});