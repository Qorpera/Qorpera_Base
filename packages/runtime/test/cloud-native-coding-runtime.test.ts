import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudCodingCommandGateway } from "../src/cloud-coding-command-tools.ts";
import { HttpCloudCodingControl } from "../src/cloud-coding-control.ts";
import { CloudControlRpcEnded } from "../src/cloud-control-errors.ts";
import {
	type CloudCodingNativeControl,
	CloudNativeCodingRuntime,
	type CloudNativeCodingTurnContext,
	parseCloudCodingTurnContext,
} from "../src/cloud-native-coding-runtime.ts";
import type { NativeCompanyExecutionRequest } from "../src/cloud-native-provider-host.ts";
import { runCloudNativeRunToolSession } from "../src/cloud-native-run-tool-session.ts";
import { CLOUD_RUN_ROW_READ_MS, CloudNativeToolRun } from "../src/cloud-native-tool-authority.ts";
import {
	CloudNativeToolBoundary,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	cloudToolJsonText,
} from "../src/cloud-native-tool-boundary.ts";
import { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
import { CLOUD_RUNTIME_NATIVE_BINARY_SHA256 } from "../src/cloud-runtime-bundle.generated.ts";
import {
	CloudRuntimeDiagnosticError,
	CloudRuntimeObservability,
	type CloudRuntimeObservation,
} from "../src/cloud-runtime-observability.ts";
import { SITE_NAME_RULE } from "../src/cloud-site-tools.ts";
import type { CloudWakeEnvelope } from "../src/cloud-wake-bus.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";
import { pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

vi.mock("../src/cloud-native-run-tool-session.ts", () => ({ runCloudNativeRunToolSession: vi.fn() }));
afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

function fixture() {
	const { binding, authority: base } = nativeToolAuthorityFixture();
	const authority = { ...base, identity: { ...base.identity, sessionId: null as string | null } };
	const workerId = randomUUID();
	const vmId = randomUUID();
	const turnId = randomUUID();
	const repository = { host: "github.com", owner: "Qorpera", name: "test", baseBranch: "main" };
	const coding = {
		workerId,
		sequence: 1,
		turnId,
		vmId,
		harness: "codex",
		model: null,
		repository,
		branch: `qorpera/coding/${workerId}`,
		baseSha: "a".repeat(40),
		harnessSessionRef: null,
		title: "Fix the delay after send",
		goal: "Build it",
		definitionOfDone: "Tests pass",
		context: "Bounded parent context",
		followUp: null,
		pullRequest: null,
		submission: null as unknown,
	};
	// What qorpera_read_coding_turn_context says started this turn and what came before it.
	const turnContext = {
		input: { from: "dispatch", text: null, answers: null } as Record<string, unknown>,
		earlierTurns: [] as unknown[],
		omittedEarlierTurns: 0,
		commands: { running: [], stopped: [], omitted: 0 } as Record<string, unknown>,
	};
	const call = vi.fn<CloudCodingNativeControl["call"]>(async (method, args) => {
		if (method === "qorpera_authorize_coding_turn") return { ...authority, coding };
		if (method === "qorpera_read_coding_turn_context")
			return {
				schema: "qorpera.coding-turn-context/v2",
				workerId: coding.workerId,
				sequence: coding.sequence,
				...turnContext,
			};
		if (method === "qorpera_submit_coding_turn") {
			const input = args.p_submission as Record<string, unknown>;
			coding.submission = {
				schema: "qorpera.coding-submission/v1",
				workerId,
				sequence: coding.sequence,
				kind: input.kind,
				state: "submitted",
				summary: input.summary,
				headSha: input.headSha ?? null,
				question: input.question ?? null,
				options: input.options ?? [],
				operationKey: input.operationKey,
			};
			return coding.submission;
		}
		if (method === "qorpera_begin_native_coding_execution")
			return {
				schema: "qorpera.native-company-execution-start/v1",
				runId: binding.runId,
				jobId: binding.jobId,
				leaseId: binding.leaseId,
				binarySha256: args.p_binary_sha256,
				runtimeBundleSha256: authority.identity.runtimeBundleSha256,
				reasoningEffort: authority.identity.reasoningEffort,
				reasoningPolicySha256: authority.identity.reasoningPolicySha256,
				toolCatalogSha256: createHash("sha256").update(String(args.p_tool_catalog_text)).digest("hex"),
				contextSha256: args.p_context_sha256,
				contextBytes: args.p_context_bytes,
			};
		throw new Error("Unexpected call");
	});
	const control = {
		call,
		describeToolAuthority: vi.fn().mockResolvedValue(authority),
		beginToolOperation: vi.fn(),
		completeToolOperation: vi.fn(),
	};
	const gateway: CloudCodingCommandGateway = {
		authorize: vi.fn().mockResolvedValue(undefined),
		start: vi.fn(),
		read: vi.fn(),
		cancel: vi.fn(),
	};
	const gatewayFactory = vi.fn(() => gateway);
	const runtime = new CloudNativeCodingRuntime({
		control,
		gateway: gatewayFactory,
		command: ["/pinned/codex"],
		binarySha256: CLOUD_RUNTIME_NATIVE_BINARY_SHA256,
	});
	const request: NativeCompanyExecutionRequest = {
		runtime: "company-path-v1",
		authority: {
			...binding,
			encryptedCapsuleReference: "opaque",
			attestationPolicySha256: "a".repeat(64),
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		},
		job: {
			jobId: binding.jobId,
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: 1,
			payload: { schema: "qorpera.wake-run/v1", occurrenceId: randomUUID() },
		},
	};
	const wake = {
		kind: "agent",
		source: { kind: "worker-dispatch", id: workerId },
		payload: {
			schema: "qorpera.worker-dispatch/v1",
			species: "coding",
			workerId,
			sequence: 1,
			coding: { harness: "codex" },
		},
	} as unknown as CloudWakeEnvelope;
	const turn: CloudNativeCodingTurnContext = { binding, identity: authority.identity, wake };
	const context: CloudToolContext = {
		companyId: authority.identity.companyId,
		runId: binding.runId,
		identity: authority.identity,
		callId: "finish",
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
	return {
		binding,
		authority,
		coding,
		turnContext,
		call,
		control,
		gateway,
		gatewayFactory,
		runtime,
		request,
		turn,
		context,
		scope: { workerId, vmId, requestId: turnId, turn: 1 },
	};
}

describe("the coding composition of a native turn", () => {
	it("aborts a streaming native session when the session lease is revoked between tools", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let activeRun: CloudNativeToolRun | undefined;
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			activeRun = await CloudNativeToolRun.open(f.binding, options.controlPlane, options.signal);
			const original = f.call.getMockImplementation()!;
			f.call.mockImplementation((method, args, signal) =>
				method === "qorpera_authorize_coding_turn"
					? Promise.reject(new Error("Coding session lease expired"))
					: original(method, args, signal),
			);
			await new Promise<void>((resolve) =>
				activeRun!.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new Error("native session stopped");
		});
		const execution = f.runtime.execute(f.request, "/private", f.context.signal, f.turn);
		const outcome = expect(execution).rejects.toThrow("native session stopped");
		await vi.advanceTimersByTimeAsync(10001);
		await outcome;
		expect(activeRun?.signal.aborted).toBe(true);
		expect(f.control.describeToolAuthority).not.toHaveBeenCalled();
	});
	it("gives the run's own checks of the coding authorize, which takes the run's row, that row's 20 s (R2, 31 Oct 2026)", async () => {
		vi.useFakeTimers();
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			const f = fixture();
			const sent: number[] = [];
			vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
				expect(options.controlPlane.runRowMs).toBe(CLOUD_RUN_ROW_READ_MS);
				// Held as the session holds it (NATIVE_AUTHORITY_LEASE_SECONDS).
				const run = await CloudNativeToolRun.open(f.binding, options.controlPlane, options.signal, 120_000);
				// The refresh at 10 s never answers: it waits 20 s, as long as the database may run it, before it is cut
				// and asked again after the pause (a reader without the wait cuts it at 5 s and asks again at 15.25 s).
				const original = f.call.getMockImplementation()!;
				f.call.mockImplementation((method, args, signal) => {
					if (method !== "qorpera_authorize_coding_turn") return original(method, args, signal);
					sent.push(now);
					return sent.length === 1 ? new Promise<never>(() => undefined) : original(method, args, signal);
				});
				for (let step = 0; step < 800 && sent.length < 2; step += 1) {
					now += 50;
					await vi.advanceTimersByTimeAsync(50);
				}
				expect(run.signal.aborted).toBe(false);
				run.close();
				throw new Error("native session stopped");
			});
			await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
				"native session stopped",
			);
			expect(sent).toEqual([10_000, 30_250]);
		} finally {
			clock.mockRestore();
		}
	});
	it("uses the three command tools and two ways to end the turn, a durable submission and no human delivery", async () => {
		const f = fixture();
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				expect(adapters.tools.map((tool) => tool.name)).toEqual([
					"coding_run_command",
					"coding_read_command",
					"coding_cancel_command",
					"coding_finish",
					"coding_ask",
				]);
				expect(options.prompt).toContain("Bounded parent context");
				expect(options.prompt).toContain("Fix the delay after send");
				expect(options.prompt).not.toContain(f.binding.credentialCapsuleId);
				expect(options.runtimeInstructions).toContain("coding_ask");
				// C4-1 (26 October 2026): asked to push, open a draft PR and report its link, Codex committed and ended its
				// turn with a written answer, which fails as CODING_TURN_ENDED_WITHOUT_SUBMISSION. A turn ends by handing in
				// or asking, those words mean a hand-in, and a blocker is handed in or asked about.
				for (const rule of [
					"Every turn ends with coding_finish or coding_ask, never with a written answer alone: a turn that ends without one fails",
					"A request to push, to merge, to open a pull request or to report its link means: commit and call coding_finish; the platform then hands the commit in as above and passes on what happened, so you do none of that yourself.",
					"A repository kept in Qorpera may start empty, with one commit and no files: build the project in it from scratch.",
					// Own code storage, step 6 (20260930736000): code brought in keeps its other branches, for reading only; the
					// import's follow-ups (13 November 2026): one comes into the default branch by a merge on the session's branch.
					"A repository brought in from elsewhere keeps the branches it had there under refs/qorpera/imported/heads/: read them and never change them; to bring one into the default branch, merge it into your branch (git merge refs/qorpera/imported/heads/<name>), then run the checks, commit and finish.",
					"When something blocks you, still end the turn that way. On a GitHub repository: coding_finish with the commit you have and a summary that names the blocker, since it stays a draft.",
					// 10 November 2026 (audit): a landing has no draft, so half-done work is never handed in there, and the
					// values the session was given are its to use. Own code storage, step 3 (20260930721000): Qorpera runs the
					// repository's checks file before a landing; the session writes the file and runs the same checks first.
					"In a repository kept in Qorpera: never hand in half-done or failing work: it would not pass its checks, or would go in unfinished; hand in what is whole and passes its checks and name what is left, or, with nothing whole yet, call coding_ask.",
					"In a repository kept in Qorpera, Qorpera runs the repository's checks before your commit goes into its default branch: the commands in .qorpera/checks.json, each from the top of a clean copy of what would go in (your commit, or your commit merged with the default branch when it moved), on this machine, with CI=true and stdin closed.",
					"Only work whose every check passes goes in; otherwise nothing goes in and the turn fails with the check that failed and the end of its output.",
					'When the repository has no checks file, add one in this change: {"checks":[{"name":"install","run":"npm ci"},{"name":"test","run":"npm test"},{"name":"build","run":"npm run build"}]} for a Node project, or the commands that install, test and build yours;',
					"each check has a name (lower case, digits, . _ -), a run command, and may have timeoutSeconds (10 to 1800, 600 when left out; at most 3600 in all) and cwd (a folder of the repository).",
					'Checks run sequentially unless any check lists "needs" (an array of check names that must pass first), in which case ready checks run in parallel up to 4 at once (e.g. install first, then lint, typecheck and test with "needs":["install"], then build with "needs":["lint","typecheck","test"]); parallel checks share one copy, so do not let two of them write the same files.',
					// Own code storage, step 4 (20260930729000): a website's built folder, named in the checks file, is the
					// change's site for What's new, within a site's limits and with none of the session's secret values.
					'When the project is a website, add "site": {"folder": "dist"} to the checks file, with the folder your build writes:',
					"once every check passed, Qorpera takes the web files in that folder (index.html at its top, at most 500 files and 25 MB in at most 100 folders, none hidden) as the site of this change, and nothing goes in when they are missing or hold one of this session's secret values.",
					// Step 4's live proof (11 November 2026): What's new showed the site's address; a site's title is its name there.
					// Step 5.1 (v247): the name makes the site's own host, and follows the kernel's name rule in its own words.
					'It may also give "name", the name in the site\'s address https://<name>.qorpera.com/, used once, when the site is first made, and "title", the name members see for the site (1 to 120 characters on one line, no space at either end).',
					`no space at either end). ${SITE_NAME_RULE} The site is served`,
					// The first live site (Wristband, 11 November 2026) loaded /src/style.css from the top of the sites' domain,
					// which the old host never served. Since site hosts (v247) a site is served at the top of its own address,
					// so links from / work, and the collect lets them through while hosts are on.
					"The site is served at the top of an address of its own, so its pages, styles and scripts may link its files from / (/src/app.js) or relatively (src/app.js): both work.",
					"Never build a key into the site.",
					"Make checks fast and honest: they must not need servers or ports your own commands hold, or files git does not track.",
					// The session's copy is in its home, on the machine's disk, and is removed first, so a second run after a
					// fix works.
					'Before coding_finish, run them yourself the same way: rm -rf ~/qorpera-check && git clone --quiet --shared --no-checkout "$(git rev-parse --path-format=absolute --git-common-dir)" ~/qorpera-check && git -C ~/qorpera-check checkout --quiet --detach <commit>, then each command in ~/qorpera-check with CI=true.',
					"Never remove or weaken a check or a test to make it pass: the record of your change shows every change to the checks.",
					"Never commit test output or logs as proof; the record says which checks passed. Write tests with a change that can be tested. Keep a README that says how to install, test, build and start the project.",
					"the landing merges your commit with it, and the checks run on that merge; if the two conflict, the turn fails and says so",
					"The secret values this session was given, when it was given any, are environment variables of every command, under the names the company saved them with: use them for what the work needs",
					"Commands in this VM can reach the company's databases under /company/data/ with the data CLI",
					"data describe [<database>], data apply <database>, data query <database> <question> [name=value ...] (or --sql '<one select>'), and data change <database> <change> [name=value ...] print JSON",
					// 3 November 2026: Codex's read-only sandbox notice made a session ask for "a writable coding environment"
					// before it tried one edit. The notice is about the harness's own tools; the repository VM is writable.
					"The read-only sandbox your harness describes covers only its own built-in tools, which this session does not use; it says nothing about the repository VM.",
					"In the VM the selected repository and branch are writable: edit files, install, build, test and commit there through coding_run_command.",
					"Never stop, ask or hand in because of that read-only notice; only a command the VM actually refuses shows the repository is not writable, and then name that command and its error.",
					// Own code storage, step 2b (20260930720000): the change's record is made of one sentence a founder can
					// read and a small picture the session commits; neither holds a hand-in back.
					"With coding_finish, also give notice: one plain sentence, in the language of the brief, on what a customer of the company will notice, written for a founder who reads no code, so with no file, branch, commit or test name in it.",
					"Leave it out when a customer will notice nothing.",
					"When the change shows on a screen, give picture too: take a screenshot of the new screen with the machine's headless Chromium",
					"keep it small (a few hundred KB; one over 4 MB is not used), commit it under docs/changes/ with a name of its own, and give its path in the repository.",
					"Neither is required: never hold work back for them.",
					"For UI or web changes, verify what you built visually before coding_finish: start a local dev or preview server, capture PNG, JPEG, or WebP screenshots with the machine's headless Chromium or Playwright",
					"call coding_run_command with inspectImage set to that relative workspace path (using a fresh operationKey for each new or re-captured screenshot) to view each screenshot directly in your context",
				])
					expect(options.runtimeInstructions).toContain(rule);
				await options.beginExecution(
					{
						type: "namespace",
						name: "qorpera",
						tools: adapters.tools.map((tool) => ({
							type: "function",
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
					},
					options.signal,
				);
				await adapters.assertContext(options.signal);
				const finish = adapters.tools[3];
				const input = {
					operationKey: "done",
					summary: "Changes committed; checks passed",
					headSha: "b".repeat(40),
				};
				// The turn check before the submission is its own child observation.
				const rows: CloudRuntimeObservation[] = [];
				const observability = new CloudRuntimeObservability({
					assignmentId: f.binding.assignmentId,
					publish: async (batch) => {
						rows.push(...structuredClone(batch));
					},
				});
				const span = observability.start("coding_finish");
				// The model gets the receipt without the summary it wrote; the turn row keeps it.
				expect(await finish.execute(finish.parseArguments(input), { ...f.context, observation: span })).toEqual({
					kind: "text",
					value: cloudToolJsonText({
						schema: "qorpera.coding-submission/v1",
						workerId: f.coding.workerId,
						sequence: 1,
						kind: "finish",
						state: "submitted",
						headSha: "b".repeat(40),
						operationKey: "done",
					}),
				});
				expect(f.coding.submission).toMatchObject({ kind: "finish", summary: "Changes committed; checks passed" });
				span.finish("succeeded");
				await observability.close();
				expect(
					rows
						.filter((row) => row.parentAttemptId === span.attemptId && row.phase === "finish")
						.map((row) => [row.operation, row.status]),
				).toEqual([["context_authority", "succeeded"]]);
				await adapters.assertContext(options.signal);
				// After the submission nothing else may run in the VM.
				await expect(
					adapters.tools[0].execute({ operationKey: "later", command: "true", timeoutMs: 1000 }, f.context),
				).rejects.toThrow("CODING_COMMAND_AFTER_SUBMISSION");
				return { providerSessionId: "native-thread", toolCalls: 1, codexVersion: "pinned", fencedRequests: 2 };
			} finally {
				run.close();
			}
		});
		expect(await f.runtime.execute(f.request, "/private/native-identity", f.context.signal, f.turn)).toEqual({
			providerSessionId: "native-thread",
			delivery: { messageCount: 0, finalMessageId: null },
		});
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_submit_coding_turn",
			expect.objectContaining({
				p_binding: f.binding,
				p_submission: {
					kind: "finish",
					operationKey: "done",
					summary: "Changes committed; checks passed",
					headSha: "b".repeat(40),
				},
			}),
			expect.any(AbortSignal),
		);
		expect(f.gatewayFactory).toHaveBeenCalledWith(f.binding);
	});
	// Own code storage, step 2b (20260930720000): a finish may say what a customer will notice and name a screenshot the
	// session committed. Both are optional, a wrong shape is refused with what to change, and neither is ever required.
	it("hands in what a customer will notice and the picture's path when they are given, and only then", async () => {
		const f = fixture();
		const base = {
			operationKey: "done",
			summary: "Added the returns line; npm test: 21 passed",
			headSha: "b".repeat(40),
		};
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				const finish = adapters.tools[3];
				expect(finish.description).toContain(
					"notice says in one plain sentence what a customer will notice, and picture names a screenshot you committed that shows it; both may be left out.",
				);
				expect(finish.inputSchema).toMatchObject({
					properties: {
						notice: { type: "string", minLength: 1, maxLength: 200 },
						picture: { type: "string", minLength: 1, maxLength: 300 },
					},
					required: ["operationKey", "summary", "headSha"],
					additionalProperties: false,
				});
				// Neither given: exactly the three of before. An empty one is one left out.
				expect(finish.parseArguments(base)).toEqual(base);
				expect(finish.parseArguments({ ...base, notice: "", picture: "" })).toEqual(base);
				expect(finish.parseArguments({ ...base, notice: "  \n" })).toEqual(base);
				// Each alone, and both; what surrounds a value is trimmed off.
				expect(
					finish.parseArguments({ ...base, notice: ' Each price now says "Free returns within 30 days". ' }),
				).toEqual({ ...base, notice: 'Each price now says "Free returns within 30 days".' });
				expect(finish.parseArguments({ ...base, picture: " docs/changes/free returns.PNG\n" })).toEqual({
					...base,
					picture: "docs/changes/free returns.PNG",
				});
				for (const picture of [
					"shot.png",
					"a/b/c.webp",
					"docs/changes/x.jpeg",
					"docs/.hidden/y.jpg",
					"a-b_c.d/e.png",
				])
					expect(finish.parseArguments({ ...base, picture })).toEqual({ ...base, picture });
				expect(finish.parseArguments({ ...base, notice: "é".repeat(200) })).toEqual({
					...base,
					notice: "é".repeat(200),
				});
				// A wrong shape is refused in words the model can act on, and the boundary relays them.
				const plain = /^[ -~À-ÿ]{1,1024}$/;
				for (const notice of [
					"two\nlines",
					"a\ttab",
					"x".repeat(201),
					"é".repeat(201),
					"nul\u0000",
					7,
					null,
					["a"],
				]) {
					const refusal = (() => {
						try {
							finish.parseArguments({ ...base, notice } as never);
						} catch (error) {
							return error;
						}
					})();
					expect(refusal, JSON.stringify(notice)).toBeInstanceOf(CloudToolArgumentRefusal);
					expect((refusal as Error).message).toMatch(/^notice is one line of at most 200 characters/);
					expect((refusal as Error).message).toMatch(plain);
				}
				for (const picture of [
					"/company/code/acme/shop/main/docs/changes/x.png",
					"/docs/changes/x.png",
					"docs/changes/../../secret.png",
					"./x.png",
					"docs//x.png",
					"docs/changes/x.gif",
					"docs/changes/x",
					"docs/changes/.png",
					"docs/changes/æ.png",
					"docs/changes/x.png\nmore",
					"docs\\x.png",
					`${"d/".repeat(148)}x.png`,
					7,
					null,
				]) {
					const refusal = (() => {
						try {
							finish.parseArguments({ ...base, picture } as never);
						} catch (error) {
							return error;
						}
					})();
					expect(refusal, JSON.stringify(picture)).toBeInstanceOf(CloudToolArgumentRefusal);
					expect((refusal as Error).message).toMatch(
						/^picture is the path of a \.png, \.jpg, \.jpeg or \.webp file/,
					);
					expect((refusal as Error).message).toMatch(plain);
				}
				// The three of before are still required, and no other key is taken.
				expect(() => finish.parseArguments({ operationKey: "done", headSha: "b".repeat(40), notice: "n" })).toThrow(
					"Invalid coding submission",
				);
				expect(() => finish.parseArguments({ ...base, pictures: ["a.png"] })).toThrow("Invalid coding submission");
				const receipt = JSON.parse(
					(
						await finish.execute(
							finish.parseArguments({
								...base,
								notice: "Each price now says free returns.",
								picture: "docs/changes/free-returns.png",
							}),
							f.context,
						)
					).value as string,
				);
				// The model's receipt holds none of the words, as before.
				expect(receipt).toEqual({
					schema: "qorpera.coding-submission/v1",
					workerId: f.coding.workerId,
					sequence: 1,
					kind: "finish",
					state: "submitted",
					headSha: "b".repeat(40),
					operationKey: "done",
				});
				return { providerSessionId: "native-thread", toolCalls: 1, codexVersion: "pinned", fencedRequests: 2 };
			} finally {
				run.close();
			}
		});
		await f.runtime.execute(f.request, "/private", f.context.signal, f.turn);
		const submitted = f.call.mock.calls.filter(([method]) => method === "qorpera_submit_coding_turn");
		expect(submitted).toHaveLength(1);
		expect(submitted[0]?.[1]).toEqual({
			p_binding: f.binding,
			p_submission: {
				kind: "finish",
				...base,
				notice: "Each price now says free returns.",
				picture: "docs/changes/free-returns.png",
			},
		});
	});
	it("records any number of model requests in a coding turn (runtime v92; it was 256)", async () => {
		const f = fixture();
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) =>
			method === "qorpera_record_coding_context_view"
				? {
						schema: "qorpera.native-context-view-receipt/v1",
						viewId: randomUUID(),
						requestId: (args.p_view as { requestId: string }).requestId,
						sha256: "c".repeat(64),
						ordinal: 300,
					}
				: original(method, args, signal),
		);
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				await adapters.recordContextView(
					{
						schema: "qorpera.native-result-fence/v1",
						requestId: "request-300",
						threadId: "thread",
						turnId: "turn",
						purpose: "turn",
						outputs: [],
					},
					[],
					options.signal,
				);
				throw new Error("request 300 recorded");
			} finally {
				run.close();
			}
		});
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			"request 300 recorded",
		);
	});
	it("a question ends the turn the same way, with its choices", async () => {
		const f = fixture();
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				const ask = adapters.tools[4];
				const parsed = ask.parseArguments({
					operationKey: "poll",
					summary: "Composer fixed; the poll interval is your call.",
					question: "Keep 250 ms, or raise to 500 ms?",
					options: ["Keep 250 ms", "Raise to 500 ms"],
				});
				const receipt = JSON.parse((await ask.execute(parsed, f.context)).value as string);
				// The question and its choices reach the turn row; the model's receipt holds none of the words.
				expect(f.coding.submission).toMatchObject({
					kind: "ask",
					summary: "Composer fixed; the poll interval is your call.",
					question: "Keep 250 ms, or raise to 500 ms?",
					options: ["Keep 250 ms", "Raise to 500 ms"],
				});
				expect(receipt).toEqual({
					schema: "qorpera.coding-submission/v1",
					workerId: f.coding.workerId,
					sequence: 1,
					kind: "ask",
					state: "submitted",
					headSha: null,
					operationKey: "poll",
				});
				expect(() =>
					ask.parseArguments({
						operationKey: "poll",
						summary: "s",
						question: "q",
						options: ["a", "b", "c", "d", "e", "f", "g"],
					}),
				).toThrow();
				return { providerSessionId: "native-thread", toolCalls: 1, codexVersion: "pinned", fencedRequests: 2 };
			} finally {
				run.close();
			}
		});
		await f.runtime.execute(f.request, "/private", f.context.signal, f.turn);
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_submit_coding_turn",
			expect.objectContaining({ p_submission: expect.objectContaining({ kind: "ask" }) }),
			expect.any(AbortSignal),
		);
	});
	it("does not run an ordinary wake through the coding composition", async () => {
		const f = fixture();
		const wake = {
			...(f.turn.wake as object),
			payload: { schema: "qorpera.worker-dispatch/v1", species: "in-house" },
		} as unknown as CloudWakeEnvelope;
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, { ...f.turn, wake })).rejects.toThrow(
			/^CODING_TURN_WAKE_DIFFERS$/,
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("requires no conversation recipient on the admitted native run", async () => {
		const f = fixture();
		f.authority.identity.sessionId = randomUUID();
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			/^CODING_TURN_SCOPE_DIFFERS$/,
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("refuses another worker's scope before launching the harness", async () => {
		const f = fixture();
		f.coding.workerId = randomUUID();
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			/^CODING_TURN_SCOPE_DIFFERS$/,
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("names a timed-out turn check as a timeout, not a refusal, and submits nothing", async () => {
		const f = fixture();
		const rows: CloudRuntimeObservation[] = [];
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				await options.beginExecution(
					{
						type: "namespace",
						name: "qorpera",
						tools: adapters.tools.map((tool) => ({
							type: "function",
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
					},
					options.signal,
				);
				// The coding control's own request deadline (AbortSignal.timeout) ran out.
				const original = f.call.getMockImplementation()!;
				f.call.mockImplementation((method, args, signal) =>
					method === "qorpera_authorize_coding_turn"
						? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
						: original(method, args, signal),
				);
				const observability = new CloudRuntimeObservability({
					assignmentId: f.binding.assignmentId,
					publish: async (batch) => {
						rows.push(...structuredClone(batch));
					},
				});
				const span = observability.start("coding_finish");
				const finish = adapters.tools[3];
				const input = { operationKey: "done", summary: "Changes committed", headSha: "b".repeat(40) };
				await expect(
					finish.execute(finish.parseArguments(input), { ...f.context, observation: span }),
				).rejects.toThrow();
				span.finish("failed");
				await observability.close();
				expect(
					rows
						.filter((row) => row.parentAttemptId === span.attemptId && row.phase === "finish")
						.map((row) => [row.operation, row.status, row.errorCategory]),
				).toEqual([["context_authority", "unconfirmed", "timeout"]]);
				throw new Error("session checked");
			} finally {
				run.close();
			}
		});
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			"session checked",
		);
		expect(f.call).not.toHaveBeenCalledWith("qorpera_submit_coding_turn", expect.anything(), expect.anything());
	});
	it("leaves an already-submitted turn to the executor instead of generating again", async () => {
		const f = fixture();
		f.coding.submission = { kind: "finish", headSha: "a".repeat(40) };
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			/^CODING_TURN_ALREADY_SUBMITTED$/,
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("a one-letter answer is read against the exact question and choices of the turn before", async () => {
		const f = fixture();
		// The kernel side of two turns, as qorpera_read_coding_turn_context returns them: the
		// submission of turn 1 is what the harness really submitted through coding_ask.
		const question = "Should I use approach A or B?";
		const choices = ["A: keep the in-memory cache", "B: drop the cache and read through"];
		const prompts: Record<string, unknown>[] = [];
		const decisions: string[] = [];
		// A stand-in model that can only act on its prompt: turn 1 asks, turn 2 acts on the answer.
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				const context = JSON.parse(options.prompt ?? "") as Record<string, unknown>;
				prompts.push(context);
				const [, , , finish, ask] = adapters.tools;
				const current = context.input as { text: string | null; answers: { options: string[] } | null } | undefined;
				if (!current?.answers) {
					await ask.execute(
						ask.parseArguments({
							operationKey: "approach",
							summary: "Two ways to go.",
							question,
							options: choices,
						}),
						f.context,
					);
				} else {
					const chosen = current.answers.options.find((option) => option.startsWith(`${current.text}:`));
					if (!chosen) throw new Error("The answer does not name a choice");
					decisions.push(chosen);
					await finish.execute(
						finish.parseArguments({
							operationKey: "done",
							summary: `Went with ${chosen}.`,
							headSha: "c".repeat(40),
						}),
						f.context,
					);
				}
				return { providerSessionId: "native-thread", toolCalls: 1, codexVersion: "pinned", fencedRequests: 1 };
			} finally {
				run.close();
			}
		});
		await f.runtime.execute(f.request, "/private", f.context.signal, f.turn);
		const asked = f.coding.submission as Record<string, unknown>;
		expect(asked).toMatchObject({ kind: "ask", question, options: choices });

		// The executor reported the question; the owner answered "B"; the kernel opened turn 2.
		f.turnContext.earlierTurns.push({
			sequence: 1,
			input: { from: "dispatch", text: null },
			submitted: { kind: "ask", summary: asked.summary, question, options: choices, headSha: null },
			outcome: {
				state: "blocked",
				summary: asked.summary,
				reason: null,
				needs: question,
				options: choices,
				pullRequest: null,
			},
		});
		f.turnContext.input = { from: "member", text: "B", answers: { question, options: choices } };
		Object.assign(f.coding, { sequence: 2, turnId: randomUUID(), followUp: "B", submission: null });
		const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
		wake.payload.sequence = 2;
		await f.runtime.execute(f.request, "/private", f.context.signal, {
			...f.turn,
			wake: wake as unknown as CloudWakeEnvelope,
		});

		expect(prompts[1]).toMatchObject({
			schema: "qorpera.coding-context/v2",
			sequence: 2,
			input: { from: "member", text: "B", answers: { question, options: choices } },
			earlierTurns: [{ sequence: 1, submitted: { kind: "ask", question, options: choices } }],
		});
		expect(decisions).toEqual(["B: drop the cache and read through"]);
		// A letter counts by position, and an undecided question is asked again rather than guessed.
		const instructions = vi.mocked(runCloudNativeRunToolSession).mock.calls[1][0].runtimeInstructions;
		expect(instructions).toContain("a single letter selects the choice at that position (A is the first)");
		expect(instructions).toContain("the only choice that starts with that letter");
		expect(instructions).toContain("a turn marked shortened had its long texts cut to fit");
		expect(instructions).toContain("When no reply decides it");
		expect(instructions).toContain("call coding_ask again");
		expect(instructions).toContain("MACHINE_STOPPED: the machine stopped from outside");
		expect(instructions).toContain("FOLDER_RESTART: the machine restarted because the company folder");
		expect(instructions).toContain("MACHINE_NEW_DISK: the machine got a new disk");
		expect(instructions).toContain("a new disk keeps only /company, which holds the repository");
		// Own code storage, step 6: the machine's package caches, which its sessions and the checks share.
		expect(instructions).toContain(
			"start fresh. Packages you download with npm, pnpm, pip, uv and Playwright are kept on this machine for later sessions and for Qorpera's checks. ",
		);
		expect(f.gateway.start).not.toHaveBeenCalled();
		expect(f.coding.submission).toMatchObject({
			kind: "finish",
			summary: "Went with B: drop the cache and read through.",
		});
	});
	it("refuses a turn context that belongs to another turn or claims a question it cannot hold", async () => {
		// Turn 2 answering turn 1's question; each case breaks one rule of it.
		const earlier = {
			sequence: 1,
			input: { from: "dispatch", text: null },
			submitted: { kind: "ask", summary: "Two ways.", question: "A or B?", options: ["A", "B"], headSha: null },
			outcome: {
				state: "blocked",
				summary: "Two ways.",
				reason: null,
				needs: "A or B?",
				options: ["A", "B"],
				pullRequest: null,
			},
		};
		const valid = {
			schema: "qorpera.coding-turn-context/v2",
			sequence: 2,
			input: { from: "member", text: "B", answers: { question: "A or B?", options: ["A", "B"] } },
			earlierTurns: [earlier],
			omittedEarlierTurns: 0,
			commands: { running: [], stopped: [], omitted: 0 },
		};
		const run = async (drift: Record<string, unknown>) => {
			const f = fixture();
			Object.assign(f.coding, { sequence: 2 });
			const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
			wake.payload.sequence = 2;
			const original = f.call.getMockImplementation()!;
			f.call.mockImplementation(async (method, args, signal) =>
				method === "qorpera_read_coding_turn_context"
					? { ...valid, workerId: f.coding.workerId, ...drift }
					: original(method, args, signal),
			);
			vi.mocked(runCloudNativeRunToolSession).mockReset();
			vi.mocked(runCloudNativeRunToolSession).mockResolvedValue({
				providerSessionId: "native-thread",
				toolCalls: 0,
				codexVersion: "pinned",
				fencedRequests: 1,
			});
			return f.runtime.execute(f.request, "/private", f.context.signal, {
				...f.turn,
				wake: wake as unknown as CloudWakeEnvelope,
			});
		};
		// The unbroken context is accepted: the turn runs and then ends without a submission.
		await expect(run({})).rejects.toThrow(/^CODING_TURN_ENDED_WITHOUT_SUBMISSION$/);
		for (const drift of [
			{ sequence: 3 },
			{ workerId: randomUUID() },
			{ omittedEarlierTurns: 1 },
			{ input: { from: "stranger", text: "B", answers: null } },
			{ input: { from: "dispatch", text: null, answers: null } },
			{ input: { from: "member", text: "", answers: null } },
			{ input: { from: "member", text: "B", answers: { question: "", options: [] } } },
			{
				input: {
					from: "member",
					text: "B",
					answers: { question: "A or B?", options: ["1", "2", "3", "4", "5", "6", "7"] },
				},
			},
			{ earlierTurns: [{ ...earlier, sequence: 2 }] },
			{ earlierTurns: [{ ...earlier, submitted: { ...earlier.submitted, kind: "finish", headSha: "short" } }] },
			{
				earlierTurns: [
					{
						...earlier,
						outcome: {
							...earlier.outcome,
							pullRequest: { url: "https://github.com/Other/repo/pull/1", number: 1, headSha: "c".repeat(40) },
						},
					},
				],
			},
		]) {
			await expect(run(drift)).rejects.toThrow(/^CODING_TURN_CONTEXT_INVALID$/);
			expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
		}
	});
	it("accepts the context the kernel really returns for a session stuck before the fix", () => {
		// Captured from qorpera_read_coding_turn_context by scripts/test-coding-turn-backfill.mjs, which C1c-3i removed with
		// the snapshot-v1 coding path; the sample stays as a shape the parser must keep accepting.
		const sample: unknown = JSON.parse(
			readFileSync(new URL("./fixtures/coding-turn-context-backfilled.json", import.meta.url), "utf8"),
		);
		const context = parseCloudCodingTurnContext(
			sample,
			{ workerId: "00000000-0000-4000-8000-000000000000", sequence: 4 },
			{ host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
		);
		expect(context.input).toEqual({
			from: "member",
			text: "Yes, back off.",
			answers: { question: "Should the poll also back off after errors?", options: ["Yes", "No"] },
		});
		expect(
			context.earlierTurns.map((turn) => [turn.sequence, turn.submitted?.kind ?? null, turn.outcome?.state]),
		).toEqual([
			[1, null, "succeeded"],
			[2, null, "blocked"],
			[3, "ask", "failed"],
		]);
		expect(context.earlierTurns[1].outcome?.needs).toBe("Keep 250 ms, or raise to 500 ms?");
		// It predates machine (20260930515000): no new disk.
		expect(context.machine).toEqual({ newDisk: false });
	});
	it("takes a command the machine's stop from outside, its restart for the folder or its new disk ended, and refuses a reason it does not know", () => {
		const workerId = randomUUID(),
			repository = { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" } as const;
		const stopped = { commandId: randomUUID(), turn: 1, command: "npm run dev", reason: "MACHINE_STOPPED" };
		const context = (reason: string) => ({
			schema: "qorpera.coding-turn-context/v2",
			workerId,
			sequence: 2,
			input: { from: "agent", text: "Go on.", answers: null },
			earlierTurns: [],
			omittedEarlierTurns: 1,
			commands: { running: [], stopped: [{ ...stopped, reason }], omitted: 0 },
		});
		expect(
			parseCloudCodingTurnContext(context("MACHINE_STOPPED"), { workerId, sequence: 2 }, repository).commands,
		).toEqual({ running: [], stopped: [stopped], omitted: 0 });
		expect(
			parseCloudCodingTurnContext(context("FOLDER_RESTART"), { workerId, sequence: 2 }, repository).commands,
		).toEqual({ running: [], stopped: [{ ...stopped, reason: "FOLDER_RESTART" }], omitted: 0 });
		expect(
			parseCloudCodingTurnContext(context("MACHINE_NEW_DISK"), { workerId, sequence: 2 }, repository).commands,
		).toEqual({ running: [], stopped: [{ ...stopped, reason: "MACHINE_NEW_DISK" }], omitted: 0 });
		expect(() => parseCloudCodingTurnContext(context("UNPLUGGED"), { workerId, sequence: 2 }, repository)).toThrow(
			/^CODING_TURN_CONTEXT_INVALID$/,
		);
	});
	it("reads whether the machine got a new disk, a context that does not say as no, and refuses any other shape of it", () => {
		const workerId = randomUUID(),
			repository = { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" } as const;
		const context = {
			schema: "qorpera.coding-turn-context/v2",
			workerId,
			sequence: 2,
			input: { from: "agent", text: "Go on.", answers: null },
			earlierTurns: [],
			omittedEarlierTurns: 1,
			commands: { running: [], stopped: [], omitted: 0 },
		};
		const machine = (value: unknown) =>
			parseCloudCodingTurnContext(value, { workerId, sequence: 2 }, repository).machine;
		// A kernel from before 20260930515000 does not say.
		expect(machine(context)).toEqual({ newDisk: false });
		expect(machine({ ...context, machine: { newDisk: false } })).toEqual({ newDisk: false });
		expect(machine({ ...context, machine: { newDisk: true } })).toEqual({ newDisk: true });
		for (const drift of [
			{ newDisk: true, since: "2026-10-17T20:00:00Z" },
			{ newDisk: "yes" },
			{ newDisk: 1 },
			{ newDisk: null },
			{},
			null,
			[],
			true,
		])
			expect(() => machine({ ...context, machine: drift })).toThrow(/^CODING_TURN_CONTEXT_INVALID$/);
	});
	it("tells the agent of a new disk only on a turn whose context says so", async () => {
		for (const said of [undefined, { newDisk: false }, { newDisk: true }]) {
			const f = fixture();
			// Turn 2: the kernel never says it on a first turn.
			Object.assign(f.coding, { sequence: 2 });
			const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
			wake.payload.sequence = 2;
			f.turnContext.earlierTurns = [
				{ sequence: 1, input: { from: "dispatch", text: null }, submitted: null, outcome: null },
			];
			f.turnContext.input = { from: "member", text: "Go on.", answers: null };
			if (said) Object.assign(f.turnContext, { machine: said });
			let prompt = "";
			let instructions = "";
			vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
				prompt = options.prompt ?? "";
				instructions = options.runtimeInstructions ?? "";
				throw new Error("stop after composing");
			});
			await expect(
				f.runtime.execute(f.request, "/private", f.context.signal, {
					...f.turn,
					wake: wake as unknown as CloudWakeEnvelope,
				}),
			).rejects.toThrow("stop after composing");
			const newDisk = said?.newDisk ?? false;
			// The prompt carries it, so it counts in the context's hash.
			expect((JSON.parse(prompt) as { machine: unknown }).machine).toEqual({ newDisk });
			expect(instructions.split("machine.newDisk is true").length - 1).toBe(newDisk ? 1 : 0);
			if (newDisk) expect(instructions).toContain("Only /company was kept");
			expect(instructions).toContain("MACHINE_NEW_DISK: the machine got a new disk");
		}
	});
	it("reads optional secretNames in turn context and refuses invalid shapes", () => {
		const workerId = randomUUID(),
			repository = { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" } as const;
		const context = {
			schema: "qorpera.coding-turn-context/v2",
			workerId,
			sequence: 2,
			input: { from: "agent", text: "Go on.", answers: null },
			earlierTurns: [],
			omittedEarlierTurns: 1,
			commands: { running: [], stopped: [], omitted: 0 },
		};
		const parsed = (value: unknown) =>
			parseCloudCodingTurnContext(value, { workerId, sequence: 2 }, repository).secretNames;
		expect(parsed(context)).toBeUndefined();
		expect(parsed({ ...context, secretNames: [] })).toEqual([]);
		expect(parsed({ ...context, secretNames: ["NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] })).toEqual([
			"NPM_TOKEN",
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
		]);
		const tooMany = Array.from({ length: 129 }, (_, index) => `SECRET_${index}`);
		for (const bad of [
			null,
			"OPENAI_API_KEY",
			{},
			[123],
			["openai_api_key"],
			["OPENAI_API_KEY=sk-test"],
			["1BAD"],
			[""],
			["A".repeat(65)],
			["OPENAI_API_KEY", "OPENAI_API_KEY"],
			tooMany,
		])
			expect(() => parsed({ ...context, secretNames: bad })).toThrow(/^CODING_TURN_CONTEXT_INVALID$/);
	});
	it("surfaces configured secretNames in the coding context prompt when present", async () => {
		for (const names of [undefined, [], ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]]) {
			const f = fixture();
			if (names !== undefined) Object.assign(f.turnContext, { secretNames: names });
			let prompt = "";
			vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
				prompt = options.prompt ?? "";
				throw new Error("stop after composing");
			});
			await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
				"stop after composing",
			);
			const parsed = JSON.parse(prompt) as Record<string, unknown>;
			if (names === undefined) expect(Object.hasOwn(parsed, "secretNames")).toBe(false);
			else expect(parsed.secretNames).toEqual(names);
		}
	});
	it("keeps the newest earlier turns when the whole history does not fit the prompt", async () => {
		const f = fixture();
		// Turn 43: the kernel already left turns 1-3 out of its answer; 4-42 still exceed the prompt.
		Object.assign(f.coding, { sequence: 43 });
		const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
		wake.payload.sequence = 43;
		const long = "x".repeat(3900);
		f.turnContext.earlierTurns = Array.from({ length: 39 }, (_, index) => ({
			sequence: index + 4,
			input: { from: "member", text: long },
			submitted: null,
			outcome: { state: "failed", summary: long, reason: null, needs: null, options: [], pullRequest: null },
		}));
		f.turnContext.input = { from: "member", text: "Go on.", answers: null };
		f.turnContext.omittedEarlierTurns = 3;
		let prompt = "";
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			prompt = options.prompt ?? "";
			throw new Error("stop after composing");
		});
		await expect(
			f.runtime.execute(f.request, "/private", f.context.signal, {
				...f.turn,
				wake: wake as unknown as CloudWakeEnvelope,
			}),
		).rejects.toThrow("stop after composing");
		const context = JSON.parse(prompt) as { earlierTurns: { sequence: number }[]; omittedEarlierTurns: number };
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
		expect(context.earlierTurns.at(-1)?.sequence).toBe(42);
		expect(context.earlierTurns.length).toBeGreaterThan(0);
		expect(context.earlierTurns.length).toBeLessThan(39);
		expect(context.omittedEarlierTurns).toBe(3 + 39 - context.earlierTurns.length);
		expect(context.earlierTurns.map((turn) => turn.sequence)).toEqual(
			Array.from({ length: context.earlierTurns.length }, (_, index) => 43 - context.earlierTurns.length + index),
		);
	});
	it("keeps the previous turn, shortened, when it alone does not fit the prompt", async () => {
		const f = fixture();
		Object.assign(f.coding, { sequence: 3 });
		const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
		wake.payload.sequence = 3;
		// Control characters escape to six bytes each: turn 2 alone is about 90 KB of prompt.
		const wide = "\u0001".repeat(4000);
		const question = `Keep the raw log?${"\u0001".repeat(900)}`;
		f.turnContext.earlierTurns = [
			{ sequence: 1, input: { from: "dispatch", text: null }, submitted: null, outcome: null },
			{
				sequence: 2,
				input: { from: "member", text: wide },
				submitted: { kind: "ask", summary: wide, question, options: ["Yes", "No"], headSha: null },
				outcome: {
					state: "blocked",
					summary: wide,
					reason: null,
					needs: question,
					options: ["Yes", "No"],
					pullRequest: null,
				},
			},
		];
		f.turnContext.input = { from: "member", text: "Yes", answers: { question, options: ["Yes", "No"] } };
		let prompt = "";
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			prompt = options.prompt ?? "";
			throw new Error("stop after composing");
		});
		await expect(
			f.runtime.execute(f.request, "/private", f.context.signal, {
				...f.turn,
				wake: wake as unknown as CloudWakeEnvelope,
			}),
		).rejects.toThrow("stop after composing");
		const context = JSON.parse(prompt) as {
			earlierTurns: { sequence: number; shortened?: boolean; submitted: { question: string } }[];
			omittedEarlierTurns: number;
		};
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
		expect(context.earlierTurns.map((turn) => [turn.sequence, turn.shortened])).toEqual([[2, true]]);
		expect(context.earlierTurns[0].submitted.question.startsWith("Keep the raw log?")).toBe(true);
		expect(context.omittedEarlierTurns).toBe(1);
	});
	it("forwards verified coding screenshot images through the tool boundary and context view, and refuses forged image provenance", async () => {
		const f = fixture();
		const png = pngFile(pngHeader(2, 1, 8, 2), pngRows([[255, 0, 0, 0, 0, 255]]));
		const rawSha = createHash("sha256").update(png).digest("hex");
		const payload = `QORPERA_IMG:${png.byteLength}:${rawSha}:\n${png.toString("base64")}`;
		vi.mocked(f.gateway.start).mockImplementation(async (_scope, input) => ({
			schema: "qorpera.coding-command-result/v2",
			workerId: f.scope.workerId,
			commandId: input.commandId,
			inputSha256: input.inputSha256,
			state: "succeeded",
			exitCode: 0,
			output: payload,
			truncated: false,
			log: {
				offset: 0,
				nextOffset: payload.length,
				totalBytes: payload.length,
				limitBytes: 67108864,
				limitReached: false,
			},
		}));
		const ledger = new Map<string, { receiptId: string; result: unknown }>();
		f.control.beginToolOperation.mockImplementation(async (b, input) => {
			let row = ledger.get(input.logicalOperationKey);
			if (!row) {
				row = { receiptId: input.receiptId, result: null };
				ledger.set(input.logicalOperationKey, row);
			}
			return {
				run_id: b.runId,
				receipt_id: row.receiptId,
				state: row.result === null ? "executing" : "completed",
				result: row.result,
				output_snapshot_id: null,
				proposal_id: null,
				folder_commit_id: null,
			};
		});
		f.control.completeToolOperation.mockImplementation(async (b, input) => {
			const row = [...ledger.values()].find((r) => r.receiptId === input.receiptId);
			if (row) row.result = structuredClone(input.result);
			return { run_id: b.runId, receipt_id: input.receiptId, state: "completed", result: input.result };
		});
		const original = f.call.getMockImplementation()!;
		const recordedViews: unknown[] = [];
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_record_coding_context_view") {
				recordedViews.push(args.p_view);
				return {
					schema: "qorpera.native-context-view-receipt/v1",
					viewId: randomUUID(),
					requestId: (args.p_view as { requestId: string }).requestId,
					sha256: "d".repeat(64),
					ordinal: recordedViews.length,
				};
			}
			return original(method, args, signal);
		});
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				expect(adapters.tools[0]?.images).toBe(true);
				const boundary = new CloudNativeToolBoundary({
					companyId: f.authority.identity.companyId,
					runId: f.authority.identity.runId,
					identity: f.authority.identity,
					tools: adapters.tools,
					assertActive: async () => undefined,
					signal: options.signal,
				});
				try {
					expect(boundary.captureImagesEnabled).toBe(true);
					const invoked = await boundary.invoke("shot-1", "qorpera", "coding_run_command", {
						operationKey: "view-home",
						inspectImage: "docs/changes/home.png",
					});
					expect(invoked.success).toBe(true);
					expect(invoked.contentItems).toHaveLength(2);
					const envelopeText = invoked.contentItems[0].text;
					const answer = JSON.parse(JSON.parse(envelopeText).content.text);
					const fenced = await boundary.fenceNativeResults([
						{
							kind: "function_call_output",
							callId: "shot-1",
							output: [
								{ type: "input_text", text: envelopeText },
								{ type: "input_image", sha256: answer.imageSha256 },
							],
						},
					]);
					expect(fenced).toEqual([
						{
							kind: "function_call_output",
							callId: "shot-1",
							output: envelopeText,
							imageSha256: answer.imageSha256,
						},
					]);
					const frame = {
						schema: "qorpera.native-result-fence/v1" as const,
						requestId: "req-img-1",
						threadId: "thread",
						turnId: "turn",
						purpose: "turn" as const,
						outputs: [],
					};
					await adapters.recordContextView(frame, fenced, options.signal);
					expect(recordedViews).toHaveLength(1);
					expect(recordedViews[0]).toMatchObject({
						requestId: "req-img-1",
						outputs: [{ callId: "shot-1", readId: null }],
					});
					await expect(
						adapters.recordContextView(
							{ ...frame, requestId: "req-img-bad-hash" },
							[{ ...fenced[0]!, imageSha256: "f".repeat(64) }],
							options.signal,
						),
					).rejects.toThrow("CODING_CONTEXT_RESOURCES_REFUSED");
					const forgedToolEnvelope = JSON.stringify({
						...JSON.parse(envelopeText),
						provenance: { ...JSON.parse(envelopeText).provenance, tool: "coding_read_command" },
					});
					await expect(
						adapters.recordContextView(
							{ ...frame, requestId: "req-img-bad-tool" },
							[{ ...fenced[0]!, output: forgedToolEnvelope }],
							options.signal,
						),
					).rejects.toThrow("CODING_CONTEXT_RESOURCES_REFUSED");
					const withReadIdEnvelope = JSON.stringify({
						...JSON.parse(envelopeText),
						provenance: { ...JSON.parse(envelopeText).provenance, companyReadId: randomUUID() },
					});
					await expect(
						adapters.recordContextView(
							{ ...frame, requestId: "req-img-read-id" },
							[{ ...fenced[0]!, output: withReadIdEnvelope }],
							options.signal,
						),
					).rejects.toThrow("CODING_CONTEXT_RESOURCES_REFUSED");
					await expect(
						adapters.recordContextView(
							{ ...frame, requestId: "req-img-capture" },
							[{ ...fenced[0]!, capture: {} as never }],
							options.signal,
						),
					).rejects.toThrow("CODING_CONTEXT_RESOURCES_REFUSED");
					const finish = adapters.tools[3]!;
					await finish.execute(
						finish.parseArguments({
							operationKey: "done",
							summary: "Inspected screenshot and finished.",
							headSha: "b".repeat(40),
						}),
						f.context,
					);
				} finally {
					boundary.close();
				}
				return { providerSessionId: "native-thread", toolCalls: 2, codexVersion: "pinned", fencedRequests: 2 };
			} finally {
				run.close();
			}
		});
		await f.runtime.execute(f.request, "/private", f.context.signal, f.turn);
		expect(recordedViews).toHaveLength(1);
	});
	it("does not claim completion when the harness ends without a submission", async () => {
		const f = fixture();
		vi.mocked(runCloudNativeRunToolSession).mockResolvedValue({
			providerSessionId: "native-thread",
			toolCalls: 0,
			codexVersion: "pinned",
			fencedRequests: 1,
		});
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			/^CODING_TURN_ENDED_WITHOUT_SUBMISSION$/,
		);
	});
});

describe("a coding turn's first reads through a slow database (R2, 31 Oct 2026)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	const authorize = "qorpera_authorize_coding_turn";
	const read = "qorpera_read_coding_turn_context";

	/** Fake timers and performance.now move together, in small steps, so a timer set late in a step still fires in the next. */
	function fakeClock() {
		vi.useFakeTimers();
		const clock = {
			now: 0,
			async tick(ms: number) {
				for (let passed = 0; passed < ms; passed += 50) {
					clock.now += 50;
					await vi.advanceTimersByTimeAsync(50);
				}
			},
		};
		vi.spyOn(performance, "now").mockImplementation(() => clock.now);
		return clock;
	}
	/** The fixture's control, failing the first answers of each method as `lost` says, and noting when each call is sent. */
	function losing(f: ReturnType<typeof fixture>, now: () => number, lost: Partial<Record<string, (() => unknown)[]>>) {
		const original = f.call.getMockImplementation()!;
		const sent: [string, number][] = [];
		f.call.mockImplementation(async (method, args, signal) => {
			sent.push([method, now()]);
			const fail = lost[method]?.shift();
			return fail ? fail() : original(method, args, signal);
		});
		return sent;
	}

	it("asks the turn's authority and context again while their answers are lost, and waits out a copy the database may still run", async () => {
		const clock = fakeClock();
		const f = fixture();
		const sent = losing(f, () => clock.now, {
			// PostgREST's statement timeout: the copy ended, so it is asked again after the first pause.
			[authorize]: [() => Promise.reject(new CloudControlRpcEnded(`Coding control ${authorize} unconfirmed (500)`))],
			// No answer at all: the copy may still take the run's row, so it is asked again 20 s after it was sent.
			[read]: [
				() =>
					Promise.reject(
						new CloudRuntimeDiagnosticError("transport_unavailable", `Coding control ${read} unconfirmed`),
					),
			],
		});
		vi.mocked(runCloudNativeRunToolSession).mockRejectedValue(new Error("stop after composing"));
		const outcome = expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			"stop after composing",
		);
		await vi.advanceTimersByTimeAsync(0);
		await clock.tick(21_000);
		await outcome;
		expect(sent).toEqual([
			[authorize, 0],
			[authorize, 250],
			[read, 250],
			[read, 20_250],
		]);
		expect(runCloudNativeRunToolSession).toHaveBeenCalledTimes(1);
	});

	it("gives up a read whose answers stay lost at its 30 s budget, and starts no session", async () => {
		const clock = fakeClock();
		const f = fixture();
		// Every answer is lost: the call hangs and ignores its signal.
		const sent: [string, number][] = [];
		f.call.mockImplementation(async (method) => {
			sent.push([method, clock.now]);
			return new Promise<never>(() => undefined);
		});
		let settled = false;
		const execution = f.runtime.execute(f.request, "/private", f.context.signal, f.turn).finally(() => {
			settled = true;
		});
		const outcome = expect(execution).rejects.toMatchObject({ category: "timeout" });
		await vi.advanceTimersByTimeAsync(0);
		// The first attempt waits as long as the database may run it (20 s); the second gets what is left of the budget.
		await clock.tick(29_900);
		expect(settled).toBe(false);
		await clock.tick(200);
		expect(settled).toBe(true);
		await outcome;
		await expect(execution).rejects.toBeInstanceOf(CloudRuntimeDiagnosticError);
		expect(sent).toEqual([
			[authorize, 0],
			[authorize, 20_250],
		]);
		// Nothing more is asked after the budget, and no session started.
		await clock.tick(60_000);
		expect(f.call).toHaveBeenCalledTimes(2);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});

	it("asks a refused or unreadable read once", async () => {
		const cases: [Partial<Record<string, (() => unknown)[]>>, string, number][] = [
			[
				{ [authorize]: [() => Promise.reject(new Error(`Coding control ${authorize} unconfirmed (403)`))] },
				"(403)",
				1,
			],
			[{ [read]: [() => Promise.reject(new Error(`Coding control ${read} unconfirmed (500)`))] }, "(500)", 2],
			[{ [authorize]: [() => Promise.resolve({ unexpected: true })] }, "CODING_TURN_AUTHORITY_DIFFERS", 1],
			[{ [read]: [() => Promise.resolve({ unexpected: true })] }, "CODING_TURN_CONTEXT_INVALID", 2],
		];
		for (const [lost, message, calls] of cases) {
			const f = fixture();
			losing(f, () => 0, lost);
			await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(message);
			expect(f.call).toHaveBeenCalledTimes(calls);
			expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
		}
	});

	it("stops asking when the turn is stopped during the pause", async () => {
		const clock = fakeClock();
		const f = fixture();
		losing(f, () => clock.now, {
			[authorize]: [
				() =>
					Promise.reject(
						new CloudRuntimeDiagnosticError("transport_unavailable", `Coding control ${authorize} unconfirmed`),
					),
			],
		});
		const stop = new AbortController();
		const reason = new Error("turn stopped");
		const outcome = expect(f.runtime.execute(f.request, "/private", stop.signal, f.turn)).rejects.toBe(reason);
		await vi.advanceTimersByTimeAsync(0);
		await clock.tick(5_000);
		expect(f.call).toHaveBeenCalledTimes(1);
		stop.abort(reason);
		await outcome;
		await clock.tick(30_000);
		expect(f.call).toHaveBeenCalledTimes(1);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});

	it("drops a late answer: the turn reads the attempt that answered in time", async () => {
		const clock = fakeClock();
		const f = fixture();
		const original = f.call.getMockImplementation()!;
		const sent: [string, number][] = [];
		f.call.mockImplementation(async (method, args, signal) => {
			sent.push([method, clock.now]);
			const value = (await original(method, args, signal)) as Record<string, unknown>;
			if (method !== authorize || sent.length > 1) return value;
			// The first authority ignores its cut and answers at 25 s that the turn was already submitted: read, it would
			// end the turn.
			await new Promise((resolve) => setTimeout(resolve, 25_000));
			return { ...value, coding: { ...(value.coding as Record<string, unknown>), submission: { kind: "finish" } } };
		});
		vi.mocked(runCloudNativeRunToolSession).mockRejectedValue(new Error("stop after composing"));
		const outcome = expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			"stop after composing",
		);
		await vi.advanceTimersByTimeAsync(0);
		await clock.tick(26_000);
		await outcome;
		expect(sent).toEqual([
			[authorize, 0],
			[authorize, 20_250],
			[read, 20_250],
		]);
		expect(runCloudNativeRunToolSession).toHaveBeenCalledTimes(1);
	});

	it("goes on through the coding control's lost answers: its first reads, and its run's authority check", async () => {
		const clock = fakeClock();
		const f = fixture();
		const original = f.call.getMockImplementation()!;
		const answers: Partial<Record<string, Response[]>> = {
			[authorize]: [
				new Response(JSON.stringify({ code: "57014", details: null, hint: null, message: "canceling statement" }), {
					status: 500,
				}),
			],
			[read]: [new Response(null, { status: 503 })],
		};
		const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1) as Parameters<
				CloudCodingNativeControl["call"]
			>[0];
			const answer = answers[method]?.shift();
			if (answer) return answer;
			const value = await original(method, JSON.parse(String(init?.body)), init?.signal as AbortSignal);
			return new Response(JSON.stringify(value), { status: 200 });
		});
		const http = new HttpCloudCodingControl({
			supabaseUrl: "https://db.example.test/",
			serviceRoleKey: "private",
			fetch,
		});
		f.call.mockImplementation((method, args, signal) => http.call(method, args, signal));
		let aborted: boolean | undefined;
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, options.controlPlane, options.signal);
			try {
				// PostgREST's pool wait (PGRST003) on the run's next authority check: the run asks again and holds.
				answers[authorize]?.push(
					new Response(JSON.stringify({ code: "PGRST003", details: null, hint: null, message: "timed out" }), {
						status: 504,
					}),
				);
				await run.assertActive(options.signal);
				aborted = run.signal.aborted;
			} finally {
				run.close();
			}
			throw new Error("session checked");
		});
		let settled = false;
		const execution = f.runtime.execute(f.request, "/private", f.context.signal, f.turn).finally(() => {
			settled = true;
		});
		const outcome = expect(execution).rejects.toThrow("session checked");
		for (let second = 0; second < 60 && !settled; second += 1) await clock.tick(1_000);
		await outcome;
		expect(aborted).toBe(false);
		// Authority twice, context twice, the run's opening read, and its check twice.
		expect(fetch.mock.calls.map(([url]) => String(url).slice(String(url).lastIndexOf("/") + 1))).toEqual([
			authorize,
			authorize,
			read,
			read,
			authorize,
			authorize,
			authorize,
		]);
	});

	it("goes on through answers cut off after their headers: its first reads, and its run's authority read (release PR #1390 review F2)", async () => {
		const clock = fakeClock();
		const f = fixture();
		const original = f.call.getMockImplementation()!;
		// Good headers, then the connection is lost mid-body (undici's error for it).
		const cut = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"schema":'));
					},
					pull(controller) {
						controller.error(new TypeError("terminated"));
					},
				}),
				{ status: 200 },
			);
		const answers: Partial<Record<string, Response[]>> = { [authorize]: [cut()], [read]: [cut()] };
		const sent: [string, number][] = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1) as Parameters<
				CloudCodingNativeControl["call"]
			>[0];
			sent.push([method, clock.now]);
			const answer = answers[method]?.shift();
			if (answer) return answer;
			const value = await original(method, JSON.parse(String(init?.body)), init?.signal as AbortSignal);
			return new Response(JSON.stringify(value), { status: 200 });
		});
		const http = new HttpCloudCodingControl({
			supabaseUrl: "https://db.example.test/",
			serviceRoleKey: "private",
			fetch,
		});
		f.call.mockImplementation((method, args, signal) => http.call(method, args, signal));
		let aborted: boolean | undefined;
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			// The run's own first read of its authority is cut off too.
			answers[authorize]?.push(cut());
			const run = await CloudNativeToolRun.open(f.binding, options.controlPlane, options.signal);
			aborted = run.signal.aborted;
			run.close();
			throw new Error("session opened");
		});
		let settled = false;
		const execution = f.runtime.execute(f.request, "/private", f.context.signal, f.turn).finally(() => {
			settled = true;
		});
		const outcome = expect(execution).rejects.toThrow("session opened");
		await vi.advanceTimersByTimeAsync(0);
		for (let second = 0; second < 120 && !settled; second += 1) await clock.tick(1_000);
		await outcome;
		expect(aborted).toBe(false);
		// Each asked again once its cut copy is waited out: nothing said that copy's statement ended.
		expect(sent).toEqual([
			[authorize, 0],
			[authorize, 20_000],
			[read, 20_000],
			[read, 40_000],
			[authorize, 40_000],
			[authorize, 60_000],
		]);
	});
});
