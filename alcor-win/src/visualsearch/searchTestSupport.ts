// Fakes for the visual search tests (only imported by *.test.ts).
import { createSignal } from "solid-js";
import type { EmbedderSpec, VisualEmbedder, VisualModelState, VisualSearchModel } from "./visualEmbedder";
import type { SampledFrame } from "./frameSampler";

export const fakeSpec: EmbedderSpec = { model: "fake", version: 1, embeddingDim: 4, imageSize: 2, contextLength: 8 };

const words = ["red", "green", "blue", "dog"];

/** Text: unit vector of the first colour word it contains. Image: unit vector of the dominant channel of pixel 0 (alpha 255 = dog). */
export class FakeEmbedder implements VisualEmbedder {
  imageCalls = 0;
  textCalls = 0;
  constructor(readonly spec: EmbedderSpec = fakeSpec) {}

  async encodeImage(pixels: Uint8ClampedArray): Promise<Float32Array> {
    this.imageCalls++;
    const v = new Float32Array(4);
    if (pixels[3] === 7) v[3] = 1;
    else v[[pixels[0], pixels[1], pixels[2]].indexOf(Math.max(pixels[0] as number, pixels[1] as number, pixels[2] as number))] = 1;
    return v;
  }

  async encodeText(text: string): Promise<Float32Array> {
    this.textCalls++;
    const v = new Float32Array(4);
    const i = words.findIndex((w) => text.includes(w));
    if (i >= 0) v[i] = 1;
    else v[0] = 0.1; // unrelated text still has a (tiny) direction
    return v;
  }
}

export class FakeModel implements VisualSearchModel {
  private readonly stateSignal = createSignal<VisualModelState>({ kind: "unknown" });
  isEnabled = true;
  downloads = 0;
  constructor(public fake: FakeEmbedder = new FakeEmbedder(), private readonly installed = true) {}

  enabled = (): boolean => this.isEnabled;
  state = (): VisualModelState => this.stateSignal[0]();
  setState(s: VisualModelState): void {
    this.stateSignal[1](s);
  }
  downloadProgress = (): number => 0.5;
  embedder = (): VisualEmbedder | undefined => (this.state().kind === "ready" ? this.fake : undefined);
  async prepare(): Promise<void> {
    this.setState(this.installed ? { kind: "ready" } : { kind: "notInstalled" });
  }
  async download(): Promise<void> {
    this.downloads++;
    this.setState({ kind: "downloading" });
  }
}

/** A frame whose first pixel is the given colour. */
export function frame(time: number, rgb: [number, number, number], isNewShot: boolean, alpha = 255): SampledFrame {
  const pixels = new Uint8ClampedArray(2 * 2 * 4);
  pixels.set([...rgb, alpha], 0);
  return { time, isNewShot, pixels };
}
