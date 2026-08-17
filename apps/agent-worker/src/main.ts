import { delimiter } from "node:path";

import { installAgentWorkerIpc } from "./ipc.js";

function configuredSkillPaths(): string[] {
  const configured = process.env["PRIVATE_FUND_AGENT_SKILL_PATHS"];
  if (configured === undefined || configured.trim() === "") {
    return [];
  }
  return configured
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function configuredParentRpcTimeout(): number | undefined {
  const configured =
    process.env["PRIVATE_FUND_PARENT_TOOL_RPC_TIMEOUT_MS"];
  if (configured === undefined || configured.trim() === "") {
    return undefined;
  }
  const timeout = Number(configured);
  if (
    !Number.isInteger(timeout) ||
    timeout < 10 ||
    timeout > 300_000
  ) {
    throw new Error(
      "PRIVATE_FUND_PARENT_TOOL_RPC_TIMEOUT_MS must be an integer from 10 to 300000",
    );
  }
  return timeout;
}

const skillPaths = configuredSkillPaths();
const systemPrompt = process.env["PRIVATE_FUND_AGENT_SYSTEM_PROMPT"];
const parentToolRpcTimeoutMs = configuredParentRpcTimeout();

installAgentWorkerIpc({
  enableParentRpcTools:
    process.env["PRIVATE_FUND_ENABLE_PARENT_RPC_TOOLS"] === "1",
  ...(parentToolRpcTimeoutMs === undefined
    ? {}
    : { parentToolRpcTimeoutMs }),
  piSessionFactoryOptions: {
    skillPaths,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  },
  ...(process.env["AGENT_WORKER_ID"] === undefined
    ? {}
    : { workerId: process.env["AGENT_WORKER_ID"] }),
});
