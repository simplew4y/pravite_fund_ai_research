import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  login,
  register,
  resetPassword,
  sendPasswordResetCode,
  sendRegisterCode,
} from "../../api/client";
import { ApiError } from "../../api/http";
import { useMe, useServerInfo } from "../../api/queries";
import { Blueprint } from "../../components/Blueprint";
import { useT } from "../../i18n/useT";

type AuthMode = "login" | "register" | "reset";

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

/** 发送验证码按钮，带 60 秒冷却。 */
function SendCodeButton({
  email,
  send,
}: {
  email: string;
  send: (email: string) => Promise<void>;
}) {
  const { t } = useT();
  const [cooldown, setCooldown] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function onSend() {
    setPending(true);
    setError(null);
    try {
      await send(email);
      setCooldown(60);
    } catch (sendError) {
      setError(errorText(sendError, t("auth.codeSendFailed")));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={pending || cooldown > 0 || !email.includes("@")}
        onClick={() => void onSend()}
      >
        {cooldown > 0 ? `${String(cooldown)}s` : t("auth.sendCode")}
      </button>
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}

function AuthScreen({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [nickName, setNickName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function switchMode(next: AuthMode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setCode("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "login") {
        await login(email, password);
        onDone();
      } else if (mode === "register") {
        await register({
          email,
          code,
          password,
          ...(nickName.trim() ? { nick_name: nickName.trim() } : {}),
        });
        onDone();
      } else {
        await resetPassword({ email, code, password });
        switchMode("login");
        setNotice(t("auth.resetDone"));
      }
    } catch (submitError) {
      setError(
        errorText(
          submitError,
          mode === "login" ? t("auth.failed") : t("auth.submitFailed"),
        ),
      );
    } finally {
      setPending(false);
    }
  }

  const needsCode = mode !== "login";
  const passwordLabel =
    mode === "reset" ? t("auth.newPassword") : t("auth.password");

  return (
    <div className="login-screen">
      <Blueprint className="login-box elev-md">
        <h1 className="card-title">{t("app.title")}</h1>
        <div className="auth-tabs" role="tablist">
          {(["login", "register", "reset"] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={mode === tab}
              onClick={() => switchMode(tab)}
            >
              {t(
                tab === "login"
                  ? "auth.login"
                  : tab === "register"
                    ? "auth.register"
                    : "auth.reset",
              )}
            </button>
          ))}
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="auth-email">{t("auth.email")}</label>
            <input
              id="auth-email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          {needsCode ? (
            <div className="field">
              <label htmlFor="auth-code">{t("auth.code")}</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  id="auth-code"
                  className="input"
                  style={{ flex: 1 }}
                  inputMode="numeric"
                  // 注册码 4 位、重置码 6 位（云端后台契约）
                  pattern={mode === "register" ? "\\d{4}" : "\\d{6}"}
                  maxLength={mode === "register" ? 4 : 6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
                <SendCodeButton
                  email={email}
                  send={mode === "register" ? sendRegisterCode : sendPasswordResetCode}
                />
              </div>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="auth-password">{passwordLabel}</label>
            <input
              id="auth-password"
              className="input"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "login" ? undefined : 8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {mode === "register" ? (
            <div className="field">
              <label htmlFor="auth-nick">{t("auth.nickname")}</label>
              <input
                id="auth-nick"
                className="input"
                maxLength={120}
                value={nickName}
                onChange={(event) => setNickName(event.target.value)}
              />
            </div>
          ) : null}
          {error ? <p className="error-text">{error}</p> : null}
          {notice ? <p className="text-muted">{notice}</p> : null}
          <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
            {t(
              mode === "login"
                ? "auth.login"
                : mode === "register"
                  ? "auth.register"
                  : "auth.resetSubmit",
            )}
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
      return <AuthScreen onDone={() => void client.invalidateQueries({ queryKey: ["me"] })} />;
    }
  }
  return <>{children}</>;
}
