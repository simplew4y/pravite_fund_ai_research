import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, X } from "lucide-react";

import {
  attachmentContentUrl,
  deleteSessionAttachment,
  listSessionAttachments,
  uploadSessionAttachment,
} from "../../api/client";
import { ApiError } from "../../api/http";
import { MonoLabel } from "../../components/MonoLabel";
import { useT } from "../../i18n/useT";

const ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.markdown,.csv,.json,.log";

/**
 * Session attachments strip rendered above the composer, next to the
 * context chips. With no attachments it collapses to a single paperclip
 * button so the composer stays quiet.
 */
export function AttachmentsBar({ sessionId }: { sessionId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachments = useQuery({
    queryKey: ["attachments", sessionId],
    queryFn: () => listSessionAttachments(sessionId),
  });

  const upload = useMutation({
    mutationFn: (file: File) => uploadSessionAttachment(sessionId, file),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["attachments", sessionId] }),
  });

  const remove = useMutation({
    mutationFn: (attachmentId: string) =>
      deleteSessionAttachment(sessionId, attachmentId),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["attachments", sessionId] }),
  });

  return (
    <div>
      <div
        className="ctx-chips"
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}
      >
        <button
          className="btn btn-quiet"
          type="button"
          title={t("chat.attachments")}
          aria-label={t("chat.attachments")}
          disabled={upload.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={15} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            // Reset so re-picking the same file fires change again.
            event.target.value = "";
          }}
        />
        {attachments.isPending ? (
          <span className="text-muted">{t("common.loading")}</span>
        ) : null}
        {attachments.data?.map((attachment) => (
          <span key={attachment.id} className="ctx-chip">
            <a
              href={attachmentContentUrl(sessionId, attachment.id)}
              target="_blank"
              rel="noopener"
            >
              {attachment.name}
            </a>
            <MonoLabel>
              {(attachment.attachment.bytes / 1024).toFixed(0)}KB
            </MonoLabel>
            <button
              className="btn btn-icon btn-ghost"
              type="button"
              title={t("common.close")}
              aria-label={`${t("common.close")} ${attachment.name}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(attachment.id)}
            >
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
      {attachments.isError || remove.isError ? (
        <p className="error-text">{t("common.error")}</p>
      ) : null}
      {upload.isError ? (
        <>
          <p className="error-text">
            {upload.error instanceof ApiError
              ? upload.error.message
              : t("common.error")}
          </p>
          <p className="text-muted">{t("chat.attach.hint")}</p>
        </>
      ) : null}
    </div>
  );
}
