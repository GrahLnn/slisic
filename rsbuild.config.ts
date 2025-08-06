import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginBabel } from "@rsbuild/plugin-babel";

const isDev = process.env.NODE_ENV !== "production";
export default defineConfig({
  plugins: [
    pluginReact(),
    pluginBabel({
      include: /\.(?:jsx|tsx)$/,
      babelLoaderOptions(opts) {
        opts.plugins?.unshift("babel-plugin-react-compiler");
      },
    }),
  ],
  tools: {
    rspack: {
      watchOptions: {
        ignored: ["**/src-tauri/**"],
      },
    },
  },
  html: {
    tags: [
      ...(isDev
        ? [
            {
              tag: "script",
              attrs: {
                src: "https://unpkg.com/react-scan/dist/auto.global.js",
              },
              head: true,
            },
            {
              tag: "script",
              attrs: {
                src: "http://localhost:8097",
              },
              head: true,
            },
          ]
        : []),
    ],
  },
});
