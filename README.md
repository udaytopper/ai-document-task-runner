# AI Document Processing Task Runner

A persistent task-running service for simulated document-processing workflows. Tasks can depend on other tasks and run only after all their dependencies succeed.

The service supports configurable concurrency, retries with exponential backoff, dependency failure propagation, circular-dependency detection, cancellation, restart recovery, statistics, and task activity history.

## Technology

- Node.js
- Express.js
- SQLite using `better-sqlite3`
- Jest and Supertest

## Setup

Requirements:

- Node.js 18 or newer
- npm

Clone and install:

```bash
git clone https://github.com/udaytopper/ai-document-task-runner.git
cd ai-document-task-runner
npm install
```

Create the environment file:

```bash
cp .env.example .env
```

On Windows Command Prompt:

```cmd
copy .env.example .env
```

Start the service:

```bash
npm start
```

For development:

```bash
npm run dev
```

The service runs at:

```text
http://localhost:3000
```

Health check:

```http
GET /health
```

## Configuration

```env
PORT=3000
CONCURRENCY_LIMIT=2
SCHEDULER_INTERVAL_MS=500
BASE_RETRY_DELAY_MS=1000
```

## API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/tasks` | Submit a task workflow |
| `GET` | `/api/tasks` | List all tasks |
| `GET` | `/api/tasks?status=WAITING` | Filter tasks by status |
| `GET` | `/api/tasks/:id` | Get one task |
| `POST` | `/api/tasks/:id/cancel` | Cancel a waiting or retrying task |
| `GET` | `/api/tasks/:id/events` | Get task activity history |
| `GET` | `/api/stats` | Get status counts and concurrency limit |

Example submission:

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

`maxRetries: 2` allows three executions: one initial attempt and two retries.

## Task states

- `WAITING`
- `RUNNING`
- `RETRY_WAIT`
- `SUCCEEDED`
- `FAILED`
- `BLOCKED`
- `CANCELLED`

## Tests

Run all tests:

```bash
npm test
```

Run tests with coverage:

```bash
npm run test:coverage
```

More implementation details are available in [DESIGN.md](./DESIGN.md), and engineering decisions are documented in [TRADEOFFS.md](./TRADEOFFS.md).