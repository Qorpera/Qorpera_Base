import {
	CloudClaudePictureLane,
	type CloudClaudePictureSessionStart,
} from "@qorpera/runtime/cloud-claude-picture-lane";
import { CloudPictureFailure, type CloudPictureMade } from "@qorpera/runtime/cloud-picture-channel";
import { expect, it } from "vitest";

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
	lane.close();
	await expect.poll(() => s.log.at(-1)).toBe("end");
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
