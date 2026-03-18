import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const binariesDir = path.join(rootDir, "src-tauri", "binaries");
const cacheDir = path.join(rootDir, ".tmp", "bun-runtime");
const downloadDir = path.join(cacheDir, "downloads");
const extractDir = path.join(cacheDir, "extracted");
const bunVersion = execFileSync("bun", ["--version"], {
  cwd: rootDir,
  encoding: "utf8",
}).trim();

const targets = [
  {
    label: "windows-x64",
    archiveName: `bun-windows-x64-${bunVersion}.zip`,
    sourceBinaryPath: path.join("bun-windows-x64", "bun.exe"),
    sourceUrl: `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-windows-x64.zip`,
    targetTriple: "x86_64-pc-windows-msvc",
    extension: ".exe",
  },
  {
    label: "linux-x64",
    archiveName: `bun-linux-x64-${bunVersion}.zip`,
    sourceBinaryPath: path.join("bun-linux-x64", "bun"),
    sourceUrl: `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-x64.zip`,
    targetTriple: "x86_64-unknown-linux-gnu",
    extension: "",
  },
  {
    label: "macos-arm64",
    archiveName: `bun-darwin-aarch64-${bunVersion}.zip`,
    sourceBinaryPath: path.join("bun-darwin-aarch64", "bun"),
    sourceUrl: `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-aarch64.zip`,
    targetTriple: "aarch64-apple-darwin",
    extension: "",
  },
  {
    label: "macos-x64",
    archiveName: `bun-darwin-x64-${bunVersion}.zip`,
    sourceBinaryPath: path.join("bun-darwin-x64", "bun"),
    sourceUrl: `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-x64.zip`,
    targetTriple: "x86_64-apple-darwin",
    extension: "",
  },
];

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    ...options,
  });
}

async function downloadFile(url, destination) {
  if (existsSync(destination)) {
    return;
  }

  console.log(`Downloading ${path.basename(destination)}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, Buffer.from(arrayBuffer));
}

function extractArchive(archivePath, targetDir) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  run("tar", ["-xf", archivePath, "-C", targetDir]);
}

async function prepareSourceBinary(target) {
  const archivePath = path.join(downloadDir, target.archiveName);
  await downloadFile(target.sourceUrl, archivePath);

  const targetExtractDir = path.join(extractDir, target.label);
  const sourceBinary = path.join(targetExtractDir, target.sourceBinaryPath);
  if (!existsSync(sourceBinary)) {
    console.log(`Extracting ${target.archiveName}...`);
    extractArchive(archivePath, targetExtractDir);
  }

  return sourceBinary;
}

async function buildRuntimeBinary(target) {
  mkdirSync(binariesDir, { recursive: true });
  const outputPath = path.join(
    binariesDir,
    `bun-runtime-${target.targetTriple}${target.extension}`,
  );

  const sourceBinary = await prepareSourceBinary(target);
  rmSync(outputPath, { force: true });
  copyFileSync(sourceBinary, outputPath);

  if (!outputPath.endsWith(".exe")) {
    chmodSync(outputPath, 0o755);
  }

  console.log(
    `Prepared Bun runtime for ${target.label} -> ${path.basename(outputPath)}`,
  );
}

for (const target of targets) {
  await buildRuntimeBinary(target);
}
