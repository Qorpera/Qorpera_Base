export interface RecordedFrame {
  /** Source body circle: centre x, centre y, radius, in the 160px source frame. */
  c: [number, number, number];
  /** Eye contours as pixel rings; an empty ring or no ring is a hidden eye. */
  eyes: [number, number][][];
  /** Visible stroke pixels as (y, x, length) runs. */
  runs: number[];
}
export const recordedClips: Record<"Idle" | "Working" | "Waiting", { frames: RecordedFrame[]; atlases: string[] }>;
export function recordedFrameAt(state: string, seconds: number): number;
