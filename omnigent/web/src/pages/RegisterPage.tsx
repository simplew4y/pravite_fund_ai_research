import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import {
  clearUserScopedBrowserState,
  register as registerRequest,
  sendRegistrationCode,
} from "@/lib/accountsApi";
import { Link, useSearchParams } from "@/lib/routing";
import { LanguageSelector } from "@/components/LanguageSelector";

const MIN_PASSWORD_LENGTH = 8;

type RegisterField = "identity" | "code" | "nickName" | "password" | "confirm";
type RegisterFieldErrors = Partial<Record<RegisterField, string>>;

function registrationError(
  rawMessage: string,
  status: number,
  code?: string,
): { message: string; field?: RegisterField } {
  const value = `${code ?? ""} ${rawMessage}`.toLocaleLowerCase();
  if (/already.*registered|email.*exists|邮箱.*注册|邮箱.*存在/.test(value)) {
    return { message: "该邮箱已被注册，请直接登录或更换邮箱。", field: "identity" };
  }
  if (/verification|verify|验证码|invalid.*code|expired.*code/.test(value)) {
    return { message: "验证码无效或已过期，请重新获取后再试。", field: "code" };
  }
  if (/password|密码/.test(value)) {
    return {
      message: "密码不符合要求：至少 8 位，并按服务要求包含字母、数字或特殊字符。",
      field: "password",
    };
  }
  if (/nick.?name|昵称/.test(value)) {
    return { message: "昵称格式无效，请缩短昵称或移除特殊字符。", field: "nickName" };
  }
  if (/valid email|invalid email|email.*required|邮箱/.test(value)) {
    return { message: "请输入有效的邮箱地址。", field: "identity" };
  }
  if (status === 429) return { message: "注册尝试过于频繁，请稍后再试。" };
  if (status === 0 || status >= 500) {
    return { message: "账户服务暂时不可用，请检查网络后重试。" };
  }
  return { message: rawMessage || "账户注册失败，请检查填写内容后重试。" };
}

export function RegisterPage() {
  const { t } = useTranslation();
  const info = useServerInfo();
  const [params] = useSearchParams();
  const invite = params.get("invite") ?? "";
  const openRegistration = info !== "loading" && info.registration_mode === "open";
  const cloudRegistration =
    info !== "loading" && info.cloud_accounts_enabled === true && openRegistration;
  const [identity, setIdentity] = useState("");
  const [nickName, setNickName] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<RegisterFieldErrors>({});

  function clearFieldError(field: RegisterField) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setError(null);
  }

  function showRegistrationError(rawMessage: string, status: number, codeValue?: string) {
    const mapped = registrationError(rawMessage, status, codeValue);
    setError(mapped.message);
    setFieldErrors(mapped.field ? { [mapped.field]: mapped.message } : {});
    if (mapped.field) {
      window.requestAnimationFrame(() =>
        document
          .getElementById(`register-${mapped.field === "nickName" ? "nick-name" : mapped.field}`)
          ?.focus(),
      );
    }
  }

  useEffect(() => {
    document.getElementById("register-identity")?.focus();
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(() => {
      setResendSeconds((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  async function onSendCode() {
    if (sendingCode || submitting) return;
    const emailInput = document.getElementById("register-identity");
    if (emailInput instanceof HTMLInputElement && !emailInput.reportValidity()) return;

    setSendingCode(true);
    setError(null);
    setFieldErrors({});
    const result = await sendRegistrationCode(identity.trim().toLowerCase());
    setSendingCode(false);
    if (!result.ok) {
      showRegistrationError(result.error, result.status, result.code);
      return;
    }
    setCodeSent(true);
    setResendSeconds(result.resend_after);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setFieldErrors({});
    if (password !== confirm) {
      const message = "两次输入的密码不一致。";
      setError(message);
      setFieldErrors({ confirm: message });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      const message = `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`;
      setError(message);
      setFieldErrors({ password: message });
      return;
    }
    setSubmitting(true);
    const result = await registerRequest(
      cloudRegistration
        ? {
            email: identity.trim().toLowerCase(),
            code,
            password,
            nick_name: nickName.trim() || null,
          }
        : openRegistration
          ? { email: identity.trim().toLowerCase(), password }
          : { invite, username: identity.trim().toLowerCase(), password },
    );
    if (result.ok) {
      clearUserScopedBrowserState();
      window.location.href = "/";
      return;
    }
    setSubmitting(false);
    showRegistrationError(result.error, result.status, result.code);
  }

  const missingInvite = !cloudRegistration && !openRegistration && !invite;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <LanguageSelector compact className="fixed right-4 top-4 z-10" />
      <div className="w-full max-w-sm space-y-6">
        <header className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">{t("auth.registerTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {cloudRegistration
              ? t(
                  "auth.registerCloudDescription",
                  "Verify your email to create your research workspace.",
                )
              : openRegistration
                ? t(
                    "auth.registerOpenDescription",
                    "Use your email to create your research workspace.",
                  )
                : t(
                    "auth.registerInviteDescription",
                    "Accept the invitation and create an account.",
                  )}
          </p>
        </header>

        {missingInvite ? (
          <div
            role="alert"
            aria-label="Invite token required"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            邀请链接无效或缺少邀请码。
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="register-identity" className="text-sm font-medium">
                {openRegistration ? t("auth.email") : "Username"}
              </label>
              <div className="flex gap-2">
                <Input
                  id="register-identity"
                  aria-label={openRegistration ? "Email" : "Username"}
                  type={openRegistration ? "email" : "text"}
                  autoComplete={openRegistration ? "email" : "username"}
                  value={identity}
                  aria-invalid={Boolean(fieldErrors.identity)}
                  aria-describedby={fieldErrors.identity ? "register-identity-error" : undefined}
                  onChange={(event) => {
                    setIdentity(event.target.value);
                    clearFieldError("identity");
                    if (cloudRegistration && codeSent) {
                      setCodeSent(false);
                      setCode("");
                      setResendSeconds(0);
                    }
                  }}
                  disabled={submitting || sendingCode}
                  required
                />
                {cloudRegistration && (
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={
                      sendingCode || submitting || resendSeconds > 0 || identity.trim().length === 0
                    }
                    onClick={() => void onSendCode()}
                  >
                    {sendingCode
                      ? "发送中..."
                      : resendSeconds > 0
                        ? `${resendSeconds}s`
                        : codeSent
                          ? t("auth.resendCode")
                          : t("auth.sendCode")}
                  </Button>
                )}
              </div>
              {fieldErrors.identity && (
                <p id="register-identity-error" className="text-xs text-destructive">
                  {fieldErrors.identity}
                </p>
              )}
            </div>
            {cloudRegistration && (
              <>
                <div className="space-y-1.5">
                  <label htmlFor="register-code" className="text-sm font-medium">
                    {t("auth.verificationCode")}
                  </label>
                  <Input
                    id="register-code"
                    aria-label="Verification code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    aria-invalid={Boolean(fieldErrors.code)}
                    aria-describedby={fieldErrors.code ? "register-code-error" : undefined}
                    onChange={(event) => {
                      setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                      clearFieldError("code");
                    }}
                    disabled={submitting}
                    pattern="\d{6}"
                    maxLength={6}
                    placeholder={t("auth.sixDigitCode", "6-digit code")}
                    required
                  />
                  {fieldErrors.code && (
                    <p id="register-code-error" className="text-xs text-destructive">
                      {fieldErrors.code}
                    </p>
                  )}
                  {codeSent && (
                    <p className="text-xs text-muted-foreground">
                      {t("auth.codeSent", "Code sent. Check your inbox and spam folder.")}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="register-nick-name" className="text-sm font-medium">
                    {t("auth.nickname")}
                    <span className="ml-1 font-normal text-muted-foreground">
                      {t("auth.optional", "Optional")}
                    </span>
                  </label>
                  <Input
                    id="register-nick-name"
                    aria-label="Nickname"
                    type="text"
                    autoComplete="nickname"
                    value={nickName}
                    aria-invalid={Boolean(fieldErrors.nickName)}
                    aria-describedby={fieldErrors.nickName ? "register-nick-name-error" : undefined}
                    onChange={(event) => {
                      setNickName(event.target.value);
                      clearFieldError("nickName");
                    }}
                    disabled={submitting}
                    maxLength={120}
                  />
                  {fieldErrors.nickName && (
                    <p id="register-nick-name-error" className="text-xs text-destructive">
                      {fieldErrors.nickName}
                    </p>
                  )}
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <label htmlFor="register-password" className="text-sm font-medium">
                {t("auth.password")}
              </label>
              <Input
                id="register-password"
                aria-label="Password"
                type="password"
                autoComplete="new-password"
                value={password}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? "register-password-error" : undefined}
                onChange={(event) => {
                  setPassword(event.target.value);
                  clearFieldError("password");
                }}
                disabled={submitting}
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
              {fieldErrors.password && (
                <p id="register-password-error" className="text-xs text-destructive">
                  {fieldErrors.password}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="register-confirm" className="text-sm font-medium">
                {t("auth.confirmPassword")}
              </label>
              <Input
                id="register-confirm"
                aria-label="Confirm password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                aria-invalid={Boolean(fieldErrors.confirm)}
                aria-describedby={fieldErrors.confirm ? "register-confirm-error" : undefined}
                onChange={(event) => {
                  setConfirm(event.target.value);
                  clearFieldError("confirm");
                }}
                disabled={submitting}
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
              {fieldErrors.confirm && (
                <p id="register-confirm-error" className="text-xs text-destructive">
                  {fieldErrors.confirm}
                </p>
              )}
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            )}
            <Button
              type="submit"
              aria-label="Create account"
              className="w-full"
              disabled={
                submitting ||
                identity.trim().length === 0 ||
                (cloudRegistration && code.length !== 6) ||
                password.length < MIN_PASSWORD_LENGTH
              }
            >
              {submitting ? t("auth.creating", "Creating…") : t("auth.registerTitle")}
            </Button>
          </form>
        )}
        <p className="text-center text-sm text-muted-foreground">
          {t("auth.haveAccount", "Already have an account?")}{" "}
          <Link to="/login" className="font-medium text-foreground hover:underline">
            {t("auth.signIn")}
          </Link>
        </p>
      </div>
    </main>
  );
}
