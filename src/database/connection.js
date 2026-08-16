const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const dataDirectory = path.join(__dirname, "../../data");
const databasePath = path.join(dataDirectory, "tasks.db");
const schemaPath = path.join(__dirname, "schema.sql");

if (!fs.existsSync(dataDirectory)) {
  fs.mkdirSync(dataDirectory, { recursive: true });
}

const database = new Database(databasePath);

database.pragma("foreign_keys = ON");
database.pragma("journal_mode = WAL");

const schema = fs.readFileSync(schemaPath, "utf8");
database.exec(schema);

module.exports = database;