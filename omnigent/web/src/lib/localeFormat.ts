import i18n, { normalizeAppLocale, type AppLocale } from "@/i18n";

export function currentAppLocale(): AppLocale {
  return normalizeAppLocale(i18n.language);
}

export function formatLocalizedNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentAppLocale(), options).format(value);
}

export function formatLocalizedDate(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(currentAppLocale(), options).format(date);
}

export function formatCny(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(currentAppLocale(), {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value);
}
