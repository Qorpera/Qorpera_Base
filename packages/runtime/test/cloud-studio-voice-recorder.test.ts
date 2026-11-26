import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
					const outDirMatch = /node\s+\S+\/voice-encode\.cjs\s+\S+\s+(\S+)\s+(.+)$/m.exec(rewritten);
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

	it("runs the real CDP peer and WAV encoder scripts end-to-end against a stub chromium DevTools server", async () => {
		const workSandbox = await mkdtemp(join(tmpdir(), "qorpera-voice-cdp-test-"));
		tempDirs.push(workSandbox);
		const stubPath = join(workSandbox, "chromium-stub.cjs");
		const cdpStubSource = [
			`#!${process.execPath}`,
			'const crypto = require("node:crypto");',
			'const fs = require("node:fs");',
			'const http = require("node:http");',
			'const path = require("node:path");',
			'const scenario = process.env.QORPERA_CDP_SCENARIO || "happy";',
			'const tracePath = process.env.QORPERA_CDP_TRACE || "";',
			'const triggerPath = process.env.QORPERA_CDP_TRIGGER || "";',
			'const userDataArg = process.argv.find((a) => a.startsWith("--user-data-dir=")) || "";',
			'const userData = userDataArg.slice("--user-data-dir=".length);',
			"const workDir = userData ? path.dirname(userData) : process.cwd();",
			'const turnPayload = Buffer.from("cdp-webm-turn-1", "utf8");',
			"const log = (event) => { if (tracePath) fs.appendFileSync(tracePath, JSON.stringify(event) + '\\n'); };",
			"function sendFrame(socket, text) {",
			"  const data = Buffer.from(text, 'utf8');",
			"  let head;",
			"  if (data.length < 126) { head = Buffer.from([0x81, data.length]); }",
			"  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }",
			"  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }",
			"  socket.write(Buffer.concat([head, data]));",
			"}",
			"let port = 0;",
			"const server = http.createServer((req, res) => {",
			"  if (req.url === '/json/list') {",
			"    res.writeHead(200, { 'content-type': 'application/json' });",
			"    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/1' }]));",
			"    return;",
			"  }",
			"  res.writeHead(404); res.end();",
			"});",
			"server.on('upgrade', (req, socket) => {",
			"  const key = req.headers['sec-websocket-key'] || '';",
			"  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');",
			"  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');",
			"  let buf = Buffer.alloc(0);",
			"  let connected = false;",
			"  let turnSent = false;",
			"  let ackWaiter = null;",
			"  const emitTurn = () => {",
			"    if (turnSent) return;",
			"    turnSent = true;",
			"    sendFrame(socket, JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: 'qorperaTurn', payload: JSON.stringify({ seq: 1, ms: 420, b64: turnPayload.toString('base64') }) } }));",
			"  };",
			"  const handle = (msg) => {",
			"    const reply = (value) => sendFrame(socket, JSON.stringify({ id: msg.id, result: { result: { value } } }));",
			"    if (msg.method === 'Runtime.enable' || msg.method === 'Runtime.addBinding') { sendFrame(socket, JSON.stringify({ id: msg.id, result: {} })); return; }",
			"    if (msg.method !== 'Runtime.evaluate') { sendFrame(socket, JSON.stringify({ id: msg.id, result: {} })); return; }",
			"    const expr = String((msg.params && msg.params.expression) || '');",
			"    if (expr.includes('createOffer')) { reply('v=0\\r\\ns=cdp-offer\\r\\n'); return; }",
			"    if (expr.includes('setRemoteDescription')) {",
			"      connected = true;",
			"      log({ kind: 'remote' });",
			"      reply(null);",
			"      if (scenario === 'happy') {",
			"        const waitTrigger = () => {",
			"          if (!triggerPath || fs.existsSync(triggerPath)) emitTurn();",
			"          else setTimeout(waitTrigger, 15);",
			"        };",
			"        setTimeout(waitTrigger, 15);",
			"      }",
			"      return;",
			"    }",
			"    if (expr.includes('pc.connectionState')) { reply({ state: connected ? 'connected' : 'connecting', stream: connected, closed: false }); return; }",
			"    if (expr.includes('window.qorperaCall.failed')) {",
			"      if (scenario === 'socket-close') { log({ kind: 'closing-socket' }); socket.destroy(); return; }",
			"      reply({ closed: false, failed: null }); return;",
			"    }",
			"    if (expr.includes('window.qorperaTurnAck')) {",
			"      const diskPath = path.join(workDir, '1.webm');",
			"      const existsAtAck = fs.existsSync(diskPath);",
			"      const bytesMatch = existsAtAck && fs.readFileSync(diskPath).equals(turnPayload);",
			"      log({ kind: 'ack', existsAtAck, bytesMatch });",
			"      reply(1);",
			"      if (ackWaiter) { const w = ackWaiter; ackWaiter = null; w(); }",
			"      return;",
			"    }",
			"    if (expr.includes('window.qorperaCall.settle')) {",
			"      log({ kind: 'settle-start' });",
			"      if (scenario === 'stop-during-finish' && !turnSent) {",
			"        ackWaiter = () => { log({ kind: 'settle-after-ack' }); reply({ busy: false, failed: null }); };",
			"        emitTurn();",
			"        return;",
			"      }",
			"      reply({ busy: false, failed: null }); return;",
			"    }",
			"    if (expr.includes('decodeAudioData')) {",
			"      const floats = new Float32Array(7200);",
			"      for (let i = 0; i < floats.length; i++) floats[i] = Math.sin((2 * Math.PI * 440 * i) / 24000) * 0.25;",
			"      const b64 = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');",
			"      log({ kind: 'decode' });",
			"      reply({ rate: 24000, b64, seconds: floats.length / 24000 });",
			"      return;",
			"    }",
			"    reply(null);",
			"  };",
			"  socket.on('data', (chunk) => {",
			"    buf = Buffer.concat([buf, chunk]);",
			"    while (buf.length >= 2) {",
			"      const opcode = buf[0] & 0x0f;",
			"      const masked = (buf[1] & 0x80) !== 0;",
			"      let len = buf[1] & 0x7f;",
			"      let off = 2;",
			"      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }",
			"      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }",
			"      const need = off + (masked ? 4 : 0) + len;",
			"      if (buf.length < need) return;",
			"      const payload = Buffer.alloc(len);",
			"      if (masked) {",
			"        const mask = buf.subarray(off, off + 4);",
			"        const src = buf.subarray(off + 4, need);",
			"        for (let i = 0; i < len; i++) payload[i] = src[i] ^ mask[i & 3];",
			"      } else {",
			"        buf.copy(payload, 0, off, need);",
			"      }",
			"      buf = buf.subarray(need);",
			"      if (opcode === 0x8) { socket.end(); return; }",
			"      if (opcode === 0x1) handle(JSON.parse(payload.toString('utf8')));",
			"    }",
			"  });",
			"});",
			"server.listen(0, '127.0.0.1', () => {",
			"  port = server.address().port;",
			"  process.stderr.write('DevTools listening on ws://127.0.0.1:' + port + '/devtools/browser/stub\\n');",
			"});",
		].join("\n");
		await writeFile(stubPath, cdpStubSource, "utf8");
		await chmod(stubPath, 0o755);

		const makeVmGateway = (envOverrides: Record<string, string>): CloudCodingCommandGateway => {
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
			return {
				authorize: async () => undefined,
				start: async (_scope, input) => {
					const rewritten = input.command.replaceAll("/tmp/qorpera-studio-voice", join(workSandbox, "cdp"));
					if (rewritten.includes("out = { ffmpeg: false")) {
						const text = `${MARK}${JSON.stringify({ ffmpeg: false, pw: "" })}\n`;
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
						env: { ...process.env, ...envOverrides },
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
		};

		const happyTrace = join(workSandbox, "trace-happy.jsonl");
		const happyTrigger = join(workSandbox, "trigger-happy");
		const line = "Stock coding machine records trimmed wav audio cleanly.";
		const happy = await recordStudioChatGptVoiceClips({
			voice: {
				usage: async () => ({ windows: [{ usedPercent: 10 }] }),
				open: async ({ offerSdp }) => {
					expect(offerSdp).toContain("s=cdp-offer");
					return {
						answerSdp: "v=0\r\ns=cdp-answer\r\n",
						speak: async () => {
							await writeFile(happyTrigger, "go", "utf8");
							return { transcript: line };
						},
						close: async () => undefined,
					};
				},
			},
			machine: {
				scope: SCOPE,
				identity: IDENTITY,
				operations: makeOperations(),
				gateway: makeVmGateway({
					QORPERA_VOICE_CHROMIUM: stubPath,
					QORPERA_CDP_SCENARIO: "happy",
					QORPERA_CDP_TRACE: happyTrace,
					QORPERA_CDP_TRIGGER: happyTrigger,
				}),
			},
			callId: "call-cdp-happy",
			captions: [{ hash: captionHash(line), text: line }],
			signal: new AbortController().signal,
			timing: { pollMs: 25 },
		});

		expect({ stopReason: happy.stopReason, errorMessage: happy.errorMessage }).toEqual({
			stopReason: null,
			errorMessage: undefined,
		});
		expect(happy.clips).toHaveLength(1);
		expect(happy.clips[0]!.hash).toBe(captionHash(line));
		expect(happy.clips[0]!.mediaType).toBe("audio/wav");
		expect(happy.clips[0]!.fileExtension).toBe("wav");
		expect(happy.clips[0]!.seconds).toBe(0.3);
		const wav = happy.clips[0]!.audio;
		expect(Buffer.from(wav.subarray(0, 4)).toString("ascii")).toBe("RIFF");
		expect(Buffer.from(wav.subarray(8, 12)).toString("ascii")).toBe("WAVE");
		expect(wav.byteLength).toBe(44 + 7200 * 2);
		const happyEvents = (await readFile(happyTrace, "utf8"))
			.trim()
			.split("\n")
			.map((row) => JSON.parse(row) as Record<string, unknown>);
		expect(happyEvents).toContainEqual({ kind: "ack", existsAtAck: true, bytesMatch: true });
		expect(happyEvents).toContainEqual({ kind: "decode" });

		const stopTrace = join(workSandbox, "trace-stop.jsonl");
		const stopResult = await recordStudioChatGptVoiceClips({
			voice: {
				usage: async () => ({ windows: [{ usedPercent: 10 }] }),
				open: async () => ({
					answerSdp: "v=0\r\ns=cdp-answer\r\n",
					speak: async () => {
						throw new Error("call dropped while turn finishing");
					},
					close: async () => undefined,
				}),
			},
			machine: {
				scope: SCOPE,
				identity: IDENTITY,
				operations: makeOperations(),
				gateway: makeVmGateway({
					QORPERA_VOICE_CHROMIUM: stubPath,
					QORPERA_CDP_SCENARIO: "stop-during-finish",
					QORPERA_CDP_TRACE: stopTrace,
				}),
			},
			callId: "call-cdp-stop-finish",
			captions: [{ hash: captionHash(line), text: line }],
			signal: new AbortController().signal,
			timing: { pollMs: 25 },
		});
		expect(stopResult.stopReason).toBe("error");
		const stopEvents = (await readFile(stopTrace, "utf8"))
			.trim()
			.split("\n")
			.map((row) => JSON.parse(row) as Record<string, unknown>);
		expect(stopEvents).toContainEqual({ kind: "ack", existsAtAck: true, bytesMatch: true });
		expect(stopEvents).toContainEqual({ kind: "settle-after-ack" });

		const spawnMissing = await recordStudioChatGptVoiceClips({
			voice: {
				usage: async () => ({ windows: [{ usedPercent: 10 }] }),
				open: vi.fn(),
			},
			machine: {
				scope: SCOPE,
				identity: IDENTITY,
				operations: makeOperations(),
				gateway: makeVmGateway({
					QORPERA_VOICE_CHROMIUM: join(workSandbox, "does-not-exist-chromium"),
				}),
			},
			callId: "call-cdp-spawn-err",
			captions: [{ hash: captionHash(line), text: line }],
			signal: new AbortController().signal,
			timing: { pollMs: 25 },
		});
		expect(spawnMissing.stopReason).toBe("error");
		expect(spawnMissing.errorMessage).toContain("ENOENT");

		const socketCloseTrace = join(workSandbox, "trace-close.jsonl");
		const socketClosed = await recordStudioChatGptVoiceClips({
			voice: {
				usage: async () => ({ windows: [{ usedPercent: 10 }] }),
				open: async () => ({
					answerSdp: "v=0\r\ns=cdp-answer\r\n",
					speak: async () => ({ transcript: line }),
					close: async () => undefined,
				}),
			},
			machine: {
				scope: SCOPE,
				identity: IDENTITY,
				operations: makeOperations(),
				gateway: makeVmGateway({
					QORPERA_VOICE_CHROMIUM: stubPath,
					QORPERA_CDP_SCENARIO: "socket-close",
					QORPERA_CDP_TRACE: socketCloseTrace,
				}),
			},
			callId: "call-cdp-socket-close",
			captions: [{ hash: captionHash(line), text: line }],
			signal: new AbortController().signal,
			timing: { pollMs: 25 },
		});
		expect(socketClosed.stopReason).toBe("error");
		expect(socketClosed.errorMessage).toBe("the recorder ended");
		const closeEvents = (await readFile(socketCloseTrace, "utf8"))
			.trim()
			.split("\n")
			.map((row) => JSON.parse(row) as Record<string, unknown>);
		expect(closeEvents).toContainEqual({ kind: "closing-socket" });
	});
});

describe("prepareSurfaceCodingWorkspace interfaces, search/data tools, and machine-gated voice", () => {
	it("includes live Company Interfaces in turnBrief, wires search/read-only data tools, and requires codingMachine for ChatGPT voice", async () => {
		const fakeFolder = {
			read: vi.fn(),
			readText: vi.fn(),
			list: vi.fn(),
			commit: vi.fn(),
			release: vi.fn(),
		} as unknown as Parameters<typeof prepareSurfaceCodingWorkspace>[0]["folder"];
		const fakeSearch = {
			search: vi.fn(),
			close: vi.fn(),
		} as unknown as Parameters<typeof prepareSurfaceCodingWorkspace>[0]["folderSearch"];
		const fakeData = {
			describe: vi.fn(),
			query: vi.fn(),
			change: vi.fn(),
			apply: vi.fn(),
		} as unknown as Parameters<typeof prepareSurfaceCodingWorkspace>[0]["companyData"];

		const prepared = await prepareSurfaceCodingWorkspace({
			workspaceKind: "surface_folder",
			folder: fakeFolder,
			folderSearch: fakeSearch,
			companyData: fakeData,
			surfaceSession: {
				sessionId: "sess-1",
				surfaceSlug: "strategy",
				surfaceTitle: "Strategy",
				surfaceKind: "strategy",
				folderRoot: "surfaces/strategy",
				companyInterfaces: {
					interfaces: [
						{
							slug: "strategy",
							title: "Strategy",
							kind: "strategy",
							archetype: "studio",
							sourceKind: "folder",
							folderRoot: "surfaces/strategy",
							repositoryKey: null,
							briefSummary: "Grand plan and unit math",
							isGlobal: false,
						},
						{
							slug: "website",
							title: "Website",
							kind: "website",
							archetype: "live_build",
							sourceKind: "code_repo",
							folderRoot: null,
							repositoryKey: "surfaces/website",
							briefSummary: "Public site",
							isGlobal: false,
						},
					],
					strategySummary: "Testing dealer fee play.",
					identitySummary: "# Brooks\nPre-market used car intake.",
				},
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

		expect(prepared.turnBrief).toContain("## Company Interfaces");
		expect(prepared.turnBrief).toContain("Cross-company tools:");
		expect(prepared.turnBrief).toContain("`company_search`");
		expect(prepared.turnBrief).toContain("`data_describe` and `data_query`");
		expect(prepared.turnBrief).toContain("/company/surfaces/strategy");
		expect(prepared.turnBrief).toContain("/company/code/surfaces/website");
		expect(prepared.turnBrief).toContain("Pre-market used car intake.");
		expect(prepared.turnBrief).toContain("Testing dealer fee play.");

		const toolsWithoutMachine = prepared.buildTools(IDENTITY, makeOperations() as CloudNativeToolOperations);
		const toolNames = toolsWithoutMachine.map((t) => t.name);
		expect(toolNames).toContain("company_search");
		expect(toolNames).toContain("data_describe");
		expect(toolNames).toContain("data_query");
		expect(toolNames).not.toContain("data_apply");
		expect(toolNames).not.toContain("data_change");
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
