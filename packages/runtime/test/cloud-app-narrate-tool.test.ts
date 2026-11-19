import { randomUUID } from "node:crypto";
import { type AppManifest, writeAppManifest } from "@qorpera/cloud-client/interface-apps";
import type { JsonValue } from "@qorpera/contracts";
import { captionHash, EXPLAINER_ENGINE_JS, explainerPage } from "@qorpera/runtime/cloud-app-kit-explainer";
import {
	CLOUD_NARRATE_APP_DESCRIPTION,
	cloudNarrateAppTool,
	narrateSpokenLine,
} from "@qorpera/runtime/cloud-app-narrate-tool";
import type { CloudMachineCommandGateway } from "@qorpera/runtime/cloud-machine-command-http";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { type CloudToolContext, CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import type { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import {
	type CloudVoiceCall,
	CloudVoiceLimitReached,
	CloudVoiceUnavailable,
	type CloudVoiceUsage,
} from "@qorpera/runtime/cloud-voice-channel";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const MACHINE_ID = "6a1f0000-0000-4000-8000-000000000001";
const MARK = "QORPERA-VOICE ";
const ANSWER = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=answer";
const A = "The shop pays Ada 149 kroner.";
const B = "Ada keeps what is left.";
const C = "Then the month starts again.";
type Step = "captions" | "peer" | "answer" | "stop" | "encode" | "clean";

interface Machine {
	machines?: { name: string; state: string }[];
	captions?: string[];
	captionsLine?: Record<string, unknown>;
	company?: { company: "mounted" | "pending" | "none"; why?: string };
	say?: (caption: string, asked: number) => string;
	unavailable?: true;
	limitAtOpen?: true;
	lateTurnOn?: string;
	extraTurnAfter?: string;
	limitOn?: string;
	failOn?: string;
	usage?: (read: number) => CloudVoiceUsage | undefined;
	hidden?: string[];
	speakMs?: number;
	abortOn?: string;
	files?: Record<string, string | Uint8Array>;
	manifest?: Partial<AppManifest>;
}

async function fixture(options: Machine = {}) {
	const f = await folderWriterFixture();
	runs.push(f.run);
	const manifest: AppManifest = {
		name: "Pricing",
		about: null,
		emblem: "page",
		colour: null,
		entry: "index.html",
		owner: f.identity.staffAgentId.toLowerCase(),
		posted: false,
		reads: [],
		writes: [],
		concept: false,
		cover: null,
		kit: "explainer",
		...options.manifest,
	};
	f.seed("apps/pricing/app.toml", writeAppManifest(manifest), "application/toml");
	f.seed("apps/pricing/index.html", explainerPage("Pricing", []), "text/html");
	f.seed("apps/pricing/engine.js", EXPLAINER_ENGINE_JS, "text/javascript");
	f.seed("apps/pricing/scenes.js", 'V.scene((s) => { s.say("x"); });', "text/javascript");
	for (const [path, content] of Object.entries(options.files ?? {}))
		f.seed(`apps/pricing/${path}`, content, path.endsWith(".json") ? "application/json" : "audio/mp4");

	const captions = options.captions ?? [A, B];
	const logs = new Map<string, { step: Step; text: string; state: "running" | "succeeded" | "failed" }>();
	const commands: { step: Step; command: string; timeoutMs: number | null }[] = [];
	let peerId = "";
	let withheld = "";
	let stalling = false;
	let answerFile: string | null = null;
	let turns = 0;
	const stepOf = (command: string): Step =>
		command.includes("voice-captions.cjs")
			? "captions"
			: command.includes("voice-peer.cjs")
				? "peer"
				: command.includes("voice-encode.cjs")
					? "encode"
					: command.includes("answer.sdp")
						? "answer"
						: command.includes("/stop")
							? "stop"
							: "clean";
	const line = (value: Record<string, unknown>) => `${MARK}${JSON.stringify(value)}\n`;
	const peer = () => logs.get(peerId) as { text: string; state: "running" | "succeeded" | "failed" };
	const receipt = (commandId: string, offset: number, limit: number) => {
		const log = logs.get(commandId);
		if (!log) throw new Error("no such command");
		const bytes = Buffer.from(log.text);
		const slice = bytes.subarray(offset, offset + limit);
		const company =
			log.step === "captions"
				? (options.company ?? { company: "mounted" as const })
				: { company: "mounted" as const };
		return {
			schema: "qorpera.machine-command-result/v1" as const,
			machineId: MACHINE_ID,
			commandId,
			inputSha256: "c".repeat(64),
			state: log.state,
			exitCode: log.state === "succeeded" ? 0 : log.state === "failed" ? 1 : null,
			output: slice.toString(),
			truncated: offset + slice.length < bytes.length,
			log: {
				offset,
				nextOffset: offset + slice.length,
				totalBytes: bytes.length,
				limitBytes: 64 * 1024 * 1024,
				limitReached: false,
			},
			companyFolder: company,
		};
	};
	const gateway = {
		start: vi.fn<CloudMachineCommandGateway["start"]>(async (_scope, input) => {
			const step = stepOf(input.command);
			commands.push({ step, command: input.command, timeoutMs: input.timeoutMs });
			let text = "";
			let state: "running" | "succeeded" | "failed" = "succeeded";
			if (step === "captions")
				text = line(
					options.captionsLine ?? { captions: captions.map((caption) => ({ text: caption, hash: "x" })) },
				);
			else if (step === "peer") {
				peerId = input.commandId;
				text = line({ offer: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=offer" });
				state = "running";
			} else if (step === "answer") {
				const coded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(input.command)?.[1] ?? "";
				answerFile = Buffer.from(coded, "base64").toString("utf8");
				peer().text += line({ connected: true });
			} else if (step === "stop") {
				stalling = false;
				peer().text += withheld + line({ ended: "stop" });
				peer().state = "succeeded";
			} else if (step === "encode") {
				for (const [, turn, hash] of input.command.matchAll(/ (\d+):([0-9a-f]{8})/g)) {
					text += line({ clip: hash, file: `${hash}.mp4`, seconds: 2 + Number(turn) / 10 });
					if (!options.hidden?.includes(hash as string))
						f.seed(`apps/pricing/voice/${hash}.mp4`, new Uint8Array([1, 2, 3]), "audio/mp4");
				}
			}
			logs.set(input.commandId, { step, text, state });
			return receipt(input.commandId, 0, 0);
		}),
		read: vi.fn<CloudMachineCommandGateway["read"]>(async (_scope, input) => {
			if (stalling) skew += 6000;
			return receipt(input.commandId, input.offset ?? 0, input.limit ?? 4096);
		}),
		cancel: vi.fn<CloudMachineCommandGateway["cancel"]>(async (_scope, commandId) => {
			const log = logs.get(commandId);
			if (log) log.state = "failed";
			return receipt(commandId, 0, 0);
		}),
	};
	const execute = vi.fn<CloudNativeToolOperations["execute"]>(async ({ operation, authorize, perform, signal }) => {
		signal.throwIfAborted();
		await authorize(operation, f.identity, signal);
		return (
			await perform(operation, {
				identity: f.identity,
				receiptId: randomUUID(),
				inputSha256: "c".repeat(64),
				idempotencyKey: "k",
				signal,
			})
		).content;
	});
	const control = {
		call: vi.fn(async (method: string) => {
			if (method !== "qorpera_native_machine_manage") throw new Error(`unexpected ${method}`);
			return {
				schema: "qorpera.machine-list/v1",
				machines: (options.machines ?? [{ name: "studio", state: "running" }]).map((machine) => ({
					...machine,
					machineId: machine.name === "studio" ? MACHINE_ID : randomUUID(),
				})),
			};
		}),
	};
	let skew = 0;
	const abort = new AbortController();
	const asked = new Map<string, number>();
	const spoken: string[] = [];
	const call: CloudVoiceCall = {
		answerSdp: ANSWER,
		speak: vi.fn(async (text: string) => {
			spoken.push(text);
			const caption = /"(.*)"$/s.exec(text)?.[1] ?? "";
			if (caption === options.limitOn) throw new CloudVoiceLimitReached();
			if (caption === options.failOn) throw new Error("Native voice call failed");
			if (caption === options.abortOn) {
				abort.abort(new Error("stopped"));
				throw new Error("aborted");
			}
			asked.set(caption, (asked.get(caption) ?? 0) + 1);
			turns += 1;
			const turn = line({ turn: turns, file: `${turns}.webm`, ms: 2100, bytes: 9000 });
			if (caption === options.lateTurnOn) {
				withheld = turn;
				stalling = true;
			} else peer().text += turn;
			if (caption === options.extraTurnAfter) {
				turns += 1;
				peer().text += line({ turn: turns, file: `${turns}.webm`, ms: 900, bytes: 4000 });
			}
			skew += options.speakMs ?? 1000;
			return { transcript: options.say?.(caption, asked.get(caption) as number) ?? caption };
		}),
		close: vi.fn(async () => {}),
	};
	let usageReads = 0;
	const voice = {
		open: vi.fn(async () => {
			if (options.unavailable) throw new CloudVoiceUnavailable();
			if (options.limitAtOpen) throw new CloudVoiceLimitReached();
			return call;
		}),
		usage: vi.fn(async () => options.usage?.(usageReads++)),
	};
	const tool = cloudNarrateAppTool({
		binding: f.binding,
		identity: f.identity,
		control,
		folder: f.folder,
		operations: f.operations(),
		machines: { gateway, operations: { execute } },
		voice,
		timing: { now: () => Date.now() + skew, pollMs: 1, settleMs: 1 },
	});
	const context: CloudToolContext = { ...f.context, signal: abort.signal };
	const narrate = async (value: Record<string, JsonValue> = {}) =>
		JSON.parse(
			String(
				(
					await tool.execute(
						tool.parseArguments({ name: "pricing", operationKey: "voice-1", machine: "studio", ...value }),
						context,
					)
				).value,
			),
		);
	const steps = () => commands.map((command) => command.step);
	const committed = (path: string) => f.text(`apps/pricing/${path}`);
	return {
		...f,
		context,
		tool,
		narrate,
		steps,
		commands,
		gateway,
		execute,
		call,
		voice,
		spoken,
		committed,
		answerFile: () => answerFile,
	};
}

async function refuses(promise: Promise<unknown>, text: string) {
	const error = await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(text);
}

const clip = (caption: string) => `${captionHash(caption)}.mp4`;

it("says what it does within the bytes a tool's description may hold", async () => {
	const f = await fixture();
	expect(Buffer.byteLength(f.tool.description)).toBeLessThanOrEqual(3600);
	expect(f.tool.description.split("\n")).toHaveLength(7);
	expect(f.tool.description).toBe(CLOUD_NARRATE_APP_DESCRIPTION);
	for (const said of [
		"It needs a running company machine whose commands see the company folder at /company",
		"counts against that login's usage limit, so the call reads the limit first and records only captions that have no clip yet",
		"One call speaks one batch",
		"its answer says how many captions are spoken and how many are left",
		"State limit_reached means the login is at its usage limit: what was recorded is saved",
		"A video in two languages",
		"is left silent and named in silent with what the voice said instead",
		"Write captions for the ear",
		"after you change one part of a video only the captions you changed are recorded again",
		"the video still plays with its captions",
	])
		expect(f.tool.description).toContain(said);
	expect(f.tool.name).toBe("narrate_app");
	expect(() => f.tool.parseArguments({ name: "pricing", operationKey: "k", machine: "studio", voice: "x" })).toThrow(
		"voice must be one of",
	);
	expect(f.tool.parseArguments({ name: "pricing", operationKey: "k", machine: "studio" })).toEqual({
		name: "pricing",
		operationKey: "k",
		machine: "studio",
		voice: "cove",
	});
	expect(f.tool.parseArguments({ name: "pricing", operationKey: "k" })).toEqual({
		name: "pricing",
		operationKey: "k",
		voice: "cove",
	});
	expect(() => f.tool.parseArguments({ name: "pricing", operationKey: "k", machine: "Studio!" })).toThrow(
		"machine must be the name of a running company machine",
	);
});

it("hands the voice a caption's own double quotes as curly ones, so the order's quotes stay the outer ones", () => {
	expect(narrateSpokenLine('She said "yes" and "no".')).toBe(
		'Speak exactly this line and nothing else: "She said “yes” and “no”."',
	);
	expect(narrateSpokenLine(A)).toBe(`Speak exactly this line and nothing else: "${A}"`);
});

it("refuses an app that is not an explainer, or not its own, before anything runs on a machine", async () => {
	const page = await fixture({ manifest: { kit: null } });
	await refuses(page.narrate(), "APP_NOT_AN_EXPLAINER");
	const foreign = await fixture({ manifest: { owner: "0b1c2d3e-4444-4444-8444-444444444445" } });
	await refuses(foreign.narrate(), "APP_NOT_YOURS");
	const missing = await fixture();
	await refuses(missing.narrate({ name: "nothing-here" }), "APP_NOT_FOUND");
	expect([...page.commands, ...foreign.commands, ...missing.commands]).toEqual([]);
});

it("refuses a machine that is not there or not running, and says to start one with machine_start", async () => {
	const none = await fixture({ machines: [] });
	await refuses(
		none.narrate(),
		"MACHINE_NOT_FOUND: the company has no machine named studio; start one with machine_start",
	);
	const asleep = await fixture({ machines: [{ name: "studio", state: "stopped" }] });
	await refuses(asleep.narrate(), "MACHINE_NOT_RUNNING: studio is stopped; wake it with machine_start");
	expect([...none.commands, ...asleep.commands]).toEqual([]);
});

it("refuses a machine without /company on its boot, with why, and cleans its work folder", async () => {
	const f = await fixture({
		company: { company: "none", why: "the agent that started it does not read the whole folder" },
	});
	await refuses(
		f.narrate(),
		"NARRATE_NO_COMPANY_FOLDER: studio has no /company on this boot (the agent that started it does not read the whole folder)",
	);
	expect(f.steps()).toEqual(["captions", "clean"]);
	expect(f.commands[1]?.command).toMatch(/^rm -rf -- \/root\/\.qorpera-narrate\/[0-9a-f]{24}$/);
});

it("refuses a video whose page says it is broken, with the page's words, and one with no caption", async () => {
	const broken = await fixture({ captionsLine: { problem: "scenes.js, line 3: s.sya is not a function" } });
	await refuses(
		broken.narrate(),
		"APP_VIDEO_PROBLEM: the video's page says: scenes.js, line 3: s.sya is not a function.",
	);
	const empty = await fixture({ captions: [] });
	await refuses(empty.narrate(), "APP_NO_CAPTIONS");
	expect(broken.voice.open).not.toHaveBeenCalled();
	expect(empty.voice.open).not.toHaveBeenCalled();
});

it("answers at once when every caption has its clip, and starts no call", async () => {
	const clips = [A, B].map((caption) => ({ caption: captionHash(caption), file: clip(caption), seconds: 2.5 }));
	const f = await fixture({
		files: {
			"voice/clips.json": JSON.stringify({ clips }),
			[`voice/${clip(A)}`]: new Uint8Array([1]),
			[`voice/${clip(B)}`]: new Uint8Array([1]),
		},
	});
	expect(await f.narrate()).toMatchObject({
		schema: "qorpera.app-narrate/v1",
		state: "spoken",
		captions: 2,
		spokenNow: 0,
		spokenBefore: 2,
		left: 0,
		link: "app:pricing",
	});
	expect(f.steps()).toEqual(["captions", "clean"]);
	expect(f.voice.open).not.toHaveBeenCalled();
	expect(f.commits).toEqual([]);
});

it("speaks two captions, makes their clips and commits the list and the page under its receipt", async () => {
	const f = await fixture();
	const answer = await f.narrate();
	expect(f.steps()).toEqual(["captions", "peer", "answer", "stop", "encode", "clean"]);
	const work = /\/root\/\.qorpera-narrate\/[0-9a-f]{24}/.exec(f.commands[0]?.command ?? "")?.[0] as string;
	expect(f.commands[0]?.command).toContain(`node ${work}/voice-captions.cjs /company/apps/pricing/index.html\n`);
	expect(f.commands[1]?.command).toContain(`exec node ${work}/voice-peer.cjs ${work} `);
	expect(f.commands.every((command) => Buffer.byteLength(command.command) <= 16384)).toBe(true);
	expect(f.commands[2]?.command).toContain(
		`> ${work}/answer.sdp.part && mv -f ${work}/answer.sdp.part ${work}/answer.sdp`,
	);
	expect(f.answerFile()).toBe(`${ANSWER}\n`);
	expect(f.spoken).toEqual([narrateSpokenLine(A), narrateSpokenLine(B)]);
	expect(f.commands[3]?.command).toBe(`touch ${work}/stop`);
	expect(f.commands[4]?.command).toContain(
		`node ${work}/voice-encode.cjs ${work} /company/apps/pricing/voice 1:${captionHash(A)} 2:${captionHash(B)}\n`,
	);
	expect(f.call.close).toHaveBeenCalledTimes(1);
	expect(f.execute.mock.calls.map(([options]) => options.operation.tool)).toEqual(Array(6).fill("machine_run"));
	const clips = [
		{ caption: captionHash(A), file: clip(A), seconds: 2.1 },
		{ caption: captionHash(B), file: clip(B), seconds: 2.2 },
	];
	expect(JSON.parse(f.committed("voice/clips.json") as string)).toEqual({ voice: "cove", clips });
	expect(f.committed("index.html")).toBe(explainerPage("Pricing", clips));
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]?.receiptId).toBe(answer.receiptId);
	expect(answer).toMatchObject({
		schema: "qorpera.app-narrate/v1",
		state: "spoken",
		app: "pricing",
		voice: "cove",
		captions: 2,
		spokenNow: 2,
		spokenBefore: 0,
		left: 0,
		link: "app:pricing",
	});
	expect(answer).not.toHaveProperty("silent");
	expect(answer.next).toContain("[Pricing](app:pricing)");
});

it("keeps a caption the voice said as written on its third try, and the right turn of it", async () => {
	const f = await fixture({
		say: (caption, asked) => (caption === A && asked < 3 ? "Hello! The shop pays." : caption),
	});
	const answer = await f.narrate();
	expect(f.spoken).toEqual([narrateSpokenLine(A), narrateSpokenLine(A), narrateSpokenLine(A), narrateSpokenLine(B)]);
	expect(f.commands.find((command) => command.step === "encode")?.command).toContain(
		` 3:${captionHash(A)} 4:${captionHash(B)}\n`,
	);
	expect(answer).toMatchObject({ state: "spoken", spokenNow: 2, left: 0 });
});

it("leaves a caption silent after three tries and names it with what the voice said", async () => {
	const f = await fixture({
		say: (caption) => (caption === B ? `Sure! ${"Ada keeps it all. ".repeat(20)}` : caption),
	});
	const answer = await f.narrate();
	expect(f.spoken.filter((line) => line === narrateSpokenLine(B))).toHaveLength(3);
	expect(answer).toMatchObject({ state: "partly_spoken", captions: 2, spokenNow: 1, spokenBefore: 0, left: 1 });
	expect(answer.silent).toHaveLength(1);
	expect(answer.silent[0].caption).toBe(B);
	expect(answer.silent[0].said.startsWith("Sure! Ada keeps it all.")).toBe(true);
	expect([...answer.silent[0].said].length).toBeLessThanOrEqual(200);
	expect(answer.next).toContain("call narrate_app again with a new operationKey");
	expect(
		JSON.parse(f.committed("voice/clips.json") as string).clips.map((each: { caption: string }) => each.caption),
	).toEqual([captionHash(A)]);
});

it("answers unavailable when no call can be placed: the recorder is stopped and nothing is saved", async () => {
	const f = await fixture({ unavailable: true });
	const answer = await f.narrate();
	expect(answer).toMatchObject({
		state: "unavailable",
		captions: 2,
		spokenNow: 0,
		left: 2,
		reason: "The voice could not be had in this call: no voice call can be placed in this run.",
	});
	expect(answer.next).toContain("the video plays with its captions and the clips it has");
	expect(f.steps()).toEqual(["captions", "peer", "stop", "clean"]);
	expect(f.commits).toEqual([]);
});

it("stops starting captions when less than a minute of its time is left, and says how many are left", async () => {
	const f = await fixture({ captions: [A, B, C], speakMs: 110_000 });
	const answer = await f.narrate();
	expect(f.spoken).toEqual([narrateSpokenLine(A), narrateSpokenLine(B)]);
	expect(answer).toMatchObject({ state: "partly_spoken", captions: 3, spokenNow: 2, left: 1 });
	expect(answer).not.toHaveProperty("silent");
	expect(f.steps()).toEqual(["captions", "peer", "answer", "stop", "encode", "clean"]);
});

it("on an abort closes the call and cancels the recorder, and saves nothing", async () => {
	const f = await fixture({ abortOn: B });
	await expect(f.narrate()).rejects.toThrow();
	expect(f.call.close).toHaveBeenCalledTimes(1);
	expect(f.gateway.cancel).toHaveBeenCalledTimes(1);
	expect(f.gateway.cancel.mock.calls[0]?.[1]).toBe(f.gateway.start.mock.calls[1]?.[1].commandId);
	expect(f.steps()).toEqual(["captions", "peer", "answer"]);
	expect(f.commits).toEqual([]);
});

it("leaves out a clip whose file never shows in the folder", async () => {
	const f = await fixture({ hidden: [captionHash(B)] });
	const answer = await f.narrate();
	expect(answer).toMatchObject({ state: "partly_spoken", spokenNow: 1, left: 1 });
	expect(JSON.parse(f.committed("voice/clips.json") as string).clips).toEqual([
		{ caption: captionHash(A), file: clip(A), seconds: 2.1 },
	]);
	expect(f.committed("index.html")).not.toContain(captionHash(B));
});

it("answers a call again with the same operationKey as the first, running nothing more", async () => {
	const f = await fixture();
	const first = await f.narrate();
	const commands = f.commands.length;
	expect(await f.narrate()).toEqual(first);
	expect(f.commands).toHaveLength(commands);
	expect(f.commits).toHaveLength(1);
	expect(f.voice.open).toHaveBeenCalledTimes(1);
	await refuses(f.narrate({ voice: "maple" }), "OPERATION_KEY_REUSED");
});

it("takes a running machine when none is named, and refuses when none runs", async () => {
	const f = await fixture({
		machines: [
			{ name: "archive", state: "stopped" },
			{ name: "studio", state: "running" },
		],
	});
	const answer = JSON.parse(
		String(
			(await f.tool.execute(f.tool.parseArguments({ name: "pricing", operationKey: "voice-1" }), f.context)).value,
		),
	);
	expect(answer).toMatchObject({ state: "spoken", spokenNow: 2 });
	expect(f.execute.mock.calls[0]?.[0].operation.arguments).toMatchObject({ machine: "studio" });
	const none = await fixture({ machines: [{ name: "studio", state: "stopped" }] });
	await refuses(
		none.tool.execute(none.tool.parseArguments({ name: "pricing", operationKey: "voice-1" }), none.context),
		"MACHINE_NOT_RUNNING: the company has no running machine; start one with machine_start",
	);
});

const WEEK_FULL: CloudVoiceUsage = {
	windows: [
		{ usedPercent: 41, resetAt: "2026-11-18T19:00:00.000Z", windowMinutes: 300 },
		{ usedPercent: 100, resetAt: "2026-11-24T13:22:00.000Z", windowMinutes: 10080 },
	],
};
const ROOM: CloudVoiceUsage = {
	windows: [{ usedPercent: 84, resetAt: "2026-11-24T13:22:00.000Z", windowMinutes: 10080 }],
};

it("reads the login's limit before it starts: at the limit no recorder starts and no call is placed", async () => {
	const f = await fixture({ captions: [A, B, C], usage: () => WEEK_FULL });
	const answer = await f.narrate();
	expect(answer).toMatchObject({
		state: "limit_reached",
		captions: 3,
		spoken: 0,
		left: 3,
		spokenNow: 0,
		spokenBefore: 0,
		limit: { usedPercent: 100, resetAt: "2026-11-24T13:22:00.000Z", reached: true },
	});
	expect(answer.next).toContain("at its usage limit, which resets at 2026-11-24T13:22:00.000Z");
	expect(answer.next).toContain("No call was placed and nothing changed");
	expect(f.voice.usage).toHaveBeenCalledTimes(1);
	expect(f.voice.open).not.toHaveBeenCalled();
	expect(f.steps()).toEqual(["captions", "clean"]);
	expect(f.commits).toEqual([]);
});

it("takes a login whose ordinary use is not allowed as at its limit, and an unknown reading as room", async () => {
	const blocked = await fixture({ usage: () => ({ allowed: false, windows: [] }) });
	expect(await blocked.narrate()).toMatchObject({ state: "limit_reached", left: 2, limit: { reached: true } });
	expect(blocked.voice.open).not.toHaveBeenCalled();
	const unknown = await fixture({ usage: () => undefined });
	const answer = await unknown.narrate();
	expect(answer).toMatchObject({ state: "spoken", spokenNow: 2, left: 0 });
	expect(answer).not.toHaveProperty("limit");
});

it("stops cleanly when the limit ends the call: what it recorded is saved, and it says how many are left", async () => {
	const f = await fixture({
		captions: [A, B, C],
		limitOn: C,
		usage: (read) => (read === 0 ? ROOM : WEEK_FULL),
	});
	const answer = await f.narrate();
	expect(f.spoken).toEqual([narrateSpokenLine(A), narrateSpokenLine(B), narrateSpokenLine(C)]);
	expect(f.steps()).toEqual(["captions", "peer", "answer", "stop", "encode", "clean"]);
	expect(f.call.close).toHaveBeenCalledTimes(1);
	expect(answer).toMatchObject({
		state: "limit_reached",
		captions: 3,
		spoken: 2,
		left: 1,
		spokenNow: 2,
		spokenBefore: 0,
		limit: { usedPercent: 100, resetAt: "2026-11-24T13:22:00.000Z", reached: true },
	});
	expect(answer).not.toHaveProperty("recorder");
	expect(answer.next).toContain(
		"What this call recorded is saved (2 captions); 1 caption is left and plays without sound",
	);
	expect(answer.next).toContain("call narrate_app again after the reset");
	expect(
		JSON.parse(f.committed("voice/clips.json") as string).clips.map((each: { caption: string }) => each.caption),
	).toEqual([captionHash(A), captionHash(B)]);
	expect(f.committed("index.html")).not.toContain(captionHash(C));
	expect(f.commits).toHaveLength(1);
});

it("names the limit when the call ends for no stated reason and the login then reads full", async () => {
	const f = await fixture({ captions: [A, B], failOn: B, usage: (read) => (read === 0 ? ROOM : WEEK_FULL) });
	expect(await f.narrate()).toMatchObject({ state: "limit_reached", spokenNow: 1, left: 1, limit: { reached: true } });
	const other = await fixture({ captions: [A, B], failOn: B, usage: () => ROOM });
	expect(await other.narrate()).toMatchObject({
		state: "partly_spoken",
		spokenNow: 1,
		left: 1,
		limit: { usedPercent: 84, reached: false },
		recorder: "The batch stopped early: the call ended.",
	});
});

it("answers limit_reached when the limit refuses the call itself, and saves nothing", async () => {
	const f = await fixture({ limitAtOpen: true, usage: () => ROOM });
	const answer = await f.narrate();
	expect(answer).toMatchObject({
		state: "limit_reached",
		spokenNow: 0,
		left: 2,
		limit: { usedPercent: 84, reached: true },
	});
	expect(f.steps()).toEqual(["captions", "peer", "stop", "clean"]);
	expect(f.commits).toEqual([]);
});

it("records only the captions that have no clip: a changed part costs only its own captions", async () => {
	const kept = { caption: captionHash(A), file: clip(A), seconds: 2.5 };
	const stale = { caption: captionHash("An old line."), file: clip("An old line."), seconds: 3 };
	const f = await fixture({
		captions: [A, C],
		files: {
			"voice/clips.json": JSON.stringify({ clips: [kept, stale] }),
			[`voice/${clip(A)}`]: new Uint8Array([1]),
			[`voice/${stale.file}`]: new Uint8Array([1]),
		},
	});
	const answer = await f.narrate();
	expect(f.spoken).toEqual([narrateSpokenLine(C)]);
	expect(answer).toMatchObject({ state: "spoken", captions: 2, spoken: 2, left: 0, spokenNow: 1, spokenBefore: 1 });
	expect(JSON.parse(f.committed("voice/clips.json") as string).clips).toEqual([
		kept,
		{ caption: captionHash(C), file: clip(C), seconds: 2.1 },
	]);
});

it("speaks a video's languages one after the other and counts each", async () => {
	const DA_A = "Butikken betaler Ada 149 kroner.";
	const DA_B = "Ada beholder resten.";
	const f = await fixture({
		captionsLine: {
			captions: [
				{ text: A, hash: "x", lang: "en" },
				{ text: B, hash: "x", lang: "en" },
				{ text: DA_A, hash: "x", lang: "da" },
				{ text: DA_B, hash: "x", lang: "da" },
			],
		},
		limitOn: DA_B,
		usage: (read) => (read === 0 ? ROOM : WEEK_FULL),
	});
	const answer = await f.narrate();
	expect(f.spoken.slice(0, 3)).toEqual([narrateSpokenLine(A), narrateSpokenLine(B), narrateSpokenLine(DA_A)]);
	expect(answer).toMatchObject({
		state: "limit_reached",
		captions: 4,
		spoken: 3,
		left: 1,
		languages: {
			en: { captions: 2, spoken: 2, left: 0 },
			da: { captions: 2, spoken: 1, left: 1 },
		},
	});
});

it("ends the batch when a recording does not arrive in time, and gives its late turn to no caption", async () => {
	const f = await fixture({ captions: [A, B, C], lateTurnOn: B });
	const answer = await f.narrate();
	expect(f.spoken).toEqual([narrateSpokenLine(A), narrateSpokenLine(B)]);
	expect(f.steps()).toEqual(["captions", "peer", "answer", "stop", "encode", "clean"]);
	expect(f.commands.find((command) => command.step === "encode")?.command).toContain(
		`/company/apps/pricing/voice 1:${captionHash(A)}\n`,
	);
	expect(answer).toMatchObject({
		state: "partly_spoken",
		captions: 3,
		spokenNow: 1,
		left: 2,
		recorder: "The batch stopped early: a recording did not arrive in time.",
	});
	expect(answer).not.toHaveProperty("silent");
	expect(
		JSON.parse(f.committed("voice/clips.json") as string).clips.map((each: { caption: string }) => each.caption),
	).toEqual([captionHash(A)]);
});

it("ends the batch at a turn nobody asked for, and drops the clip recorded just before it", async () => {
	const f = await fixture({ captions: [A, B, C], extraTurnAfter: B });
	const answer = await f.narrate();
	expect(f.spoken).toEqual([narrateSpokenLine(A), narrateSpokenLine(B)]);
	expect(f.commands.find((command) => command.step === "encode")?.command).toContain(
		`/company/apps/pricing/voice 1:${captionHash(A)}\n`,
	);
	expect(answer).toMatchObject({
		state: "partly_spoken",
		spokenNow: 1,
		left: 2,
		recorder: "The batch stopped early: the recorder heard a turn that was not asked for.",
	});
	expect(f.committed("index.html")).not.toContain(captionHash(B));
	const first = await fixture({ captions: [A, B], extraTurnAfter: A });
	expect(await first.narrate()).toMatchObject({ state: "partly_spoken", spokenNow: 0, left: 2 });
	expect(first.steps()).toEqual(["captions", "peer", "answer", "stop", "clean"]);
	expect(first.commits).toEqual([]);
});
