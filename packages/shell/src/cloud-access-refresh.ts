export type CloudProfileAccessRefreshResult = "active" | "revoked";

export interface CloudProfileAccessRefreshOptions {
	refresh: () => Promise<CloudProfileAccessRefreshResult>;
	onRestricted: () => void;
	onActive: () => void | Promise<void>;
	onRevoked: () => void | Promise<void>;
	onError?: (error: unknown) => void;
}

/**
 * Access invalidation fails closed immediately, then replaces cached authority
 * with an authoritative hosted read. Changes arriving during that read cause
 * one more pass before authority is restored.
 */
export class CloudProfileAccessRefresh {
	readonly #options: CloudProfileAccessRefreshOptions;
	#inFlight?: Promise<CloudProfileAccessRefreshResult | undefined>;
	#pending = false;

	constructor(options: CloudProfileAccessRefreshOptions) {
		this.#options = options;
	}

	refreshing(): boolean {
		return this.#inFlight !== undefined;
	}

	trigger(restrict = true): Promise<CloudProfileAccessRefreshResult | undefined> {
		if (restrict) this.#options.onRestricted();
		this.#pending = true;
		if (this.#inFlight) return this.#inFlight;
		const operation = this.#run().finally(() => {
			if (this.#inFlight === operation) this.#inFlight = undefined;
		});
		this.#inFlight = operation;
		return operation;
	}

	async #run(): Promise<CloudProfileAccessRefreshResult | undefined> {
		for (;;) {
			this.#pending = false;
			let result: CloudProfileAccessRefreshResult;
			try {
				result = await this.#options.refresh();
			} catch (error) {
				if (this.#pending) continue;
				this.#options.onError?.(error);
				return undefined;
			}
			if (this.#pending) continue;
			if (result === "active") await this.#options.onActive();
			else await this.#options.onRevoked();
			if (!this.#pending) return result;
		}
	}
}
