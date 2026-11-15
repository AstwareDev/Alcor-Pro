// Port of Home/Onboarding/OnboardingModels.swift and the pure parts of OnboardingStore.swift.

export type OnboardingStep = "welcome" | "discovery" | "profile" | "account";
export const onboardingSteps: readonly OnboardingStep[] = ["welcome", "discovery", "profile", "account"];

export type OnboardingQuestion = "roles" | "videoTypes" | "interests" | "acquisitionSource" | "previousEditors";

export interface OnboardingOption {
  id: string;
  label: string;
}

const other: OnboardingOption = { id: "other", label: "Other" };

export const profileQuestions: readonly OnboardingQuestion[] = ["roles", "videoTypes", "interests"];
export const discoveryQuestions: readonly OnboardingQuestion[] = ["acquisitionSource", "previousEditors"];

export const questionTitles: Record<OnboardingQuestion, string> = {
  videoTypes: "What do you make?",
  roles: "What best describes your role?",
  interests: "What interests you most about Alcor Pro?",
  acquisitionSource: "How did you find Alcor Pro?",
  previousEditors: "Which editors did you use before?",
};

export const questionOptions: Record<OnboardingQuestion, readonly OnboardingOption[]> = {
  videoTypes: [
    { id: "short_form", label: "Short-form and social" },
    { id: "youtube", label: "YouTube" },
    { id: "podcast", label: "Podcast" },
    { id: "ai_videos", label: "AI videos" },
    { id: "advertising", label: "Ads and branded content" },
    { id: "product_demos", label: "Product demos" },
    { id: "education", label: "Education and tutorials" },
    other,
  ],
  roles: [
    { id: "editor", label: "Video editor" },
    { id: "filmmaker", label: "Filmmaker" },
    { id: "hobbyist", label: "Hobbyist" },
    { id: "founder", label: "Founder" },
    { id: "designer", label: "Designer" },
    { id: "content_creator", label: "Content creator" },
    { id: "student", label: "Student" },
    { id: "marketer", label: "Marketer" },
    other,
  ],
  interests: [
    { id: "ai_generation", label: "AI videos" },
    { id: "ai_transcription", label: "AI transcription" },
    { id: "agent_editing", label: "Agentic editing" },
    { id: "external_agents", label: "Integration with your own agent" },
    { id: "video_automation", label: "Video automation" },
  ],
  acquisitionSource: [
    { id: "google", label: "Google" },
    { id: "github", label: "GitHub" },
    { id: "x", label: "X" },
    { id: "instagram", label: "Instagram" },
    { id: "youtube", label: "YouTube" },
    { id: "hacker_news", label: "Hacker News" },
    { id: "word_of_mouth", label: "Friend or colleague" },
    other,
  ],
  previousEditors: [
    { id: "premiere_pro", label: "Adobe Premiere Pro" },
    { id: "davinci_resolve", label: "DaVinci Resolve" },
    { id: "final_cut_pro", label: "Final Cut Pro" },
    { id: "capcut", label: "CapCut" },
    { id: "instagram_edits", label: "Instagram Edits" },
    { id: "imovie", label: "iMovie" },
    { id: "descript", label: "Descript" },
    { id: "none", label: "None" },
    other,
  ],
};

export const allowsMultipleSelection = (question: OnboardingQuestion): boolean => question !== "acquisitionSource";

/** Choosing one of these clears every other pick (and vice versa). */
export const exclusiveOptionIds = (question: OnboardingQuestion): readonly string[] => (question === "previousEditors" ? ["none"] : []);

export type Selections = Partial<Record<OnboardingQuestion, readonly string[]>>;

/** `OnboardingStore.toggle`: single choice, exclusive options, or a plain multi-select. Returns a new selection map. */
export function toggleOption(selections: Selections, question: OnboardingQuestion, optionId: string): Selections {
  const current = new Set(selections[question] ?? []);
  const set = (ids: Iterable<string>): Selections => ({ ...selections, [question]: [...ids] });

  if (!allowsMultipleSelection(question)) return set(current.has(optionId) ? [] : [optionId]);

  const exclusive = exclusiveOptionIds(question);
  if (exclusive.includes(optionId)) return set(current.size === 1 && current.has(optionId) ? [] : [optionId]);

  for (const id of exclusive) current.delete(id);
  if (!current.delete(optionId)) current.add(optionId);
  return set(current);
}

export const nextStep = (step: OnboardingStep): OnboardingStep =>
  onboardingSteps[Math.min(onboardingSteps.indexOf(step) + 1, onboardingSteps.length - 1)] as OnboardingStep;

export const previousStep = (step: OnboardingStep): OnboardingStep =>
  onboardingSteps[Math.max(onboardingSteps.indexOf(step) - 1, 0)] as OnboardingStep;
