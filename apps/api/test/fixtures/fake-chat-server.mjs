// Fake OpenAI-compatible /chat/completions server for integration tests.
// Mirrors the behaviors of the retired fake-agent-worker child process,
// keyed off the conversation content.
import { createServer } from "node:http";

function lastUser(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].content ?? "";
  }
  return "";
}

function lastToolResult(messages, marker) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "tool" && typeof message.content === "string") {
      try {
        const parsed = JSON.parse(message.content.replace(/…\(truncated\)$/, ""));
        if (marker(parsed, messages, index)) return parsed;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function toolCallNameFor(messages, toolCallId) {
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call.id === toolCallId) return call.function?.name ?? "";
      }
    }
  }
  return "";
}

function findToolResult(messages, functionName) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "tool") continue;
    if (toolCallNameFor(messages, message.tool_call_id) !== functionName) continue;
    try {
      return JSON.parse(String(message.content).replace(/…\(truncated\)$/, ""));
    } catch {
      return null;
    }
  }
  return null;
}

function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function respondText(response, text) {
  sse(response, { choices: [{ delta: { content: text } }] });
  sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
  response.write("data: [DONE]\n\n");
  response.end();
}

function respondToolCall(response, name, args) {
  sse(response, {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: `call-${name.replace("__", "-")}-${String(Date.now())}`,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
  sse(response, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  response.write("data: [DONE]\n\n");
  response.end();
}

/** Start the fake model server; returns { url, close }. */
export async function startFakeChatServer() {
  const sockets = new Set();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const messages = parsed.messages ?? [];
      const user = lastUser(messages);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      // Compaction request (the runtime appends a summary instruction).
      if (user.includes("simulate-control-plane-crash")) {
        return; // hang forever — the control plane must reconcile
      }
      if (user.includes("压缩成")) {
        respondText(response, "Synthetic compacted context");
        return;
      }
      if (user === "Hold after acknowledge") {
        return; // hang — used by interrupt/backpressure tests
      }
      if (user.startsWith("Evidence question:")) {
        const searchResult = findToolResult(messages, "evidence__search");
        if (searchResult === null) {
          respondToolCall(response, "evidence__search", {
            query: user.slice("Evidence question:".length).trim(),
            limit: 5,
          });
          return;
        }
        const hit = searchResult?.hits?.[0];
        if (!hit?.evidenceId) {
          respondText(
            response,
            "No matching canonical Evidence was found. [Evidence: none; document=none]",
          );
          return;
        }
        const getResult = findToolResult(messages, "evidence__get");
        if (getResult === null) {
          respondToolCall(response, "evidence__get", {
            evidenceIds: [hit.evidenceId],
          });
          return;
        }
        const item = getResult?.items?.[0];
        if (!item) {
          respondText(
            response,
            `Canonical Evidence detail was unavailable. [Evidence: ${hit.evidenceId}; document=none]`,
          );
          return;
        }
        respondText(
          response,
          `${item.content} [Evidence: ${item.evidenceId}; document=${item.documentId}]`,
        );
        return;
      }
      if (user === "Request parent tool") {
        const listed = findToolResult(messages, "workspace__list");
        if (listed === null) {
          respondToolCall(response, "workspace__list", {
            collection: "research",
            limit: 10,
          });
          return;
        }
        respondText(response, "Synthetic answer");
        return;
      }
      respondText(response, "Synthetic answer");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve(undefined));
      }),
  };
}
