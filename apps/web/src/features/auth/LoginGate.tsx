import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { login } from "../../api/client";
import { useMe, useServerInfo } from "../../api/queries";
import { Blueprint } from "../../components/Blueprint";
import { useT } from "../../i18n/useT";

function LoginForm({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailed(false);
    try {
      await login(email, password);
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-screen">
      <Blueprint className="login-box elev-md">
        <h1 className="card-title">{t("app.title")}</h1>
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="login-email">{t("auth.email")}</label>
            <input
              id="login-email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">{t("auth.password")}</label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {failed ? <p className="error-text">{t("auth.failed")}</p> : null}
          <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
            {t("auth.login")}
          </button>
        </form>
      </Blueprint>
    </div>
  );
}

/**
 * Gates the app behind /auth/me when the server runs cloud accounts;
 * development-mode servers need no login.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const { t } = useT();
  const client = useQueryClient();
  const info = useServerInfo();
  const accountsEnabled = info.data?.accounts_enabled ?? false;
  const me = useMe(accountsEnabled);

  if (info.isPending) return <div className="center-placeholder">{t("common.loading")}</div>;
  if (info.isError) {
    return (
      <div className="center-placeholder">
        {t("common.error")}
        <button className="btn btn-ghost" onClick={() => void info.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (accountsEnabled) {
    if (me.isPending) return <div className="center-placeholder">{t("common.loading")}</div>;
    if (me.isError) {
      return <LoginForm onDone={() => void client.invalidateQueries({ queryKey: ["me"] })} />;
    }
  }
  return <>{children}</>;
}
