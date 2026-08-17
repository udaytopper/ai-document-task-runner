# Trade-offs

This project intentionally keeps the architecture small. The goal was to build a correct and explainable task runner within the assignment scope rather than introduce infrastructure that the problem did not require.

## 1. SQLite instead of PostgreSQL or MySQL

### Selected

SQLite using `better-sqlite3`.

### Alternative

Run PostgreSQL or MySQL as a separate database service.

### Why I chose SQLite

The runner needs persistent task state, relationships and transactions, but it does not need a distributed database for the assignment.

SQLite gives the project durable storage while keeping setup simple:

```bash
npm install
npm start
```

A reviewer does not need to install a database server, create credentials or configure another service.

SQLite transactions are also sufficient for storing workflows and claiming tasks safely within the single-process architecture.

### Trade-off

SQLite is not the database I would choose for a task runner with many application instances writing concurrently.

A larger version of this system would likely move task state to PostgreSQL and use database locking or a dedicated work queue.

---

## 2. Polling scheduler instead of a message queue

### Selected

A scheduler that checks SQLite at a configurable interval.

### Alternative

Redis with BullMQ, RabbitMQ, SQS or another message broker.

### Why I chose polling

The assignment focuses on dependency handling, concurrency, retries and failure recovery.

A polling scheduler keeps those rules visible in the application code instead of delegating important behavior to another system.

It also keeps the project easy to run from a clean clone and avoids introducing infrastructure only for the sake of appearing more production-like.

For a small single-service runner, the approach is sufficient.

### Trade-off

Polling performs database queries even when no work is available.

It also introduces scheduling latency of up to approximately one polling interval.

At higher scale, an event-driven queue would use resources more efficiently and would make it easier to distribute work across multiple workers.

---

## 3. FIFO scheduling instead of priorities

### Selected

Ready tasks are ordered by:

```text
created_at ASC, rowid ASC
```

### Alternative

Priority scheduling, shortest-job-first scheduling, deadlines, or separate queues.

### Why I chose FIFO

FIFO is predictable.

Older ready work is handled before newer work, and the ordering is deterministic when tasks are created at the same time.

It is also easy to test and easy to explain during review.

For this assignment, I preferred a simple scheduling policy whose behavior is obvious over a more sophisticated policy with additional configuration.

### Trade-off

FIFO cannot represent urgency.

For example, a long-running task submitted earlier can occupy a slot before a newer one-second task that is much more important.

A real system might add task priority or deadline information.

---

## 4. At-least-once execution instead of exactly-once execution

### Selected

If the service restarts while a task is `RUNNING`, that task is returned to `WAITING` and executed again.

### Alternative

Treat interrupted tasks as failed, or introduce coordination intended to provide exactly-once execution.

### Why I chose at-least-once

After a process crash, the runner cannot know with certainty whether an interrupted task finished its external work before the process stopped.

Re-running the task avoids silently losing unfinished work.

It also gives restart behavior that is simple to understand:

```text
RUNNING
   ↓ service stops
WAITING
   ↓
execute again
```

For this project, preventing lost work is more useful than trying to simulate exactly-once guarantees that the system cannot truly provide.

### Trade-off

Duplicate execution is possible.

A task may finish its real-world operation and then crash before its `SUCCEEDED` state is persisted. When the service restarts, that task will run again.

A production implementation should therefore make task handlers idempotent where practical, for example by using operation identifiers or checking whether the expected output already exists.
