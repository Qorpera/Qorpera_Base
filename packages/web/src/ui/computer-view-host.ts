import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";
import { type AbortScope, createAbortScope } from "../cloud/abort-scope.ts";
import {
	type ComputerViewer,
	type ComputerViewerOptions,
	loadComputerViewer,
	openComputerViewer,
} from "./computer-viewer.ts";

/** One presentation lifetime for shared and private views. Closing never
 * submits computer-stop or privacy-finish intent. */
export class ComputerViewHost {
	readonly #signal: AbortSignal;
	readonly #connections = new Map<string, CompanyComputerMemberView>();
	readonly #scopes = new Map<string, AbortScope>();
	#viewer: ComputerViewer | undefined;
	#version = 0;
	#opening = false;
	constructor(signal: AbortSignal) {
		this.#signal = signal;
		signal.addEventListener("abort", () => void this.close().catch(() => undefined), { once: true });
	}
	async open(
		options: Omit<ComputerViewerOptions, "releaseConnection" | "onClosed"> & { onClosed?: () => void },
	): Promise<void> {
		this.#signal.throwIfAborted();
		if (this.#opening) throw new Error("A viewer is already opening.");
		this.#opening = true;
		const version = ++this.#version;
		try {
			const current = () => {
				this.#signal.throwIfAborted();
				if (version !== this.#version) throw new Error("Viewer closed.");
			};
			await this.#release();
			current();
			// The renderer arrives on first use; a close while it loads still wins.
			await loadComputerViewer();
			current();
			this.#viewer = openComputerViewer({
				...options,
				requestConnection: async (input) => {
					const scope = createAbortScope([this.#signal, input.signal]);
					let handedOff = false;
					try {
						scope.signal.throwIfAborted();
						if (version !== this.#version) throw new Error("Viewer closed.");
						const raw = await options.requestConnection({ ...input, signal: scope.signal });
						if (scope.signal.aborted || version !== this.#version) {
							await raw.close();
							throw new Error("Viewer closed.");
						}
						const connection: CompanyComputerMemberView = {
							connectionId: raw.connectionId,
							binding: raw.binding,
							mode: raw.mode,
							channel: raw.channel,
							close: async () => {
								try {
									await raw.close();
								} finally {
									scope.dispose();
									this.#scopes.delete(raw.connectionId);
								}
							},
						};
						this.#scopes.set(connection.connectionId, scope);
						this.#connections.set(connection.connectionId, connection);
						handedOff = true;
						return connection;
					} finally {
						if (!handedOff) scope.dispose();
					}
				},
				releaseConnection: async ({ connectionId }) => {
					const connection = this.#connections.get(connectionId);
					try {
						await connection?.close();
					} finally {
						this.#scopes.get(connectionId)?.dispose();
						this.#scopes.delete(connectionId);
						this.#connections.delete(connectionId);
					}
				},
				onClosed: () => {
					if (version === this.#version) {
						this.#version++;
						this.#viewer = undefined;
						options.onClosed?.();
					}
				},
			});
		} finally {
			this.#opening = false;
		}
	}
	async close(): Promise<void> {
		this.#version++;
		await this.#release();
	}
	async #release(): Promise<void> {
		const viewer = this.#viewer;
		this.#viewer = undefined;
		const results = await Promise.allSettled([
			...(viewer ? [viewer.close()] : []),
			...[...this.#connections.values()].map(async (connection) => {
				await connection.close();
				this.#connections.delete(connection.connectionId);
			}),
		]);
		if (results.some((result) => result.status === "rejected"))
			throw new Error("Viewer release could not be confirmed.");
	}
}
