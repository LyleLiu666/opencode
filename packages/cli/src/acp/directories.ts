import { isAbsolute, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { OpenCodeClient } from "@opencode/client/effect"
import type { Permission } from "@opencode/schema/permission"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import type { Session } from "@opencode/schema/session"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Option, Schema, Stream } from "effect"
import { ACPClient } from "./client"
import { ACPError } from "./error"

const key = "opencode.acp.additionalDirectories"
const decodeStored = Schema.decodeUnknownOption(Schema.Array(Schema.String))

// Permission resources treat `*` and `?` as wildcards.
export const parse = Effect.fnUntraced(function* (cwd: string, directories: readonly string[] = []) {
  yield* parseCwd(cwd)
  const invalid = directories.find((directory) => !isAbsolute(directory) || /[*?]/.test(directory))
  if (invalid !== undefined) return yield* new ACPError.InvalidAdditionalDirectoryError({ directory: invalid })
  const root = FSUtil.resolve(cwd)
  return [...new Set(directories.map((directory) => resolve(FSUtil.windowsPath(directory))))].filter(
    (directory) => FSUtil.resolve(directory) !== root,
  )
})

export const parseCwd = Effect.fnUntraced(function* (cwd: string) {
  if (!isAbsolute(cwd))
    return yield* new ACPError.InvalidRequestError({ message: `cwd must be an absolute path: ${cwd}`, field: "cwd" })
  return AbsolutePath.make(cwd)
})

export const canRestoreFrom = Effect.fnUntraced(function* (client: OpenCodeClient, session: Session.Info, cwd: string) {
  if (session.projectID === Project.ID.global) return false

  const previous = yield* Stream.paginate(undefined, (cursor: string | undefined) =>
    client.message
      .list({
        sessionID: session.id,
        type: "location-switched",
        limit: 200,
        ...(cursor === undefined ? { order: "desc" } : { cursor }),
      })
      .pipe(
        Effect.catch(ACPClient.classify),
        Effect.map((page) => [page.data, Option.fromNullishOr(page.cursor.next)] as const),
      ),
  ).pipe(
    Stream.filter((message) => message.type === "location-switched"),
    // Older locations stop being valid when the session leaves its project.
    Stream.takeWhile((move) => move.projectID === session.projectID && move.previous?.projectID === session.projectID),
    Stream.filter((move) => move.previous !== undefined && FSUtil.resolve(move.previous.location.directory) === cwd),
    Stream.runHead,
  )
  if (Option.isNone(previous)) return false

  // A formerly used path may now belong to another project.
  const location = yield* client.location
    .get({ location: { directory: cwd } })
    .pipe(Effect.orElseSucceed(() => undefined))
  return location?.project.id === session.projectID
})

export function grant(directories: readonly string[]) {
  if (directories.length === 0) return {}
  return { permissions: rules(directories), metadata: { [key]: [...directories] } }
}

export function list(session: Pick<Session.Info, "metadata">) {
  return [...Option.getOrElse(decodeStored(session.metadata?.[key]), () => [])]
}

export const activate = Effect.fnUntraced(function* (
  client: OpenCodeClient,
  session: Session.Info,
  directories: readonly string[],
) {
  const previous = list(session)
  const owned = rules(previous)
  const current = session.permissions ?? []
  // ACP rules lead so the session's other rules keep precedence for the same paths.
  const permissions = [
    ...rules(directories),
    ...current.filter((rule) => !owned.some((item) => isDeepStrictEqual(item, rule))),
  ]
  const metadata: Session.Metadata = {
    ...Object.fromEntries(Object.entries(session.metadata ?? {}).filter(([name]) => name !== key)),
    ...(directories.length > 0 ? { [key]: [...directories] } : {}),
  }
  const permissionsChanged = !isDeepStrictEqual(permissions, current)
  const metadataChanged = !isDeepStrictEqual(previous, directories)
  if (!permissionsChanged && !metadataChanged) return
  yield* client.session
    .update({
      sessionID: session.id,
      ...(permissionsChanged ? { permissions } : {}),
      ...(metadataChanged ? { metadata } : {}),
    })
    .pipe(Effect.catch(ACPClient.classify))
})

// Tools compare the written path without following symlinks, so both spellings of a root are granted.
function rules(directories: readonly string[]): Permission.Rule[] {
  return [...new Set(directories.flatMap((directory) => [directory, FSUtil.resolve(directory)]))].map((directory) => ({
    action: "external_directory",
    resource: join(directory, "*"),
    effect: "allow",
  }))
}

export * as ACPDirectories from "./directories"
