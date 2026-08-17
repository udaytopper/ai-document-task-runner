# Design

## Scenario

This service models an AI document-processing pipeline.

An uploaded document may pass through tasks such as:

1. Extract text
2. Scan for malware
3. Classify the document
4. Extract structured fields
5. Validate the fields
6. Generate a report

Some operations are independent and can run concurrently. Other operations require successful results from earlier tasks. For example, report generation must wait for classification and field validation.

Each task has a configured maximum duration and failure probability. The executor chooses a simulated duration between 50% and 100% of the configured duration and then randomly succeeds or fails according to the failure probability.

## Architecture

The application is divided into these responsibilities:

- Routes define the HTTP endpoints.
- Controllers translate HTTP requests and responses.
- The task service validates workflows and applies application rules.
- The repository performs SQLite queries and transactions.
- The task runner polls for ready tasks and executes them.
- SQLite stores tasks, dependencies and activity events.

The runner executes periodically using a configurable polling interval.

During each scheduler cycle it:

1. Prevents another scheduler cycle from overlapping.
2. Propagates `BLOCKED` status through failed dependency chains.
3. Counts currently running tasks.
4. Calculates available concurrency slots.
5. Selects ready tasks in FIFO order.
6. Changes selected tasks to `RUNNING` inside a transaction.
7. Starts their simulated execution.
8. Marks each task succeeded, retrying or permanently failed.

## Dependency validation

Dependencies are supplied using `clientId` values within the same submitted workflow.

Before saving a workflow, the service validates:

- Every task has a unique `clientId`.
- Every task has a name.
- Durations and failure probabilities are valid.
- `maxRetries` is valid.
- Every referenced dependency exists.
- A task does not depend on itself.
- There are no duplicated dependencies.
- The dependency graph contains no cycle.

Circular dependencies are detected using depth-first search. The algorithm maintains a set of visited tasks and a set of tasks currently being visited. Encountering a task already in the current path means a cycle exists.

The complete submission is rejected with `400 Bad Request` if validation fails. Tasks and dependencies are inserted in a single SQLite transaction so a partial workflow is never stored.

## Concurrency

`claimReadyTasks()` in `src/repositories/task.repository.js` performs the important scheduling operation inside a SQLite transaction.

It:

1. Counts `RUNNING` tasks.
2. Calculates `concurrencyLimit - runningCount`.
3. Selects no more tasks than the available slots.
4. Updates those tasks to `RUNNING`.
5. Increments their attempt counts.
6. Records `TASK_STARTED` events.

The selected tasks are marked `RUNNING` before asynchronous execution starts. This means the next scheduler cycle sees the reserved slots.

The scheduler also uses a `schedulerRunning` boolean lock to prevent overlapping scheduler cycles inside the Node.js process.

This design is intended for one service process. Running multiple service instances would require stronger database-level claiming or a distributed queue.

## Dependencies and blocked tasks

A task is ready only when all its dependencies have status `SUCCEEDED`. This is enforced by the `NOT EXISTS` dependency query inside `findReadyTasks()`.

If a dependency becomes `FAILED`, `BLOCKED` or `CANCELLED`, a waiting dependent becomes `BLOCKED`.

Blocking is applied repeatedly until no more tasks can be blocked. This handles complete chains:

```text
A FAILED
B depends on A -> BLOCKED
C depends on B -> BLOCKED