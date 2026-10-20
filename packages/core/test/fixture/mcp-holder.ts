import fs from "node:fs"
import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

// A persistent stdio MCP server that records its pid so a test can kill it out from under the
// client and prove the registry reconnects to a fresh process.
const pidFile = process.argv[2]
if (pidFile) fs.writeFileSync(pidFile, String(process.pid))

const server = new Server({ name: "holder", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler("tools/list", () =>
  Promise.resolve({
    tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }],
  }),
)

await server.connect(new StdioServerTransport())
