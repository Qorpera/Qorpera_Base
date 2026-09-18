import { randomUUID } from "node:crypto";
import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";

const MAX_BYTES = 256 * 1024;
/** A pull-driven, window-owned display bridge. Only one bounded reply can be
 * in flight. The renderer receives RFB bytes, never tickets or endpoints. */
export class MemberCompanyComputerRelay {
	readonly #view: CompanyComputerMemberView;
	readonly #current: () => void;
	#queue: Uint8Array[] = [];
	#bytes = 0;
	#closed = false;
	#reading = false;
	#ack: string | null = null;
	#wake?: () => void;
	#closing?: Promise<void>;
	constructor(view: CompanyComputerMemberView, current: () => void) {
		this.#view = view;
		this.#current = current;
		view.channel.onclose = () => this.#fail();
		view.channel.onerror = () => this.#fail();
		view.channel.onmessage = ({ data }) => {
			try {
				this.#check();
				if (
					!(data instanceof ArrayBuffer) ||
					data.byteLength + this.#bytes > MAX_BYTES ||
					this.#queue.length >= 1024
				)
					throw new Error("Display buffer exceeded");
				if (data.byteLength) {
					this.#queue.push(new Uint8Array(data).slice());
					this.#bytes += data.byteLength;
					this.#wake?.();
				}
			} catch {
				this.#fail();
			}
		};
		if (view.channel.readyState !== 1) this.#fail();
	}
	get connectionId(): string {
		return this.#view.connectionId;
	}
	get metadata(): Pick<CompanyComputerMemberView, "binding" | "connectionId" | "mode"> {
		return { connectionId: this.connectionId, binding: structuredClone(this.#view.binding), mode: this.#view.mode };
	}
	#check(): void {
		this.#current();
		if (this.#closed || this.#view.channel.readyState !== 1) throw new Error("Display disconnected");
	}
	#fail(): void {
		void this.close().catch(() => undefined);
	}
	async read(ack: unknown = null): Promise<{ state: "open" | "closed"; data: ArrayBuffer; ack: string }> {
		if (this.#reading) throw new Error("Display read already pending");
		if (ack !== this.#ack) throw new Error("Display acknowledgement differs");
		const nextAck = randomUUID();
		this.#ack = nextAck;
		this.#reading = true;
		try {
			this.#current();
			if (!this.#closed && !this.#bytes)
				await new Promise<void>((resolve) => {
					const timer = setTimeout(done, 1000);
					const self = this;
					function done(): void {
						clearTimeout(timer);
						self.#wake = undefined;
						resolve();
					}
					this.#wake = done;
				});
			this.#current();
			if (this.#closed) return { state: "closed", data: new ArrayBuffer(0), ack: nextAck };
			this.#check();
			const data = new Uint8Array(this.#bytes);
			let offset = 0;
			for (const bytes of this.#queue) {
				data.set(bytes, offset);
				offset += bytes.length;
				bytes.fill(0);
			}
			this.#queue = [];
			this.#bytes = 0;
			return { state: "open", data: data.buffer, ack: nextAck };
		} catch (error) {
			this.#fail();
			throw error;
		} finally {
			this.#reading = false;
		}
	}
	send(data: unknown): void {
		try {
			this.#check();
			if (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > MAX_BYTES)
				throw new Error("Invalid display input");
			this.#view.channel.send(data.slice());
		} catch (error) {
			this.#fail();
			throw error;
		}
	}
	close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			for (const bytes of this.#queue) bytes.fill(0);
			this.#queue = [];
			this.#bytes = 0;
			this.#view.channel.onmessage = null;
			this.#view.channel.onerror = null;
			this.#view.channel.onclose = null;
			this.#view.channel.close();
			this.#wake?.();
		}
		this.#closing ??= this.#view.close().catch((error) => {
			this.#closing = undefined;
			throw error;
		});
		return this.#closing;
	}
}
