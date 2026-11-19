import { describe, expect, it } from "vitest";
import { tourSeenKey, TourController, type TourHost } from "./tourController";
import { calloutMargin, calloutPosition, calloutWidth, hostPanel, tourSelector, tourSpotlightCount, tourSteps, type TourPanel } from "./tourSteps";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

function setup(stored: Record<string, string> = {}) {
  const revealed: TourPanel[] = [];
  const host: TourHost = { reveal: (p) => void revealed.push(p) };
  const storage = memoryStorage(stored);
  return { tour: new TourController(host, storage), revealed, storage };
}

describe("tour steps", () => {
  it("opensWithAnIntroClosesWithAnOutroAndSpotlightsEverythingBetween", () => {
    expect(tourSteps[0]?.kind).toBe("intro");
    expect(tourSteps.at(-1)?.kind).toBe("outro");
    expect(tourSteps.slice(1, -1).every((s) => s.kind === "spotlight" && s.target !== undefined)).toBe(true);
    expect(tourSpotlightCount).toBe(tourSteps.length - 2);
  });

  it("coversTheMainPanelsPromptBarAndExport", () => {
    const targets = tourSteps.map((s) => s.target);
    for (const t of ["media", "preview", "timeline", "inspector", "promptBar", "export"]) expect(targets).toContain(t);
  });

  it("everyTargetHasASelectorAndOnlyPanelsNeedRevealing", () => {
    for (const step of tourSteps) if (step.target) expect(tourSelector(step.target)).toMatch(/^\[data-(panel|tour)="/);
    expect(hostPanel("promptBar")).toBe("timeline");
    expect(hostPanel("export")).toBeUndefined();
  });
});

describe("TourController", () => {
  it("walksForwardAndBackAndStopsAtTheStart", () => {
    const { tour } = setup();
    expect(tour.active()).toBe(false);
    tour.start();
    expect(tour.index()).toBe(0);
    tour.back();
    expect(tour.index()).toBe(0);
    tour.next();
    tour.next();
    expect(tour.index()).toBe(2);
    tour.back();
    expect(tour.index()).toBe(1);
  });

  it("endsAfterTheLastStep", () => {
    const { tour } = setup();
    tour.start();
    for (let i = 0; i < tourSteps.length - 1; i++) tour.next();
    expect(tour.step()?.kind).toBe("outro");
    tour.next();
    expect(tour.active()).toBe(false);
    expect(tour.step()).toBeNull();
  });

  it("skipEndsFromAnyStepAndNextBackAreNoOpsWhenIdle", () => {
    const { tour } = setup();
    tour.next();
    tour.back();
    expect(tour.active()).toBe(false);
    tour.start();
    tour.next();
    tour.end();
    expect(tour.active()).toBe(false);
  });

  it("revealsTheHostPanelBeforeEachSpotlight", () => {
    const { tour, revealed } = setup();
    tour.start();
    expect(revealed).toEqual([]);
    tour.next();
    expect(revealed).toEqual(["media"]);
    for (let i = 0; i < 4; i++) tour.next();
    expect(tour.step()?.target).toBe("inspector");
    expect(revealed.at(-1)).toBe("inspector");
    tour.next();
    expect(tour.step()?.target).toBe("export");
    expect(revealed.at(-1)).toBe("inspector");
  });

  it("autoStartsOnlyOnce", () => {
    const { tour, storage } = setup();
    expect(tour.startIfFirstRun()).toBe(true);
    expect(tour.active()).toBe(true);
    expect(storage.getItem(tourSeenKey)).toBe("true");
    tour.end();
    expect(tour.startIfFirstRun()).toBe(false);
    expect(tour.active()).toBe(false);
    expect(setup({ [tourSeenKey]: "true" }).tour.startIfFirstRun()).toBe(false);
  });

  it("canBeReopenedByHandAfterBeingSeen", () => {
    const { tour } = setup({ [tourSeenKey]: "true" });
    tour.start();
    expect(tour.index()).toBe(0);
  });

  it("worksWithoutStorage", () => {
    const tour = new TourController({ reveal: () => undefined }, null);
    expect(tour.startIfFirstRun()).toBe(true);
  });
});

describe("calloutPosition", () => {
  const size = { width: 1600, height: 900 };

  it("centresWhenThereIsNoFrame", () => {
    expect(calloutPosition(null, size)).toEqual({ x: 800, y: 450 });
  });

  it("prefersTheRightOfTheFrame", () => {
    const p = calloutPosition({ x: 100, y: 300, width: 200, height: 200 }, size);
    expect(p.x).toBe(300 + calloutMargin + calloutWidth / 2);
    expect(p.y).toBe(400);
  });

  it("fallsBackToTheLeft", () => {
    const p = calloutPosition({ x: 1000, y: 300, width: 600, height: 200 }, size);
    expect(p.x).toBe(1000 - calloutMargin - calloutWidth / 2);
  });

  it("goesAboveOrBelowForAFullWidthFrameAndStaysOnScreen", () => {
    const below = calloutPosition({ x: 0, y: 0, width: 1600, height: 80 }, size);
    expect(below.y).toBeGreaterThan(80);
    const above = calloutPosition({ x: 0, y: 600, width: 1600, height: 300 }, size);
    expect(above.y).toBeLessThan(600);
    for (const p of [below, above]) {
      expect(p.x - calloutWidth / 2).toBeGreaterThanOrEqual(calloutMargin);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(size.height);
    }
  });

  it("clampsHorizontallyOnNarrowViewports", () => {
    const p = calloutPosition({ x: 0, y: 500, width: 400, height: 380 }, { width: 400, height: 900 });
    expect(p.x).toBe(200);
  });
});
