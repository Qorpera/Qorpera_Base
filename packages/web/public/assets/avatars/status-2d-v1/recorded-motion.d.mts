export interface EyeGeometry { x: number; y: number; width: number; height: number; rotation: number; }
export function loadRecordedMotion(state: string, base: URL): Promise<void>;
export interface EyeFieldTransform { mirror: boolean; tilt: number; x: number; y: number; }
export interface StrokeFieldTransform { mirror: boolean; tilt: number; }
export function drawRecordedEyes(ctx: CanvasRenderingContext2D, eyes: EyeGeometry[], state: string, frame: number, field?: EyeFieldTransform): void;
/** Where drawRecordedEyes would put this frame's eyes, in the caller's units ([left, top, right, bottom]), or null
 * when the frame has no eye. */
export function recordedEyesBox(eyes: EyeGeometry[], state: string, frame: number, field?: EyeFieldTransform): [number, number, number, number] | null;
export function drawWorkingStrokes(ctx: CanvasRenderingContext2D, frame: number, isFront: boolean, field?: StrokeFieldTransform): void;
