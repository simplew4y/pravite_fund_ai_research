import type { FastifyReply, FastifyRequest } from "fastify";

import {
  compareMemoVersionsQuerySchema,
  generateMemoRequestSchema,
  listMemoVersionsQuerySchema,
  memoArtifactQuerySchema,
} from "@private-fund/contracts";

import { parseIdentifier, sendOpenedFile } from "./shared.js";
import type { RouteContext } from "./context.js";

/**
 * Memo pipeline routes. The wider pre/post-investment surface (valuation,
 * tracking, research workflow) was removed pending a redesign — the memo
 * pipeline stays because it is a shipped feature with its own UI.
 */
export function registerInsightsRoutes(ctx: RouteContext): void {
  const { app, requireInsights, tenantFor } = ctx;

  type MemoArtifactRoute = {
    Params: { projectId: string; memoVersionId: string };
    Querystring: { format?: string };
  };

  const serveMemoArtifact =
    (disposition: "inline" | "attachment") =>
    async (
      request: FastifyRequest<MemoArtifactRoute>,
      reply: FastifyReply,
    ) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const memoVersionId = parseIdentifier(
        request.params.memoVersionId,
        "memo version id",
      );
      const query = memoArtifactQuerySchema.parse(request.query);
      return sendOpenedFile(
        request,
        reply,
        requireInsights().openMemoArtifact(
          tenant,
          projectId,
          memoVersionId,
          query.format,
        ),
        disposition,
      );
    };
  app.get<MemoArtifactRoute>(
    "/v1/projects/:projectId/tracking/memos/:memoVersionId/preview",
    serveMemoArtifact("inline"),
  );
  app.get<MemoArtifactRoute>(
    "/v1/projects/:projectId/tracking/memos/:memoVersionId/download",
    serveMemoArtifact("attachment"),
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      seriesId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/projects/:projectId/tracking/memos", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = listMemoVersionsQuerySchema.parse(request.query);
    return requireInsights().memoSeries(tenant, projectId, query);
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/tracking/memos",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = generateMemoRequestSchema.parse(request.body);
      return reply
        .status(202)
        .send(
          await requireInsights().generateMemo(
            tenant,
            projectId,
            input,
          ),
        );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { fromVersionId?: string; toVersionId?: string };
  }>(
    "/v1/projects/:projectId/tracking/memos/compare",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const query = compareMemoVersionsQuerySchema.parse(request.query);
      return requireInsights().compareMemoVersions(
        tenant,
        projectId,
        query.fromVersionId,
        query.toVersionId,
      );
    },
  );
}
