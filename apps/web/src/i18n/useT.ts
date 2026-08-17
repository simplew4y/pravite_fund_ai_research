import { useUiStore } from "../store/ui";
import { translate, type DictKey, type Lang } from "./dict";

export function useT(): { t: (key: DictKey) => string; lang: Lang } {
  const lang = useUiStore((state) => state.lang);
  return { t: (key) => translate(key, lang), lang };
}
