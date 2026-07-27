"""Project-scoped durable memory wiring for native Pi sessions."""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Mapping
from pathlib import Path

# Pi extensions execute with the same authority as the agent. Keep the CLI on a
# reviewed, patched release and use maintained code for pi-memory's deprecated
# @mariozechner peer names. The pi-ai alias and narrow coding-agent compatibility
# shim preserve pi-memory 0.4.0's import specifiers without installing the
# abandoned, vulnerable 0.73.1 coding-agent package.
PI_CLI_PACKAGE = "@earendil-works/pi-coding-agent"
PI_CLI_VERSION = "0.81.1"

# Pin the package because Pi extensions execute with the same host authority as
# the Pi process. A floating third-party extension would make every new session
# an implicit code update.
PI_MEMORY_PACKAGE = "npm:pi-memory@0.4.0"
PI_MEMORY_PACKAGE_VERSION = "0.4.0"
_PI_MEMORY_COMPAT_DEPENDENCIES = {
    "pi-memory": PI_MEMORY_PACKAGE_VERSION,
    "@mariozechner/pi-ai": f"npm:@earendil-works/pi-ai@{PI_CLI_VERSION}",
    "@mariozechner/pi-coding-agent": "file:shims/pi-coding-agent",
}
# @google/genai's compatible range can otherwise resolve protobufjs 7.6.4,
# which is affected by GHSA-j3f2-48v5-ccww. Force the patched release throughout
# the isolated extension tree.
_PI_MEMORY_NPM_OVERRIDES: dict[str, object] = {
    "protobufjs": "7.6.5",
    "@google/genai": {"protobufjs": "7.6.5"},
}
PI_MEMORY_DIR_ENV_VAR = "PI_MEMORY_DIR"
PI_MEMORY_SNAPSHOT_ENV_VAR = "PI_MEMORY_SNAPSHOT"
OMNIGENT_PI_MEMORY_DIR_ENV_VAR = "OMNIGENT_PI_MEMORY_DIR"

_DEFAULT_SNAPSHOT_MODE = "stable"
_MEMORY_ROOT = Path.home() / ".omnigent" / "pi-memory"
_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")

_PI_MEMORY_CODING_AGENT_SHIM = """\
import { contentText } from "@mariozechner/pi-ai";

const COMPACTION_PREFIX =
  "The conversation history before this point was compacted into " +
  "the following summary:\\n\\n<summary>\\n";
const COMPACTION_SUFFIX = "\\n</summary>";
const BRANCH_PREFIX =
  "The following is a summary of a branch that this conversation " +
  "came back from:\\n\\n<summary>\\n";
const BRANCH_SUFFIX = "</summary>";
const TOOL_RESULT_MAX_CHARS = 2000;

function bashExecutionToText(message) {
  let text = `Ran \\`${message.command}\\`\\n`;
  text += message.output ? `\\`\\`\\`\\n${message.output}\\n\\`\\`\\`` : "(no output)";
  if (message.cancelled) text += "\\n\\n(command cancelled)";
  else if (message.exitCode != null && message.exitCode !== 0) {
    text += `\\n\\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\\n\\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

export function convertToLlm(messages) {
  return messages.flatMap((message) => {
    switch (message.role) {
      case "bashExecution":
        return message.excludeFromContext
          ? []
          : [{
              role: "user",
              content: [{ type: "text", text: bashExecutionToText(message) }],
              timestamp: message.timestamp,
            }];
      case "custom":
        return [{
          role: "user",
          content: typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content,
          timestamp: message.timestamp,
        }];
      case "branchSummary":
        return [{
          role: "user",
          content: [{ type: "text", text: BRANCH_PREFIX + message.summary + BRANCH_SUFFIX }],
          timestamp: message.timestamp,
        }];
      case "compactionSummary":
        return [{
          role: "user",
          content: [{
            type: "text",
            text: COMPACTION_PREFIX + message.summary + COMPACTION_SUFFIX,
          }],
          timestamp: message.timestamp,
        }];
      case "user":
      case "assistant":
      case "toolResult":
        return [message];
      default:
        return [];
    }
  });
}

function truncateToolResult(text) {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const remaining = text.length - TOOL_RESULT_MAX_CHARS;
  return (
    `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\\n\\n` +
    `[... ${remaining} more characters truncated]`
  );
}

export function serializeConversation(messages) {
  const parts = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = contentText(message.content, "");
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }
    if (message.role === "assistant") {
      const thinking = [];
      const calls = [];
      for (const block of message.content || []) {
        if (block.type === "thinking") thinking.push(block.thinking);
        if (block.type === "toolCall") {
          const args = Object.entries(block.arguments || {})
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(", ");
          calls.push(`${block.name}(${args})`);
        }
      }
      if (thinking.length) parts.push(`[Assistant thinking]: ${thinking.join("\\n")}`);
      if ((message.content || []).some((block) => block.type === "text")) {
        parts.push(`[Assistant]: ${contentText(message.content)}`);
      }
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
      continue;
    }
    if (message.role === "toolResult") {
      const text = contentText(message.content, "");
      if (text) parts.push(`[Tool result]: ${truncateToolResult(text)}`);
    }
  }
  return parts.join("\\n\\n");
}
"""


def prepare_pi_memory_package_manifest(agent_dir: Path) -> Path:
    """Preseed Pi's isolated npm tree with pinned, maintained dependencies.

    ``pi-memory@0.4.0`` still declares runtime peers under the deprecated
    ``@mariozechner`` package names. A normal npm install therefore brings in
    the final unpatched 0.73.1 release even when the host Pi CLI is current.
    The pi-ai alias uses the maintained package. A local, versioned shim
    supplies only the two coding-agent serialization functions pi-memory
    imports, avoiding a second full CLI dependency tree.

    Existing unrelated dependency and override entries are preserved because a
    managed agent dir can survive a terminal restart. The security-sensitive
    Pi entries are always rewritten to the reviewed exact versions.

    :param agent_dir: Managed ``PI_CODING_AGENT_DIR`` for one session.
    :returns: The written ``npm/package.json`` path.
    """
    npm_dir = agent_dir / "npm"
    npm_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(npm_dir, 0o700)
    shim_dir = npm_dir / "shims" / "pi-coding-agent"
    shim_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(shim_dir, 0o700)
    shim_package = {
        "name": "@mariozechner/pi-coding-agent",
        "version": PI_CLI_VERSION,
        "type": "module",
        "main": "index.js",
        "exports": "./index.js",
        "private": True,
    }
    for path, content in (
        (npm_dir / ".npmrc", "save-exact=true\n"),
        (
            shim_dir / "package.json",
            json.dumps(shim_package, indent=2, sort_keys=True) + "\n",
        ),
        (shim_dir / "index.js", _PI_MEMORY_CODING_AGENT_SHIM),
    ):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(path, 0o600)
    manifest_path = npm_dir / "package.json"
    manifest: dict[str, object] = {}
    if manifest_path.is_file():
        try:
            parsed = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            parsed = {}
        if isinstance(parsed, dict):
            manifest = parsed

    manifest["name"] = "omnigent-pi-extensions"
    manifest["private"] = True
    raw_dependencies = manifest.get("dependencies")
    dependencies = dict(raw_dependencies) if isinstance(raw_dependencies, dict) else {}
    dependencies.update(_PI_MEMORY_COMPAT_DEPENDENCIES)
    manifest["dependencies"] = dependencies
    raw_overrides = manifest.get("overrides")
    overrides = dict(raw_overrides) if isinstance(raw_overrides, dict) else {}
    overrides.update(_PI_MEMORY_NPM_OVERRIDES)
    manifest["overrides"] = overrides

    fd = os.open(
        manifest_path,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        0o600,
    )
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.chmod(manifest_path, 0o600)
    return manifest_path


def _git_repository_identity(workspace: Path) -> tuple[str, Path] | None:
    """Return ``(repository_name, common_git_dir)`` for *workspace*.

    Resolving the common git directory makes a repository and all of its
    worktrees share one operational memory instead of fragmenting memory by
    checkout path.
    """
    resolved = workspace.expanduser().resolve()
    candidates = (resolved, *resolved.parents)
    for project_root in candidates:
        dot_git = project_root / ".git"
        if dot_git.is_dir():
            return project_root.name, dot_git.resolve()
        if not dot_git.is_file():
            continue
        try:
            first_line = dot_git.read_text(encoding="utf-8").splitlines()[0]
        except (OSError, IndexError):
            continue
        prefix = "gitdir:"
        if not first_line.lower().startswith(prefix):
            continue
        git_dir = Path(first_line[len(prefix) :].strip())
        if not git_dir.is_absolute():
            git_dir = project_root / git_dir
        git_dir = git_dir.resolve()
        common_dir_file = git_dir / "commondir"
        if common_dir_file.is_file():
            try:
                common_dir = Path(common_dir_file.read_text(encoding="utf-8").strip())
                if not common_dir.is_absolute():
                    common_dir = git_dir / common_dir
                git_dir = common_dir.resolve()
            except OSError:
                pass
        repository_name = git_dir.parent.name if git_dir.name == ".git" else project_root.name
        return repository_name, git_dir
    return None


def pi_memory_dir_for_workspace(
    workspace: Path,
    *,
    env: Mapping[str, str] | None = None,
    memory_root: Path | None = None,
) -> Path:
    """Resolve the durable Pi memory directory for *workspace*.

    ``OMNIGENT_PI_MEMORY_DIR`` is the Omnigent-specific override;
    ``PI_MEMORY_DIR`` remains compatible with direct pi-memory configuration.
    Either can point to a single cross-project memory or a mounted remote
    volume. Otherwise, memory is isolated per Git repository (shared by all
    worktrees); non-Git workspaces are isolated by their resolved path.
    """
    env = os.environ if env is None else env
    override = env.get(OMNIGENT_PI_MEMORY_DIR_ENV_VAR, "").strip()
    if not override:
        override = env.get(PI_MEMORY_DIR_ENV_VAR, "").strip()
    if override:
        configured = Path(override).expanduser()
        if not configured.is_absolute():
            configured = workspace / configured
        return configured.resolve()

    resolved_workspace = workspace.expanduser().resolve()
    repository = _git_repository_identity(resolved_workspace)
    if repository is None:
        display_name = resolved_workspace.name or "workspace"
        identity = resolved_workspace
    else:
        display_name, identity = repository
    slug = _SLUG_RE.sub("-", display_name).strip("-._") or "workspace"
    digest = hashlib.sha256(str(identity).encode("utf-8")).hexdigest()[:16]
    root = _MEMORY_ROOT if memory_root is None else memory_root
    return root.expanduser().resolve() / f"{slug}-{digest}"


def prepare_pi_memory_env(
    workspace: Path,
    *,
    env: Mapping[str, str] | None = None,
    memory_root: Path | None = None,
) -> dict[str, str]:
    """Create the workspace memory directory and return Pi launch variables."""
    env = os.environ if env is None else env
    memory_dir = pi_memory_dir_for_workspace(
        workspace,
        env=env,
        memory_root=memory_root,
    )
    has_override = bool(
        env.get(OMNIGENT_PI_MEMORY_DIR_ENV_VAR, "").strip()
        or env.get(PI_MEMORY_DIR_ENV_VAR, "").strip()
    )
    if not has_override:
        memory_dir.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(memory_dir.parent, 0o700)
    memory_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(memory_dir, 0o700)
    snapshot_mode = env.get(PI_MEMORY_SNAPSHOT_ENV_VAR, "").strip()
    if snapshot_mode not in {"stable", "per-turn"}:
        snapshot_mode = _DEFAULT_SNAPSHOT_MODE
    return {
        PI_MEMORY_DIR_ENV_VAR: str(memory_dir),
        PI_MEMORY_SNAPSHOT_ENV_VAR: snapshot_mode,
    }
