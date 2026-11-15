import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFolder } from "../../media/library";
import { makeFakeIo, type FakeIo } from "../../media/fakeIo";
import { setMediaIo } from "../../media/io";
import { mediaHooks } from "../../media/mediaHooks";
import { isMediaUnprocessable } from "../../media/library";
import { generationHooks } from "../../generation/generationState";
import { setImportDeps } from "./importTools";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

const project = "C:/Proj/Import.palmier";
const b64 = (s: string) => btoa(s);

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
  mediaHooks.parseSubtitleDuration = async () => 4;
});
afterEach(() => {
  setMediaIo(undefined);
  setImportDeps(undefined);
  delete mediaHooks.parseSubtitleDuration;
  delete generationHooks.checkpointRequired;
});

function openProject(h: ToolHarness): void {
  h.editor.projectPath = project;
}

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 100 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("import_media", () => {
  it("directoryImportAfterUserEditDoesNotBlock", async () => {
    io.addFile("/root/reference.mov", "fake-video");
    const h = new ToolHarness();
    createFolder(h.editor, "User Folder");
    expect((await h.runRaw("get_timeline")).isError).toBe(false);
    expect((await h.runRaw("get_media")).isError).toBe(false);
    const result = await h.runRaw("import_media", { source: { path: "/root" } });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    expect(h.editor.mediaAssets.length).toBe(1);
    const body = JSON.parse(ToolHarness.textOf(result)) as Json;
    expect(body).toMatchObject({ status: "ready", imported: 1, folders: 1 });
  });

  it("importBytesWritesFileAndRegistersAsset", async () => {
    const h = new ToolHarness();
    openProject(h);
    const result = await h.runRaw("import_media", {
      source: { bytes: b64("fake-png"), mimeType: "image/png" },
      name: "Imported Still",
    });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const asset = h.editor.mediaAssets[0];
    expect(asset.name).toBe("Imported Still");
    expect(asset.type).toBe("image");
    expect(io.has(asset.url)).toBe(true);
    expect(asset.url.startsWith(`${project}/media/imported-`)).toBe(true);
    expect(h.editor.doc.mediaManifest.entries[0].name).toBe("Imported Still");
    h.editor.undo();
    expect(h.editor.mediaAssets.length).toBe(0);
  });

  it("importBytesRejectsInvalidLottieBeforePackageCommit", async () => {
    const h = new ToolHarness();
    openProject(h);
    const result = await h.runRaw("import_media", { source: { bytes: b64("not-lottie"), mimeType: "application/json" } });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toBe("source.bytes is not a valid Lottie animation");
    expect(h.editor.mediaAssets.length).toBe(0);
    expect(io.has(project)).toBe(false);
  });

  it("importBytesValidatesInputs", async () => {
    const h = new ToolHarness();
    const noProject = await h.runRaw("import_media", { source: { bytes: b64("x"), mimeType: "image/png" } });
    expect(ToolHarness.textOf(noProject)).toBe("No project is open; cannot import bytes");
    openProject(h);
    const noMime = await h.runRaw("import_media", { source: { bytes: b64("x") } });
    expect(ToolHarness.textOf(noMime)).toBe("source.mimeType is required when source.bytes is set");
    const badMime = await h.runRaw("import_media", { source: { bytes: b64("x"), mimeType: "text/plain" } });
    expect(ToolHarness.textOf(badMime)).toContain("Unsupported mimeType 'text/plain'. Accepted: video/mp4");
    const badData = await h.runRaw("import_media", { source: { bytes: "!!!", mimeType: "image/png" } });
    expect(ToolHarness.textOf(badData)).toBe("source.bytes is not valid non-empty base64");
  });

  it("importPathReferencesSourceFile", async () => {
    io.addFile("/root/source.srt", "1\n00:00:00,000 --> 00:00:04,000\nHi\n");
    const h = new ToolHarness();
    openProject(h);
    let checkpoints = 0;
    generationHooks.checkpointRequired = () => { checkpoints += 1; };

    const result = await h.runRaw("import_media", { source: { path: "/root/source.srt" }, name: "Linked Subs" });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const body = JSON.parse(ToolHarness.textOf(result)) as Json;
    expect(body.status).toBe("ready");
    expect(typeof body.mediaRef).toBe("string");
    const asset = h.editor.mediaAssets[0];
    expect(asset.name).toBe("Linked Subs");
    expect(asset.type).toBe("subtitle");
    expect(asset.url).toBe("/root/source.srt");
    expect(asset.duration).toBe(4);
    expect(asset.generationStatus).toEqual({ kind: "none" });
    expect(asset.importInput).toBeUndefined();
    expect(h.editor.doc.mediaManifest.entries[0].source).toEqual({ external: { absolutePath: "/root/source.srt" } });
    expect(checkpoints).toBe(1);
  });

  it("importPathFilesIntoFolderCreatingIt", async () => {
    io.addFile("/root/a.srt", "x");
    const h = new ToolHarness();
    openProject(h);
    await h.runOK("import_media", { source: { path: "/root/a.srt" }, folder: "Refs/Subs" });
    const json = await h.runOK("get_media");
    expect(json.folders).toEqual(["Refs", "Refs/Subs"]);
    expect((json.assets as Json[])[0].folder).toBe("Refs/Subs");
  });

  it("importPathRejectsUnreadableMedia", async () => {
    io.addFile("/root/source.png", "fake-png");
    const h = new ToolHarness();
    openProject(h);
    const result = await h.runRaw("import_media", { source: { path: "/root/source.png" }, name: "Unreadable Still" });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("Could not read media file");
    const asset = h.editor.mediaAssets[0];
    expect(asset.generationStatus).toEqual({ kind: "none" });
    expect(asset.url).toBe("/root/source.png");
    expect(asset.importInput).toBeUndefined();
    expect(isMediaUnprocessable(h.editor, asset.id)).toBe(true);
  });

  it("importPathErrors", async () => {
    io.addFile("/root/notes.txt", "x");
    io.addFile("/root/anim.json", "not lottie");
    io.addDir("/root/empty");
    const h = new ToolHarness();
    expect(ToolHarness.textOf(await h.runRaw("import_media", { source: { path: "/nope.mov" } }))).toBe("File not found: /nope.mov");
    expect(ToolHarness.textOf(await h.runRaw("import_media", { source: { path: "/root/notes.txt" } }))).toContain("Unsupported file extension '.txt'");
    expect(ToolHarness.textOf(await h.runRaw("import_media", { source: { path: "/root/anim.json" } }))).toBe("Unsupported Lottie file: anim.json");
    io.addFile("/root/a.mov", "x");
    expect(ToolHarness.textOf(await h.runRaw("import_media", { source: { path: "/root/a.mov" } }))).toBe("No project is open; cannot import from path");
    expect(ToolHarness.textOf(await h.runRaw("import_media", { source: { path: "/root/empty" } }))).toBe("No supported media found in folder: /root/empty");
  });

  it("sourceMustSetExactlyOneKey", async () => {
    const h = new ToolHarness();
    expect(ToolHarness.textOf(await h.runRaw("import_media", {}))).toBe("Missing required 'source' object");
    expect(ToolHarness.textOf(await h.runRaw("import_media", { source: {} }))).toBe("source must set exactly one of 'url', 'path', 'bytes', or 'matte' (got 0)");
    expect(ToolHarness.textOf(await h.runRaw("import_media", { source: { path: "/a.mov", url: "https://x.test/a.mp4" } }))).toContain("(got 2)");
    expect((await h.runRaw("import_media", { source: { path: "/a.mov" }, bogus: 1 })).isError).toBe(true);
    expect((await h.runRaw("import_media", { source: { pth: "/a.mov" } })).isError).toBe(true);
  });

  it("urlImportValidatesTheUrl", async () => {
    const h = new ToolHarness();
    openProject(h);
    const run = async (source: Json) => ToolHarness.textOf(await h.runRaw("import_media", { source }));
    expect(await run({ url: "not a url" })).toBe("source.url is not a valid URL");
    expect(await run({ url: "http://x.test/a.mp4" })).toBe("source.url must use https");
    expect(await run({ url: "https://user:pw@x.test/a.mp4" })).toBe("source.url must not embed credentials");
    expect(await run({ url: "https://x.test/download?id=1" })).toContain("Cannot infer media type from URL extension (none)");
    expect(await run({ url: "https://x.test/a.xyz" })).toContain("URL extension .xyz");
    expect(await run({ url: "https://x.test/a", mimeType: "text/plain" })).toContain("Unsupported mimeType 'text/plain'");
    expect(h.editor.mediaAssets.length).toBe(0);
  });

  it("urlImportCreatesPlaceholderThenDownloadsInBackground", async () => {
    const h = new ToolHarness();
    openProject(h);
    const requested: string[] = [];
    setImportDeps({
      download: async (url, dest) => {
        requested.push(url);
        await io.writeBytes(dest, new TextEncoder().encode("1\n00:00:00,000 --> 00:00:04,000\nHi\n"));
      },
      cancel: async () => true,
    });
    const body = await h.runOK("import_media", { source: { url: "https://x.test/path/Captions%20One.srt?sig=1" } });
    expect(body.status).toBe("downloading");
    expect(body.type).toBe("subtitle");
    const id = h.editor.mediaAssets[0].id;
    expect(h.editor.mediaAssets[0].name).toBe("Captions One");
    expect(body.note).toContain("Poll get_media with ids:[");
    await settle(() => h.editor.mediaAssets[0].generationStatus.kind === "none" && h.editor.mediaAssets[0].importInput === undefined);
    const asset = h.editor.mediaAssets[0];
    expect(requested).toEqual(["https://x.test/path/Captions%20One.srt?sig=1"]);
    expect(asset.generationStatus).toEqual({ kind: "none" });
    expect(asset.importInput).toBeUndefined();
    expect(asset.url.startsWith(`${project}/media/imported-${id.slice(0, 8)}.srt`)).toBe(true);
    expect(io.has(asset.url)).toBe(true);
    const polled = await h.runOK("get_media", { ids: [id] });
    expect((polled.assets as Json[])[0].generationStatus).toBeUndefined();
  });

  it("urlImportReportsDownloadFailureThroughGetMedia", async () => {
    const h = new ToolHarness();
    openProject(h);
    setImportDeps({
      download: async () => { throw new Error("server returned HTTP 404"); },
      cancel: async () => true,
    });
    await h.runOK("import_media", { source: { url: "https://x.test/a.mp4" } });
    const id = h.editor.mediaAssets[0].id;
    await settle(() => h.editor.mediaAssets[0].generationStatus.kind === "failed");
    const polled = await h.runOK("get_media", { ids: [id] });
    expect((polled.assets as Json[])[0].generationStatus).toBe("failed: server returned HTTP 404");
  });

  it("matteCreatesSolidColorPngAsset", async () => {
    const h = new ToolHarness();
    openProject(h);
    const result = await h.runOK("import_media", { source: { matte: { hex: "#FF0000", aspectRatio: "1:1" } }, name: "Red" });
    expect(result).toMatchObject({ name: "Red", type: "image", status: "ready" });
    const asset = h.editor.mediaAssets[0];
    expect(asset.url.startsWith(`${project}/media/matte-`)).toBe(true);
    const png = await io.readAll(asset.url);
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([h.editor.timeline.height, h.editor.timeline.height]);
  });

  it("matteValidatesInputs", async () => {
    const h = new ToolHarness();
    const run = async (matte: Json) => ToolHarness.textOf(await h.runRaw("import_media", { source: { matte } }));
    expect(await run({ hex: "#000000" })).toBe("Open a project before creating a matte.");
    openProject(h);
    expect(await run({})).toBe("source.matte requires 'hex'.");
    expect(await run({ hex: "#000", aspectRatio: "5:4" })).toBe("source.matte: unknown aspectRatio '5:4'. Use one of Project, 16:9, 9:16, 1:1, 4:3, 9:14, 2.4:1.");
    expect(await run({ hex: "zzz" })).toBe("Couldn't render matte image.");
    expect((await h.runRaw("import_media", { source: { matte: { hex: "#000", extra: 1 } } })).isError).toBe(true);
  });
});
