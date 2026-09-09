import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// CLAUDE.md §0.1: process.env must never be read outside src/lib/config.ts (NODE_ENV is the
// only tolerated exception, everywhere). Scattering env reads across the codebase is exactly
// what makes the Gateway image install-specific instead of immutable+configurable.
const noScatteredProcessEnv = {
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "MemberExpression[object.object.name='process'][object.property.name='env']:not([property.name='NODE_ENV'])",
        message:
          "Don't read process.env.* directly — import { getConfig } from '@/lib/config' instead (see CLAUDE.md §0.1).",
      },
      {
        selector:
          "MemberExpression[object.name='process'][property.name='env']:not(MemberExpression > MemberExpression[object.name='process'][property.name='env'])",
        message:
          "Don't reference process.env directly — import { getConfig } from '@/lib/config' instead (see CLAUDE.md §0.1).",
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  noScatteredProcessEnv,
  {
    // The one file allowed to actually parse process.env, and the one exception the plan
    // (docs/plan-kubernetes-helm.md §1) explicitly carves out: KUBERNETES_SERVICE_HOST/PORT
    // are injected by Kubernetes itself and deliberately kept out of the ConfigMap/schema.
    files: ["src/lib/config.ts", "src/lib/k8s/client.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    "public/swagger-ui/**",
  ]),
]);

export default eslintConfig;
