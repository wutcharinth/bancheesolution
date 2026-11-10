import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is the web app folder.
export default defineConfig({ test: { root: ".", include: ["tests/**/*.test.ts"] } });
