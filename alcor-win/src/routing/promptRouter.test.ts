import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../platform/backend";
import { buildDecisionRequest, parseDecisionResponse } from "./decisionClient";
import { nearestChoice, parseDurationSeconds, routePrompt, routeQuestions, routeWithRules, type GenKind } from "./promptRouter";

const all: GenKind[] = ["video", "image", "speech", "sfx", "music"];
const ctx = { available: all, hasSelection: false };
const ok = (answers: unknown): HttpResponse => ({ status: 200, headers: [], bodyText: JSON.stringify({ answers }) });

describe("routeWithRules", () => {
  it("routes the lofi example to music on the timeline", () => {
    const r = routeWithRules("Generate a lovely, chill, lofi music for 2x speed video", ctx);
    expect(r).toMatchObject({ kind: "music", placement: "timeline", source: "rules" });
    expect(r.confidence).toBeGreaterThan(0.55);
  });
  it("does not count the destination video as the thing to make", () => {
    expect(routeWithRules("Generate a lovely, chill lofi track for my 2x speed video", ctx)).toMatchObject({ kind: "music", placement: "timeline" });
    expect(routeWithRules("a whoosh for the intro clip", ctx).kind).toBe("sfx");
    expect(routeWithRules("a video of a cat in the rain", ctx).kind).toBe("video");
  });
  it("recognises images, speech and sound effects", () => {
    expect(routeWithRules("a poster of a cat astronaut", ctx).kind).toBe("image");
    expect(routeWithRules("voiceover: welcome back to the channel", ctx).kind).toBe("speech");
    expect(routeWithRules("a big whoosh sound effect", ctx).kind).toBe("sfx");
    expect(routeWithRules("drone shot over cliffs at sunset", ctx).kind).toBe("video");
  });
  it("defaults to video with low confidence when nothing matches", () => {
    const r = routeWithRules("something nice", ctx);
    expect(r.kind).toBe("video");
    expect(r.confidence).toBeLessThan(0.55);
    expect(r.placement).toBe("library");
  });
  it("only picks available kinds and only uses the selection when there is one", () => {
    expect(routeWithRules("lofi music", { available: ["video", "image"], hasSelection: false }).kind).toBe("video");
    expect(routeWithRules("animate this", { available: all, hasSelection: true }).useSelection).toBe(true);
    expect(routeWithRules("animate this", ctx).useSelection).toBe(false);
  });
});

describe("routePrompt", () => {
  it("uses the decision model answers", async () => {
    let sent: HttpRequest | undefined;
    const fetch = async (req: HttpRequest) => {
      sent = req;
      return ok({
        kind: { type: "choice", choice: "music", confidence: 0.91, probabilities: {} },
        placement: { type: "choice", choice: "timeline", confidence: 0.7 },
      });
    };
    const r = await routePrompt("chill beat", ctx, "mercury-decide", fetch);
    expect(r).toEqual({ kind: "music", placement: "timeline", useSelection: false, confidence: 0.91, source: "model" });
    expect(sent?.url).toBe("https://api.inceptionlabs.ai/v1/decisions");
  });
  it("falls back to the rules when the request fails or answers out of range", async () => {
    const failing = async () => ({ status: 401, headers: [], bodyText: "bad key" });
    const r = await routePrompt("chill lofi music", ctx, "jev", failing);
    expect(r).toMatchObject({ kind: "music", source: "rules" });
    expect(r.fallbackReason).toContain("HTTP 401");
    const odd = async () => ok({ kind: { type: "choice", choice: "podcast", confidence: 0.9 } });
    expect((await routePrompt("chill lofi music", ctx, "gemini-decision-1", odd)).source).toBe("rules");
  });
  it("skips the network when only one kind is available", async () => {
    const r = await routePrompt("anything", { available: ["image"], hasSelection: false }, "jev", () => Promise.reject(new Error("no")));
    expect(r).toMatchObject({ kind: "image", confidence: 1, source: "rules" });
  });
});

describe("decision requests", () => {
  it("uses each vendor's endpoint, auth and input field", () => {
    const q = routeQuestions(ctx);
    const g = buildDecisionRequest("gemini-decision-1", "x", q);
    expect(g.auth).toEqual({ secret: "google", header: "x-goog-api-key", prefix: "" });
    expect(g.body).toMatchObject({ kind: "json", value: { model: "gemini-decision-1", input: "x" } });
    const j = buildDecisionRequest("jev", "x", q);
    expect(j.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(j.body).toMatchObject({ value: { model: "typesafe/jev-1.14", state: "x" } });
  });
  it("only asks about the selection when one exists", () => {
    expect(routeQuestions(ctx).use_selection).toBeUndefined();
    expect(routeQuestions({ ...ctx, hasSelection: true }).use_selection?.type).toBe("noul");
  });
  it("drops malformed answers", () => {
    const parsed = parseDecisionResponse(ok({ a: { type: "noul", noul: 0.8 }, b: { type: "choice" }, c: 3 }));
    expect(parsed).toEqual({ a: { type: "noul", noul: 0.8 } });
  });
});

describe("durations", () => {
  it("parses seconds and minutes", () => {
    expect(parseDurationSeconds("a 10s clip")).toBe(10);
    expect(parseDurationSeconds("2 minutes of jazz")).toBe(120);
    expect(parseDurationSeconds("lofi for 2x speed video")).toBeUndefined();
  });
  it("snaps to the nearest allowed value", () => {
    expect(nearestChoice([5, 10], 8)).toBe(10);
    expect(nearestChoice([5, 10], 6)).toBe(5);
    expect(nearestChoice([], 6)).toBeUndefined();
  });
});
