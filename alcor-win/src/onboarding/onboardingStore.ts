// Port of Home/Onboarding/OnboardingStore.swift. Analytics and the account step's sign-in are not ported: the survey
// answers are only kept on this machine, and the last step offers the sample project (when there is one) or a plain start.
import { createSignal } from "solid-js";
import { nextStep, previousStep, toggleOption, type OnboardingQuestion, type OnboardingStep, type Selections } from "./onboardingModel";

/** Inherited from the pre-survey welcome overlay so existing installs stay onboarded. */
export const onboardingCompletionKey = "hasSeenWelcome";
export const onboardingSurveyKey = "onboardingSurvey";
const surveyVersion = 2;

export type OnboardingSampleState = "idle" | "loading" | "failed";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export interface OnboardingStoreOptions {
  storage?: KeyValueStorage | undefined;
  /** Whether there is a sample project to offer on the last step. */
  sampleAvailable?: () => boolean;
  /** Opens the first sample project; resolves false when there is none. */
  openSample?: () => Promise<boolean>;
}

export class OnboardingStore {
  private readonly storage: KeyValueStorage | undefined;
  private readonly openSample: (() => Promise<boolean>) | undefined;
  private readonly sampleAvailable: (() => boolean) | undefined;
  private readonly stepSignal = createSignal<OnboardingStep>("welcome");
  private readonly selectionsSignal = createSignal<Selections>({});
  private readonly sampleSignal = createSignal<OnboardingSampleState>("idle");
  private readonly completeSignal: ReturnType<typeof createSignal<boolean>>;
  private didCaptureSurvey = false;
  private sampleRun = 0;

  constructor(options: OnboardingStoreOptions = {}) {
    this.storage = "storage" in options ? options.storage : defaultStorage();
    this.openSample = options.openSample;
    this.sampleAvailable = options.sampleAvailable;
    this.completeSignal = createSignal(this.storage?.getItem(onboardingCompletionKey) === "true");
  }

  step = (): OnboardingStep => this.stepSignal[0]();
  isComplete = (): boolean => this.completeSignal[0]();
  sampleState = (): OnboardingSampleState => this.sampleSignal[0]();
  selection = (question: OnboardingQuestion): readonly string[] => this.selectionsSignal[0]()[question] ?? [];
  /** The last step offers a tutorial sample only when there is one to open. */
  hasSample = (): boolean => this.sampleAvailable?.() ?? false;

  advance(): void {
    this.stepSignal[1](nextStep(this.step()));
  }

  goBack(): void {
    this.stepSignal[1](previousStep(this.step()));
  }

  /** Records the survey once, no matter how often the user steps back. */
  submitSurvey(): void {
    if (!this.didCaptureSurvey) {
      this.didCaptureSurvey = true;
      const pick = (q: OnboardingQuestion): string[] => [...this.selection(q)].sort();
      this.storage?.setItem(
        onboardingSurveyKey,
        JSON.stringify({
          survey_version: surveyVersion,
          roles: pick("roles"),
          video_types: pick("videoTypes"),
          interests: pick("interests"),
          acquisition_source: pick("acquisitionSource")[0] ?? "not_provided",
          previous_editors: pick("previousEditors"),
        }),
      );
    }
    this.advance();
  }

  complete(): void {
    this.storage?.setItem(onboardingCompletionKey, "true");
    this.completeSignal[1](true);
  }

  skip(): void {
    this.sampleRun++;
    this.sampleSignal[1]("idle");
    this.complete();
  }

  toggle(question: OnboardingQuestion, optionId: string): void {
    this.selectionsSignal[1]((s) => toggleOption(s, question, optionId));
  }

  /** Owned here rather than by the overlay so onboarding still completes once Home is torn down. */
  async openSampleProject(): Promise<void> {
    if (!this.openSample || this.sampleState() === "loading") return;
    const run = ++this.sampleRun;
    this.sampleSignal[1]("loading");
    try {
      const opened = await this.openSample();
      if (run !== this.sampleRun) return;
      if (!opened) {
        this.sampleSignal[1]("failed");
        return;
      }
      this.sampleSignal[1]("idle");
      this.complete();
    } catch {
      if (run === this.sampleRun) this.sampleSignal[1]("failed");
    }
  }
}
