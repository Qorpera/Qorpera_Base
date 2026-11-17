import { createHash } from "node:crypto";
import { posix } from "node:path";
import { APP_ICONS_FOLDER } from "@qorpera/cloud-client/app-icons";
import { appPath } from "@qorpera/cloud-client/interface-apps";
import { CLAUDE_REPEAT_COMMAND, CLAUDE_REPEAT_ELSEWHERE, CLAUDE_REVIEW_FAILED } from "./cloud-claude-home-review.ts";
import {
	type CloudCodexHomeAction,
	type CloudCodexHomeMachine,
	type CloudCodexHomeReview,
	finishAction,
	folderPath,
} from "./cloud-codex-home.ts";
import { CLOUD_HOME_CHANNEL_LINE_BYTES } from "./cloud-home-channel.ts";
import { CloudToolRefusal } from "./cloud-native-tool-boundary.ts";
import {
	CLOUD_PICTURE_MS,
	CloudPictureFailure,
	type CloudPictureInput,
	type CloudPictureMade,
	CloudPictureUnavailable,
	cloudPictureInput,
	isCloudPicturePng,
	MAX_CLOUD_PICTURE_BYTES,
	MAX_CLOUD_PICTURE_PROMPT_BYTES,
} from "./cloud-picture-channel.ts";

export const CLAUDE_PICTURE_COMMAND = "picture";
export const CLAUDE_PICTURE_MAX_BYTES = Math.min(
	MAX_CLOUD_PICTURE_BYTES,
	Math.floor((CLOUD_HOME_CHANNEL_LINE_BYTES - 64 * 1024) / 4) * 3,
);
const PATH_BYTES = 4096;
const MB = 1_000_000;

export const CLAUDE_PICTURE_NOTE = `To make a picture (an illustration, a product idea, a scene), run \`picture <file.png under /company> <what to draw, in words>\` as a Bash command of its own, with a timeout of 300000: it is made on the member's own ChatGPT and saved at that path, which must be a new file or a picture it saved earlier in this run. Then open the file with Read and look at it. If it says no picture can be made, render it in Blender on the machine instead.`;

export const CLAUDE_PICTURE_USAGE = `PICTURE_USAGE: nothing was made. Run \`picture <file.png under /company> <what to draw, in words>\` as a command of its own: not in a pipe, a script or after &&, with the words written out (no $, backticks, * or ?). For example: picture /company/designs/chair.png "a walnut lounge chair on a plain light grey background, soft daylight"`;
export const CLAUDE_PICTURE_PATH =
	"PICTURE_PATH: nothing was made. The picture's path must be a .png file under /company, the company's folder, such as /company/designs/chair.png.";
export const CLAUDE_PICTURE_ICONS =
	"PICTURE_PATH: nothing was made. An app's icons/ hold SVG drawings: put the picture in another folder of the app, such as pictures/.";
export const CLAUDE_PICTURE_WORDS = `PICTURE_USAGE: nothing was made. The words for the picture must be plain text of 1 to ${MAX_CLOUD_PICTURE_PROMPT_BYTES} bytes.`;
export const CLAUDE_NO_PICTURES =
	"NO_PICTURES: no picture can be made for this work: pictures are made on the member's own ChatGPT sign-in, and this member has none here that makes pictures. Nothing was made or saved. Render it in Blender on this machine instead (blender -b, with the starter assets in /opt/qorpera-assets), or go on without the picture.";
export const CLAUDE_PICTURE_FAILED =
	"PICTURE_FAILED: the picture could not be made now; nothing was saved. Run it once more; if it fails again, go on without it.";

export function claudePictureFailureWords(error: CloudPictureFailure): string {
	const minutes = Math.round(CLOUD_PICTURE_MS / 60_000);
	const words: Record<CloudPictureFailure["reason"], string> = {
		picture_limit: `PICTURE_LIMIT_REACHED: the member's ChatGPT has no pictures left for now${
			error.resetsAt === undefined ? "" : `, until about ${new Date(error.resetsAt * 1000).toISOString()}`
		}; nothing was saved. Do not try again before then: render it in Blender on this machine, or go on without it.`,
		usage_limit:
			"USAGE_LIMIT_REACHED: the member's ChatGPT usage limit stopped the picture; nothing was saved. Try again later, render it in Blender on this machine, or go on without it.",
		refused:
			"PICTURE_REFUSED: the picture generator refused these words or could not draw them; nothing was saved. Change the words (leave out real people, brands and anything unsafe) and run it once more; if it fails again, go on without it.",
		free_plan:
			"NO_PICTURES: the member's ChatGPT plan is Free, which makes no pictures; nothing was saved. Render it in Blender on this machine instead, or go on without it, and say in your report that their plan makes no pictures.",
		no_picture:
			"NO_PICTURE: no picture was made, and why is not known (the words may have been declined, or this sign-in may make no pictures); nothing was saved. Change the words and run it once more; if no picture comes again, render it in Blender on this machine or go on without it.",
		timeout: `PICTURE_TIMEOUT: no picture came back within ${minutes} minutes; nothing was saved. Run it once more; if it fails again, go on without it.`,
		invalid:
			"PICTURE_UNUSABLE: what the generator gave back is not a usable PNG; nothing was saved. Run it once more.",
		too_large: `PICTURE_TOO_LARGE: the picture is larger than ${(CLAUDE_PICTURE_MAX_BYTES / MB).toFixed(1)} MB, more than one picture may be here; nothing was saved. Ask for a simpler picture.`,
		busy: "PICTURE_BUSY: another picture is being made in this run; run it again once that one is done.",
		failed: CLAUDE_PICTURE_FAILED,
	};
	return words[error.reason];
}

const BARE = /^[A-Za-z0-9_/.,:@%+=^-]$/u;

export function cloudClaudeCommandWords(text: string): string[] | undefined {
	const words: string[] = [];
	let at = 0;
	for (;;) {
		while (at < text.length && (text[at] === " " || text[at] === "\t")) at += 1;
		if (at >= text.length) return words;
		let word = "";
		while (at < text.length && text[at] !== " " && text[at] !== "\t") {
			const char = text[at] as string;
			if (char === "'") {
				const end = text.indexOf("'", at + 1);
				if (end < 0) return undefined;
				word += text.slice(at + 1, end);
				at = end + 1;
			} else if (char === '"') {
				at += 1;
				while (at < text.length && text[at] !== '"') {
					const inner = text[at] as string;
					if (inner === "\\" && at + 1 < text.length && '$`"\\\n'.includes(text[at + 1] as string)) {
						if (text[at + 1] !== "\n") word += text[at + 1];
						at += 2;
					} else if (inner === "$" || inner === "`") return undefined;
					else {
						word += inner;
						at += 1;
					}
				}
				if (at >= text.length) return undefined;
				at += 1;
			} else if (char === "\\") {
				if (at + 1 >= text.length || text[at + 1] === "\n") return undefined;
				word += text[at + 1];
				at += 2;
			} else if (BARE.test(char) || (char.codePointAt(0) ?? 0) > 0x7f) {
				word += char;
				at += 1;
			} else return undefined;
		}
		words.push(word);
	}
}

export type ClaudePictureCall = { readonly path: string; readonly prompt: string } | { readonly usage: string };

export function cloudClaudePictureCall(command: string, cwd: string): ClaudePictureCall | undefined {
	if (!new RegExp(`^${CLAUDE_PICTURE_COMMAND}(?:[ \\t]|$)`).test(command)) return undefined;
	const words = cloudClaudeCommandWords(command);
	if (!words || words[0] !== CLAUDE_PICTURE_COMMAND || words.length < 3) return { usage: CLAUDE_PICTURE_USAGE };
	const named = words[1] as string;
	if (named.length === 0 || named.includes("\0") || !posix.isAbsolute(cwd)) return { usage: CLAUDE_PICTURE_PATH };
	const path = posix.resolve(cwd, named);
	const inFolder = folderPath(path);
	if (
		inFolder === undefined ||
		!path.toLowerCase().endsWith(".png") ||
		Buffer.byteLength(path) > PATH_BYTES ||
		/\p{Cc}/u.test(path)
	)
		return { usage: CLAUDE_PICTURE_PATH };
	if (appPath(inFolder)?.inner.toLowerCase().startsWith(`${APP_ICONS_FOLDER}/`))
		return { usage: CLAUDE_PICTURE_ICONS };
	try {
		return { path, prompt: cloudPictureInput({ prompt: words.slice(2).join(" ") }).prompt };
	} catch {
		return { usage: CLAUDE_PICTURE_WORDS };
	}
}

export function cloudClaudePictureAction(
	machine: CloudCodexHomeMachine,
	input: { readonly command: string; readonly cwd: string; readonly path: string; readonly prompt: string },
	foreignOwner: boolean,
	callId: string,
): CloudCodexHomeAction {
	const inFolder = folderPath(input.path) ?? input.path;
	const action = finishAction({
		tool: "make_picture",
		machine,
		summary: input.command,
		identity: {
			cwd: input.cwd,
			path: inFolder,
			prompt: input.prompt,
			...(foreignOwner ? { foreignOwner: true } : {}),
		},
		callId,
		step: { tool: "claude_code_picture", arguments: { path: inFolder }, paths: [input.path] },
		repeat: CLAUDE_REPEAT_COMMAND,
	});
	return { ...action, repeatElsewhere: CLAUDE_REPEAT_ELSEWHERE };
}

export interface CloudClaudePictures {
	readonly make: ((input: CloudPictureInput, signal: AbortSignal) => Promise<CloudPictureMade>) | undefined;
	readonly foreignOwner?: (path: string, signal: AbortSignal) => Promise<boolean>;
}

export type ClaudePicturePlace =
	| { readonly real: string; readonly file: string | null }
	| "missing"
	| "folder"
	| "unresolved"
	| "unavailable";

export interface ClaudePictureHome {
	place(path: string, signal: AbortSignal): Promise<ClaudePicturePlace>;
	write(path: string, png: Buffer, signal: AbortSignal): Promise<boolean>;
}

export interface ClaudePictureOutcome {
	readonly out?: string;
	readonly err?: string;
	readonly code: number;
	readonly saved?: number;
}

const HOME_UNAVAILABLE =
	"HOME_UNAVAILABLE: this agent's machine could not be reached, so no picture was made. Try again.";

function placeRefusal(place: Exclude<ClaudePicturePlace, { readonly real: string }>, path: string): string {
	if (place === "missing")
		return `PICTURE_FOLDER_MISSING: nothing was made; the folder ${posix.dirname(path)} does not exist on this machine. Make it with mkdir -p first, or save the picture in a folder that exists.`;
	if (place === "folder")
		return `PICTURE_PATH: nothing was made; ${path} is a folder. Give the picture a file's path ending in .png.`;
	if (place === "unresolved")
		return `PICTURE_PATH: nothing was made; where ${path} leads could not be worked out on this machine (a loop of links). Choose another path.`;
	return HOME_UNAVAILABLE;
}

function picturePathRefusal(real: string, named: string): string | undefined {
	const inFolder = folderPath(real);
	if (inFolder === undefined || !real.toLowerCase().endsWith(".png"))
		return real === named
			? CLAUDE_PICTURE_PATH
			: `PICTURE_PATH: nothing was made; ${named} leads to ${real} on this machine, which is not a .png file under /company. Name the picture's real place.`;
	if (appPath(inFolder)?.inner.toLowerCase().startsWith(`${APP_ICONS_FOLDER}/`)) return CLAUDE_PICTURE_ICONS;
	return undefined;
}

export async function runClaudePictureCommand(input: {
	readonly call: { readonly path: string; readonly prompt: string };
	readonly command: string;
	readonly cwd: string;
	readonly machine: CloudCodexHomeMachine;
	readonly review?: CloudCodexHomeReview;
	readonly callId: string;
	readonly pictures: CloudClaudePictures;
	readonly home: ClaudePictureHome;
	readonly written: Map<string, string>;
	readonly signal: AbortSignal;
}): Promise<ClaudePictureOutcome> {
	const { call, home, signal } = input;
	const refused = (words: string, code = 1): ClaudePictureOutcome => ({ err: words, code });
	const make = input.pictures.make;
	if (!make) return refused(CLAUDE_NO_PICTURES);
	const before = await home.place(call.path, signal);
	if (typeof before === "string") return refused(placeRefusal(before, call.path), before === "unavailable" ? 255 : 1);
	const real = before.real;
	const wrong = picturePathRefusal(real, call.path);
	if (wrong !== undefined) return refused(wrong);
	if (before.file !== null && input.written.get(real) !== before.file)
		return refused(
			`PICTURE_EXISTS: nothing was made; ${real} is there already, and picture replaces only the very picture it saved there in this run. Name a new file, or remove the old one first.`,
		);
	let foreignOwner = false;
	const inFolder = folderPath(real) as string;
	if (appPath(inFolder) && input.pictures.foreignOwner) {
		try {
			foreignOwner = await input.pictures.foreignOwner(inFolder, signal);
		} catch (error) {
			signal.throwIfAborted();
			return refused(error instanceof CloudToolRefusal ? error.message : CLAUDE_PICTURE_FAILED);
		}
	}
	if (input.review) {
		const action = cloudClaudePictureAction(
			input.machine,
			{ command: input.command, cwd: input.cwd, path: real, prompt: call.prompt },
			foreignOwner,
			input.callId,
		);
		let gate: Awaited<ReturnType<CloudCodexHomeReview["check"]>>;
		try {
			gate = await input.review.check(action, signal);
		} catch {
			signal.throwIfAborted();
			return refused(CLAUDE_REVIEW_FAILED, 126);
		}
		if (!gate.run) return refused(gate.text, 126);
	}
	let made: CloudPictureMade;
	try {
		made = await make({ prompt: call.prompt }, signal);
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof CloudPictureUnavailable) return refused(CLAUDE_NO_PICTURES);
		return refused(
			claudePictureFailureWords(error instanceof CloudPictureFailure ? error : new CloudPictureFailure("failed")),
		);
	}
	if (made.png.byteLength > CLAUDE_PICTURE_MAX_BYTES)
		return refused(claudePictureFailureWords(new CloudPictureFailure("too_large")));
	if (!isCloudPicturePng(made.png)) return refused(claudePictureFailureWords(new CloudPictureFailure("invalid")));
	const after = await home.place(call.path, signal);
	if (typeof after === "string" || after.real !== real || after.file !== before.file) {
		signal.throwIfAborted();
		return refused(
			after === "unavailable"
				? HOME_UNAVAILABLE
				: `PICTURE_PLACE_CHANGED: the picture was made but not saved; ${call.path} changed on this machine while it was made (it leads elsewhere now, or a file appeared there). Run it again.`,
			after === "unavailable" ? 255 : 1,
		);
	}
	if (!(await home.write(real, made.png, signal))) {
		signal.throwIfAborted();
		return refused(
			`PICTURE_NOT_SAVED: the picture was made but could not be written to ${real} on this machine; nothing was saved. Run it again into a folder you can write.`,
		);
	}
	input.written.set(real, createHash("sha256").update(made.png).digest("hex"));
	return {
		out: `Saved a new picture to ${real}: a PNG of ${made.png.byteLength} bytes, made on the member's ChatGPT from your words. Open it with Read and look at it; if it is not what the work needs, run picture again with better words (each picture uses the member's ChatGPT picture allowance).\n`,
		code: 0,
		saved: made.png.byteLength,
	};
}
