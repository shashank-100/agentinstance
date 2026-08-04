// Separate node-environment config for pure UI-logic tests (no workers pool).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/ui/**/*.test.ts"],
    environment: "node",
  },
});
