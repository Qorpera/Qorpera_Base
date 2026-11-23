export interface ThreeVector3 {
	x: number;
	y: number;
	z: number;
	set(x: number, y: number, z: number): ThreeVector3;
}

export interface ThreeColor {
	set(value: string): ThreeColor;
	copy(color: ThreeColor): ThreeColor;
	lerp(color: ThreeColor, alpha: number): ThreeColor;
}

export interface ThreeTexture {
	readonly isTexture: true;
	dispose(): void;
}

export interface ThreeMaterial {
	name: string;
	color?: ThreeColor;
	dispose(): void;
}

export interface ThreeObject3D {
	name: string;
	readonly children: ThreeObject3D[];
	readonly parent: ThreeObject3D | null;
	readonly position: ThreeVector3;
	readonly rotation: { x: number; y: number; z: number };
	readonly scale: ThreeVector3;
	readonly userData: Record<string, unknown>;
	readonly geometry?: { dispose(): void };
	readonly material?: ThreeMaterial | ThreeMaterial[];
	add(...objects: ThreeObject3D[]): ThreeObject3D;
	remove(...objects: ThreeObject3D[]): ThreeObject3D;
	traverse(callback: (object: ThreeObject3D) => void): void;
	updateMatrixWorld(force?: boolean): void;
	getWorldPosition(target: ThreeVector3): ThreeVector3;
	worldToLocal(vector: ThreeVector3): ThreeVector3;
}

export interface ThreeScene extends ThreeObject3D {
	environment: ThreeTexture | null;
}

export interface ThreeBox3 {
	readonly min: ThreeVector3;
	readonly max: ThreeVector3;
	setFromObject(object: ThreeObject3D): ThreeBox3;
	isEmpty(): boolean;
	getCenter(target: ThreeVector3): ThreeVector3;
	getSize(target: ThreeVector3): ThreeVector3;
}

export interface ThreeCamera extends ThreeObject3D {
	fov: number;
	aspect: number;
	near: number;
	far: number;
	lookAt(x: number, y: number, z: number): void;
	updateProjectionMatrix(): void;
}

export interface ThreeRenderer {
	readonly domElement: HTMLCanvasElement;
	outputColorSpace: string;
	toneMapping: number;
	toneMappingExposure: number;
	setPixelRatio(ratio: number): void;
	setSize(width: number, height: number, updateStyle: boolean): void;
	setClearColor(color: number, alpha: number): void;
	render(scene: ThreeScene, camera: ThreeCamera): void;
	dispose(): void;
	forceContextLoss(): void;
}

export interface ThreeGltf {
	readonly scene: ThreeObject3D;
}

export interface StudioThree {
	readonly WebGLRenderer: new (options: {
		readonly canvas: HTMLCanvasElement;
		readonly alpha: boolean;
		readonly antialias: boolean;
	}) => ThreeRenderer;
	readonly Scene: new () => ThreeScene;
	readonly Group: new () => ThreeObject3D;
	readonly PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => ThreeCamera;
	readonly Box3: new () => ThreeBox3;
	readonly Vector3: new (x?: number, y?: number, z?: number) => ThreeVector3;
	readonly Color: new (value?: string) => ThreeColor;
	readonly PMREMGenerator: new (
		renderer: ThreeRenderer,
	) => {
		fromScene(scene: ThreeObject3D, sigma: number): { readonly texture: ThreeTexture };
		dispose(): void;
	};
	readonly RoomEnvironment: new () => ThreeObject3D & { dispose(): void };
	readonly GLTFLoader: new () => {
		parse(
			data: ArrayBuffer,
			path: string,
			onLoad: (gltf: ThreeGltf) => void,
			onError: (error: unknown) => void,
		): void;
	};
	readonly AgXToneMapping: number;
	readonly SRGBColorSpace: string;
}

declare const __QORPERA_THREE_SRC__: string | undefined;

const CONSTRUCTORS = [
	"WebGLRenderer",
	"Scene",
	"Group",
	"PerspectiveCamera",
	"Box3",
	"Vector3",
	"Color",
	"PMREMGenerator",
	"RoomEnvironment",
	"GLTFLoader",
] as const;

function isStudioThree(value: unknown): value is StudioThree {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		CONSTRUCTORS.every((name) => typeof record[name] === "function") &&
		typeof record.AgXToneMapping === "number" &&
		typeof record.SRGBColorSpace === "string"
	);
}

export function studioThree(): StudioThree | undefined {
	const library = (globalThis as { QORPERA_THREE?: unknown }).QORPERA_THREE;
	return isStudioThree(library) ? library : undefined;
}

export function studioThreeSource(): string | undefined {
	return typeof __QORPERA_THREE_SRC__ === "string" ? __QORPERA_THREE_SRC__ : undefined;
}

let loading: Promise<StudioThree | undefined> | undefined;

export function loadStudioThree(): Promise<StudioThree | undefined> {
	const present = studioThree();
	if (present) return Promise.resolve(present);
	const source = studioThreeSource();
	if (!source || typeof document === "undefined") return Promise.resolve(undefined);
	loading ??= new Promise<StudioThree | undefined>((resolve) => {
		const script = document.createElement("script");
		script.src = new URL(source, import.meta.url).href;
		script.async = true;
		script.addEventListener("load", () => resolve(studioThree()), { once: true });
		script.addEventListener(
			"error",
			() => {
				script.remove();
				loading = undefined;
				resolve(undefined);
			},
			{ once: true },
		);
		document.head.append(script);
	});
	return loading;
}
