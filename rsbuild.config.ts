import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSass } from "@rsbuild/plugin-sass";

const isDev = process.env.NODE_ENV !== "production";
const disableReactScan = process.env.PUBLIC_DISABLE_REACT_SCAN === "1";
export default defineConfig({
  plugins: [
    pluginReact(),
    pluginSass(),
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
        ignored: ["**/src-tauri/**", "**/.bg-shell/**", "**/.tauri/**"],
      },
    },
  },
  html: {
    tags: isDev && !disableReactScan
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
      : [],
  },
});
