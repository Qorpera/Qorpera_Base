export interface EyeGeometry { x: number; y: number; width: number; height: number; rotation: number; }
export function loadRecordedMotion(state: string, base: URL): Promise<void>;
export interface EyeFieldTransform { mirror: boolean; tilt: number; x: number; y: number; }
export interface StrokeFieldTransform { mirror: boolean; tilt: number; }
export function drawRecordedEyes(ctx: CanvasRenderingContext2D, eyes: EyeGeometry[], state: string, frame: number, field?: EyeFieldTransform): void;
export function drawWorkingStrokes(ctx: CanvasRenderingContext2D, frame: number, isFront: boolean, field?: StrokeFieldTransform): void;
