// Test fixture for sync.test.ts: a reference audio clip plus a linked audio + video target pair. Only imported by tests.
import { newId } from "../../util/id";
import type { Editor } from "../editor";
import { Fixtures, makeAsset, makeEditor, setup } from "./testFixtures";

export function makeLinkGroupFixture(): { editor: Editor } {
  const link = newId();
  const ref = Fixtures.clip({ id: "ref", mediaRef: "refMedia", mediaType: "audio", start: 100, duration: 600 });
  const tgtA = Fixtures.clip({ id: "tgtA", mediaRef: "tgtMedia", mediaType: "audio", start: 5000, duration: 450 });
  const tgtV = Fixtures.clip({ id: "tgtV", mediaRef: "tgtMedia", mediaType: "video", start: 5000, duration: 450 });
  tgtA.linkGroupId = link;
  tgtV.linkGroupId = link;
  const editor = makeEditor([
    Fixtures.videoTrack({ clips: [tgtV] }),
    Fixtures.audioTrack({ clips: [ref] }),
    Fixtures.audioTrack({ clips: [tgtA] }),
  ]);
  setup(editor, () => {
    editor.doc.mediaAssets.push(
      makeAsset({ id: "refMedia", type: "audio", duration: 20 }),
      makeAsset({ id: "tgtMedia", type: "video", duration: 15, hasAudio: true }),
    );
  });
  return { editor };
}
