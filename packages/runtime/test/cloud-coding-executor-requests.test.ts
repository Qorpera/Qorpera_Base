import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODING_CONTROL_METHODS } from "../../../deploy/coding-worker/control.ts";
import { codeHostRequestsOf, codeImportTransports } from "../../../deploy/coding-worker/executor.ts";
import { BrokerRepositoryFetch } from "../../../deploy/coding-worker/repository-fetch.ts";
import { CODE_BUNDLE_FOLDER, createCodeBundleStore } from "../../runner-orchestrator/src/code-bundle-store.ts";
import type { CodeHostJobs } from "../../runner-orchestrator/src/code-host-views.ts";
import { CodeImportStop } from "../../runner-orchestrator/src/code-import.ts";
import { CODE_IMPORT_RUN_RPCS } from "../../runner-orchestrator/src/code-import-run.ts";

// The coding executor's requests as `deploy/coding-worker/executor.ts` builds them (own code storage, steps 2b and 6):
// with the bundle store an import is claimed and run by the CodeImport it is given, with the import's own ways to
// GitHub; without it no claim asks for one. The control lets the import's calls through, and only the executor's.

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const OWNER = "coding-node-1";
const MACHINE = "d".repeat(64);
const REQUEST = "aaaaaaaa-0000-4000-8000-000000000004";
const TOKEN = "bbbbbbbb-0000-4000-8000-000000000004";
/** An import as A2's claim hands it out: through the company's connection, nothing done yet. */
const IMPORT = {
	requestId: REQUEST,
	token: TOKEN,
	leaseUntil: "2026-11-12T15:15:00+00:00",
	companyId: "22222222-2222-4222-8222-222222222222",
	environmentId: "44444444-4444-4444-8444-444444444444",
	owner: "qorpera",
	name: "saml-storefront",
	kind: "import",
	input: { from: { github: "Qorpera/saml-storefront" }, via: "connection", look: false, maximumBytes: 1_073_741_824 },
	progress: null,
	looked: null,
};

/** The kernel's answers to the calls the requests make, each call kept. */
function control() {
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	let claims = 0;
	return {
		calls,
		async call(method: string, args: Record<string, unknown>) {
			calls.push({ method, args: structuredClone(args) });
			if (method === "qorpera_code_requests_claim")
				return { schema: "qorpera.code-requests/v1", requests: claims++ === 0 ? [IMPORT] : [] };
			if (method === "qorpera_code_request_step")
				return { schema: "qorpera.code-request-step/v1", state: "go", leaseUntil: "2026-11-12T15:30:00+00:00" };
			if (method === "qorpera_code_request_finish")
				return { schema: "qorpera.code-request-finish/v1", state: "recorded", change: null };
			throw new Error(`not a call of these requests: ${method}`);
		},
	};
}

/** The code host as the import's first job sees it: a place with no mark. No job of these tests runs a command. */
const hosts: Pick<CodeHostJobs, "run"> = {
	run: (async () => ({ there: false, mark: null })) as Pick<CodeHostJobs, "run">["run"],
};

async function store() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "executor-requests-")));
	roots.push(root);
	await mkdir(join(root, "control"));
	return createCodeBundleStore({ root: join(root, "control", CODE_BUNDLE_FOLDER) });
}

describe("the executor's code requests, as executor.ts builds them", () => {
	it("gives an import without a broker no road through the connection, and github.com for a public project", () => {
		const transports = codeImportTransports(null);
		let stopped: unknown;
		try {
			transports.connection(
				{ companyId: IMPORT.companyId, requestId: REQUEST, leaseToken: TOKEN },
				{ owner: "Qorpera", name: "saml-storefront" },
			);
		} catch (error) {
			stopped = error;
		}
		expect(stopped).toBeInstanceOf(CodeImportStop);
		expect(stopped).toMatchObject({ end: "failed", code: "IMPORT_RELAY_NOT_ROUTED" });
		// (Not asked: it would reach github.com.)
		const open = transports.public({ owner: "Acme", name: "Shop" });
		expect([typeof open.refs, typeof open.uploadPack]).toEqual(["function", "function"]);
		// With a broker, its fetch relay with the executor's own bearer.
		expect(
			codeImportTransports({
				origin: "https://broker.example.com",
				executorToken: "A".repeat(43),
				executorOwner: OWNER,
			}),
		).toBeInstanceOf(BrokerRepositoryFetch);
	});

	it("claims an import and runs it with the CodeImport and the transports it was given", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const kernel = control();
		const requests = codeHostRequestsOf({
			control: kernel,
			hosts,
			records: { inJob: async () => async () => undefined },
			bundles: await store(),
			transports: codeImportTransports(null),
			owner: OWNER,
			machineIdSha256: MACHINE,
		});
		await requests.pass(new AbortController().signal);
		await requests.settled();
		expect(kernel.calls[0]).toMatchObject({
			method: "qorpera_code_requests_claim",
			args: { p_owner: OWNER, p_kinds: ["undo", "download", "restore", "import"] },
		});
		// The run: step fetch before anything else, then the connection with no broker refuses, and the import ends
		// failed with that code; the finish takes it.
		expect(kernel.calls.slice(1).map((call) => call.method)).toEqual([
			"qorpera_code_request_step",
			"qorpera_code_request_finish",
		]);
		expect(kernel.calls[1]?.args).toMatchObject({
			p_request_id: REQUEST,
			p_token: TOKEN,
			p_progress: { step: "fetch" },
		});
		expect(kernel.calls[2]?.args.p_outcome).toEqual({
			schema: "qorpera.code-request-outcome/v1",
			state: "failed",
			code: "IMPORT_RELAY_NOT_ROUTED",
		});
		// Every call the import made is one the executor's control lets through.
		for (const { method } of kernel.calls) expect(CODING_CONTROL_METHODS.has(method), method).toBe(true);
	});

	it("asks for no import without the bundle store, and puts one handed out back", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const kernel = control();
		const requests = codeHostRequestsOf({
			control: kernel,
			hosts,
			records: { inJob: async () => async () => undefined },
			bundles: undefined,
			transports: codeImportTransports(null),
			owner: OWNER,
			machineIdSha256: MACHINE,
		});
		await requests.pass(new AbortController().signal);
		await requests.settled();
		expect(kernel.calls[0]?.args.p_kinds).toEqual(["undo", "download", "restore"]);
		expect(kernel.calls.slice(1).map((call) => [call.method, call.args.p_outcome])).toEqual([
			["qorpera_code_request_finish", { schema: "qorpera.code-request-outcome/v1", state: "busy" }],
		]);
	});

	it("lets every call of the import's run through the control, and none of the agent's or the member's", () => {
		for (const method of CODE_IMPORT_RUN_RPCS) expect(CODING_CONTROL_METHODS.has(method), method).toBe(true);
		for (const method of [
			"qorpera_folder_request_code_import",
			"qorpera_folder_code_import",
			"qorpera_request_code_import",
			"qorpera_authorize_code_import_fetch",
		])
			expect(CODING_CONTROL_METHODS.has(method), method).toBe(false);
	});
});
