import { eyeClips } from './eye-clips.mjs';
import { workingFrames, workingAtlases } from './working-frames.mjs';

export const recordedClips={
  ...eyeClips,
  Working:{frames:workingFrames,atlases:workingAtlases,sourceStart:224},
};

export function recordedFrameAt(state,seconds) {
  return Math.min(recordedClips[state].frames.length-1,Math.max(0,Math.floor(seconds*60+1e-6)));
}
