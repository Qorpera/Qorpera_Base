import { request } from "node:http";

/** A machine on this node, as LXD names it: its project, its name, and `volatile.uuid` (its physical id, which a
 * rebuild or a recreated instance changes). */
export interface MachineRef {
	readonly project: string;
	readonly name: string;
	readonly physicalId: string;
}

export interface MachineCheck {
	/** Whether the vsock peer `cid` is that machine, running, now. Fails closed. */
	matches(cid: number, machine: MachineRef): Promise<boolean>;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseMachineRef(value: unknown): MachineRef {
	const m = value as Record<string, unknown>;
	if (
		!m ||
		typeof m !== "object" ||
		Object.keys(m).length !== 3 ||
		typeof m.project !== "string" ||
		!NAME.test(m.project) ||
		typeof m.name !== "string" ||
		!NAME.test(m.name) ||
		typeof m.physicalId !== "string" ||
		!UUID.test(m.physicalId)
	)
		throw new Error("Machine reference must be {project, name, physicalId}");
	return { project: m.project, name: m.name, physicalId: m.physicalId };
}

/** Asks LXD on this node, through its local socket, which CID a machine has. One fixed read request per check;
 * nothing is cached, because LXD may give a machine another CID when it starts again. */
export class LxdMachines implements MachineCheck {
	readonly #socketPath: string;
	readonly #timeoutMs: number;

	constructor(socketPath = "/var/snap/lxd/common/lxd/unix.socket", timeoutMs = 5_000) {
		this.#socketPath = socketPath;
		this.#timeoutMs = timeoutMs;
	}

	async matches(cid: number, machine: MachineRef): Promise<boolean> {
		try {
			const body = await this.#get(
				`/1.0/instances/${encodeURIComponent(machine.name)}?project=${encodeURIComponent(machine.project)}`,
			);
			const metadata = (body as { metadata?: { status?: unknown; config?: Record<string, unknown> } }).metadata;
			const config = metadata?.config ?? {};
			return (
				metadata?.status === "Running" &&
				config["volatile.vsock_id"] === String(cid) &&
				config["volatile.uuid"] === machine.physicalId
			);
		} catch {
			return false;
		}
	}

	#get(path: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const req = request({ socketPath: this.#socketPath, path, method: "GET", timeout: this.#timeoutMs }, (res) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				res.on("data", (chunk: Buffer) => {
					bytes += chunk.byteLength;
					if (bytes > 1024 * 1024) req.destroy(new Error("LXD answer is too large"));
					else chunks.push(chunk);
				});
				res.on("end", () => {
					if (res.statusCode !== 200) return reject(new Error(`LXD answered ${res.statusCode}`));
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch (error) {
						reject(error);
					}
				});
				res.on("error", reject);
			});
			req.on("timeout", () => req.destroy(new Error("LXD did not answer")));
			req.on("error", reject);
			req.end();
		});
	}
}
