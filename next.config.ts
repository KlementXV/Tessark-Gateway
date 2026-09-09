import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
};

// Points next-intl at src/i18n/request.ts (its default location) — the request-scoped
// locale/messages resolver used by both Server and Client Components.
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
