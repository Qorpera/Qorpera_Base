import { request as httpRequest } from "node:http";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_INSTANCE_FILE_BYTES = 256 * 1024;

export type LxdInstancePowerAction = "start" | "stop";

export interface LxdInstanceRecord {
	name: string;
	type: "virtual-machine" | "container";
	status: string;
	statusCode: number;
	config: Readonly<Record<string, string>>;
	profiles: readonly string[];
	devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface LxdInstanceStateRecord {
	status: string;
	statusCode: number;
	network: Readonly<
		Record<
			string,
			{
				addresses: readonly { family: string; address: string; scope: string }[];
			}
		>
	>;
}

export interface LxdStorageVolumeRecord {
	name: string;
	type: "custom";
	contentType: "filesystem" | "block";
	description: string;
	config: Readonly<Record<string, string>>;
}

export interface LxdCreateStorageVolumeRequest {
	name: string;
	type: "custom";
	content_type: "filesystem";
	description: string;
	config: Readonly<Record<string, string>>;
}

export interface LxdCreateInstanceRequest {
	name: string;
	type: "virtual-machine";
	profiles: readonly string[];
	config: Readonly<Record<string, string>>;
	devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
	source:
		| {
				type: "image";
				fingerprint: string;
		  }
		| {
				type: "image";
				mode: "pull";
				protocol: "simplestreams";
				server: string;
				fingerprint: string;
		  };
}

/** Step 3 extension surface: the persistent company-computer lane needs
 * instance snapshots on top of the Step 2 client contract. A separate
 * interface keeps every existing LxdClient implementer valid unchanged. */
export interface LxdInstanceSnapshotClient extends LxdClient {
	createInstanceSnapshot(project: string, name: string, snapshotName: string, signal?: AbortSignal): Promise<void>;
}

/** Persistent-machine recovery may replace a disposable VM root while
 * deliberately retaining its separately managed identity volume. */
export interface LxdPersistentInstanceClient extends LxdClient {
	deleteInstance(project: string, name: string, signal?: AbortSignal): Promise<void>;
}

export interface LxdClient {
	getInstance(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceRecord | undefined>;
	getInstanceState(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceStateRecord>;
	getStorageVolume(
		project: string,
		pool: string,
		name: string,
		signal?: AbortSignal,
	): Promise<LxdStorageVolumeRecord | undefined>;
	createStorageVolume(
		project: string,
		pool: string,
		request: LxdCreateStorageVolumeRequest,
		signal?: AbortSignal,
	): Promise<void>;
	createInstance(project: string, request: LxdCreateInstanceRequest, signal?: AbortSignal): Promise<void>;
	setInstancePower(project: string, name: string, action: LxdInstancePowerAction, signal?: AbortSignal): Promise<void>;
	pushInstanceFile(
		project: string,
		name: string,
		path: string,
		content: string,
		mode: number,
		signal?: AbortSignal,
	): Promise<void>;
	execInstance(project: string, name: string, command: readonly string[], signal?: AbortSignal): Promise<void>;
}

interface HttpResult {
	status: number;
	body: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
	const input = record(value, label);
	const output: Record<string, string> = {};
	for (const [key, entry] of Object.entries(input)) {
		if (typeof entry !== "string") throw new Error(`${label} is invalid`);
		output[key] = entry;
	}
	return output;
}

function devices(value: unknown): Record<string, Readonly<Record<string, string>>> {
	const input = record(value, "LXD instance devices");
	const output: Record<string, Readonly<Record<string, string>>> = {};
	for (const [name, device] of Object.entries(input)) output[name] = stringRecord(device, "LXD instance device");
	return output;
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new Error(`${label} is invalid`);
	}
	return [...value];
}

function instance(value: unknown): LxdInstanceRecord {
	const input = record(value, "LXD instance");
	if (
		typeof input.name !== "string" ||
		(input.type !== "virtual-machine" && input.type !== "container") ||
		typeof input.status !== "string" ||
		typeof input.status_code !== "number"
	) {
		throw new Error("LXD instance is invalid");
	}
	return {
		name: input.name,
		type: input.type,
		status: input.status,
		statusCode: input.status_code,
		config: stringRecord(input.config, "LXD instance config"),
		profiles: strings(input.profiles, "LXD instance profiles"),
		devices: devices(input.devices),
	};
}

function instanceState(value: unknown): LxdInstanceStateRecord {
	const input = record(value, "LXD instance state");
	if (typeof input.status !== "string" || typeof input.status_code !== "number") {
		throw new Error("LXD instance state is invalid");
	}
	const networkInput = record(input.network, "LXD instance network state");
	const network: Record<string, { addresses: readonly { family: string; address: string; scope: string }[] }> = {};
	for (const [name, rawInterface] of Object.entries(networkInput)) {
		const networkInterface = record(rawInterface, "LXD instance network interface");
		if (!Array.isArray(networkInterface.addresses)) throw new Error("LXD instance network addresses are invalid");
		const addresses = networkInterface.addresses.map((rawAddress) => {
			const address = record(rawAddress, "LXD instance network address");
			if (
				typeof address.family !== "string" ||
				typeof address.address !== "string" ||
				typeof address.scope !== "string"
			) {
				throw new Error("LXD instance network address is invalid");
			}
			return { family: address.family, address: address.address, scope: address.scope };
		});
		network[name] = { addresses };
	}
	return { status: input.status, statusCode: input.status_code, network };
}

function storageVolume(value: unknown): LxdStorageVolumeRecord {
	const input = record(value, "LXD storage volume");
	if (
		typeof input.name !== "string" ||
		input.type !== "custom" ||
		(input.content_type !== "filesystem" && input.content_type !== "block") ||
		typeof input.description !== "string"
	) {
		throw new Error("LXD storage volume is invalid");
	}
	return {
		name: input.name,
		type: "custom",
		contentType: input.content_type,
		description: input.description,
		config: stringRecord(input.config, "LXD storage volume config"),
	};
}

function lxdError(result: HttpResult, fallback: string): Error {
	try {
		const envelope = record(result.body, "LXD response");
		if (typeof envelope.error === "string" && envelope.error.trim()) return new Error(`LXD: ${envelope.error}`);
	} catch {
		// Use the bounded status-only error below for malformed daemon responses.
	}
	return new Error(`${fallback} (${result.status})`);
}

function envelopeMetadata(result: HttpResult): unknown {
	const envelope = record(result.body, "LXD response");
	if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD request failed");
	return envelope.metadata;
}

function projectPath(path: string, project: string): string {
	return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`;
}

export class LxdUnixClient implements LxdClient {
	readonly #socketPath: string;
	readonly #operationTimeoutSeconds: number;

	constructor(socketPath = "/var/snap/lxd/common/lxd/unix.socket", operationTimeoutSeconds = 120) {
		if (!socketPath.startsWith("/") || /[\0\r\n]/.test(socketPath)) throw new Error("LXD socket path is invalid");
		if (
			!Number.isSafeInteger(operationTimeoutSeconds) ||
			operationTimeoutSeconds < 1 ||
			operationTimeoutSeconds > 600
		) {
			throw new Error("LXD operation timeout is invalid");
		}
		this.#socketPath = socketPath;
		this.#operationTimeoutSeconds = operationTimeoutSeconds;
	}

	async getInstance(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceRecord | undefined> {
		const result = await this.#request(
			"GET",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}`, project),
			undefined,
			signal,
		);
		if (result.status === 404) return undefined;
		return instance(envelopeMetadata(result));
	}

	async getInstanceState(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceStateRecord> {
		const result = await this.#request(
			"GET",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/state`, project),
			undefined,
			signal,
		);
		return instanceState(envelopeMetadata(result));
	}

	async getStorageVolume(
		project: string,
		pool: string,
		name: string,
		signal?: AbortSignal,
	): Promise<LxdStorageVolumeRecord | undefined> {
		const result = await this.#request(
			"GET",
			projectPath(
				`/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
				project,
			),
			undefined,
			signal,
		);
		if (result.status === 404) return undefined;
		return storageVolume(envelopeMetadata(result));
	}

	async createStorageVolume(
		project: string,
		pool: string,
		request: LxdCreateStorageVolumeRequest,
		signal?: AbortSignal,
	): Promise<void> {
		if (request.type !== "custom" || request.content_type !== "filesystem") {
			throw new Error("LXD provider only creates custom filesystem volumes");
		}
		const result = await this.#request(
			"POST",
			projectPath(`/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom`, project),
			request,
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async createInstance(project: string, request: LxdCreateInstanceRequest, signal?: AbortSignal): Promise<void> {
		if (request.type !== "virtual-machine") throw new Error("LXD provider only creates full virtual machines");
		const result = await this.#request("POST", projectPath("/1.0/instances", project), request, signal);
		await this.#waitForOperation(result, signal);
	}

	async deleteInstance(project: string, name: string, signal?: AbortSignal): Promise<void> {
		const result = await this.#request(
			"DELETE",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}`, project),
			undefined,
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async createInstanceSnapshot(
		project: string,
		name: string,
		snapshotName: string,
		signal?: AbortSignal,
	): Promise<void> {
		/* Stateless snapshots only: the VM is near-stateless by design and its
		 * working world lives on the NAS dataset, so capturing guest RAM would
		 * record nothing durable. */
		if (!/^[a-z][a-z0-9-]{0,62}$/.test(snapshotName)) throw new Error("LXD snapshot name is invalid");
		const result = await this.#request(
			"POST",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/snapshots`, project),
			{ name: snapshotName, stateful: false },
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async setInstancePower(
		project: string,
		name: string,
		action: LxdInstancePowerAction,
		signal?: AbortSignal,
	): Promise<void> {
		const result = await this.#request(
			"PUT",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/state`, project),
			{ action, timeout: this.#operationTimeoutSeconds, force: action === "stop", stateful: false },
			signal,
		);
		await this.#waitForOperation(result, signal);
	}

	async pushInstanceFile(
		project: string,
		name: string,
		path: string,
		content: string,
		mode: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (!path.startsWith("/") || /[\0\r\n]/.test(path)) throw new Error("LXD instance file path is invalid");
		if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) throw new Error("LXD instance file mode is invalid");
		const payload = Buffer.from(content, "utf-8");
		if (payload.byteLength > MAX_INSTANCE_FILE_BYTES) throw new Error("LXD instance file exceeds the supported size");
		const result = await this.#requestPayload(
			"POST",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, project),
			payload,
			{
				"content-type": "application/octet-stream",
				"x-lxd-type": "file",
				"x-lxd-uid": "0",
				"x-lxd-gid": "0",
				"x-lxd-mode": mode.toString(8).padStart(4, "0"),
				"x-lxd-modify-perm": "uid,gid,mode",
			},
			signal,
		);
		envelopeMetadata(result);
	}

	async execInstance(project: string, name: string, command: readonly string[], signal?: AbortSignal): Promise<void> {
		if (
			command.length < 1 ||
			command.length > 64 ||
			command.some((argument) => !argument || /[\0\r\n]/.test(argument) || Buffer.byteLength(argument) > 4096)
		) {
			throw new Error("LXD instance command is invalid");
		}
		const result = await this.#request(
			"POST",
			projectPath(`/1.0/instances/${encodeURIComponent(name)}/exec`, project),
			{
				command: [...command],
				interactive: false,
				"wait-for-websocket": false,
				"record-output": true,
				user: 0,
				group: 0,
			},
			signal,
		);
		const operation = await this.#waitForOperation(result, signal);
		const metadata = record(operation.metadata, "LXD exec operation metadata");
		if (metadata.return !== 0) throw new Error("LXD instance command failed");
	}

	async #waitForOperation(result: HttpResult, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const envelope = record(result.body, "LXD response");
		if (result.status < 200 || result.status >= 300) throw lxdError(result, "LXD request failed");
		if (envelope.type === "sync") return record(envelope.metadata, "LXD synchronous operation");
		if (
			envelope.type !== "async" ||
			typeof envelope.operation !== "string" ||
			!envelope.operation.startsWith("/1.0/operations/")
		) {
			throw new Error("LXD operation response is invalid");
		}
		const waitPath = `${envelope.operation}/wait?timeout=${this.#operationTimeoutSeconds}`;
		const wait = await this.#request("GET", waitPath, undefined, signal);
		const operation = record(envelopeMetadata(wait), "LXD operation");
		if (
			typeof operation.status_code !== "number" ||
			operation.status_code < 200 ||
			operation.status_code >= 300 ||
			(typeof operation.err === "string" && operation.err.length > 0)
		) {
			throw new Error("LXD operation failed");
		}
		return operation;
	}

	async #request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<HttpResult> {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf-8");
		return this.#requestPayload(
			method,
			path,
			payload,
			payload ? { "content-type": "application/json" } : undefined,
			signal,
		);
	}

	async #requestPayload(
		method: string,
		path: string,
		payload: Buffer | undefined,
		headers: Readonly<Record<string, string>> | undefined,
		signal?: AbortSignal,
	): Promise<HttpResult> {
		return new Promise<HttpResult>((resolve, reject) => {
			const request = httpRequest(
				{
					method,
					path,
					socketPath: this.#socketPath,
					headers: payload ? { ...headers, "content-length": String(payload.byteLength) } : headers,
					signal,
				},
				(response) => {
					const chunks: Buffer[] = [];
					let length = 0;
					response.on("data", (chunk: Buffer) => {
						length += chunk.byteLength;
						if (length > MAX_RESPONSE_BYTES) {
							request.destroy(new Error("LXD response exceeded the supported size"));
							return;
						}
						chunks.push(chunk);
					});
					response.once("end", () => {
						try {
							const text = Buffer.concat(chunks).toString("utf-8");
							resolve({ status: response.statusCode ?? 500, body: text ? (JSON.parse(text) as unknown) : null });
						} catch (error) {
							reject(error);
						}
					});
				},
			);
			request.once("error", reject);
			if (payload) request.end(payload);
			else request.end();
		});
	}
}
