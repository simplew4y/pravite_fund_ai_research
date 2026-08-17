import { describe, expect, it } from "vitest";

import type { AgentToolName } from "@private-fund/contracts";

import {
  PARENT_RPC_TOOL_NAMES,
  createParentRpcToolRegistry,
} from "../src/parent-rpc-tools.js";
import { ParentToolRpcClient } from "../src/parent-tool-rpc.js";

const RETIRED_OR_FORBIDDEN_TOOL_NAMES = [
  "bash",
  "environment.list",
  "filesystem.read",
  "hook.permission.resolve",
  "mcp.execute",
  "policy.evaluate",
  "session.permissions.update",
  "session.switch-agent",
  "shell.execute",
  "skills.resolve",
  "terminal.create",
  "terminal.transfer",
] as const;

describe("retired Host/Runner actions at the Pi parent RPC boundary", () => {
  it("exposes exactly the bounded logical-tool allowlist", () => {
    const sent: unknown[] = [];
    const client = new ParentToolRpcClient({
      send: (message) => sent.push(message),
    });
    const registry = createParentRpcToolRegistry(client);

    expect(PARENT_RPC_TOOL_NAMES).toEqual([
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "workspace.write",
      "evidence.search",
      "evidence.get",
      "job.enqueue",
      "job.get",
    ]);
    expect(registry.getAllowedNames()).toEqual(PARENT_RPC_TOOL_NAMES);
    expect(registry.getRegisteredNames()).toEqual(PARENT_RPC_TOOL_NAMES);
    expect(sent).toEqual([]);
  });

  it.each(RETIRED_OR_FORBIDDEN_TOOL_NAMES)(
    "rejects non-allowlisted tool %s before sending parent RPC",
    (tool) => {
      const sent: unknown[] = [];
      const client = new ParentToolRpcClient({
        send: (message) => sent.push(message),
        requestIdFactory: () => "toolreq_forbidden",
      });

      expect(() =>
        client.request({
          sessionId: "session_test",
          toolCallId: "toolcall_test",
          tool: tool as unknown as AgentToolName,
          arguments: {
            action: "execute",
            command: "touch must-not-exist",
            path: "../../outside",
          },
        }),
      ).toThrow();
      expect(client.pendingCount).toBe(0);
      expect(sent).toEqual([]);
    },
  );

  it.each([
    {
      tool: "workspace.read",
      arguments: {
        resourceId: "resource_test",
        action: "shell",
        path: "../../outside",
      },
    },
    {
      tool: "workspace.search",
      arguments: {
        query: "revenue",
        environmentId: "environment_test",
        mcpServer: "untrusted-server",
      },
    },
    {
      tool: "workspace.write",
      arguments: {
        collection: "sources",
        title: "Forbidden source rewrite",
        content: "mutated",
        idempotencyKey: "write_test",
      },
    },
    {
      tool: "job.enqueue",
      arguments: {
        type: "document.ingest",
        idempotencyKey: "job_test",
        command: "touch must-not-exist",
        provider: "untrusted-provider",
      },
    },
  ] as const)(
    "rejects forbidden action fields or authority escalation on $tool",
    ({ tool, arguments: requestArguments }) => {
      const sent: unknown[] = [];
      const client = new ParentToolRpcClient({
        send: (message) => sent.push(message),
        requestIdFactory: () => "toolreq_action_test",
      });

      expect(() =>
        client.request({
          sessionId: "session_test",
          toolCallId: "toolcall_test",
          tool,
          arguments: requestArguments,
        }),
      ).toThrow();
      expect(client.pendingCount).toBe(0);
      expect(sent).toEqual([]);
    },
  );
});
