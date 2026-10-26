import { dependencyRules } from "@macromackie/swift-factory-toolkit/config/dependencies";
export default dependencyRules({
  externalModules: ["cloudflare:workers"],
  forbidden: [
    {
      name: "postgres-internals-are-private",
      severity: "error",
      from: { path: "^src/(?!postgres/|postgres\\.ts$)" },
      to: { path: "^src/postgres/(?!index\\.ts$)" },
    },
    {
      name: "sync-core-has-no-platform-dependencies",
      severity: "error",
      from: { path: "^src/(?:postgres/|protocol\\.ts$)" },
      to: { path: "^src/(?:cloudflare|testing)\\.ts$" },
    },
  ],
});
