import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name));
const text = (name) => read(name).toString("utf8");
const pkg = JSON.parse(text("package.json"));
const config = JSON.parse(text("src-tauri/tauri.conf.json"));
const cargo = text("src-tauri/Cargo.toml");

function cargoValue(section, key) {
  const block = cargo.split(`[${section}]`)[1]?.split(/\r?\n\[/)[0];
  const value = block?.match(new RegExp(`^${key} = "([^"]+)"`, "m"))?.[1];
  assert.ok(value, `Missing Cargo ${section}.${key}`);
  return value;
}

test("Alcor Pro name, package names, crate and versions stay consistent", () => {
  assert.equal(config.productName, "Alcor Pro");
  for (const window of config.app.windows) assert.equal(window.title, "Alcor Pro");
  assert.equal(pkg.name, "alcor-pro");
  assert.equal(cargoValue("package", "name"), pkg.name);
  assert.equal(cargoValue("lib", "name"), "alcor_pro_lib");
  assert.equal(cargoValue("package", "version"), pkg.version);
  assert.equal(config.version, pkg.version);
  assert.equal(pkg.private, true);
  assert.match(pkg.description, /^Alcor Pro/);
  assert.match(cargoValue("package", "description"), /^Alcor Pro/);
  assert.equal(cargoValue("package", "license"), pkg.license);
  assert.equal(text("src-tauri/Cargo.lock").match(/name = "alcor-pro"\r?\nversion = "([^"]+)"/)?.[1], pkg.version);
});

test("rebranding preserves application ID and stored credential namespace", () => {
  assert.equal(config.identifier, "io.alcor.pro");
  assert.match(text("src-tauri/src/secrets.rs"), /const SERVICE: &str = "AlcorPro";/);
  assert.match(text("src-tauri/src/rename_migration.rs"), /const NEW_IDENTIFIER: &str = "io\.alcor\.pro";/);
});

test("browser metadata names Alcor Pro and references generated favicons", () => {
  const html = text("index.html");
  assert.match(html, /<title>Alcor Pro<\/title>/);
  assert.match(html, /name="application-name" content="Alcor Pro"/);
  for (const name of ["favicon.svg", "favicon.png"]) {
    assert.ok(html.includes(`href="/${name}"`));
    assert.ok(fs.existsSync(path.join(root, "public", name)));
  }
  assert.deepEqual(read("public/favicon.png"), read("src-tauri/icons/32x32.png"));
  assert.deepEqual(read("public/favicon.svg"), read("docs/brand/alcor-app-icon.svg"));
});

const dimensions = {
  "32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512,
  "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150, "Square284x284Logo.png": 284, "Square310x310Logo.png": 310, "StoreLogo.png": 50,
};
for (const [name, size] of Object.entries(dimensions)) {
  test(`${name} is a correctly sized RGBA PNG`, () => {
    const bytes = read(`src-tauri/icons/${name}`);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
    assert.equal(bytes[24], 8);
    assert.equal(bytes[25], 6);
  });
}

test("Windows ICO contains small and large application icons", () => {
  const bytes = read("src-tauri/icons/icon.ico");
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  const widths = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    widths.push(bytes[offset] || 256);
    assert.equal(bytes[offset], bytes[offset + 1]);
    const length = bytes.readUInt32LE(offset + 8), start = bytes.readUInt32LE(offset + 12);
    assert.ok(start >= 6 + count * 16 && start + length <= bytes.length);
  }
  for (const size of [16, 32, 48, 256]) assert.ok(widths.includes(size), `Missing ICO size ${size}`);
});

test("all configured bundle icons and README brand images exist", () => {
  for (const icon of config.bundle.icon) assert.ok(fs.existsSync(path.join(root, "src-tauri", icon)), icon);
  const icns = read("src-tauri/icons/icon.icns");
  assert.equal(icns.subarray(0, 4).toString(), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const readme = fs.readFileSync(path.join(root, "../README.md"), "utf8");
  assert.match(readme, /^# Alcor Pro/m);
  for (const asset of ["brand/alcor-logo.svg", "brand/alcor-logo-light.svg", "cover/alcor-pro-cover.png"]) {
    assert.ok(readme.includes(`alcor-win/docs/${asset}`));
    assert.ok(fs.existsSync(path.join(root, "docs", asset)));
  }
});
