import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError, describeError } from "../cloud/client.ts";
import { type CompanyFounding, CompanyFoundingApi } from "../cloud/company-founding.ts";
import { createWebNativeSubscription } from "../cloud/native-subscription.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import type { HostedFriend } from "../cloud/types.ts";
import { t } from "../ui/preferences.ts";
import { Store } from "./state.ts";
import { ConnectionsView, memberProviderSignIns } from "./views/settings-connections.ts";

/* One founding table, as one member sees it. The server owns every rule; this controller keeps
 * the table fresh while it is open (other founders edit it too) and sends one action at a time. */

/** Another founder's edit shows within this long; the table is short-lived and small. */
const POLL_MS = 2500;
/** While the ChatGPT panel is open, a finished sign-in turns into Ready sooner. */
const CONNECT_POLL_MS = 1500;

export type FoundingAction = "name" | "vision" | "role" | "ready" | "invite" | "remove" | "respond" | "start" | "close";

export interface FoundingState {
	table?: CompanyFounding;
	/** The table as last seen before Start: its roles, which Start moves into the company's files. */
	beforeStart?: CompanyFounding;
	loading: boolean;
	/** The last action's failure; it stays until the next action. */
	error?: string;
	/** A read failed; cleared by the next read that works. */
	readError?: string;
	busy?: FoundingAction;
	/** You no longer sit at this table: you declined, left or were removed, or it was closed. */
	gone?: "declined" | "left" | "closed" | "unavailable";
	friendsOpen?: boolean;
	friends?: HostedFriend[];
	friendsError?: string;
	addingFriend?: boolean;
	friendAdded?: string;
	connectOpen?: boolean;
}

export interface FoundingOptions {
	/** The signed-in account now; a sign-in in progress stops only when this changes, as in Settings. */
	currentUserId: () => string | undefined;
	/** Where you sit changed (joined, left, declined, closed): the hub's lists are out of date. */
	onSeatChanged?: () => void;
}

function stale(error: unknown): boolean {
	return error instanceof CloudRpcError && error.code === "PT412";
}

function unavailable(error: unknown): boolean {
	return error instanceof CloudRpcError && error.code === "42501";
}

export class FoundingController {
	readonly store = new Store<FoundingState>({ loading: true });
	readonly profileId: string;
	readonly userId: string;
	readonly #api: CloudApi;
	readonly #founding: CompanyFoundingApi;
	readonly #options: FoundingOptions;
	readonly #lifetime = new AbortController();
	readonly #startKey: string;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#reading: Promise<void> | undefined;
	#connections: ConnectionsView | undefined;
	#queue: Promise<void> = Promise.resolve();
	/** Moves when an action ends: a read that started before that is out of date. */
	#epoch = 0;
	/** Revisions this tab's own edits produced, each mapped to the revision it was made on. */
	readonly #ownRevisions = new Map<number, number>();

	constructor(api: CloudApi, userId: string, profileId: string, options: FoundingOptions) {
		this.#api = api;
		this.#founding = new CompanyFoundingApi(api.cloud);
		this.userId = userId;
		this.#options = options;
		this.profileId = profileId;
		this.#startKey = `qorpera-web-founding-start/v1/${api.cloud.config.projectUrl}/${userId}/${profileId}`;
		const resume = () => {
			if (!document.hidden) void this.refresh();
		};
		window.addEventListener("focus", resume, { signal: this.#lifetime.signal });
		document.addEventListener("visibilitychange", resume, { signal: this.#lifetime.signal });
		void this.refresh();
	}

	get disposed(): boolean {
		return this.#lifetime.signal.aborted;
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#timer);
		this.#closeConnections();
		this.store.dispose();
	}

	refresh(): Promise<void> {
		if (this.disposed || this.store.get().gone) return Promise.resolve();
		this.#reading ??= this.#read().finally(() => {
			this.#reading = undefined;
		});
		return this.#reading;
	}

	async #read(): Promise<void> {
		clearTimeout(this.#timer);
		const epoch = this.#epoch;
		try {
			const table = await this.#founding.read(this.profileId);
			// An action ended while this read was out; its own answer is newer than this one.
			if (epoch === this.#epoch) this.#show(table);
			if (!this.disposed) this.store.set({ loading: false, readError: undefined });
		} catch (error) {
			if (this.disposed) return;
			if (unavailable(error)) this.#gone(this.store.get().gone ?? "unavailable");
			else this.store.set({ loading: false, readError: describeError(error) });
		}
		this.#schedule();
	}

	#schedule(): void {
		clearTimeout(this.#timer);
		const { table, gone, connectOpen } = this.store.get();
		if (this.disposed || gone || (table?.start?.companyReady ?? false)) return;
		// A hidden tab does not ask; coming back (visibilitychange) reads at once.
		this.#timer = setTimeout(
			() => {
				if (document.hidden) this.#schedule();
				else void this.refresh();
			},
			connectOpen ? CONNECT_POLL_MS : POLL_MS,
		);
	}

	#show(table: CompanyFounding): void {
		if (this.disposed) return;
		const current = this.store.get().table;
		// Never step back: a started table stays started, and an older revision of an open table is
		// out of date. (An invitation does not move the revision, so an equal revision still shows.)
		if (current?.phase === "started" && table.phase === "open") return;
		if (current?.phase === "open" && table.phase === "open" && table.revision < current.revision) return;
		const connected = table.seats.some((seat) => seat.userId === this.userId && seat.modelLoginReady);
		// Once your own ChatGPT account is connected, or the table has started, the panel is done.
		const panelDone = (this.store.get().connectOpen && connected) || table.phase === "started";
		this.store.set({
			table,
			loading: false,
			...(table.phase === "open" ? { beforeStart: table } : {}),
			...(panelDone ? { connectOpen: false } : {}),
		});
		if (panelDone) this.#closeConnections();
	}

	/** Actions run one after another, in the order they were made (a role saved as you click Ready,
	 * then Ready). A changed table is read again and shown, never silently overwritten. */
	#act(action: FoundingAction, run: (table: CompanyFounding) => Promise<CompanyFounding | null>): Promise<boolean> {
		const next = this.#queue.then(() => this.#run(action, run));
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async #run(
		action: FoundingAction,
		run: (table: CompanyFounding) => Promise<CompanyFounding | null>,
	): Promise<boolean> {
		const table = this.store.get().table;
		if (this.disposed || !table || this.store.get().gone) return false;
		this.store.set({ busy: action, error: undefined });
		try {
			const next = await run(table);
			this.#epoch++;
			if (next) this.#show(next);
			return true;
		} catch (error) {
			if (this.disposed) return false;
			this.#epoch++;
			if (stale(error)) {
				// A read already out started before this action and will be dropped: read again after it.
				await this.#reading?.catch(() => undefined);
				await this.refresh();
				this.store.set({ error: t("The table changed while you were editing. Check it and try again.") });
			} else this.store.set({ error: describeError(error) });
			return false;
		} finally {
			if (!this.disposed) this.store.set({ busy: undefined });
		}
	}

	/** A text edit applies to the table as it is on the server: on a moved table it is sent again on
	 * that table, with that table's other fields, so nobody else's edit is undone. */
	#edit(
		action: "name" | "vision" | "role",
		run: (table: CompanyFounding) => Promise<CompanyFounding>,
	): Promise<boolean> {
		return this.#act(action, async (table) => {
			let base = table;
			let next: CompanyFounding;
			try {
				next = await run(base);
			} catch (error) {
				if (!stale(error)) throw error;
				base = await this.#founding.read(this.profileId);
				next = await run(base);
			}
			if (next.revision !== base.revision) this.#ownRevisions.set(next.revision, base.revision);
			return next;
		});
	}

	rename(name: string): Promise<boolean> {
		const trimmed = name.trim();
		if (!trimmed) return Promise.resolve(false);
		return this.#edit("name", (table) =>
			trimmed === table.companyName
				? Promise.resolve(table)
				: this.#founding.update(this.profileId, table.revision, trimmed, table.vision),
		);
	}

	describe(vision: string): Promise<boolean> {
		const trimmed = vision.trim();
		return this.#edit("vision", (table) =>
			trimmed === table.vision
				? Promise.resolve(table)
				: this.#founding.update(this.profileId, table.revision, table.companyName, trimmed),
		);
	}

	setRole(role: string): Promise<boolean> {
		const trimmed = role.trim();
		return this.#edit("role", (table) =>
			trimmed === table.seats.find((seat) => seat.userId === this.userId)?.role
				? Promise.resolve(table)
				: this.#founding.setRole(this.profileId, table.revision, trimmed),
		);
	}

	/** Ready (or not) for the table you pressed it on. Your own edits queued before the press (a role
	 * saved as you clicked) may move the revision; anyone else's change makes the server refuse it. */
	async setReady(seenRevision: number, ready: boolean): Promise<void> {
		await this.#act("ready", (table) => {
			let revision = table.revision;
			while (revision !== seenRevision && this.#ownRevisions.has(revision))
				revision = this.#ownRevisions.get(revision)!;
			const expected = revision === seenRevision ? table.revision : seenRevision;
			return this.#founding.setReady(this.profileId, expected, ready);
		});
	}

	async invite(friendUserId: string): Promise<void> {
		await this.#act("invite", () => this.#founding.invite(this.profileId, friendUserId));
	}

	async removeSeat(userId: string): Promise<void> {
		await this.#act("remove", () => this.#founding.remove(this.profileId, userId));
	}

	async leave(): Promise<boolean> {
		const left = await this.#act("remove", async () => {
			await this.#founding.leave(this.profileId, this.userId);
			return null;
		});
		if (left) this.#gone("left");
		return left;
	}

	async respond(accept: boolean): Promise<void> {
		const answered = await this.#act("respond", () => this.#founding.respond(this.profileId, accept));
		if (!answered) return;
		if (accept) this.#options.onSeatChanged?.();
		else this.#gone("declined");
	}

	/** The one who opened the table closes it once they sit there alone (the last member deletes). */
	async close(): Promise<boolean> {
		const closed = await this.#act("close", async () => {
			await this.#api.deleteProfile(this.profileId);
			return null;
		});
		if (closed) this.#gone("closed");
		return closed;
	}

	/** Safe to press twice, from two tabs or after a lost answer: the server keeps the first Start. */
	async start(): Promise<void> {
		let clientStartId: string = crypto.randomUUID();
		try {
			const saved = sessionStorage.getItem(this.#startKey);
			if (saved && UUID_PATTERN.test(saved)) clientStartId = saved;
			else sessionStorage.setItem(this.#startKey, clientStartId);
		} catch {
			/* A blocked storage API keeps the id for this page only. */
		}
		await this.#act("start", (table) => this.#founding.start(this.profileId, table.revision, clientStartId));
	}

	dismissError(): void {
		this.store.set({ error: undefined });
	}

	openFriends(open: boolean): void {
		this.store.set({ friendsOpen: open, friendAdded: undefined, friendsError: undefined });
		if (open) void this.#loadFriends();
	}

	async #loadFriends(): Promise<void> {
		try {
			const friends = await this.#api.listFriends();
			if (!this.disposed) this.store.set({ friends, friendsError: undefined });
		} catch (error) {
			if (!this.disposed) this.store.set({ friendsError: describeError(error) });
		}
	}

	/** Not friends yet: a friend request; they can be invited once they accept. */
	async addFriend(email: string): Promise<boolean> {
		const address = email.trim();
		if (!address || this.store.get().addingFriend) return false;
		this.store.set({ addingFriend: true, friendsError: undefined, friendAdded: undefined });
		try {
			await this.#api.sendFriendRequest(address);
			if (this.disposed) return false;
			this.store.set({ friendAdded: address });
			await this.#loadFriends();
			return true;
		} catch (error) {
			if (!this.disposed) this.store.set({ friendsError: describeError(error) });
			return false;
		} finally {
			if (!this.disposed) this.store.set({ addingFriend: false });
		}
	}

	openConnect(open: boolean): void {
		if (!open) this.#closeConnections();
		this.store.set({ connectOpen: open });
		this.#schedule();
	}

	/** Your ChatGPT accounts for this company: the Settings panel, offering ChatGPT only. */
	connections(): ConnectionsView {
		if (this.#connections) return this.#connections;
		const signal = this.#lifetime.signal;
		const userId = this.userId;
		const currentUserId = this.#options.currentUserId;
		// As in Settings, a sign-in belongs to the member, not to this page: it goes on when the table
		// is left and stops only if the account changes.
		const signIn = createWebNativeSubscription(
			this.#api.cloud,
			this.profileId,
			userId,
			new AbortController().signal,
			() => {
				if (currentUserId() !== userId) throw new Error("The account changed.");
			},
		);
		this.#connections = new ConnectionsView(
			createWebNativeSubscription(this.#api.cloud, this.profileId, userId, signal, () => {
				signal.throwIfAborted();
				if (currentUserId() !== userId) throw new Error("The account changed.");
			}),
			signal,
			memberProviderSignIns(userId, this.profileId),
			(input) => signIn.beginProviderLogin(input),
			["openai"],
		);
		return this.#connections;
	}

	#closeConnections(): void {
		this.#connections?.dispose();
		this.#connections = undefined;
	}

	#gone(reason: NonNullable<FoundingState["gone"]>): void {
		clearTimeout(this.#timer);
		this.#closeConnections();
		this.store.set({ gone: reason, connectOpen: false, friendsOpen: false, loading: false });
		this.#options.onSeatChanged?.();
	}
}
