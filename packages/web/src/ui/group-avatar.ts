import type { HostedStaffAgent } from "../cloud/types.ts";
import { colorFor, type FigureId, figureArtwork, figureFor, nativeColorOf } from "./avatar.ts";
import type { FigureArtwork } from "./figure-motion.ts";

export interface GroupAvatarOptions {
	width?: number;
	height?: number;
	selected?: boolean;
}
interface MemberFigure {
	figure: FigureId;
	color: string;
}
interface Group {
	canvas: HTMLCanvasElement;
	width: number;
	height: number;
	selected: boolean;
	count: number;
	members: MemberFigure[];
	artwork: FigureArtwork;
	ready: boolean;
}
interface Mask {
	canvas: HTMLCanvasElement;
	margin: number;
}

const loaded = new WeakMap<FigureArtwork["prepare"], Map<FigureId, Promise<void>>>();
const masks = new WeakMap<FigureArtwork["prepare"], Map<string, Mask>>();
const groups = new Map<HTMLCanvasElement, Group>();
let mutations: MutationObserver | undefined;
let resize: ResizeObserver | undefined;
let lifetime: AbortController | undefined;

/** Coordinates from the approved Assets Room and desktop group compositor. */
function layout(count: number): readonly (readonly [number, number, number])[] {
	if (count <= 1) return [[2, 0, 44]];
	if (count === 2)
		return [
			[4, 2, 27],
			[17, 15, 27],
		];
	if (count === 3)
		return [
			[12.5, 2, 23],
			[5, 17, 23],
			[20, 17, 23],
		];
	return [
		[5.5, 3, 23],
		[20.5, 3, 23],
		[5.5, 18, 23],
		[20.5, 18, 23],
	];
}

function prepare(artwork: FigureArtwork, figure: FigureId): Promise<void> {
	let cache = loaded.get(artwork.prepare);
	if (!cache) {
		cache = new Map();
		loaded.set(artwork.prepare, cache);
	}
	let pending = cache.get(figure);
	if (!pending) {
		const image = new Image();
		image.src = new URL(`./assets/avatars/status-2d-v1/${figure}.webp`, document.baseURI).href;
		pending = image
			.decode()
			.then(() => artwork.prepare(figure, image))
			.catch((error: unknown) => {
				cache.delete(figure);
				throw error;
			});
		cache.set(figure, pending);
	}
	return pending;
}

/** Dilate the actual foreground alpha, then erase it from the figures behind.
 * The separator is transparent on every surface, including selected rows. */
function knockout(artwork: FigureArtwork, figure: FigureId, side: number, radius: number): Mask | undefined {
	let cache = masks.get(artwork.prepare);
	if (!cache) {
		cache = new Map();
		masks.set(artwork.prepare, cache);
	}
	const key = `${figure}:${side}:${radius}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const margin = Math.ceil(radius) + 1;
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = side + margin * 2;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) return undefined;
	context.drawImage(artwork.drawable(figure, nativeColorOf(figure)), margin, margin, side, side);
	const source = context.getImageData(0, 0, canvas.width, canvas.height);
	const target = context.createImageData(canvas.width, canvas.height);
	const offsets: [number, number][] = [];
	for (let y = -Math.ceil(radius); y <= Math.ceil(radius); y++)
		for (let x = -Math.ceil(radius); x <= Math.ceil(radius); x++)
			if (x * x + y * y <= radius * radius) offsets.push([x, y]);
	for (let y = 0; y < canvas.height; y++) {
		for (let x = 0; x < canvas.width; x++) {
			const index = (y * canvas.width + x) * 4 + 3;
			let alpha = source.data[index]!;
			if (alpha < 255) {
				for (const [dx, dy] of offsets) {
					const sx = x + dx,
						sy = y + dy;
					if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) continue;
					alpha = Math.max(alpha, source.data[(sy * canvas.width + sx) * 4 + 3]!);
					if (alpha === 255) break;
				}
			}
			target.data[index] = alpha;
		}
	}
	context.putImageData(target, 0, 0);
	const mask = { canvas, margin };
	if (cache.size >= 96) cache.delete(cache.keys().next().value!);
	cache.set(key, mask);
	return mask;
}

function draw(group: Group): void {
	if (!group.ready || !groups.has(group.canvas) || !group.canvas.isConnected) return;
	const { canvas, artwork } = group;
	const ratio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
	const bounds = canvas.getBoundingClientRect();
	canvas.width = Math.max(1, Math.round((bounds.width || group.width) * ratio));
	canvas.height = Math.max(1, Math.round((bounds.height || group.height) * ratio));
	const context = canvas.getContext("2d");
	if (!context) return;
	const scale = Math.min(canvas.width / 48, canvas.height / 44);
	const offsetX = (canvas.width - 48 * scale) / 2,
		offsetY = (canvas.height - 44 * scale) / 2;
	const positions = layout(group.count);
	const dark = document.documentElement.dataset.theme === "dark";
	for (const [index, member] of group.members.entries()) {
		const [x, y, size] = positions[index]!;
		const side = Math.round(size * scale);
		const left = Math.round(x * scale + offsetX),
			top = Math.round(y * scale + offsetY);
		if (index > 0) {
			const mask = knockout(artwork, member.figure, side, 1.2 * scale);
			if (mask) {
				context.globalCompositeOperation = "destination-out";
				context.drawImage(mask.canvas, left - mask.margin, top - mask.margin);
			}
		}
		context.globalCompositeOperation = "source-over";
		const color = dark ? artwork.colorOnDark(member.figure, member.color) : member.color;
		context.drawImage(artwork.drawable(member.figure, color), left, top, side, side);
	}
	if (group.count > 4) {
		context.font = `600 ${(group.count > 12 ? 12 : 13) * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillStyle = group.selected ? "#ffffff" : dark ? "#c5c5c0" : "#686864";
		context.fillText(`+${group.count - 3}`, offsetX + 32.5 * scale, offsetY + 30.7 * scale);
	}
}

function sweep(): void {
	for (const canvas of groups.keys()) {
		if (canvas.isConnected) continue;
		resize?.unobserve(canvas);
		groups.delete(canvas);
	}
	if (groups.size) return;
	resize?.disconnect();
	mutations?.disconnect();
	lifetime?.abort();
	resize = undefined;
	mutations = undefined;
	lifetime = undefined;
}

function observe(): void {
	if (mutations) return;
	lifetime = new AbortController();
	if (typeof ResizeObserver !== "undefined") {
		resize = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const group = groups.get(entry.target as HTMLCanvasElement);
				if (group) draw(group);
			}
		});
	}
	mutations = new MutationObserver((records) => {
		sweep();
		if (records.some((record) => record.type === "attributes" && record.target === document.documentElement))
			for (const group of groups.values()) draw(group);
	});
	mutations.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	window.addEventListener(
		"resize",
		() => {
			for (const group of groups.values()) draw(group);
		},
		{ signal: lifetime.signal },
	);
}

/** The approved group cluster, composed from the room's actual agent roster.
 * An empty roster leaves transparent space while canonical membership loads. */
export function groupAvatar(agents: readonly HostedStaffAgent[], options: GroupAvatarOptions = {}): HTMLElement {
	const canvas = document.createElement("canvas");
	canvas.className = "group-chat-avatar";
	canvas.setAttribute("aria-hidden", "true");
	const width = options.width ?? 48,
		height = options.height ?? 44;
	canvas.style.width = `var(--group-avatar-width, ${width}px)`;
	canvas.style.height = `var(--group-avatar-height, ${height}px)`;
	canvas.width = Math.max(1, Math.round(width * 2));
	canvas.height = Math.max(1, Math.round(height * 2));
	const artwork = figureArtwork();
	if (!artwork || !agents.length) return canvas;
	const members = agents.slice(0, agents.length > 4 ? 3 : 4).map((agent) => {
		const figure = figureFor(agent);
		return {
			figure,
			color: agent.templateId === "co-founder" ? nativeColorOf(figure) : colorFor(agent, figure),
		};
	});
	const group: Group = {
		canvas,
		width,
		height,
		selected: Boolean(options.selected),
		count: agents.length,
		members,
		artwork,
		ready: false,
	};
	groups.set(canvas, group);
	observe();
	resize?.observe(canvas);
	queueMicrotask(sweep);
	void Promise.all(members.map(({ figure }) => prepare(artwork, figure)))
		.then(() => {
			group.ready = true;
			draw(group);
		})
		.catch(() => {
			// Keep missing artwork transparent; never substitute an unrelated icon.
		});
	return canvas;
}
