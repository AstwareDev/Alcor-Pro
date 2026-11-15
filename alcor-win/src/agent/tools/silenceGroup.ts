// Port of ToolExecutor+Words.swift `removeSilence`: the remove_silence tool (verbatim schema from the pending
// transcript definitions). Registered as its own group so the transcript group stays untouched.
import { DeadAirSelectionError, removeAllDeadAir, removeDeadAirInClips, type DeadAirResult } from "../../deadair/deadAir";
import { deadAirServices, maskMediaRefs, prepareDeadAirMasks, silenceRemovalSettings } from "../../deadair/deadAirService";
import {
  makeSilenceRemovalSettings, minimumPauseRange, speechPaddingRange, type SilenceRemovalSettings,
} from "../../deadair/silenceRemovalSettings";
import { pendingTranscriptDefinitions } from "./definitions/transcriptDefinitions";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import type { Json } from "./timelinePayload";
import { ToolError, argDouble, validateUnknownKeys } from "./toolArgs";
import { defineTools, definitionNamed, type ToolArgs, type ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

const allowedKeys = ["clipIds", "minimumPauseSeconds", "speechPaddingSeconds"];

/** `parseSilenceRemovalSettings`: one-shot overrides on top of the current controls. */
export function parseSilenceRemovalSettings(args: ToolArgs, defaults: SilenceRemovalSettings): SilenceRemovalSettings {
  validateUnknownKeys(args, allowedKeys, "remove_silence");
  const value = (key: string, fallback: number, range: { min: number; max: number }): number => {
    if (args[key] === undefined) return fallback;
    const v = argDouble(args, key);
    if (v === undefined || !Number.isFinite(v) || v < range.min || v > range.max) {
      throw new ToolError(`remove_silence: ${key} must be a finite number from ${range.min} through ${range.max}.`);
    }
    return v;
  };
  const minimumPause = value("minimumPauseSeconds", defaults.minimumPauseSeconds, minimumPauseRange);
  const speechPadding = value("speechPaddingSeconds", defaults.speechPaddingSeconds, speechPaddingRange);
  const settings = makeSilenceRemovalSettings(minimumPause, speechPadding);
  if (!settings) throw new ToolError("remove_silence: invalid silence removal settings.");
  return settings;
}

export async function removeSilence({ editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const settings = parseSilenceRemovalSettings(args, silenceRemovalSettings());
  let clipIds: string[] | undefined;
  if (args.clipIds !== undefined) {
    const raw = args.clipIds;
    if (!Array.isArray(raw) || raw.length === 0) throw new ToolError("remove_silence: clipIds must be a non-empty array of clip IDs.");
    const seen = new Set<string>();
    clipIds = [];
    raw.forEach((value: unknown, index) => {
      if (typeof value !== "string" || value.trim() === "") throw new ToolError(`remove_silence: clipIds[${index}] must be a non-empty string.`);
      if (!editor.findClip(value)) throw new ToolError(`Clip not found: ${value}`);
      if (!seen.has(value)) {
        seen.add(value);
        clipIds?.push(value);
      }
    });
  }

  // Unlike the Swift (which reports "analysis may still be running"), wait for the masks of the affected audio first.
  const scope = clipIds === undefined
    ? editor.timeline.tracks.flatMap((t) => t.clips)
    : clipIds.flatMap((id) => {
      const clip = editor.clipFor(id);
      return clip ? [clip] : [];
    });
  await prepareDeadAirMasks(editor, maskMediaRefs(editor, scope));

  const snapshot = timelineSnapshot(editor);
  let result: DeadAirResult | undefined;
  try {
    result = editor.perform("Remove Silence (Agent)", () =>
      clipIds === undefined ? removeAllDeadAir(editor, settings, deadAirServices) : removeDeadAirInClips(editor, clipIds, settings, deadAirServices),
    );
  } catch (e) {
    if (e instanceof DeadAirSelectionError) throw new ToolError(`remove_silence: ${e.message}`);
    throw e;
  }
  if (!result) {
    const where = clipIds === undefined ? "on the timeline" : "in the selected clips";
    throw new ToolError(`No dead air ${where}. Speech analysis may still be running, or the audio has no quiet non-speech sections.`);
  }
  if (result.refusal !== undefined && result.sections === 0) throw new ToolError(`Ripple delete refused: ${result.refusal}`);
  const notes: string[] = [];
  if (result.refusal !== undefined) notes.push(`A later track refused: ${result.refusal}. Earlier tracks were already edited.`);
  const extra: Json = {
    sectionsRemoved: result.sections,
    removedFrames: result.removedFrames,
    minimumPauseSeconds: settings.minimumPauseSeconds,
    speechPaddingSeconds: settings.speechPaddingSeconds,
  };
  if (clipIds !== undefined) extra.clipIds = clipIds;
  return mutationResult(editor, snapshot, { extra, notes });
}

defineTools("silence", [
  { definition: definitionNamed(pendingTranscriptDefinitions, "remove_silence"), run: removeSilence, publishesTimelineChanges: true },
]);
