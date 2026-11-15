import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "docs/brand/alcor-app-icon.png");
const icons = path.join(root, "src-tauri/icons");
const publicDir = path.join(root, "public");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alcor-icons-"));

try {
  execFileSync(process.execPath, [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), "icon", source, "--output", temporary], {
    cwd: root,
    stdio: "inherit",
  });
  // This is a desktop app; do not add generated iOS/Android trees to the repository.
  const generated = fs.readdirSync(temporary).filter((name) => /\.(png|ico|icns)$/.test(name));
  const existing = fs.readdirSync(icons).filter((name) => /\.(png|ico|icns)$/.test(name));
  for (const name of existing) {
    if (!generated.includes(name)) throw new Error(`Missing replacement for existing icon: ${name}`);
  }
  for (const name of generated) fs.copyFileSync(path.join(temporary, name), path.join(icons, name));
  fs.mkdirSync(publicDir, { recursive: true });
  fs.copyFileSync(path.join(root, "docs/brand/alcor-app-icon.svg"), path.join(publicDir, "favicon.svg"));
  fs.copyFileSync(path.join(icons, "32x32.png"), path.join(publicDir, "favicon.png"));
  console.log(`Updated ${generated.length} desktop icons and both browser favicons.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
