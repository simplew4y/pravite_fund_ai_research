process.send({
  type: "worker.ready",
  workerId: "fake-worker",
});

const groundedQuestions = new Map();

function emitGroundedAnswer(sessionId, operationId, item) {
  process.send({
    type: "agent.event",
    sessionId,
    operationId,
    eventType: "message.assistant.delta",
    payload: {
      delta:
        `${item.content} ` +
        `[Evidence: ${item.evidenceId}; document=${item.documentId}]`,
    },
  });
  process.send({
    type: "agent.event",
    sessionId,
    operationId,
    eventType: "session.status",
    payload: { status: "idle" },
  });
}

process.on("message", (command) => {
  if (command.type === "tool.result") {
    const grounded = groundedQuestions.get(command.sessionId);
    if (grounded && command.tool === "evidence.search") {
      process.send({
        type: "agent.event",
        sessionId: command.sessionId,
        operationId: grounded.operationId,
        eventType: "test.evidence-search-result",
        payload: {
          ok: command.ok,
          result: command.result ?? null,
          error: command.error ?? null,
        },
      });
      const hit = command.ok ? command.result?.hits?.[0] : undefined;
      if (!hit?.evidenceId) {
        groundedQuestions.delete(command.sessionId);
        emitGroundedAnswer(command.sessionId, grounded.operationId, {
          content: "No matching canonical Evidence was found.",
          evidenceId: "none",
          documentId: "none",
        });
        return;
      }
      grounded.evidenceId = hit.evidenceId;
      process.send({
        type: "tool.request",
        protocolVersion: 1,
        requestId: `evidence-get-${command.sessionId}`,
        sessionId: command.sessionId,
        toolCallId: `evidence-get-call-${command.sessionId}`,
        tool: "evidence.get",
        arguments: {
          evidenceIds: [hit.evidenceId],
        },
        deadlineAt: new Date(Date.now() + 2_000).toISOString(),
      });
      return;
    }
    if (grounded && command.tool === "evidence.get") {
      process.send({
        type: "agent.event",
        sessionId: command.sessionId,
        operationId: grounded.operationId,
        eventType: "test.evidence-get-result",
        payload: {
          ok: command.ok,
          result: command.result ?? null,
          error: command.error ?? null,
        },
      });
      const item = command.ok ? command.result?.items?.[0] : undefined;
      groundedQuestions.delete(command.sessionId);
      emitGroundedAnswer(
        command.sessionId,
        grounded.operationId,
        item ?? {
          content: "Canonical Evidence detail was unavailable.",
          evidenceId: grounded.evidenceId ?? "none",
          documentId: "none",
        },
      );
      return;
    }
    process.send({
      type: "agent.event",
      sessionId: command.sessionId,
      operationId: null,
      eventType: "test.tool-result",
      payload: {
        ok: command.ok,
        result: command.result ?? null,
        error: command.error ?? null,
      },
    });
    return;
  }
  process.send({
    type: "command.result",
    requestId: command.requestId,
    ok: true,
  });
  if (command.type === "session.prompt") {
    if (command.content === "Crash after acknowledge") {
      setImmediate(() => process.exit(17));
      return;
    }
    if (command.content === "Hold after acknowledge") {
      return;
    }
    if (command.content.startsWith("Evidence question:")) {
      groundedQuestions.set(command.sessionId, {
        operationId: command.operationId,
      });
      process.send({
        type: "tool.request",
        protocolVersion: 1,
        requestId: `evidence-search-${command.sessionId}`,
        sessionId: command.sessionId,
        toolCallId: `evidence-search-call-${command.sessionId}`,
        tool: "evidence.search",
        arguments: {
          query: command.content.slice("Evidence question:".length).trim(),
          limit: 5,
        },
        deadlineAt: new Date(Date.now() + 2_000).toISOString(),
      });
      return;
    }
    if (command.content === "Request parent tool") {
      process.send({
        type: "tool.request",
        protocolVersion: 1,
        requestId: "tool-request-1",
        sessionId: command.sessionId,
        toolCallId: "tool-call-1",
        tool: "workspace.list",
        arguments: {
          collection: "research",
          limit: 10,
        },
        deadlineAt: new Date(Date.now() + 2_000).toISOString(),
      });
    }
    process.send({
      type: "agent.event",
      sessionId: command.sessionId,
      operationId: command.operationId,
      eventType: "test.environment",
      payload: {
        cookieSecretVisible:
          process.env.OMNIGENT_ACCOUNTS_COOKIE_SECRET !== undefined,
      },
    });
    process.send({
      type: "agent.event",
      sessionId: command.sessionId,
      operationId: command.operationId,
      eventType: "message.assistant.delta",
      payload: { delta: "Synthetic answer" },
    });
    process.send({
      type: "agent.event",
      sessionId: command.sessionId,
      operationId: command.operationId,
      eventType: "session.status",
      payload: { status: "idle" },
    });
    return;
  }
  if (command.type === "session.compact") {
    process.send({
      type: "agent.event",
      sessionId: command.sessionId,
      operationId: null,
      eventType: "compaction.started",
      payload: { reason: "manual" },
    });
    if (command.customInstructions === "simulate-control-plane-crash") {
      return;
    }
    process.send({
      type: "agent.event",
      sessionId: command.sessionId,
      operationId: null,
      eventType: "compaction.completed",
      payload: {
        reason: "manual",
        result: "Synthetic compacted context",
        aborted: false,
        willRetry: false,
        error: null,
      },
    });
  }
});

process.on("disconnect", () => {
  process.exitCode = 0;
});
