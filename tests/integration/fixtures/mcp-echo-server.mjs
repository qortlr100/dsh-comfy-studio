// A dependency-free MCP server over stdio (newline-delimited JSON-RPC) with one tool, `echo`,
// which answers the given text upper-cased. dsh-features.test.ts adds it with a patch of the
// mcp-manager row. Node runs this file directly.

import { createInterface } from "node:readline";

/** The server's instructions, which dsh puts into the system prompt. */
const INSTRUCTIONS = "CS-MCP-INSTRUCTIONS: the echo tool repeats text.";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // Notifications (initialized, cancelled) carry no id and get no answer.
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cs-echo", version: "0.0.1" },
        instructions: INSTRUCTIONS,
      });
      break;
    case "tools/list":
      result(message.id, {
        tools: [
          {
            name: "echo",
            description: "Repeats the given text back, upper-cased.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "Text to repeat" } },
              required: ["text"],
            },
          },
        ],
      });
      break;
    case "tools/call":
      result(message.id, {
        content: [
          { type: "text", text: `ECHO:${String(message.params?.arguments?.text).toUpperCase()}` },
        ],
      });
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
