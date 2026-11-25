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
);
