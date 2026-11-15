// Decides what a free-form prompt-bar request should generate and where the result goes.
import type { HttpRequest, HttpResponse } from "../platform/backend";
import { decide, type DecisionModelId, type Question } from "./decisionClient";

export type GenKind = "video" | "image" | "speech" | "sfx" | "music";
export type Placement = "library" | "timeline";

export interface Route {
  kind: GenKind;
  placement: Placement;
  /** The request refers to the selected clip ("animate this"), so it becomes a reference. */
  useSelection: boolean;
  /** 0–1. Below the ask threshold the bar asks the user to pick the kind. */
  confidence: number;
  source: "model" | "rules";
  /** Set when a routing model was chosen but failed and the rules answered instead. */
  fallbackReason?: string;
}

export interface RouteContext {
  available: readonly GenKind[];
  hasSelection: boolean;
}

const kindCriteria: Record<GenKind, string> = {
  video: "A video clip, shot, scene, animation or footage.",
  image: "A still image: picture, photo, illustration, poster, thumbnail or logo.",
  speech: "Spoken words: voiceover, narration, or a line read aloud by a voice.",
  sfx: "A short sound effect or ambience, such as a whoosh, footsteps, impact or rain.",
  music: "Music: a song, beat, loop, score or soundtrack.",
};

export function routeQuestions(ctx: RouteContext): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const k of ctx.available) criteria[k] = kindCriteria[k];
  const questions: Record<string, Question> = {
    kind: { type: "choice", instructions: "A user typed this into a video editor's generate bar. What should be generated?", criteria },
    placement: {
      type: "choice",
      instructions: "Where does the user want the generated result?",
      criteria: {
        timeline: "Placed in the current edit: on the timeline, at the playhead, as background or soundtrack for this video.",
        library: "Only created and kept in the media library; no placement is asked for.",
      },
    },
  };
  if (ctx.hasSelection) {
    questions.use_selection = {
      type: "noul",
      instructions: "Does the request refer to an existing selected clip or image, for example 'animate this' or 'make it night'?",
    };
  }
  return questions;
}

// MARK: built-in rules

const kindPatterns: Record<GenKind, RegExp> = {
  music: /\b(music|song|beat|beats|soundtrack|score|lo-?fi|melody|instrumental|tune|jingle|hip ?hop|jazz|edm|piano|guitar|synthwave|ambient music|loop)\b/gi,
  speech: /\b(say|says|saying|voice ?over|narrat\w*|read (?:this|it|aloud)|speak\w*|tts|dialogue|announce\w*|voice line)\b/gi,
  sfx: /\b(sound effects?|sfx|whoosh|swoosh|footsteps?|explosions?|ding|click|ambience|thunder|impact|riser|swish|boom|crowd noise|rain sound)\b/gi,
  image: /\b(image|picture|photo|poster|thumbnail|illustration|logo|still|drawing|portrait|wallpaper|icon|render of)\b/gi,
  video: /\b(video|clip|shot|footage|scene|animate|animation|b-?roll|drone|cinematic|timelapse|tracking shot|slow motion)\b/gi,
};

const timelinePattern =
  /\b(timeline|playhead|insert|put (?:it|this) (?:in|on)|add (?:it |this )?to (?:the |my )?(?:edit|video|timeline)|background (?:music|track)|under (?:the|this)|for (?:a |an |the |this |my )?[\w\s-]{0,24}video|soundtrack for)\b/i;
const selectionPattern = /\b(this|it|the selected|selection|that clip|this clip|this image)\b/i;

/** "for my 2x speed video" names the destination, not what to make, so it must not vote for video. */
const destinationPattern = /\b(?:for|in|on|into|under) (?:a |an |the |this |my |our )?[\w\s-]{0,24}?(?:video|edit|timeline|clip)\b/gi;

export function routeWithRules(text: string, ctx: RouteContext): Route {
  const subject = text.replace(destinationPattern, " ");
  const scores = ctx.available.map((k) => ({ k, n: subject.match(kindPatterns[k])?.length ?? 0 }));
  scores.sort((a, b) => b.n - a.n);
  const best = scores[0];
  const second = scores[1];
  const kind: GenKind = best && best.n > 0 ? best.k : ctx.available.includes("video") ? "video" : ctx.available[0] ?? "video";
  const clear = best !== undefined && best.n > 0 && (second === undefined || best.n > second.n);
  return {
    kind,
    placement: timelinePattern.test(text) ? "timeline" : "library",
    useSelection: ctx.hasSelection && selectionPattern.test(text),
    confidence: clear ? 0.8 : best && best.n > 0 ? 0.45 : 0.3,
    source: "rules",
  };
}

// MARK: model routing

export type RoutingModelId = "rules" | DecisionModelId;

export async function routePrompt(
  text: string,
  ctx: RouteContext,
  model: RoutingModelId,
  fetch: (req: HttpRequest) => Promise<HttpResponse>,
): Promise<Route> {
  if (model === "rules" || ctx.available.length === 0) return routeWithRules(text, ctx);
  if (ctx.available.length === 1) return { ...routeWithRules(text, ctx), confidence: 1 };
  try {
    const answers = await decide(model, text, routeQuestions(ctx), fetch);
    const kindAnswer = answers.kind;
    const kind = kindAnswer?.type === "choice" ? (kindAnswer.choice as GenKind) : undefined;
    if (!kind || !ctx.available.includes(kind)) throw new Error("The routing model returned no usable answer.");
    const placementAnswer = answers.placement;
    const selectionAnswer = answers.use_selection;
    return {
      kind,
      placement: placementAnswer?.type === "choice" && placementAnswer.choice === "timeline" ? "timeline" : "library",
      useSelection: selectionAnswer?.type === "noul" && selectionAnswer.noul >= 0.5,
      confidence: kindAnswer?.type === "choice" ? kindAnswer.confidence : 0,
      source: "model",
    };
  } catch (e) {
    return { ...routeWithRules(text, ctx), fallbackReason: e instanceof Error ? e.message : String(e) };
  }
}

// MARK: durations

const durationPattern = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m)\b/i;

/** "a 10s clip", "2 minutes of music"; `undefined` when the prompt names no length. */
export function parseDurationSeconds(text: string): number | undefined {
  const m = durationPattern.exec(text);
  if (!m) return undefined;
  const value = Number(m[1]);
  return m[2].toLowerCase().startsWith("m") ? value * 60 : value;
}

/** The allowed duration closest to `seconds`, preferring the longer one on a tie. */
export function nearestChoice(choices: readonly number[], seconds: number): number | undefined {
  let best: number | undefined;
  for (const c of choices) {
    if (best === undefined || Math.abs(c - seconds) < Math.abs(best - seconds) || (Math.abs(c - seconds) === Math.abs(best - seconds) && c > best)) best = c;
  }
  return best;
}
