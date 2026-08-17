# Design

## 1. Scenario

I chose an AI document-processing pipeline as the real-world scenario for the task runner.

A document may need to go through several operations such as:

1. Extract text
2. Scan for malware
3. Classify the document
4. Extract structured fields
5. Validate extracted fields
6. Generate a report

Some of these operations can run independently, while others need results from previous steps.

For example:

```text
extract_text
    |
    +--> classify_document -----+
    |                           |
    +--> extract_fields         +--> generate_report
             |                  |
             +--> validate -----+
```

`generate_report` cannot start until every task it depends on has succeeded.

The actual document-processing work is intentionally simulated. Each task has a configured duration and failure probability. The runner sleeps for a random duration between approximately 50% and 100% of the configured duration, then decides whether the attempt succeeds or fails.

This keeps the project focused on scheduling, dependencies, retries, persistence and failure handling rather than on the document-processing implementation itself.

## 2. Architecture

The application is separated into a few small responsibilities.

* **Routes** define the HTTP endpoints.
* **Controllers** translate HTTP requests into service calls and responses.
* **Task service** performs workflow validation and application-level operations.
* **Repository** handles SQLite queries and transactions.
* **Task runner** finds executable tasks and manages execution, retries and failures.
* **SQLite** stores tasks, dependencies and activity events.

The scheduler polls SQLite at a configurable interval instead of using an external queue.

Each scheduler cycle:

1. Prevents another scheduler cycle from overlapping.
2. Propagates blocked states through dependency chains.
3. Checks how many tasks are currently `RUNNING`.
4. Calculates the remaining concurrency slots.
5. Finds tasks whose dependencies have all succeeded.
6. Selects ready tasks in FIFO order.
7. Claims those tasks by changing them to `RUNNING` in a transaction.
8. Starts their simulated execution.
9. Records success, retry or permanent failure.

## 3. Workflow submission and validation

Dependencies are submitted using `clientId` values belonging to tasks in the same workflow.

Before anything is written to the database, the service validates that:

* `tasks` is a non-empty array.
* Every task has a non-empty `clientId`.
* `clientId` values are unique.
* Every task has a non-empty name.
* `durationMs` is within the accepted range.
* `failureProbability` is between `0` and `1`.
* `maxRetries` is a valid non-negative integer.
* `dependencies` is an array when provided.
* A dependency is not listed twice.
* Every dependency exists in the same workflow.
* A task does not depend on itself.
* The dependency graph contains no cycle.

Invalid workflows are rejected with `400 Bad Request`.

All tasks are inserted first and their dependency records are inserted afterwards. The entire operation runs inside one SQLite transaction, so a failure cannot leave half of a workflow stored in the database.

## 4. Circular dependency detection

A circular dependency must be rejected before execution begins.

For example:

```text
task-a -> task-b -> task-a
```

would mean neither task could ever become ready.

Cycle detection uses depth-first search with:

* a `visited` set for tasks that have already been fully checked
* a `visiting` set for tasks currently in the DFS path
* a path array so the error can describe the actual cycle

If DFS reaches a task already in `visiting`, a cycle exists and the submission is rejected.

For example:

```json
{
  "error": "Circular dependency detected: task-a -> task-b -> task-a"
}
```

## 5. Dependency execution

A task can start only when every dependency has status:

```text
SUCCEEDED
```

The repository enforces this when selecting ready tasks using a SQL `NOT EXISTS` check. If any dependency is not successful, the task is not selected.

This is one of the most important correctness rules in the application.

For example:

```text
extract_text -> SUCCEEDED
classify_document -> SUCCEEDED
extract_fields -> RUNNING
```

If `generate_report` depends on both `classify_document` and `extract_fields`, it must remain waiting until `extract_fields` also succeeds.

## 6. Concurrency control

The configured invariant is:

```text
RUNNING task count <= CONCURRENCY_LIMIT
```

`claimReadyTasks()` performs the critical scheduling work inside a synchronous SQLite transaction.

It:

1. Counts currently running tasks.
2. Calculates:

```text
availableSlots = concurrencyLimit - runningCount
```

3. Selects at most that many ready tasks.
4. Changes those tasks to `RUNNING`.
5. Increments their attempt counts.
6. Records their `TASK_STARTED` events.

Tasks are marked `RUNNING` before asynchronous execution begins. This reserves the slots immediately, so the next scheduler cycle sees the updated running count.

The scheduler also has a process-level `schedulerRunning` lock to prevent two polling cycles from overlapping inside the same Node.js process.

This design intentionally supports one service process. A multi-instance deployment would require stronger distributed coordination.

## 7. Retries

`maxRetries` means the number of retries after the initial attempt.

For example:

```text
maxRetries = 2
```

allows three total executions:

```text
Attempt 1 - initial execution
Attempt 2 - first retry
Attempt 3 - second retry
```

When an attempt fails but retries remain, the task moves to:

```text
RETRY_WAIT
```

and receives a `next_attempt_at` timestamp.

Retry delay uses exponential backoff:

```text
delay = BASE_RETRY_DELAY_MS * 2^(attemptCount - 1)
```

With a base delay of 1000 ms:

```text
Attempt 1 fails -> wait 1000 ms
Attempt 2 fails -> wait 2000 ms
Attempt 3 fails -> permanently FAILED
```

A retrying task does not become ready until `next_attempt_at` has been reached.

## 8. Failed dependencies and blocking

A task should never wait forever for work that can no longer succeed.

If one of its dependencies becomes:

```text
FAILED
BLOCKED
CANCELLED
```

the waiting task becomes:

```text
BLOCKED
```

Blocking is repeatedly propagated until no additional tasks can be blocked.

For example:

```text
A -> FAILED
B depends on A -> BLOCKED
C depends on B -> BLOCKED
```

This guarantees that an impossible workflow eventually reaches a clear terminal state instead of leaving downstream tasks in `WAITING`.

## 9. Cancellation

I allow cancellation only when a task is:

```text
WAITING
RETRY_WAIT
```

A `RUNNING` task is not forcibly interrupted.

The reason for this decision is that safe interruption normally requires cooperative cancellation inside the work being executed. For this assignment, allowing cancellation only before execution keeps the behavior predictable and avoids pretending that arbitrary work can always be stopped safely.

When a task is cancelled:

1. Its status becomes `CANCELLED`.
2. A `TASK_CANCELLED` event is recorded.
3. Tasks depending on it become `BLOCKED`.
4. Blocking continues through further descendants.

A downside of this choice is that running tasks cannot currently be cancelled and cancelled workflows cannot be resumed.

## 10. Restart recovery

Task state is stored in SQLite, so completed work survives a service restart.

The difficult case is a task that was `RUNNING` when the service stopped.

On startup, `recoverRunningTasks()` finds those tasks and changes them from:

```text
RUNNING -> WAITING
```

A `TASK_RECOVERED` activity event is also recorded.

The scheduler can then execute the task again.

I chose this because silently treating interrupted work as successful would be incorrect, while permanently failing it would make temporary service failures unnecessarily destructive.

The result is **at-least-once execution**.

This means interrupted work is not silently lost, but duplicate execution is possible.

For example, a task could finish an external operation and the process could crash immediately before saving `SUCCEEDED`. After restart, the task would run again.

In a real document-processing system, task handlers should therefore be designed to be idempotent where possible.

## 11. Scheduling policy

When several tasks are ready and a concurrency slot becomes available, the runner uses FIFO ordering:

```text
ORDER BY created_at ASC, rowid ASC
```

Older tasks are selected first.

`rowid` provides deterministic insertion order when multiple tasks have the same creation timestamp.

I chose FIFO because it is easy to understand, deterministic, fair to older work and straightforward to test.

The downside is that FIFO does not understand urgency or execution cost.

For example:

```text
Task A - created first - takes 30 seconds
Task B - created later - takes 1 second and is urgent
```

FIFO still selects Task A first.

A production system might introduce priorities, deadlines or separate queues.

## 12. Activity history improvement

The additional feature I added beyond the assignment requirements is **task activity history**.

The `task_events` table records important state transitions such as:

```text
TASK_SUBMITTED
TASK_STARTED
ATTEMPT_FAILED
RETRY_SCHEDULED
TASK_SUCCEEDED
TASK_FAILED
TASK_BLOCKED
TASK_CANCELLED
TASK_RECOVERED
```

The current task record answers:

> What state is this task in now?

The event history answers:

> How did it get there?

For example, instead of seeing only:

```text
FAILED
```

an operator can see:

```text
submitted
attempt 1 started
attempt 1 failed
retry scheduled
attempt 2 started
attempt 2 failed
retry scheduled
attempt 3 started
attempt 3 failed
permanently failed
```

The history is available through:

```http
GET /api/tasks/:id/events
```

I chose this improvement because debugging task systems is often less about knowing the current state and more about understanding the transitions that produced it.

---

# Required design questions

## 1. How do you make sure the concurrency limit is never exceeded?

The scheduler first prevents overlapping scheduling cycles in the Node.js process using the `schedulerRunning` lock.

The repository then performs task claiming inside a SQLite transaction.

`claimReadyTasks()`:

1. Counts existing `RUNNING` tasks.
2. Calculates the number of free slots.
3. Selects at most that many ready tasks.
4. Marks the selected tasks `RUNNING` before returning them for execution.

Because a task reserves its slot before asynchronous work begins, a later scheduler cycle counts that task as already running.

If this were implemented incorrectly, two scheduling cycles could both observe the same free slot and both start a task. The actual number of running tasks could then exceed the configured limit.

The implementation is intentionally designed for a single Node.js service process.

## 2. What happens if the service is killed while tasks are running?

Completed task state remains in SQLite.

Any task left in `RUNNING` is detected when the service starts again and changed back to `WAITING`. A `TASK_RECOVERED` event is recorded and the scheduler executes the task again.

This means interrupted tasks are not silently lost.

It also means a task can potentially run twice. The design therefore provides at-least-once execution rather than exactly-once execution.

For simulated tasks this is safe. Real document-processing handlers should be idempotent so repeating an operation does not corrupt data.

## 3. When several tasks are ready and one slot becomes available, which one runs next?

The oldest ready task runs first.

The ordering is:

```text
created_at ASC, rowid ASC
```

This gives deterministic FIFO scheduling.

A poor case for this rule would be:

```text
old task: 30-second report generation
new task: 1-second urgent validation
```

The older long-running task would still run first even though executing the short urgent task might be more useful.

I accepted this trade-off because FIFO is predictable and sufficient for the scope of this assignment.

## 4. What is the one thing that must always be true for the service to be correct?

The most important invariant is:

> A task must never start unless all of its dependencies have succeeded and a concurrency slot has been reserved for it.

The dependency part is enforced when ready tasks are selected using the dependency check in `findReadyTasks()`.

The concurrency part is enforced by `claimReadyTasks()`, which calculates available slots and changes selected tasks to `RUNNING` before execution begins.

If either part of this invariant is broken, the runner can produce incorrect workflow results even if every individual task eventually finishes.
