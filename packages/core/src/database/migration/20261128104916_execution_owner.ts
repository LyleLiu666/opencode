import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261128104916_execution_owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`job\` ADD \`execution_owner\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`execution_owner\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`execution_generation\` text;`)
    })
  },
}

export default migration
