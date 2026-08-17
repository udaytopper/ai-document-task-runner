# Trade-offs

## 1. SQLite instead of MySQL or PostgreSQL

### Selected

SQLite with `better-sqlite3`.

### Alternative

A separate MySQL or PostgreSQL server.

### Reason

SQLite provides persistent storage without requiring the reviewer to install or configure another service. This keeps clean-clone setup short and allows task state, dependencies and events to be stored transactionally.

### Downside

SQLite is not the best choice for many service instances writing concurrently. A production distributed runner would likely use PostgreSQL with row locking or a dedicated queue.

## 2. Polling scheduler instead of a message queue

### Selected

A scheduler that checks SQLite at a configurable interval.

### Alternative

Redis with BullMQ, RabbitMQ, SQS or another message broker.

### Reason

Polling keeps the project small, makes task selection rules visible in the code and avoids requiring additional infrastructure. It is appropriate for the assignment’s single-service scope.

### Downside

Polling creates repeated database queries even when no work exists. It also adds up to one polling interval of scheduling delay.

## 3. FIFO instead of priority scheduling

### Selected

Ready tasks run in order of creation time and SQLite insertion order.

### Alternative

A priority queue, shortest-job-first scheduling or explicit task priorities.

### Reason

FIFO is deterministic, fair to older tasks and easy to test and explain.

### Downside

A long-running old task can run before a short urgent task. There is no way for an important task to move ahead of the queue.

## 4. At-least-once instead of exactly-once execution

### Selected

Tasks interrupted by a restart return to `WAITING` and execute again.

### Alternative

Mark interrupted tasks permanently failed, or build an exactly-once coordination mechanism.

### Reason

Re-executing interrupted tasks prevents unfinished work from being silently lost. It is simple and reliable for this simulated runner.

### Downside

A task may execute twice if its work completed just before a crash but the successful status was not saved. Real task handlers would need to be idempotent.