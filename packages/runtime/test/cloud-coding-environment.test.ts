import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	CODING_ENVIRONMENT_VALUE_MINIMUM_BYTES,
	type CodingEnvironmentRequest,
} from "../src/cloud-secret-broker.ts";
import { CloudSecretKeyring } from "../src/cloud-secret-crypto.ts";

// 5j-3: the coding executor asks the company's secret broker for the environment
// of one session it holds, the member's and the company's environment secrets
// (5j-1). Real envelope sealing and opening; the kernel is a fake authority.

const keyrings: CloudSecretKeyring[] = [];
afterEach(() => {
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const REFUSAL = "Coding environment is unavailable";
const KEY = "company-kek-1";
const repository = { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" };
// Values the tests seal. None is a real secret, and none may ever ride on an error.
const API_KEY = "env-value-api-key-CANARY";
const DATABASE_URL = "postgres://env-value-database-CANARY";

interface Entry {
	readonly name: string;
	readonly fields: Readonly<Record<string, string>>;
	readonly ownerKind?: "company" | "member";
}

type Answer = Record<string, unknown> & { readonly secrets: readonly Record<string, unknown>[] };

const signal = () => new AbortController().signal;

/** The custody methods these tests never reach. */
function unusedAuthority(): CloudSecretBrokerAuthority {
	const unused = () =>
		vi.fn(async (): Promise<never> => {
			throw new Error("unused");
		});
	return {
		describeCapture: unused(),
		completeCapture: unused(),
		authorizeOperation: unused(),
		authorizeRepositoryCredential: unused(),
	};
}

/** A broker whose fake kernel authorizes the sealed entries for the asking session, in the
 * entries' order; `edit` changes the kernel's answer before the broker reads it. */
function fixture(entries: readonly Entry[], edit: (answer: Answer) => unknown = (answer) => answer) {
	const companyId = randomUUID();
	const environmentId = randomUUID();
	const keyring = new CloudSecretKeyring({ [KEY]: randomBytes(32) });
	keyrings.push(keyring);
	const secrets = entries.map((entry, index) => {
		const identity = { companyId, environmentId, secretId: randomUUID(), version: index + 1, keyId: KEY };
		const envelope = Buffer.from(keyring.seal(entry.fields, identity));
		return {
			name: entry.name,
			secretId: identity.secretId,
			secretVersion: identity.version,
			keyId: KEY,
			ownerKind: entry.ownerKind ?? "company",
			// PostgreSQL's encode(...,'base64') wraps lines; the broker accepts that.
			encryptedEnvelopeBase64: envelope.toString("base64").replace(/(.{76})/g, "$1\n"),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		};
	});
	const authorizeCodingEnvironment = vi.fn(async (request: CodingEnvironmentRequest) =>
		edit({
			schema: "qorpera.coding-environment-authorization/v1",
			companyId,
			environmentId,
			workerId: request.workerId,
			repository,
			secrets,
		}),
	);
	const broker = new CloudSecretBroker({
		authority: { ...unusedAuthority(), authorizeCodingEnvironment },
		keyring,
		adapters: [],
	});
	const request: CodingEnvironmentRequest = {
		workerId: randomUUID(),
		leaseToken: randomUUID(),
		executorOwner: "coding-node-02",
	};
	return { broker, keyring, authorizeCodingEnvironment, request };
}

/** The broker's one opaque refusal: the exact message, with no cause, so a sealed value never rides on it. */
async function expectRefusal(promise: Promise<unknown>): Promise<void> {
	const error = await promise.catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(REFUSAL);
	expect((error as Error).cause).toBeUndefined();
	for (const value of [API_KEY, DATABASE_URL]) expect(`${(error as Error).stack}`).not.toContain(value);
}

describe("a coding session's environment through the company's secret broker", () => {
	it("opens each secret to its variable, in the kernel's order, for the session the executor holds", async () => {
		const f = fixture([
			{ name: "API_KEY", ownerKind: "member", fields: { value: API_KEY } },
			{ name: "DATABASE_URL", ownerKind: "company", fields: { value: DATABASE_URL } },
		]);
		const answer = await f.broker.codingEnvironment(
			{ ...f.request, workerId: f.request.workerId.toUpperCase(), leaseToken: f.request.leaseToken.toUpperCase() },
			signal(),
		);
		expect(answer).toEqual({ schema: "qorpera.coding-environment/v1", environment: { API_KEY, DATABASE_URL } });
		expect(Object.keys(answer.environment)).toEqual(["API_KEY", "DATABASE_URL"]);
		// The kernel is asked for exactly the request's worker, lease and executor, lower-cased.
		expect(f.authorizeCodingEnvironment).toHaveBeenCalledExactlyOnceWith(f.request, expect.any(AbortSignal));
	});

	it("gives an empty environment to a session with no environment secrets", async () => {
		const f = fixture([]);
		await expect(f.broker.codingEnvironment(f.request, signal())).resolves.toEqual({
			schema: "qorpera.coding-environment/v1",
			environment: {},
		});
	});

	it("refuses an answer that is not the one the kernel promised", async () => {
		const each = (answer: Answer, change: Record<string, unknown>) => ({
			...answer,
			secrets: answer.secrets.map((secret) => ({ ...secret, ...change })),
		});
		const edits: ((answer: Answer) => unknown)[] = [
			// A digest that is not the envelope's.
			(answer) => each(answer, { envelopeSha256: "0".repeat(64) }),
			// Another worker's session.
			(answer) => ({ ...answer, workerId: randomUUID() }),
			// An extra key on the answer or on a secret.
			(answer) => ({ ...answer, extra: true }),
			(answer) => each(answer, { extra: true }),
			// Other shapes the kernel never gives.
			(answer) => ({ ...answer, schema: "qorpera.coding-environment-authorization/v2" }),
			(answer) => ({ ...answer, companyId: "company" }),
			(answer) => ({ ...answer, repository: { ...repository, host: "gitlab.com" } }),
			(answer) => ({ ...answer, secrets: {} }),
			(answer) => each(answer, { ownerKind: "team" }),
			(answer) => each(answer, { secretVersion: 0 }),
			(answer) => each(answer, { keyId: "../key" }),
			(answer) => each(answer, { encryptedEnvelopeBase64: "not base64!" }),
		];
		for (const edit of edits) {
			const f = fixture([{ name: "API_KEY", fields: { value: API_KEY } }], edit);
			await expectRefusal(f.broker.codingEnvironment(f.request, signal()));
			expect(f.authorizeCodingEnvironment).toHaveBeenCalledTimes(1);
		}
	});

	it("refuses a name that is not an environment variable's, and a repeated name", async () => {
		for (const names of [["api_key"], ["1API_KEY"], ["API-KEY"], ["API_KEY", "API_KEY"]]) {
			const f = fixture(names.map((name) => ({ name, fields: { value: API_KEY } })));
			await expectRefusal(f.broker.codingEnvironment(f.request, signal()));
		}
	});

	it("refuses a sealed secret that is not exactly one value long enough to mask and without NUL", async () => {
		const sealed: Readonly<Record<string, string>>[] = [
			{ token: API_KEY },
			{ value: API_KEY, other: API_KEY },
			{ value: "1234567" },
			{ value: `${API_KEY}\0` },
		];
		for (const fields of sealed) {
			const f = fixture([{ name: "API_KEY", fields }]);
			await expectRefusal(f.broker.codingEnvironment(f.request, signal()));
		}
	});

	it("counts the minimum in UTF-8 bytes, not characters", async () => {
		expect(CODING_ENVIRONMENT_VALUE_MINIMUM_BYTES).toBe(8);
		// Eight ASCII bytes, and three characters of three bytes each, pass.
		for (const value of ["12345678", "€".repeat(3)]) {
			const f = fixture([{ name: "API_KEY", fields: { value } }]);
			await expect(f.broker.codingEnvironment(f.request, signal())).resolves.toEqual({
				schema: "qorpera.coding-environment/v1",
				environment: { API_KEY: value },
			});
		}
		// Seven ASCII bytes do not.
		const f = fixture([{ name: "API_KEY", fields: { value: "abcdefg" } }]);
		await expectRefusal(f.broker.codingEnvironment(f.request, signal()));
	});

	it("refuses the whole environment when one secret is bad, and never names a value", async () => {
		const f = fixture([
			{ name: "API_KEY", fields: { value: API_KEY } },
			{ name: "DATABASE_URL", fields: { value: DATABASE_URL, other: DATABASE_URL } },
		]);
		await expectRefusal(f.broker.codingEnvironment(f.request, signal()));
	});

	it("refuses before the kernel when the broker cannot serve environments or the request is invalid", async () => {
		const f = fixture([{ name: "API_KEY", fields: { value: API_KEY } }]);
		// An authority without the method, like the service-role one.
		const bare = new CloudSecretBroker({ authority: unusedAuthority(), keyring: f.keyring, adapters: [] });
		await expectRefusal(bare.codingEnvironment(f.request, signal()));
		for (const request of [
			{ ...f.request, workerId: "../worker" },
			{ ...f.request, leaseToken: "lease" },
			{ ...f.request, executorOwner: "exec owner" },
		])
			await expectRefusal(f.broker.codingEnvironment(request, signal()));
		expect(f.authorizeCodingEnvironment).not.toHaveBeenCalled();
		// A request given up while the broker worked gets nothing.
		const controller = new AbortController();
		controller.abort();
		await expectRefusal(f.broker.codingEnvironment(f.request, controller.signal));
	});
});

/** A broker with one open capture ticket for a connector. */
function captureFixture(connectorId: string) {
	const keyring = new CloudSecretKeyring({ [KEY]: randomBytes(32) });
	keyrings.push(keyring);
	const description = {
		schema: "qorpera.cloud-secret-capture-description/v1",
		ticketId: randomUUID(),
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		ownerKind: "company",
		ownerUserId: null,
		connectorId,
		secretName: "api_key",
		purpose: "A coding session's environment variable",
		keyId: KEY,
		expiresAt: "2099-08-29T12:00:00.000Z",
	};
	const describeCapture = vi.fn(async () => description);
	const completeCapture = vi.fn(async () => ({
		schema: "qorpera.cloud-secret-descriptor/v1",
		secretId: description.secretId,
		version: description.version,
		connectorId,
		secretName: description.secretName,
		purpose: description.purpose,
		ownerKind: "company",
		ownerUserId: null,
		status: "active",
	}));
	const broker = new CloudSecretBroker({
		authority: { ...unusedAuthority(), describeCapture, completeCapture },
		keyring,
		adapters: [],
	});
	const capture = (fields: Readonly<Record<string, string>>) =>
		broker.capture(
			{ ticketId: description.ticketId, captureCapability: randomBytes(32).toString("base64url"), fields },
			signal(),
		);
	return { capture, describeCapture, completeCapture };
}

describe("capturing a coding environment secret", () => {
	it("refuses a value that could never be handed out before anything is sealed or saved", async () => {
		const refused: Readonly<Record<string, string>>[] = [
			{ value: "1234567" },
			{ value: "x", other: "y" },
			{ token: API_KEY },
			{ value: `${API_KEY}\0` },
		];
		for (const fields of refused) {
			const f = captureFixture("environment");
			const error = await f.capture(fields).catch((failure: unknown) => failure);
			expect((error as Error).message).toBe("Cloud secret capture was not confirmed");
			expect(String(error)).not.toContain(API_KEY);
			expect(f.describeCapture).toHaveBeenCalledTimes(1);
			expect(f.completeCapture).not.toHaveBeenCalled();
		}
	});

	it("seals and saves a value of the minimum length", async () => {
		const f = captureFixture("environment");
		await expect(f.capture({ value: "12345678" })).resolves.toMatchObject({
			connectorId: "environment",
			status: "active",
		});
		expect(f.completeCapture).toHaveBeenCalledTimes(1);
	});

	it("leaves other connectors' captures as they were", async () => {
		const f = captureFixture("gmail");
		await expect(f.capture({ access_token: "x" })).resolves.toMatchObject({ connectorId: "gmail" });
		expect(f.completeCapture).toHaveBeenCalledTimes(1);
	});
});
