import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerCodingEnvironment } from "../../../deploy/coding-worker/coding-environment.ts";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CodingEnvironmentRequest,
} from "../src/cloud-secret-broker.ts";
import { HttpCloudSecretBrokerService } from "../src/cloud-secret-broker-http.ts";
import { CloudSecretKeyring } from "../src/cloud-secret-crypto.ts";

// 5j-4: the coding executor asks the company's secret broker for the
// environment of one session it holds, for each command it starts. Real broker
// HTTP service, real envelope sealing and opening; the kernel is a fake
// authority.

const services: HttpCloudSecretBrokerService[] = [];
const keyrings: CloudSecretKeyring[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const UNAVAILABLE = "CODING_ENVIRONMENT_UNAVAILABLE";
const KEY = "company-kek-1";
const repository = { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" };
// Values the tests seal or answer. None is a real secret, and none may ever ride on an error.
const API_KEY = "env-value-api-key-CANARY";
const DATABASE_URL = "postgres://env-value-database-CANARY";
const OLD_API_KEY = "env-value-old-api-key-CANARY";

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

/** A broker HTTP service whose fake kernel authorizes API_KEY and DATABASE_URL for the asking session, and older
 * versions of API_KEY with the `masked` values when given, and the executor's client for it on the shared public
 * origin. */
async function fixture(options: { refuse?: boolean; masked?: readonly string[] } = {}) {
	const companyId = randomUUID();
	const environmentId = randomUUID();
	const keyring = new CloudSecretKeyring({ [KEY]: randomBytes(32) });
	keyrings.push(keyring);
	const seal = (name: string, value: string, version: number) => {
		const identity = { companyId, environmentId, secretId: randomUUID(), version, keyId: KEY };
		const envelope = Buffer.from(keyring.seal({ value }, identity));
		return {
			name,
			secretId: identity.secretId,
			secretVersion: identity.version,
			keyId: KEY,
			ownerKind: "company",
			encryptedEnvelopeBase64: envelope.toString("base64"),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		};
	};
	const secrets = [seal("API_KEY", API_KEY, 3), seal("DATABASE_URL", DATABASE_URL, 1)];
	const maskSecrets = options.masked?.map((value, index) => seal("API_KEY", value, index + 1));
	const authorizeCodingEnvironment = vi.fn(async (request: CodingEnvironmentRequest) => {
		if (options.refuse) throw new Error("the session's lease is not held");
		return {
			schema: "qorpera.coding-environment-authorization/v1",
			companyId,
			environmentId,
			workerId: request.workerId,
			repository,
			secrets,
			...(maskSecrets ? { maskSecrets } : {}),
		};
	});
	const broker = new CloudSecretBroker({
		authority: { ...unusedAuthority(), authorizeCodingEnvironment },
		keyring,
		adapters: [],
	});
	const runtimeToken = randomBytes(32).toString("base64url");
	const executorToken = randomBytes(32).toString("base64url");
	const service = new HttpCloudSecretBrokerService(broker, runtimeToken, { codingExecutorToken: executorToken });
	services.push(service);
	const port = await service.start();
	const requested: string[] = [];
	// The shared public origin, rewritten to the loopback listener.
	const rewrite: typeof fetch = (input, init) => {
		const url = new URL(String(input));
		requested.push(url.href);
		return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
	};
	const scope = {
		companyId: companyId.toUpperCase(),
		workerId: randomUUID().toUpperCase(),
		leaseToken: randomUUID().toUpperCase(),
	};
	const environment = new BrokerCodingEnvironment({
		origin: "https://secrets.qorpera.test",
		executorToken,
		executorOwner: "coding-node-02",
		fetch: rewrite,
	});
	return { companyId, authorizeCodingEnvironment, requested, scope, environment };
}

/** The client's one opaque error: the exact message, with no cause, and no value anywhere on it. */
async function expectUnavailable(promise: Promise<unknown>): Promise<void> {
	const error = await promise.catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(UNAVAILABLE);
	expect((error as Error).cause).toBeUndefined();
	for (const value of [API_KEY, DATABASE_URL, OLD_API_KEY]) expect(`${(error as Error).stack}`).not.toContain(value);
}

describe("a coding session's environment through the executor's broker client", () => {
	it("gets each variable of the session the executor holds, asking again each time", async () => {
		const f = await fixture();
		const answer = await f.environment.environment(f.scope, signal());
		expect(answer).toStrictEqual({ environment: { API_KEY, DATABASE_URL }, mask: [] });
		for (const part of [answer, answer.environment, answer.mask]) expect(Object.isFrozen(part)).toBe(true);
		expect(f.requested).toEqual([`https://secrets.qorpera.test/v1/coding-environment?company=${f.companyId}`]);
		// The kernel is asked for exactly the scope's worker and lease, lower-cased, and the executor.
		expect(f.authorizeCodingEnvironment).toHaveBeenCalledExactlyOnceWith(
			{
				workerId: f.scope.workerId.toLowerCase(),
				leaseToken: f.scope.leaseToken.toLowerCase(),
				executorOwner: "coding-node-02",
			},
			expect.any(AbortSignal),
		);
		await f.environment.environment(f.scope, signal());
		expect(f.authorizeCodingEnvironment).toHaveBeenCalledTimes(2);
	});

	it("gets the older values used on the session's machine, for the mask only", async () => {
		// The kernel names an older version, and one whose value the environment holds now: the broker drops that one.
		const f = await fixture({ masked: [OLD_API_KEY, API_KEY] });
		const answer = await f.environment.environment(f.scope, signal());
		expect(answer).toStrictEqual({ environment: { API_KEY, DATABASE_URL }, mask: [OLD_API_KEY] });
		expect(Object.isFrozen(answer.mask)).toBe(true);
	});

	it("gives the one opaque error when the kernel refuses", async () => {
		const f = await fixture({ refuse: true });
		await expectUnavailable(f.environment.environment(f.scope, signal()));
		expect(f.authorizeCodingEnvironment).toHaveBeenCalledOnce();
	});
});

describe("executor-side environment client", () => {
	const executorToken = randomBytes(32).toString("base64url");
	const scope = { companyId: randomUUID(), workerId: randomUUID(), leaseToken: randomUUID() };
	const client = (fetcher: typeof fetch) =>
		new BrokerCodingEnvironment({
			origin: "https://secrets.qorpera.test",
			executorToken,
			executorOwner: "coding-node-02",
			fetch: fetcher,
		});
	const answer = (environment: unknown, extra: Record<string, unknown> = {}) =>
		Response.json({ schema: "qorpera.coding-environment/v1", environment, ...extra });

	it("posts the exact request over HTTPS without following redirects", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => answer({ API_KEY, DATABASE_URL }));
		await expect(client(fetcher).environment(scope, signal())).resolves.toStrictEqual({
			environment: { API_KEY, DATABASE_URL },
			mask: [],
		});
		expect(fetcher).toHaveBeenCalledExactlyOnceWith(
			`https://secrets.qorpera.test/v1/coding-environment?company=${scope.companyId}`,
			{
				method: "POST",
				redirect: "error",
				signal: expect.any(AbortSignal),
				headers: { authorization: `Bearer ${executorToken}`, "content-type": "application/json" },
				body: JSON.stringify({
					schema: "qorpera.coding-environment-request/v1",
					workerId: scope.workerId,
					leaseToken: scope.leaseToken,
					executorOwner: "coding-node-02",
				}),
			},
		);
		// A session with no environment secrets gets an empty environment.
		await expect(client(async () => answer({})).environment(scope, signal())).resolves.toStrictEqual({
			environment: {},
			mask: [],
		});
	});

	it("refuses every answer but the exact one with the one opaque error", async () => {
		const answers = [
			// Not the broker's 200.
			() => new Response("{}", { status: 302, headers: { location: "https://elsewhere.test/" } }),
			() => Response.json({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" }, { status: 403 }),
			() => Response.json({ schema: "qorpera.coding-environment/v1", environment: { API_KEY } }, { status: 201 }),
			// Not its schema or keys.
			() => Response.json({ schema: "qorpera.coding-environment/v2", environment: { API_KEY } }),
			() => answer({ API_KEY }, { expiresAt: null }),
			() => Response.json({ schema: "qorpera.coding-environment/v1" }),
			() => Response.json([{ API_KEY }]),
			() => new Response(`not json ${API_KEY}`),
			() => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
			() => answer([API_KEY]),
			() => answer(null),
			() => answer(API_KEY),
			// A name the vault never holds.
			() => answer({ api_key: API_KEY }),
			() => answer({ "1KEY": API_KEY }),
			() => answer({ [`K${"E".repeat(64)}`]: API_KEY }),
			() => answer({ HOME: API_KEY }),
			() => answer({ NODE_EXTRA_CA_CERTS: API_KEY }),
			() => answer({ GIT_TOKEN: API_KEY }),
			() => answer({ QORPERA_TOKEN: API_KEY }),
			// A value outside the broker's bounds.
			() => answer({ API_KEY: 12345678 }),
			() => answer({ API_KEY: "short" }),
			() => answer({ API_KEY: `${API_KEY}\0` }),
			() => answer({ API_KEY: `${API_KEY}\ud800` }),
			() => answer({ API_KEY: "x".repeat(32 * 1024 + 1) }),
			// More than one guest run request can take: each value within bounds, the whole over 64 KiB.
			() => answer({ ONE: "x".repeat(30000), TWO: "y".repeat(30000), THREE: "z".repeat(30000) }),
			// A mask that is not at most 64 values within the same bounds (5j-4).
			() => answer({ API_KEY }, { mask: {} }),
			() => answer({ API_KEY }, { mask: null }),
			() => answer({ API_KEY }, { mask: OLD_API_KEY }),
			() => answer({ API_KEY }, { mask: [12345678] }),
			() => answer({ API_KEY }, { mask: [OLD_API_KEY, "short"] }),
			() => answer({ API_KEY }, { mask: [`${OLD_API_KEY}\0`] }),
			() => answer({ API_KEY }, { mask: [`${OLD_API_KEY}\ud800`] }),
			() => answer({ API_KEY }, { mask: ["x".repeat(32 * 1024 + 1)] }),
			() => answer({ API_KEY }, { mask: Array.from({ length: 65 }, (_, n) => `${OLD_API_KEY}-${n}`) }),
			// Over the read's 2 MiB: 64 values within bounds, escaped six times over.
			() => answer({ API_KEY }, { mask: Array.from({ length: 64 }, (_, n) => `${n}`.padEnd(32 * 1024, "\u0001")) }),
		];
		for (const response of answers)
			await expectUnavailable(client(async () => response()).environment(scope, signal()));
		// The largest single value is accepted.
		const largest = { API_KEY: "x".repeat(32 * 1024) };
		await expect(client(async () => answer(largest)).environment(scope, signal())).resolves.toStrictEqual({
			environment: largest,
			mask: [],
		});
		// A mask as large as the database gives (64 values from 256 KiB of envelopes) fits, even escaped.
		const mask = Array.from({ length: 64 }, (_, n) => `${n}`.padEnd(4096, "\u0001"));
		const full = client(async () => answer({ API_KEY }, { mask }));
		await expect(full.environment(scope, signal())).resolves.toStrictEqual({ environment: { API_KEY }, mask });
	});

	it("never reveals a value in an error and refuses an invalid scope or configuration", async () => {
		await expectUnavailable(
			client(async () => {
				throw new Error(`network failure carrying ${API_KEY}`);
			}).environment(scope, signal()),
		);
		const fetcher = vi.fn<typeof fetch>();
		for (const invalid of [
			{ ...scope, workerId: "../other" },
			{ ...scope, companyId: "company" },
			{ ...scope, leaseToken: "" },
		])
			await expectUnavailable(client(fetcher).environment(invalid, signal()));
		expect(fetcher).not.toHaveBeenCalled();
		const configure = (options: { origin?: string; executorToken?: string; executorOwner?: string }) =>
			new BrokerCodingEnvironment({
				origin: "https://secrets.qorpera.test",
				executorToken,
				executorOwner: "coding-node-02",
				...options,
			});
		for (const origin of [
			"secrets.qorpera.test",
			"http://secrets.qorpera.test",
			"https://secrets.qorpera.test/v1",
			"https://a:b@secrets.qorpera.test",
			"https://secrets.qorpera.test/?company=x",
			"https://secrets.qorpera.test/#x",
		])
			expect(() => configure({ origin })).toThrow(UNAVAILABLE);
		expect(() => configure({ executorToken: "short" })).toThrow(UNAVAILABLE);
		expect(() => configure({ executorOwner: "exec owner" })).toThrow(UNAVAILABLE);
	});

	it("honours the caller's abort", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => answer({ API_KEY }));
		const aborted = new AbortController();
		aborted.abort(new Error("stopped"));
		await expect(client(fetcher).environment(scope, aborted.signal)).rejects.toThrow("stopped");
		expect(fetcher).not.toHaveBeenCalled();
		// Aborted while it asks: the request's own signal ends, and nothing is answered.
		const asking = new AbortController();
		const waiting = vi.fn<typeof fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
					asking.abort(new Error("stopped"));
				}),
		);
		await expectUnavailable(client(waiting).environment(scope, asking.signal));
		expect(waiting.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});
});
