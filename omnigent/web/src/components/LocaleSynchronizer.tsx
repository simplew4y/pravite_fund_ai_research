import { useEffect } from "react";
import { applyAppLocale } from "@/i18n";
import { ACCOUNT_UPDATED_EVENT, getMe, type CurrentAccount } from "@/lib/accountsApi";

export function LocaleSynchronizer({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void getMe().then((account) => {
      if (active && account?.preferred_locale) {
        void applyAppLocale(account.preferred_locale);
      }
    });
    const update = (event: Event) => {
      const account = (event as CustomEvent<CurrentAccount>).detail;
      if (account?.preferred_locale) void applyAppLocale(account.preferred_locale);
    };
    window.addEventListener(ACCOUNT_UPDATED_EVENT, update);
    return () => {
      active = false;
      window.removeEventListener(ACCOUNT_UPDATED_EVENT, update);
    };
  }, [enabled]);
  return null;
}
