import type { ServerResponse } from "node:http";

import type { SessionEvent } from "@private-fund/contracts";

export function writeSseEvent(response: ServerResponse, event: SessionEvent): void {
  response.write(`id: ${event.sequence}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function writeSseComment(response: ServerResponse, comment: string): void {
  response.write(`: ${comment.replaceAll("\n", " ")}\n\n`);
}
