export type Activity = "Idle" | "Working" | "Waiting" | "Blocked" | "Thinking" | "Done";
export interface FacePose { x: number; y: number; width: number; height: number; rotation: number; alpha: number; }
export interface MotionPose {
  scaleX: number; scaleY: number; turn: number; x: number; y: number; body: number; eyes: number; open: number;
  face: FacePose[];
  dots: { x: number; y: number; r: number; alpha: number }[];
  stemTop: number; stemBottom: number; stemWidth: number; alertDotY: number; alertDotR: number;
  strokes: { lane: number; head: number; length: number; width: number; expansion: number; color: string }[];
}
export const states: Activity[];
export const timelines: Record<Activity, { start: number; end: number; loopStart?: number }>;
export function pose(state: Activity, seconds: number, options?: { reduced?: boolean }): MotionPose;
export function localTime(state: Activity, seconds: number): number;
