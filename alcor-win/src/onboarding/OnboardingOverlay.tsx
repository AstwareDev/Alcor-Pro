// Port of Home/Onboarding/OnboardingOverlay.swift + OnboardingSteps.swift: welcome, two questionnaires, and a last step.
import { For, Show, type JSX } from "solid-js";
import { CapsuleButton } from "../ui/CapsuleButton";
import {
  allowsMultipleSelection, discoveryQuestions, profileQuestions, questionOptions, questionTitles, type OnboardingQuestion,
} from "./onboardingModel";
import type { OnboardingStore } from "./onboardingStore";
import "./onboarding.css";

function Title(props: { children: JSX.Element }) {
  return <h2 class="ob-title">{props.children}</h2>;
}

function Detail(props: { children: JSX.Element }) {
  return <p class="ob-detail">{props.children}</p>;
}

function Questionnaire(props: { onboarding: OnboardingStore; title: string; questions: readonly OnboardingQuestion[] }) {
  return (
    <div class="ob-step">
      <Title>{props.title}</Title>
      <For each={props.questions}>
        {(question) => (
          <section class="ob-question">
            <h3 class="ob-question-title">{questionTitles[question]}</h3>
            <div class="ob-options" role={allowsMultipleSelection(question) ? "group" : "radiogroup"}>
              <For each={questionOptions[question]}>
                {(option) => {
                  const selected = () => props.onboarding.selection(question).includes(option.id);
                  return (
                    <CapsuleButton
                      size="small"
                      variant={selected() ? "prominent" : "secondary"}
                      {...(selected() ? {} : { fill: "var(--onboarding-secondary-fill)" })}
                      aria-pressed={selected()}
                      onClick={() => props.onboarding.toggle(question, option.id)}
                    >
                      {option.label}
                    </CapsuleButton>
                  );
                }}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}

export function OnboardingOverlay(props: { onboarding: OnboardingStore }) {
  const ob = () => props.onboarding;
  const loading = () => ob().sampleState() === "loading";
  const secondaryFill = "var(--onboarding-secondary-fill)";

  return (
    <div class="ob-backdrop" role="dialog" aria-modal="true" aria-label="Welcome to Alcor Pro">
      <div class="ob-card">
        <div class="ob-content" classList={{ scrolls: ob().step() === "discovery" || ob().step() === "account" }}>
          <Show when={ob().step() === "welcome"}>
            <div class="ob-step">
              <Title>Welcome to Alcor Pro</Title>
              <Detail>A video editor built for AI. Generate, and edit all in one place.</Detail>
            </div>
          </Show>
          <Show when={ob().step() === "discovery"}>
            <Questionnaire onboarding={ob()} title="Quick questions" questions={discoveryQuestions} />
          </Show>
          <Show when={ob().step() === "profile"}>
            <Questionnaire onboarding={ob()} title="Tell us about your work" questions={profileQuestions} />
          </Show>
          <Show when={ob().step() === "account"}>
            <div class="ob-step">
              <Title>Welcome</Title>
              <Detail>
                {ob().hasSample() ? "Watch the tutorial or start creating." : "Start a new project or open an existing one."}
              </Detail>
              <Show when={ob().sampleState() === "failed"}>
                <p class="ob-error">Sample project couldn’t be opened. Try again.</p>
              </Show>
            </div>
          </Show>
        </div>

        <footer class="ob-footer">
          <Show when={ob().step() !== "welcome"}>
            <CapsuleButton size="regular" fill={secondaryFill} disabled={loading()} onClick={() => ob().goBack()}>Back</CapsuleButton>
          </Show>
          <span class="ob-spacer" />
          <Show when={ob().step() === "welcome" || ob().step() === "discovery"}>
            <CapsuleButton size="regular" variant="prominent" onClick={() => ob().advance()}>Continue</CapsuleButton>
          </Show>
          <Show when={ob().step() === "profile"}>
            <CapsuleButton size="regular" variant="prominent" onClick={() => ob().submitSurvey()}>Continue</CapsuleButton>
          </Show>
          <Show when={ob().step() === "account"}>
            <Show
              when={ob().hasSample()}
              fallback={<CapsuleButton size="regular" variant="prominent" onClick={() => ob().complete()}>Get Started</CapsuleButton>}
            >
              <CapsuleButton size="regular" fill={secondaryFill} disabled={loading()} onClick={() => ob().skip()}>Skip</CapsuleButton>
              <CapsuleButton size="regular" variant="prominent" disabled={loading()} onClick={() => void ob().openSampleProject()}>
                {loading() ? "Loading…" : "Tutorial"}
              </CapsuleButton>
            </Show>
          </Show>
        </footer>
      </div>
    </div>
  );
}
