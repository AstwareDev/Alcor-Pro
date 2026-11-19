import type { DotLottie } from "@lottiefiles/dotlottie-web";
import type { SourceFrame } from "../preview/renderer";
import { lottieFrameIndex, lottieRasterSize } from "./lottieFrames";

const wasmUrl = new URL("../../node_modules/@lottiefiles/dotlottie-web/dist/dotlottie-player.wasm", import.meta.url).href;
const fallbackSize = 512;

/** One Lottie animation rendered by the ThorVG WASM player into an OffscreenCanvas; seeking is exact and synchronous. */
export class LottieSource {
  /** Reused for every call; `version` changes only when the canvas was redrawn. */
  private readonly frame: SourceFrame;
  private rendered = -1;

  private constructor(
    private readonly player: DotLottie,
    canvas: OffscreenCanvas,
    readonly totalFrames: number,
    readonly duration: number,
  ) {
    this.frame = { source: canvas, width: canvas.width, height: canvas.height, version: 0, premultiplied: true };
  }

  /** The player module and WASM are fetched on first use, so projects without Lottie never pay for them. */
  static async open(data: ArrayBuffer, size?: { width: number; height: number }): Promise<LottieSource | null> {
    const { DotLottie } = await import("@lottiefiles/dotlottie-web");
    DotLottie.setWasmUrl(wasmUrl);
    const raster = lottieRasterSize(size?.width ?? fallbackSize, size?.height ?? fallbackSize);
    const canvas = new OffscreenCanvas(raster.width, raster.height);
    const isZip = data.byteLength > 3 && new Uint8Array(data, 0, 2).every((b, i) => b === (i === 0 ? 0x50 : 0x4b));
    const player = new DotLottie({
      canvas,
      data: isZip ? data : new TextDecoder().decode(data),
      autoplay: false,
      useFrameInterpolation: false,
      renderConfig: { autoResize: false, freezeOnOffscreen: false, devicePixelRatio: 1 },
    });
    const loaded = await new Promise<boolean>((resolve) => {
      if (player.isLoaded) return resolve(true);
      player.addEventListener("load", () => resolve(true));
      player.addEventListener("loadError", () => resolve(false));
    });
    if (!loaded || !(player.totalFrames > 0) || !(player.duration > 0)) {
      player.destroy();
      return null;
    }
    return new LottieSource(player, canvas, player.totalFrames, player.duration);
  }

  get framerate(): number {
    return this.totalFrames / this.duration;
  }

  /** The animation at `sourceTime` seconds; redraws only when the Lottie frame changed. */
  frameAt(sourceTime: number): SourceFrame {
    const index = lottieFrameIndex(sourceTime, this.totalFrames, this.duration);
    if (index !== this.rendered) {
      this.player.setFrame(index);
      this.rendered = index;
      this.frame.version = (this.frame.version as number) + 1;
    }
    return this.frame;
  }

  dispose(): void {
    this.player.destroy();
  }
}

/** Fetches the animation file and opens it; null when it can't be read or parsed. */
export async function openLottieUrl(url: string, size?: { width: number; height: number }): Promise<LottieSource | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await LottieSource.open(await res.arrayBuffer(), size);
  } catch {
    return null;
  }
}
