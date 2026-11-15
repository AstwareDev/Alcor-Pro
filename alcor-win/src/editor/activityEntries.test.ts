import { describe, expect, it } from "vitest";
import { makeMediaAsset } from "../model";
import { projectActivityEntries, relativeTime } from "./activityEntries";

const gen = (id: string, createdAt: number | undefined, extra: Record<string, unknown> = {}) =>
  makeMediaAsset({
    id, url: "x", type: "video", name: id,
    generationInput: { prompt: "p", model: "unknown-model", duration: 5, aspectRatio: "16:9", ...(createdAt === undefined ? {} : { createdAt }), ...extra },
  });

describe("project activity", () => {
  it("lists only generated assets, newest first, undated last", () => {
    const plain = makeMediaAsset({ id: "imported", url: "x", type: "video", name: "i" });
    const list = projectActivityEntries([gen("old", 100), plain, gen("undated", undefined), gen("new", 500)]);
    expect(list.map((e) => e.id)).toEqual(["new", "old", "undated"]);
  });

  it("classifies failed, refunded and in-progress", () => {
    const failed = gen("f", 1);
    failed.generationStatus = { kind: "failed", message: "boom" };
    const busy = gen("b", 2);
    busy.generationStatus = { kind: "generating" };
    const refunded = gen("r", 3, { refundedCredits: 12 });
    const byId = Object.fromEntries(projectActivityEntries([failed, busy, refunded]).map((e) => [e.id, e]));
    expect(byId.f?.kind).toBe("failed");
    expect(byId.b?.kind).toBe("inProgress");
    expect(byId.r?.kind).toBe("refund");
    expect(byId.r?.cost).toBe("12 credits refunded");
  });

  it("uses recorded credits over the estimate", () => {
    expect(projectActivityEntries([gen("c", 1, { costCredits: 40 })])[0]?.cost).toBe("40 credits");
  });

  it("formats relative time", () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(relativeTime(undefined, now)).toBe("");
  });
});
