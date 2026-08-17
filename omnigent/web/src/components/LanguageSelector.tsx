import { useState } from "react";
import { useTranslation } from "react-i18next";
import { applyAppLocale, normalizeAppLocale, type AppLocale } from "@/i18n";
import { updateAccountPreferences } from "@/lib/accountsApi";
import { cn } from "@/lib/utils";

export function LanguageSelector({
  persistAccount = false,
  compact = false,
  className,
}: {
  persistAccount?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const active = normalizeAppLocale(i18n.language);

  async function select(locale: AppLocale) {
    if (locale === active || saving) return;
    const previous = active;
    setSaving(true);
    setError("");
    await applyAppLocale(locale);
    if (persistAccount) {
      const result = await updateAccountPreferences(locale);
      if (!result.ok) {
        await applyAppLocale(previous);
        setError(t("language.saveFailed"));
      }
    }
    setSaving(false);
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className={cn(
          "inline-flex rounded-md border bg-muted/40 p-0.5",
          compact ? "text-xs" : "text-sm",
        )}
        role="radiogroup"
        aria-label={t("language.label")}
      >
        {(
          [
            ["zh-CN", t("language.chinese")],
            ["en-US", t("language.english")],
          ] as const
        ).map(([locale, label]) => (
          <button
            key={locale}
            type="button"
            role="radio"
            aria-checked={active === locale}
            disabled={saving}
            onClick={() => void select(locale)}
            className={cn(
              "rounded px-3 py-1.5 transition-colors",
              active === locale
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
