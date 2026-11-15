import { describe, expect, it } from "vitest";
import {
  discoveryQuestions, nextStep, previousStep, profileQuestions, questionOptions, toggleOption, type Selections,
} from "./onboardingModel";
import { onboardingCompletionKey, onboardingSurveyKey, OnboardingStore } from "./onboardingStore";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe("toggleOption", () => {
  it("multiSelectAddsAndRemoves", () => {
    let s: Selections = {};
    s = toggleOption(s, "roles", "editor");
    s = toggleOption(s, "roles", "student");
    expect(s.roles).toEqual(["editor", "student"]);
    s = toggleOption(s, "roles", "editor");
    expect(s.roles).toEqual(["student"]);
  });

  it("singleChoiceReplacesAndClears", () => {
    let s: Selections = {};
    s = toggleOption(s, "acquisitionSource", "google");
    s = toggleOption(s, "acquisitionSource", "github");
    expect(s.acquisitionSource).toEqual(["github"]);
    s = toggleOption(s, "acquisitionSource", "github");
    expect(s.acquisitionSource).toEqual([]);
  });

  it("noneIsExclusiveForPreviousEditors", () => {
    let s: Selections = {};
    s = toggleOption(s, "previousEditors", "capcut");
    s = toggleOption(s, "previousEditors", "imovie");
    s = toggleOption(s, "previousEditors", "none");
    expect(s.previousEditors).toEqual(["none"]);
    s = toggleOption(s, "previousEditors", "capcut");
    expect(s.previousEditors).toEqual(["capcut"]);
    s = toggleOption(s, "previousEditors", "none");
    s = toggleOption(s, "previousEditors", "none");
    expect(s.previousEditors).toEqual([]);
  });

  it("doesNotMutateTheInput", () => {
    const s: Selections = { roles: ["editor"] };
    toggleOption(s, "roles", "student");
    expect(s.roles).toEqual(["editor"]);
  });
});

describe("steps and questions", () => {
  it("clampAtBothEnds", () => {
    expect(nextStep("welcome")).toBe("discovery");
    expect(nextStep("account")).toBe("account");
    expect(previousStep("profile")).toBe("discovery");
    expect(previousStep("welcome")).toBe("welcome");
  });

  it("everyQuestionHasUniqueOptionIds", () => {
    for (const q of [...profileQuestions, ...discoveryQuestions]) {
      const ids = questionOptions[q].map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("OnboardingStore", () => {
  it("startsIncompleteUnlessAlreadySeen", () => {
    expect(new OnboardingStore({ storage: memoryStorage() }).isComplete()).toBe(false);
    expect(new OnboardingStore({ storage: memoryStorage({ [onboardingCompletionKey]: "true" }) }).isComplete()).toBe(true);
  });

  it("walksTheStepsAndSavesTheSurveyOnce", () => {
    const storage = memoryStorage();
    const store = new OnboardingStore({ storage });
    store.advance();
    store.toggle("acquisitionSource", "github");
    store.toggle("previousEditors", "capcut");
    store.advance();
    store.toggle("roles", "student");
    store.submitSurvey();
    expect(store.step()).toBe("account");
    expect(JSON.parse(storage.data[onboardingSurveyKey] ?? "{}")).toEqual({
      survey_version: 2, roles: ["student"], video_types: [], interests: [],
      acquisition_source: "github", previous_editors: ["capcut"],
    });
    store.goBack();
    store.toggle("roles", "editor");
    store.submitSurvey();
    expect(JSON.parse(storage.data[onboardingSurveyKey] ?? "{}").roles).toEqual(["student"]);
  });

  it("completeAndSkipPersist", () => {
    const storage = memoryStorage();
    const store = new OnboardingStore({ storage });
    store.skip();
    expect(store.isComplete()).toBe(true);
    expect(storage.data[onboardingCompletionKey]).toBe("true");
  });

  it("openingTheSampleCompletesOnSuccessAndFlagsFailure", async () => {
    const ok = new OnboardingStore({ storage: memoryStorage(), sampleAvailable: () => true, openSample: async () => true });
    await ok.openSampleProject();
    expect(ok.isComplete()).toBe(true);
    expect(ok.sampleState()).toBe("idle");

    const none = new OnboardingStore({ storage: memoryStorage(), sampleAvailable: () => true, openSample: async () => false });
    await none.openSampleProject();
    expect([none.isComplete(), none.sampleState()]).toEqual([false, "failed"]);

    const boom = new OnboardingStore({ storage: memoryStorage(), openSample: async () => { throw new Error("offline"); } });
    await boom.openSampleProject();
    expect(boom.sampleState()).toBe("failed");
    expect(boom.hasSample()).toBe(false);
  });

  it("skippingWhileASampleLoadsDropsItsResult", async () => {
    let release: (v: boolean) => void = () => undefined;
    const store = new OnboardingStore({ storage: memoryStorage(), openSample: () => new Promise<boolean>((r) => (release = r)) });
    const opening = store.openSampleProject();
    expect(store.sampleState()).toBe("loading");
    store.skip();
    release(false);
    await opening;
    expect([store.isComplete(), store.sampleState()]).toEqual([true, "idle"]);
  });
});
