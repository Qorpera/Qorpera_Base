export interface EyeGeometry { x: number; y: number; width: number; height: number; rotation: number; }
export function loadRecordedMotion(state: string, base: URL): Promise<void>;
export function drawRecordedEyes(ctx: CanvasRenderingContext2D, eyes: EyeGeometry[], state: string, frame: number): void;
export function drawWorkingStrokes(ctx: CanvasRenderingContext2D, frame: number, isFront: boolean): void;
