import {
	isProgramFileName,
	PROGRAM_FILE,
	PROGRAM_KINDS,
	type Program,
	type ProgramForm,
	type ProgramKeptForm,
	type ProgramKind,
	type ProgramVersion,
	parseProgram,
	programFilePath,
	programFormsInOrder,
	writeProgram,
} from "@qorpera/cloud-client/app-program";
import {
	CLOUD_MEMBER_FOLDER_UPLOAD_MAX_BYTES,
	type CloudMemberFolderClient,
	type CloudMemberFolderCommit,
	CloudMemberFolderError,
	type CloudMemberFolderUnit,
	type CloudMemberFolderUploadFile,
	prepareCloudMemberFolderUpload,
} from "@qorpera/cloud-client/cloud-member-folder";
import {
	APP_DEFAULT_EMBLEM,
	APP_DEFAULT_ENTRY,
	APP_MANIFEST,
	APP_NAME_MAX_CHARS,
	APPS_FOLDER,
	writeAppManifest,
} from "@qorpera/cloud-client/interface-apps";

export const PROGRAM_ADD_MAX_BYTES = CLOUD_MEMBER_FOLDER_UPLOAD_MAX_BYTES;
export const MEMBER_TEXT_MAX_BYTES = 64 * 1024;
const FOLDER_NAME_MAX = 48;
const TRIES = 3;

const ENDINGS: readonly (readonly [string, ProgramKind])[] = [
	[".apk", "android"],
	[".ipa", "iphone"],
	[".exe", "windows"],
	[".msi", "windows"],
	[".dmg", "mac"],
	[".pkg", "mac"],
	[".appimage", "linux"],
	[".deb", "linux"],
	[".rpm", "linux"],
	[".flatpak", "linux"],
	[".tar.gz", "linux"],
	[".tar.xz", "linux"],
	[".tgz", "linux"],
];
const EXTRA_WORDS = new Set([
	"setup",
	"installer",
	"install",
	"x64",
	"x86",
	"x86_64",
	"amd64",
	"arm64",
	"aarch64",
	"win64",
	"win32",
	"universal",
	"release",
	"signed",
	"unsigned",
]);
const VERSION_WORD = /^v?\d+(?:[._]\d+)*(?:-?(?:rc|beta|alpha)\.?\d*)?$/i;
const DANISH: Readonly<Record<string, string>> = { æ: "ae", ø: "oe", å: "aa" };

export function programKindOf(fileName: string): ProgramKind | null {
	const lower = fileName.toLowerCase();
	return ENDINGS.find(([ending]) => lower.endsWith(ending) && lower.length > ending.length)?.[1] ?? null;
}

function withoutEnding(fileName: string): string {
	const lower = fileName.toLowerCase();
	const known = ENDINGS.find(([ending]) => lower.endsWith(ending) && lower.length > ending.length)?.[0];
	if (known) return fileName.slice(0, -known.length);
	const dot = fileName.lastIndexOf(".");
	return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function programNameOf(fileName: string): string {
	const base = withoutEnding(fileName).trim();
	const words = base.split(/[\s_.-]+/).filter(Boolean);
	while (words.length > 1) {
		const last = words.at(-1) ?? "";
		if (!VERSION_WORD.test(last) && !EXTRA_WORDS.has(last.toLowerCase())) break;
		words.pop();
	}
	const name = (
		words.length === 1 && VERSION_WORD.test(words[0] ?? "") ? base : words.join(" ") || base || fileName
	).trim();
	return [...name].slice(0, APP_NAME_MAX_CHARS).join("").trim() || fileName;
}

export function programFolderName(name: string, taken: ReadonlySet<string>): string {
	const slug =
		name
			.toLowerCase()
			.replace(/[æøå]/g, (letter) => DANISH[letter] ?? letter)
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, FOLDER_NAME_MAX)
			.replace(/-+$/g, "") || "program";
	if (!taken.has(slug)) return slug;
	for (let n = 2; ; n++) {
		const free = `${slug}-${n}`;
		if (!taken.has(free)) return free;
	}
}

export function nextMemberVersion(program: Pick<Program, "versions"> | null): string {
	const kept = new Set(program?.versions.map((each) => each.version) ?? []);
	for (let n = 1; ; n++) if (!kept.has(String(n))) return String(n);
}

export interface DroppedFile {
	readonly file: File;
	readonly kind: ProgramKind | null;
}

export type DropProblem =
	| { readonly problem: "none" }
	| { readonly problem: "many" }
	| { readonly problem: "empty"; readonly name: string }
	| { readonly problem: "large"; readonly name: string; readonly bytes: number }
	| { readonly problem: "name"; readonly name: string }
	| { readonly problem: "twice"; readonly kind: ProgramKind };

export function readDrop(files: readonly File[]): { readonly files: DroppedFile[] } | DropProblem {
	if (files.length === 0) return { problem: "none" };
	if (files.length > PROGRAM_KINDS.length) return { problem: "many" };
	const dropped: DroppedFile[] = [];
	for (const file of files) {
		if (file.size < 1) return { problem: "empty", name: file.name };
		if (file.size > PROGRAM_ADD_MAX_BYTES) return { problem: "large", name: file.name, bytes: file.size };
		if (!isProgramFileName(file.name)) return { problem: "name", name: file.name };
		dropped.push({ file, kind: programKindOf(file.name) });
	}
	const twice = sameKind(dropped);
	return twice ? { problem: "twice", kind: twice } : { files: dropped };
}

export function sameKind(files: readonly DroppedFile[]): ProgramKind | null {
	const seen = new Set<ProgramKind>();
	for (const { kind } of files) {
		if (kind === null) continue;
		if (seen.has(kind)) return kind;
		seen.add(kind);
	}
	return null;
}

export interface ProgramTarget {
	readonly folder: string;
	readonly name: string;
	readonly isNew: boolean;
}

export type ProgramAddFolder = Pick<CloudMemberFolderClient, "read" | "readFile" | "commit" | "uploadFile">;

export class ProgramAddRefusal extends Error {
	readonly reason:
		| "full"
		| "denied"
		| "paused"
		| "busy"
		| "taken"
		| "exists"
		| "refused"
		| "unusable"
		| "gone"
		| "offline";
	readonly why: string | null;
	constructor(reason: ProgramAddRefusal["reason"], why: string | null = null) {
		super(`Program add refused: ${reason}`);
		this.reason = reason;
		this.why = why;
	}
}

export function refusalOf(error: unknown): ProgramAddRefusal {
	if (error instanceof ProgramAddRefusal) return error;
	const status = error instanceof CloudMemberFolderError ? error.status : null;
	if (status === 401 || status === 403) return new ProgramAddRefusal("denied");
	if (status === 423) return new ProgramAddRefusal("paused");
	if (status === 429) return new ProgramAddRefusal("busy");
	if (status === 400 || status === 413) return new ProgramAddRefusal("unusable");
	return new ProgramAddRefusal("offline");
}

async function readKept(
	folder: ProgramAddFolder,
	path: string,
	signal: AbortSignal,
): Promise<{ readonly program: Program | null; readonly version: string | null }> {
	const entry = (await folder.read(path, signal)).entry;
	if (!entry) return { program: null, version: null };
	if (entry.kind !== "file" || !entry.file || entry.file.bytes > MEMBER_TEXT_MAX_BYTES)
		throw new ProgramAddRefusal("full");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(
		await folder.readFile(entry.file, signal, MEMBER_TEXT_MAX_BYTES),
	);
	const program = parseProgram(text);
	if (!program) throw new ProgramAddRefusal("gone");
	return { program, version: entry.version };
}

export function programWithVersion(
	kept: Program | null,
	version: string,
	forms: readonly ProgramKeptForm[],
	userId: string,
	at: Date,
): string {
	const ordered = programFormsInOrder(forms);
	const added: ProgramVersion = { version, date: at.toISOString(), forms: ordered, userId };
	return writeProgram({
		version,
		forms: ordered.map((form): ProgramForm => ({ for: form.for, file: form.file })),
		screens: kept?.screens ?? {},
		versions: [added, ...(kept?.versions ?? [])],
	});
}

const fits = (text: string) => new TextEncoder().encode(text).byteLength <= MEMBER_TEXT_MAX_BYTES;

export interface ProgramAddPlan {
	readonly target: ProgramTarget;
	readonly files: readonly { readonly file: File; readonly kind: ProgramKind }[];
	readonly userId: string;
	readonly signal: AbortSignal;
	readonly onProgress?: (sent: number, total: number) => void;
	readonly onSettling?: () => void;
	readonly taken?: readonly string[];
	readonly now?: () => Date;
}

interface Placed {
	readonly file: File;
	readonly kind: ProgramKind;
	readonly prepared: CloudMemberFolderUploadFile;
	version: string;
	entry: string | null;
}

interface Pending {
	readonly key: string;
	readonly units: readonly CloudMemberFolderUnit[];
	readonly apply: (commit: CloudMemberFolderCommit) => void;
}

const SETTLE_MS = 30_000;
const CLAIM_TRIES = 20;

export class ProgramAdd {
	readonly #folder: () => ProgramAddFolder;
	readonly #isNew: boolean;
	readonly #name: string;
	#slug: string;
	#claimed = false;
	#listed = false;
	#settling = false;
	#running: Promise<unknown> | undefined;
	#userId: string | undefined;
	#date: Date | undefined;
	#pending: Pending | undefined;
	#inflight: { readonly file: File; readonly kind: ProgramKind; readonly version: string } | undefined;
	readonly #keys = new Map<string, string>();
	readonly #placed = new Map<File, Placed>();
	readonly #prepared = new Map<File, CloudMemberFolderUploadFile>();

	constructor(folder: () => ProgramAddFolder, target: ProgramTarget) {
		this.#folder = folder;
		this.#isNew = target.isNew;
		this.#name = target.name;
		this.#slug = target.folder;
	}

	get folder(): string {
		return this.#slug;
	}

	get settling(): boolean {
		return this.#settling;
	}

	get #app(): string {
		return `${APPS_FOLDER}/${this.#slug}`;
	}

	#path(version: string, file: File): string {
		return `${this.#app}/${programFilePath(version, file.name)}`;
	}

	#key(what: string): string {
		const known = this.#keys.get(what);
		if (known) return known;
		const key = `web:${crypto.randomUUID()}`;
		this.#keys.set(what, key);
		return key;
	}

	async #commit(
		units: readonly CloudMemberFolderUnit[],
		signal: AbortSignal,
		apply: (commit: CloudMemberFolderCommit) => void,
	): Promise<CloudMemberFolderCommit> {
		const key = this.#key(JSON.stringify(units));
		this.#pending = { key, units, apply };
		const commit = await this.#folder().commit(key, units, signal);
		this.#pending = undefined;
		apply(commit);
		return commit;
	}

	async #replay(signal: AbortSignal): Promise<void> {
		const pending = this.#pending;
		if (!pending) return;
		const commit = await this.#folder().commit(pending.key, pending.units, signal);
		this.#pending = undefined;
		pending.apply(commit);
	}

	#lists(program: Program | null): boolean {
		const ours = [...this.#prepared.values()];
		return (
			ours.length > 0 &&
			program?.versions.some(
				(version) =>
					version.userId === this.#userId &&
					ours.every((prepared) => version.forms.some((form) => form.sha256 === prepared.fileSha256)),
			) === true
		);
	}

	run(plan: ProgramAddPlan): Promise<void> {
		const running = this.#run(plan);
		this.#running = running.catch(() => undefined);
		return running;
	}

	async discard(): Promise<void> {
		await this.#running;
		const signal = AbortSignal.timeout(SETTLE_MS);
		const folder = this.#folder();
		try {
			await this.#replay(signal);
			if (this.#listed || (this.#prepared.size > 0 && this.#lists((await this.#kept(signal)).program))) return;
			const inflight = this.#inflight;
			const prepared = inflight ? this.#prepared.get(inflight.file) : undefined;
			if (inflight && prepared && !this.#placed.has(inflight.file)) {
				const entry = (await folder.read(this.#path(inflight.version, inflight.file), signal)).entry;
				if (entry?.file?.fileSha256 === prepared.fileSha256 && entry.file.bytes === prepared.bytes)
					this.#placed.set(inflight.file, {
						file: inflight.file,
						kind: inflight.kind,
						prepared,
						version: inflight.version,
						entry: entry.version,
					});
			}
			const placed = [...this.#placed.values()];
			this.#placed.clear();
			this.#inflight = undefined;
			if (this.#claimed) {
				const read = await folder.read(this.#app, signal);
				if (read.entry?.kind === "folder")
					await folder.commit(
						`web:${crypto.randomUUID()}`,
						[{ op: "delete", path: this.#app, asOfSeq: read.asOfSeq }],
						signal,
					);
				return;
			}
			if (placed.length === 0) return;
			await folder.commit(
				`web:${crypto.randomUUID()}`,
				placed.map(
					(each): CloudMemberFolderUnit => ({
						op: "delete",
						path: this.#path(each.version, each.file),
						...(each.entry ? { expectedVersion: each.entry } : {}),
					}),
				),
				signal,
			);
		} catch {
			return;
		}
	}

	#kept(signal: AbortSignal) {
		return readKept(this.#folder(), `${this.#app}/${PROGRAM_FILE}`, signal);
	}

	async #claim(taken: Set<string>, signal: AbortSignal): Promise<void> {
		for (let attempt = 1; attempt <= CLAIM_TRIES; attempt++) {
			const commit = await this.#commit(
				[
					{ op: "mkdir", path: APPS_FOLDER },
					{ op: "mkdir", path: this.#app },
				],
				signal,
				(answer) => {
					if (answer.units[1]?.outcome === "saved") this.#claimed = true;
				},
			);
			if (this.#claimed) return;
			const claim = commit.units[1];
			if (claim?.outcome === "denied") throw new ProgramAddRefusal("denied");
			if (claim?.outcome !== "conflict") throw new ProgramAddRefusal("refused", claim?.reason ?? null);
			taken.add(this.#slug);
			this.#slug = programFolderName(this.#name, taken);
		}
		throw new ProgramAddRefusal("taken");
	}

	async #run(plan: ProgramAddPlan): Promise<void> {
		const { signal } = plan;
		const now = plan.now ?? (() => new Date());
		this.#userId = plan.userId;
		await this.#replay(AbortSignal.timeout(SETTLE_MS));
		if (this.#listed) return;
		if (this.#isNew && !this.#claimed) await this.#claim(new Set(plan.taken ?? []), signal);
		const programPath = `${this.#app}/${PROGRAM_FILE}`;
		const total = plan.files.reduce((sum, each) => sum + each.file.size, 0);
		let done = [...this.#placed.values()].reduce((sum, each) => sum + each.file.size, 0);
		plan.onProgress?.(done, total);
		let kept = await readKept(this.#folder(), programPath, signal);
		if (this.#lists(kept.program)) {
			this.#listed = true;
			return;
		}
		const draft = programWithVersion(
			kept.program,
			nextMemberVersion(kept.program),
			plan.files.map(({ file, kind }) => ({ for: kind, file: file.name, bytes: file.size, sha256: "0".repeat(64) })),
			plan.userId,
			now(),
		);
		if (!fits(draft)) throw new ProgramAddRefusal("full");
		let version =
			[...this.#placed.values()][0]?.version ?? this.#inflight?.version ?? nextMemberVersion(kept.program);
		for (const { file, kind } of plan.files) {
			if (this.#placed.has(file)) continue;
			let prepared = this.#prepared.get(file);
			if (!prepared) {
				prepared = await prepareCloudMemberFolderUpload(file, signal);
				this.#prepared.set(file, prepared);
			}
			if (this.#inflight?.file === file) version = this.#inflight.version;
			for (let attempt = 1; ; attempt++) {
				const path = this.#path(version, file);
				this.#inflight = { file, kind, version };
				const put = await this.#folder().uploadFile(path, file, prepared, {
					operationKey: this.#key(`upload:${path}:${prepared.fileSha256}`),
					signal,
					onProgress: (sent) => plan.onProgress?.(done + sent, total),
				});
				this.#inflight = undefined;
				if (put.outcome === "saved") {
					this.#placed.set(file, { file, kind, prepared, version, entry: put.version });
					break;
				}
				if (put.outcome === "denied") throw new ProgramAddRefusal("denied");
				if (put.outcome === "refused") throw new ProgramAddRefusal("refused", put.reason);
				if (attempt === TRIES) throw new ProgramAddRefusal(put.outcome === "exists" ? "exists" : "taken");
				kept = await readKept(this.#folder(), programPath, signal);
				version = nextMemberVersion({
					versions: [...(kept.program?.versions ?? []), { version, date: "", forms: [] }],
				});
			}
			signal.throwIfAborted();
			done += file.size;
			plan.onProgress?.(done, total);
		}
		signal.throwIfAborted();
		this.#settling = true;
		plan.onSettling?.();
		try {
			this.#date ??= now();
			await this.#keep(plan, programPath, kept);
		} finally {
			this.#settling = false;
		}
	}

	async #move(placed: readonly Placed[], version: string, signal: AbortSignal): Promise<void> {
		const moving = placed.filter((each) => each.version !== version);
		if (moving.length === 0) return;
		const commit = await this.#commit(
			[
				{ op: "mkdir", path: `${this.#app}/versions/${version}` },
				...moving.map(
					(each): CloudMemberFolderUnit => ({
						op: "move",
						from: this.#path(each.version, each.file),
						to: this.#path(version, each.file),
						...(each.entry ? { expectedVersion: each.entry } : {}),
					}),
				),
			],
			signal,
			(answer) => {
				for (const [index, each] of moving.entries()) {
					const unit = answer.units[index + 1];
					if (unit?.outcome !== "saved") continue;
					each.version = version;
					each.entry = unit.version;
				}
			},
		);
		const failed = commit.units.slice(1).find((unit) => unit.outcome !== "saved");
		if (failed) throw new ProgramAddRefusal(failed.outcome === "denied" ? "denied" : "taken");
	}

	async #keep(
		plan: ProgramAddPlan,
		programPath: string,
		first: { readonly program: Program | null; readonly version: string | null },
	): Promise<void> {
		const signal = AbortSignal.timeout(SETTLE_MS);
		const at = this.#date ?? new Date();
		let kept = first;
		let manifest = this.#isNew && kept.program === null;
		for (let attempt = 1; ; attempt++) {
			if (this.#lists(kept.program)) {
				this.#listed = true;
				return;
			}
			const placed = plan.files.map(({ file }) => this.#placed.get(file)!);
			const head = placed[0]!.version;
			const free =
				placed.every((each) => each.version === head) &&
				!kept.program?.versions.some((each) => each.version === head);
			const version = free
				? head
				: nextMemberVersion({
						versions: [
							...(kept.program?.versions ?? []),
							...placed.map((each) => ({ version: each.version, date: "", forms: [] })),
						],
					});
			await this.#move(placed, version, signal);
			const text = programWithVersion(
				kept.program,
				version,
				placed.map((each) => ({
					for: each.kind,
					file: each.file.name,
					bytes: each.prepared.bytes,
					sha256: each.prepared.fileSha256,
				})),
				plan.userId,
				at,
			);
			if (!fits(text)) throw new ProgramAddRefusal("full");
			const units: CloudMemberFolderUnit[] = [
				...(manifest
					? [
							{
								op: "write" as const,
								path: `${this.#app}/${APP_MANIFEST}`,
								text: writeAppManifest({
									name: this.#name,
									about: null,
									emblem: APP_DEFAULT_EMBLEM,
									colour: null,
									entry: APP_DEFAULT_ENTRY,
									owner: null,
									posted: true,
									reads: [],
									writes: [],
									concept: false,
									cover: null,
									kit: "program",
								}),
							},
						]
					: []),
				{ op: "write", path: programPath, text, ...(kept.version ? { expectedVersion: kept.version } : {}) },
			];
			const withManifest = manifest;
			const commit = await this.#commit(units, signal, (answer) => {
				if (withManifest && answer.units[0]?.outcome === "saved") manifest = false;
				if (answer.units.at(-1)?.outcome === "saved") {
					this.#listed = true;
					this.#placed.clear();
				}
			});
			const written = commit.units.at(-1);
			if (written?.outcome === "saved") return;
			if (written?.outcome === "denied") throw new ProgramAddRefusal("denied");
			if (written?.outcome === "refused") throw new ProgramAddRefusal("refused", written.reason);
			if (written?.outcome !== "conflict" || attempt === TRIES) throw new ProgramAddRefusal("taken");
			kept = await readKept(this.#folder(), programPath, signal);
		}
	}
}
