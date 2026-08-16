CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'WAITING',
    duration_ms INTEGER NOT NULL,
    failure_probability REAL NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    next_attempt_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL,
    dependency_id TEXT NOT NULL,
    PRIMARY KEY (task_id, dependency_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (dependency_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status
ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_tasks_created_at
ON tasks(created_at);

CREATE INDEX IF NOT EXISTS idx_dependencies_task
ON task_dependencies(task_id);

CREATE INDEX IF NOT EXISTS idx_events_task
ON task_events(task_id);