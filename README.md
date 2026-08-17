# AI Document Processing Task Runner

A persistent task runner for simulated AI document-processing workflows.

Tasks can depend on other tasks, and a task is allowed to run only after all of its dependencies have completed successfully. The runner also handles concurrency limits, retries, failed dependencies, cancellation, circular dependency detection, and service restarts.

The actual document-processing work is simulated so the focus stays on task scheduling and failure handling.

## Features

* Dependency-aware task execution
* Configurable concurrency limit
* Retries with exponential backoff
* Permanent failure handling
* Automatic blocking of dependent tasks
* Circular dependency detection before submission
* Persistent task state using SQLite
* Restart recovery for interrupted tasks
* FIFO scheduling for ready tasks
* Task cancellation
* Task statistics
* Task activity history for debugging and observability

## Technology

* Node.js
* Express.js
* SQLite
* `better-sqlite3`
* Jest
* Supertest
* dotenv

## Requirements

* Node.js 22 LTS
* npm

## Setup

Clone the repository:

```bash
git clone https://github.com/udaytopper/ai-document-task-runner.git
cd ai-document-task-runner
```

Install dependencies:

```bash
npm install
```

Create the local environment file.

Git Bash, macOS or Linux:

```bash
cp .env.example .env
```

Windows Command Prompt:

```cmd
copy .env.example .env
```

Start the service:

```bash
npm start
```

For development with automatic restart:

```bash
npm run dev
```

The service runs by default at:

```text
http://localhost:3000
```

Check that it is running:

```http
GET /health
```

Example response:

```json
{
  "status": "healthy",
  "service": "AI Document Processing Task Runner"
}
```

## Configuration

The default configuration is provided in `.env.example`:

```env
PORT=3000
CONCURRENCY_LIMIT=2
SCHEDULER_INTERVAL_MS=500
BASE_RETRY_DELAY_MS=1000
```

* `CONCURRENCY_LIMIT` controls the maximum number of tasks that may be running at the same time.
* `SCHEDULER_INTERVAL_MS` controls how often the scheduler checks for work.
* `BASE_RETRY_DELAY_MS` is the starting delay used for exponential retry backoff.

The application stores task data in:

```text
data/tasks.db
```

Tests use an in-memory SQLite database and do not modify the local application database.

## API

| Method | Endpoint                    | Description                                |
| ------ | --------------------------- | ------------------------------------------ |
| `POST` | `/api/tasks`                | Submit a workflow                          |
| `GET`  | `/api/tasks`                | List all tasks                             |
| `GET`  | `/api/tasks?status=WAITING` | Filter tasks by status                     |
| `GET`  | `/api/tasks/:id`            | Get one task and its dependencies          |
| `POST` | `/api/tasks/:id/cancel`     | Cancel a waiting or retrying task          |
| `GET`  | `/api/tasks/:id/events`     | View task activity history                 |
| `GET`  | `/api/stats`                | View task counts and the concurrency limit |

## Example workflow

```json
{
  "tasks": [
    {
      "clientId": "extract",
      "name": "extract_text",
      "durationMs": 1000,
      "failureProbability": 0.1,
      "maxRetries": 2,
      "dependencies": []
    },
    {
      "clientId": "classify",
      "name": "classify_document",
      "durationMs": 1200,
      "failureProbability": 0.1,
      "maxRetries": 2,
      "dependencies": ["extract"]
    },
    {
      "clientId": "report",
      "name": "generate_report",
      "durationMs": 800,
      "failureProbability": 0.05,
      "maxRetries": 2,
      "dependencies": ["classify"]
    }
  ]
}
```

Dependencies use `clientId` values from tasks in the same submitted workflow. Stored tasks receive generated UUIDs.

`maxRetries` means retries after the initial execution.

For example:

```text
maxRetries = 2
```

allows:

```text
Attempt 1 - initial execution
Attempt 2 - first retry
Attempt 3 - second retry
```

## Task states

The runner uses the following states:

* `WAITING` - waiting for dependencies or an available concurrency slot
* `RUNNING` - currently executing
* `RETRY_WAIT` - waiting until the next retry time
* `SUCCEEDED` - completed successfully
* `FAILED` - permanently failed after using all retries
* `BLOCKED` - cannot run because a dependency failed, was blocked, or was cancelled
* `CANCELLED` - cancelled before execution

## Tests

Run all automated tests:

```bash
npm test
```

Run the test suite with coverage:

```bash
npm run test:coverage
```

The tests cover API behavior, validation, circular dependencies, dependency scheduling, concurrency, retries, failure propagation, cancellation, FIFO ordering, and restart recovery.

For implementation details and the decisions behind the runner, see [DESIGN.md](./DESIGN.md).

For alternatives considered and their trade-offs, see [TRADEOFFS.md](./TRADEOFFS.md).
