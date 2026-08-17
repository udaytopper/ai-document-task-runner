const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const defaultDataDirectory = path.join(
  __dirname,
  "../../data"
);

const databasePath =
  process.env.DATABASE_PATH ||
  path.join(defaultDataDirectory, "tasks.db");

const schemaPath = path.join(__dirname, "schema.sql");

if (databasePath !== ":memory:") {
  const databaseDirectory = path.dirname(databasePath);

  if (!fs.existsSync(databaseDirectory)) {
    fs.mkdirSync(databaseDirectory, {
      recursive: true,
    });
  }
}

const database = new Database(databasePath);

database.pragma("foreign_keys = ON");
database.pragma("journal_mode = WAL");

const schema = fs.readFileSync(schemaPath, "utf8");
database.exec(schema);

module.exports = database;