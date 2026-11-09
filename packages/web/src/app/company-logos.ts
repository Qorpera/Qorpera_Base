import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError } from "../cloud/client.ts";
import type { WebMemberFolder } from "../cloud/company-folder-writes.ts";
import {
	COMPANY_BRAND_FOLDER,
	COMPANY_LOGO_PATH,
	type CompanyLogo,
	type CompanyLogoChange,
	companyLogoName,
	companyLogoSource,
} from "../cloud/company-logos.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import { type CompanyLogoStore, paintCompanyLogo } from "../ui/company-logos.ts";
import { type LoadedPicture, loadPicture, type PictureCrop, PictureFileError } from "../ui/picture-file.ts";
import { phrase } from "../ui/preferences.ts";

/* The signed-in account's view of company logos (cloud/company-logos.ts). Every company figure on the page asks for its
 * company; the asks of one moment go to the cloud as one read, each logo is downloaded once and kept as a blob: URL,
 * and every figure of that company is repainted when it arrives or changes. A member who may write a company's folder
 * keeps its logo PNG current (`sync`): when the folder's QorperaOS/brand/logo.svg is newer than the PNG everyone sees,
 * their app draws the SVG and publishes the drawing. They also choose a logo of their own, which the app wraps in an
 * SVG and saves as that file (`choose`), or remove it (`remove`). A reset (the account changed) forgets everything. */

type Entry =
	| { kind: "loading" }
	| { kind: "none"; row?: CompanyLogo }
	| { kind: "logo"; row: CompanyLogo; url: string }
	| { kind: "failed"; retryAt: number };

const RETRY_MS = 60_000;
/** A PNG that is not the logo and has sat this long was left by a sync that never published it. */
const STALE_MS = 10 * 60_000;
/** The bucket keeps four PNGs per company (migration 20260930696000). */
const FOLDER_CAP = 4;
const BATCH = 100;
/** The PNG everyone sees, square. */
export const COMPANY_LOGO_SIZE = 512;
/** The largest logo.svg the app draws; the folder takes text writes up to 512 KiB. */
const MAX_SVG_BYTES = 512 * 1024;
/** A chosen picture, wrapped in the SVG, stays under this so the text write fits. */
const MAX_WRAPPED_BYTES = 360 * 1024;

export interface CompanyLogosOptions {
	/** Draws an SVG to a square PNG (tests have no canvas). */
	rasterize?: (svg: string, size: number) => Promise<Blob>;
	/** Turns a chosen picture into the SVG saved as the logo. */
	wrap?: (file: File, crop?: PictureCrop) => Promise<string>;
	now?: () => number;
}

export class CompanyLogos implements CompanyLogoStore {
	readonly #api: CloudApi;
	readonly #rasterize: (svg: string, size: number) => Promise<Blob>;
	readonly #wrap: (file: File, crop?: PictureCrop) => Promise<string>;
	readonly #now: () => number;
	readonly #entries = new Map<string, Entry>();
	readonly #elements = new Map<string, Set<WeakRef<HTMLElement>>>();
	readonly #queue = new Set<string>();
	readonly #syncing = new Map<string, Promise<void>>();
	/** Each company's latest answer being taken; an older one that finishes later is dropped. */
	readonly #revisions = new Map<string, number>();
	#flushing = false;
	#generation = 0;
	/** False once the cloud has said it has no company logos (not deployed there yet). */
	#available: boolean | undefined;

	constructor(api: CloudApi, options: CompanyLogosOptions = {}) {
		this.#api = api;
		this.#rasterize = options.rasterize ?? rasterizeSvg;
		this.#wrap = options.wrap ?? wrapPicture;
		this.#now = options.now ?? Date.now;
	}

	attach(element: HTMLElement, rawProfileId: string): void {
		if (!UUID_PATTERN.test(rawProfileId) || this.#available === false) return;
		const profileId = rawProfileId.toLowerCase();
		let elements = this.#elements.get(profileId);
		if (!elements) {
			elements = new Set();
			this.#elements.set(profileId, elements);
		}
		if (elements.size >= 32) for (const ref of elements) if (!ref.deref()) elements.delete(ref);
		elements.add(new WeakRef(element));
		const entry = this.#entries.get(profileId);
		if (entry?.kind === "logo") paintCompanyLogo(element, entry.url);
		if (!entry || (entry.kind === "failed" && this.#now() >= entry.retryAt)) this.#ask(profileId);
	}

	/** What the cloud last said about a company's logo, once it has answered. */
	logo(profileId: string): CompanyLogo | undefined {
		const entry = this.#entries.get(profileId.toLowerCase());
		return entry?.kind === "logo" || entry?.kind === "none" ? entry.row : undefined;
	}

	reset(): void {
		this.#generation++;
		for (const entry of this.#entries.values()) if (entry.kind === "logo") URL.revokeObjectURL(entry.url);
		this.#entries.clear();
		this.#queue.clear();
		this.#syncing.clear();
		this.#revisions.clear();
		this.#flushing = false;
		this.#available = undefined;
		for (const [profileId] of this.#elements) this.#paint(profileId, undefined);
		this.#elements.clear();
	}

	/** Reads a company's logo again, and repaints its figures. */
	async refresh(profileId: string): Promise<CompanyLogo | undefined> {
		const id = profileId.toLowerCase();
		const generation = this.#generation;
		const revision = this.#revision(id);
		const [row] = await this.#api.listCompanyLogos([id]);
		if (generation !== this.#generation) return undefined;
		await this.#take(id, row, generation, revision);
		return row;
	}

	/** Brings the PNG everyone sees in step with the folder's logo.svg, when the caller may. One sync per company runs
	 * at a time; another joins it. */
	sync(profileId: string, folder: () => WebMemberFolder, signal: AbortSignal): Promise<void> {
		return this.#start(profileId.toLowerCase(), folder, signal, false);
	}

	/** Starts a sync, or joins the one running; `fresh` (after a change to the folder) runs another pass after it,
	 * since the running one may have read the folder before the change. */
	#start(id: string, folder: () => WebMemberFolder, signal: AbortSignal, fresh: boolean): Promise<void> {
		const running = this.#syncing.get(id);
		if (running && !fresh) return running;
		const work: Promise<void> = (running ?? Promise.resolve())
			.catch(() => undefined)
			.then(() => this.#sync(id, folder, signal))
			.finally(() => {
				if (this.#syncing.get(id) === work) this.#syncing.delete(id);
			});
		this.#syncing.set(id, work);
		return work;
	}

	/** Saves `file`, cropped to `crop`, as the company's logo.svg, then publishes its drawing. */
	async choose(
		profileId: string,
		file: File,
		crop: PictureCrop | undefined,
		folder: () => WebMemberFolder,
		signal: AbortSignal,
	): Promise<void> {
		const svg = await this.#wrap(file, crop);
		signal.throwIfAborted();
		const client = folder();
		const read = await client.read(COMPANY_LOGO_PATH, signal);
		const brand = read.entry ? undefined : await client.read(COMPANY_BRAND_FOLDER, signal);
		const answer = await client.commit(
			`company-logo-${crypto.randomUUID()}`,
			[
				...(brand && !brand.entry ? [{ op: "mkdir" as const, path: COMPANY_BRAND_FOLDER }] : []),
				{
					op: "write" as const,
					path: COMPANY_LOGO_PATH,
					text: svg,
					...(read.entry?.version ? { expectedVersion: read.entry.version } : {}),
				},
			],
			signal,
		);
		const unsaved = answer.units.find((unit) => unit.outcome !== "saved");
		if (unsaved) throw new Error(phrase("The logo could not be saved. Try again."));
		await this.#start(profileId.toLowerCase(), folder, signal, true);
	}

	/** Takes the company's logo away: the folder's logo.svg is deleted and the figure comes back. */
	async remove(profileId: string, folder: () => WebMemberFolder, signal: AbortSignal): Promise<void> {
		const client = folder();
		const read = await client.read(COMPANY_LOGO_PATH, signal);
		if (read.entry) {
			const answer = await client.commit(
				`company-logo-${crypto.randomUUID()}`,
				[
					{
						op: "delete",
						path: COMPANY_LOGO_PATH,
						...(read.entry.version ? { expectedVersion: read.entry.version } : {}),
					},
				],
				signal,
			);
			if (answer.units.some((unit) => unit.outcome !== "saved"))
				throw new Error(phrase("The logo could not be removed. Try again."));
		}
		await this.#start(profileId.toLowerCase(), folder, signal, true);
	}

	async #sync(profileId: string, folder: () => WebMemberFolder, signal: AbortSignal): Promise<void> {
		if (this.#available === false) return;
		const generation = this.#generation;
		// Taken before the read, so an answer the page asked for earlier cannot paint over what this sync finds.
		const revision = this.#revision(profileId);
		let row: CompanyLogo | undefined;
		try {
			[row] = await this.#api.listCompanyLogos([profileId]);
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) this.#available = false;
			else if (this.#latest(profileId, generation, revision))
				this.#entries.set(profileId, { kind: "failed", retryAt: this.#now() + RETRY_MS });
			return;
		}
		// Unless the sync publishes and reads the logo again, its answer is the one the page shows.
		let published = false;
		try {
			published = await this.#publish(profileId, row, folder, signal, generation);
		} finally {
			if (!published) await this.#take(profileId, row, generation, revision);
		}
		if (published) await this.refresh(profileId);
	}

	/** Publishes the drawing of the folder's logo.svg when `row` says the shown one is behind; true once it did. */
	async #publish(
		profileId: string,
		row: CompanyLogo | undefined,
		folder: () => WebMemberFolder,
		signal: AbortSignal,
		generation: number,
	): Promise<boolean> {
		if (generation !== this.#generation || !row?.publisher) return false;
		const shown = row.objectName ? companyLogoSource(row.objectName) : null;
		if (row.sourceSha256 === shown) return false;
		let objectName: string | null = null;
		if (row.sourceSha256) {
			const client = folder();
			const read = await client.read(COMPANY_LOGO_PATH, signal);
			const file = read.entry?.file;
			// The folder moved on since the cloud answered: the next sync draws the newer logo.
			if (!file || file.fileSha256 !== row.sourceSha256) return false;
			if (file.bytes > MAX_SVG_BYTES) return false;
			const svg = new TextDecoder().decode(await client.readFile(file, signal, MAX_SVG_BYTES));
			const png = await this.#rasterize(svg, COMPANY_LOGO_SIZE);
			signal.throwIfAborted();
			objectName = companyLogoName(profileId, row.sourceSha256);
			await this.#tidy(profileId, row.objectName, objectName);
			await this.#api.uploadCompanyLogo(objectName, png);
		}
		if (generation !== this.#generation) return false;
		let change: CompanyLogoChange;
		try {
			change = await this.#api.publishCompanyLogo(profileId, objectName);
		} catch (error) {
			// Not published. Once the folder has moved on, nobody can publish this drawing, so it only takes one of the four
			// places. While it still matches the folder's logo.svg, another member may be about to publish it (or the next
			// sync will), so it stays; the cloud refuses to delete it anyway once it is the logo.
			if (objectName) {
				const [again] = await this.#api.listCompanyLogos([profileId]).catch(() => []);
				if (again?.publisher && again.sourceSha256 !== row.sourceSha256)
					await this.#api.deleteCompanyLogo(objectName).catch(() => undefined);
			}
			throw error;
		}
		if (change.previousObjectName)
			await this.#api.deleteCompanyLogo(change.previousObjectName).catch(() => undefined);
		return true;
	}

	/** Makes room for an upload: deletes PNGs that are neither the logo nor `keep` once they are stale, and the oldest
	 * of them as well while the folder would still be full. A delete that fails is tried again by the next upload. */
	async #tidy(profileId: string, current: string | null, keep: string): Promise<void> {
		let objects: { objectName: string; createdAt: number }[];
		try {
			objects = await this.#api.listCompanyLogoObjects(profileId);
		} catch {
			return;
		}
		const others = objects
			.filter((object) => object.objectName !== current && object.objectName !== keep)
			.sort((a, b) => a.createdAt - b.createdAt);
		const kept = objects.length - others.length;
		const now = this.#now();
		let left = others.length;
		for (const object of others) {
			const full = kept + left >= FOLDER_CAP;
			if (!full && now - object.createdAt < STALE_MS) continue;
			await this.#api.deleteCompanyLogo(object.objectName).then(
				() => left--,
				() => undefined,
			);
		}
	}

	#ask(profileId: string): void {
		this.#entries.set(profileId, { kind: "loading" });
		this.#queue.add(profileId);
		if (this.#flushing) return;
		this.#flushing = true;
		const generation = this.#generation;
		queueMicrotask(() => void this.#flush(generation));
	}

	async #flush(generation: number): Promise<void> {
		// Asked for before a reset: the reset dropped the queue and the flag, and a newer flush serves the new account.
		if (generation !== this.#generation) return;
		try {
			while (this.#queue.size > 0 && generation === this.#generation) {
				const ids = [...this.#queue].slice(0, BATCH);
				for (const id of ids) this.#queue.delete(id);
				const revisions = new Map(ids.map((id) => [id, this.#revision(id)]));
				let rows: CompanyLogo[];
				try {
					rows = await this.#api.listCompanyLogos(ids);
				} catch (error) {
					if (generation !== this.#generation) return;
					if (error instanceof CloudRpcError && error.missing) {
						this.#available = false;
						for (const id of ids) this.#entries.set(id, { kind: "none" });
						this.#queue.clear();
						return;
					}
					for (const id of ids)
						if (this.#latest(id, generation, revisions.get(id)!))
							this.#entries.set(id, { kind: "failed", retryAt: this.#now() + RETRY_MS });
					continue;
				}
				if (generation !== this.#generation) return;
				this.#available = true;
				await Promise.all(
					ids.map((id) =>
						this.#take(
							id,
							rows.find((row) => row.profileId === id),
							generation,
							revisions.get(id)!,
						),
					),
				);
			}
		} finally {
			if (generation === this.#generation) this.#flushing = false;
		}
	}

	/** A new revision for a company, taken before asking the cloud about it: only the newest ask's answer is shown. */
	#revision(profileId: string): number {
		const revision = (this.#revisions.get(profileId) ?? 0) + 1;
		this.#revisions.set(profileId, revision);
		return revision;
	}

	#latest(profileId: string, generation: number, revision: number): boolean {
		return generation === this.#generation && this.#revisions.get(profileId) === revision;
	}

	/** Takes a company's answer to the ask of `revision`: downloads its PNG when it is new, and repaints. An answer to
	 * an older ask, which may hold an older logo or none, is dropped. */
	async #take(profileId: string, row: CompanyLogo | undefined, generation: number, revision: number): Promise<void> {
		const latest = () => this.#latest(profileId, generation, revision);
		if (!latest()) return;
		const before = this.#entries.get(profileId);
		if (!row?.objectName) {
			if (before?.kind === "logo") URL.revokeObjectURL(before.url);
			this.#entries.set(profileId, { kind: "none", ...(row ? { row } : {}) });
			this.#paint(profileId, undefined);
			return;
		}
		if (before?.kind === "logo" && before.row.objectName === row.objectName) {
			this.#entries.set(profileId, { kind: "logo", row, url: before.url });
			return;
		}
		try {
			const blob = await this.#api.downloadCompanyLogo(row.objectName);
			if (!latest()) return;
			const url = URL.createObjectURL(blob);
			const current = this.#entries.get(profileId);
			if (current?.kind === "logo") URL.revokeObjectURL(current.url);
			this.#entries.set(profileId, { kind: "logo", row, url });
			this.#paint(profileId, url);
		} catch {
			if (latest()) this.#entries.set(profileId, { kind: "failed", retryAt: this.#now() + RETRY_MS });
		}
	}

	#paint(profileId: string, url: string | undefined): void {
		const elements = this.#elements.get(profileId);
		if (!elements) return;
		for (const ref of elements) {
			const element = ref.deref();
			if (!element) elements.delete(ref);
			else paintCompanyLogo(element, url);
		}
	}
}

function canvasOf(size: number): CanvasRenderingContext2D {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const context = canvas.getContext("2d");
	if (!context) throw new PictureFileError(phrase("This browser cannot prepare pictures."));
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	return context;
}

function blobOf(context: CanvasRenderingContext2D, type: string, quality?: number): Promise<Blob | null> {
	return new Promise((resolve) => context.canvas.toBlob(resolve, type, quality));
}

/** Draws an SVG into a square PNG, kept to its own shape and centred, with what it leaves transparent. */
export async function rasterizeSvg(svg: string, size: number): Promise<Blob> {
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	try {
		const image = new Image();
		image.decoding = "async";
		image.src = url;
		await image.decode();
		const width = image.naturalWidth || size;
		const height = image.naturalHeight || size;
		const scale = Math.min(size / width, size / height);
		const context = canvasOf(size);
		context.drawImage(image, (size - width * scale) / 2, (size - height * scale) / 2, width * scale, height * scale);
		const png = await blobOf(context, "image/png");
		if (!png) throw new PictureFileError(phrase("This browser cannot prepare pictures."));
		return png;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function base64(bytes: Uint8Array): string {
	let text = "";
	for (let index = 0; index < bytes.length; index += 0x8000)
		text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(text);
}

/** A chosen picture as the logo's SVG: the crop, square, as one embedded WebP (transparency kept) or JPEG. */
export async function wrapPicture(file: File, crop?: PictureCrop): Promise<string> {
	const picture: LoadedPicture = await loadPicture(file);
	try {
		const { x, y, side } = crop ?? {
			x: (picture.width - Math.min(picture.width, picture.height)) / 2,
			y: (picture.height - Math.min(picture.width, picture.height)) / 2,
			side: Math.min(picture.width, picture.height),
		};
		for (const [size, quality] of [
			[COMPANY_LOGO_SIZE, 0.9],
			[COMPANY_LOGO_SIZE, 0.75],
			[384, 0.75],
		] as const) {
			const context = canvasOf(size);
			context.drawImage(picture.image, x, y, side, side, 0, 0, size, size);
			let blob = await blobOf(context, "image/webp", quality);
			if (blob?.type !== "image/webp") blob = await blobOf(context, "image/png");
			if (!blob) continue;
			const data = `data:${blob.type};base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><image href="${data}" width="${size}" height="${size}"/></svg>\n`;
			if (svg.length <= MAX_WRAPPED_BYTES) return svg;
		}
		throw new PictureFileError(phrase("That picture is too detailed to upload."));
	} finally {
		picture.release();
	}
}
