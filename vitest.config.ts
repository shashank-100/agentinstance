// vitest-pool-workers v0.22 replaced defineWorkersConfig with a Vite plugin.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: "./wrangler.jsonc" },
      // Offline: no provider key in CI, so serve replies from EchoModel.
      miniflare: { bindings: { USE_ECHO_MODEL: "1" } },
    }),
  ],
  test: {
    // The UI suite runs in node via vitest.ui.config.ts; keep it out of here.
    // `node_modules/**` matches only the top level, so a nested install — the
    // board UI has its own — drags thousands of dependency tests into the
    // run and reports them as this project's failures.
    exclude: ["test/ui/**", "**/node_modules/**", "board/**"],
    // singleWorker means every file shares one worker, so parallel file
    // runners deadlock competing to start it: the suite hangs until the
    // pool times out and reports "no tests" with a zero exit code. Serial
    // is also simply faster here — the whole suite is ~12s.
    fileParallelism: false,
  },
});
