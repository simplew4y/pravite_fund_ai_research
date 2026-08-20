import { useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  changePassword,
  fetchAccountUsage,
  fetchBalanceRecords,
  submitFeedback,
} from "../../api/account";
import { ApiError } from "../../api/http";
import { useServerInfo } from "../../api/queries";
import { Modal } from "../../components/Modal";
import { MonoLabel } from "../../components/MonoLabel";
import { useT } from "../../i18n/useT";

const FORM_STYLE = { display: "flex", flexDirection: "column", gap: 8 } as const;

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <div style={{ marginBottom: 6 }}>
        <MonoLabel>{label}</MonoLabel>
      </div>
      {children}
    </section>
  );
}

function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="doc-row">
      <span className="title">{label}</span>
      <MonoLabel>{value}</MonoLabel>
    </div>
  );
}

/** Cloud proxy endpoints answer 404/503 when the account service is absent. */
function isAccountsUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 503);
}

function UsageSection() {
  const { t } = useT();
  const usage = useQuery({
    queryKey: ["account", "usage"],
    queryFn: () => fetchAccountUsage(),
  });

  if (usage.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (usage.isError) {
    return isAccountsUnavailable(usage.error) ? (
      <p className="text-muted">{t("account.unavailable")}</p>
    ) : (
      <p className="error-text">{t("common.error")}</p>
    );
  }

  const summary = usage.data.summary;
  const missing = t("common.missing");
  return (
    <div>
      <KeyValueRow
        label={t("account.usage.requests")}
        value={
          summary?.request_count !== undefined ? String(summary.request_count) : missing
        }
      />
      <KeyValueRow
        label={t("account.usage.tokens")}
        value={summary?.total_tokens !== undefined ? String(summary.total_tokens) : missing}
      />
      <KeyValueRow
        label={t("account.usage.charged")}
        value={summary?.charged_amount_cny ?? missing}
      />
    </div>
  );
}

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function BalanceSection() {
  const { t } = useT();
  const records = useQuery({
    queryKey: ["account", "balance-records"],
    queryFn: () => fetchBalanceRecords(),
  });

  if (records.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (records.isError) {
    return isAccountsUnavailable(records.error) ? (
      <p className="text-muted">{t("account.unavailable")}</p>
    ) : (
      <p className="error-text">{t("common.error")}</p>
    );
  }

  const rows = records.data.items.slice(0, 10);
  if (rows.length === 0) return <p className="text-muted">{t("common.empty")}</p>;
  return (
    <div>
      {rows.map((record, index) => (
        <div key={record.id ?? `record-${String(index)}`} className="doc-row">
          <span className="title">
            {record.id ? truncateId(record.id) : t("common.missing")}
          </span>
          <MonoLabel>{record.amount_cny ?? t("common.missing")}</MonoLabel>
        </div>
      ))}
    </div>
  );
}

function FeedbackSection() {
  const { t } = useT();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const send = useMutation({
    mutationFn: (input: { title: string; content: string }) =>
      submitFeedback({ feedback_type: "general", ...input }),
    onSuccess: () => {
      setTitle("");
      setContent("");
    },
  });

  return (
    <form
      style={FORM_STYLE}
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate({ title, content });
      }}
    >
      <input
        className="input"
        placeholder={t("account.feedback.title")}
        value={title}
        maxLength={240}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        className="input"
        rows={3}
        placeholder={t("account.feedback.content")}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="btn btn-secondary"
          type="submit"
          // Server-side feedbackSchema requires >= 2 chars for both fields.
          disabled={
            send.isPending || title.trim().length < 2 || content.trim().length < 2
          }
        >
          {t("common.submit")}
        </button>
        {send.isSuccess ? (
          <span className="text-muted">{t("account.feedback.sent")}</span>
        ) : null}
      </div>
      {send.isError ? (
        <p className="error-text">
          {send.error instanceof ApiError ? send.error.message : t("common.error")}
        </p>
      ) : null}
    </form>
  );
}

function PasswordSection() {
  const { t } = useT();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const change = useMutation({
    mutationFn: (input: { oldPassword: string; newPassword: string }) =>
      changePassword(input.oldPassword, input.newPassword),
    onSuccess: () => {
      setOldPassword("");
      setNewPassword("");
    },
  });

  return (
    <form
      style={FORM_STYLE}
      onSubmit={(event) => {
        event.preventDefault();
        change.mutate({ oldPassword, newPassword });
      }}
    >
      <input
        className="input"
        type="password"
        autoComplete="current-password"
        placeholder={t("account.oldPassword")}
        value={oldPassword}
        onChange={(event) => setOldPassword(event.target.value)}
      />
      <input
        className="input"
        type="password"
        autoComplete="new-password"
        minLength={8}
        placeholder={t("auth.newPassword")}
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
      />
      <div>
        <button
          className="btn btn-secondary"
          type="submit"
          disabled={change.isPending || oldPassword === "" || newPassword.length < 8}
        >
          {t("account.changePassword")}
        </button>
      </div>
      {change.isSuccess ? (
        // The server already cleared the session cookie; the auth gate takes
        // over on the next request, so no manual redirect here.
        <p className="text-muted">{t("account.passwordChanged")}</p>
      ) : null}
      {change.isError ? (
        <p className="error-text">
          {change.error instanceof ApiError ? change.error.message : t("common.error")}
        </p>
      ) : null}
    </form>
  );
}

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const info = useServerInfo();

  return (
    <Modal title={t("account.title")} onClose={onClose}>
      {info.data?.accounts_enabled === true ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Section label={t("account.usage")}>
            <UsageSection />
          </Section>
          <Section label={t("account.balance")}>
            <BalanceSection />
          </Section>
          <Section label={t("account.feedback")}>
            <FeedbackSection />
          </Section>
          <Section label={t("account.changePassword")}>
            <PasswordSection />
          </Section>
        </div>
      ) : (
        <p className="text-muted">{t("account.unavailable")}</p>
      )}
    </Modal>
  );
}
