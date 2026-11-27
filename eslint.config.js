import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/examples/**", "**/docs/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Imported code predates linting; keep the first run green without edits.
      // Node globals (process, Buffer, ...) in plain-JS fixtures; tsc already checks the TS files.
      "no-undef": "off",
      "prefer-const": "warn",
      "no-useless-escape": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Type-aware rules: an unhandled rejection exits the process (core/src/process-errors.ts). Tests are out of scope.
    files: ["packages/*/src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
);
