import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/main/__tests__/**/*.test.mjs"],
    // .mjs files are ESM by default in Node when package.json has "type": "module"
  },
  // Resolve .mjs files properly
  resolve: {
    extensions: [".mjs", ".js", ".ts"],
  },
});
