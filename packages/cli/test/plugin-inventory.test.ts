import { expect, test } from "bun:test"
import path from "node:path"
import type { Plugin } from "@opencode/schema/plugin"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { OPENCODE_VERSION } from "../src/version"
import { isolatedEnv } from "./fixture/environment"

const plugin = {
  id: "delayed-plugin",
  source: { type: "package", target: "opencode-test-plugin", version: "1.0.0" },
  state: { status: "active" },
  features: { server: true },
} satisfies typeof Plugin.Info.Encoded

test("plugin list waits for the cold plugin inventory", async () => {
  const result = await runColdPluginCommand(["list"])

  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain(plugin.id)
  expect(result.inventoryReads).toBe(2)
})

test("plugin update uses the package discovered after a cold inventory read", async () => {
  const result = await runColdPluginCommand(["update", plugin.source.target])

  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Updated Server plugin "delayed-plugin"')
  expect(result.inventoryReads).toBe(2)
  expect(result.updates).toEqual([{ targets: [plugin.source.target] }])
})

async function runColdPluginCommand(args: string[]) {
  await using root = await tmpdir("opencode-cli-plugin-inventory-")
  const location = { directory: root.path }
  const updates: unknown[] = []
  let inventoryReads = 0
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/api/info": { GET: () => Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [] }) },
      "/api/plugin": { GET: () => Response.json({ location, data: ++inventoryReads === 1 ? [] : [plugin] }) },
      "/api/plugin/check": {
        POST: async (request) => {
          if (inventoryReads < 2 || (await request.json()).target !== plugin.source.target)
            return new Response(null, { status: 400 })
          return Response.json({ location, data: [{ ...plugin, source: { ...plugin.source, outdated: true } }] })
        },
      },
      "/api/plugin/update": {
        POST: async (request) => {
          updates.push(await request.json())
          return new Response(null, { status: 204 })
        },
      },
    },
    fetch: () => new Response(null, { status: 404 }),
  })
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--preload",
      Bun.resolveSync("@opentui/solid/preload", import.meta.dir),
      path.join(import.meta.dir, "../src/index.ts"),
      "plugin",
      ...args,
      "--server",
      server.url.href,
    ],
    {
      cwd: root.path,
      env: isolatedEnv(root.path, { OPENCODE_PASSWORD: undefined }),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode, inventoryReads, updates }
}
