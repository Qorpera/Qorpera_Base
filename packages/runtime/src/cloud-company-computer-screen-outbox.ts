import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerScope,
	type CompanyComputerScope,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	assertCompanyComputerScreenEventReceipt,
	type CompanyComputerScreenEventCustody,
	type CompanyComputerScreenLifecycleRegistry,
	type CompanyComputerScreenObservation,
	parseCompanyComputerScreenObservation,
} from "./cloud-company-computer-screen-lifecycle.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECORD = new RegExp(`^(${UUID})-([0-9]{16})\\.json$`);
const TEMPORARY = new RegExp(`^\\.write-${UUID}$`);
const LIMIT = 73729;
const MAX_RECORDS = 8192;
const MAX_BYTES = 64 * 1024 * 1024;
const isCode = (error: unknown, code: string): boolean =>
	error instanceof Error && "code" in error && error.code === code;
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b, "en"))
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}
const bytesFor = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const nameFor = (value: CompanyComputerScreenObservation): string =>
	`${value.event.lifetimeId}-${String(value.event.sequence).padStart(16, "0")}.json`;

function assertRetentionReceipt(value: unknown, observation: CompanyComputerScreenObservation, bytes: Buffer): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_SCREEN_RETENTION_RECEIPT");
	const r = value as Record<string, unknown>,
		event = observation.event;
	// A direct call may have committed before its response was lost. The
	// retention RPC returns that original canonical receipt without duplicating it.
	if (r.schema === "qorpera.runtime-screen-event-receipt/v1") {
		assertCompanyComputerScreenEventReceipt(value, event);
		return;
	}
	if (
		Object.keys(r).sort().join() !==
			"confirmation,eventId,lifetimeId,observationSha256,observedAt,retainedAt,schema,sequence,state" ||
		r.schema !== "qorpera.runtime-screen-retention-receipt/v1" ||
		r.confirmation !== "unconfirmed" ||
		r.lifetimeId !== event.lifetimeId ||
		r.eventId !== event.eventId ||
		r.sequence !== event.sequence ||
		r.state !== event.state ||
		r.observedAt !== event.observedAt ||
		typeof r.retainedAt !== "string" ||
		!Number.isFinite(Date.parse(r.retainedAt)) ||
		r.observationSha256 !== createHash("sha256").update(bytes).digest("hex")
	)
		throw new Error("INVALID_SCREEN_RETENTION_RECEIPT");
}

/** Private service-owned local custody. The root must be provisioned outside
 * every guest-visible mount. Local records are removed only after an exact SQL
 * receipt confirming canonical publication or separate unconfirmed custody.
 * The ordinary systemd service owns the sole writer lifetime. */
export class CompanyComputerScreenOutbox implements CompanyComputerScreenEventCustody {
	readonly #root: string;
	readonly #scope: CompanyComputerScope;
	readonly #identity: { dev: number; ino: number };
	readonly #registry: CompanyComputerScreenLifecycleRegistry;
	readonly #stop = new AbortController();
	#writing: Promise<unknown> = Promise.resolve();
	#flushing?: Promise<void>;
	#timer?: ReturnType<typeof setTimeout>;
	#cursor = "";
	#closing?: Promise<void>;
	#started = false;
	#local<T>(operation: () => Promise<T>): Promise<T> {
		const work = this.#writing.then(operation);
		this.#writing = work.catch(() => undefined);
		return work;
	}
	private constructor(
		root: string,
		scope: CompanyComputerScope,
		identity: { dev: number; ino: number },
		registry: CompanyComputerScreenLifecycleRegistry,
	) {
		this.#root = root;
		this.#scope = structuredClone(scope);
		this.#identity = identity;
		this.#registry = registry;
	}
	static async open(
		root: string,
		scope: CompanyComputerScope,
		excludedRoots: readonly string[],
		registry: CompanyComputerScreenLifecycleRegistry,
	): Promise<CompanyComputerScreenOutbox> {
		assertCompanyComputerScope(scope, scope);
		if (
			resolve(root) !== root ||
			root === sep ||
			excludedRoots.some(
				(path) =>
					resolve(path) !== path ||
					path === root ||
					path.startsWith(`${root}${sep}`) ||
					root.startsWith(`${path}${sep}`),
			)
		)
			throw new Error("SCREEN_OUTBOX_PATH_UNSAFE");
		for (const path of excludedRoots) {
			if ((await realpath(path)) !== path) throw new Error("SCREEN_OUTBOX_PATH_UNSAFE");
		}
		const identity = await lstat(root);
		const outbox = new CompanyComputerScreenOutbox(root, scope, identity, registry);
		await outbox.#checkRoot();
		await outbox.#recoverTemporary();
		const existing = await readdir(root);
		if (existing.some((name) => RECORD.test(name)) && !existing.includes("scope.json"))
			throw new Error("SCREEN_OUTBOX_SCOPE_MISSING");
		await outbox.#publish("scope.json", bytesFor({ schema: "qorpera.screen-outbox-scope/v1", scope }));
		await outbox.#records();
		return outbox;
	}
	async #checkRoot(): Promise<void> {
		const stat = await lstat(this.#root);
		if (
			!stat.isDirectory() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o7777) !== 0o700 ||
			stat.dev !== this.#identity.dev ||
			stat.ino !== this.#identity.ino ||
			(await realpath(this.#root)) !== this.#root
		)
			throw new Error("SCREEN_OUTBOX_DIRECTORY_UNSAFE");
	}
	async #syncRoot(): Promise<void> {
		await this.#checkRoot();
		const directory = await open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
	async #read(name: string, links = 1): Promise<{ bytes: Buffer; value: unknown }> {
		await this.#checkRoot();
		const file = await open(join(this.#root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await file.stat();
			if (
				!before.isFile() ||
				before.uid !== process.getuid?.() ||
				(before.mode & 0o7777) !== 0o600 ||
				before.nlink !== links ||
				before.size < 1 ||
				before.size > LIMIT
			)
				throw new Error("SCREEN_OUTBOX_RECORD_UNSAFE");
			const buffer = Buffer.alloc(before.size + 1);
			let size = 0;
			while (size < buffer.length) {
				const result = await file.read(buffer, size, buffer.length - size, size);
				if (!result.bytesRead) break;
				size += result.bytesRead;
			}
			const after = await file.stat();
			if (
				size !== before.size ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs ||
				before.mode !== after.mode ||
				before.uid !== after.uid ||
				before.nlink !== after.nlink
			)
				throw new Error("SCREEN_OUTBOX_RECORD_CHANGED");
			const bytes = buffer.subarray(0, size);
			await this.#checkRoot();
			return { bytes, value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) };
		} finally {
			await file.close();
		}
	}
	async #recoverTemporary(): Promise<void> {
		const names = await readdir(this.#root);
		if (names.length > MAX_RECORDS * 2 + 2) throw new Error("SCREEN_OUTBOX_CAPACITY");
		for (const name of names.filter((name) => TEMPORARY.test(name))) {
			const stat = await lstat(join(this.#root, name));
			if (
				!stat.isFile() ||
				stat.uid !== process.getuid?.() ||
				(stat.mode & 0o7777) !== 0o600 ||
				stat.size > LIMIT ||
				![1, 2].includes(stat.nlink)
			)
				throw new Error("SCREEN_OUTBOX_TEMPORARY_UNSAFE");
			if (stat.nlink === 2) {
				const { value } = await this.#read(name, 2);
				const scope = { schema: "qorpera.screen-outbox-scope/v1", scope: this.#scope };
				const target = isDeepStrictEqual(value, scope) ? "scope.json" : nameFor(this.#observation(value));
				const linked = await lstat(join(this.#root, target));
				if (linked.dev !== stat.dev || linked.ino !== stat.ino || linked.nlink !== 2)
					throw new Error("SCREEN_OUTBOX_TEMPORARY_CHANGED");
			}
			// A single-linked temporary never became an authoritative record.
			// Two links are repaired only with the exact complete published inode.
			await unlink(join(this.#root, name));
			await this.#syncRoot();
		}
	}
	#observation(value: unknown): CompanyComputerScreenObservation {
		const observation = parseCompanyComputerScreenObservation(value);
		assertCompanyComputerScope(observation.startup.scope, this.#scope);
		return observation;
	}
	async #records(): Promise<{ name: string; observation: CompanyComputerScreenObservation; bytes: number }[]> {
		await this.#checkRoot();
		const names = await readdir(this.#root);
		if (
			names.length > MAX_RECORDS + 2 ||
			names.some((name) => name !== "scope.json" && !RECORD.test(name) && !TEMPORARY.test(name))
		)
			throw new Error("SCREEN_OUTBOX_INVENTORY_UNSAFE");
		if (
			!names.includes("scope.json") ||
			!isDeepStrictEqual((await this.#read("scope.json")).value, {
				schema: "qorpera.screen-outbox-scope/v1",
				scope: this.#scope,
			})
		)
			throw new Error("SCREEN_OUTBOX_SCOPE_MISSING");
		const records = [];
		let bytes = 0;
		for (const name of names.filter((name) => RECORD.test(name)).sort()) {
			const record = await this.#read(name);
			const observation = this.#observation(record.value);
			if (nameFor(observation) !== name) throw new Error("SCREEN_OUTBOX_RECORD_IDENTITY_DIFFERS");
			if (!bytesFor(observation).equals(record.bytes)) throw new Error("SCREEN_OUTBOX_RECORD_CHANGED");
			bytes += record.bytes.length;
			if (bytes > MAX_BYTES) throw new Error("SCREEN_OUTBOX_CAPACITY");
			records.push({ name, observation, bytes: record.bytes.length });
		}
		return records;
	}
	async #publish(name: string, bytes: Buffer): Promise<void> {
		await this.#checkRoot();
		const temporary = join(this.#root, `.write-${randomUUID()}`);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await link(temporary, join(this.#root, name));
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
			const existing = await this.#read(name);
			if (!existing.bytes.equals(bytes)) throw new Error("SCREEN_OUTBOX_RECORD_CHANGED");
		} finally {
			await unlink(temporary);
			await this.#syncRoot();
		}
	}
	retain(value: CompanyComputerScreenObservation, signal: AbortSignal): Promise<void> {
		const observation = this.#observation(value);
		const bytes = bytesFor(observation);
		if (this.#closing) return Promise.reject(new Error("SCREEN_OUTBOX_CLOSED"));
		return this.#local(async () => {
			signal.throwIfAborted();
			const records = await this.#records();
			const name = nameFor(observation);
			if (
				!records.some((record) => record.name === name) &&
				(records.length >= MAX_RECORDS ||
					records.reduce((size, record) => size + record.bytes, bytes.length) > MAX_BYTES)
			)
				throw new Error("SCREEN_OUTBOX_CAPACITY");
			await this.#publish(name, bytes);
		});
	}
	async canHeartbeat(lifetimeId: string): Promise<boolean> {
		return this.#local(
			async () => !(await this.#records()).some((record) => record.observation.event.lifetimeId === lifetimeId),
		);
	}
	flush(signal: AbortSignal): Promise<void> {
		if (this.#closing) return Promise.reject(new Error("SCREEN_OUTBOX_CLOSED"));
		if (this.#flushing) return this.#flushing;
		signal = AbortSignal.any([signal, this.#stop.signal]);
		this.#flushing = (async () => {
			const records = await this.#local(() => this.#records());
			const first = new Map<string, (typeof records)[number]>();
			for (const record of records)
				if (!first.has(record.observation.event.lifetimeId)) first.set(record.observation.event.lifetimeId, record);
			const ordered = [...first.values()];
			const candidates = [
				...ordered.filter((r) => r.name > this.#cursor),
				...ordered.filter((r) => r.name <= this.#cursor),
			].slice(0, 64);
			for (const record of candidates) {
				signal.throwIfAborted();
				this.#cursor = record.name;
				const { startup, binding, privacy, event } = record.observation;
				try {
					const receipt = await cloudToolRequest(
						(checked) =>
							this.#registry.call(
								"qorpera_record_runtime_screen_event",
								structuredClone({ p_startup: startup, p_binding: binding, p_privacy: privacy, p_event: event }),
								checked,
							),
						signal,
						3000,
					);
					assertCompanyComputerScreenEventReceipt(receipt, event);
				} catch {
					try {
						const bytes = bytesFor(record.observation);
						const receipt = await cloudToolRequest(
							(checked) =>
								this.#registry.call(
									"qorpera_retain_runtime_screen_observation",
									{ p_record: bytes.toString("utf8") },
									checked,
								),
							signal,
							3000,
						);
						assertRetentionReceipt(receipt, record.observation, bytes);
					} catch {
						continue;
					}
				}
				await this.#local(async () => {
					await this.#checkRoot();
					const current = await this.#read(record.name);
					if (!isDeepStrictEqual(current.value, record.observation))
						throw new Error("SCREEN_OUTBOX_RECORD_CHANGED");
					await unlink(join(this.#root, record.name));
					await this.#syncRoot();
				});
			}
		})().finally(() => {
			this.#flushing = undefined;
		});
		return this.#flushing;
	}
	start(): void {
		if (this.#started || this.#closing) return;
		this.#started = true;
		const tick = (): void => {
			if (this.#stop.signal.aborted) return;
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				void this.flush(this.#stop.signal)
					.catch(() => undefined)
					.then(tick);
			}, 2000);
		};
		tick();
	}
	close(): Promise<void> {
		this.#stop.abort();
		clearTimeout(this.#timer);
		this.#closing ??= Promise.resolve().then(async () => {
			await this.#writing;
			await this.#flushing?.catch(() => undefined);
		});
		return this.#closing;
	}
}
