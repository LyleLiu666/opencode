import type { ListSessionsResponse, PromptResponse } from "@agentclientprotocol/sdk"
import { $ } from "bun"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { git, initGit } from "../../../core/test/fixture/git"
import { createAcpFixture, expectOk, initialize, newSession, toolCallStream } from "./subprocess"

test("restores a moved session after restarting ACP and keeps project boundaries", async () => {
  const call = { id: "", name: "", input: {} as Record<string, string> }
  await using fixture = await createAcpFixture({
    respond(request) {
      if (JSON.stringify(request).includes(`"tool_call_id":"${call.id}"`)) return "Done"
      return toolCallStream(call.id, call.name, call.input)
    },
  })
  const main = await fs.realpath(fixture.home)
  await initGit(main)
  await git(main, "commit", "--allow-empty", "-m", "main checkout")
  const other = await fs.realpath(await fs.mkdtemp(path.join(fixture.root, "other-")))
  await initGit(other)
  await git(other, "commit", "--allow-empty", "-m", "another project")
  const neverUsed = path.join(main, "never-used")
  await fs.mkdir(neverUsed)

  const first = fixture.spawn()
  await initialize(first)
  const { sessionId } = await newSession(first, main)
  const prompt = (text: string) => ({ sessionId, prompt: [{ type: "text", text }] })

  Object.assign(call, { id: "call_create_checkout", name: "opencode_worktree_create", input: { name: "feature" } })
  expect(
    expectOk(await first.request<PromptResponse>("session/prompt", prompt("Make a feature worktree"))).stopReason,
  ).toBe("end_turn")
  const worktrees = (await $`git -C ${main} worktree list --porcelain`.text())
    .split(/\r?\n/)
    .flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []))
  expect(worktrees).toHaveLength(2)
  const worktree = await fs.realpath(worktrees[1]!)
  await Promise.all([
    Bun.write(path.join(main, "acp-probe.txt"), "main checkout contents"),
    Bun.write(path.join(worktree, "acp-probe.txt"), "feature worktree contents"),
  ])

  Object.assign(call, { id: "call_move_checkout", name: "opencode_session_move", input: { directory: worktree } })
  expect(expectOk(await first.request<PromptResponse>("session/prompt", prompt("Move this session"))).stopReason).toBe(
    "end_turn",
  )
  await first.close()

  const restored = fixture.spawn()
  await initialize(restored)
  const list = (cwd: string) => restored.request<ListSessionsResponse>("session/list", { cwd }).then(expectOk)
  expect((await list(worktree)).sessions).toContainEqual(expect.objectContaining({ sessionId, cwd: worktree }))
  expect((await list(main)).sessions.some((session) => session.sessionId === sessionId)).toBe(false)

  const load = (cwd: string, additionalDirectories?: string[]) =>
    restored.request("session/load", { sessionId, cwd, mcpServers: [], additionalDirectories })
  for (const cwd of [other, neverUsed]) {
    expect((await load(cwd)).error).toMatchObject({ code: -32602, data: { sessionId, cwd } })
  }
  expectOk(await load(main))
  await restored.waitForMessage(
    (message) =>
      message.method === "session/update" &&
      JSON.stringify(message.params).includes('"sessionUpdate":"user_message_chunk"') &&
      JSON.stringify(message.params).includes("Make a feature worktree"),
    "original prompt replayed when loading the previous checkout",
  )
  expectOk(await load(worktree))
  expect((await restored.request("session/fork", { sessionId, cwd: main, mcpServers: [] })).error).toMatchObject({
    code: -32602,
    data: { sessionId, cwd: main },
  })
  expectOk(await restored.request("session/resume", { sessionId, cwd: main, mcpServers: [] }))

  Object.assign(call, { id: "call_read_checkout", name: "read", input: { path: "acp-probe.txt" } })
  expect(
    expectOk(await restored.request<PromptResponse>("session/prompt", prompt("Read the checkout marker"))).stopReason,
  ).toBe("end_turn")
  expect(JSON.stringify(fixture.llm.requests.at(-1))).toContain("feature worktree contents")
  expect(JSON.stringify(fixture.llm.requests.at(-1))).not.toContain("main checkout contents")

  // The client can explicitly grant the other checkout for a move, but the old paths stop being valid for restore.
  expectOk(await load(worktree, [other]))
  Object.assign(call, { id: "call_move_project", name: "opencode_session_move", input: { directory: other } })
  expect(
    expectOk(await restored.request<PromptResponse>("session/prompt", prompt("Move to the other project"))).stopReason,
  ).toBe("end_turn")
  expect((await list(other)).sessions).toContainEqual(expect.objectContaining({ sessionId, cwd: other }))
  for (const cwd of [main, worktree]) {
    expect((await load(cwd)).error).toMatchObject({ code: -32602, data: { sessionId, cwd } })
  }
  expectOk(await load(other))
}, 60_000)
