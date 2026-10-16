import { createHash } from "node:crypto";
import { type CloudCodingCommandScope, type CloudCodingRepository, cloudCodingSessionLayout } from "@qorpera/contracts";
import { inspectCodingSessionGuest } from "./coding-command-transport.ts";
import {
	type CodingMachineStorage,
	type LxdCodingMachineBinding,
	lxdCodingMachineName,
	lxdCodingMachinePlan,
} from "./coding-machine.ts";
import type { LxdInspectableClient } from "./lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const HELPER = "/opt/qorpera-coding/cloud-coding-git-guest.mjs";
const CHUNK = 32768,
	LIMIT = 64 * 1024 ** 2,
	// A seed chunk's base64 is exactly LXD's largest file push (256 KiB).
	SEED_CHUNK = 196608,
	SEED_LIMIT = 256 * 1024 ** 2,
	// The guest imports a whole seed in one command.
	SEED_WAIT_SECONDS = 600;
type Client = Pick<LxdInspectableClient, "getInstance" | "readInstanceFile" | "pushInstanceFile" | "execInstance">;
interface Request {
	schema: "qorpera.coding-git-transfer/v1";
	workerId: string;
	vmId: string;
	transferId: string;
	action: "seed" | "export";
	repository: CloudCodingRepository;
	headSha: string;
	bundleSha256: string | null;
	bundleBytes: number;
}
export interface CodingGitTransferReceipt {
	schema: "qorpera.coding-git-receipt/v1";
	workerId: string;
	vmId: string;
	transferId: string;
	action: "seed" | "export";
	headSha: string;
	bundleSha256: string;
	bundleBytes: number;
	chunkCount: number;
}
export interface LxdCodingGitTransferOptions {
	machine: LxdCodingMachineBinding;
	storage: CodingMachineStorage;
	/** The session's repository (qorpera_coding_sessions.repository). */
	repository: CloudCodingRepository;
	scope: CloudCodingCommandScope;
	bootId: string;
	helperSha256: string;
	guestConfigSha256: string;
	client: Client;
	/** Must verify current execution receipt/worker lease, exclusive stopped
	 * workspace command lane, exact target/head and transfer digest. */
	authorize(
		action: "seed" | "export",
		scope: CloudCodingCommandScope,
		transferId: string,
		requestSha256: string,
		signal: AbortSignal,
	): Promise<void>;
}

/** Protected byte transport only. Credentials stay in the broker. Every LXD
 * effect is fenced by live authority, the exact machine with this session
 * attached, boot and helper hashes. */
export class LxdCodingGitTransfer {
	readonly #options: LxdCodingGitTransferOptions;
	readonly #machine: Readonly<LxdCodingMachineBinding>;
	readonly #project: string;
	readonly #name: string;
	readonly #custody: string;
	constructor(options: LxdCodingGitTransferOptions) {
		const machine = lxdCodingMachinePlan(options.machine).binding;
		if (
			Object.keys(options.scope).sort().join() !== "requestId,turn,vmId,workerId" ||
			!UUID.test(options.scope.workerId) ||
			options.scope.vmId !== machine.machineId ||
			!UUID.test(options.scope.requestId) ||
			!Number.isSafeInteger(options.scope.turn) ||
			options.scope.turn < 1 ||
			!UUID.test(options.bootId) ||
			!SHA.test(options.helperSha256) ||
			!SHA.test(options.guestConfigSha256)
		)
			throw new Error("CODING_GIT_TRANSFER_BINDING_INVALID");
		this.#options = { ...options, scope: Object.freeze({ ...options.scope }) };
		this.#machine = machine;
		this.#project = machine.project;
		this.#name = lxdCodingMachineName(machine.machineId);
		this.#custody = cloudCodingSessionLayout(options.scope.workerId).custodyRoot;
	}
	async #gate(request: Request, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
		const authorize = () =>
			this.#options.authorize(request.action, this.#options.scope, request.transferId, digest, signal);
		await authorize();
		await inspectCodingSessionGuest(
			{
				machine: this.#machine,
				storage: this.#options.storage,
				workerId: this.#options.scope.workerId,
				bootId: this.#options.bootId,
				helperSha256: this.#options.helperSha256,
				guestConfigSha256: this.#options.guestConfigSha256,
				client: this.#options.client,
			},
			HELPER,
			[0o444],
			signal,
		);
		await authorize();
		signal.throwIfAborted();
	}
	async #read(request: Request, path: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
		await this.#gate(request, signal);
		const file = await this.#options.client.readInstanceFile(this.#project, this.#name, path, maximum, signal);
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444 || file.content.length > maximum)
			throw new Error("CODING_GIT_TRANSFER_UNPROTECTED");
		return file.content;
	}
	/** Unread: a seed chunk is larger than a file read. The guest takes only a
	 * root-owned 0444 chunk of the exact size and checks the whole digest. */
	async #stage(request: Request, path: string, text: string, signal: AbortSignal): Promise<void> {
		await this.#gate(request, signal);
		await this.#options.client.pushInstanceFile(this.#project, this.#name, path, text, 0o444, signal);
	}
	async #push(request: Request, path: string, text: string, signal: AbortSignal): Promise<void> {
		await this.#stage(request, path, text, signal);
		if (!(await this.#read(request, path, Buffer.byteLength(text), signal)).equals(Buffer.from(text)))
			throw new Error("CODING_GIT_TRANSFER_STAGING_CHANGED");
	}
	async #invoke(request: Request, action: "prepare" | "seed" | "export", signal: AbortSignal): Promise<void> {
		await this.#gate(request, signal);
		await this.#options.client.execInstance(
			this.#project,
			this.#name,
			["/usr/bin/node", HELPER, action, request.workerId, request.transferId],
			signal,
			action === "seed" ? SEED_WAIT_SECONDS : undefined,
		);
	}
	async #receipt(request: Request, signal: AbortSignal): Promise<CodingGitTransferReceipt> {
		const [chunk, limit] = request.action === "seed" ? [SEED_CHUNK, SEED_LIMIT] : [CHUNK, LIMIT];
		const value = JSON.parse(
			(await this.#read(request, `${this.#custody}/git/${request.transferId}/receipt.json`, 8192, signal)).toString(
				"utf8",
			),
		) as CodingGitTransferReceipt;
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).sort().join() !==
				"action,bundleBytes,bundleSha256,chunkCount,headSha,schema,transferId,vmId,workerId" ||
			value.schema !== "qorpera.coding-git-receipt/v1" ||
			value.workerId !== request.workerId ||
			value.vmId !== request.vmId ||
			value.transferId !== request.transferId ||
			value.action !== request.action ||
			value.headSha !== request.headSha ||
			typeof value.bundleSha256 !== "string" ||
			!SHA.test(value.bundleSha256) ||
			!Number.isSafeInteger(value.bundleBytes) ||
			value.bundleBytes < 1 ||
			value.bundleBytes > limit ||
			value.chunkCount !== Math.ceil(value.bundleBytes / chunk) ||
			(request.action === "seed" &&
				(value.bundleSha256 !== request.bundleSha256 || value.bundleBytes !== request.bundleBytes))
		)
			throw new Error("CODING_GIT_TRANSFER_RECEIPT_CHANGED");
		return value;
	}
	#request(transferId: string, headSha: string, bundle?: Uint8Array): Request {
		if (
			!UUID.test(transferId) ||
			!/^[0-9a-f]{40}$/.test(headSha) ||
			(bundle !== undefined &&
				(!(bundle instanceof Uint8Array) || bundle.byteLength < 1 || bundle.byteLength > SEED_LIMIT))
		)
			throw new Error("INVALID_CODING_GIT_TRANSFER");
		return {
			schema: "qorpera.coding-git-transfer/v1",
			workerId: this.#options.scope.workerId,
			vmId: this.#machine.machineId,
			transferId,
			action: bundle ? "seed" : "export",
			repository: this.#options.repository,
			headSha,
			bundleSha256: bundle ? createHash("sha256").update(bundle).digest("hex") : null,
			bundleBytes: bundle?.byteLength ?? 0,
		};
	}
	async seed(
		transferId: string,
		headSha: string,
		value: Uint8Array,
		signal: AbortSignal,
	): Promise<CodingGitTransferReceipt> {
		const request = this.#request(transferId, headSha, value),
			bundle = Buffer.from(value);
		await this.#push(request, `${this.#custody}/inbox/${transferId}.git.json`, JSON.stringify(request), signal);
		await this.#invoke(request, "prepare", signal);
		for (let index = 0; index < Math.ceil(bundle.length / SEED_CHUNK); index++)
			await this.#stage(
				request,
				`${this.#custody}/git/${transferId}/${String(index).padStart(6, "0")}.base64`,
				bundle.subarray(index * SEED_CHUNK, (index + 1) * SEED_CHUNK).toString("base64"),
				signal,
			);
		await this.#invoke(request, "seed", signal);
		const receipt = await this.#receipt(request, signal);
		await this.#gate(request, signal);
		return receipt;
	}
	async export(
		transferId: string,
		headSha: string,
		signal: AbortSignal,
	): Promise<{ receipt: CodingGitTransferReceipt; bundle: Buffer }> {
		const request = this.#request(transferId, headSha);
		await this.#push(request, `${this.#custody}/inbox/${transferId}.git.json`, JSON.stringify(request), signal);
		await this.#invoke(request, "export", signal);
		const receipt = await this.#receipt(request, signal),
			parts: Buffer[] = [];
		for (let index = 0; index < receipt.chunkCount; index++) {
			const chunk = await this.#read(
				request,
				`${this.#custody}/git/${transferId}/${String(index).padStart(6, "0")}.bundle`,
				CHUNK,
				signal,
			);
			if (chunk.length !== Math.min(CHUNK, receipt.bundleBytes - index * CHUNK))
				throw new Error("CODING_GIT_TRANSFER_CHUNK_CHANGED");
			parts.push(chunk);
		}
		const bundle = Buffer.concat(parts);
		if (createHash("sha256").update(bundle).digest("hex") !== receipt.bundleSha256)
			throw new Error("CODING_GIT_TRANSFER_DIGEST_CHANGED");
		await this.#gate(request, signal);
		return { receipt, bundle };
	}
}
