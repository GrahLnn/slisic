import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  tools: {
    rspack: {
      watchOptions: {
        ignored: ["**/src-tauri/**"],
      },
    },
  },
  html: {
    tags: [
      {
        tag: "script",
        attrs: {
          src: "https://unpkg.com/react-scan/dist/auto.global.js",
        },
        head: true,
      },
    ],
  },
});
