import { createHash } from "node:crypto";
import { cloudActionEffect, describeCloudAction } from "@qorpera/runtime/cloud-action-review";
import {
	CLAUDE_NO_PICTURES,
	CLAUDE_PICTURE_ICONS,
	CLAUDE_PICTURE_MAX_BYTES,
	CLAUDE_PICTURE_NOT_OWN_LOGIN,
	CLAUDE_PICTURE_PATH,
	CLAUDE_PICTURE_USAGE,
	CLAUDE_PICTURE_WORDS,
	type ClaudePictureHome,
	type ClaudePicturePlace,
	type CloudClaudePictures,
	claudePictureLogin,
	cloudClaudeCommandWords,
	cloudClaudePictureAction,
	cloudClaudePictureCall,
	runClaudePictureCommand,
} from "@qorpera/runtime/cloud-claude-picture-command";
import type { CloudCodexHomeAction } from "@qorpera/runtime/cloud-codex-home";
import { CLOUD_HOME_CHANNEL_LINE_BYTES } from "@qorpera/runtime/cloud-home-channel";
import { CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudPictureFailure, CloudPictureUnavailable } from "@qorpera/runtime/cloud-picture-channel";
import { describe, expect, it } from "vitest";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);
const MACHINE = { id: "00000000-0000-4000-8000-000000000002", name: "studio" };

describe("the picture command's words", () => {
	it.each<[string, string[] | undefined]>([
		["picture /company/a.png a red chair", ["picture", "/company/a.png", "a", "red", "chair"]],
		[`picture /company/a.png "a red chair, side view"`, ["picture", "/company/a.png", "a red chair, side view"]],
		["picture 'b c.png' 'it'\\''s red'", ["picture", "b c.png", "it's red"]],
		['picture a.png "say \\"hi\\" æøå"', ["picture", "a.png", 'say "hi" æøå']],
		['picture a.png "two\nlines"', ["picture", "a.png", "two\nlines"]],
		["picture a.png red\\ chair", ["picture", "a.png", "red chair"]],
		["picture a.png red | tee x", undefined],
		["picture a.png red && rm -rf /company", undefined],
		["picture a.png red; echo", undefined],
		['picture a.png "$(cat words.txt)"', undefined],
		["picture a.png `cat words.txt`", undefined],
		["picture a.png $WORDS", undefined],
		["picture *.png red", undefined],
		["picture a.png red > out.txt", undefined],
		["picture a.png red\necho second", undefined],
		["picture a.png 'open", undefined],
	])("reads %j as %j", (text, words) => {
		expect(cloudClaudeCommandWords(text)).toEqual(words);
	});

	it("is the host's only when its first word is picture", () => {
		expect(cloudClaudePictureCall("echo picture", "/company")).toBeUndefined();
		expect(cloudClaudePictureCall("pictures a.png red", "/company")).toBeUndefined();
		expect(cloudClaudePictureCall("ls && picture a.png red", "/company")).toBeUndefined();
		expect(cloudClaudePictureCall("picture", "/company")).toEqual({ usage: CLAUDE_PICTURE_USAGE });
		expect(cloudClaudePictureCall("picture /company/a.png", "/company")).toEqual({ usage: CLAUDE_PICTURE_USAGE });
		expect(cloudClaudePictureCall("picture /company/a.png red | tee x", "/company")).toEqual({
			usage: CLAUDE_PICTURE_USAGE,
		});
	});

	it("takes a .png under /company, from the command's folder, and the rest as the words", () => {
		expect(cloudClaudePictureCall('picture designs/chair.png "a red chair"', "/company/work")).toEqual({
			path: "/company/work/designs/chair.png",
			prompt: "a red chair",
		});
		expect(cloudClaudePictureCall("picture /company/A.PNG a red chair", "/tmp")).toEqual({
			path: "/company/A.PNG",
			prompt: "a red chair",
		});
		for (const named of ["/tmp/a.png", "../a.png", "/company/a.jpg", "/company/folder/", "/company"])
			expect(cloudClaudePictureCall(`picture ${named} red`, "/company")).toEqual({ usage: CLAUDE_PICTURE_PATH });
		expect(cloudClaudePictureCall(`picture /company/${"a".repeat(4100)}.png red`, "/company")).toEqual({
			usage: CLAUDE_PICTURE_PATH,
		});
		expect(cloudClaudePictureCall("picture /company/apps/shop/icons/cart.png red", "/company")).toEqual({
			usage: CLAUDE_PICTURE_ICONS,
		});
		expect(cloudClaudePictureCall(`picture /company/a.png ${"x".repeat(4097)}`, "/company")).toEqual({
			usage: CLAUDE_PICTURE_WORDS,
		});
	});

	it("never takes more than one line of the home's channel for a picture", () => {
		expect(Math.ceil(CLAUDE_PICTURE_MAX_BYTES / 3) * 4 + 64 * 1024).toBeLessThanOrEqual(
			CLOUD_HOME_CHANNEL_LINE_BYTES,
		);
		expect(CLAUDE_PICTURE_MAX_BYTES).toBeGreaterThan(6_000_000);
	});
});

describe("the picture's review", () => {
	it("is Codex's make_picture: internal in the agent's own places, delegation into another's app", () => {
		const call = { command: "picture /company/a.png red", cwd: "/company", path: "/company/a.png", prompt: "red" };
		const own = cloudClaudePictureAction(MACHINE, call, false, "c1");
		expect(own.tool).toBe("make_picture");
		const parsed = JSON.parse(own.argumentsText);
		expect(parsed).toEqual({
			machine: "studio",
			machineId: MACHINE.id,
			command: "picture /company/a.png red",
			cwd: "/company",
			path: "a.png",
			prompt: "red",
		});
		expect(cloudActionEffect({ name: own.tool, source: "runtime" }, parsed)).toBe("internal");
		expect(own.repeatElsewhere).toContain("in its own thread");
		const into = { ...call, path: "/company/apps/shop/pictures/a.png" };
		const foreign = cloudClaudePictureAction(MACHINE, into, true, "c2");
		const foreignParsed = JSON.parse(foreign.argumentsText);
		expect(cloudActionEffect({ name: foreign.tool, source: "runtime" }, foreignParsed)).toBe("delegation");
		const card = describeCloudAction({ name: foreign.tool, source: "runtime" }, foreignParsed);
		expect(card.title).toBe("Put a picture into another agent's app");
		expect(card.target).toBe("apps/shop/pictures/a.png");
		expect(foreign.argumentSha256).not.toBe(own.argumentSha256);
		expect(cloudClaudePictureAction(MACHINE, call, false, "c3").argumentSha256).toBe(own.argumentSha256);
	});
});

function fakeHome(
	place: ClaudePicturePlace | "ok" | ((path: string, asked: number) => ClaudePicturePlace) = "ok",
	writes = true,
) {
	const seen: string[] = [];
	const written: { path: string; png: Buffer }[] = [];
	let asked = 0;
	const home: ClaudePictureHome = {
		place: async (path) => {
			seen.push(`place ${path}`);
			asked += 1;
			if (typeof place === "function") return place(path, asked);
			return place === "ok" ? { real: path, file: null } : place;
		},
		write: async (path, png) => {
			seen.push(`write ${path}`);
			if (writes) written.push({ path, png });
			return writes;
		},
	};
	return { home, seen, written };
}

async function picture(
	pictures: CloudClaudePictures,
	home: ClaudePictureHome,
	more: {
		path?: string;
		review?: (action: CloudCodexHomeAction) => { run: true } | { run: false; text: string };
		written?: Map<string, string>;
	} = {},
) {
	const reviewed: CloudCodexHomeAction[] = [];
	const outcome = await runClaudePictureCommand({
		call: { path: more.path ?? "/company/designs/chair.png", prompt: "a red chair" },
		command: "picture designs/chair.png a red chair",
		cwd: "/company",
		machine: MACHINE,
		review: {
			check: async (action) => {
				reviewed.push(action);
				return more.review?.(action) ?? { run: true };
			},
		},
		callId: "claude-picture:s:1",
		pictures,
		home,
		written: more.written ?? new Map(),
		signal: new AbortController().signal,
	});
	return { outcome, reviewed };
}

describe("one picture", () => {
	it("is checked, made on the member's lane, written where the worker named, and told in words", async () => {
		const asked: string[] = [];
		const { home, seen, written } = fakeHome();
		const { outcome, reviewed } = await picture(
			{
				make: async (input) => {
					asked.push(input.prompt);
					seen.push("make");
					return { png: PNG };
				},
			},
			home,
		);
		expect(outcome).toEqual({
			out: expect.stringContaining(
				`Saved a new picture to /company/designs/chair.png: a PNG of ${PNG.byteLength} bytes`,
			),
			code: 0,
			saved: PNG.byteLength,
		});
		expect(outcome.out).toContain("Open it with Read");
		expect(asked).toEqual(["a red chair"]);
		expect(seen).toEqual([
			"place /company/designs/chair.png",
			"make",
			"place /company/designs/chair.png",
			"write /company/designs/chair.png",
		]);
		expect(written[0]?.png.equals(PNG)).toBe(true);
		expect(reviewed.map((action) => action.tool)).toEqual(["make_picture"]);
	});

	it("gives a member with no picture login the words, and makes and writes nothing", async () => {
		const { home, seen } = fakeHome();
		const none = await picture({ make: undefined }, home);
		expect(none.outcome).toEqual({ err: CLAUDE_NO_PICTURES, code: 1 });
		expect(CLAUDE_NO_PICTURES).toContain("Blender");
		const detached = await picture(
			{
				make: async () => {
					throw new CloudPictureUnavailable();
				},
			},
			home,
		);
		expect(detached.outcome).toEqual({ err: CLAUDE_NO_PICTURES, code: 1 });
		expect(seen.filter((step) => step.startsWith("write"))).toEqual([]);
	});

	it.each<[CloudPictureFailure, string]>([
		[new CloudPictureFailure("picture_limit", 1763049600), "PICTURE_LIMIT_REACHED"],
		[new CloudPictureFailure("spend_cap"), "GEMINI_SPEND_CAP_REACHED"],
		[new CloudPictureFailure("billing_required"), "GEMINI_BILLING_REQUIRED"],
		[new CloudPictureFailure("free_plan"), "NO_PICTURES: the member's ChatGPT plan is Free"],
		[new CloudPictureFailure("refused"), "PICTURE_REFUSED"],
		[new CloudPictureFailure("timeout"), "PICTURE_TIMEOUT"],
		[new CloudPictureFailure("no_picture"), "NO_PICTURE:"],
	])("says why no picture came back (%s)", async (failure, words) => {
		const { home, written } = fakeHome();
		const { outcome } = await picture(
			{
				make: async () => {
					throw failure;
				},
			},
			home,
		);
		expect(outcome.code).toBe(1);
		expect(outcome.err).toContain(words);
		expect(outcome.err).toContain("nothing was saved");
		expect(written).toEqual([]);
	});

	it("is not made when the review does not let it through, nor when its folder is not there", async () => {
		let made = 0;
		const make = async () => {
			made += 1;
			return { png: PNG };
		};
		const denied = await picture({ make }, fakeHome().home, {
			review: () => ({ run: false, text: "REVIEW_DENIED: not this one." }),
		});
		expect(denied.outcome).toEqual({ err: "REVIEW_DENIED: not this one.", code: 126 });
		const missing = await picture({ make }, fakeHome("missing").home);
		expect(missing.outcome.err).toContain("PICTURE_FOLDER_MISSING");
		expect(missing.outcome.err).toContain("/company/designs does not exist");
		const folder = await picture({ make }, fakeHome("folder").home);
		expect(folder.outcome.err).toContain("is a folder");
		const gone = await picture({ make }, fakeHome("unavailable").home);
		expect(gone.outcome.code).toBe(255);
		expect(made).toBe(0);
	});

	it("is reviewed as delegation into another agent's app, and refused in a retired one before anything", async () => {
		const owners: string[] = [];
		const into = "/company/apps/shop/pictures/a.png";
		const { reviewed } = await picture(
			{
				make: async () => ({ png: PNG }),
				foreignOwner: async (path) => {
					owners.push(path);
					return true;
				},
			},
			fakeHome().home,
			{ path: into },
		);
		expect(owners).toEqual(["apps/shop/pictures/a.png"]);
		expect(JSON.parse(reviewed[0]?.argumentsText ?? "{}").foreignOwner).toBe(true);
		const retired = await picture(
			{
				make: async () => ({ png: PNG }),
				foreignOwner: async () => {
					throw new CloudToolRefusal("APP_RETIRED: a member retired the interface shop.");
				},
			},
			fakeHome().home,
			{ path: into },
		);
		expect(retired.outcome).toEqual({ err: "APP_RETIRED: a member retired the interface shop.", code: 1 });
		expect(retired.reviewed).toEqual([]);
	});

	it("keeps out a picture that is not a PNG or too large, and says when the write failed", async () => {
		const notPng = await picture({ make: async () => ({ png: Buffer.from("not a png") }) }, fakeHome().home);
		expect(notPng.outcome.err).toContain("PICTURE_UNUSABLE");
		const large = Buffer.concat([PNG, Buffer.alloc(CLAUDE_PICTURE_MAX_BYTES)]);
		const tooLarge = await picture({ make: async () => ({ png: large }) }, fakeHome().home);
		expect(tooLarge.outcome.err).toContain("PICTURE_TOO_LARGE");
		const unwritten = await picture({ make: async () => ({ png: PNG }) }, fakeHome("ok", false).home);
		expect(unwritten.outcome).toEqual({ err: expect.stringContaining("PICTURE_NOT_SAVED"), code: 1 });
	});

	it("is checked, reviewed and written at the real place a link leads to, and refused when that is outside", async () => {
		const into = "/company/apps/shop/pictures/a.png";
		const owners: string[] = [];
		const linked = fakeHome(() => ({ real: into, file: null }));
		const { outcome, reviewed } = await picture(
			{
				make: async () => ({ png: PNG }),
				foreignOwner: async (path) => {
					owners.push(path);
					return true;
				},
			},
			linked.home,
			{ path: "/company/mine/p/a.png" },
		);
		expect(outcome.code).toBe(0);
		expect(outcome.out).toContain(`Saved a new picture to ${into}`);
		expect(owners).toEqual(["apps/shop/pictures/a.png"]);
		const parsed = JSON.parse(reviewed[0]?.argumentsText ?? "{}");
		expect(parsed).toMatchObject({ path: "apps/shop/pictures/a.png", foreignOwner: true });
		expect(cloudActionEffect({ name: "make_picture", source: "runtime" }, parsed)).toBe("delegation");
		expect(linked.written.map((write) => write.path)).toEqual([into]);
		let made = 0;
		const make = async () => {
			made += 1;
			return { png: PNG };
		};
		const outside = await picture({ make }, fakeHome(() => ({ real: "/etc/a.png", file: null })).home, {
			path: "/company/mine/p/a.png",
		});
		expect(outside.outcome.err).toContain("leads to /etc/a.png on this machine");
		const icons = await picture(
			{ make },
			fakeHome(() => ({ real: "/company/apps/shop/icons/a.png", file: null })).home,
		);
		expect(icons.outcome.err).toBe(CLAUDE_PICTURE_ICONS);
		expect(outside.reviewed).toEqual([]);
		expect(made).toBe(0);
	});

	it("replaces only a picture it saved in this run, and saves nothing when the place changed while it was made", async () => {
		const ours = createHash("sha256").update(PNG).digest("hex");
		const there = fakeHome(() => ({ real: "/company/designs/chair.png", file: ours }));
		const written = new Map<string, string>();
		const refused = await picture({ make: async () => ({ png: PNG }) }, there.home, { written });
		expect(refused.outcome.err).toContain(
			"PICTURE_EXISTS: nothing was made; /company/designs/chair.png is there already",
		);
		expect(there.written).toEqual([]);
		const fresh = fakeHome();
		const first = await picture({ make: async () => ({ png: PNG }) }, fresh.home, { written });
		expect(first.outcome.code).toBe(0);
		expect([...written]).toEqual([["/company/designs/chair.png", ours]]);
		const again = await picture({ make: async () => ({ png: PNG }) }, there.home, { written });
		expect(again.outcome.code).toBe(0);
		expect(there.written).toHaveLength(1);
		const changed = fakeHome(() => ({ real: "/company/designs/chair.png", file: "f".repeat(64) }));
		const other = await picture({ make: async () => ({ png: PNG }) }, changed.home, { written });
		expect(other.outcome.err).toContain("PICTURE_EXISTS");
		expect(changed.written).toEqual([]);
		const swapped = fakeHome((path, asked) => ({
			real: asked === 1 ? path : "/company/elsewhere/a.png",
			file: null,
		}));
		const moved = await picture({ make: async () => ({ png: PNG }) }, swapped.home);
		expect(moved.outcome.err).toContain("PICTURE_PLACE_CHANGED");
		const appeared = fakeHome((path, asked) => ({ real: path, file: asked > 1 ? "e".repeat(64) : null }));
		const late = await picture({ make: async () => ({ png: PNG }) }, appeared.home);
		expect(late.outcome.err).toContain("PICTURE_PLACE_CHANGED");
		expect([...swapped.written, ...appeared.written]).toEqual([]);
	});

	it("makes a picture only on the asking member's own Codex login, as the run's facts say, and nothing on any other", async () => {
		expect(claudePictureLogin({ member: "Ada", ownCodexLogin: true })).toEqual({ own: true });
		expect(claudePictureLogin({ member: "Ada", ownCodexLogin: false })).toEqual({
			own: false,
			none: CLAUDE_PICTURE_NOT_OWN_LOGIN,
		});
		for (const facts of [null, { member: "Ada" }, { ownCodexLogin: "true" }, "x"])
			expect(claudePictureLogin(facts)).toEqual({ own: false });
		expect(CLAUDE_PICTURE_NOT_OWN_LOGIN).toContain("own ChatGPT sign-in isn't what this run uses");
		expect(CLAUDE_PICTURE_NOT_OWN_LOGIN).toContain("Blender");
		const home = fakeHome();
		const { outcome, reviewed } = await picture({ make: undefined, none: CLAUDE_PICTURE_NOT_OWN_LOGIN }, home.home);
		expect(outcome).toEqual({ err: CLAUDE_PICTURE_NOT_OWN_LOGIN, code: 1 });
		expect(home.seen).toEqual([]);
		expect(reviewed).toEqual([]);
	});
});
