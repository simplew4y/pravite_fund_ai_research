import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { HarnessStartInput } from "./types.js";

const BUILTIN_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
]);

export interface WhitelistedToolFactory {
  name: string;
  create(context: Readonly<HarnessStartInput>): ToolDefinition;
}

function assertSafeCustomToolName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new Error(`Invalid agent tool name: ${name}`);
  }
  if (BUILTIN_TOOL_NAMES.has(name)) {
    throw new Error(`Built-in agent tool cannot be registered: ${name}`);
  }
}

export class WhitelistedToolRegistry {
  private readonly allowedNames: Set<string>;
  private readonly factories = new Map<string, WhitelistedToolFactory>();

  constructor(allowedNames: Iterable<string>) {
    this.allowedNames = new Set();
    for (const name of allowedNames) {
      assertSafeCustomToolName(name);
      this.allowedNames.add(name);
    }
  }

  register(factory: WhitelistedToolFactory): this {
    assertSafeCustomToolName(factory.name);
    if (!this.allowedNames.has(factory.name)) {
      throw new Error(`Agent tool is not allowlisted: ${factory.name}`);
    }
    if (this.factories.has(factory.name)) {
      throw new Error(`Agent tool is already registered: ${factory.name}`);
    }
    this.factories.set(factory.name, factory);
    return this;
  }

  registerDefinition(tool: ToolDefinition): this {
    return this.register({
      name: tool.name,
      create: () => tool,
    });
  }

  getAllowedNames(): string[] {
    return [...this.allowedNames];
  }

  getRegisteredNames(): string[] {
    return [...this.factories.keys()];
  }

  materialize(context: Readonly<HarnessStartInput>): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const name of this.allowedNames) {
      const factory = this.factories.get(name);
      if (factory === undefined) {
        continue;
      }
      const tool = factory.create(context);
      if (tool.name !== name) {
        throw new Error(
          `Agent tool factory ${name} produced mismatched tool ${tool.name}`,
        );
      }
      tools.push(tool);
    }
    return tools;
  }
}

export function createEmptyToolRegistry(): WhitelistedToolRegistry {
  return new WhitelistedToolRegistry([]);
}
