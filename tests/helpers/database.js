const database = require("../../src/database/connection");

function resetDatabase() {
  database.exec(`
    DELETE FROM task_events;
    DELETE FROM task_dependencies;
    DELETE FROM tasks;
    DELETE FROM sqlite_sequence
    WHERE name = 'task_events';
  `);
}

module.exports = {
  database,
  resetDatabase,
};