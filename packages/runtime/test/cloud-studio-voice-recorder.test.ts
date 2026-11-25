import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudCodingCommandScope } from "@qorpera/contracts";
import { captionHash } from "@qorpera/runtime/cloud-app-kit-explainer";
import type { CloudCodingCommandGateway } from "@qorpera/runtime/cloud-coding-command-tools";
import type { CloudNativeToolIdentity } from "@qorpera/runtime/cloud-native-tool-authority";
import type { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import {
	recordStudioChatGptVoiceClips,
	type StudioChatGptVoiceMachine,
} from "@qorpera/runtime/cloud-studio-voice-recorder";
import { prepareSurfaceCodingWorkspace } from "@qorpera/runtime/cloud-surface-coding-tools";
import {
	type CloudVoiceCall,
	CloudVoiceLimitReached,
	type CloudVoiceUsage,
} from "@qorpera/runtime/cloud-voice-channel";
import { afterEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_STUB = join(HERE, "fixtures/voice-playwright-stub.cjs");
const MARK = "QORPERA-VOICE ";
const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const VM_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const COMPANY_ID = "55555555-5555-4555-8555-555555555555";
const AGENT_ID = "66666666-6666-4666-8666-666666666666";

const SCOPE: CloudCodingCommandScope = {
	workerId: WORKER_ID,
	vmId: VM_ID,
	requestId: REQUEST_ID,
	turn: 1,
};

const IDENTITY: CloudNativeToolIdentity = {
	companyId: COMPANY_ID,
	environmentId: "77777777-7777-4777-8777-777777777777",
	runId: RUN_ID,
	jobId: "88888888-8888-4888-8888-888888888881",
	runnerId: "88888888-8888-4888-8888-888888888882",
	assignmentId: "88888888-8888-4888-8888-888888888883",
	leaseId: "88888888-8888-4888-8888-888888888884",
	computeIdentityId: "88888888-8888-4888-8888-888888888885",
	staffAgentId: AGENT_ID,
	staffVersion: 1,
	sessionId: null,
	requesterUserId: "88888888-8888-4888-8888-888888888886",
	sponsorUserId: null,
	sponsorBindingId: "88888888-8888-4888-8888-888888888887",
	sponsorVersion: 1,
	providerConnectionId: "88888888-8888-4888-8888-888888888888",
	providerConnectionVersion: 1,
	audienceKind: "company",
	audienceUserId: null,
	runtimeBundleId: "88888888-8888-4888-8888-888888888889",
	runtimeBundleSha256: "a".repeat(64),
	reasoningEffort: "medium",
	reasoningPolicySha256: "b".repeat(64),
	provider: "openai",
	nativeHarness: "codex-cli",
	model: "gpt-5.4",
};

function makeOperations(): Pick<CloudNativeToolOperations, "execute"> {
	return {
		execute: async (input) => {
			const receiptId = randomUUID();
			const inputSha256 = createHash("sha256").update(JSON.stringify(input.operation.arguments)).digest("hex");
			await input.authorize?.(input.operation, IDENTITY, input.signal);
			const result = await input.perform(input.operation, {
				identity: IDENTITY,
				receiptId,
				inputSha256,
				idempotencyKey: `${input.operation.logicalOperationKey}:${receiptId}`,
				signal: input.signal,
			});
			return result.content;
		},
	};
}

function makeFakeMachine(options?: {
	readonly hasFfmpeg?: boolean;
	readonly hasPlaywright?: boolean;
	readonly audioPayload?: Uint8Array;
	readonly extraTurnAfter?: number;
}) {
	const hasFfmpeg = options?.hasFfmpeg ?? true;
	const hasPlaywright = options?.hasPlaywright ?? true;
	const audioBytes =
		options?.audioPayload ?? new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
	const logs = new Map<string, { step: string; text: string; state: "running" | "succeeded" | "failed" }>();
	const commands: string[] = [];
	let peerId = "";
	let turns = 0;

	const emit = (value: Record<string, unknown>) => `${MARK}${JSON.stringify(value)}\n`;
	const receiptOf = (commandId: string, inputSha256: string, offset: number, limit: number) => {
		const log = logs.get(commandId);
		if (!log) throw new Error(`missing command ${commandId}`);
		const buf = Buffer.from(log.text, "utf8");
		const slice = buf.subarray(offset, offset + limit);
		return {
			schema: "qorpera.coding-command-result/v2" as const,
			workerId: WORKER_ID,
			commandId,
			inputSha256,
			state: log.state,
			exitCode: log.state === "succeeded" ? 0 : log.state === "failed" ? 1 : null,
			output: slice.toString("utf8"),
			truncated: offset + slice.length < buf.length,
			log: {
				offset,
				nextOffset: offset + slice.length,
				totalBytes: buf.length,
				limitBytes: 64 * 1024 * 1024,
				limitReached: false,
			},
		};
	};
	const shaByCmd = new Map<string, string>();
	const gateway: CloudCodingCommandGateway = {
		authorize: vi.fn(async () => undefined),
		start: vi.fn(async (_scope, input) => {
			commands.push(input.command);
			shaByCmd.set(input.commandId, input.inputSha256);
			let text = "";
			let state: "running" | "succeeded" | "failed" = "succeeded";
			if (input.command.includes("out = { ffmpeg: false")) {
				text = emit({ ffmpeg: hasFfmpeg, pw: hasPlaywright ? "playwright" : "" });
			} else if (input.command.includes("voice-peer.cjs") || input.command.includes("voice-cdp-peer.cjs")) {
				peerId = input.commandId;
				text = emit({ offer: "v=0 offer" });
				state = "running";
			} else if (input.command.includes("answer.sdp")) {
				const peer = logs.get(peerId);
				if (peer) peer.text += emit({ connected: true });
			} else if (input.command.includes("/stop")) {
				const peer = logs.get(peerId);
				if (peer) {
					peer.text += emit({ ended: "stop" });
					peer.state = "succeeded";
				}
			} else if (input.command.includes("voice-encode.cjs")) {
				const pairs = [...input.command.matchAll(/\b([1-9][0-9]*):([0-9a-f]{8})\b/g)];
				text = pairs.map((m) => emit({ clip: m[2]!, file: `${m[2]!}.mp4`, seconds: 2.35 })).join("");
			} else if (input.command.includes("voice-wav-encode.cjs")) {
				const pairs = [...input.command.matchAll(/\b([1-9][0-9]*):([0-9a-f]{8})\b/g)];
				text = pairs.map((m) => emit({ clip: m[2]!, file: `${m[2]!}.wav`, seconds: 2.15 })).join("");
			} else if (input.command.includes("QORPERA_CLIP:")) {
				const hash = createHash("sha256").update(audioBytes).digest("hex");
				text = `QORPERA_CLIP:${audioBytes.byteLength}:${hash}:\n${Buffer.from(audioBytes).toString("base64")}`;
			}
			logs.set(input.commandId, { step: input.command.slice(0, 32), text, state });
			return receiptOf(input.commandId, input.inputSha256, 0, 16_384);
		}),
		read: vi.fn(async (_scope, input) =>
			receiptOf(
				input.commandId,
				shaByCmd.get(input.commandId) ?? "c".repeat(64),
				Number(input.offset),
				Number(input.limit),
			),
		),
		cancel: vi.fn(async (_scope, commandId) => {
			const log = logs.get(commandId);
			if (log) log.state = "succeeded";
			return receiptOf(commandId, shaByCmd.get(commandId) ?? "c".repeat(64), 0, 0);
		}),
	};
	const recordTurn = () => {
		const peer = logs.get(peerId);
		if (!peer) return;
		turns += 1;
		peer.text += emit({ turn: turns, file: `${turns}.webm`, ms: 2350, bytes: 12000 });
		if (options?.extraTurnAfter === turns) {
			turns += 1;
			peer.text += emit({ turn: turns, file: `${turns}.webm`, ms: 1200, bytes: 6000 });
		}
	};
	const machine: StudioChatGptVoiceMachine = {
		scope: SCOPE,
		identity: IDENTITY,
		operations: makeOperations(),
		gateway,
	};
	return { machine, gateway, commands, recordTurn };
}

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("recordStudioChatGptVoiceClips", () => {
	it("runs voice-peer.cjs and voice-encode.cjs on the coding machine, verifies transcripts, and returns trimmed mp4 clips", async () => {
		const fake = makeFakeMachine();
		const A = "Dealers pay three thousand five hundred kroner on verified introductions.";
		const B = "Manual buyer sourcing breaks past seventy hours per month.";
		const captions = [
			{ hash: captionHash(A), text: A },
			{ hash: captionHash(B), text: B },
		];
		let calls = 0;
		const voice = {
			usage: vi.fn(async (): Promise<CloudVoiceUsage> => ({ windows: [{ usedPercent: 10 }] })),
			open: vi.fn(
				async (): Promise<CloudVoiceCall> => ({
					answerSdp: "v=0\r\ns=answer\r\n",
					speak: vi.fn(async (prompt) => {
						calls += 1;
						fake.recordTurn();
						if (calls === 1) return { transcript: "Totally unrelated filler text" };
						const match = /“(.+)”|"(.+)"/.exec(prompt);
						return { transcript: match?.[1] ?? match?.[2] ?? "" };
					}),
					close: vi.fn(async () => undefined),
				}),
			),
		};

		const result = await recordStudioChatGptVoiceClips({
			voice,
			machine: fake.machine,
			callId: "call-1",
			voiceName: "cove",
			captions,
			signal: new AbortController().signal,
			timing: { pollMs: 5 },
		});

		expect(result.stopReason).toBeNull();
		expect(result.clips).toHaveLength(2);
		expect(result.clips[0]!.mediaType).toBe("audio/mp4");
		expect(result.clips[0]!.fileExtension).toBe("mp4");
		expect(result.clips[0]!.seconds).toBe(2.35);
		expect(calls).toBe(3);
		expect(fake.commands.some((cmd) => cmd.includes("voice-peer.cjs"))).toBe(true);
		expect(fake.commands.some((cmd) => cmd.includes("voice-encode.cjs"))).toBe(true);
		expect(fake.commands.some((cmd) => cmd.includes("rm -rf /tmp/qorpera-studio-voice-"))).toBe(true);
	});

	it("stops and drops a tainted turn when the recorder hears an unsolicited voice turn", async () => {
		const fake = makeFakeMachine({ extraTurnAfter: 1 });
		const A = "First beat text.";
		const B = "Second beat text.";
		const voice = {
			usage: vi.fn(async (): Promise<CloudVoiceUsage> => ({ windows: [{ usedPercent: 10 }] })),
			open: vi.fn(
				async (): Promise<CloudVoiceCall> => ({
					answerSdp: "v=0\r\ns=answer\r\n",
					speak: vi.fn(async () => {
						fake.recordTurn();
						return { transcript: A };
					}),
					close: vi.fn(async () => undefined),
				}),
			),
		};

		const result = await recordStudioChatGptVoiceClips({
			voice,
			machine: fake.machine,
			callId: "call-unasked",
			captions: [
				{ hash: captionHash(A), text: A },
				{ hash: captionHash(B), text: B },
			],
			signal: new AbortController().signal,
			timing: { pollMs: 5 },
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("turn that was not asked for");
		expect(result.clips).toHaveLength(0);
	});

	it("returns limit_reached immediately when voice usage is full or open hits limit", async () => {
		const fake = makeFakeMachine();
		const fullResult = await recordStudioChatGptVoiceClips({
			voice: {
				usage: vi.fn(async () => ({ windows: [{ usedPercent: 100, resetAt: "2026-11-26T00:00:00Z" }] })),
				open: vi.fn(),
			},
			machine: fake.machine,
			callId: "call-full",
			captions: [{ hash: captionHash("Hello"), text: "Hello" }],
			signal: new AbortController().signal,
			timing: { pollMs: 5 },
		});
		expect(fullResult).toEqual({ clips: [], stopReason: "limit_reached" });
		expect(fake.commands).toHaveLength(0);

		const openLimit = await recordStudioChatGptVoiceClips({
			voice: {
				usage: vi.fn(async () => ({ windows: [{ usedPercent: 50 }] })),
				open: vi.fn(async () => {
					throw new CloudVoiceLimitReached();
				}),
			},
			machine: fake.machine,
			callId: "call-open-limit",
			captions: [{ hash: captionHash("Hello"), text: "Hello" }],
			signal: new AbortController().signal,
			timing: { pollMs: 5 },
		});
		expect(openLimit).toEqual({ clips: [], stopReason: "limit_reached" });
	});

	it("runs the real EXPLAINER_VOICE_PEER_CJS through voice-playwright-stub.cjs inside the simulated coding VM", async () => {
		const workSandbox = await mkdtemp(join(tmpdir(), "qorpera-voice-vm-test-"));
		tempDirs.push(workSandbox);
		const procs = new Map<
			string,
			{
				readonly sha: string;
				output: string;
				state: "running" | "succeeded" | "failed";
				exitCode: number | null;
				readonly child?: ReturnType<typeof spawn>;
			}
		>();
		const fakeMp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
		const gateway: CloudCodingCommandGateway = {
			authorize: async () => undefined,
			start: async (_scope, input) => {
				const rewritten = input.command.replaceAll("/tmp/qorpera-studio-voice", join(workSandbox, "voice"));
				if (rewritten.includes("out = { ffmpeg: false")) {
					const text = `${MARK}${JSON.stringify({ ffmpeg: true, pw: PLAYWRIGHT_STUB })}\n`;
					procs.set(input.commandId, { sha: input.inputSha256, output: text, state: "succeeded", exitCode: 0 });
					return {
						schema: "qorpera.coding-command-result/v2",
						workerId: WORKER_ID,
						commandId: input.commandId,
						inputSha256: input.inputSha256,
						state: "succeeded",
						exitCode: 0,
						output: text,
						truncated: false,
						log: {
							offset: 0,
							nextOffset: Buffer.byteLength(text),
							totalBytes: Buffer.byteLength(text),
							limitBytes: 64 * 1024 * 1024,
							limitReached: false,
						},
					};
				}
				if (rewritten.includes("voice-encode.cjs")) {
					const outDirMatch = /voice-encode\.cjs\s+\S+\s+(\S+)\s+(.+)$/m.exec(rewritten);
					const outDir = outDirMatch?.[1] ?? join(workSandbox, "out");
					const pairs = [...(outDirMatch?.[2] ?? "").matchAll(/\b([1-9][0-9]*):([0-9a-f]{8})\b/g)];
					const lines: string[] = [];
					await mkdir(outDir, { recursive: true });
					for (const pair of pairs) {
						const hash = pair[2]!;
						await writeFile(join(outDir, `${hash}.mp4`), fakeMp4);
						lines.push(`${MARK}${JSON.stringify({ clip: hash, file: `${hash}.mp4`, seconds: 1.8 })}\n`);
					}
					const text = lines.join("");
					procs.set(input.commandId, { sha: input.inputSha256, output: text, state: "succeeded", exitCode: 0 });
					return {
						schema: "qorpera.coding-command-result/v2",
						workerId: WORKER_ID,
						commandId: input.commandId,
						inputSha256: input.inputSha256,
						state: "succeeded",
						exitCode: 0,
						output: text,
						truncated: false,
						log: {
							offset: 0,
							nextOffset: Buffer.byteLength(text),
							totalBytes: Buffer.byteLength(text),
							limitBytes: 64 * 1024 * 1024,
							limitReached: false,
						},
					};
				}
				const child = spawn("bash", ["-lc", rewritten], {
					env: { ...process.env, QORPERA_PLAYWRIGHT: PLAYWRIGHT_STUB, QORPERA_VOICE_SCENARIO: "turn" },
					stdio: ["ignore", "pipe", "pipe"],
				});
				const entry = {
					sha: input.inputSha256,
					output: "",
					state: "running" as "running" | "succeeded" | "failed",
					exitCode: null as number | null,
					child,
				};
				procs.set(input.commandId, entry);
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					entry.output += chunk;
				});
				child.stderr.resume();
				child.on("close", (code) => {
					entry.exitCode = code ?? 1;
					entry.state = code === 0 ? "succeeded" : "failed";
				});
				return {
					schema: "qorpera.coding-command-result/v2",
					workerId: WORKER_ID,
					commandId: input.commandId,
					inputSha256: input.inputSha256,
					state: entry.state,
					exitCode: entry.exitCode,
					output: "",
					truncated: false,
					log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 64 * 1024 * 1024, limitReached: false },
				};
			},
			read: async (_scope, input) => {
				const entry = procs.get(input.commandId)!;
				const buf = Buffer.from(entry.output, "utf8");
				const offset = Number(input.offset);
				const limit = Number(input.limit);
				const slice = buf.subarray(offset, offset + limit);
				return {
					schema: "qorpera.coding-command-result/v2",
					workerId: WORKER_ID,
					commandId: input.commandId,
					inputSha256: entry.sha,
					state: entry.state,
					exitCode: entry.exitCode,
					output: slice.toString("utf8"),
					truncated: offset + slice.length < buf.length,
					log: {
						offset,
						nextOffset: offset + slice.length,
						totalBytes: buf.length,
						limitBytes: 64 * 1024 * 1024,
						limitReached: false,
					},
				};
			},
			cancel: async (_scope, commandId) => {
				const entry = procs.get(commandId);
				if (entry?.child && entry.state === "running") {
					entry.child.kill("SIGKILL");
					entry.state = "succeeded";
				}
				return {
					schema: "qorpera.coding-command-result/v2",
					workerId: WORKER_ID,
					commandId,
					inputSha256: entry?.sha ?? "c".repeat(64),
					state: "succeeded",
					exitCode: 0,
					output: "",
					truncated: false,
					log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 64 * 1024 * 1024, limitReached: false },
				};
			},
		};

		const line = "One clean beat recorded through the real peer script.";
		const result = await recordStudioChatGptVoiceClips({
			voice: {
				usage: async () => ({ windows: [{ usedPercent: 5 }] }),
				open: async ({ offerSdp }) => {
					expect(offerSdp).toContain("v=0 the offer");
					return {
						answerSdp: "v=0 the answer\n",
						speak: async () => ({ transcript: line }),
						close: async () => undefined,
					};
				},
			},
			machine: { scope: SCOPE, identity: IDENTITY, operations: makeOperations(), gateway },
			callId: "call-real-peer",
			captions: [{ hash: captionHash(line), text: line }],
			signal: new AbortController().signal,
			timing: { pollMs: 25 },
		});

		expect(result.stopReason).toBeNull();
		expect(result.clips).toHaveLength(1);
		expect(result.clips[0]!.hash).toBe(captionHash(line));
		expect(result.clips[0]!.mediaType).toBe("audio/mp4");
		expect(result.clips[0]!.audio).toEqual(fakeMp4);
	});

	it("uses the CDP peer and WAV encoder on stock coding machines without playwright or ffmpeg", async () => {
		const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
		const fake = makeFakeMachine({ hasFfmpeg: false, hasPlaywright: false, audioPayload: fakeWav });
		const line = "Stock coding machine records trimmed wav audio cleanly.";
		const voice = {
			usage: vi.fn(async (): Promise<CloudVoiceUsage> => ({ windows: [{ usedPercent: 15 }] })),
			open: vi.fn(
				async (): Promise<CloudVoiceCall> => ({
					answerSdp: "v=0\r\ns=answer\r\n",
					speak: vi.fn(async () => {
						fake.recordTurn();
						return { transcript: line };
					}),
					close: vi.fn(async () => undefined),
				}),
			),
		};

		const result = await recordStudioChatGptVoiceClips({
			voice,
			machine: fake.machine,
			callId: "call-cdp-wav",
			captions: [{ hash: captionHash(line), text: line }],
			signal: new AbortController().signal,
			timing: { pollMs: 5 },
		});

		expect(result.stopReason).toBeNull();
		expect(result.clips).toHaveLength(1);
		expect(result.clips[0]!.mediaType).toBe("audio/wav");
		expect(result.clips[0]!.fileExtension).toBe("wav");
		expect(result.clips[0]!.audio).toEqual(fakeWav);
		const peerCmd = fake.commands.find((cmd) => cmd.includes("voice-cdp-peer.cjs")) ?? "";
		expect(peerCmd).toContain("st.state === 'connected' && st.stream");
		expect(peerCmd).toContain("qorperaTurnAck");
		expect(peerCmd).toContain("proc.on('error'");
		const encCmd = fake.commands.find((cmd) => cmd.includes("voice-wav-encode.cjs")) ?? "";
		expect(encCmd).toContain("decodeAudioData");
		expect(encCmd).toContain("proc.on('error'");
	});
});

describe("prepareSurfaceCodingWorkspace vision/reading and machine-gated voice", () => {
	it("includes visionMarkdown and readingMarkdown in turnBrief and requires codingMachine for ChatGPT voice", async () => {
		const prepared = await prepareSurfaceCodingWorkspace({
			workspaceKind: "surface_folder",
			surfaceSession: {
				sessionId: "sess-1",
				surfaceSlug: "strategy",
				surfaceTitle: "Strategy",
				surfaceKind: "strategy",
				folderRoot: "surfaces/strategy",
				visionMarkdown: "# Brooks\nPre-market used car intake.",
				readingMarkdown: "Testing dealer fee play.",
				briefMarkdown: "Strategy war room.",
				fullPrompt: "Build the grand plan",
				stageSurfacePatch: vi.fn(async () => ({ changeId: "chg-1", seq: 1, openChangeCount: 1 })),
				narrateExplainer: {
					stageBytes: vi.fn(),
					voiceChannel: {
						usage: vi.fn(async () => ({ windows: [{ usedPercent: 10 }] })),
						open: vi.fn(),
					},
				},
				openScenesOps: [
					{
						op: "write_text",
						path: "surfaces/strategy/tour.json",
						content: JSON.stringify({
							title: "Walkthrough",
							beats: [{ id: "b1", say: "Start with the winning play." }],
						}),
					},
				],
			},
			isClaudeTurn: true,
			newDisk: false,
			signal: new AbortController().signal,
		});

		expect(prepared.turnBrief).toContain("Pre-market used car intake.");
		expect(prepared.turnBrief).toContain("Testing dealer fee play.");

		const toolsWithoutMachine = prepared.buildTools(IDENTITY, makeOperations() as CloudNativeToolOperations);
		const narrateNoMachine = toolsWithoutMachine.find((t) => t.name === "narrate_explainer")!;
		const res = await narrateNoMachine.execute(
			{ scenesPath: "tour.json" },
			{
				companyId: COMPANY_ID,
				runId: RUN_ID,
				callId: "c1",
				argumentSha256: "c".repeat(64),
				identity: IDENTITY,
				signal: new AbortController().signal,
			},
		);
		expect(res.kind).toBe("text");
		if (res.kind === "text") {
			const parsed = JSON.parse(res.value) as { ok: boolean; state: string };
			expect(parsed.ok).toBe(false);
			expect(parsed.state).toBe("unsupported_in_studio");
		}
	});
});
