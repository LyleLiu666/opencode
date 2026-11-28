import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import path from "node:path"
import { existsSync } from "node:fs"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Job } from "@opencode/core/job"
import { JobTable } from "@opencode/core/job/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const parent = Session.ID.make("ses_parent")
const child = Session.ID.make("ses_child")
const independent = Session.ID.make("ses_other")
const recovery = {
  kind: "subagent",
  parentSessionID: parent,
  childSessionID: child,
  agent: "review",
  description: "Review fixture",
} as const

const build = Effect.fnUntraced(function* (filename: string, scope: Scope.Scope) {
  const services = yield* Layer.buildWithScope(
    AppNodeBuilder.build(LayerNode.group([Database.node, Job.node, SessionStore.node]), [
      Database.node.replace(Database.configured({ path: filename })),
    ]),
    scope,
  )
  return {
    database: Context.get(services, Database.Service),
    jobs: Context.get(services, Job.Service),
    store: Context.get(services, SessionStore.Service),
  }
})

const seed = Effect.fnUntraced(function* (database: Database.Interface) {
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* database.db
    .insert(SessionTable)
    .values(
      [parent, independent, child].map((id) => ({
        id,
        project_id: Project.ID.global,
        parent_id: id === child ? parent : null,
        directory: "/project",
        slug: id,
        title: id,
        version: "test",
      })),
    )
    .run()
})

const subagent = { id: child, type: "subagent", recovery, background: true, run: Effect.never } as const

it.live("reserves a suspended subagent and its job for only one recovery process", () =>
  Effect.gen(function* () {
    const temp = yield* tmpdirScoped()
    const filename = path.join(temp.path, "shared.sqlite")
    const scope = yield* Scope.Scope
    const originalScope = yield* Scope.fork(scope)
    const original = yield* build(filename, originalScope)
    yield* seed(original.database)
    expect(yield* original.store.claim(child)).toBe(true)
    yield* original.jobs.start(subagent)
    const contenders = yield* Scope.fork(scope)
    const first = yield* build(filename, contenders)
    const second = yield* build(filename, contenders)
    const marker = (database: Database.Interface) =>
      path.join(filename + ".execution-owners", database.owner?.id + ".sqlite")
    expect(existsSync(marker(original.database))).toBe(true)
    const entry = (yield* first.jobs.pendingBackground)[0]
    expect(entry.executionOwner).toBe(original.database.owner?.id)

    expect(yield* first.store.claim(child)).toBe(false)
    expect(yield* first.store.recoverSubagent(entry)).toBe(false)
    expect(yield* first.jobs.cancel(child)).toBeUndefined()
    expect(yield* first.store.claim(independent)).toBe(true)
    yield* first.store.release(independent)

    yield* Scope.close(originalScope, Exit.void)
    expect(existsSync(marker(original.database))).toBe(true)
    const results = yield* Effect.all([first.store.recoverSubagent(entry), second.store.recoverSubagent(entry)], {
      concurrency: "unbounded",
    })
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results[0] ? first : second
    const loser = results[0] ? second : first
    expect(yield* winner.store.owns(child)).toBe(true)
    expect(yield* loser.store.claim(child)).toBe(false)
    yield* loser.store.release(child)
    yield* loser.jobs.completeBackground(entry.notificationID)
    expect(yield* winner.store.owns(child)).toBe(true)
    expect((yield* loser.jobs.pendingBackground)[0].executionOwner).toBe(winner.database.owner?.id)

    yield* winner.jobs.start({ ...subagent, notificationID: entry.notificationID })
    expect((yield* winner.jobs.cancel(child))?.status).toBe("cancelled")
    yield* winner.store.release(child)
    yield* winner.jobs.completeBackground(entry.notificationID)
    expect(yield* loser.jobs.pendingBackground).toEqual([])
    expect(yield* loser.store.recoverSubagent(entry)).toBe(false)
    yield* winner.database.owner?.pruneDeparted ?? Effect.void
    expect(existsSync(marker(original.database))).toBe(false)
    yield* Scope.close(contenders, Exit.void)
    expect(existsSync(marker(winner.database))).toBe(false)
    expect(existsSync(marker(loser.database))).toBe(false)
  }),
)

it.live("retains unknown legacy ownership in a shared database", () =>
  Effect.gen(function* () {
    const temp = yield* tmpdirScoped()
    const scope = yield* Scope.Scope
    const local = yield* build(path.join(temp.path, "legacy.sqlite"), scope)
    yield* seed(local.database)
    const stamp = Date.now()
    yield* local.database.db.update(SessionTable).set({ time_suspended: stamp }).where(eq(SessionTable.id, child)).run()
    const id = SessionMessage.ID.create()
    yield* local.database.db
      .insert(JobTable)
      .values({
        notification_id: id,
        id: child,
        session_id: parent,
        child_session_id: child,
        kind: "subagent",
        status: "running",
        recovery,
      })
      .run()

    expect(yield* local.store.recover(child)).toBe(false)
    expect(yield* local.store.recoverSubagent((yield* local.jobs.pendingBackground)[0])).toBe(false)
    expect(yield* local.store.claim(child)).toBe(false)
    yield* local.store.release(child)
    yield* local.jobs.completeBackground(id)
    expect(yield* local.store.listSuspended()).toEqual([child])
    expect((yield* local.jobs.pendingBackground)[0]).toMatchObject({ notificationID: id, status: "running" })
  }),
)
