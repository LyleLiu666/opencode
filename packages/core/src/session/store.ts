export * as SessionStore from "./store.js"

import { and, asc, desc, eq, gt, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Project } from "@opencode/schema/project"
import { Workspace } from "@opencode/schema/workspace"
import { AbsolutePath, PositiveInt, RelativePath } from "@opencode/schema/schema"
import { JobTable } from "../job/sql.js"
import type { Job } from "../job.js"
import { Database } from "../database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionHistory } from "./history.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { Session } from "@opencode/schema/session"
import { SessionMessageTable, SessionTable } from "./sql.js"
import { fromRow } from "./info.js"
import { LiveToolMetadata } from "./runner/live-tool-metadata.js"

const ListInputBase = {
  workspaceID: Workspace.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  parentID: Schema.NullOr(Session.ID).pipe(Schema.optional),
  archived: Schema.Boolean.pipe(Schema.optional),
  anchor: Session.ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

export type MessagesInput = {
  sessionID: Session.ID
  limit?: number
  order?: "asc" | "desc"
  type?: SessionMessage.Type
  cursor?: {
    id: SessionMessage.ID
    direction: "previous" | "next"
  }
}

export interface Interface {
  readonly get: (sessionID: Session.ID) => Effect.Effect<Session.Info | undefined>
  readonly list: (input?: ListInput) => Effect.Effect<Session.Info[]>
  readonly messages: (input: MessagesInput) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  readonly context: (sessionID: Session.ID) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  /**
   * The newest completed, error-free assistant message above the sequence
   * bound. Reads newest-first in pages so a long run of incomplete steps does
   * not decode the whole history.
   */
  readonly lastAssistantAfter: (input: {
    readonly sessionID: Session.ID
    readonly afterSeq?: number
  }) => Effect.Effect<SessionMessage.Assistant | undefined, MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.Info } | undefined>
  /** {@link Interface.messages} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
  readonly messagesWithRefs: (input: MessagesInput) => Effect.Effect<SessionMessage.MediaInfo[], MessageDecodeError>
  /** {@link Interface.message} for clients that fetch media themselves. */
  readonly messageWithRefs: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.MediaInfo } | undefined>
  /**
   * Sessions holding an execution claim, including directly driven children.
   */
  readonly listSuspended: () => Effect.Effect<ReadonlyArray<Session.ID>>
  /**
   * Records the execution claim: the durable write-ahead intent that a turn is
   * (or was) in flight. Set when execution starts; a claim that survives to the
   * next boot marks a turn that never completed — its process crashed or shut
   * down mid-turn.
   */
  readonly claim: (sessionID: Session.ID) => Effect.Effect<boolean>
  readonly owns: (sessionID: Session.ID) => Effect.Effect<boolean>
  readonly recover: (sessionID: Session.ID) => Effect.Effect<boolean>
  readonly recoverBackground: (background: Job.Background) => Effect.Effect<boolean>
  /** Releases the claim and resets resume accounting. Terminal events call this on commit. */
  readonly release: (sessionID: Session.ID) => Effect.Effect<void>
  /**
   * Release abandoned claims when the child's parent was deleted.
   */
  readonly releaseOrphanedChildClaims: () => Effect.Effect<void>
  /**
   * Durably counts one more resume of an orphaned claim, returning the new
   * total — or undefined when the Session no longer exists.
   */
  readonly countResume: (sessionID: Session.ID) => Effect.Effect<number | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, owner } = yield* Database.Service
    const readClaim = (sessionID: Session.ID) =>
      db
        .select({
          owner: SessionTable.execution_owner,
          generation: SessionTable.execution_generation,
          started: SessionTable.time_suspended,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
    const replaceClaim = (sessionID: Session.ID, previous: Effect.Success<ReturnType<typeof readClaim>>) =>
      db
        .update(SessionTable)
        .set({
          execution_owner: owner?.id,
          execution_generation: crypto.randomUUID(),
          time_suspended: previous?.started ?? Date.now(),
          time_updated: sql`${SessionTable.time_updated}`,
        })
        .where(
          and(
            eq(SessionTable.id, sessionID),
            sql`${SessionTable.execution_owner} IS ${previous?.owner ?? null}`,
            sql`${SessionTable.execution_generation} IS ${previous?.generation ?? null}`,
            sql`${SessionTable.time_suspended} IS ${previous?.started ?? null}`,
          ),
        )
        .returning({ id: SessionTable.id })
        .get()
        .pipe(Effect.map(Boolean), Effect.orDie)

    /** One page of a session's message rows, oldest first within the page when paging backwards. */
    const messageRows = Effect.fnUntraced(function* (input: MessagesInput) {
      const direction = input.cursor?.direction ?? "next"
      const requestedOrder = input.order ?? "desc"
      const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
      const anchor = input.cursor
        ? yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      if (input.cursor && !anchor) return []
      const boundary = anchor
        ? order === "asc"
          ? gt(SessionMessageTable.seq, anchor.seq)
          : lt(SessionMessageTable.seq, anchor.seq)
        : undefined
      const query = db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            boundary,
            input.type === undefined ? undefined : eq(SessionMessageTable.type, input.type),
          ),
        )
        .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
      const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(Effect.orDie)
      return direction === "previous" ? rows.toReversed() : rows
    })

    const messageRow = (messageID: SessionMessage.ID) =>
      db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).get().pipe(Effect.orDie)

    return Service.of({
      get: Effect.fnUntraced(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      list: Effect.fn("SessionStore.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_updated
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if ("project" in input && input.subpath !== undefined) conditions.push(eq(SessionTable.path, input.subpath))
        if (input.search) conditions.push(sql`${SessionTable.title} GLOB ${titlePattern(input.search)}`)
        if (input.parentID !== undefined)
          conditions.push(
            input.parentID === null ? isNull(SessionTable.parent_id) : eq(SessionTable.parent_id, input.parentID),
          )
        if (input.archived !== undefined)
          conditions.push(input.archived ? isNotNull(SessionTable.time_archived) : isNull(SessionTable.time_archived))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("SessionStore.messages")(function* (input) {
        return (yield* SessionHistory.decodeMessageRows(db, yield* messageRows(input))).map((message) =>
          LiveToolMetadata.overlay(message),
        )
      }),
      messagesWithRefs: Effect.fn("SessionStore.messagesWithRefs")(function* (input) {
        return (yield* SessionHistory.decodeMessageRowsWithRefs(db, yield* messageRows(input))).map(
          LiveToolMetadata.overlay,
        )
      }),
      context: Effect.fn("SessionStore.context")((sessionID) => SessionHistory.load(db, sessionID, "latest")),
      lastAssistantAfter: Effect.fn("SessionStore.lastAssistantAfter")(function* (input) {
        let cursorSeq: number | undefined
        while (true) {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, input.sessionID),
                eq(SessionMessageTable.type, "assistant"),
                input.afterSeq === undefined ? undefined : gt(SessionMessageTable.seq, input.afterSeq),
                cursorSeq === undefined ? undefined : lt(SessionMessageTable.seq, cursorSeq),
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(20)
            .all()
            .pipe(Effect.orDie)
          for (const message of yield* SessionHistory.decodeMessageRows(db, rows)) {
            if (message.type === "assistant" && message.time.completed !== undefined && message.error === undefined)
              return message
          }
          if (rows.length < 20) return undefined
          cursorSeq = rows[rows.length - 1]!.seq
        }
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* messageRow(messageID)
        if (!row) return undefined
        const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
        return message && { sessionID: row.session_id, message: LiveToolMetadata.overlay(message) }
      }),
      messageWithRefs: Effect.fn("SessionStore.messageWithRefs")(function* (messageID) {
        const row = yield* messageRow(messageID)
        if (!row) return undefined
        const [message] = yield* SessionHistory.decodeMessageRowsWithRefs(db, [row]).pipe(Effect.orDie)
        return message && { sessionID: row.session_id, message: LiveToolMetadata.overlay(message) }
      }),
      listSuspended: Effect.fn("SessionStore.listSuspended")(function* () {
        return yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(isNotNull(SessionTable.time_suspended))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => row.sessionID)),
          )
      }),
      claim: Effect.fn("SessionStore.claim")(function* (sessionID) {
        const claimed = yield* db
          .update(SessionTable)
          .set({
            time_suspended: Date.now(),
            execution_owner: owner?.id,
            execution_generation: owner ? crypto.randomUUID() : undefined,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(and(eq(SessionTable.id, sessionID), isNull(SessionTable.time_suspended)))
          .returning({ id: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        return !owner || !!claimed || (yield* readClaim(sessionID))?.owner === owner.id
      }),
      owns: (sessionID) =>
        owner ? readClaim(sessionID).pipe(Effect.map((claim) => claim?.owner === owner.id)) : Effect.succeed(true),
      recover: Effect.fn("SessionStore.recover")(function* (sessionID) {
        if (!owner) return true
        const previous = yield* readClaim(sessionID)
        if (!previous?.started || !previous.generation || !(yield* owner.departed(previous.owner))) return false
        return yield* replaceClaim(sessionID, previous)
      }),
      recoverBackground: Effect.fn("SessionStore.recoverBackground")(function* (background) {
        if (!owner) return true
        const recovery = background.recovery
        const previousOwner = background.executionOwner
        if (!previousOwner || !(yield* owner.departed(previousOwner))) return false
        const child =
          recovery.kind === "subagent" &&
          (background.status === "running" || (background.status === "cancelled" && background.error === undefined))
            ? recovery.childSessionID
            : undefined
        const previous = child ? yield* readClaim(child) : undefined
        // A separately driven child can be live under a different owner. Its claim must not be moved or released.
        if (previous?.started && (previous.owner !== previousOwner || !previous.generation)) return false
        return yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                const job = yield* db
                  .update(JobTable)
                  .set({ execution_owner: owner.id })
                  .where(
                    and(
                      eq(JobTable.notification_id, background.notificationID),
                      eq(JobTable.execution_owner, previousOwner),
                      eq(JobTable.status, background.status),
                    ),
                  )
                  .returning({ id: JobTable.notification_id })
                  .get()
                  .pipe(Effect.orDie)
                if (!job) return false
                if (child && previous && !(yield* replaceClaim(child, previous))) {
                  return yield* Effect.fail("claim-changed" as const)
                }
                return true
              }),
            { behavior: "immediate" },
          )
          .pipe(
            Effect.catchIf(
              (error) => error === "claim-changed",
              () => Effect.succeed(false),
            ),
            Effect.orDie,
          )
      }),
      release: Effect.fn("SessionStore.release")(function* (sessionID) {
        yield* db
          .update(SessionTable)
          .set({
            time_suspended: null,
            execution_owner: null,
            execution_generation: null,
            resume_attempts: 0,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(and(eq(SessionTable.id, sessionID), owner ? eq(SessionTable.execution_owner, owner.id) : undefined))
          .run()
          .pipe(Effect.orDie)
      }),
      releaseOrphanedChildClaims: Effect.fn("SessionStore.releaseOrphanedChildClaims")(() =>
        db
          .update(SessionTable)
          .set({
            time_suspended: null,
            execution_owner: null,
            execution_generation: null,
            resume_attempts: 0,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(
            and(
              isNotNull(SessionTable.time_suspended),
              owner ? eq(SessionTable.execution_owner, owner.id) : undefined,
              notInArray(SessionTable.parent_id, db.select({ id: SessionTable.id }).from(SessionTable)),
            ),
          )
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      ),
      countResume: Effect.fn("SessionStore.countResume")(function* (sessionID) {
        const row = yield* db
          .update(SessionTable)
          .set({
            resume_attempts: sql`${SessionTable.resume_attempts} + 1`,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(and(eq(SessionTable.id, sessionID), owner ? eq(SessionTable.execution_owner, owner.id) : undefined))
          .returning({ attempts: SessionTable.resume_attempts })
          .get()
          .pipe(Effect.orDie)
        return row?.attempts
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

// SQLite's LIKE folds case for ASCII only, and none of our drivers (bun, node, Durable Objects) ships ICU or lets us
// register a lowercase function everywhere. GLOB is case-sensitive but supports character classes, so each cased
// letter becomes a class of its single-character case forms ("т" -> "[тТ]"). The LIKE wildcards % and _ keep their
// meaning, and GLOB metacharacters are wrapped in a class so they stay literal as they were under LIKE.
function titlePattern(search: string) {
  const chars = Array.from(search, (char) => {
    if (char === "%") return "*"
    if (char === "_") return "?"
    const cases = new Set(
      [char, char.toLowerCase(), char.toUpperCase()].filter((form) => Array.from(form).length === 1),
    )
    if (cases.size > 1) return `[${[...cases].join("")}]`
    return "*?[".includes(char) ? `[${char}]` : char
  })
  return `*${chars.join("")}*`
}
