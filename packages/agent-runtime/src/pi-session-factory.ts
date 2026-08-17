import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelGatewayAccess } from "@private-fund/contracts";

import { ModelGatewayCredentialStore } from "./model-gateway-credential-store.js";
import type { PiAgentSession, PiSessionFactory } from "./pi-session.js";
import {
  createEmptyToolRegistry,
  type WhitelistedToolRegistry,
} from "./tool-registry.js";
import type {
  HarnessStartInput,
  HarnessStartSecrets,
} from "./types.js";

export interface PiSessionFactoryOptions {
  agentDirectory?:
    | string
    | ((input: Readonly<HarnessStartInput>) => string);
  skillPaths?: readonly string[];
  systemPrompt?:
    | string
    | ((input: Readonly<HarnessStartInput>) => string | undefined);
  toolRegistry?: WhitelistedToolRegistry;
  modelRuntimeFactory?: (
    input: Readonly<HarnessStartInput>,
    agentDirectory: string,
  ) => Promise<ModelRuntime>;
}

function requireAbsolutePath(label: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path: ${value}`);
  }
  return resolve(value);
}

function optionalSystemPrompt(
  option: PiSessionFactoryOptions["systemPrompt"],
  input: Readonly<HarnessStartInput>,
): string | undefined {
  if (typeof option === "function") {
    return option(input);
  }
  return option;
}

export class PiAgentSessionFactory implements PiSessionFactory {
  private readonly options: PiSessionFactoryOptions;
  private readonly toolRegistry: WhitelistedToolRegistry;
  private readonly defaultModelRuntimes = new Map<
    string,
    Promise<ModelRuntime>
  >();

  constructor(options: PiSessionFactoryOptions = {}) {
    this.options = options;
    this.toolRegistry = options.toolRegistry ?? createEmptyToolRegistry();
  }

  async create(
    input: HarnessStartInput,
    secrets?: HarnessStartSecrets,
  ): Promise<PiAgentSession> {
    const workspace = requireAbsolutePath("workspace", input.workspace);
    const sessionFile = requireAbsolutePath("sessionFile", input.sessionFile);
    const agentDirectory = await this.resolveAgentDirectory(input, sessionFile);

    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(dirname(sessionFile), { recursive: true }),
      mkdir(agentDirectory, { recursive: true }),
    ]);

    const settingsManager = SettingsManager.inMemory();
    const skillPaths = (this.options.skillPaths ?? []).map((path) =>
      requireAbsolutePath("skillPath", path),
    );
    const systemPrompt = optionalSystemPrompt(this.options.systemPrompt, input);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: agentDirectory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: skillPaths,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    });
    await resourceLoader.reload();

    const modelGatewayAccess = secrets?.modelGatewayAccess;
    if (modelGatewayAccess !== undefined) {
      this.assertGatewayBinding(input, modelGatewayAccess);
    }
    const { runtime: modelRuntime, credentialStore } =
      await this.resolveModelRuntime(
        input,
        agentDirectory,
        modelGatewayAccess,
      );
    const requestedModel =
      modelGatewayAccess === undefined
        ? input.model
        : this.gatewayModelReference(input.model, modelGatewayAccess);
    const model = this.resolveRequestedModel(requestedModel, modelRuntime);
    const customTools = this.toolRegistry.materialize(input);
    const sessionAlreadyExists = existsSync(sessionFile);
    const sessionManager = SessionManager.open(
      sessionFile,
      dirname(sessionFile),
      workspace,
    );

    const result = await createAgentSession({
      cwd: workspace,
      agentDir: agentDirectory,
      modelRuntime,
      ...(model === undefined ? {} : { model }),
      noTools: "all",
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
      sessionStartEvent: {
        type: "session_start",
        reason: sessionAlreadyExists ? "resume" : "startup",
      },
    });

    if (credentialStore === undefined) {
      return result.session;
    }
    const session = result.session;
    return {
      get sessionId() {
        return session.sessionId;
      },
      get sessionFile() {
        return session.sessionFile;
      },
      subscribe: session.subscribe.bind(session),
      prompt: session.prompt.bind(session),
      steer: session.steer.bind(session),
      compact: session.compact.bind(session),
      abortCompaction: session.abortCompaction.bind(session),
      abort: session.abort.bind(session),
      async updateModelGatewayAccess(access) {
        credentialStore.update(access);
      },
      dispose() {
        credentialStore.clear();
        session.dispose();
      },
    };
  }

  private async resolveAgentDirectory(
    input: Readonly<HarnessStartInput>,
    sessionFile: string,
  ): Promise<string> {
    const configured = this.options.agentDirectory;
    const directory =
      typeof configured === "function"
        ? configured(input)
        : configured ?? join(dirname(sessionFile), "agent-config");
    return requireAbsolutePath("agentDirectory", directory);
  }

  private async resolveModelRuntime(
    input: Readonly<HarnessStartInput>,
    agentDirectory: string,
    modelGatewayAccess?: ModelGatewayAccess,
  ): Promise<{
    runtime: ModelRuntime;
    credentialStore?: ModelGatewayCredentialStore;
  }> {
    if (modelGatewayAccess !== undefined) {
      const credentialStore = new ModelGatewayCredentialStore(
        modelGatewayAccess,
      );
      const runtime = await ModelRuntime.create({
        credentials: credentialStore,
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerProvider(modelGatewayAccess.providerId, {
        name: "Private Fund Model Gateway",
        baseUrl: modelGatewayAccess.gatewayBaseUrl,
        api: "openai-completions",
        authHeader: true,
        models: [
          {
            id: modelGatewayAccess.model.id,
            name: modelGatewayAccess.model.name,
            api: "openai-completions",
            baseUrl: modelGatewayAccess.gatewayBaseUrl,
            reasoning: false,
            input: ["text"],
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow: modelGatewayAccess.model.contextWindow,
            maxTokens: modelGatewayAccess.model.maxTokens,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
            },
          },
        ],
      });
      return { runtime, credentialStore };
    }
    if (this.options.modelRuntimeFactory !== undefined) {
      return {
        runtime: await this.options.modelRuntimeFactory(input, agentDirectory),
      };
    }

    const existing = this.defaultModelRuntimes.get(agentDirectory);
    if (existing !== undefined) {
      return { runtime: await existing };
    }

    const created = ModelRuntime.create({
      authPath: join(agentDirectory, "auth.json"),
      modelsPath: join(agentDirectory, "models.json"),
      allowModelNetwork: false,
    });
    this.defaultModelRuntimes.set(agentDirectory, created);
    void created.catch(() => {
      if (this.defaultModelRuntimes.get(agentDirectory) === created) {
        this.defaultModelRuntimes.delete(agentDirectory);
      }
    });
    return { runtime: await created };
  }

  private gatewayModelReference(
    requested: string | undefined,
    access: ModelGatewayAccess,
  ): string {
    const canonical = `${access.providerId}/${access.model.id}`;
    if (
      requested !== undefined &&
      requested !== access.model.id &&
      requested !== canonical
    ) {
      throw new Error("Requested model is outside the model gateway lease");
    }
    return canonical;
  }

  private assertGatewayBinding(
    input: HarnessStartInput,
    access: ModelGatewayAccess,
  ): void {
    if (
      access.binding.userId !== input.tenant.userId ||
      access.binding.dataNamespace !== input.tenant.dataNamespace ||
      access.binding.projectId !== input.projectId ||
      access.binding.sessionId !== input.sessionId
    ) {
      throw new Error("Model gateway credential binding mismatch");
    }
  }

  private resolveRequestedModel(
    modelReference: string | undefined,
    modelRuntime: ModelRuntime,
  ): ReturnType<typeof resolveCliModel>["model"] {
    if (modelReference === undefined) {
      return undefined;
    }

    const result = resolveCliModel({
      cliModel: modelReference,
      modelRuntime,
    });
    if (result.model === undefined) {
      throw new Error(
        result.error ??
          result.warning ??
          `Pi model could not be resolved: ${modelReference}`,
      );
    }
    return result.model;
  }
}
