import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261128121244_inbox_wake_generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_inbox\` ADD \`wake_after_generation\` text;`)
    })
  },
}

export default migration
