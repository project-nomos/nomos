import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/index.ts",
  platform: "node",
  fixedExtension: false,
  env: {
    NODE_ENV: "production",
  },
  banner: "#!/usr/bin/env node",
});
