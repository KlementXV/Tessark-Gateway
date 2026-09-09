// Makes `t("some.key")` a compile error when the key is missing from messages/en.json, and
// narrows `useLocale()` to the supported set. English is the reference catalogue: French
// must carry the same keys (checked by scripts/check-messages.ts).
import type en from "../../messages/en.json"
import type { Locale } from "./locale"

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale
    Messages: typeof en
  }
}
