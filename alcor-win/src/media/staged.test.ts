import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../editor/editor";
import { makeFakeIo, type FakeIo } from "./fakeIo";
import { setMediaIo } from "./io";
import { commitStagedProjectMedia, FileTooLargeError, importPastedImageData } from "./library";

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
});
afterEach(() => setMediaIo(undefined));

describe("commitStagedProjectMedia", () => {
  it("installs into <project>/media, replacing an existing file, and removes the staged file", async () => {
    const e = new Editor();
    e.projectPath = "C:/Proj/My.palmier";
    io.addFile("/tmp/stage.png", "new");
    io.addFile("C:/Proj/My.palmier/media/pasted.png", "old");
    const dest = await commitStagedProjectMedia(e, "/tmp/stage.png", "pasted.png");
    expect(dest).toBe("C:/Proj/My.palmier/media/pasted.png");
    expect(new TextDecoder().decode(await io.readAll(dest))).toBe("new");
    expect(io.has("/tmp/stage.png")).toBe(false);
  });

  it("without a project the file lands in the temp directory", async () => {
    const e = new Editor();
    io.addFile("/tmp/stage-1.png", "x");
    const dest = await commitStagedProjectMedia(e, "/tmp/stage-1.png", "final.png");
    expect(dest).toBe("/tmp/final.png");
    expect(io.has("/tmp/stage-1.png")).toBe(false);
  });

  it("refuses files over maxBytes and still removes the staged file", async () => {
    const e = new Editor();
    e.projectPath = "C:/Proj/My.palmier";
    io.addFile("/tmp/big.png", new Uint8Array(100));
    await expect(commitStagedProjectMedia(e, "/tmp/big.png", "big.png", { maxBytes: 10 })).rejects.toBeInstanceOf(FileTooLargeError);
    expect(io.has("/tmp/big.png")).toBe(false);
    expect(io.has("C:/Proj/My.palmier/media/big.png")).toBe(false);
  });

  it("waits for an in-progress save before touching the package", async () => {
    const e = new Editor();
    e.projectPath = "C:/Proj/My.palmier";
    io.addFile("/tmp/s.png", "x");
    const { projectPackageCoordinator } = await import("./libraryCore");
    const coordinator = projectPackageCoordinator(e);
    coordinator.saveStarted();
    let done = false;
    const p = commitStagedProjectMedia(e, "/tmp/s.png", "s.png").then((d) => {
      done = true;
      return d;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    expect(io.has("C:/Proj/My.palmier/media/s.png")).toBe(false);
    coordinator.saveFinished(true);
    expect(await p).toBe("C:/Proj/My.palmier/media/s.png");
  });
});

describe("importPastedImageData", () => {
  it("writes pasted-XXXXXXXX.<ext> into the project media folder", async () => {
    const e = new Editor();
    e.projectPath = "C:/Proj/My.palmier";
    // finalize would probe through fetch; the asset is created either way
    const asset = await importPastedImageData(e, Uint8Array.of(1, 2, 3), "tiff");
    expect(asset?.url).toMatch(/^C:\/Proj\/My\.palmier\/media\/pasted-[0-9A-F]{8}\.tiff$/);
    expect(asset?.type).toBe("image");
    expect(e.mediaAssets.length).toBe(1);
  });
});
