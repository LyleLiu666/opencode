import type { ExecutionMarker } from "./execution-owner.js"
import { Database, SQLiteError } from "bun:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"
import type { SqlClient } from "effect/sql"

export const supportsTuningPragmas = true

// Foreign keys default OFF and can be toggled per connection.
export const supportsForeignKeyToggle = true

// Opening the database can only fail on a broken file or a lock held past
// busyTimeout; Database.layer treats both as fatal.
export const sqliteLayer = (config: SqliteClient.SqliteClientConfig): Layer.Layer<SqlClient.SqlClient> =>
  Layer.orDie(SqliteClient.layer(config))

// bun:sqlite throws SQLiteError, whose errno is SQLite's extended result code.
export const resultCode = (cause: unknown) => (cause instanceof SQLiteError ? cause.errno : undefined)

export function openExecutionMarker(filename: string, create: boolean): ExecutionMarker {
  const db = new Database(filename, { create, readwrite: true })
  db.exec("PRAGMA busy_timeout=0")
  return {
    lock: () => db.exec("BEGIN IMMEDIATE"),
    initialize: (id) => {
      db.exec("CREATE TABLE owner (id TEXT NOT NULL)")
      db.query("INSERT INTO owner VALUES (?)").run(id)
    },
    identity: () => db.query<{ id: string }, []>("SELECT id FROM owner").get()?.id,
    close: () => db.close(),
  }
}
