import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [preact()],
  server: { port: 5173 },
  test: { include: ["tests/**/*.test.ts"] },
});
