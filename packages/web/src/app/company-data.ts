import type {
	CloudMemberDataAnswer,
	CloudMemberDataAt,
	CloudMemberDataChanges,
	CloudMemberDataChangesAsked,
	CloudMemberDataDescription,
	CloudMemberDataEdit,
	CloudMemberDataEdited,
	CloudMemberDataPage,
	CloudMemberDataQuestion,
	CloudMemberDataTableAsked,
	CloudMemberDataWatched,
	CloudMemberDataWatchedAnswer,
} from "@qorpera/cloud-client/cloud-member-data";

export interface CompanyDataCalls {
	describe(database: string | null, signal: AbortSignal): Promise<CloudMemberDataDescription>;
	rows(
		asked: CloudMemberDataTableAsked & { readonly after?: readonly unknown[]; readonly at?: CloudMemberDataAt },
		signal: AbortSignal,
	): Promise<CloudMemberDataPage>;
	query(asked: CloudMemberDataQuestion, signal: AbortSignal): Promise<CloudMemberDataAnswer>;
	edit(edit: CloudMemberDataEdit, signal: AbortSignal): Promise<CloudMemberDataEdited>;
	changes(asked: CloudMemberDataChangesAsked, signal: AbortSignal): Promise<CloudMemberDataChanges>;
	watchTables(watches: readonly CloudMemberDataWatched[], signal: AbortSignal): Promise<CloudMemberDataWatchedAnswer>;
}

const AGAIN_AFTER_MS = 60_000;
const POLL_MS = 5 * 60_000;

export class CompanyDatabases {
	readonly #client: () => CompanyDataCalls;
	readonly #publish: (described: CloudMemberDataDescription | null) => void;
	readonly #stop = new AbortController();
	#poll?: ReturnType<typeof setInterval>;
	#reading: Promise<void> | null = null;
	#again = false;
	#readAt = Number.NEGATIVE_INFINITY;
	#shown: string | undefined;

	constructor(
		client: () => CompanyDataCalls,
		publish: (described: CloudMemberDataDescription | null) => void,
		signal: AbortSignal,
	) {
		this.#client = client;
		this.#publish = publish;
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#stop.signal });
	}

	get signal(): AbortSignal {
		return this.#stop.signal;
	}

	calls(): CompanyDataCalls {
		return this.#client();
	}

	open(): void {
		if (this.#stop.signal.aborted || this.#poll) return;
		const listen = { signal: this.#stop.signal };
		const shows = () => document.visibilityState === "visible";
		const stale = () => shows() && Date.now() - this.#readAt > AGAIN_AFTER_MS && void this.refresh();
		window.addEventListener("focus", stale, listen);
		document.addEventListener("visibilitychange", stale, listen);
		this.#poll = setInterval(() => void (shows() && this.refresh()), POLL_MS);
		void this.refresh();
	}

	dispose(): void {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		clearInterval(this.#poll);
	}

	refresh(): Promise<void> {
		if (this.#stop.signal.aborted) return Promise.resolve();
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		this.#reading = this.#read().finally(() => {
			this.#reading = null;
			if (this.#again) {
				this.#again = false;
				void this.refresh();
			}
		});
		return this.#reading;
	}

	async #read(): Promise<void> {
		let described: CloudMemberDataDescription | null;
		try {
			described = await this.#client().describe(null, this.#stop.signal);
		} catch (error) {
			if (this.#stop.signal.aborted) return;
			const status = (error as { status?: unknown }).status;
			if (status !== 401 && status !== 403 && status !== 404) return;
			described = null;
		}
		if (this.#stop.signal.aborted) return;
		this.#readAt = Date.now();
		const shown = JSON.stringify(described);
		if (shown === this.#shown) return;
		this.#shown = shown;
		this.#publish(described);
	}
}
