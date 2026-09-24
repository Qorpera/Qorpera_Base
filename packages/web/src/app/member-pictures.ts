import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError } from "../cloud/client.ts";
import { memberPictureName } from "../cloud/member-pictures.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import {
	forgetPersonPictures,
	PERSON_PICTURE_EVENT,
	type PersonPictureStatus,
	type PersonPictureStore,
	paintPersonPicture,
} from "../ui/person-pictures.ts";
import { type PictureCrop, type PreparedPicture, pictureSha256, preparePicture } from "../ui/picture-file.ts";

/* The signed-in account's view of member pictures. Every initials disc on the
 * page asks for its person; the asks of one moment go to the cloud as one
 * read, each picture is downloaded once and kept as a blob: URL, and every disc
 * showing that person is repainted when it arrives or changes. A reset (the
 * account changed) forgets everything, since who may see a picture depends on
 * who is asking. */

type Entry =
	| { kind: "loading" }
	| { kind: "none" }
	| { kind: "picture"; objectName: string; url: string }
	| { kind: "failed"; retryAt: number };

/** How long a picture that failed to load waits before another disc may ask again. */
const RETRY_MS = 60_000;
/** The cloud answers at most 200 accounts per read. */
const BATCH = 100;
/** An upload younger than this may be another tab's, about to become the picture. */
const TIDY_GRACE_SECONDS = 120;
/** A choice waits this long at most for a tidy that never answers; the cloud's
 * folder lock keeps it safe either way. */
const TIDY_WAIT_MS = 10_000;

export interface MemberPicturesOptions {
	prepare?: (file: File, crop?: PictureCrop) => Promise<PreparedPicture>;
	now?: () => number;
	tidyWaitMs?: number;
}

export class MemberPictures implements PersonPictureStore {
	readonly #api: CloudApi;
	readonly #prepare: (file: File, crop?: PictureCrop) => Promise<PreparedPicture>;
	readonly #now: () => number;
	readonly #tidyWaitMs: number;
	readonly #entries = new Map<string, Entry>();
	/** Weakly held: a disc that left the page is forgotten with it. */
	readonly #elements = new Map<string, Set<WeakRef<HTMLElement>>>();
	readonly #queue = new Set<string>();
	#flushing = false;
	#generation = 0;
	/** False once the cloud has said it has no member pictures (not deployed there yet). */
	#available: boolean | undefined;
	#busy: string | undefined;
	#failure: { userId: string; error: unknown } | undefined;
	/** Tidies run one after another; a choice waits for the one running. */
	#tidying: Promise<void> = Promise.resolve();
	/** The object on its way to becoming the picture: no tidy deletes it, even one
	 * that outlived its wait and read the folder late. */
	#choosing: string | undefined;

	constructor(api: CloudApi, options: MemberPicturesOptions = {}) {
		this.#api = api;
		this.#prepare = options.prepare ?? preparePicture;
		this.#now = options.now ?? Date.now;
		this.#tidyWaitMs = options.tidyWaitMs ?? TIDY_WAIT_MS;
	}

	attach(element: HTMLElement, rawUserId: string): void {
		if (!UUID_PATTERN.test(rawUserId)) return;
		const userId = rawUserId.toLowerCase();
		let elements = this.#elements.get(userId);
		if (!elements) {
			elements = new Set();
			this.#elements.set(userId, elements);
		}
		if (elements.size >= 32) for (const ref of elements) if (!ref.deref()) elements.delete(ref);
		elements.add(new WeakRef(element));
		const entry = this.#entries.get(userId);
		paintPersonPicture(element, entry?.kind === "picture" ? entry.url : undefined);
		this.#request(userId);
	}

	status(rawUserId: string): PersonPictureStatus {
		if (this.#available === false) return "unavailable";
		const entry = this.#entries.get(rawUserId.toLowerCase());
		if (!entry || entry.kind === "loading") return "loading";
		return entry.kind;
	}

	busy(rawUserId: string): boolean {
		return this.#busy === rawUserId.toLowerCase();
	}

	failure(rawUserId: string): unknown {
		return this.#failure?.userId === rawUserId.toLowerCase() ? this.#failure.error : undefined;
	}

	async choose(rawUserId: string, file: File, crop?: PictureCrop): Promise<void> {
		const userId = this.#begin(rawUserId);
		const generation = this.#generation;
		let created: string | undefined;
		let objectName: string | undefined;
		try {
			const picture = await this.#prepare(file, crop);
			objectName = memberPictureName(userId, await pictureSha256(picture.blob), picture.extension);
			this.#current(generation);
			this.#choosing = objectName;
			// A tidy already running read "current" before this choice and may still
			// delete these very bytes (a picture chosen again); let it finish first.
			await this.#afterTidy();
			this.#current(generation);
			if (await this.#upload(userId, objectName, picture.blob, generation)) created = objectName;
			this.#current(generation);
			const change = await this.#api.setMemberPicture(objectName);
			this.#current(generation);
			this.#show(userId, { kind: "picture", objectName, url: URL.createObjectURL(picture.blob) });
			if (change.previousObjectName && change.previousObjectName !== objectName)
				void this.#tidy(userId, [change.previousObjectName], generation);
		} catch (error) {
			this.#fail(userId, generation, error);
			// An upload this call stored goes again, unless the cloud says it became
			// the picture after all (an answer lost on the way back).
			if (this.#choosing === created) this.#choosing = undefined;
			if (created) void this.#tidy(userId, [created], generation);
			throw error;
		} finally {
			// Only this choice's guard: a choice of the next account may have set its own.
			if (objectName && this.#choosing === objectName) this.#choosing = undefined;
			this.#end(userId, generation);
		}
	}

	async remove(rawUserId: string): Promise<void> {
		const userId = this.#begin(rawUserId);
		const generation = this.#generation;
		try {
			const change = await this.#api.clearMemberPicture();
			this.#current(generation);
			this.#show(userId, { kind: "none" });
			if (change.previousObjectName) void this.#tidy(userId, [change.previousObjectName], generation);
		} catch (error) {
			this.#fail(userId, generation, error);
			throw error;
		} finally {
			this.#end(userId, generation);
		}
	}

	fail(rawUserId: string, error: unknown): void {
		if (!UUID_PATTERN.test(rawUserId)) return;
		const userId = rawUserId.toLowerCase();
		this.#failure = { userId, error };
		this.#announce(userId);
	}

	/** Forgets every picture: the account changed, and with it who may see what. */
	reset(): void {
		this.#generation++;
		for (const entry of this.#entries.values()) if (entry.kind === "picture") URL.revokeObjectURL(entry.url);
		const elements = [...this.#elements.values()];
		this.#entries.clear();
		this.#elements.clear();
		this.#queue.clear();
		this.#flushing = false;
		this.#available = undefined;
		this.#busy = undefined;
		this.#failure = undefined;
		this.#tidying = Promise.resolve();
		this.#choosing = undefined;
		forgetPersonPictures();
		for (const set of elements)
			for (const ref of set) {
				const element = ref.deref();
				if (!element) continue;
				paintPersonPicture(element, undefined);
				element.dispatchEvent(new CustomEvent(PERSON_PICTURE_EVENT));
			}
	}

	#begin(rawUserId: string): string {
		if (!UUID_PATTERN.test(rawUserId)) throw new Error("Sign in again to change your picture.");
		if (this.#busy) throw new Error("Your picture is still being changed.");
		const userId = rawUserId.toLowerCase();
		this.#busy = userId;
		this.#failure = undefined;
		this.#announce(userId);
		return userId;
	}

	#end(userId: string, generation: number): void {
		if (generation !== this.#generation) return;
		this.#busy = undefined;
		this.#announce(userId);
	}

	#fail(userId: string, generation: number, error: unknown): void {
		if (generation === this.#generation) this.#failure = { userId, error };
	}

	/** Stores the picture. A folder full of uploads never chosen is tidied once, then tried again. */
	async #upload(userId: string, objectName: string, blob: Blob, generation: number): Promise<boolean> {
		try {
			return await this.#api.uploadMemberPicture(objectName, blob);
		} catch (error) {
			const refused = error as { statusCode?: unknown; message?: unknown };
			if (refused.statusCode !== "403" && !/row-level security/i.test(String(refused.message))) throw error;
			// Not queued behind a tidy that may never answer: wait for it a while, then tidy now.
			await this.#afterTidy();
			await this.#within(this.#tidyNow(userId, [], generation, true));
			this.#current(generation);
			return this.#api.uploadMemberPicture(objectName, blob);
		}
	}

	/** The running tidy, or a while if it never answers. */
	#afterTidy(): Promise<void> {
		return this.#within(this.#tidying);
	}

	/** `work`, or a while if it never answers (the web client has no request timeout). */
	async #within(work: Promise<void>): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			work,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, this.#tidyWaitMs);
			}),
		]);
		clearTimeout(timer);
	}

	/** Deletes what in the member's folder is not their current picture: the named
	 * objects at once, anything else once it is too old to be another tab's upload
	 * on its way (`everything`: all of it, for a full folder). The cloud names the
	 * current picture first and refuses to delete it anyway; if anything here fails,
	 * only storage is at stake. */
	#tidy(userId: string, named: string[], generation: number, everything = false): Promise<void> {
		this.#tidying = this.#tidying.then(() => this.#tidyNow(userId, named, generation, everything));
		return this.#tidying;
	}

	async #tidyNow(userId: string, named: string[], generation: number, everything: boolean): Promise<void> {
		if (generation !== this.#generation) return;
		try {
			const current = (await this.#api.listMemberPictures([userId])).find(
				(picture) => picture.userId === userId,
			)?.objectName;
			if (generation !== this.#generation) return;
			const objects = (await this.#api.ownMemberPictureObjects()).filter((object) =>
				object.objectName.startsWith(`${userId}/`),
			);
			if (generation !== this.#generation) return;
			const stale = objects.filter(
				(object) =>
					object.objectName !== current &&
					object.objectName !== this.#choosing &&
					(everything || named.includes(object.objectName) || object.ageSeconds >= TIDY_GRACE_SECONDS),
			);
			await Promise.all(stale.map((object) => this.#api.deleteMemberPicture(object.objectName).catch(() => {})));
		} catch {
			// Left for the next tidy.
		}
	}

	#current(generation: number): void {
		if (generation !== this.#generation) throw new Error("The account changed.");
	}

	#request(userId: string): void {
		if (this.#available === false) return;
		const entry = this.#entries.get(userId);
		if (entry && !(entry.kind === "failed" && entry.retryAt <= this.#now())) return;
		this.#entries.set(userId, { kind: "loading" });
		this.#queue.add(userId);
		if (this.#flushing) return;
		this.#flushing = true;
		const generation = this.#generation;
		queueMicrotask(() => void this.#flush(generation));
	}

	async #flush(generation: number): Promise<void> {
		try {
			while (this.#queue.size && generation === this.#generation) {
				const batch = [...this.#queue].slice(0, BATCH);
				for (const userId of batch) this.#queue.delete(userId);
				await this.#read(batch, generation);
			}
		} finally {
			if (generation === this.#generation) this.#flushing = false;
		}
	}

	/** Still waiting for this read: nothing reset the store or changed the picture meanwhile. */
	#waiting(userId: string, generation: number): boolean {
		return generation === this.#generation && this.#entries.get(userId)?.kind === "loading";
	}

	async #read(batch: string[], generation: number): Promise<void> {
		let pictures: Map<string, string>;
		try {
			pictures = new Map(
				(await this.#api.listMemberPictures(batch)).map((picture) => [picture.userId, picture.objectName]),
			);
		} catch (error) {
			if (generation !== this.#generation) return;
			const missing = error instanceof CloudRpcError && error.missing;
			if (missing) this.#available = false;
			for (const userId of batch)
				if (this.#waiting(userId, generation))
					this.#show(userId, missing ? { kind: "none" } : { kind: "failed", retryAt: this.#now() + RETRY_MS });
			return;
		}
		if (generation !== this.#generation) return;
		this.#available = true;
		await Promise.all(
			batch.map(async (userId) => {
				const objectName = pictures.get(userId);
				if (!objectName) {
					if (this.#waiting(userId, generation)) this.#show(userId, { kind: "none" });
					return;
				}
				try {
					const blob = await this.#api.downloadMemberPicture(objectName);
					const hash = objectName.slice(objectName.indexOf("/") + 1, objectName.lastIndexOf("."));
					if ((await pictureSha256(blob)) !== hash) throw new Error("The picture failed verification.");
					if (this.#waiting(userId, generation))
						this.#show(userId, { kind: "picture", objectName, url: URL.createObjectURL(blob) });
				} catch {
					if (this.#waiting(userId, generation))
						this.#show(userId, { kind: "failed", retryAt: this.#now() + RETRY_MS });
				}
			}),
		);
	}

	#show(userId: string, entry: Entry): void {
		const previous = this.#entries.get(userId);
		this.#entries.set(userId, entry);
		this.#announce(userId);
		if (previous?.kind === "picture") URL.revokeObjectURL(previous.url);
	}

	#announce(userId: string): void {
		const entry = this.#entries.get(userId);
		const url = entry?.kind === "picture" ? entry.url : undefined;
		const elements = this.#elements.get(userId);
		if (!elements) return;
		for (const ref of elements) {
			const element = ref.deref();
			if (!element) {
				elements.delete(ref);
				continue;
			}
			paintPersonPicture(element, url);
			element.dispatchEvent(new CustomEvent(PERSON_PICTURE_EVENT));
		}
		if (!elements.size) this.#elements.delete(userId);
	}
}
