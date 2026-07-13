import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const iconsDir = path.join(rootDir, "src-tauri", "icons");
const sourcePath = path.join(iconsDir, "app-icon-macos.svg");
const targetPath = path.join(iconsDir, "icon.icns");
const outputDir = mkdtempSync(path.join(tmpdir(), "slisic-macos-icons-"));

try {
  execFileSync(
    process.platform === "win32" ? "bunx.exe" : "bunx",
    ["--no-install", "tauri", "icon", sourcePath, "--output", outputDir],
    {
      cwd: rootDir,
      stdio: "inherit",
    },
  );
  copyFileSync(path.join(outputDir, "icon.icns"), targetPath);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
