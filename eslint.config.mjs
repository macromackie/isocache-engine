import { strictTypeScript } from "@macromackie/swift-factory-toolkit/config/eslint";
export default strictTypeScript({
  root: import.meta.dirname,
  files: ["src/**/*.ts", "test/**/*.ts", "examples/**/*.ts", "scripts/**/*.ts"],
});
