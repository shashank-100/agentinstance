// vitest-pool-workers v0.22 replaced defineWorkersConfig with a Vite plugin.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // The UI suite runs in node via vitest.ui.config.ts; keep it out of here.
    exclude: ["test/ui/**", "node_modules/**"],
  },
});
