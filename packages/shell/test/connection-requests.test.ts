import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendKernelConnectionObservation, bindTrailSession } from "../src/agent-runtime.ts";
import {
	beginConnectionRequest,
	beginConnectionRequestSetup,
	beginConnectionRequestSync,
	type ConnectionRequest,
	type ConnectionRequestIdentity,
	type CreateConnectionRequestInput,
	cancelConnectionRequest,
	cancelPendingConnectionRequestsForStaff,
	completeConnectionRequest,
	completeConnectionRequestSync,
	connectionRequestsStatePath,
	createConnectionRequest,
	denyConnectionRequest,
	failConnectionRequest,
	getConnectionRequest,
	getRecoverableConnectionSetup,
	installPreparedConnectionRequestRecipe,
	prepareConnectionRequest,
	projectConnectionRequest,
	readConnectionRequests,
	readRendererConnectionRequests,
	resumeConnectionRequestAuthorization,
	retryFailedConnectionRequest,
	selectConnectionRequest,
	verifyConnectionRequest,
} from "../src/connection-requests.ts";

const STAFF_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STAFF_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_FILE = "2026-08-15T12-00-00-000Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";

function createCompany(path: string, id = COMPANY_ID): void {
	mkdirSync(join(path, ".qorpera"), { recursive: true });
	writeFileSync(
		join(path, ".qorpera", "company.json"),
		`${JSON.stringify({ schema: "qorpera.company/v1", id, name: "Test", createdAt: "2026-08-15T12:00:00.000Z" })}\n`,
		"utf-8",
	);
}

describe("machine-local connection requests", () => {
	let root: string;
	let userData: string;
	let company: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-connection-requests-"));
		userData = join(root, "user-data");
		company = join(root, "company");
		mkdirSync(userData);
		createCompany(company);
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
			artifactId: "customer-health",
			dataNeedId: "support-inbox",
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
			phase: "suggested",
			events: [{ sequence: 1, phase: "suggested", actor: "agent" }],
			createdAt: "2026-08-15T12:00:00.000Z",
			updatedAt: "2026-08-15T12:00:00.000Z",
			destinations: [{ host: "api.github.com", note: "GitHub API" }, { host: "uploads.github.com:443" }],
			secretNames: ["github_token"],
			artifactId: "customer-health",
			dataNeedId: "support-inbox",
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
		expect(projection).toMatchObject({
			artifactId: "customer-health",
			dataNeedId: "support-inbox",
			phase: "suggested",
		});
		expect(JSON.stringify(projection)).not.toContain("github_token");
		expect(JSON.parse(readFileSync(path, "utf-8"))).not.toHaveProperty("oauth");
		expect(readdirSync(dirname(path)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("isolates requests by canonical company root", () => {
		const sibling = join(root, "sibling");
		createCompany(sibling, "44444444-4444-4444-8444-444444444444");
		const request = createConnectionRequest(userData, company, input());
		expect(readConnectionRequests(userData, sibling)).toEqual([]);
		expect(connectionRequestsStatePath(userData, sibling)).not.toBe(connectionRequestsStatePath(userData, company));
		expect(getConnectionRequest(userData, company, request.id)).toBeDefined();
	});

	it("does not carry requests into a new company created at the same path", () => {
		const first = createConnectionRequest(userData, company, input());
		const firstStatePath = connectionRequestsStatePath(userData, company);
		expect(getConnectionRequest(userData, company, first.id)).toBeDefined();

		rmSync(company, { recursive: true, force: true });
		createCompany(company, "55555555-5555-4555-8555-555555555555");
		const secondStatePath = connectionRequestsStatePath(userData, company);

		expect(secondStatePath).not.toBe(firstStatePath);
		expect(readConnectionRequests(userData, company)).toEqual([]);
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
			input({ recipeId: undefined, providerSuggestions: ["Google Sheets"] }),
			input({ recipeId: undefined, providerSuggestions: ["Google Sheets", "google sheets"] }),
			input({ providerSuggestions: ["Google Sheets", "Nordea Open Banking"] }),
			input({ dataNeedId: undefined }),
			input({ artifactId: "../escape" }),
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

	it("normalizes retired kernel lifecycle actors to the desktop host", () => {
		const request = createConnectionRequest(userData, company, input());
		selectConnectionRequest(userData, company, identity(request), {
			label: "Google Sheets",
			kind: "suggestion",
		});
		prepareConnectionRequest(userData, company, identity(request));
		const path = connectionRequestsStatePath(userData, company);
		const state = JSON.parse(readFileSync(path, "utf-8")) as {
			requests: Record<string, { events: Array<{ actor: string }> }>;
		};
		state.requests[request.id].events.at(-1)!.actor = "kernel";
		writeFileSync(path, `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600 });
		if (process.platform !== "win32") chmodSync(path, 0o600);

		expect(readConnectionRequests(userData, company)[0].events.at(-1)?.actor).toBe("host");
	});

	it("persists the selected intent through authorization, verification, and synchronization", () => {
		const request = createConnectionRequest(userData, company, input());
		const owner = identity(request);
		const wrongAgent = { ...owner, staffAgentId: OTHER_STAFF_AGENT_ID };
		const wrongSession = { ...owner, sessionFile: "different.jsonl" };

		expect(() => beginConnectionRequest(userData, company, wrongAgent)).toThrow("ownership does not match");
		expect(() => beginConnectionRequest(userData, company, wrongSession)).toThrow("ownership does not match");

		vi.setSystemTime(new Date("2026-08-15T12:00:30.000Z"));
		const selected = selectConnectionRequest(userData, company, owner, {
			label: "Company files and spreadsheets",
			kind: "suggestion",
		});
		expect(selected).toMatchObject({
			status: "pending",
			phase: "selected",
			selection: {
				label: "Company files and spreadsheets",
				kind: "suggestion",
				selectedAt: "2026-08-15T12:00:30.000Z",
			},
		});
		expect(
			selectConnectionRequest(userData, company, owner, {
				label: "Company files and spreadsheets",
				kind: "suggestion",
			}),
		).toEqual(selected);

		vi.setSystemTime(new Date("2026-08-15T12:00:45.000Z"));
		const preparing = prepareConnectionRequest(userData, company, owner);
		expect(preparing.phase).toBe("preparing");
		expect(projectConnectionRequest(preparing).guidance).toBe("Preparing GitHub…");
		vi.setSystemTime(new Date("2026-08-15T12:01:00.000Z"));
		const connecting = beginConnectionRequest(userData, company, owner);
		expect(connecting).toMatchObject({
			status: "connecting",
			phase: "awaiting_auth",
			updatedAt: "2026-08-15T12:01:00.000Z",
		});
		expect(projectConnectionRequest(connecting).guidance).toBe(
			"GitHub is open in your browser. Sign in and approve access.",
		);
		vi.setSystemTime(new Date("2026-08-15T12:02:00.000Z"));
		expect(beginConnectionRequest(userData, company, owner).updatedAt).toBe(connecting.updatedAt);

		const verifying = verifyConnectionRequest(userData, company, owner);
		expect(verifying.phase).toBe("verifying");
		expect(projectConnectionRequest(verifying).guidance).toBe(
			"Qorpera is checking that GitHub completed the connection.",
		);
		vi.setSystemTime(new Date("2026-08-15T12:03:00.000Z"));
		const connected = completeConnectionRequest(userData, company, owner, "grant:github:primary");
		expect(connected).toMatchObject({
			status: "connected",
			phase: "connected",
			grantId: "grant:github:primary",
			updatedAt: "2026-08-15T12:03:00.000Z",
		});
		vi.setSystemTime(new Date("2026-08-15T12:04:00.000Z"));
		expect(completeConnectionRequest(userData, company, owner, "grant:github:primary").updatedAt).toBe(
			connected.updatedAt,
		);
		expect(() => completeConnectionRequest(userData, company, owner, "grant:github:other")).toThrow(
			"cannot complete",
		);
		const syncing = beginConnectionRequestSync(userData, company, owner);
		expect(syncing.phase).toBe("syncing");
		expect(projectConnectionRequest(syncing).guidance).toBe(
			"GitHub is connected. The agent is checking the first data before marking it ready.",
		);
		vi.setSystemTime(new Date("2026-08-15T12:05:00.000Z"));
		const ready = completeConnectionRequestSync(userData, company, owner);
		expect(ready).toMatchObject({ status: "connected", phase: "ready" });
		expect(projectConnectionRequest(ready).guidance).toBe("GitHub is ready.");
		expect(ready.events.map((event) => event.phase)).toEqual([
			"suggested",
			"selected",
			"preparing",
			"awaiting_auth",
			"verifying",
			"connected",
			"syncing",
			"ready",
		]);
		expect(() => cancelConnectionRequest(userData, company, owner)).toThrow("cannot be cancelled");
	});

	it("installs an agent-built recipe into the founder's prepared request", () => {
		const proposed = createConnectionRequest(
			userData,
			company,
			input({
				displayName: "Banking records",
				destinations: [],
				secretNames: [],
				providerSuggestions: ["Google Sheets", "Nordea Open Banking", "Xero", "QuickBooks"],
				recipeId: undefined,
			}),
		);
		expect(projectConnectionRequest(proposed).providerSuggestions).toEqual([
			"Google Sheets",
			"Nordea Open Banking",
			"Xero",
			"QuickBooks",
		]);
		selectConnectionRequest(userData, company, identity(proposed), {
			label: "Nordea Bank",
			kind: "custom",
		});
		prepareConnectionRequest(userData, company, identity(proposed));
		vi.setSystemTime(new Date("2026-08-15T12:01:00.000Z"));

		const installed = installPreparedConnectionRequestRecipe(
			userData,
			company,
			identity(proposed),
			input({
				displayName: "Nordea Open Banking",
				purpose: "Read balances and booked transactions.",
				destinations: [{ host: "api.nordeaopenbanking.com", note: "Nordea Open Banking" }],
				secretNames: ["nordea_access"],
				recipeId: "company:nordea-open-banking",
			}),
		);

		expect(installed).toMatchObject({
			id: proposed.id,
			displayName: "Nordea Open Banking",
			recipeId: "company:nordea-open-banking",
			phase: "preparing",
			selection: { label: "Nordea Bank", kind: "custom" },
			destinations: [{ host: "api.nordeaopenbanking.com", note: "Nordea Open Banking" }],
			secretNames: ["nordea_access"],
			updatedAt: "2026-08-15T12:01:00.000Z",
		});
		expect(installed).not.toHaveProperty("providerSuggestions");
		expect(installed.events.map((event) => `${event.actor}:${event.phase}`)).toEqual([
			"agent:suggested",
			"founder:selected",
			"host:preparing",
			"agent:preparing",
		]);
		expect(() =>
			installPreparedConnectionRequestRecipe(
				userData,
				company,
				identity(proposed),
				input({ recipeId: "company:another-connector" }),
			),
		).toThrow("cannot install a recipe");
	});

	it("resumes authorization after provider enrollment without another founder approval", () => {
		const request = createConnectionRequest(userData, company, input({ displayName: "Nordea Open Banking" }));
		const awaitingSetup = beginConnectionRequestSetup(userData, company, identity(request));

		expect(awaitingSetup).toMatchObject({ status: "connecting", phase: "awaiting_setup" });
		expect(projectConnectionRequest(awaitingSetup).guidance).toBe(
			"Nordea Open Banking is ready at the first private sign-in step. Complete it in Qorpera Chrome, then return here.",
		);
		expect(beginConnectionRequestSetup(userData, company, identity(request))).toEqual(awaitingSetup);
		expect(() => verifyConnectionRequest(userData, company, identity(request))).toThrow("cannot verify");

		vi.setSystemTime(new Date("2026-08-15T12:01:00.000Z"));
		const awaitingAuth = resumeConnectionRequestAuthorization(userData, company, identity(request));
		expect(awaitingAuth).toMatchObject({ status: "connecting", phase: "awaiting_auth" });
		expect(projectConnectionRequest(awaitingAuth).guidance).toBe(
			"Nordea Open Banking is open in your browser. Sign in and approve access.",
		);
		expect(resumeConnectionRequestAuthorization(userData, company, identity(request))).toEqual(awaitingAuth);
	});

	it("recovers the newest durable provider setup owned by the attached agent conversation", () => {
		const older = createConnectionRequest(
			userData,
			company,
			input({ displayName: "Older provider", recipeId: "company:older-provider" }),
		);
		beginConnectionRequestSetup(userData, company, identity(older));
		vi.setSystemTime(new Date("2026-08-15T12:01:00.000Z"));
		const newest = createConnectionRequest(
			userData,
			company,
			input({ displayName: "Newest provider", recipeId: "company:newest-provider" }),
		);
		const awaitingSetup = beginConnectionRequestSetup(userData, company, identity(newest));
		const otherConversation = createConnectionRequest(
			userData,
			company,
			input({ sessionFile: "other.jsonl", recipeId: "company:other-conversation" }),
		);
		beginConnectionRequestSetup(userData, company, identity(otherConversation));

		expect(getRecoverableConnectionSetup(userData, company, STAFF_AGENT_ID, SESSION_FILE)).toEqual(awaitingSetup);
		expect(getRecoverableConnectionSetup(userData, company, STAFF_AGENT_ID, "missing.jsonl")).toBeUndefined();
		expect(() => getRecoverableConnectionSetup(userData, company, "not-a-uuid", SESSION_FILE)).toThrow(
			"ownership is invalid",
		);
	});

	it("reconstructs connector state from verified company trail observations", () => {
		mkdirSync(join(company, "trail"));
		const request = createConnectionRequest(userData, company, input());
		const selected = selectConnectionRequest(userData, company, identity(request), {
			label: "A custom ledger export",
			kind: "custom",
		});
		const binding = bindTrailSession(company, company, {
			actor: "company-agent",
			attended: true,
			staffAgentId: STAFF_AGENT_ID,
		});
		appendKernelConnectionObservation(binding, { version: 1, request: selected });
		const restoredUserData = join(root, "restored-user-data");
		mkdirSync(restoredUserData);

		expect(readConnectionRequests(restoredUserData, company)).toEqual([selected]);
		expect(readFileSync(connectionRequestsStatePath(restoredUserData, company), "utf-8")).toContain(
			"A custom ledger export",
		);
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
		expect(failed).toMatchObject({
			status: "failed",
			phase: "failed",
			failure: "Provider authorization was not completed.",
		});
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
		expect(denied).toMatchObject({ status: "denied", phase: "denied" });
		expect(denyConnectionRequest(userData, company, identity(deniedRequest))).toEqual(denied);

		beginConnectionRequest(userData, company, identity(cancelledRequest));
		const cancelled = cancelConnectionRequest(userData, company, identity(cancelledRequest));
		expect(cancelled).toMatchObject({ status: "cancelled", phase: "cancelled" });
		expect(cancelConnectionRequest(userData, company, identity(cancelledRequest))).toEqual(cancelled);
		expect(() => denyConnectionRequest(userData, company, identity(cancelledRequest))).toThrow("cannot be denied");
	});

	it("retries an exact failed connector without asking for the same founder selection again", () => {
		const requestInput = input({
			displayName: "Gmail",
			purpose: "Discover production service notices.",
			destinations: [{ host: "gmail.googleapis.com" }, { host: "oauth2.googleapis.com" }],
			secretNames: ["gmail_oauth", "gmail_client_secret"],
			recipeId: "company:gmail",
			artifactId: undefined,
			dataNeedId: undefined,
		});
		const original = createConnectionRequest(userData, company, requestInput);
		vi.setSystemTime(new Date("2026-08-15T12:00:10.000Z"));
		const selected = selectConnectionRequest(userData, company, identity(original), {
			label: "Gmail",
			kind: "suggestion",
		});
		prepareConnectionRequest(userData, company, identity(original));
		beginConnectionRequest(userData, company, identity(original));
		failConnectionRequest(userData, company, identity(original), "Provider authorization timed out");
		const duplicate = createConnectionRequest(userData, company, requestInput);

		vi.setSystemTime(new Date("2026-08-15T12:01:00.000Z"));
		const retried = retryFailedConnectionRequest(userData, company, requestInput);

		expect(retried?.request).toMatchObject({
			id: original.id,
			status: "pending",
			phase: "preparing",
			selection: selected.selection,
		});
		expect(retried?.request).not.toHaveProperty("failure");
		expect(retried?.request.events.at(-1)).toMatchObject({ phase: "preparing", actor: "agent" });
		expect(retried?.superseded).toMatchObject([{ id: duplicate.id, status: "cancelled", phase: "cancelled" }]);
		expect(
			retryFailedConnectionRequest(userData, company, { ...requestInput, purpose: "Broader access." }),
		).toBeUndefined();
	});

	it("cancels only unresolved proposals owned by an archived agent", () => {
		const pending = createConnectionRequest(userData, company, input({ displayName: "Pending service" }));
		const connecting = createConnectionRequest(userData, company, input({ displayName: "Connecting service" }));
		const other = createConnectionRequest(
			userData,
			company,
			input({ staffAgentId: OTHER_STAFF_AGENT_ID, displayName: "Other agent service" }),
		);
		beginConnectionRequest(userData, company, identity(connecting));

		const cancelled = cancelPendingConnectionRequestsForStaff(userData, company, STAFF_AGENT_ID).sort((left, right) =>
			left.id.localeCompare(right.id),
		);
		const expected = [
			{ id: pending.id, status: "cancelled" },
			{ id: connecting.id, status: "cancelled" },
		].sort((left, right) => left.id.localeCompare(right.id));
		expect(cancelled).toMatchObject(expected);
		expect(getConnectionRequest(userData, company, other.id)).toMatchObject({ status: "pending" });
		expect(cancelPendingConnectionRequestsForStaff(userData, company, STAFF_AGENT_ID)).toEqual([]);
	});
});
