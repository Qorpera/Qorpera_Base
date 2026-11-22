import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	appFolder,
	parseAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import {
	type CloudMachineCommandReceipt,
	isUuid,
	type JsonValue,
	parseCloudCodingCommandRead,
	parseCloudMachineCommandReceipt,
	parseRecord,
} from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import {
	captionHash,
	EXPLAINER_CLIPS,
	EXPLAINER_CLIPS_MAX_BYTES,
	EXPLAINER_PAGE,
	EXPLAINER_VOICE_CAPTIONS_CJS,
	EXPLAINER_VOICE_ENCODE_CJS,
	EXPLAINER_VOICE_PEER_CJS,
	type ExplainerClip,
	explainerPage,
	explainerSpokenMatches,
	parseExplainerClips,
} from "./cloud-app-kit-explainer.ts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderRelease,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderUnitResult,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { type CloudCompanyPathControl, CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { CloudCompanyPathRpcRefusal } from "./cloud-company-path-refusal.ts";
import { CloudControlRpcRefused } from "./cloud-control-errors.ts";
import {
	args,
	cloudFolderRefusal,
	OPERATION_KEY,
	operationKey,
	released,
	TOOL_VERSION,
	unavailable,
} from "./cloud-folder-file-tools.ts";
import {
	CLOUD_MACHINE_TOOL_VERSION,
	type CloudMachineCommandGateway,
	cloudMachineCommandRefusal,
} from "./cloud-machine-command-http.ts";
import { CLOUD_MACHINE_READ_MS } from "./cloud-machine-tools.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import {
	CLOUD_VOICE_NAMES,
	type CloudVoiceCall,
	type CloudVoiceChannel,
	CloudVoiceLimitReached,
	type CloudVoiceName,
	CloudVoiceUnavailable,
	type CloudVoiceUsage,
	cloudVoiceUsageFull,
	isCloudVoiceName,
	MAX_CLOUD_VOICE_TEXT_BYTES,
} from "./cloud-voice-channel.ts";

const BUDGET_MS = 270_000;
const RESERVE_MS = 60_000;
const DEFAULT_VOICE: CloudVoiceName = "cove";
const COMMAND_MAX_BYTES = 16384;
const CAPTIONS_MS = 60_000;
const USAGE_MS = 10_000;
const OFFER_MS = 40_000;
const CONNECTED_MS = 30_000;
const SPEAK_MS = 45_000;
const TURN_MS = 20_000;
const ENDED_MS = 50_000;
const ENCODE_MS = 90_000;
const FINISHING_SECONDS = 20;
const TRIES = 3;
const SHOWN_CHARS = 200;
const MAX_CAPTIONS = 400;
const WORK_ROOT = "/root/.qorpera-narrate";
const SCRIPT_END = "QORPERA_NARRATE_SCRIPT_END";
const MARK = "QORPERA-VOICE ";
const MACHINE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const LINE_MAX_BYTES = 256 * 1024;

export const CLOUD_NARRATE_APP_DESCRIPTION = [
	"Give your explainer app its voice: a voice reads each caption of the video aloud, and each reading becomes that caption's clip in the app's voice/ folder, which the video plays under the caption. The app must be your own explainer (save_app, manifest.kit explainer).",
	"It needs a running company machine whose commands see the company folder at /company: name it as machine, or leave machine out and a running one is taken; with none running, start one with machine_start first.",
	"The voice is made on the ChatGPT login this run works on and counts against that login's usage limit, so the call reads the limit first and records only captions that have no clip yet. A clip is named by its caption's text: after you change one part of a video only the captions you changed are recorded again, and the others keep their voice.",
	"One call speaks one batch, as many captions as fit in about three minutes; its answer says how many captions are spoken and how many are left. State partly_spoken: call again with a new operationKey while left is more than 0. State limit_reached means the login is at its usage limit: what was recorded is saved, nothing more can be recorded until the limit resets (limit.resetAt when known), and the video plays its captions without sound where a clip is missing; tell the member, and call again after the reset. State unavailable: no call could be placed in this run, the video still plays with its captions; tell the member and try again in a later run.",
	`A clip is kept only when the voice said its caption as written; a caption that did not come back as written in ${TRIES} tries is left silent and named in silent with what the voice said instead: write it more plainly with save_app and call again. Write captions for the ear: short plain sentences, numbers and amounts as they are said, no brackets and no symbols.`,
	'A video in two languages (captions written as { en: "…", da: "…" }) gets a clip for each caption in each language, the first language first, and languages in the answer counts each.',
	`voice is one of ${CLOUD_VOICE_NAMES.join(", ")} (default ${DEFAULT_VOICE}). When every caption is spoken, link the app in your message as [Title](app:<name>).`,
].join("\n");

const sha256hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface NarrateRequest {
	readonly name: string;
	readonly operationKey: string;
	readonly machine?: string;
	readonly voice: CloudVoiceName;
}

interface Caption {
	readonly text: string;
	readonly hash: string;
	readonly lang?: string;
}

type Line = Readonly<Record<string, unknown>>;

class VoiceUnavailable extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

class VoiceLimit extends Error {
	readonly limit = true;
}

class MachineGone extends Error {}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const stop = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}

function plain(text: unknown, max = 300): string {
	const flat = String(text)
		.replace(/[\0-\x1f\x7f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const chars = [...flat];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

export function narrateSpokenLine(caption: string): string {
	let open = true;
	const quoted = caption.replace(/"/g, () => {
		const mark = open ? "“" : "”";
		open = !open;
		return mark;
	});
	return `Speak exactly this line and nothing else: "${quoted}"`;
}

export function narrateLimitView(usage: CloudVoiceUsage | undefined): Record<string, JsonValue> | undefined {
	const fullest = [...(usage?.windows ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];
	const full = cloudVoiceUsageFull(usage);
	if (!fullest && !full) return undefined;
	const resetAt = full?.resetAt ?? fullest?.resetAt;
	return {
		...(fullest ? { usedPercent: Math.round(fullest.usedPercent) } : {}),
		...(resetAt ? { resetAt } : {}),
		reached: full !== undefined,
	};
}

function withScript(work: string, file: string, script: string, then: string): string {
	if (script.split("\n").includes(SCRIPT_END)) throw new Error("A kit script holds the script end");
	const command = `mkdir -p ${work} && cat > ${work}/${file} <<'${SCRIPT_END}' && ${then}\n${script.endsWith("\n") ? script : `${script}\n`}${SCRIPT_END}\n`;
	if (Buffer.byteLength(command) > COMMAND_MAX_BYTES) throw new Error("A narration command exceeds its bound");
	return command;
}

export function cloudNarrateAppTool(options: {
	binding: CloudNativeToolBinding;
	identity: CloudNativeToolIdentity;
	control: CloudCompanyPathControl;
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	machines: {
		gateway: CloudMachineCommandGateway;
		operations: Pick<CloudNativeToolOperations, "execute">;
	};
	voice: Pick<CloudVoiceChannel, "open" | "usage">;
	timing?: { now?: () => number; pollMs?: number; settleMs?: number };
}): CloudNativeTool {
	const binding = parseCloudNativeToolBinding(options.binding);
	const identity = Object.freeze({ ...options.identity });
	if (
		Object.entries(binding).some(
			([key, value]) => key !== "credentialCapsuleId" && identity[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Narrate tool binding differs");
	const { folder, operations, machines, voice } = options;
	const now = options.timing?.now ?? Date.now;
	const pollMs = options.timing?.pollMs ?? 250;
	const settleMs = options.timing?.settleMs ?? 1000;
	const owner = identity.staffAgentId.toLowerCase();
	const calls = new Map<
		string,
		{ digest: string; answer: Promise<{ text: string; reads: CloudCompanyFolderRelease[] }> }
	>();

	const check = (context: CloudToolContext): void => {
		if (
			context.runId !== identity.runId ||
			context.companyId !== identity.companyId ||
			!context.identity ||
			cloudToolJsonText(context.identity) !== cloudToolJsonText(identity)
		)
			throw new Error("Narrate tool identity differs");
		context.signal.throwIfAborted();
	};

	const runningMachine = async (
		name: string | undefined,
		signal: AbortSignal,
	): Promise<{ machineId: string; name: string }> => {
		let listed: Record<string, unknown>;
		try {
			listed = parseRecord(
				await cloudToolRequest(
					(requestSignal) =>
						options.control.call(
							"qorpera_native_machine_manage",
							{ p_binding: binding, p_request: { action: "list" } },
							requestSignal,
						),
					signal,
					10_000,
				),
				"Machine list differs",
			);
		} catch (error) {
			if (error instanceof CloudControlRpcRefused || error instanceof CloudCompanyPathRpcRefusal)
				throw new CloudToolRefusal("NOT_AVAILABLE: the company's machines cannot be read now; try again");
			throw error;
		}
		if (listed.schema !== "qorpera.machine-list/v1" || !Array.isArray(listed.machines))
			throw new Error("Machine list differs");
		const all = (listed.machines as unknown[]).filter(
			(item): item is { machineId: string; name: string; state: unknown } =>
				!!item &&
				typeof item === "object" &&
				typeof (item as { name?: unknown }).name === "string" &&
				MACHINE.test((item as { name: string }).name) &&
				isUuid((item as { machineId?: unknown }).machineId),
		);
		if (name === undefined) {
			const running = all.find((item) => item.state === "running");
			if (!running)
				throw new CloudToolRefusal(
					"MACHINE_NOT_RUNNING: the company has no running machine; start one with machine_start, and call narrate_app again once it runs",
				);
			return { machineId: running.machineId, name: running.name };
		}
		const found = all.find((item) => item.name === name);
		if (!found)
			throw new CloudToolRefusal(
				`MACHINE_NOT_FOUND: the company has no machine named ${name}; start one with machine_start, or name a running one from machine_list`,
			);
		if (found.state !== "running")
			throw new CloudToolRefusal(
				`MACHINE_NOT_RUNNING: ${name} is ${typeof found.state === "string" && /^[a-z_]{1,32}$/.test(found.state) ? found.state : "not running"}; wake it with machine_start (pass only machine with its name), or start a new one, and call narrate_app again once it runs`,
			);
		return { machineId: found.machineId, name: found.name };
	};

	const narrate = async (
		request: NarrateRequest,
		context: CloudToolContext,
	): Promise<{ text: string; reads: CloudCompanyFolderRelease[] }> => {
		const { signal } = context;
		if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const deadline = now() + BUDGET_MS;
		const left = () => deadline - now();
		const by = (ms: number) => Math.min(now() + ms, deadline);
		const root = appFolder(request.name) as string;
		const reads = new Map<string, CloudCompanyFolderRelease>();
		const read = (entry: CloudCompanyFolderEntry) =>
			reads.set(`${entry.path}\n${entry.version}`, cloudCompanyFolderRelease(entry));
		const answered = (answer: Record<string, JsonValue>) => ({
			text: cloudToolJsonText({
				schema: "qorpera.app-narrate/v1",
				app: request.name,
				operationKey: request.operationKey,
				...answer,
				link: `app:${request.name}`,
			}),
			reads: [...reads.values()],
		});

		let stored: Awaited<ReturnType<CloudCompanyFolderClient["readText"]>>;
		try {
			stored = await folder.readText(`${root}/${APP_MANIFEST}`, APP_MANIFEST_MAX_BYTES, signal);
		} catch (error) {
			if (error instanceof CloudCompanyPathNotText)
				throw new CloudToolRefusal(
					`APP_MANIFEST_UNREADABLE: ${root}/${APP_MANIFEST} is not text; save the app again with save_app`,
				);
			return unavailable(error, "read");
		}
		if (stored === null)
			throw new CloudToolRefusal("APP_NOT_FOUND: no app has that name; make the explainer with save_app first");
		read(stored.entry);
		const parsed = parseAppManifest(stored.text);
		if (!parsed.ok)
			throw new CloudToolRefusal(
				`APP_MANIFEST_INVALID: ${root}/${APP_MANIFEST} has problems; save the app again with save_app`,
			);
		if (parsed.manifest.kit !== "explainer")
			throw new CloudToolRefusal(
				"APP_NOT_AN_EXPLAINER: narrate_app speaks an explainer's captions, and this app is not one; make a video with save_app and manifest.kit explainer",
			);
		if (parsed.manifest.owner !== owner)
			throw new CloudToolRefusal(
				"APP_NOT_YOURS: this explainer is another agent's or a member's; narrate_app speaks only your own. Ask its owner to give it its voice",
			);
		const title = parsed.manifest.name;
		const listing = async () => {
			const entries: CloudCompanyFolderEntry[] = [];
			let after: string | undefined;
			for (;;) {
				const page = await folder
					.list(root, { recursive: true, ...(after === undefined ? {} : { after }) }, signal)
					.catch((error: unknown) => unavailable(error, "read"));
				entries.push(...page.entries);
				if (page.next === null) break;
				after = page.next;
			}
			for (const entry of entries) read(entry);
			return new Map(entries.map((entry) => [entry.path.slice(root.length + 1).toLowerCase(), entry]));
		};
		const byKey = await listing();
		if (byKey.get(EXPLAINER_PAGE)?.kind !== "file")
			throw new CloudToolRefusal(
				`APP_PAGE_MISSING: the explainer has no ${EXPLAINER_PAGE}; save it again with save_app, which writes its page`,
			);
		let listedText: string | null = null;
		if (byKey.get(EXPLAINER_CLIPS)?.kind === "file") {
			const found = await folder.readText(`${root}/${EXPLAINER_CLIPS}`, EXPLAINER_CLIPS_MAX_BYTES, signal).then(
				(value) => value,
				(error: unknown) => (error instanceof CloudCompanyPathNotText ? null : unavailable(error, "read")),
			);
			if (found) {
				read(found.entry);
				listedText = found.text;
			}
		}
		const before = new Map(
			(listedText === null ? [] : parseExplainerClips(listedText))
				.filter((clip) => byKey.get(`voice/${clip.file}`)?.kind === "file")
				.map((clip) => [clip.caption, clip]),
		);

		const machine = await runningMachine(request.machine, signal);
		const scope = { machineId: machine.machineId };
		const tag = sha256hex(`${identity.runId}:${context.callId}`).slice(0, 24);
		const work = `${WORK_ROOT}/${tag}`;
		let worked = false;
		const start = async (step: string, command: string, timeoutMs: number | null): Promise<string> => {
			const key = `narrate-app.${tag}.${step}`;
			const content = await machines.operations.execute({
				operation: {
					tool: "machine_run",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: key,
					arguments: {
						operationKey: key,
						machine: machine.name,
						command,
						...(timeoutMs === null ? {} : { timeoutMs }),
						notify: false,
					},
					target: { realm: "company_machine", machineId: machine.machineId },
					requiresCompanyRevision: false,
				},
				signal,
				authorize: async (_operation, admitted) => {
					if (!isDeepStrictEqual(admitted, identity)) throw new Error("Narrate command identity changed");
				},
				perform: async (_operation, effect) => {
					try {
						const receipt = await machines.gateway.start(
							scope,
							{
								commandId: effect.receiptId,
								inputSha256: effect.inputSha256,
								command,
								timeoutMs,
								notify: false,
							},
							effect.signal,
						);
						return { content: { kind: "json", value: receipt as unknown as JsonValue } };
					} catch (error) {
						const refusal = cloudMachineCommandRefusal(error);
						if (refusal === "MACHINE_NOT_RUNNING" || refusal === "MACHINE_COMMAND_ENDED")
							return { content: { kind: "json", value: { refused: refusal } } };
						throw error;
					}
				},
			});
			const value = content.kind === "json" ? content.value : null;
			if (value && typeof value === "object" && !Array.isArray(value) && typeof value.refused === "string")
				throw new MachineGone(value.refused);
			worked = true;
			return parseCloudMachineCommandReceipt(value).commandId;
		};
		const watch = (commandId: string) => {
			const lines: Line[] = [];
			const state = {
				offset: 0,
				partial: "",
				done: false,
				mounted: false,
				why: undefined as string | undefined,
				heldBack: undefined as string | undefined,
				said: "",
			};
			const take = (line: string) => {
				if (!line.startsWith(MARK)) {
					if (line.trim()) state.said = plain(`${state.said} ${line}`.slice(-600));
					return;
				}
				try {
					const value = JSON.parse(line.slice(MARK.length)) as unknown;
					if (value && typeof value === "object" && !Array.isArray(value)) lines.push(value as Line);
				} catch {
					return;
				}
			};
			const poll = async (until: number): Promise<boolean> => {
				let got: CloudMachineCommandReceipt;
				try {
					got = parseCloudMachineCommandReceipt(
						await cloudToolRequest(
							(requestSignal) =>
								machines.gateway.read(
									scope,
									parseCloudCodingCommandRead({ commandId, offset: state.offset, limit: COMMAND_MAX_BYTES }),
									requestSignal,
								),
							signal,
							Math.max(1, Math.min(CLOUD_MACHINE_READ_MS, until - now())),
						),
					);
				} catch (error) {
					signal.throwIfAborted();
					const refusal = cloudMachineCommandRefusal(error);
					if (refusal === "MACHINE_NOT_RUNNING" || refusal === "MACHINE_COMMAND_ENDED") state.done = true;
					return false;
				}
				const report = got.companyFolder;
				if (report) {
					if (report.company === "mounted") state.mounted = true;
					state.why = report.why;
					state.heldBack = report.heldBack;
				}
				state.partial += got.output;
				state.offset = got.log.nextOffset;
				for (;;) {
					const at = state.partial.indexOf("\n");
					if (at < 0) break;
					take(state.partial.slice(0, at));
					state.partial = state.partial.slice(at + 1);
				}
				if (Buffer.byteLength(state.partial) > LINE_MAX_BYTES) state.partial = "";
				const ended = got.state !== "running" && got.state !== "unconfirmed";
				if (ended && state.offset >= got.log.totalBytes && report?.heldBack === undefined) {
					if (state.partial) take(state.partial);
					state.partial = "";
					state.done = true;
				}
				return got.output !== "";
			};
			const until = async (find: (line: Line) => boolean, end: number): Promise<Line | undefined> => {
				for (;;) {
					const found = lines.find(find);
					if (found) return found;
					if (state.done || now() >= end) return undefined;
					if (!(await poll(end))) await pause(Math.max(1, Math.min(pollMs, end - now())), signal);
				}
			};
			const look = async (): Promise<void> => {
				const end = now() + CLOUD_MACHINE_READ_MS;
				while (!state.done && now() < end && (await poll(end)));
			};
			return { lines, state, until, look };
		};
		const ended = (line: Line | undefined) => (line && "ended" in line ? plain(line.ended) : undefined);
		const usageNow = (): Promise<CloudVoiceUsage | undefined> =>
			withAbortScopes([signal], (usageSignal) => voice.usage(usageSignal), USAGE_MS).catch(() => undefined);

		try {
			const reader = watch(
				await start(
					"captions",
					withScript(
						work,
						"voice-captions.cjs",
						EXPLAINER_VOICE_CAPTIONS_CJS,
						`node ${work}/voice-captions.cjs /company/${root}/${EXPLAINER_PAGE}`,
					),
					CAPTIONS_MS + 30_000,
				),
			);
			const told = await reader.until((line) => "captions" in line || "problem" in line, by(CAPTIONS_MS));
			if (!reader.state.mounted)
				throw new CloudToolRefusal(
					`NARRATE_NO_COMPANY_FOLDER: ${machine.name} has no /company on this boot${reader.state.why ? ` (${plain(reader.state.why)})` : ""}, so it cannot open the app; start a machine of your own with machine_start, whose commands see the company folder, and call narrate_app with it as machine`,
				);
			if (!told) {
				if (reader.state.heldBack)
					throw new CloudToolRefusal(
						`NARRATE_OUTPUT_HELD: the machine's answer is held back (${plain(reader.state.heldBack)}); call narrate_app again with a new operationKey`,
					);
				throw new CloudToolRefusal(
					`NARRATE_CAPTIONS_UNREAD: the machine did not read the video's captions${reader.state.said ? `: ${reader.state.said}` : ""}; call narrate_app again with a new operationKey`,
				);
			}
			if ("problem" in told)
				throw new CloudToolRefusal(
					`APP_VIDEO_PROBLEM: the video's page says: ${plain(told.problem)}. Fix scenes.js with save_app, look at the page on a machine, then call narrate_app again`,
				);
			const captions: Caption[] = [];
			const seen = new Set<string>();
			for (const item of Array.isArray(told.captions) ? (told.captions as unknown[]) : []) {
				const { text, lang } = (item && typeof item === "object" ? item : {}) as { text?: unknown; lang?: unknown };
				if (typeof text !== "string" || !text.trim()) continue;
				const hash = captionHash(text);
				if (seen.has(hash)) continue;
				seen.add(hash);
				captions.push({ text, hash, ...(typeof lang === "string" && LANGUAGE.test(lang) ? { lang } : {}) });
			}
			if (captions.length === 0)
				throw new CloudToolRefusal(
					'APP_NO_CAPTIONS: the video has no caption to speak; give its scenes captions with s.say("…") in scenes.js (save_app), then call narrate_app again',
				);
			if (captions.length > MAX_CAPTIONS)
				throw new CloudToolRefusal(
					`APP_TOO_MANY_CAPTIONS: the video has ${captions.length} captions and narrate_app speaks at most ${MAX_CAPTIONS}; cut it to the one thing it explains with save_app, then call narrate_app again`,
				);

			const codes = [
				...new Set(captions.map((caption) => caption.lang).filter((code): code is string => code !== undefined)),
			];
			const tally = (spoken: (hash: string) => boolean): Record<string, JsonValue> => {
				const count = captions.filter((caption) => spoken(caption.hash)).length;
				return {
					captions: captions.length,
					spoken: count,
					left: captions.length - count,
					...(codes.length > 1
						? {
								languages: Object.fromEntries(
									codes.map((code) => {
										const own = captions.filter((caption) => caption.lang === code);
										const said = own.filter((caption) => spoken(caption.hash)).length;
										return [code, { captions: own.length, spoken: said, left: own.length - said }];
									}),
								),
							}
						: {}),
				};
			};
			const spokenBefore = captions.filter((caption) => before.has(caption.hash)).length;
			const todo = captions.filter((caption) => !before.has(caption.hash));
			const shown = `Show it to the member with a link in your message: [${title}](app:${request.name}).`;
			if (todo.length === 0)
				return answered({
					state: "spoken",
					voice: request.voice,
					...tally((hash) => before.has(hash)),
					spokenNow: 0,
					spokenBefore,
					next: `Every caption is spoken. ${shown}`,
				});
			const limited = (usage: CloudVoiceUsage | undefined): string => {
				const resetAt = cloudVoiceUsageFull(usage)?.resetAt;
				return `The ChatGPT login this run works on is at its usage limit${resetAt ? `, which resets at ${resetAt}` : ""}: no more captions can be recorded until then`;
			};
			const nothingRecorded = (usage: CloudVoiceUsage | undefined) => {
				const limit = narrateLimitView(usage);
				return answered({
					state: "limit_reached",
					voice: request.voice,
					...tally((hash) => before.has(hash)),
					spokenNow: 0,
					spokenBefore,
					limit: { ...limit, reached: true },
					next: `${limited(usage)}. No call was placed and nothing changed; the video plays with its captions${spokenBefore > 0 ? ` and the ${spokenBefore} ${spokenBefore === 1 ? "clip" : "clips"} it has` : " alone"}. Tell the member, and call narrate_app again after the reset with a new operationKey.`,
				});
			};

			const reading = await usageNow();
			if (cloudVoiceUsageFull(reading)) return nothingRecorded(reading);

			const peerSeconds = Math.max(10, Math.min(290, Math.floor(left() / 1000) - 5));
			const peerId = await start(
				"peer",
				withScript(
					work,
					"voice-peer.cjs",
					EXPLAINER_VOICE_PEER_CJS,
					`exec node ${work}/voice-peer.cjs ${work} ${peerSeconds} ${FINISHING_SECONDS}`,
				),
				(peerSeconds + 60) * 1000,
			);
			const peer = watch(peerId);
			let call: CloudVoiceCall | undefined;
			let peerEnded: string | undefined;
			let peerStopped = false;
			const stopPeer = async () => {
				peerStopped = true;
				const stopped =
					!signal.aborted &&
					(await start("stop", `touch ${work}/stop`, 30_000).then(
						() => true,
						() => false,
					));
				const last = stopped
					? await peer.until((line) => "ended" in line, by(ENDED_MS)).catch(() => undefined)
					: undefined;
				peerEnded = ended(last);
				if (!last && !peer.state.done)
					await withAbortScopes(
						[],
						(cancelSignal) => machines.gateway.cancel(scope, peerId, cancelSignal),
						10_000,
					).catch(() => undefined);
			};
			const kept: { turn: number; caption: Caption }[] = [];
			const silent: { caption: string; said: string }[] = [];
			let callEnded: string | undefined;
			let limitMet = false;
			let heard = 0;
			let unanswered = false;
			const turnsPrinted = () =>
				peer.lines.reduce((most, line) => (typeof line.turn === "number" ? Math.max(most, line.turn) : most), 0);
			const unasked = (): void => {
				if (kept.at(-1)?.turn === heard) kept.pop();
				callEnded ??= "the recorder heard a turn that was not asked for";
			};
			try {
				try {
					const offer = await peer.until(
						(line) => typeof line.offer === "string" || "ended" in line,
						by(OFFER_MS),
					);
					if (typeof offer?.offer !== "string")
						throw new VoiceUnavailable(
							`the machine's voice recorder did not start${ended(offer) ? ` (${ended(offer)})` : ""}`,
						);
					try {
						call = await voice.open({ offerSdp: offer.offer, voice: request.voice }, signal);
					} catch (error) {
						signal.throwIfAborted();
						if (error instanceof CloudVoiceLimitReached) throw new VoiceLimit();
						throw new VoiceUnavailable(
							error instanceof CloudVoiceUnavailable
								? "no voice call can be placed in this run"
								: "the voice call could not be placed",
						);
					}
					const answer = call.answerSdp.endsWith("\n") ? call.answerSdp : `${call.answerSdp}\n`;
					const handover = `mkdir -p ${work} && printf '%s' '${Buffer.from(answer, "utf8").toString("base64")}' | base64 -d > ${work}/answer.sdp.part && mv -f ${work}/answer.sdp.part ${work}/answer.sdp`;
					if (Buffer.byteLength(handover) > COMMAND_MAX_BYTES)
						throw new VoiceUnavailable("the call's answer is too large to hand to the machine");
					await start("answer", handover, 30_000);
					const connected = await peer.until(
						(line) => line.connected === true || "ended" in line,
						by(CONNECTED_MS),
					);
					if (connected?.connected !== true)
						throw new VoiceUnavailable(
							`the call did not reach the machine's recorder${ended(connected) ? ` (${ended(connected)})` : ""}`,
						);
				} catch (error) {
					if (!(error instanceof VoiceUnavailable) && !(error instanceof VoiceLimit)) throw error;
					await call?.close();
					call = undefined;
					await stopPeer();
					const after = await usageNow();
					if (error instanceof VoiceLimit || cloudVoiceUsageFull(after)) return nothingRecorded(after);
					return answered({
						state: "unavailable",
						voice: request.voice,
						reason: `The voice could not be had in this call: ${error.reason}.`,
						...tally((hash) => before.has(hash)),
						spokenNow: 0,
						spokenBefore,
						next: "Nothing was saved, and the video plays with its captions and the clips it has. Tell the member its voice is not complete yet, and call narrate_app again in a later run with a new operationKey.",
					});
				}

				batch: for (const caption of todo) {
					if (left() < RESERVE_MS) break;
					const line = narrateSpokenLine(caption.text);
					if (Buffer.byteLength(line) > MAX_CLOUD_VOICE_TEXT_BYTES) {
						silent.push({ caption: plain(caption.text, SHOWN_CHARS), said: "" });
						continue;
					}
					let said = "";
					for (let attempt = 1; attempt <= TRIES; attempt++) {
						if (left() < RESERVE_MS) break batch;
						await peer.look();
						if (turnsPrinted() > heard) {
							unasked();
							break batch;
						}
						try {
							const activeCall = call;
							said = (
								await withAbortScopes(
									[signal],
									(speakSignal) => activeCall.speak(line, speakSignal),
									Math.max(1, Math.min(SPEAK_MS, left())),
								)
							).transcript;
						} catch (error) {
							signal.throwIfAborted();
							limitMet = error instanceof CloudVoiceLimitReached;
							callEnded = "the call ended";
							unanswered = true;
							break batch;
						}
						heard += 1;
						const turn = heard;
						const recorded = await peer.until((found) => found.turn === turn || "ended" in found, by(TURN_MS));
						if (recorded?.turn !== turn) {
							callEnded =
								recorded && "ended" in recorded ? "the recorder ended" : "a recording did not arrive in time";
							break batch;
						}
						if (explainerSpokenMatches(caption.text, said)) {
							kept.push({ turn, caption });
							break;
						}
						if (attempt === TRIES)
							silent.push({ caption: plain(caption.text, SHOWN_CHARS), said: plain(said, SHOWN_CHARS) });
					}
				}
			} finally {
				await call?.close();
				if (!peerStopped) await stopPeer();
			}
			if (turnsPrinted() > heard + (unanswered ? 1 : 0)) unasked();
			const after = callEnded ? await usageNow() : reading;
			if (callEnded && cloudVoiceUsageFull(after)) limitMet = true;

			const written = new Map<string, ExplainerClip>();
			const printed = new Set(peer.lines.filter((line) => typeof line.turn === "number").map((line) => line.turn));
			const encodable = kept.filter((each) => printed.has(each.turn));
			if (encodable.length > 0) {
				const encoder = watch(
					await start(
						"encode",
						withScript(
							work,
							"voice-encode.cjs",
							EXPLAINER_VOICE_ENCODE_CJS,
							`node ${work}/voice-encode.cjs ${work} /company/${root}/voice ${encodable.map((each) => `${each.turn}:${each.caption.hash}`).join(" ")}`,
						),
						ENCODE_MS + 30_000,
					),
				);
				const wanted = new Set(encodable.map((each) => each.caption.hash));
				await encoder.until(() => false, Math.max(by(ENCODE_MS), now() + 1));
				for (const line of encoder.lines) {
					if (typeof line.clip !== "string" || !wanted.has(line.clip) || "problem" in line) continue;
					const clip = parseExplainerClips(
						JSON.stringify({ clips: [{ caption: line.clip, file: line.file, seconds: line.seconds }] }),
					)[0];
					if (clip) written.set(clip.caption, clip);
				}
			}
			let fresh = await listing();
			const shows = (clip: ExplainerClip) => fresh.get(`voice/${clip.file}`)?.kind === "file";
			for (let tries = 0; tries < 4 && [...written.values()].some((clip) => !shows(clip)); tries++) {
				await pause(settleMs, signal);
				fresh = await listing();
			}
			for (const [hash, clip] of written) if (!shows(clip)) written.delete(hash);
			const clips = captions
				.map((caption) => written.get(caption.hash) ?? before.get(caption.hash))
				.filter((clip): clip is ExplainerClip => clip !== undefined);
			const leftOver = captions.length - clips.length;
			const limit = narrateLimitView(after);
			const counts = {
				voice: request.voice,
				...tally((hash) => written.has(hash) || before.has(hash)),
				spokenNow: written.size,
				spokenBefore,
				...(limitMet ? { limit: { ...limit, reached: true } } : limit ? { limit } : {}),
				...(silent.length > 0 ? { silent } : {}),
				...(limitMet
					? {}
					: peerEnded !== undefined && peerEnded !== "stop" && peerEnded !== "time"
						? { recorder: `The recorder ended early: ${peerEnded}.` }
						: callEnded
							? { recorder: `The batch stopped early: ${callEnded}.` }
							: {}),
			};
			const stateOf = (): string => (leftOver === 0 ? "spoken" : limitMet ? "limit_reached" : "partly_spoken");
			const rewrite =
				silent.length > 0
					? " The captions in silent did not come back as written: write them more plainly for the ear with save_app first."
					: "";
			const next = (state: string): string =>
				state === "spoken"
					? `Every caption is spoken. ${shown}`
					: state === "limit_reached"
						? `${limited(after)}. ${written.size === 0 ? "Nothing was recorded in this call" : `What this call recorded is saved (${written.size} ${written.size === 1 ? "caption" : "captions"})`}; ${leftOver} ${leftOver === 1 ? "caption is" : "captions are"} left and ${leftOver === 1 ? "plays" : "play"} without sound. Tell the member, and call narrate_app again after the reset with a new operationKey.${rewrite}`
						: `${leftOver} ${leftOver === 1 ? "caption is" : "captions are"} still silent: call narrate_app again with a new operationKey.${rewrite}`;
			if (written.size === 0) return answered({ state: stateOf(), ...counts, next: next(stateOf()) });

			const list = `${JSON.stringify({ voice: request.voice, clips }, null, 1)}\n`;
			const page = explainerPage(title, clips);
			const units: CloudCompanyFolderUnit[] = [];
			for (const [relative, text, mediaType] of [
				[EXPLAINER_CLIPS, list, "application/json"],
				[EXPLAINER_PAGE, page, "text/html"],
			] as const) {
				const found = fresh.get(relative);
				if (found !== undefined && found.kind !== "file")
					throw new CloudToolRefusal(`APP_NOT_A_FILE: ${root}/${relative} is a folder or a link`);
				if (found?.kind === "file" && found.file.fileSha256 === sha256hex(text)) continue;
				units.push(
					found?.kind === "file"
						? {
								op: "write",
								path: found.path,
								content: { text, mediaType: found.file.mediaType, executable: found.file.executable },
								expectedVersion: found.version,
							}
						: { op: "write", path: `${root}/${relative}`, content: { text, mediaType } },
				);
			}
			const listSaved = (results: readonly CloudCompanyFolderUnitResult[]) =>
				(results.find((unit) => unit.path.toLowerCase() === `${root}/${EXPLAINER_CLIPS}`)?.outcome ?? "saved") ===
				"saved";
			const content = await operations.execute({
				operation: {
					tool: "narrate_app",
					toolVersion: TOOL_VERSION,
					logicalOperationKey: request.operationKey,
					arguments: { name: request.name, machine: machine.name, voice: request.voice },
					target: { path: root },
					requiresCompanyRevision: true,
				},
				authorize: async () => {},
				refused: cloudFolderRefusal,
				perform: async (_operation, { receiptId, signal: commitSignal }) => {
					const committed = await folder.commit(
						`narrate_app:${sha256hex(request.operationKey)}`,
						units,
						{ receiptId },
						commitSignal,
					);
					if (committed.units.length !== units.length)
						throw new Error("Company folder commit answered other units");
					const listed = listSaved(committed.units);
					const state = listed ? stateOf() : "not_saved";
					return {
						content: {
							kind: "text",
							value: answered({
								state,
								receiptId,
								...counts,
								...(listed ? {} : { ...tally((hash) => before.has(hash)), spokenNow: 0 }),
								files: committed.units.map((unit) => ({
									path: unit.path,
									outcome: unit.outcome,
									...(unit.reason ? { reason: unit.reason } : {}),
								})),
								next: listed
									? next(state)
									: "The clips were recorded but their list was not saved (files says why): call narrate_app again with a new operationKey.",
							}).text,
						},
						folderCommitId: committed.commitId,
						...(committed.units.some((unit) => unit.outcome === "waiting_for_review")
							? { proposed: true as const }
							: {}),
					};
				},
				signal,
				...(context.observation ? { observation: context.observation } : {}),
			});
			if (content.kind !== "text") throw new Error("A narration answered no text");
			return { text: content.value, reads: [...reads.values()] };
		} catch (error) {
			if (error instanceof MachineGone)
				throw new CloudToolRefusal(
					`MACHINE_NOT_RUNNING: ${machine.name} stopped while the voice was being made, and nothing was saved; wake it with machine_start, then call narrate_app again with a new operationKey`,
				);
			throw error;
		} finally {
			if (worked && !signal.aborted) await start("clean", `rm -rf -- ${work}`, 30_000).catch(() => undefined);
		}
	};

	const tool: CloudNativeTool = {
		name: "narrate_app" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		description: CLOUD_NARRATE_APP_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["name", "operationKey"],
			properties: {
				name: { type: "string", maxLength: 64 },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				machine: { type: "string", pattern: MACHINE.source },
				voice: { type: "string", enum: [...CLOUD_VOICE_NAMES] },
			},
		},
		parseArguments(value) {
			const given = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
			const input = args(
				given
					? {
							...given,
							...(Object.hasOwn(given, "voice") ? {} : { voice: DEFAULT_VOICE }),
							...(Object.hasOwn(given, "machine") ? {} : { machine: null }),
						}
					: value,
				"narrate_app",
				["name", "operationKey", "machine", "voice"],
			);
			if (typeof input.name !== "string" || !isInterfaceName(input.name))
				throw new CloudToolArgumentRefusal(
					"name must be the explainer's folder name: lowercase a–z, digits and single hyphens, like pricing-video",
				);
			const machine = input.machine === null ? undefined : input.machine;
			if (machine !== undefined && (typeof machine !== "string" || !MACHINE.test(machine)))
				throw new CloudToolArgumentRefusal(
					"machine must be the name of a running company machine, as machine_list gives it, or left out",
				);
			if (!isCloudVoiceName(input.voice))
				throw new CloudToolArgumentRefusal(`voice must be one of ${CLOUD_VOICE_NAMES.join(", ")}`);
			const request: NarrateRequest = {
				name: input.name,
				operationKey: operationKey(input.operationKey),
				...(machine === undefined ? {} : { machine }),
				voice: input.voice,
			};
			return request as unknown as JsonValue;
		},
		refused: cloudFolderRefusal,
		async execute(value, context) {
			check(context);
			const request = value as unknown as NarrateRequest;
			const digest = sha256hex(cloudToolJsonText(request as unknown as JsonValue));
			let running = calls.get(request.operationKey);
			if (running && running.digest !== digest)
				throw new CloudToolRefusal(
					"OPERATION_KEY_REUSED: this operationKey was used for another app, machine or voice; use a new one",
				);
			if (!running) {
				const answer = narrate(request, context);
				running = { digest, answer };
				calls.set(request.operationKey, running);
				answer.catch(() => {
					if (calls.get(request.operationKey)?.answer === answer) calls.delete(request.operationKey);
				});
			}
			const { text, reads } = await running.answer;
			try {
				return await released(folder, identity.runId, context, text, reads);
			} catch (error) {
				if (error instanceof CloudToolRefusal)
					throw new Error("A narration's answer could not be released", { cause: error });
				throw error;
			}
		},
	};
	return tool;
}
