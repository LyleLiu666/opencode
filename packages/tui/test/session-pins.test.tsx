import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { SessionInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const pin = "Pin this session"
const recent = "Most recent session"
const oldest = "Older pinned session"

function session(id: string, title: string, order: number): SessionInfo {
  return {
    id,
    title,
    projectID: "proj_test",
    location: { directory },
    subpath: "packages/tui",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: order },
  }
}

async function fixture(state: string, sessions: SessionInfo[], listed = sessions, tabs: "off" | "on" = "off") {
  return createAppFixture({
    state,
    width: 100,
    height: 40,
    config: { animations: false, tabs: tabs === "on" ? { mode: "on", scope: "global" } : { mode: "off" } },
    fetch: (url) => {
      if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "null")
        return json({ data: listed, cursor: {} })
      if (/^\/api\/session\/[^/]+\/inbox$/.test(url.pathname)) return json({ data: [] })
      const info = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
      if (info) return json({ data: info })
      const history = sessions.find((item) => url.pathname === `/api/session/${item.id}/message`)
      if (history)
        return json({
          data: [{ id: "msg_saved", type: "user", text: `History for ${history.title}`, time: { created: 1 } }],
          cursor: {},
        })
    },
  })
}

async function openSessions(setup: Awaited<ReturnType<typeof fixture>>, visible: string) {
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  await setup.mockInput.typeText("/sessions")
  setup.mockInput.pressEnter()
  return setup.waitForFrame(
    (frame) =>
      frame.includes("Sessions") &&
      frame.includes(visible) &&
      setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
}

test("pinning and unpinning keeps the selected session as it moves in the session picker", async () => {
  await using state = await tmpdir()
  await using setup = await fixture(state.path, [
    session("ses_recent", recent, 4),
    session("ses_middle", "Next most recent session", 3),
    session("ses_pin", pin, 2),
    session("ses_older", "Last session", 1),
  ])
  await setup.ready
  await openSessions(setup, pin)
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressKey("f", { ctrl: true })
  const pinned = await setup.waitForFrame(
    (frame) => frame.includes("Pinned") && frame.indexOf(pin) < frame.indexOf(recent),
  )
  expect(pinned).toContain(pin)
  setup.mockInput.pressKey("f", { ctrl: true })
  await setup.renderOnce()
  const unpinned = setup.captureCharFrame()
  expect(unpinned).not.toContain("Pinned")
  expect(unpinned.indexOf(pin)).toBeGreaterThan(unpinned.indexOf(recent))

  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(`History for ${pin}`))
})

test.each(["home", "picker"])("a fresh TUI restores saved quick slots via %s", async (entry) => {
  await using state = await tmpdir()
  const saved = session("ses_pin", pin, 2)
  const older = session("ses_older", oldest, 1)
  const newest = session("ses_recent", recent, 3)
  await Bun.write(path.join(state.path, "session.json"), JSON.stringify({ pinned: [older.id, saved.id] }))
  await using setup = await fixture(state.path, [newest, saved, older], [newest, saved])
  await setup.ready
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  if (entry === "picker") {
    await openSessions(setup, pin)
    await setup.waitForFrame((frame) => /^ +2 +Pin this session *$/m.test(frame))
    setup.mockInput.pressEscape()
    await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  }

  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("2")
  await setup.waitForFrame((frame) => frame.includes(`History for ${pin}`))
})

test("leader plus a number switches tabs when tabs are enabled, even with saved pins", async () => {
  await using state = await tmpdir()
  const saved = session("ses_pin", pin, 1)
  const tabs = [session("ses_first", "First tab", 2), session("ses_second", "Second tab", 3)]
  const tabState = path.join(state.path, "test", "tui")
  await mkdir(tabState, { recursive: true })
  await Bun.write(path.join(state.path, "session.json"), JSON.stringify({ pinned: [saved.id] }))
  await Bun.write(
    path.join(tabState, "tabs.json"),
    JSON.stringify({ global: { tabs: tabs.map((item) => ({ sessionID: item.id, title: item.title })) }, cwd: {} }),
  )

  await using setup = await fixture(state.path, [...tabs, saved], [...tabs, saved], "on")
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("First tab") && frame.includes("Second tab"))
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("1")
  await setup.waitForFrame((frame) => frame.includes("History for First tab"))
})
