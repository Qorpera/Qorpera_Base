import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	beginConnectionRequest,
	type ConnectionRequest,
	type ConnectionRequestIdentity,
	type CreateConnectionRequestInput,
	cancelConnectionRequest,
	completeConnectionRequest,
	connectionRequestsStatePath,
	createConnectionRequest,
	denyConnectionRequest,
	failConnectionRequest,
	getConnectionRequest,
	projectConnectionRequest,
	readConnectionRequests,
	readRendererConnectionRequests,
} from "../src/connection-requests.ts";

const STAFF_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STAFF_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_FILE = "2026-08-15T12-00-00-000Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl";

describe("machine-local connection requests", () => {
	let root: string;
	let userData: string;
	let company: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-connection-requests-"));
		userData = join(root, "user-data");
		company = join(root, "company");
		mkdirSync(userData);
		mkdirSync(company);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	function input(overrides: Partial<CreateConnectionRequestInput> = {}): CreateConnectionRequestInput {
		return {
			staffAgentId: STAFF_AGENT_ID,
			sessionFile: SESSION_FILE,
			displayName: "GitHub",
			purpose: "Review pull requests and prepare releases.",
			destinations: [{ host: "API.GITHUB.COM", note: "GitHub API" }, { host: "uploads.github.com:443" }],
			secretNames: ["GitHub_Token"],
			recipeId: "github:oauth-v1",
			...overrides,
		};
	}

	function identity(request: ConnectionRequest): ConnectionRequestIdentity {
		return {
			id: request.id,
			staffAgentId: request.staffAgentId,
			sessionFile: request.sessionFile,
		};
	}

	it("persists canonical requests outside the company and exposes a credential-free projection", () => {
		const request = createConnectionRequest(userData, company, input());
		const path = connectionRequestsStatePath(userData, join(company, "."));

		expect(request).toMatchObject({
			staffAgentId: STAFF_AGENT_ID,
			sessionFile: SESSION_FILE,
			status: "pending",
			createdAt: "2026-08-15T12:00:00.000Z",
			updatedAt: "2026-08-15T12:00:00.000Z",
			destinations: [{ host: "api.github.com", note: "GitHub API" }, { host: "uploads.github.com:443" }],
			secretNames: ["github_token"],
		});
		expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(path.startsWith(userData)).toBe(true);
		expect(path.startsWith(company)).toBe(false);
		expect(readConnectionRequests(userData, company)).toEqual([request]);
		expect(getConnectionRequest(userData, company, request.id)).toEqual(request);

		request.destinations[0].host = "mutated.invalid";
		request.secretNames[0] = "mutated";
		expect(getConnectionRequest(userData, company, request.id)).toMatchObject({
			destinations: [{ host: "api.github.com", note: "GitHub API" }, { host: "uploads.github.com:443" }],
			secretNames: ["github_token"],
		});

		const projection = readRendererConnectionRequests(userData, company)[0];
		expect(projection).toEqual(projectConnectionRequest(getConnectionRequest(userData, company, request.id)!));
		expect(projection).not.toHaveProperty("secretNames");
		expect(JSON.stringify(projection)).not.toContain("github_token");
		expect(JSON.parse(readFileSync(path, "utf-8"))).not.toHaveProperty("oauth");
		expect(readdirSync(dirname(path)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("isolates requests by canonical company root", () => {
		const sibling = join(root, "sibling");
		mkdirSync(sibling);
		const request = createConnectionRequest(userData, company, input());
		expect(readConnectionRequests(userData, sibling)).toEqual([]);
		expect(connectionRequestsStatePath(userData, sibling)).not.toBe(connectionRequestsStatePath(userData, company));
		expect(getConnectionRequest(userData, company, request.id)).toBeDefined();
	});

	it("rejects invalid identities, text, destinations, credential references, and unknown fields", () => {
		for (const invalid of [
			input({ staffAgentId: "not-a-uuid" }),
			input({ sessionFile: "../session.jsonl" }),
			input({ displayName: " GitHub" }),
			input({ purpose: "unsafe\nsecond line" }),
			input({ destinations: [{ host: "https://api.github.com" }] }),
			input({ destinations: [{ host: "*.github.com" }] }),
			input({ destinations: [{ host: "api.github.com:65536" }] }),
			input({ destinations: [{ host: "api.github.com" }, { host: "API.GITHUB.COM" }] }),
			input({ secretNames: ["bad/name"] }),
			input({ secretNames: ["token", "TOKEN"] }),
		]) {
			expect(() => createConnectionRequest(userData, company, invalid)).toThrow("input is invalid");
		}
		const unknown = { ...input(), oauth: { tokenUrl: "https://example.invalid/token" } };
		expect(() => createConnectionRequest(userData, company, unknown as CreateConnectionRequestInput)).toThrow(
			"input is invalid",
		);
	});

	it("fails closed when persisted state has unknown or non-canonical request data", () => {
		const request = createConnectionRequest(userData, company, input());
		const path = connectionRequestsStatePath(userData, company);
		const state = JSON.parse(readFileSync(path, "utf-8")) as {
			requests: Record<string, Record<string, unknown>>;
		};
		state.requests[request.id].unexpected = true;
		writeFileSync(path, `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600 });
		if (process.platform !== "win32") chmodSync(path, 0o600);
		expect(() => readConnectionRequests(userData, company)).toThrow("state is invalid");
	});

	it("enforces exact request ownership and idempotent begin and completion transitions", () => {
		const request = createConnectionRequest(userData, company, input());
		const owner = identity(request);
		const wrongAgent = { ...owner, staffAgentId: OTHER_STAFF_AGENT_ID };
		const wrongSession = { ...owner, sessionFile: "different.jsonl" };

		expect(() => beginConnectionRequest(userData, company, wrongAgent)).toThrow("ownership does not match");
		expect(() => beginConnectionRequest(userData, company, wrongSession)).toThrow("ownership does not match");

		vi.setSystemTime(new Date("2026-08-15T12:01:00.000Z"));
		const connecting = beginConnectionRequest(userData, company, owner);
		expect(connecting).toMatchObject({ status: "connecting", updatedAt: "2026-08-15T12:01:00.000Z" });
		vi.setSystemTime(new Date("2026-08-15T12:02:00.000Z"));
		expect(beginConnectionRequest(userData, company, owner).updatedAt).toBe(connecting.updatedAt);

		const connected = completeConnectionRequest(userData, company, owner, "grant:github:primary");
		expect(connected).toMatchObject({
			status: "connected",
			grantId: "grant:github:primary",
			updatedAt: "2026-08-15T12:02:00.000Z",
		});
		vi.setSystemTime(new Date("2026-08-15T12:03:00.000Z"));
		expect(completeConnectionRequest(userData, company, owner, "grant:github:primary").updatedAt).toBe(
			connected.updatedAt,
		);
		expect(() => completeConnectionRequest(userData, company, owner, "grant:github:other")).toThrow(
			"cannot complete",
		);
		expect(() => cancelConnectionRequest(userData, company, owner)).toThrow("cannot be cancelled");
	});

	it("supports idempotent failure, denial, and cancellation terminal transitions", () => {
		const failedRequest = createConnectionRequest(userData, company, input({ displayName: "Failed service" }));
		const deniedRequest = createConnectionRequest(userData, company, input({ displayName: "Denied service" }));
		const cancelledRequest = createConnectionRequest(userData, company, input({ displayName: "Cancelled service" }));

		beginConnectionRequest(userData, company, identity(failedRequest));
		const failed = failConnectionRequest(
			userData,
			company,
			identity(failedRequest),
			"Provider authorization was not completed.",
		);
		expect(failed).toMatchObject({ status: "failed", failure: "Provider authorization was not completed." });
		expect(
			failConnectionRequest(userData, company, identity(failedRequest), "Provider authorization was not completed."),
		).toEqual(failed);
		expect(() => failConnectionRequest(userData, company, identity(failedRequest), "A different failure.")).toThrow(
			"cannot fail",
		);
		expect(() =>
			failConnectionRequest(userData, company, identity(cancelledRequest), "token=https://secret.invalid"),
		).toThrow("not renderer-safe");

		const denied = denyConnectionRequest(userData, company, identity(deniedRequest));
		expect(denied.status).toBe("denied");
		expect(denyConnectionRequest(userData, company, identity(deniedRequest))).toEqual(denied);

		beginConnectionRequest(userData, company, identity(cancelledRequest));
		const cancelled = cancelConnectionRequest(userData, company, identity(cancelledRequest));
		expect(cancelled.status).toBe("cancelled");
		expect(cancelConnectionRequest(userData, company, identity(cancelledRequest))).toEqual(cancelled);
		expect(() => denyConnectionRequest(userData, company, identity(cancelledRequest))).toThrow("cannot be denied");
	});
});
