import type { CloudApi } from "../cloud/api.ts";
import { describeError } from "../cloud/client.ts";
import { type CompanyFounding, CompanyFoundingApi } from "../cloud/company-founding.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import type { HostedFriend } from "../cloud/types.ts";
import { Store } from "./state.ts";

export interface FoundingState {
	loading: boolean;
	data?: CompanyFounding;
	friends: HostedFriend[];
	busy?: string;
	error?: string;
	friendsError?: string;
	launchPending: boolean;
	left?: boolean;
}

/** One company/member lifetime. Polling reads shared truth; it never advances founding. */
export class FoundingController {
	readonly store = new Store<FoundingState>({ loading: true, friends: [], launchPending: false });
	readonly profileId: string;
	readonly userId: string;
	readonly #api: CompanyFoundingApi;
	readonly #account: CloudApi;
	readonly #current: () => void;
	readonly #lifetime = new AbortController();
	readonly #launchKey: string;
	#launch: { id: string; revision: number } | undefined;
	#reading: Promise<void> | undefined;
	#refreshAgain = false;
	#generation = 0;
	#watch: ReturnType<typeof setTimeout> | undefined;

	constructor(api: CloudApi, profileId: string, userId: string, current: () => void) {
		this.#account = api;
		this.#api = new CompanyFoundingApi(api.cloud);
		this.profileId = profileId;
		this.userId = userId;
		this.#current = current;
		this.#launchKey = `qorpera-founding-launch/v1/${api.cloud.config.projectUrl}/${userId}/${profileId}`;
		try {
			const saved: unknown = JSON.parse(sessionStorage.getItem(this.#launchKey) ?? "null");
			if (
				saved &&
				typeof saved === "object" &&
				"id" in saved &&
				typeof saved.id === "string" &&
				UUID_PATTERN.test(saved.id) &&
				"revision" in saved &&
				typeof saved.revision === "number" &&
				Number.isSafeInteger(saved.revision) &&
				saved.revision >= 1
			) {
				this.#launch = { id: saved.id, revision: saved.revision };
				this.store.set({ launchPending: true });
			}
		} catch {
			/* A blocked storage API leaves in-memory retry available. */
		}
		const resume = () => {
			if (!document.hidden) {
				void this.refresh();
			}
		};
		window.addEventListener("focus", resume, { signal: this.#lifetime.signal });
		document.addEventListener("visibilitychange", resume, { signal: this.#lifetime.signal });
	}

	start(): void {
		void this.refresh();
	}
	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#watch);
		this.store.dispose();
	}

	#check(): void {
		this.#lifetime.signal.throwIfAborted();
		this.#current();
	}
	#accept(data: CompanyFounding): void {
		this.#check();
		if (
			data.phase === "launched" ||
			(data.phase === "open" && this.#launch && data.revision !== this.#launch.revision)
		) {
			this.#launch = undefined;
			try {
				sessionStorage.removeItem(this.#launchKey);
			} catch {
				/* Server launch receipt remains authoritative. */
			}
		}
		this.store.set({ data, loading: false, launchPending: Boolean(this.#launch) });
	}

	refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		clearTimeout(this.#watch);
		this.#refreshAgain = true;
		this.#reading ??= this.#read();
		return this.#reading;
	}
	async #read(): Promise<void> {
		try {
			do {
				this.#refreshAgain = false;
				const generation = this.#generation;
				this.#check();
				const data = await this.#account.readCompanyFounding(this.profileId);
				this.#check();
				if (generation === this.#generation) {
					this.#accept(data);
					this.store.set({ error: undefined });
					if (data.phase === "open" && data.canManage) void this.refreshFriends();
				}
			} while (this.#refreshAgain && !this.#lifetime.signal.aborted);
		} catch (error) {
			if (!this.#lifetime.signal.aborted) this.store.set({ loading: false, error: describeError(error) });
		} finally {
			this.#reading = undefined;
			if (!this.#lifetime.signal.aborted && this.store.get().data?.phase !== "launched")
				this.#watch = setTimeout(() => {
					if (!document.hidden) void this.refresh();
				}, 4000);
		}
	}
	async refreshFriends(): Promise<void> {
		try {
			this.#check();
			const friends = await this.#account.listFriends();
			this.#check();
			this.store.set({ friends: friends.filter((friend) => friend.status === "accepted"), friendsError: undefined });
		} catch (error) {
			if (!this.#lifetime.signal.aborted) this.store.set({ friendsError: describeError(error) });
		}
	}
	async #mutate(
		name: string,
		operation: (data: CompanyFounding) => Promise<CompanyFounding | undefined>,
	): Promise<void> {
		const state = this.store.get();
		if (!state.data || state.busy || this.#lifetime.signal.aborted) return;
		this.#generation++;
		this.store.set({ busy: name, error: undefined });
		try {
			this.#check();
			const result = await operation(state.data);
			this.#generation++;
			this.#check();
			if (result) this.#accept(result);
			else this.store.set({ left: true });
		} catch (error) {
			if (!this.#lifetime.signal.aborted) {
				await this.refresh();
				if (!this.#lifetime.signal.aborted && this.store.get().data?.phase !== "launched")
					this.store.set({ error: describeError(error) });
			}
		} finally {
			if (!this.#lifetime.signal.aborted) this.store.set({ busy: undefined });
		}
	}
	update(name: string, description: string): Promise<void> {
		return this.#mutate("save", (data) => this.#api.update(this.profileId, data.revision, name, description));
	}
	invite(userId: string): Promise<void> {
		return this.#mutate("invite", (data) => this.#api.invite(this.profileId, data.revision, userId));
	}
	remove(userId: string): Promise<void> {
		return this.#mutate("remove", (data) => this.#api.remove(this.profileId, data.revision, userId));
	}
	leave(): Promise<void> {
		return this.#mutate("leave", async (data) => {
			await this.#api.leave(this.profileId, data.revision, this.userId);
			return undefined;
		});
	}
	acceptComputerUsageOwnership(): Promise<void> {
		return this.#mutate("usage-owner", async (data) => {
			await this.#api.acceptComputerUsageOwnership(this.profileId, data.computerUsageOwnerUserId);
			this.#check();
			return this.#api.read(this.profileId);
		});
	}
	ready(ready: boolean, roleDescription: string, contributeComputerUsage: boolean): Promise<void> {
		return this.#mutate("ready", async (data) => {
			if (ready) {
				await this.#api.setComputerPool(this.profileId, contributeComputerUsage);
				this.#check();
			}
			return this.#api.ready(this.profileId, data.revision, ready, roleDescription);
		});
	}
	launch(): Promise<void> {
		return this.#mutate("launch", (data) => {
			this.#launch ??= { id: crypto.randomUUID(), revision: data.revision };
			try {
				sessionStorage.setItem(this.#launchKey, JSON.stringify(this.#launch));
			} catch {
				/* Same lifetime still preserves the request. */
			}
			this.store.set({ launchPending: true });
			return this.#api.launch(this.profileId, this.#launch.revision, this.#launch.id);
		});
	}
}
