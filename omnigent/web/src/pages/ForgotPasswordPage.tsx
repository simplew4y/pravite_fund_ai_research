import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@/lib/routing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resetPassword, sendPasswordResetCode } from "@/lib/accountsApi";
import { LanguageSelector } from "@/components/LanguageSelector";

const MIN_PASSWORD_LENGTH = 8;

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setResendSeconds((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  async function sendCode() {
    if (sendingCode || !email.trim()) return;
    setSendingCode(true);
    setError(null);
    const result = await sendPasswordResetCode(email.trim());
    setSendingCode(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCodeSent(true);
    setResendSeconds(result.resend_after);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (password !== confirm) {
      setError(t("auth.passwordMismatch", "The passwords do not match."));
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await resetPassword({
      email: email.trim(),
      code,
      new_password: password,
    });
    if (result.ok) {
      window.location.href = "/login?password=reset";
      return;
    }
    setSubmitting(false);
    setError(result.error);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <LanguageSelector compact className="fixed right-4 top-4 z-10" />
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t("auth.resetTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("auth.resetDescription", "Use an email verification code to set a new password.")}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="reset-email" className="text-sm font-medium">
              {t("auth.email")}
            </label>
            <div className="flex gap-2">
              <Input
                id="reset-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (codeSent) {
                    setCodeSent(false);
                    setCode("");
                    setResendSeconds(0);
                  }
                }}
                disabled={sendingCode || submitting}
                required
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={sendingCode || submitting || resendSeconds > 0 || !email.trim()}
                onClick={() => void sendCode()}
              >
                {sendingCode
                  ? "发送中..."
                  : resendSeconds > 0
                    ? `${resendSeconds}s`
                    : codeSent
                      ? t("auth.resendCode")
                      : t("auth.sendCode")}
              </Button>
            </div>
          </div>

          {codeSent && (
            <>
              <div className="space-y-1.5">
                <label htmlFor="reset-code" className="text-sm font-medium">
                  {t("auth.verificationCode")}
                </label>
                <Input
                  id="reset-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder={t("auth.sixDigitCode", "6-digit code")}
                  disabled={submitting}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="reset-password" className="text-sm font-medium">
                  {t("auth.newPassword")}
                </label>
                <Input
                  id="reset-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  disabled={submitting}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="reset-confirm" className="text-sm font-medium">
                  {t("auth.confirmNewPassword")}
                </label>
                <Input
                  id="reset-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  disabled={submitting}
                  required
                />
              </div>
            </>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          {codeSent && (
            <Button
              type="submit"
              className="w-full"
              disabled={submitting || code.length !== 6 || password.length < MIN_PASSWORD_LENGTH}
            >
              {submitting ? t("auth.resetting", "Resetting…") : t("auth.resetPassword")}
            </Button>
          )}
        </form>

        <p className="text-center text-sm text-muted-foreground">
          <Link to="/login" className="font-medium text-foreground hover:underline">
            {t("common.back")} {t("auth.signIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
