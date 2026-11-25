import type { CloudMemberFolderEntry } from "@qorpera/cloud-client/cloud-member-folder";
import { type StudioBinaryRef, SURFACE_LAYOUT_PATH } from "@qorpera/contracts";
import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError } from "../cloud/client.ts";
import type { WebMemberFolder } from "../cloud/company-folder-writes.ts";
import {
	COMPANY_IDENTITY_LOGO_PATH,
	type CompanyLogo,
	type CompanyLogoChange,
	companyLogoName,
	companyLogoSource,
} from "../cloud/company-logos.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import { type CompanyLogoStore, paintCompanyLogo } from "../ui/company-logos.ts";
import { type LoadedPicture, loadPicture, type PictureCrop, PictureFileError } from "../ui/picture-file.ts";
import { phrase } from "../ui/preferences.ts";
import {
	activeLogoTheme,
	type CompanyIdentityLogoAsset,
	CompanyIdentityLogoCache,
	type LogoFolderReader,
	logoBytesToDataUrl,
	logoCandidatePaths,
	logoForTheme,
	logoRasterMediaType,
	logoSourceCandidates,
	logoSvgToDataUrl,
	type ResolvedCompanyIdentityLogos,
	readFolderEntries,
	resolveCompanyIdentityLogos,
} from "./company-identity-logo.ts";
import {
	type CompanyIdentityFiles,
	type IdentityWordmarkStatus,
	identityWordmarkStatus,
	type SurfacesStore,
} from "./surfaces-store.ts";

type Entry =
	| { kind: "loading" }
	| { kind: "none"; row?: CompanyLogo }
	| { kind: "logo"; row: CompanyLogo; url: string }
	| { kind: "failed"; retryAt: number };

type LiveOverride =
	| { readonly kind: "url"; readonly url: string; readonly identityAtMutation: CompanyIdentityFiles | null }
	| { readonly kind: "none"; readonly identityAtMutation: CompanyIdentityFiles | null };

interface LiveIdentityBinding {
	readonly profileId: string;
	readonly store: SurfacesStore;
	readonly signal: AbortSignal;
	readonly disabled: boolean;
	readonly onBaseLogoChange?: () => void;
	readonly blobUrls: Map<string, string>;
	readonly binaryDataUrls: Map<string, string>;
	readonly pendingReads: Set<string>;
	readonly failedReads: Map<string, number>;
	readonly retryTimers: Map<string, ReturnType<typeof setTimeout>>;
	status: IdentityWordmarkStatus;
	identity: CompanyIdentityFiles | null;
	resolved: ResolvedCompanyIdentityLogos;
	override: LiveOverride | undefined;
	lastBaseSignature: string | undefined;
	cleanup: () => void;
}

const RETRY_MS = 60_000;
const STALE_MS = 10 * 60_000;
const FOLDER_CAP = 4;
const BATCH = 100;
export const COMPANY_LOGO_SIZE = 512;
const MAX_SVG_BYTES = 512 * 1024;
const MAX_RASTER_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_WRAPPED_BYTES = 360 * 1024;
const SVG_FILE_RE = /\.svg$/i;

export interface CompanyLogosOptions {
	rasterize?: (svg: string, size: number) => Promise<Blob>;
	rasterizeImage?: (bytes: Uint8Array, mediaType: string, size: number) => Promise<Blob>;
	wrap?: (file: File, crop?: PictureCrop) => Promise<string>;
	now?: () => number;
	scope?: string;
}

function parentAncestors(path: string): string[] {
	const parts = path.split("/").filter(Boolean);
	const dirs: string[] = [];
	for (let index = 1; index < parts.length; index++) {
		dirs.push(parts.slice(0, index).join("/"));
	}
	return dirs;
}

function liveBinaryShas(resolved: ResolvedCompanyIdentityLogos): Set<string> {
	const shas = new Set<string>();
	for (const asset of [resolved.light, resolved.dark, resolved.baseLight, resolved.baseDark]) {
		if (asset?.kind === "binary") shas.add(asset.ref.fileSha256);
	}
	return shas;
}

function liveBinaryRefs(resolved: ResolvedCompanyIdentityLogos): StudioBinaryRef[] {
	const seen = new Set<string>();
	const refs: StudioBinaryRef[] = [];
	for (const asset of [resolved.light, resolved.dark, resolved.baseLight, resolved.baseDark]) {
		if (asset?.kind !== "binary" || seen.has(asset.ref.fileSha256)) continue;
		seen.add(asset.ref.fileSha256);
		refs.push(asset.ref);
	}
	return refs;
}

export class CompanyLogos implements CompanyLogoStore {
	readonly #api: CloudApi;
	readonly #rasterize: (svg: string, size: number) => Promise<Blob>;
	readonly #rasterizeImage: (bytes: Uint8Array, mediaType: string, size: number) => Promise<Blob>;
	readonly #wrap: (file: File, crop?: PictureCrop) => Promise<string>;
	readonly #now: () => number;
	readonly #identityCache: CompanyIdentityLogoCache;
	readonly #entries = new Map<string, Entry>();
	readonly #elements = new Map<string, Set<WeakRef<HTMLElement>>>();
	readonly #subscribers = new Map<string, Set<() => void>>();
	readonly #cacheUnsubs = new Map<string, () => void>();
	readonly #identityLive = new Map<string, LiveIdentityBinding>();
	readonly #failedUrls = new Map<string, Set<string>>();
	readonly #queue = new Set<string>();
	readonly #syncing = new Map<string, Promise<void>>();
	readonly #revisions = new Map<string, number>();
	readonly #onThemeChange = (): void => {
		const ids = new Set<string>([...this.#elements.keys(), ...this.#subscribers.keys()]);
		for (const id of ids) this.#repaint(id);
	};
	#flushing = false;
	#generation = 0;
	#available: boolean | undefined;
	#syncingIdentityCache = false;

	constructor(api: CloudApi, options: CompanyLogosOptions = {}) {
		this.#api = api;
		this.#rasterize = options.rasterize ?? rasterizeSvg;
		this.#rasterizeImage = options.rasterizeImage ?? rasterizeImage;
		this.#wrap = options.wrap ?? wrapPicture;
		this.#now = options.now ?? Date.now;
		this.#identityCache = new CompanyIdentityLogoCache(options.scope ?? "", this.#now);
		if (typeof window !== "undefined") window.addEventListener("qorpera-theme-change", this.#onThemeChange);
	}

	setAccount(userId: string | undefined, clearPreviousStorage = false): void {
		this.reset();
		this.#identityCache.setAccount(userId, clearPreviousStorage);
		const ids = new Set<string>([...this.#elements.keys(), ...this.#subscribers.keys()]);
		for (const id of ids) this.#repaint(id);
	}

	forget(profileId: string): void {
		const id = profileId.toLowerCase();
		this.#identityLive.get(id)?.cleanup();
		this.#identityCache.forget(id);
		this.#failedUrls.delete(id);
		const entry = this.#entries.get(id);
		if (entry?.kind === "logo") URL.revokeObjectURL(entry.url);
		this.#entries.delete(id);
		this.#repaint(id);
	}

	attach(element: HTMLElement, rawProfileId: string): void {
		if (!UUID_PATTERN.test(rawProfileId)) return;
		const profileId = rawProfileId.toLowerCase();
		let elements = this.#elements.get(profileId);
		if (!elements) {
			elements = new Set();
			this.#elements.set(profileId, elements);
		}
		if (elements.size >= 32) for (const ref of elements) if (!ref.deref()) elements.delete(ref);
		elements.add(new WeakRef(element));
		this.#ensureCacheSubscription(profileId);
		const url = this.#resolvedUrl(profileId);
		if (url) paintCompanyLogo(element, url, (failed) => this.#onImageError(profileId, failed));
		if (this.#available === false) return;
		const entry = this.#entries.get(profileId);
		if (!entry || (entry.kind === "failed" && this.#now() >= entry.retryAt)) this.#ask(profileId);
	}

	subscribe(rawProfileId: string, listener: () => void): () => void {
		const id = rawProfileId.toLowerCase();
		let listeners = this.#subscribers.get(id);
		if (!listeners) {
			listeners = new Set();
			this.#subscribers.set(id, listeners);
		}
		listeners.add(listener);
		this.#ensureCacheSubscription(id);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) {
				this.#subscribers.delete(id);
				this.#pruneCacheSubscription(id);
			}
		};
	}

	logo(profileId: string): CompanyLogo | undefined {
		const entry = this.#entries.get(profileId.toLowerCase());
		return entry?.kind === "logo" || entry?.kind === "none" ? entry.row : undefined;
	}

	hasLogo(profileId: string): boolean {
		const id = profileId.toLowerCase();
		if (this.#resolvedUrl(id)) return true;
		const live = this.#identityLive.get(id);
		if (live?.override) return live.override.kind === "url";
		if (live?.resolved.baseHasLogo) return true;
		return Boolean(this.logo(id)?.objectName);
	}

	bindIdentity(
		rawProfileId: string,
		store: SurfacesStore,
		signal: AbortSignal,
		options?: {
			readonly disabled?: boolean;
			readonly onBaseLogoChange?: () => void;
		},
	): () => void {
		const id = rawProfileId.toLowerCase();
		if (signal.aborted) return () => {};
		this.#identityLive.get(id)?.cleanup();
		const binding: LiveIdentityBinding = {
			profileId: id,
			store,
			signal,
			disabled: options?.disabled === true,
			...(options?.onBaseLogoChange ? { onBaseLogoChange: options.onBaseLogoChange } : {}),
			blobUrls: new Map(),
			binaryDataUrls: new Map(),
			pendingReads: new Set(),
			failedReads: new Map(),
			retryTimers: new Map(),
			status: "loading",
			identity: null,
			resolved: resolveCompanyIdentityLogos(null),
			override: undefined,
			lastBaseSignature: undefined,
			cleanup: () => {},
		};
		const onStoreChange = () => this.#updateLiveBinding(binding);
		const unsubscribe = store.store.subscribe(onStoreChange);
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			unsubscribe();
			signal.removeEventListener("abort", cleanup);
			for (const timer of binding.retryTimers.values()) clearTimeout(timer);
			binding.retryTimers.clear();
			for (const url of binding.blobUrls.values()) URL.revokeObjectURL(url);
			binding.blobUrls.clear();
			binding.binaryDataUrls.clear();
			binding.pendingReads.clear();
			binding.failedReads.clear();
			if (this.#identityLive.get(id) === binding) {
				this.#identityLive.delete(id);
				this.#repaint(id);
			}
		};
		binding.cleanup = cleanup;
		this.#identityLive.set(id, binding);
		signal.addEventListener("abort", cleanup, { once: true });
		this.#updateLiveBinding(binding);
		return cleanup;
	}

	prefetchIdentity(
		profileId: string,
		createFolder: (signal: AbortSignal) => LogoFolderReader,
		signal?: AbortSignal,
	): Promise<void> {
		const id = profileId.toLowerCase();
		this.#ensureCacheSubscription(id);
		return this.#identityCache.prefetch(id, createFolder, signal);
	}

	prefetchManyIdentity(
		targets: readonly {
			readonly profileId: string;
			readonly createFolder: (signal: AbortSignal) => LogoFolderReader;
		}[],
		signal?: AbortSignal,
	): Promise<void> {
		for (const target of targets) this.#ensureCacheSubscription(target.profileId.toLowerCase());
		return this.#identityCache.prefetchMany(targets, signal);
	}

	reset(): void {
		this.#generation++;
		for (const binding of [...this.#identityLive.values()]) binding.cleanup();
		this.#identityLive.clear();
		this.#identityCache.clearEntries();
		for (const unsub of this.#cacheUnsubs.values()) unsub();
		this.#cacheUnsubs.clear();
		this.#failedUrls.clear();
		for (const entry of this.#entries.values()) if (entry.kind === "logo") URL.revokeObjectURL(entry.url);
		this.#entries.clear();
		this.#queue.clear();
		this.#syncing.clear();
		this.#revisions.clear();
		this.#flushing = false;
		this.#available = undefined;
		for (const [profileId] of this.#elements) this.#paintElements(profileId, undefined);
		this.#elements.clear();
		for (const [profileId] of this.#subscribers) this.#notifySubscribers(profileId);
	}

	dispose(): void {
		if (typeof window !== "undefined") window.removeEventListener("qorpera-theme-change", this.#onThemeChange);
		this.#identityCache.dispose();
		this.reset();
		this.#subscribers.clear();
	}

	async refresh(profileId: string): Promise<CompanyLogo | undefined> {
		const id = profileId.toLowerCase();
		const generation = this.#generation;
		const revision = this.#revision(id);
		let row: CompanyLogo | undefined;
		try {
			[row] = await this.#api.listCompanyLogos([id]);
		} catch {
			if (this.#latest(id, generation, revision)) this.#fail(id);
			return undefined;
		}
		if (generation !== this.#generation) return undefined;
		await this.#take(id, row, generation, revision);
		return row;
	}

	sync(profileId: string, folder: () => WebMemberFolder, signal: AbortSignal): Promise<void> {
		return this.#start(profileId.toLowerCase(), folder, signal, false);
	}

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

	async choose(
		profileId: string,
		file: File,
		crop: PictureCrop | undefined,
		folder: () => WebMemberFolder,
		signal: AbortSignal,
	): Promise<void> {
		const id = profileId.toLowerCase();
		const svg = await this.#wrap(file, crop);
		signal.throwIfAborted();
		const client = folder();
		const { writePath, darkClearPaths } = await this.#resolveWriteTargets(id, client, signal);
		const read = await client.read(writePath, signal);
		const mkdirUnits: { op: "mkdir"; path: string }[] = [];
		if (!read.entry) {
			const ancestors = parentAncestors(writePath);
			const existingDirs = await readFolderEntries(client, ancestors, signal);
			for (let index = 0; index < ancestors.length; index++) {
				if (!existingDirs?.[index]?.entry) mkdirUnits.push({ op: "mkdir", path: ancestors[index]! });
			}
		}
		const deleteDarkUnits = await this.#deleteUnitsFor(client, darkClearPaths, signal);
		const answer = await client.commit(
			`company-logo-${crypto.randomUUID()}`,
			[
				...mkdirUnits,
				{
					op: "write" as const,
					path: writePath,
					text: svg,
					...(read.entry?.version ? { expectedVersion: read.entry.version } : {}),
				},
				...deleteDarkUnits,
			],
			signal,
		);
		const unsaved = answer.units.find((unit) => unit.outcome !== "saved");
		if (unsaved) throw new Error(phrase("The logo could not be saved. Try again."));
		const svgUrl = logoSvgToDataUrl(svg);
		if (svgUrl) {
			this.#failedUrls.delete(id);
			const live = this.#identityLive.get(id);
			if (live) live.override = { kind: "url", url: svgUrl, identityAtMutation: live.identity };
			this.#syncingIdentityCache = true;
			try {
				this.#identityCache.set(id, { light: svgUrl, dark: svgUrl }, "live");
			} finally {
				this.#syncingIdentityCache = false;
			}
			this.#repaint(id);
		}
		await this.#start(id, folder, signal, true);
	}

	async remove(profileId: string, folder: () => WebMemberFolder, signal: AbortSignal): Promise<void> {
		const id = profileId.toLowerCase();
		const client = folder();
		const { removePaths } = await this.#resolveWriteTargets(id, client, signal);
		const deleteUnits = await this.#deleteUnitsFor(client, removePaths, signal);
		if (deleteUnits.length > 0) {
			const answer = await client.commit(`company-logo-${crypto.randomUUID()}`, deleteUnits, signal);
			if (answer.units.some((unit) => unit.outcome !== "saved"))
				throw new Error(phrase("The logo could not be removed. Try again."));
		}
		this.#failedUrls.delete(id);
		const live = this.#identityLive.get(id);
		if (live) live.override = { kind: "none", identityAtMutation: live.identity };
		this.#syncingIdentityCache = true;
		try {
			this.#identityCache.setNone(id, "live");
		} finally {
			this.#syncingIdentityCache = false;
		}
		this.#repaint(id);
		await this.#start(id, folder, signal, true);
	}

	async #resolveWriteTargets(
		id: string,
		client: WebMemberFolder,
		signal: AbortSignal,
	): Promise<{ writePath: string; darkClearPaths: readonly string[]; removePaths: readonly string[] }> {
		const live = this.#identityLive.get(id);
		if (live && live.status === "settled") {
			return {
				writePath: live.resolved.writePath,
				darkClearPaths: live.resolved.darkClearPaths,
				removePaths: live.resolved.removePaths,
			};
		}
		let layoutText: string | undefined;
		try {
			const layoutRead = await client.read(`identity/${SURFACE_LAYOUT_PATH}`, signal);
			const layoutFile = layoutRead.entry?.kind === "file" ? layoutRead.entry.file : undefined;
			if (layoutFile && layoutFile.bytes > 0 && layoutFile.bytes <= MAX_SVG_BYTES) {
				const bytes = await client.readFile(layoutFile, signal, MAX_SVG_BYTES, { cached: true });
				layoutText = new TextDecoder().decode(bytes);
			}
		} catch {
			if (signal.aborted) throw signal.reason;
		}
		const candidates = logoCandidatePaths(layoutText, "identity");
		return {
			writePath: candidates.writePath || COMPANY_IDENTITY_LOGO_PATH,
			darkClearPaths: candidates.darkClearPaths,
			removePaths: candidates.removePaths,
		};
	}

	async #deleteUnitsFor(
		client: WebMemberFolder,
		paths: readonly string[],
		signal: AbortSignal,
	): Promise<{ op: "delete"; path: string; expectedVersion?: string }[]> {
		if (paths.length === 0) return [];
		const reads = await readFolderEntries(client, paths, signal);
		const seen = new Set<string>();
		const units: { op: "delete"; path: string; expectedVersion?: string }[] = [];
		for (let index = 0; index < paths.length; index++) {
			const entry = reads?.[index]?.entry;
			if (!entry || entry.kind !== "file") continue;
			const targetPath = entry.path || paths[index]!;
			const key = targetPath.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			units.push({
				op: "delete",
				path: targetPath,
				...(entry.version ? { expectedVersion: entry.version } : {}),
			});
		}
		return units;
	}

	#updateLiveBinding(binding: LiveIdentityBinding): void {
		if (binding.signal.aborted) return;
		const prevUrl = this.#resolvedUrl(binding.profileId);
		const prevHas = this.hasLogo(binding.profileId);
		const nextStatus = identityWordmarkStatus(binding.store, binding.disabled);
		const nextIdentity = binding.store.companyIdentityFiles();
		const nextResolved = resolveCompanyIdentityLogos(nextIdentity);
		if (binding.override && nextIdentity !== binding.override.identityAtMutation) {
			binding.override = undefined;
		}
		const resolvedChanged = nextResolved !== binding.resolved;
		binding.status = nextStatus;
		binding.identity = nextIdentity;
		binding.resolved = nextResolved;
		if (resolvedChanged) {
			this.#failedUrls.delete(binding.profileId);
			binding.failedReads.clear();
			for (const timer of binding.retryTimers.values()) clearTimeout(timer);
			binding.retryTimers.clear();
			this.#pruneBindingBinaries(binding);
		}
		for (const ref of liveBinaryRefs(nextResolved)) this.#ensureBindingBinary(binding, ref);
		this.#syncBindingCache(binding);
		if (nextStatus === "settled") {
			const prevBase = binding.lastBaseSignature;
			binding.lastBaseSignature = nextResolved.baseSignature;
			if (prevBase !== undefined && prevBase !== nextResolved.baseSignature) {
				binding.onBaseLogoChange?.();
			}
		}
		if (this.#resolvedUrl(binding.profileId) !== prevUrl || this.hasLogo(binding.profileId) !== prevHas) {
			this.#repaint(binding.profileId);
		}
	}

	#syncBindingCache(binding: LiveIdentityBinding): void {
		if (binding.status !== "settled" || binding.override) return;
		const { baseLight, baseDark } = binding.resolved;
		const waitForBinary = (asset: CompanyIdentityLogoAsset | undefined): boolean =>
			asset?.kind === "binary" &&
			!binding.binaryDataUrls.has(asset.ref.fileSha256) &&
			(binding.pendingReads.has(asset.ref.fileSha256) ||
				binding.failedReads.has(asset.ref.fileSha256) ||
				!binding.blobUrls.has(asset.ref.fileSha256));
		if (waitForBinary(baseLight) || waitForBinary(baseDark)) return;
		const lightUrl =
			baseLight?.kind === "svg"
				? baseLight.src
				: baseLight?.kind === "binary"
					? binding.binaryDataUrls.get(baseLight.ref.fileSha256)
					: undefined;
		const darkUrl =
			baseDark?.kind === "svg"
				? baseDark.src
				: baseDark?.kind === "binary"
					? binding.binaryDataUrls.get(baseDark.ref.fileSha256)
					: undefined;
		this.#syncingIdentityCache = true;
		try {
			if (lightUrl || darkUrl) {
				this.#identityCache.set(
					binding.profileId,
					{ ...(lightUrl ? { light: lightUrl } : {}), ...(darkUrl ? { dark: darkUrl } : {}) },
					"live",
				);
			} else if (!baseLight && !baseDark) {
				this.#identityCache.setNone(binding.profileId, "live");
			}
		} finally {
			this.#syncingIdentityCache = false;
		}
	}

	resumeIdentity(profileId: string): void {
		const binding = this.#identityLive.get(profileId);
		if (!binding || binding.signal.aborted || binding.store.suspended) return;
		binding.failedReads.clear();
		for (const timer of binding.retryTimers.values()) clearTimeout(timer);
		binding.retryTimers.clear();
		for (const ref of liveBinaryRefs(binding.resolved)) this.#ensureBindingBinary(binding, ref);
	}

	#ensureBindingBinary(binding: LiveIdentityBinding, ref: StudioBinaryRef): void {
		const sha = ref.fileSha256;
		const retryAt = binding.failedReads.get(sha);
		if (
			binding.store.suspended ||
			binding.blobUrls.has(sha) ||
			binding.pendingReads.has(sha) ||
			(retryAt !== undefined && this.#now() < retryAt)
		) {
			return;
		}
		binding.failedReads.delete(sha);
		binding.pendingReads.add(sha);
		binding.store
			.readStudioBinary(ref, binding.signal)
			.then(
				(bytes) => {
					if (binding.signal.aborted || binding.store.suspended || !liveBinaryShas(binding.resolved).has(sha))
						return;
					const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: ref.mediaType }));
					binding.blobUrls.set(sha, url);
					const mime = logoRasterMediaType("", ref.mediaType);
					const dataUrl = mime ? logoBytesToDataUrl(bytes, mime) : undefined;
					if (dataUrl) binding.binaryDataUrls.set(sha, dataUrl);
					binding.pendingReads.delete(sha);
					this.#syncBindingCache(binding);
					this.#repaint(binding.profileId);
				},
				() => {
					if (binding.signal.aborted || binding.store.suspended) return;
					binding.pendingReads.delete(sha);
					binding.failedReads.set(sha, this.#now() + RETRY_MS);
					if (liveBinaryShas(binding.resolved).has(sha)) this.#scheduleBindingRetry(binding, ref);
					this.#repaint(binding.profileId);
				},
			)
			.finally(() => {
				binding.pendingReads.delete(sha);
			});
	}

	#scheduleBindingRetry(binding: LiveIdentityBinding, ref: StudioBinaryRef): void {
		const sha = ref.fileSha256;
		const existing = binding.retryTimers.get(sha);
		if (existing !== undefined) clearTimeout(existing);
		binding.retryTimers.set(
			sha,
			setTimeout(() => {
				binding.retryTimers.delete(sha);
				if (binding.signal.aborted || !liveBinaryShas(binding.resolved).has(sha)) return;
				this.#ensureBindingBinary(binding, ref);
			}, RETRY_MS),
		);
	}

	#pruneBindingBinaries(binding: LiveIdentityBinding): void {
		const keep = liveBinaryShas(binding.resolved);
		for (const [sha, url] of binding.blobUrls) {
			if (keep.has(sha)) continue;
			URL.revokeObjectURL(url);
			binding.blobUrls.delete(sha);
		}
		for (const sha of binding.binaryDataUrls.keys()) {
			if (!keep.has(sha)) binding.binaryDataUrls.delete(sha);
		}
	}

	#assetUrl(binding: LiveIdentityBinding, asset: CompanyIdentityLogoAsset | undefined): string | undefined {
		if (!asset) return undefined;
		if (asset.kind === "svg") return asset.src;
		return binding.blobUrls.get(asset.ref.fileSha256);
	}

	#ensureCacheSubscription(id: string): void {
		if (this.#cacheUnsubs.has(id)) return;
		const unsub = this.#identityCache.subscribe(id, () => {
			if (this.#syncingIdentityCache) return;
			this.#failedUrls.delete(id);
			this.#repaint(id);
		});
		this.#cacheUnsubs.set(id, unsub);
	}

	#pruneCacheSubscription(id: string): void {
		const hasElements = (this.#elements.get(id)?.size ?? 0) > 0;
		const hasSubscribers = (this.#subscribers.get(id)?.size ?? 0) > 0;
		if (hasElements || hasSubscribers) return;
		this.#cacheUnsubs.get(id)?.();
		this.#cacheUnsubs.delete(id);
	}

	async #sync(profileId: string, folder: () => WebMemberFolder, signal: AbortSignal): Promise<void> {
		if (this.#available === false) return;
		const generation = this.#generation;
		const revision = this.#revision(profileId);
		let row: CompanyLogo | undefined;
		try {
			[row] = await this.#api.listCompanyLogos([profileId]);
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) this.#available = false;
			else if (this.#latest(profileId, generation, revision)) this.#fail(profileId);
			return;
		}
		let published = false;
		try {
			published = await this.#publish(profileId, row, folder, signal, generation);
		} finally {
			if (!published) await this.#take(profileId, row, generation, revision);
		}
		if (published) await this.refresh(profileId);
	}

	async #readMatchingSource(
		client: WebMemberFolder,
		profileId: string,
		row: CompanyLogo,
		signal: AbortSignal,
	): Promise<{ path: string; entry: CloudMemberFolderEntry } | null> {
		const targetSha = row.sourceSha256;
		if (!targetSha) return null;
		const checked = new Set<string>();
		if (row.sourcePath) {
			checked.add(row.sourcePath.toLowerCase());
			const direct = await client.read(row.sourcePath, signal);
			if (direct.entry?.kind === "file" && direct.entry.file?.fileSha256 === targetSha) {
				return { path: direct.entry.path || row.sourcePath, entry: direct.entry };
			}
		}
		const extraRoot = this.#identityLive.get(profileId)?.resolved.folderRoot;
		const remaining = logoSourceCandidates(extraRoot).filter((path) => !checked.has(path.toLowerCase()));
		if (remaining.length === 0) return null;
		const reads = await readFolderEntries(client, remaining, signal);
		if (!reads) return null;
		for (let index = 0; index < remaining.length; index++) {
			const entry = reads[index]?.entry;
			if (entry?.kind === "file" && entry.file?.fileSha256 === targetSha) {
				return { path: entry.path || remaining[index]!, entry };
			}
		}
		return null;
	}

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
			const matched = await this.#readMatchingSource(client, profileId, row, signal);
			const file = matched?.entry.file;
			if (!matched || !file || file.fileSha256 !== row.sourceSha256) return false;
			const isSvg = SVG_FILE_RE.test(matched.path) || file.mediaType.trim().toLowerCase() === "image/svg+xml";
			let png: Blob;
			if (isSvg) {
				if (file.bytes > MAX_SVG_BYTES) return false;
				const svg = new TextDecoder().decode(await client.readFile(file, signal, MAX_SVG_BYTES, { cached: true }));
				png = await this.#rasterize(svg, COMPANY_LOGO_SIZE);
			} else {
				const mediaType = logoRasterMediaType(matched.path, file.mediaType);
				if (!mediaType || file.bytes > MAX_RASTER_SOURCE_BYTES) return false;
				const bytes = await client.readFile(file, signal, MAX_RASTER_SOURCE_BYTES, { cached: true });
				png = await this.#rasterizeImage(bytes, mediaType, COMPANY_LOGO_SIZE);
			}
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
					for (const id of ids) if (this.#latest(id, generation, revisions.get(id)!)) this.#fail(id);
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

	#revision(profileId: string): number {
		const revision = (this.#revisions.get(profileId) ?? 0) + 1;
		this.#revisions.set(profileId, revision);
		return revision;
	}

	#latest(profileId: string, generation: number, revision: number): boolean {
		return generation === this.#generation && this.#revisions.get(profileId) === revision;
	}

	async #take(profileId: string, row: CompanyLogo | undefined, generation: number, revision: number): Promise<void> {
		const latest = () => this.#latest(profileId, generation, revision);
		if (!latest()) return;
		const before = this.#entries.get(profileId);
		if (!row?.objectName) {
			if (before?.kind === "logo") URL.revokeObjectURL(before.url);
			this.#entries.set(profileId, { kind: "none", ...(row ? { row } : {}) });
			this.#repaint(profileId);
			return;
		}
		if (before?.kind === "logo" && before.row.objectName === row.objectName) {
			this.#entries.set(profileId, { kind: "logo", row, url: before.url });
			this.#repaint(profileId);
			return;
		}
		try {
			const blob = await this.#api.downloadCompanyLogo(row.objectName);
			if (!latest()) return;
			const url = URL.createObjectURL(blob);
			const current = this.#entries.get(profileId);
			if (current?.kind === "logo") URL.revokeObjectURL(current.url);
			this.#entries.set(profileId, { kind: "logo", row, url });
			this.#repaint(profileId);
		} catch {
			if (latest()) this.#fail(profileId);
		}
	}

	#fail(profileId: string): void {
		const before = this.#entries.get(profileId);
		if (before?.kind === "logo") {
			URL.revokeObjectURL(before.url);
		}
		this.#entries.set(profileId, { kind: "failed", retryAt: this.#now() + RETRY_MS });
		this.#repaint(profileId);
	}

	#onImageError(profileId: string, failedUrl: string): void {
		let set = this.#failedUrls.get(profileId);
		if (!set) {
			set = new Set();
			this.#failedUrls.set(profileId, set);
		}
		if (set.has(failedUrl)) return;
		set.add(failedUrl);
		this.#repaint(profileId);
	}

	#resolvedUrl(profileId: string): string | undefined {
		const theme = activeLogoTheme();
		const failed = this.#failedUrls.get(profileId);
		const usable = (url: string | undefined): string | undefined => (url && !failed?.has(url) ? url : undefined);
		const cloudEntry = this.#entries.get(profileId);
		const cloudUrl = cloudEntry?.kind === "logo" ? usable(cloudEntry.url) : undefined;
		const cached = this.#identityCache.get(profileId);
		const cachedRaw = cached ? logoForTheme(cached, theme) : undefined;
		const cachedUrl = usable(cachedRaw);
		const live = this.#identityLive.get(profileId);
		if (live) {
			if (live.override) return live.override.kind === "url" ? usable(live.override.url) : undefined;
			const asset = logoForTheme(live.resolved, theme);
			const liveUrl = usable(this.#assetUrl(live, asset));
			const binaryPending =
				asset?.kind === "binary" &&
				!live.blobUrls.has(asset.ref.fileSha256) &&
				!live.failedReads.has(asset.ref.fileSha256);
			if (live.status === "loading") return cachedUrl ?? cloudUrl;
			if (live.status === "preview-loading") return cached ? (cachedUrl ?? cloudUrl) : (liveUrl ?? cloudUrl);
			if (liveUrl) return liveUrl;
			if (binaryPending) return cachedUrl ?? cloudUrl;
			if (live.resolved.light || live.resolved.dark || live.resolved.baseHasLogo) return undefined;
			return cloudUrl;
		}
		if (cached) {
			const cloudUpdated =
				cloudEntry?.kind === "logo" && cloudEntry.row.updatedAt ? Date.parse(cloudEntry.row.updatedAt) : Number.NaN;
			const cacheFresh = !Number.isFinite(cloudUpdated) || (cached.cachedAt ?? 0) >= cloudUpdated;
			if (cacheFresh) {
				if (cachedUrl) return cachedUrl;
				if (cachedRaw) return cloudUrl;
				return undefined;
			}
		}
		return cloudUrl;
	}

	#repaint(profileId: string): void {
		this.#paintElements(profileId, this.#resolvedUrl(profileId));
		this.#notifySubscribers(profileId);
	}

	#paintElements(profileId: string, url: string | undefined): void {
		const elements = this.#elements.get(profileId);
		if (!elements) return;
		const onError = url ? (failed: string) => this.#onImageError(profileId, failed) : undefined;
		for (const ref of elements) {
			const element = ref.deref();
			if (!element) elements.delete(ref);
			else paintCompanyLogo(element, url, onError);
		}
		if (elements.size === 0) {
			this.#elements.delete(profileId);
			this.#pruneCacheSubscription(profileId);
		}
	}

	#notifySubscribers(profileId: string): void {
		const listeners = this.#subscribers.get(profileId);
		if (!listeners) return;
		for (const listener of [...listeners]) listener();
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

export async function rasterizeImage(bytes: Uint8Array, mediaType: string, size: number): Promise<Blob> {
	const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
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

export async function rasterizeSvg(svg: string, size: number): Promise<Blob> {
	return rasterizeImage(new TextEncoder().encode(svg), "image/svg+xml", size);
}

function base64(bytes: Uint8Array): string {
	let text = "";
	for (let index = 0; index < bytes.length; index += 0x8000)
		text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(text);
}

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
