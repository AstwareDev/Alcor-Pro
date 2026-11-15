// One client for the three "decision model" APIs. They share a request shape (named typed questions over a
// shared input) and an answer shape; only the endpoint, auth and the input field name differ.
// Gemini: https://ai.google.dev (POST v1beta/decisions, field `input`)
// Inception: https://docs.inceptionlabs.ai/capabilities/decisions (POST /v1/decisions, field `state`)
// OpenRouter (Jev): https://openrouter.ai/docs/guides/community/jev (POST /api/alpha/decisions, field `state`)
import type { HttpRequest, HttpResponse } from "../platform/backend";

export type DecisionModelId = "gemini-decision-1" | "mercury-decide" | "jev";

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number };

interface Endpoint {
  url: string;
  model: string;
  secret: string;
  inputField: "input" | "state";
  header: string;
  prefix: string;
}

const endpoints: Record<DecisionModelId, Endpoint> = {
  "gemini-decision-1": {
    url: "https://generativelanguage.googleapis.com/v1beta/decisions", model: "gemini-decision-1",
    secret: "google", inputField: "input", header: "x-goog-api-key", prefix: "",
  },
  "mercury-decide": {
    url: "https://api.inceptionlabs.ai/v1/decisions", model: "mercury-decide",
    secret: "inception", inputField: "state", header: "Authorization", prefix: "Bearer ",
  },
  jev: {
    url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.14",
    secret: "openrouter", inputField: "state", header: "Authorization", prefix: "Bearer ",
  },
};

export const decisionSecret = (id: DecisionModelId): string => endpoints[id].secret;

export function buildDecisionRequest(id: DecisionModelId, input: string, questions: Record<string, Question>): HttpRequest {
  const e = endpoints[id];
  return {
    url: e.url,
    method: "POST",
    auth: { secret: e.secret, header: e.header, prefix: e.prefix },
    body: { kind: "json", value: { model: e.model, [e.inputField]: input, questions } },
    timeoutMs: 15_000,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keeps only well-formed answers; an unknown or malformed one is dropped rather than guessed. */
export function parseDecisionResponse(res: HttpResponse): Record<string, Answer> {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Routing model request failed (HTTP ${res.status}): ${res.bodyText.slice(0, 200)}`);
  }
  const body: unknown = JSON.parse(res.bodyText);
  const answers = isRecord(body) && isRecord(body.answers) ? body.answers : {};
  const out: Record<string, Answer> = {};
  for (const [key, a] of Object.entries(answers)) {
    if (!isRecord(a)) continue;
    if (a.type === "noul" && typeof a.noul === "number") out[key] = { type: "noul", noul: a.noul };
    if (a.type === "choice" && typeof a.choice === "string") {
      out[key] = { type: "choice", choice: a.choice, confidence: typeof a.confidence === "number" ? a.confidence : 1 };
    }
  }
  return out;
}

export async function decide(
  id: DecisionModelId,
  input: string,
  questions: Record<string, Question>,
  fetch: (req: HttpRequest) => Promise<HttpResponse>,
): Promise<Record<string, Answer>> {
  return parseDecisionResponse(await fetch(buildDecisionRequest(id, input, questions)));
}
