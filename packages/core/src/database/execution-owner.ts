import { Effect } from "effect"
import { chmod, mkdir, realpath, rm, stat } from "node:fs/promises"
import path from "node:path"
import { openExecutionMarker } from "#sqlite"

export type ExecutionMarker = {
  readonly lock: () => void
  readonly initialize: (id: string) => void
  readonly identity: () => string | undefined
  readonly close: () => void
}

export type ExecutionOwner = {
  readonly id: string
  readonly departed: (id: string | null) => Effect.Effect<boolean>
  readonly pruneDeparted: Effect.Effect<void>
}

export const openExecutionOwner = Effect.fnUntraced(function* (
  filename: string,
  referenced: (id: string) => Effect.Effect<boolean>,
) {
  const directory = (yield* Effect.promise(() => realpath(filename))) + ".execution-owners"
  const id = crypto.randomUUID()
  const filenameFor = (owner: string) => path.join(directory, owner + ".sqlite")
  const file = filenameFor(id)
  const departed = new Set<string>()
  const removeUnused = (owner: string) =>
    referenced(owner).pipe(
      Effect.flatMap((needed) =>
        needed ? Effect.void : Effect.promise(() => rm(filenameFor(owner), { force: true })),
      ),
      Effect.ignoreCause({ log: "Warn", message: "Could not remove unused execution owner marker" }),
    )
  yield* Effect.acquireRelease(
    Effect.promise(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const marker = openExecutionMarker(file, true)
      try {
        if (process.platform !== "win32") await chmod(file, 0o600)
        marker.initialize(id)
        marker.lock()
        return marker
      } catch (error) {
        marker.close()
        throw error
      }
    }),
    (marker) => Effect.sync(() => marker.close()).pipe(Effect.andThen(() => removeUnused(id))),
  )
  return {
    id,
    departed: (old: string | null) =>
      Effect.promise(async () => {
        // Missing and unsupported markers cannot distinguish a crash from a live older server.
        if (!old || old === id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(old)) return false
        if (departed.has(old)) return true
        const previous = filenameFor(old)
        try {
          if (!(await stat(previous)).isFile()) return false
          const marker = openExecutionMarker(previous, false)
          try {
            marker.lock()
            if (marker.identity() !== old) return false
            departed.add(old)
            return true
          } finally {
            marker.close()
          }
        } catch {
          return false
        }
      }),
    pruneDeparted: Effect.suspend(() => Effect.forEach(departed, removeUnused, { discard: true })),
  } satisfies ExecutionOwner
})
