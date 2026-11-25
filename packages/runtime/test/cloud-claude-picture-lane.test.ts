import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CloudClaudePictureLane,
	type CloudClaudePictureSessionStart,
	claudeWorkerPictures,
	cloudClaudePictureLaneFor,
	cloudClaudePictureSessionStart,
} from "@qorpera/runtime/cloud-claude-picture-lane";
import { CloudPictureFailure, type CloudPictureMade } from "@qorpera/runtime/cloud-picture-channel";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const rpcFixture = fileURLToPath(new URL("./fixtures/codex-boundary-rpc-fixture.cjs", import.meta.url));
const binarySha256 = createHash("sha256")
	.update(await readFile(process.execPath))
	.digest("hex");
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function identityRoot(kind: "codex" | "plan" | "none") {
	const root = await mkdtemp(join(tmpdir(), "claude-picture-lane-"));
	roots.push(root);
	await mkdir(join(root, "codex"), { recursive: true, mode: 0o700 });
	if (kind === "codex") await writeFile(join(root, "codex", "auth.json"), "{}", { mode: 0o600 });
	if (kind === "plan") await mkdir(join(root, "chatgpt-plan"), { mode: 0o700 });
	return root;
}

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function sessions(options: { attach?: boolean; fail?: boolean; makeMs?: number } = {}) {
	const log: string[] = [];
	let live = 0;
	let most = 0;
	const start: CloudClaudePictureSessionStart = async ({ pictures, light, signal }) => {
		live += 1;
		most = Math.max(most, live);
		log.push("start");
		try {
			if (options.fail) throw new Error("Native provider execution codex-process-start stage failed");
			if (options.attach !== false)
				pictures.attach(async (input) => {
					log.push(`make ${input.prompt}`);
					await new Promise((resolve) => setTimeout(resolve, options.makeMs ?? 0));
					return { png: PNG } satisfies CloudPictureMade;
				});
			await light(signal);
		} finally {
			pictures.attach(undefined);
			log.push("end");
			live -= 1;
		}
	};
	return { start, log, most: () => most };
}

it("starts the member's side session on the first picture only, one picture at a time", async () => {
	const run = new AbortController();
	const s = sessions({ makeMs: 30 });
	const lane = new CloudClaudePictureLane({ start: s.start, signal: run.signal });
	expect(s.log).toEqual([]);
	const signal = new AbortController().signal;
	const both = await Promise.all([lane.make({ prompt: "one" }, signal), lane.make({ prompt: "two" }, signal)]);
	expect(both.map((made) => made.png.equals(PNG))).toEqual([true, true]);
	expect(s.log).toEqual(["start", "make one", "make two"]);
	expect(lane.sessions).toBe(1);
	await lane.close();
	expect(s.log.at(-1)).toBe("end");
});

it("ends the session when no picture was asked for a while, and starts a new one only after it ended", async () => {
	const run = new AbortController();
	const s = sessions();
	const lane = new CloudClaudePictureLane({ start: s.start, signal: run.signal, idleMs: 20 });
	const signal = new AbortController().signal;
	await lane.make({ prompt: "one" }, signal);
	await expect.poll(() => s.log.at(-1)).toBe("end");
	await lane.make({ prompt: "two" }, signal);
	expect(s.log).toEqual(["start", "make one", "end", "start", "make two"]);
	expect(s.most()).toBe(1);
	run.abort();
	await expect.poll(() => s.log.at(-1)).toBe("end");
});

it("says the picture failed when the side session could not start, and no lane means no pictures", async () => {
	const failing = new CloudClaudePictureLane({
		start: sessions({ fail: true }).start,
		signal: new AbortController().signal,
	});
	const failure = await failing.make({ prompt: "one" }, new AbortController().signal).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(CloudPictureFailure);
	expect((failure as CloudPictureFailure).reason).toBe("failed");
	expect(failing.failure).toBe("Error");
	const unattached = new CloudClaudePictureLane({
		start: sessions({ attach: false }).start,
		signal: new AbortController().signal,
	});
	await expect(unattached.make({ prompt: "one" }, new AbortController().signal)).rejects.toThrow(
		"Pictures are not available in this run",
	);
	unattached.close();
	failing.close();
});

it("makes nothing once the run has ended", async () => {
	const run = new AbortController();
	const s = sessions();
	const lane = new CloudClaudePictureLane({ start: s.start, signal: run.signal });
	run.abort();
	await expect(lane.make({ prompt: "one" }, new AbortController().signal)).rejects.toBeInstanceOf(CloudPictureFailure);
	expect(s.log).toEqual([]);
});

it("gives a lane only to a run whose root holds a Codex login, never a ChatGPT plan's or none", async () => {
	const start = sessions().start;
	const signal = new AbortController().signal;
	expect(await cloudClaudePictureLaneFor({ identityRoot: await identityRoot("none"), signal, start })).toBeUndefined();
	expect(await cloudClaudePictureLaneFor({ identityRoot: await identityRoot("plan"), signal, start })).toBeUndefined();
	expect(await cloudClaudePictureLaneFor({ identityRoot: await identityRoot("codex"), signal, start })).toBeInstanceOf(
		CloudClaudePictureLane,
	);
});

it("makes pictures on a light Codex of the run's own root, a later session clearing what an earlier one left", async () => {
	const f = nativeToolAuthorityFixture();
	const root = await identityRoot("codex");
	const evidence = join(await mkdtemp(join(tmpdir(), "claude-picture-evidence-")), "evidence.json");
	roots.push(join(evidence, ".."));
	const control = {
		describeToolAuthority: vi.fn(async () => structuredClone(f.authority)),
		beginToolOperation: vi.fn(async () => {
			throw new Error("No effects expected");
		}),
		completeToolOperation: vi.fn(async () => {
			throw new Error("No effects expected");
		}),
	};
	const run = new AbortController();
	const lane = await cloudClaudePictureLaneFor({
		identityRoot: root,
		signal: run.signal,
		idleMs: 20,
		start: cloudClaudePictureSessionStart({
			binding: f.binding,
			controlPlane: control as never,
			adapters: () => ({
				tools: [],
				assertContext: async () => undefined,
				recordContextView: async () => undefined,
			}),
			command: [process.execPath, rpcFixture, "picture-light", evidence],
			binarySha256,
			identityRoot: root,
		}),
	});
	const signal = new AbortController().signal;
	const first = await (lane as CloudClaudePictureLane).make({ prompt: "a red apple" }, signal);
	expect(first.revisedPrompt).toBe("a red apple");
	await expect.poll(() => lane?.open).toBe(false);
	await writeFile(join(root, "codex", "state.sqlite"), "left by Codex");
	const second = await (lane as CloudClaudePictureLane).make({ prompt: "a red apple" }, signal);
	expect(second.png.equals(first.png)).toBe(true);
	expect(lane?.sessions).toBe(2);
	expect(lane?.failure).toBeUndefined();
	await lane?.close();
	expect(await readdir(join(root, "codex"))).not.toContain("state.sqlite");
});

it("gives a Claude worker pictures only when the run's facts say its Codex login is the asking member's own", async () => {
	const given = vi.fn(async () => ({ png: PNG }));
	const lane = vi.fn(
		async () => new CloudClaudePictureLane({ start: sessions().start, signal: new AbortController().signal }),
	);
	const foreignOwner = async () => false;
	const another = await claudeWorkerPictures({
		facts: { member: "Ada", ownCodexLogin: false },
		home: true,
		given,
		lane,
		foreignOwner,
	});
	expect(another.pictures.make).toBeUndefined();
	expect(another.pictures.none).toContain("own ChatGPT sign-in isn't what this run uses");
	const unknown = await claudeWorkerPictures({ facts: null, home: true, lane, foreignOwner });
	expect(unknown.pictures.make).toBeUndefined();
	expect(unknown.pictures.none).toBeUndefined();
	expect(lane).not.toHaveBeenCalled();
	const own = await claudeWorkerPictures({ facts: { ownCodexLogin: true }, home: true, lane, foreignOwner });
	expect(lane).toHaveBeenCalledOnce();
	expect(own.lane).toBeInstanceOf(CloudClaudePictureLane);
	expect(typeof own.pictures.make).toBe("function");
	const proof = await claudeWorkerPictures({ facts: { ownCodexLogin: true }, home: true, given, lane, foreignOwner });
	expect(proof.pictures.make).toBe(given);
	expect(lane).toHaveBeenCalledOnce();
	await own.lane?.close();

	const gemini = vi.fn(async () => ({ png: PNG }));
	const chatGptPlan = vi.fn(async () => ({ png: PNG }));
	const preferredGemini = await claudeWorkerPictures({
		facts: { member: "Ada", ownCodexLogin: false },
		home: true,
		preferredModel: "gemini-3-pro-image",
		gemini,
		chatGptPlan,
		lane,
		foreignOwner,
	});
	expect(preferredGemini.pictures.make).toBe(gemini);
	expect(lane).toHaveBeenCalledOnce();

	const planOwned = await claudeWorkerPictures({
		facts: { member: "Ada", ownCodexLogin: true },
		home: true,
		preferredModel: "chatgpt-image",
		gemini,
		chatGptPlan,
		lane,
		foreignOwner,
	});
	expect(planOwned.pictures.make).toBe(chatGptPlan);
	expect(lane).toHaveBeenCalledOnce();

	const nonGeminiNotOwn = await claudeWorkerPictures({
		facts: { member: "Ada", ownCodexLogin: false },
		home: true,
		preferredModel: "chatgpt-image",
		gemini,
		lane,
		foreignOwner,
	});
	expect(nonGeminiNotOwn.pictures.make).toBeUndefined();
	expect(nonGeminiNotOwn.pictures.none).toContain("own ChatGPT sign-in isn't what this run uses");
});
