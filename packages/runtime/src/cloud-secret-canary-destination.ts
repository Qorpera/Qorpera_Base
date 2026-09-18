import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Step2SecretCanaryBehavior } from "./cloud-secret-canary-adapter.ts";

const STATE_SCHEMA = "qorpera.step2-secret-canary-state/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BEHAVIORS = new Set<Step2SecretCanaryBehavior>([
	"safe",
	"reflect_raw",
	"reflect_url",
	"reflect_base64",
	"reflect_base64url",
	"drop_once",
	"stall",
]);

interface StoredEffect {
	readonly inputSha256: string;
	readonly effectId: string;
}

interface StoredState {
	schema: typeof STATE_SCHEMA;
	effects: Record<string, StoredEffect>;
}

function state(value: unknown): StoredState {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error("Step 2 secret canary state is invalid");
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !== ["effects", "schema"].join() ||
		input.schema !== STATE_SCHEMA ||
		!input.effects ||
		typeof input.effects !== "object" ||
		Array.isArray(input.effects) ||
		Object.getPrototypeOf(input.effects) !== Object.prototype
	) {
		throw new Error("Step 2 secret canary state is invalid");
	}
	const entries = Object.entries(input.effects as Record<string, unknown>);
	if (entries.length > 512) throw new Error("Step 2 secret canary state is invalid");
	const effects: Record<string, StoredEffect> = Object.create(null) as Record<string, StoredEffect>;
	for (const [key, valueEntry] of entries) {
		if (
			!SHA.test(key) ||
			!valueEntry ||
			typeof valueEntry !== "object" ||
			Array.isArray(valueEntry) ||
			Object.getPrototypeOf(valueEntry) !== Object.prototype
		) {
			throw new Error("Step 2 secret canary state is invalid");
		}
		const effect = valueEntry as Record<string, unknown>;
		if (
			Object.keys(effect).sort().join() !== ["effectId", "inputSha256"].join() ||
			typeof effect.inputSha256 !== "string" ||
			!SHA.test(effect.inputSha256) ||
			typeof effect.effectId !== "string" ||
			!UUID.test(effect.effectId)
		) {
			throw new Error("Step 2 secret canary state is invalid");
		}
		effects[key] = { inputSha256: effect.inputSha256, effectId: effect.effectId };
	}
	return { schema: STATE_SCHEMA, effects };
}

async function durableWrite(path: string, value: StoredState): Promise<void> {
	const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	const temporary = join(dirname(path), `.effects-${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(encoded);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		encoded.fill(0);
		await handle?.close().catch(() => undefined);
	}
}

/** Durable idempotency ledger for the deliberately bounded canary endpoint. */
export class Step2SecretCanaryLedger {
	readonly #path: string;
	readonly #state: StoredState;
	#lock: Promise<void> = Promise.resolve();

	private constructor(path: string, initial: StoredState) {
		this.#path = path;
		this.#state = initial;
	}

	static async open(path: string): Promise<Step2SecretCanaryLedger> {
		if (!path.startsWith("/") || !path.endsWith(".json")) {
			throw new Error("Step 2 secret canary state path is invalid");
		}
		try {
			const encoded = await readFile(path);
			try {
				if (encoded.byteLength > 128 * 1024) throw new Error("Step 2 secret canary state is invalid");
				return new Step2SecretCanaryLedger(
					path,
					state(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown),
				);
			} finally {
				encoded.fill(0);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return new Step2SecretCanaryLedger(path, { schema: STATE_SCHEMA, effects: Object.create(null) });
		}
	}

	async admit(
		idempotencyKey: string,
		label: string,
		behavior: Step2SecretCanaryBehavior,
	): Promise<{ readonly effectId: string; readonly reused: boolean }> {
		if (!OPERATION_KEY.test(idempotencyKey) || !LABEL.test(label) || !BEHAVIORS.has(behavior)) {
			throw new Error("Step 2 secret canary effect is invalid");
		}
		let release: (() => void) | undefined;
		const predecessor = this.#lock;
		this.#lock = new Promise<void>((resolveLock) => {
			release = resolveLock;
		});
		await predecessor;
		try {
			const key = createHash("sha256").update(idempotencyKey).digest("hex");
			const inputSha256 = createHash("sha256")
				.update(JSON.stringify({ schema: "qorpera.step2-secret-canary-request/v1", label, behavior }))
				.digest("hex");
			const existing = this.#state.effects[key];
			if (existing) {
				if (existing.inputSha256 !== inputSha256) {
					throw new Error("Step 2 secret canary idempotency key differs");
				}
				return { effectId: existing.effectId, reused: true };
			}
			if (Object.keys(this.#state.effects).length >= 512) {
				throw new Error("Step 2 secret canary state is full");
			}
			const effectId = randomUUID();
			this.#state.effects[key] = { inputSha256, effectId };
			try {
				await durableWrite(this.#path, this.#state);
			} catch (error) {
				delete this.#state.effects[key];
				throw error;
			}
			return { effectId, reused: false };
		} finally {
			release?.();
		}
	}
}

export function step2SecretCanaryReflection(
	credential: Uint8Array,
	behavior: Step2SecretCanaryBehavior,
): string | undefined {
	const value = Buffer.from(credential);
	try {
		switch (behavior) {
			case "reflect_raw":
				return value.toString("utf8");
			case "reflect_url":
				return encodeURIComponent(value.toString("utf8"));
			case "reflect_base64":
				return value.toString("base64");
			case "reflect_base64url":
				return value.toString("base64url");
			default:
				return undefined;
		}
	} finally {
		value.fill(0);
	}
}
