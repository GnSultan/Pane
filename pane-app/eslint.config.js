import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Immutability
      "prefer-const": "error",
      "no-var": "error",

      // Unused code
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // TypeScript strictness
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off", // we use ! for bounds-checked array access
      "@typescript-eslint/no-invalid-void-type": "off",

      // Disabled — too noisy for React components with dynamic classes
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
  {
    ignores: ["node_modules/**", "out/**", "dist/**", "src/renderer/lib/language-loader.ts"],
  },
);
