import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Diamond from "lucide-solid/icons/diamond";
import "./KeyframeControlStrip.css";

/** Port of `KeyframeControlStrip`: previous / toggle diamond / next. Missing actions render disabled. */
export function KeyframeControlStrip(props: {
  onPrevious?: () => void;
  onKeyframe?: () => void;
  onNext?: () => void;
  isOnKeyframe: boolean;
  hasKeyframes: boolean;
  unavailableKeyframeHelp: string;
}) {
  const keyframeHelp = (): string =>
    !props.onKeyframe ? props.unavailableKeyframeHelp : props.isOnKeyframe ? "Delete keyframe" : "Add keyframe";
  return (
    <div class="kf-strip">
      <button type="button" class="kf-nav" disabled={!props.onPrevious} title="Go to previous keyframe" aria-label="Go to previous keyframe" onClick={() => props.onPrevious?.()}>
        <ChevronLeft size={9} stroke-width={3} />
      </button>
      <button
        type="button"
        class="kf-diamond"
        classList={{ active: props.isOnKeyframe || props.hasKeyframes }}
        disabled={!props.onKeyframe}
        title={keyframeHelp()}
        aria-label={keyframeHelp()}
        onClick={() => props.onKeyframe?.()}
      >
        <Diamond size={10} stroke-width={2} fill={props.isOnKeyframe ? "currentColor" : "none"} />
      </button>
      <button type="button" class="kf-nav" disabled={!props.onNext} title="Go to next keyframe" aria-label="Go to next keyframe" onClick={() => props.onNext?.()}>
        <ChevronRight size={9} stroke-width={3} />
      </button>
    </div>
  );
}
