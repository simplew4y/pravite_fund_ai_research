import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import {
  clearUserScopedBrowserState,
  register as registerRequest,
} from "@/lib/accountsApi";
import { Link, useSearchParams } from "@/lib/routing";

const MIN_PASSWORD_LENGTH = 8;

export function RegisterPage() {
  const info = useServerInfo();
  const [params] = useSearchParams();
  const invite = params.get("invite") ?? "";
  const openRegistration = info !== "loading" && info.registration_mode === "open";
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.getElementById("register-identity")?.focus();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`);
      return;
    }
    setSubmitting(true);
    const result = await registerRequest(
      openRegistration
        ? { email: identity.trim().toLowerCase(), password }
        : { invite, username: identity.trim().toLowerCase(), password },
    );
    if (result.ok) {
      clearUserScopedBrowserState();
      window.location.href = "/";
      return;
    }
    setSubmitting(false);
    setError(result.error);
  }

  const missingInvite = !openRegistration && !invite;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <header className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">创建账户</h1>
          <p className="text-sm text-muted-foreground">
            {openRegistration ? "使用邮箱开始你的私募投研工作区。" : "接受邀请并创建账户。"}
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
                {openRegistration ? "邮箱" : "用户名"}
              </label>
              <Input
                id="register-identity"
                aria-label={openRegistration ? "Email" : "Username"}
                type={openRegistration ? "email" : "text"}
                autoComplete={openRegistration ? "email" : "username"}
                value={identity}
                onChange={(event) => setIdentity(event.target.value)}
                disabled={submitting}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="register-password" className="text-sm font-medium">
                密码
              </label>
              <Input
                id="register-password"
                aria-label="Password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="register-confirm" className="text-sm font-medium">
                确认密码
              </label>
              <Input
                id="register-confirm"
                aria-label="Confirm password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                disabled={submitting}
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
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
                password.length < MIN_PASSWORD_LENGTH
              }
            >
              {submitting ? "正在创建..." : "创建账户"}
            </Button>
          </form>
        )}
        <p className="text-center text-sm text-muted-foreground">
          已有账户？{" "}
          <Link to="/login" className="font-medium text-foreground hover:underline">
            登录
          </Link>
        </p>
      </div>
    </main>
  );
}
