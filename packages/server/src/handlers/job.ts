import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionBackground } from "@opencode/core/session/background"
import { ConflictError } from "@opencode/protocol/errors"
import type { ListQuery } from "@opencode/protocol/groups/job"
import { Effect, Option } from "effect"
import { missingSession } from "./session-error"

/** `job.*` in the `server.experimental` group. */
export const makeJob = Effect.gen(function* () {
  const jobs = yield* Job.Service
  const sessions = yield* Session.Service
  const lookup = {
    get: (sessionID: Session.ID) => sessions.get(sessionID).pipe(Effect.option, Effect.map(Option.getOrUndefined)),
  }

  return {
    list: Effect.fn("JobHandler.list")(function* (query: ListQuery) {
      if (query.sessionID !== undefined) {
        yield* sessions.get(query.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
      }
      return {
        data: yield* SessionBackground.list(jobs, lookup, query),
      }
    }),
    cancel: Effect.fn("JobHandler.cancel")(function* (id: string) {
      const result = yield* jobs.cancel(id)
      if (result?.status === "cancelled" || !(yield* jobs.isBackgroundRunning(id))) return
      return yield* new ConflictError({
        resource: id,
        message: "This server cannot stop the background job. Connect to the server running it to stop it.",
      })
    }),
  }
})
