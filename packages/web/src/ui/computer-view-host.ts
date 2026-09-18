import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";
import { type ComputerViewer, type ComputerViewerOptions, openComputerViewer } from "./computer-viewer.ts";

/** One presentation lifetime for shared and private views. Closing never
 * submits computer-stop or privacy-finish intent. */
export class ComputerViewHost {
	readonly #signal: AbortSignal;
	readonly #connections = new Map<string, CompanyComputerMemberView>();
	#viewer: ComputerViewer | undefined;
	#version = 0;
	#opening = false;
	constructor(signal: AbortSignal) {
		this.#signal = signal;
		signal.addEventListener("abort", () => void this.close().catch(() => undefined), { once: true });
	}
	async open(options: Omit<ComputerViewerOptions, "releaseConnection" | "onClosed">): Promise<void> {
		this.#signal.throwIfAborted();
		if (this.#opening) throw new Error("A viewer is already opening.");
		this.#opening = true;
		const version = ++this.#version;
		try {
			await this.#release();
			this.#signal.throwIfAborted();
			if (version !== this.#version) throw new Error("Viewer closed.");
			this.#viewer = openComputerViewer({
				...options,
				requestConnection: async (input) => {
					const signal = AbortSignal.any([this.#signal, input.signal]);
					signal.throwIfAborted();
					if (version !== this.#version) throw new Error("Viewer closed.");
					const connection = await options.requestConnection({ ...input, signal });
					if (signal.aborted || version !== this.#version) {
						await connection.close();
						throw new Error("Viewer closed.");
					}
					this.#connections.set(connection.connectionId, connection);
					return connection;
				},
				releaseConnection: async ({ connectionId }) => {
					const connection = this.#connections.get(connectionId);
					await connection?.close();
					this.#connections.delete(connectionId);
				},
				onClosed: () => {
					if (version === this.#version) {
						this.#version++;
						this.#viewer = undefined;
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
