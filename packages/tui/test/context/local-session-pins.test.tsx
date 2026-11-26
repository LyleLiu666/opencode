import { expect, test } from "bun:test"
import { renderLocal, session } from "../fixture/local"
import { json } from "../fixture/tui-client"

test("an archived pin keeps its number and opens again after it is unarchived", async () => {
  const current = session("ses_current")
  const saved = session("ses_saved")
  await using setup = await renderLocal({
    pins: [saved.id, current.id],
    sessions: [current, { ...saved, time: { ...saved.time, archived: 1 } }],
  })
  const origin = { type: "session", sessionID: current.id } as const
  setup.route.navigate(origin)

  await setup.local.session.quickSwitch(1)
  expect(setup.data.session.get(saved.id)?.time.archived).toBe(1)
  expect(setup.route.data).toEqual(origin)
  await setup.local.session.quickSwitch(1)
  expect(setup.route.data).toEqual(origin)
  expect(setup.local.session.slots()).toEqual([saved.id, current.id])

  setup.data.session.remember(saved)
  await setup.local.session.quickSwitch(1)
  expect(setup.route.data).toEqual({ type: "session", sessionID: saved.id })
})

test.each([[404], [503]])(
  "a saved pin lookup returning %i leaves the current session and slot order intact",
  async (status) => {
    const current = session("ses_current")
    const unavailable = session("ses_unavailable")
    const other = session("ses_other")
    let lookups = 0
    await using setup = await renderLocal({
      pins: [unavailable.id, other.id],
      sessions: [current, other],
      fetch: (url) => {
        if (url.pathname !== `/api/session/${unavailable.id}`) return
        lookups++
        if (status === 404)
          return json(
            { _tag: "SessionNotFoundError", sessionID: unavailable.id, message: "Session not found" },
            { status },
          )
        if (lookups === 1) return json({ message: "Service unavailable" }, { status })
        return json({ data: unavailable })
      },
    })
    const origin = { type: "session", sessionID: current.id } as const
    setup.route.navigate(origin)

    await setup.local.session.quickSwitch(1)
    expect(lookups).toBe(1)
    expect(setup.route.data).toEqual(origin)
    expect(setup.local.session.slots()).toEqual([unavailable.id, other.id])

    if (status === 503) {
      await setup.local.session.quickSwitch(1)
      expect(lookups).toBe(2)
      expect(setup.route.data).toEqual({ type: "session", sessionID: unavailable.id })
    }
    await setup.local.session.quickSwitch(2)
    expect(setup.route.data).toEqual({ type: "session", sessionID: other.id })
  },
)
