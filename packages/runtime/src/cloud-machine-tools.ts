import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	CLOUD_CODING_COMMAND_PAGE_BYTES,
	CLOUD_MACHINE_FOLDER_LIMITS,
	CLOUD_MACHINE_FOLDER_LOST,
	type CloudCodingCommandRead,
	type CloudMachineCommandFolder,
	type CloudMachineCommandReceipt,
	cloudMachineFolderBytes,
	isCloudMachineFolderLost,
	isUuid,
	type JsonValue,
	parseCloudCodingCommandRead,
	parseCloudMachineCommandFolder,
	parseCloudMachineCommandReceipt,
	UUID_PATTERN,
} from "@qorpera/contracts";
import { CODING_VALUE_REPOSITORY, codingValueNameAllowed } from "./cloud-coding-value-names.ts";
import type {
	CodingValueCaptureAnswer,
	CodingValueCaptureCall,
	CodingValueCaptureRequest,
	CodingValuePrepareAnswer,
	CodingValueRefusal,
} from "./cloud-coding-value-vault.ts";
import { CLOUD_COMMAND_PAGE_ASK, cloudCommandFits, fitCloudCommandPage } from "./cloud-command-page-fit.ts";
import { COMPANY_COMPUTER_SITE_STOP_MESSAGE } from "./cloud-company-computer-site-stops.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import { FolderImageRefusal, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import {
	CLOUD_MACHINE_TOOL_VERSION,
	CloudMachineAccountFillRefusal,
	type CloudMachineAccountFillRefusalCode,
	CloudMachineCodingValueRefusal,
	type CloudMachineCodingValueRefusalCode,
	type CloudMachineCommandGateway,
	CloudMachineCommandRefusal,
	CloudMachineCommandUnanswered,
	type CloudMachineScreenAnswer,
	type CloudMachineScreenInput,
	CloudMachineScreenRefusal,
	type CloudMachineScreenRefusalCode,
	cloudMachineCommandHead,
	cloudMachineCommandRefusal,
} from "./cloud-machine-command-http.ts";
import {
	MACHINE_SCREEN_MAX_SETTLE_MS,
	MACHINE_SCREEN_REVIEWED_VERBS,
	MACHINE_SCREEN_VERBS,
	type MachineScreenAction,
	machineScreenDefaultSettleMs,
	parseMachineScreenAction,
} from "./cloud-machine-screen.ts";
import {
	CLOUD_SCRIPT_FILES,
	type CloudCommandScriptRun,
	type CloudScriptEntry,
	cloudCommandScripts,
	cloudScriptContents,
	cloudScriptIdentity,
	cloudScriptNotRead,
	cloudScriptReadProgram,
	parseCloudPreparedScripts,
	parseCloudScriptRead,
} from "./cloud-machine-script-review.ts";
import {
	CLOUD_TOOL_REQUEST_MAX_MS,
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	CloudControlRefusalRelay,
	type CloudNativeTool,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	MAX_CLOUD_TOOL_RESULT_BYTES,
} from "./cloud-native-tool-boundary.ts";
import { type CloudNativeToolOperations, cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/** The vault, for save_coding_value (20260930705000): the same two calls an office's capture of a coding value makes
 * (HttpCloudSecretBrokerClient): the value's capture key before the machine reads its clipboard, and the box after. */
export interface CloudMachineCodingValues {
	codingValuePrepare(
		call: CodingValueCaptureCall,
		signal: AbortSignal,
	): Promise<CodingValuePrepareAnswer | CodingValueRefusal>;
	codingValueCapture(
		request: CodingValueCaptureRequest,
		signal: AbortSignal,
	): Promise<CodingValueCaptureAnswer | CodingValueRefusal>;
}

// Machines (2026-09-28): virtual machines an agent starts for tests, builds
// and long jobs, of the size it picks, on the company's own nodes. The
// cloud derives the company, the agent and the run; the model chooses only
// names, sizes, commands and handles. Starting and running are receipted
// operations (exactly once per operationKey); stopping and deleting are
// desired states the machine's executor carries out.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** How long machine_run's start may take, in all, with its sends again: the limit of one tool request. */
export const CLOUD_MACHINE_START_ANSWER_MS = CLOUD_TOOL_REQUEST_MAX_MS;
/** How long machine_read waits: what the gateway and the executor give one request, not the 5 s of a database read. It
 * crosses the executor and the machine (0.7 s when all is well), and one given up sooner costs the agent a model round
 * to ask again. A read leaves nothing open, so it is not sent again. */
export const CLOUD_MACHINE_READ_MS = 30_000;
/** How often a waiting worker looks at the machine's status again, when no word from its executor ends the wait first. */
const WAIT_STEP_MS = 5000;
/** How long a run waits for the executor to take a wake it does not wait on. A lost word costs only the executor's next
 * pass, 10 s at most. */
const WAKE_SENT_MS = 2000;
/** How many times a waiting start asks the machine's executor for a word: a machine in line is placed first and boots
 * after, each a step the executor tells of (agent-box B1). */
const WAKE_WORDS = 3;
const SCRIPT_READ_MS = 20_000;
const SCRIPT_START_MS = 15_000;
const SCRIPT_READ_POLL_MS = 300;
const REMEMBERED_SCRIPTS = 64;
/** How long a run gives its report of a wait (20260930755000): beside the answer, never holding it long. */
const WAIT_REPORT_MS = 5000;

/** A pause that the run's abort ends early. */
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

/** The company folder's report on a read asked again with a smaller page: the executor says each path it let go unsaved
 * once (F3 6e-2a, `notSaved`), so the report shown keeps those of the tries before, within the report's limits, and
 * counts the rest. The paths still not saved (`stillNotSaved`) come on every try, so the last try's are shown, as is
 * the rest of its report; over the bytes they go first, as the next receipt says them again. */
function carried(
	before: CloudMachineCommandFolder | undefined,
	folder: CloudMachineCommandFolder | undefined,
): CloudMachineCommandFolder | undefined {
	if (!before) return folder;
	if (!folder) return before;
	const {
		notSaved: _notSaved,
		moreNotSaved: _more,
		stillNotSaved: lastStill,
		moreStillNotSaved: lastMoreStill,
		...rest
	} = folder;
	const listed = [...(before.notSaved ?? []), ...(folder.notSaved ?? [])];
	let more = (before.moreNotSaved ?? 0) + (folder.moreNotSaved ?? 0);
	const still = [...(lastStill ?? [])];
	let moreStill = lastMoreStill ?? 0;
	const shown = (): CloudMachineCommandFolder => ({
		...rest,
		...(listed.length ? { notSaved: listed } : {}),
		...(more ? { moreNotSaved: more } : {}),
		...(still.length ? { stillNotSaved: still } : {}),
		...(moreStill ? { moreStillNotSaved: moreStill } : {}),
	});
	while (listed.length > CLOUD_MACHINE_FOLDER_LIMITS.notSaved) {
		listed.pop();
		more++;
	}
	while (still.length && cloudMachineFolderBytes(shown()) > CLOUD_MACHINE_FOLDER_LIMITS.bytes) {
		still.pop();
		moreStill++;
	}
	while (listed.length && cloudMachineFolderBytes(shown()) > CLOUD_MACHINE_FOLDER_LIMITS.bytes) {
		listed.pop();
		more++;
	}
	return parseCloudMachineCommandFolder(shown());
}

/** The least a machine with a desktop has: what machine_start's desktop true asks for, and what the machine's own
 * `desktop start` wants before it starts one (deploy/machine/desktop, MIN_CPUS and MIN_MEMORY_KB). */
export const CLOUD_MACHINE_DESKTOP_LEAST = Object.freeze({ cpus: 2, memoryGiB: 4 });
/** Only a company agent's run shares an app (share_app, v195): a worker's machine tools leave these out. */
const SHARE_APP_START =
	"To let members open a server in their browser, run it on an always-on machine and share its port with share_app.";
const SHARE_APP_RUN = "To let members open one in their browser, share its port with share_app.";
/** How long machine_start waits for its machine in one call (agent-box B1, 13 Nov 2026). It waits by default, for
 * `byDefault` seconds, unless waitSeconds asks for less (0: not at all) or, in a worker's run, for more: a wait the model
 * must remember to ask for mostly does not happen (v244's first live start did not ask). A boot is p50 15 to 23 s, p90
 * 28 to 31 s, and a new machine is often first in line for about 2 s while its node's executor frees a sleeping machine's
 * disk (22 of 36 new machines, 7 to 13 Nov), so the wait goes on through that line too. A conversation's run holds its
 * slot and its conversation meanwhile (one run of an agent at a time: a member's next message waits for it), so its wait
 * is a minute at most; past it the run is woken when the machine runs, as before (20260930747000). A worker has no
 * conversation to be woken in: it may wait up to 300 s a call. */
export const CLOUD_MACHINE_START_WAIT_SECONDS = Object.freeze({ worker: 300, conversation: 60, byDefault: 60 });
const CONVERSATION_START_WAIT = `The call waits up to ${CLOUD_MACHINE_START_WAIT_SECONDS.byDefault} s while it starts, with no model turn spent (waitSeconds: less, 0 for none); if it is not running yet, finish this run normally: you are woken when it runs. `;
/** Why an agent asks for more than the default 2 cpus (Jonas, 13 Nov 2026, on renders that did not look real: custom
 * machines are "built, just not used well enough"). No machine had been started with more than 4 cpus, and the agent
 * whose render raised the question ran Blender with -t 2 on a default machine. The figures are measured
 * (deploy/machine/README.md, "Sizing a machine for the job": one full HD Cycles frame at 256 samples with
 * OpenImageDenoise on a 7950X): 22 minutes on 2 threads, 5 on 8, the same processor seconds either way.
 * Computer hours count max(cpus / 4, GiB / 8) times the time awake (RUNTIME-COMPUTER-HOURS.md), so 8 cpus for a
 * quarter of the time cost what 2 cpus cost, while an idle hour before a large machine sleeps costs more than the job
 * did: hence machine_stop. */
const MACHINE_SIZE_FOR_THE_JOB =
	"Rendering, encoding and big builds use every cpu: a frame that takes 22 minutes on 2 cpus takes 5 on 8, and hours count size times time awake, so it costs the same: start 8 cpus and 8 GiB, tell the program to use them all, and stop the machine with machine_stop when done.";
export const CLOUD_MACHINE_START_DESCRIPTION = [
	"Start a machine: a whole Linux virtual machine on the company's own servers, for tests, builds, Docker stacks and long jobs. You are root. Docker with Compose, Node 24, Python 3, Git, build tools, Playwright with its Chromium (require('playwright')), a chromium command, ffmpeg and Blender (with real light, materials and furniture for renders: read /opt/qorpera-assets/README.md) are installed; install anything else. Checking a page, taking pictures of it or filming it needs no screen.",
	`Size: cpus, memoryGiB and diskGiB, limited only by what one server holds. ${MACHINE_SIZE_FOR_THE_JOB}`,
	"Desktop: desktop true gives it a screen, for work that needs one, such as testing a product the way a person uses it or driving an app's interface. On it, with machine_run: desktop start <company files, folders or URLs> starts the desktop and opens each (a folder under /company with an index.html, or an .html file, opens as a site served from the company folder, so a change shows after a reload; add --lang da-DK --tz Europe/Copenhagen for a Danish company); desktop run <program> starts a program; desktop stop when the work is done; desktop help lists the rest. machine_screen sees and drives the screen.",
	`Lifetime (task or always-on): a task machine's program busy for hours brings check-ins, and a server on it that only waits stops when it sleeps (your next run is told). ${SHARE_APP_START}`,
	"Disk: kept while the machine sleeps. It comes back empty only when its server ran out of disk, had no room for it at the wake, or is gone or moved; the result then says diskFreed. Keep what matters in the company's files. Newer preinstalled tools come only on new machines. Commands see the company folder at /company when the agent and member that started it may read all of it; a coding session's work is at /company/code/<owner>/<name>/worktrees/<workerId>.",
	"A new task machine is one of your own again when one of that size is free (woken if asleep): the result says reused; use its name.",
	"The machine is the company's: every member sees it and can stop it, and any agent of the company may use it. It holds no credentials or logins; it reaches the internet but no private network, and nothing reaches it from outside.",
	`The result says its state. With no room on any server it waits in line and gives its place. When the company is out of computer hours it waits until hours are added (waitingFor COMPUTER_HOURS_EXHAUSTED); an hour after the company runs out, its running machines sleep, keeping their disks, and wake by themselves once hours are added. ${CONVERSATION_START_WAIT}refused started nothing and says why (the name is taken, too large for any server, no such machine).`,
].join("\n");
/** A worker (an agent's background helper) is never woken: it has no conversation to continue. */
export const CLOUD_MACHINE_START_WORKER_DESCRIPTION = CLOUD_MACHINE_START_DESCRIPTION.replace(
	` ${SHARE_APP_START}`,
	"",
).replace(
	CONVERSATION_START_WAIT,
	`You are a worker: nothing wakes you. The call waits up to ${CLOUD_MACHINE_START_WAIT_SECONDS.byDefault} s while it starts, with no model turn spent (waitSeconds: 0 to ${CLOUD_MACHINE_START_WAIT_SECONDS.worker}); to wait longer, call machine_start again with the same operationKey and arguments. ` +
		"If it still waits in line for room, use another running machine from machine_list, or say in your report that it is waiting so your agent can retry. ",
);
/** What a command's result says of the company folder (F3 6e-2a). */
const FOLDER_REPORT =
	"companyFolder, on a machine with the company folder: company says whether this boot of the machine has /company (mounted, pending, or none with why); heldBack, why the output and the end are not shown yet; notSaved, the files the company folder did not save from the machine and let go, with why, each said once (moreNotSaved counts the rest); stillNotSaved, the files it did not save but holds to try again, with why, said on every result while that lasts (moreStillNotSaved counts the rest); lost, why the machine lost a lost command, also on a MACHINE_COMMAND_ENDED refusal.";
const RUN_NOTIFY =
	"With notify true you are woken when it ends, with its exit status and the end of its output: then finish your run instead of waiting. Without notify, read the handle with machine_read.";
export const CLOUD_MACHINE_RUN_DESCRIPTION = [
	"Run a shell command as root on a running machine (a bash login shell in /root). It returns a durable command handle, read once at once as machine_read reads it, with nothing waiting for the command: one that already ended shows its exit status and as much output as one result holds. running is not success.",
	`The command has no time limit unless you set timeoutMs; it keeps running after your turn ends, until it exits, you cancel it or the machine stops. Start servers and stacks with it too (docker compose up -d, npm run dev); on a task machine one that only waits stops when the machine sleeps, so keep a server up on an always-on machine. ${SHARE_APP_RUN}`,
	`${RUN_NOTIFY} Never start a command again to recover its output.`,
	"refused started nothing: the machine is not running, or the start with this operationKey was given up (start it again with a new operationKey).",
	FOLDER_REPORT,
].join("\n");
/** A worker waits for its commands within its own run. */
export const CLOUD_MACHINE_RUN_WORKER_DESCRIPTION = CLOUD_MACHINE_RUN_DESCRIPTION.replace(
	` ${SHARE_APP_RUN}`,
	"",
).replace(
	RUN_NOTIFY,
	"You are a worker: nothing wakes you. Wait for it with machine_read and waitSeconds (up to 300 per call, no model turn is spent while waiting), and read again until it ends.",
);
export const CLOUD_MACHINE_READ_DESCRIPTION = [
	"Read a machine command's kept output and status, whoever started it. Read on with offset set to log.nextOffset (a byte cursor), or ask tail true for recent output; not both.",
	`A page holds as much as one result does, up to about 31 KiB of plain output (less where characters need escaping); limit (4 to ${MAX_CLOUD_TOOL_RESULT_BYTES}) asks for less. Logs keep 64 MiB; limitReached means later output was dropped. running or unconfirmed is not success; lost means the machine stopped or restarted under it. After the machine moved to another server, its earlier commands have no log (refused).`,
	"companyFolder is as machine_run says.",
].join("\n");
/** A worker waits for its commands within its own run. */
export const CLOUD_MACHINE_READ_WORKER_DESCRIPTION = `${CLOUD_MACHINE_READ_DESCRIPTION}\nwaitSeconds (1 to 300) waits until the command ends or that time passes, and answers at once when it has already ended; no model turn is spent.`;
export const CLOUD_MACHINE_CANCEL_DESCRIPTION =
	"Stop a running machine command and everything it started. Files on the machine stay. companyFolder is as machine_run says.";
export const CLOUD_MACHINE_STOP_DESCRIPTION =
	"Stop a machine: every program on it stops and it takes no room on the servers. Its disk is kept for a wake on the same server, unless that server runs out of disk, has no room at the wake, or is gone or moved: then it comes back with an empty disk and its status says diskFreed. Wake it with machine_start and its name. A task machine is deleted after 30 days asleep.";
export const CLOUD_MACHINE_DELETE_DESCRIPTION =
	"Delete a machine and its disk. This cannot be undone. Save what you need first.";
/** The services a coding value may be taken from (qorpera_coding_value_services, 20260930695000); the database checks
 * the call again. */
const CODING_VALUE_SERVICES = ["npm", "github", "stripe", "resend"] as const;
export const CLOUD_MACHINE_SAVE_CODING_VALUE_DESCRIPTION = [
	"Save a key you made on a service's website (npm, github, stripe or resend) into the company's vault as a coding value: an environment variable the company's coding sessions in one repository get. A key of another service, or one only a person has, comes from a member: ask_member with surface secret and connectorId environment.",
	"On a running machine, make the key on the service's site in the machine's browser (desktop start, desktop open URL, sign in, create the key), press the site's own Copy button beside the key (or select it and press ctrl+c) so it is on the machine's clipboard, then call. You never pass the key: the machine reads its clipboard, checks the key's shape, seals it for the vault and clears the clipboard.",
	"The vault stores it (a new version when the variable exists) and grants it to the repository in the name of the member you work for, who must be an owner or an admin. The result says saved, with the version, or why not; the clipboard is cleared either way, so copy the key again (or make a new one) before you call again.",
	"A key is never typed, pasted, printed, echoed or written anywhere (a command, a file, a message), and no desktop shot is taken while one is on the screen: shots are kept in the company folder.",
].join("\n");
/** What the agent is told when a member holds a machine's desktop (20260930713000): what it means, and what to do. A
 * member's hand-back wakes the agent only through its takeover card ("I'm done"). */
const MEMBER_IN_CONTROL =
	"a member is using this computer's screen: until they hand it back you get no pictures of it, and you cannot act on it, start commands on it or save a key off it. Tell the member what you need (for a sign-in, a captcha or a payment, ask_member with surface takeover says what to do) and end your turn: their I'm done on that card hands the computer back and wakes you";
/** What the agent does about each refusal of the machine's (the clipboard is cleared in each). */
const CODING_VALUE_REFUSED: Readonly<Record<CloudMachineCodingValueRefusalCode, string>> = {
	MACHINE_NOT_RUNNING: "the machine is not running: start it, make or copy the key again, then call again",
	DESKTOP_MEMBER_IN_CONTROL: `${MEMBER_IN_CONTROL}; then copy the key again and call again`,
	MACHINE_IMAGE_WITHOUT_CODING_VALUES:
		"this machine runs an earlier image that cannot save keys; start a new machine to save one",
	DESKTOP_NOT_RUNNING:
		"the machine's desktop is not running, so it has no clipboard: desktop start, make the key in its browser, press the site's Copy, then call again",
	CLIPBOARD_EMPTY:
		"the machine's clipboard is empty: press the site's Copy button beside the key (or select the key and press ctrl+c), then call again",
	CLIPBOARD_NOT_A_KEY:
		"the machine's clipboard held no whole key of this service (it was cleared): copy the key itself with the site's Copy button, then call again",
	CLIPBOARD_MORE_THAN_ONE_KEY:
		"the machine's clipboard held more than one key of this service (it was cleared): copy only the key to save, then call again",
	CLIPBOARD_UNREADABLE: "the machine's clipboard could not be read: copy the key again, then call again",
	MACHINE_BOOT_CHANGED:
		"the machine restarted, and its clipboard went with it: copy or make the key again, then call again",
	CODING_VALUE_TARGET_INVALID: "the machine could not take the vault's request; try again with a new operationKey",
};
export const CLOUD_MACHINE_FILL_COMPANY_ACCOUNT_DESCRIPTION =
	"Type a company account's login, password or authenticator code into the field that has the focus in a machine's browser. The vault types it: you never see, pass, say or write a password. " +
	"To sign in (or sign up) from a desktop computer (machine_start with desktop true): machine_run desktop start, then desktop open with the site's sign-in or sign-up page (only a browser desktop open started can be typed into), desktop shot to see the page, desktop click into the field, then call fill_company_account with the machine, the account (its id from company_account find or open) and the field. Click into the next field and call again, then press the site's own button yourself (desktop click, or desktop key Return). " +
	"For a sign-up, company_account open makes the account first (its login and a password only the vault knows); then fill both into the sign-up form with this tool. A code or link the website mails comes to the account's login: find it with find_mail (to the login, since the moment you acted, waitSeconds) and read_event, and type that code yourself (desktop type) or open the link (desktop open). " +
	"The vault types only into the account's site or one of its sign-in hosts over https, into the page itself and not a frame inside it, into a box of the field's kind, and never on a page that shows a CAPTCHA, a human check, an unusual activity warning or a block. " +
	"Never type, paste, read aloud, write down or screenshot a password. Take a desktop shot of a page only before the vault types into it: once fill_company_account was called on a page, take no desktop shot or machine_screen look and add no --shot until its tab is closed or has gone to another page (after you send the form, or by opening the sign-in page again with desktop open), since a page can copy a value anywhere at any time and shots are kept in the company folder; reach the next field with desktop key Tab, or click where the earlier shot showed it. On a CAPTCHA, a bot check, an unusual activity warning or a block, stop at once and never retry: set the account needs_person with company_account state and tell a member what a person must do. " +
	"The result says filled, or why not and what to do. Each call types once: give every call a new operationKey, and keep it only to repeat a call whose result was uncertain.";
/** Every result of fill_company_account's ends with this (reviews of #1644): a page the vault typed into can copy the
 * value anywhere at any time, so no result suggests a screenshot, and each says when one is safe again. */
const ACCOUNT_FILL_NO_SCREENSHOT =
	"Take no screenshot of this tab until it is closed (desktop key ctrl+w) or has gone to another page: a page can copy a value the vault typed into it at any time, and screenshots are kept in the company folder.";
/** What the agent does about each refusal of fill_company_account's: nothing was set (every refusal but FILL_LOST), or
 * the value may still be on the page (FILL_LOST). None suggests a screenshot; the result adds when one is safe again. */
const ACCOUNT_FILL_REFUSED: Readonly<Record<Exclude<CloudMachineAccountFillRefusalCode, "VAULT_REFUSED">, string>> = {
	MACHINE_NOT_RUNNING:
		"the machine is not running: start it, open the sign-in page again with desktop open, then call again",
	ACCOUNTS_SWITCHED_OFF: "Company accounts are switched off",
	ACCOUNT_NOT_OPEN:
		"the company has no such open account: look with company_account find, and open one with company_account open when your todo needs it",
	DESKTOP_MEMBER_IN_CONTROL: `${MEMBER_IN_CONTROL}; nothing was typed, so once you have it back click into the field and call again with a new operationKey`,
	MACHINE_IMAGE_WITHOUT_ACCOUNT_FILLS:
		"this machine runs an earlier image that cannot type account values; a machine started on the current image can (one that sleeps wakes on it)",
	DESKTOP_NOT_RUNNING:
		"the machine's desktop is not running: desktop start, desktop open the sign-in page, click into the field, then call again",
	BROWSER_NOT_OPEN:
		"no browser that desktop open started runs on the machine's desktop: open the sign-in page with desktop open (not desktop run), click into the field, then call again",
	BROWSER_UNVERIFIED:
		"the browser on the desktop is not the one desktop open starts: desktop stop, desktop start, open the sign-in page with desktop open, then call again",
	NO_FOCUSED_PAGE:
		"no browser tab had the focus (or more than one did): open the sign-in page again with desktop open, click into the field, then call again",
	FILL_WRONG_SITE:
		"the tab with the focus is not on the account's site or one of its sign-in hosts over https, and nothing was typed: open the sign-in page there with desktop open, click into the field, then call again",
	FILL_IN_FRAME:
		"the field is inside a frame (another page shown within the page), and nothing was typed: the vault types only into the page itself; open the sign-in page on its own",
	FILL_WRONG_BOX:
		"the element with the focus is not a box for this field (login: a text or email box; password: a password box; code: a code box), and nothing was typed: open the sign-in page again with desktop open, click into the right field, then call again",
	FILL_PAGE_CHANGED:
		"the page changed while the vault checked it (it went to another address or loaded again), and nothing was typed: open the sign-in page again with desktop open, click into the field, then call again with a new operationKey",
	SITE_STOP_CAPTCHA: COMPANY_COMPUTER_SITE_STOP_MESSAGE,
	SITE_STOP_HUMAN_CHECK: COMPANY_COMPUTER_SITE_STOP_MESSAGE,
	SITE_STOP_UNUSUAL_ACTIVITY: COMPANY_COMPUTER_SITE_STOP_MESSAGE,
	SITE_STOP_BLOCKED: COMPANY_COMPUTER_SITE_STOP_MESSAGE,
	FILL_LOST:
		"the value may still be on the page: it was set there, or may have been, and is not verified to be only in the field (the field did not keep it or lost the focus, the page copied or moved it, went to another address, or stopped answering). Close that tab now without sending the form (desktop key ctrl+w), or desktop stop if you cannot tell which tab has it; then open the sign-in page again with desktop open and start over with a new operationKey. If you are unsure it is gone, or the tab had gone to another site, set the account needs_person with company_account state and tell a member",
	FILL_BOX_REFUSED:
		"the machine could not open the vault's sealed value (it restarted, or the call took too long): call again with a new operationKey",
	FILL_NO_BOX: "the vault sealed nothing: call again with a new operationKey",
	FILL_EXPIRED: "the machine took too long, and nothing was typed: call again with a new operationKey",
	BROWSER_NOT_ANSWERING:
		"the browser did not answer, and nothing was typed: open the sign-in page again with desktop open, click into the field, then call again with a new operationKey",
	MACHINE_BOOT_CHANGED: "the machine restarted: open the sign-in page again with desktop open, then call again",
	FILL_TARGET_INVALID: "the machine could not take the vault's request; try again with a new operationKey",
};
export const CLOUD_MACHINE_SCREEN_DESCRIPTION = [
	"See and drive a running machine's desktop in one call: at most one action, a short wait, then the screen shown to you as a picture, with the active window's and the open windows' titles. Nothing is saved in the company folder; to keep a picture, run desktop shot with machine_run.",
	"Without action it only looks, and a look starts a stopped desktop (machine_start with desktop true makes a machine that has one). An action on a stopped desktop is refused: look first, and act only on a screen you have seen.",
	"Actions: click (x, y, button), double, move, drag (x, y to toX, toY), type (text), key (keys), scroll (up or down, steps, at x y) and open (a URL or a file's absolute path). x and y are pixels of the screen: the result's screen is its size, and shown is the picture's when that is smaller.",
	"An action needs operationKey, and every action but move and scroll needs intent. An action runs once per operationKey: after an uncertain result, look before you act again.",
	"On a machine with the company folder the picture is held back (heldBack) until the folder released what the machine read: look again.",
].join("\n");
/** What the agent does about each refusal of the machine's screen (20260930708000). */
const SCREEN_REFUSED: Readonly<Record<CloudMachineScreenRefusalCode, string>> = {
	MACHINE_NOT_RUNNING: "the machine is not running: start it with machine_start, then look",
	MACHINE_NEEDS_COMPANY_VIEW:
		"this machine's disk holds the whole company folder, and this run, with the member it works for, may not read all of it, so it cannot see or drive its screen: use a machine this run started",
	MACHINE_IMAGE_WITHOUT_SCREEN:
		"this machine runs an earlier image without machine_screen: start a new machine to get it, or use machine_run with desktop commands",
	MACHINE_BOOT_CHANGED: "the machine restarted meanwhile and its desktop started over: look before you act",
	SCREEN_ACTION_TAKEN:
		"this action was taken on the machine before and is never taken twice: look (no action) to see what came of it",
	DESKTOP_BUSY:
		"another run or a member is acting on this desktop right now, so this action did not run: look, then act again with a new operationKey",
	DESKTOP_MEMBER_IN_CONTROL: MEMBER_IN_CONTROL,
	DESKTOP_MACHINE_TOO_SMALL:
		"this machine is too small for a desktop: start a desktop computer (machine_start with desktop true)",
	DESKTOP_DID_NOT_START:
		"the desktop did not start: look again; if it fails again, machine_run desktop start says why",
	DESKTOP_NOT_RUNNING:
		"the desktop is not running, and no action runs on a screen you have not seen: look first (a look starts it)",
	SCREEN_REQUEST_INVALID: "the machine could not take this request: look again",
};
/** How long an action may take, in all: the gateway's 30 s and the picture's conversion. */
const CLOUD_MACHINE_SCREEN_PERFORM_MS = 35_000;
export const CLOUD_MACHINE_LIST_DESCRIPTION =
	"List the company's machines: name, purpose, size, state (waiting, starting, running, stopping, stopped, deleting), place in line, who started it and how many commands run.";

interface MachineView {
	machineId: string;
	name: string;
	state: string;
	[key: string]: JsonValue;
}

export function cloudMachineTools(options: {
	binding: CloudNativeToolBinding;
	identity: CloudNativeToolIdentity;
	control: CloudCompanyPathControl;
	operations: Pick<CloudNativeToolOperations, "execute">;
	gateway: CloudMachineCommandGateway;
	/** The run is an agent's worker: no notify and no waking; it waits inside machine_start and machine_read. Any other
	 * run may wait inside machine_start only, and less long (CLOUD_MACHINE_START_WAIT_SECONDS). */
	worker?: boolean;
	/** The vault (20260930705000): with it, and a gateway that runs the machine's clipboard helper, a company agent's
	 * own run (never a worker's) is offered save_coding_value. */
	codingValues?: CloudMachineCodingValues;
	accountFills?: boolean;
}): readonly CloudNativeTool[] {
	const worker = options.worker === true;
	const binding = parseCloudNativeToolBinding(options.binding),
		identity = Object.freeze({ ...options.identity });
	const refusals = new CloudControlRefusalRelay();
	if (
		Object.entries(binding).some(
			([key, value]) => key !== "credentialCapsuleId" && identity[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Machine tool binding differs");
	const check = (context: CloudToolContext): void => {
		if (
			context.runId !== identity.runId ||
			context.companyId !== identity.companyId ||
			!context.identity ||
			cloudToolJsonText(context.identity) !== cloudToolJsonText(identity)
		)
			throw new Error("Machine tool identity differs");
		context.signal.throwIfAborted();
	};
	const manage = async (
		request: Record<string, JsonValue>,
		signal: AbortSignal,
	): Promise<Record<string, JsonValue>> => {
		const value = await cloudToolRequest(
			(requestSignal) =>
				options.control.call(
					"qorpera_native_machine_manage",
					{ p_binding: binding, p_request: request },
					requestSignal,
				),
			signal,
		);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Machine result differs");
		return value as Record<string, JsonValue>;
	};
	const list = async (signal: AbortSignal): Promise<MachineView[]> => {
		const result = await manage({ action: "list" }, signal);
		if (result.schema !== "qorpera.machine-list/v1" || !Array.isArray(result.machines))
			throw new Error("Machine list differs");
		return result.machines as unknown as MachineView[];
	};
	const find = async (name: string, signal: AbortSignal): Promise<MachineView | undefined> =>
		(await list(signal)).find(
			(machine) => machine.name === name && typeof machine.machineId === "string" && UUID.test(machine.machineId),
		);
	const refused = (reason: string, message: string, extra: Record<string, JsonValue> = {}) => ({
		kind: "text" as const,
		value: cloudToolJsonText({ refused: { reason, message, ...extra } }),
	});
	/** Why the machine lost a command that already ended, when the company folder made it (6e-2a): the executor's
	 * refusal carries SQL's cause. */
	const folderLost = (error: unknown): Record<string, JsonValue> =>
		error instanceof CloudMachineCommandRefusal && isCloudMachineFolderLost(error.folderLost)
			? { lost: CLOUD_MACHINE_FOLDER_LOST[error.folderLost] }
			: {};
	/** The executor's refusal to read or cancel a command, as the agent's result. */
	const commandGone = (error: unknown, machine: string) => {
		const refusal = cloudMachineCommandRefusal(error);
		if (refusal === "MACHINE_COMMAND_ENDED")
			return refused(
				refusal,
				"that command ended when its machine stopped or moved; its log went with the old disk",
				folderLost(error),
			);
		if (refusal === "MACHINE_NOT_RUNNING")
			return refused(refusal, `${machine} stopped; its commands stopped with it`);
		throw error;
	};
	/** What a run is told when the kernel says it may no longer work: a worker's agent cancels it; a conversation's run is
	 * stopped by a member. */
	const stoppedText = worker
		? "your work was stopped (your agent cancelled it, or the company paused work); end your run"
		: "your work was stopped (a member stopped it, or the company paused work); end your run";
	const workStopped = () => refused("WORK_STOPPED", stoppedText);
	/** One machine's state and, with commandId, how that command stands as the executor last recorded it. */
	const status = async (
		machine: string,
		commandId: string | undefined,
		signal: AbortSignal,
	): Promise<{ workStopped?: true; machine?: MachineView | null; command?: { state: string } | null }> => {
		const result = await manage(
			{ action: "status", machine, ...(commandId === undefined ? {} : { commandId }) },
			signal,
		);
		if (result.schema !== "qorpera.machine-status/v1") throw new Error("Machine status differs");
		return result as { workStopped?: true; machine?: MachineView | null; command?: { state: string } | null };
	};
	/**
	 * machine_run's start, sent again as it was only while the executor gives no answer AND the kernel has no record of
	 * the command: the case an executor's freeze leaves, a start that never reached the database, whose open receipt
	 * would refuse everything the run does after it (four runs on 6 and 7 Nov 2026).
	 *
	 * A record means the start may have reached the machine, and then a send again could report what it did not do, or
	 * reach a command that already ended and open its folder window for good. So at the first record, or a machine no
	 * longer running, this stops and the outcome stays unknown, as it always did. Only a first send's refusal says
	 * nothing started; after any unanswered send a refusal proves only that that send started nothing, so it too leaves
	 * the outcome unknown. What the executor did answer (a refusal, its 403) is never sent again. The command id is the
	 * receipt's on every send, the guest runs it at most once, and each send is authorized on the executor as the first.
	 */
	const startWhileUnrecorded = async (
		machine: string,
		commandId: string,
		send: () => Promise<CloudMachineCommandReceipt>,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt> => {
		const unknown = () => new Error("Machine command outcome unknown");
		for (let sends = 0; ; ) {
			try {
				return await send();
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof CloudMachineCommandUnanswered) sends += 1;
				else if (sends === 0) throw error;
				else throw unknown();
			}
			for (let waits = sends - 1; ; waits += 1) {
				await pause(Math.min(15_000, 1000 * 2 ** Math.min(waits, 4)), signal);
				let now: Awaited<ReturnType<typeof status>>;
				try {
					now = await status(machine, commandId, signal);
				} catch {
					signal.throwIfAborted();
					continue;
				}
				if (now.workStopped || now.machine?.state !== "running" || now.command !== null) throw unknown();
				break;
			}
		}
	};
	/** A run waits: it looks every few seconds until settled, the time passes or its work is stopped, and at once when a
	 * word comes from `listen` (its machine's executor saying a step took the machine somewhere). Told, it looks now and
	 * asks for the next word, at most WAKE_WORDS in all; not told, the looks go on every few seconds. No model turn is
	 * spent. A failed look is only a failed look; the answer comes after the wait either way. */
	const waitUntil = async (
		seconds: number,
		signal: AbortSignal,
		settled: () => Promise<boolean | "stopped">,
		listen?: () => Promise<boolean>,
	): Promise<"stopped" | undefined> => {
		const deadline = Date.now() + seconds * 1000;
		let words = listen ? WAKE_WORDS : 0;
		const ask = (): Promise<boolean> | undefined => {
			if (!listen || words <= 0) return undefined;
			words -= 1;
			return listen();
		};
		let waiting = ask();
		for (;;) {
			try {
				const outcome = await settled();
				if (outcome === "stopped") return "stopped";
				if (outcome) return undefined;
			} catch {
				signal.throwIfAborted();
			}
			const left = deadline - Date.now();
			if (left <= 0) return undefined;
			const cut = new AbortController();
			const heard = waiting;
			void heard?.then((told) => {
				if (told) cut.abort();
				// Each word is taken once, by the first look that hears it.
				if (waiting === heard) waiting = told ? ask() : undefined;
			});
			await pause(Math.min(WAIT_STEP_MS, left), AbortSignal.any([signal, cut.signal])).catch(() => undefined);
			signal.throwIfAborted();
		}
	};
	/** Asks the machine's executor for a pass now. It never fails the call: a lost word only means its next pass. */
	const wake = (machine: MachineView, wait: boolean, signal: AbortSignal): Promise<boolean> =>
		options.gateway.wake
			? options.gateway.wake({ machineId: machine.machineId }, wait, signal).catch(() => false)
			: Promise.resolve(false);
	/** A worker waits in machine_start and machine_read; a conversation's run only in machine_start, and less long. A
	 * start waits by default; its waitSeconds may be 0 (no wait). A read waits only when asked. */
	const waitMost = worker ? CLOUD_MACHINE_START_WAIT_SECONDS.worker : CLOUD_MACHINE_START_WAIT_SECONDS.conversation;
	const waitSecondsOf = (value: JsonValue, least: number): number => {
		if (!Number.isSafeInteger(value) || Number(value) < least || Number(value) > waitMost)
			throw new Error("Invalid machine wait");
		return Number(value);
	};
	const waitSchema = { type: "integer", minimum: 1, maximum: waitMost };
	const startWaitSchema = { type: "integer", minimum: 0, maximum: waitMost };
	const fits = cloudCommandFits;
	const receipt = (value: CloudMachineCommandReceipt, machine: string) => {
		// As much of a start's or a cancel's first page as fits; a handle without a preview is still a complete, honest
		// cursor.
		const fitted = fitCloudCommandPage(value, false, (page) => fits({ machine, ...page }));
		const shown: CloudMachineCommandReceipt =
			fitted && "page" in fitted
				? fitted.page
				: {
						...value,
						output: "",
						log: { ...value.log, nextOffset: value.log.offset },
						truncated: value.log.offset < value.log.totalBytes || value.log.limitReached,
					};
		return { kind: "text" as const, value: cloudToolJsonText({ machine, ...shown } as unknown as JsonValue) };
	};
	/** `answer` with the company folder's report the executor told on this call's reads (6e-2a), when it told one. */
	const withFolder = (answer: CloudToolContent, folder: CloudMachineCommandFolder | undefined): CloudToolContent =>
		folder === undefined || answer.kind !== "text"
			? answer
			: {
					kind: "text",
					value: cloudToolJsonText({
						...(JSON.parse(answer.value) as Record<string, JsonValue>),
						companyFolder: folder as unknown as JsonValue,
					}),
				};
	/**
	 * One page of a command's log, as much as one result holds or the read's own smaller limit: asked once and cut to fit
	 * at an exact cursor, and asked again only for exactly the bytes that fit when the page cannot tell its cut's cursor
	 * (fitCloudCommandPage). What the executor reports once (6e-2a) stays in `reported`, across the reads of one call,
	 * whichever read it came on: it spends a report when it tells it. `refused`: the executor refused the read, for the
	 * command or its machine ended.
	 */
	const readPage = async (
		machine: MachineView,
		query: CloudCodingCommandRead,
		reported: { folder?: CloudMachineCommandFolder },
		context: CloudToolContext,
	): Promise<{ content: CloudToolContent; ended: boolean; refused: boolean }> => {
		for (let limit = Number(query.limit); ; ) {
			let read: unknown;
			try {
				read = await cloudToolRequest(
					(signal) =>
						options.gateway.read(
							{ machineId: machine.machineId },
							parseCloudCodingCommandRead({ ...query, limit }),
							signal,
						),
					context.signal,
					CLOUD_MACHINE_READ_MS,
				);
			} catch (error) {
				return {
					content: withFolder(commandGone(error, machine.name), reported.folder),
					ended: true,
					refused: true,
				};
			}
			const got = parseCloudMachineCommandReceipt(read);
			check(context);
			reported.folder = carried(reported.folder, got.companyFolder);
			const shown: CloudMachineCommandReceipt = reported.folder ? { ...got, companyFolder: reported.folder } : got;
			const fitted = fitCloudCommandPage(shown, query.tail === true, (page) =>
				fits({ machine: machine.name, ...page }),
			);
			if (fitted && "page" in fitted)
				return {
					content: {
						kind: "text",
						value: cloudToolJsonText({ machine: machine.name, ...fitted.page } as unknown as JsonValue),
					},
					// Running and unconfirmed may yet go either way (the tool's own words).
					ended: got.state !== "running" && got.state !== "unconfirmed",
					refused: false,
				};
			// Each ask is less than the page before it held, so this ends.
			if (!fitted || fitted.ask >= limit) throw new Error("Machine command page exceeds result budget");
			limit = fitted.ask;
		}
	};
	/** A start's answer, or in its place one read of its command at once from the start of its log, as much as one result
	 * holds, when the start shows less than a read can: on a machine with the company folder a start holds its output
	 * back (heldBack), and a command that already ended may have printed more than a start's first page. Nothing waits
	 * for the command: the read shows it running when it runs. A refused or failed read keeps the start's answer. */
	const readStarted = async (
		machine: MachineView,
		content: CloudToolContent,
		context: CloudToolContext,
	): Promise<CloudToolContent> => {
		let started: CloudMachineCommandReceipt;
		try {
			if (content.kind !== "text") return content;
			const { machine: _machine, ...answer } = JSON.parse(content.value) as Record<string, unknown>;
			started = parseCloudMachineCommandReceipt(answer);
		} catch {
			return content;
		}
		if (
			started.companyFolder?.heldBack === undefined &&
			!(
				["succeeded", "failed", "cancelled", "lost"].includes(started.state) &&
				started.log.nextOffset < started.log.totalBytes
			)
		)
			return content;
		const reported: { folder?: CloudMachineCommandFolder } = started.companyFolder
			? { folder: started.companyFolder }
			: {};
		try {
			const read = await readPage(
				machine,
				{ commandId: started.commandId, offset: 0, limit: CLOUD_COMMAND_PAGE_ASK },
				reported,
				context,
			);
			if (!read.refused) return read.content;
		} catch {
			context.signal.throwIfAborted();
		}
		// What a read reported once before it failed still reaches the agent (6e-2a), with the start's own answer.
		return withFolder(content, reported.folder);
	};
	const closed = (
		value: JsonValue,
		required: readonly string[],
		optional: readonly string[] = [],
	): Record<string, JsonValue> => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid machine request");
		const keys = Object.keys(value);
		if (
			keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
			required.some((key) => !keys.includes(key))
		)
			throw new Error("Invalid machine request");
		return value as Record<string, JsonValue>;
	};
	const name = (value: JsonValue): string => {
		if (typeof value !== "string" || !NAME.test(value)) throw new Error("Invalid machine name");
		return value;
	};
	const key = (value: JsonValue): string => {
		if (typeof value !== "string" || !KEY.test(value)) throw new Error("Invalid machine operation key");
		return value;
	};
	const operationKey = { type: "string", pattern: KEY.source };
	const machineName = { type: "string", pattern: NAME.source };
	const commandId = { type: "string", pattern: UUID.source };

	const start: CloudNativeTool = {
		name: "machine_start" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: worker ? CLOUD_MACHINE_START_WORKER_DESCRIPTION : CLOUD_MACHINE_START_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey"],
			properties: {
				operationKey,
				name: { ...machineName, description: "A new machine's name." },
				purpose: { type: "string", minLength: 1, maxLength: 300 },
				cpus: { type: "integer", minimum: 1, maximum: 64, description: "2 by default." },
				memoryGiB: { type: "integer", minimum: 1, maximum: 1024, description: "4 by default." },
				diskGiB: { type: "integer", minimum: 10, maximum: 2048, description: "40 by default." },
				lifetime: {
					type: "string",
					enum: ["task", "always-on"],
					description:
						"task (the default): sleeps after an hour with no use and no busy program (over about 5% of one core, or moving data), and is deleted after 30 days asleep. always-on: runs until an agent or a member stops it, to keep a server up; its starter is asked once a week whether the work still needs it.",
				},
				desktop: {
					type: "boolean",
					description: "A screen: at least 2 cpus and 4 GiB (a smaller machine refuses its desktop).",
				},
				machine: { ...machineName, description: "To wake a stopped machine: its name, and nothing else." },
				waitSeconds: startWaitSchema,
			},
		},
		parseArguments(value): JsonValue {
			const input = closed(
				value,
				["operationKey"],
				["name", "purpose", "cpus", "memoryGiB", "diskGiB", "lifetime", "desktop", "machine", "waitSeconds"],
			);
			key(input.operationKey);
			// The wait is how this call answers, never part of the start or its receipt.
			const wait: Record<string, JsonValue> =
				input.waitSeconds === undefined ? {} : { waitSeconds: waitSecondsOf(input.waitSeconds, 0) };
			if (Object.hasOwn(input, "machine")) {
				if (Object.keys(input).length !== 2 + Object.keys(wait).length)
					throw new Error("A wake names only the machine");
				return { operationKey: input.operationKey, machine: name(input.machine), ...wait };
			}
			const integer = (field: string, fallback: number, min: number, max: number): number => {
				const n = input[field] ?? fallback;
				if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max)
					throw new Error(`Invalid machine ${field}`);
				return Number(n);
			};
			const purpose = typeof input.purpose === "string" ? input.purpose.trim().replace(/\s+/g, " ") : "";
			if (!purpose || purpose.length > 300 || /\p{Cc}/u.test(purpose))
				throw new Error("A new machine needs a purpose");
			if (input.lifetime !== undefined && input.lifetime !== "task" && input.lifetime !== "always-on")
				throw new Error("Invalid machine lifetime");
			if (input.desktop !== undefined && typeof input.desktop !== "boolean")
				throw new Error("Invalid machine desktop");
			// A desktop computer is a machine large enough for its desktop (deploy/machine/desktop refuses a smaller one):
			// a smaller size asked beside desktop true is raised to it. Only the size reaches the start and its receipt.
			const least = input.desktop === true ? CLOUD_MACHINE_DESKTOP_LEAST : { cpus: 1, memoryGiB: 1 };
			return {
				operationKey: input.operationKey,
				name: name(input.name ?? ""),
				purpose,
				cpus: Math.max(integer("cpus", 2, 1, 64), least.cpus),
				memoryGiB: Math.max(integer("memoryGiB", 4, 1, 1024), least.memoryGiB),
				diskGiB: integer("diskGiB", 40, 10, 2048),
				lifetime: (input.lifetime as string | undefined) ?? "task",
				...wait,
			};
		},
		async execute(value, context) {
			check(context);
			const { operationKey: logicalOperationKey, waitSeconds, ...args } = value as Record<string, JsonValue>;
			const result = await options.operations.execute({
				operation: {
					tool: "machine_start",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: String(logicalOperationKey),
					arguments: args,
					target: { realm: "company_machine" },
					requiresCompanyRevision: false,
				},
				signal: context.signal,
				observation: context.observation,
				authorize: async (operation, admitted, signal) => {
					if (!isDeepStrictEqual(admitted, identity)) throw new Error("Machine start identity changed");
					const result = (await cloudToolRequest(
						(requestSignal) =>
							options.control.call(
								"qorpera_native_machine_start",
								{
									p_binding: binding,
									p_envelope: cloudNativeToolOperationEnvelope(admitted, operation),
									p_action: "authorize",
								},
								requestSignal,
							),
						signal,
					)) as Record<string, unknown> | null;
					if (result?.state !== "authorized") throw new Error("Machine start unconfirmed");
				},
				perform: async (operation, effect) => {
					const result = (await cloudToolRequest(
						(requestSignal) =>
							options.control.call(
								"qorpera_native_machine_start",
								{
									p_binding: binding,
									p_envelope: cloudNativeToolOperationEnvelope(effect.identity, operation),
									p_action: "begin",
									p_receipt_id: effect.receiptId,
									p_idempotency_sha256: createHash("sha256").update(effect.idempotencyKey).digest("hex"),
								},
								requestSignal,
							),
						effect.signal,
					)) as Record<string, JsonValue> | null;
					if (
						!result ||
						result.schema !== "qorpera.machine-start/v1" ||
						(result.machine === undefined) === (result.refused === undefined)
					)
						throw new Error("Machine start result differs");
					return { content: { kind: "json", value: result } };
				},
			});
			// The call waits while its machine starts, by default (agent-box B1): in line for room too (a new machine is
			// often first in line for about 2 s while its node's executor frees a sleeping machine's disk), but not for
			// computer hours, which only a member adds. waitSeconds asks for less (0: not at all), or in a worker's run for
			// more. A conversation's run stays on the machine's list of runs to tell (the kernel's, at the start): when its
			// wait ends first, it is woken when the machine runs, and its look that sees it running keeps it from being woken
			// for it (20260930747000). Each wait is reported to the kernel when it ends (20260930755000).
			const started = result.kind === "json" ? (result.value as Record<string, JsonValue>) : undefined;
			const machine = started?.machine as MachineView | undefined;
			const pending = (view: MachineView): boolean => view.state === "starting" || view.state === "waiting";
			const forHours = (view: MachineView): boolean => view.waitingFor === "COMPUTER_HOURS_EXHAUSTED";
			if (!machine || !pending(machine)) return result;
			const asked = waitSeconds !== undefined;
			const limit = asked ? Number(waitSeconds) : CLOUD_MACHINE_START_WAIT_SECONDS.byDefault;
			const report = async (waitedMs: number, outcome: string, after: MachineView): Promise<void> => {
				if (context.signal.aborted) return;
				try {
					await manage(
						{
							action: "waited",
							machine: machine.name,
							// The machine the start answered, never a later one of its name (review r1 F1 of #1771).
							machineId: machine.machineId,
							wait: {
								asked,
								limitSeconds: limit,
								stateBefore: machine.state,
								waitingFor: typeof machine.waitingFor === "string" ? machine.waitingFor : null,
								waitedMs: Math.min(600_000, Math.max(0, Math.round(waitedMs))),
								outcome,
								stateAfter: after.state,
							},
						},
						AbortSignal.any([context.signal, AbortSignal.timeout(WAIT_REPORT_MS)]),
					);
				} catch {
					// A kernel without the report (before 20260930755000), or a lost report: the answer goes on without it.
				}
			};
			if (limit === 0 || forHours(machine)) {
				// Not waited on: its executor need not wait for its next pass to see it.
				await wake(machine, false, AbortSignal.any([context.signal, AbortSignal.timeout(WAKE_SENT_MS)]));
				await report(0, limit === 0 ? "not_asked" : "hours", machine);
				return result;
			}
			const began = Date.now();
			let latest: MachineView = machine;
			const stopWord = new AbortController();
			const outcome = await waitUntil(
				limit,
				context.signal,
				async () => {
					const now = await status(machine.name, undefined, context.signal);
					if (now.workStopped) return "stopped";
					latest = now.machine ?? { ...latest, state: "deleted" };
					return !pending(latest) || forHours(latest);
				},
				() => wake(machine, true, AbortSignal.any([context.signal, stopWord.signal])),
			);
			stopWord.abort();
			check(context);
			await report(
				Date.now() - began,
				outcome === "stopped"
					? "work_stopped"
					: latest.state === "running"
						? "running"
						: latest.state === "deleted"
							? "gone"
							: forHours(latest)
								? "hours"
								: pending(latest)
									? "limit"
									: "stopped",
				latest,
			);
			// The machine was started either way: a stopped run is told so beside it, not refused.
			return {
				kind: "json",
				value: {
					...started,
					machine: latest,
					...(outcome === "stopped" ? { workStopped: stoppedText } : {}),
				} as JsonValue,
			};
		},
	};

	const scriptTexts = new Map<string, string>();
	const scriptsOf = (parsed: JsonValue) =>
		parseCloudPreparedScripts((parsed as Record<string, JsonValue> | null)?.scripts ?? undefined);
	const readScripts = async (
		machine: MachineView,
		files: readonly CloudCommandScriptRun[],
		context: CloudToolContext,
	): Promise<CloudScriptEntry[]> => {
		const program = cloudScriptReadProgram(files.map((file) => file.path));
		const deadline = AbortSignal.any([context.signal, AbortSignal.timeout(SCRIPT_READ_MS)]);
		const scope = { machineId: machine.machineId };
		try {
			const started = await options.operations.execute({
				operation: {
					tool: "machine_run",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: `review-read.${randomUUID()}`,
					arguments: { machine: machine.name, command: program, timeoutMs: SCRIPT_READ_MS, notify: false },
					target: { realm: "company_machine", machineId: machine.machineId },
					requiresCompanyRevision: false,
				},
				signal: context.signal,
				authorize: async (_operation, admitted) => {
					if (!isDeepStrictEqual(admitted, identity)) throw new Error("Machine command identity changed");
				},
				perform: async (_operation, effect) => {
					const bound = AbortSignal.any([effect.signal, AbortSignal.timeout(SCRIPT_START_MS)]);
					const start = startWhileUnrecorded(
						machine.name,
						effect.receiptId,
						() =>
							options.gateway.start(
								scope,
								{
									commandId: effect.receiptId,
									inputSha256: effect.inputSha256,
									command: program,
									timeoutMs: SCRIPT_READ_MS,
									notify: false,
								},
								bound,
							),
						bound,
					).then(
						(receipt): JsonValue => ({ commandId: receipt.commandId }),
						(error: unknown): JsonValue => ({ refused: cloudMachineCommandRefusal(error) ?? "NOT_STARTED" }),
					);
					let timer: ReturnType<typeof setTimeout> | undefined;
					const late = new Promise<JsonValue>((resolve) => {
						timer = setTimeout(() => resolve({ refused: "NOT_STARTED" }), SCRIPT_START_MS + 1000);
					});
					try {
						return { content: { kind: "json", value: await Promise.race([start, late]) } };
					} finally {
						clearTimeout(timer);
					}
				},
			});
			const commandId = started.kind === "json" ? (started.value as Record<string, JsonValue>).commandId : null;
			if (typeof commandId !== "string") throw new Error("Script read differs");
			let output = "";
			for (let offset = 0; ; ) {
				const page = parseCloudMachineCommandReceipt(
					await options.gateway.read(
						scope,
						parseCloudCodingCommandRead({ commandId, offset, limit: CLOUD_CODING_COMMAND_PAGE_BYTES }),
						deadline,
					),
				);
				if (
					page.state === "running" ||
					page.state === "unconfirmed" ||
					page.companyFolder?.heldBack !== undefined
				) {
					await pause(SCRIPT_READ_POLL_MS, deadline);
					continue;
				}
				if (page.state !== "succeeded" || page.exitCode !== 0) throw new Error("Script read failed");
				output += page.output;
				if (page.output === "" || page.log.nextOffset >= page.log.totalBytes) break;
				offset = page.log.nextOffset;
			}
			const read = parseCloudScriptRead(output, files);
			for (const [sha256, text] of read.texts) {
				scriptTexts.delete(sha256);
				scriptTexts.set(sha256, text);
			}
			while (scriptTexts.size > REMEMBERED_SCRIPTS) scriptTexts.delete(scriptTexts.keys().next().value as string);
			return read.entries;
		} catch {
			context.signal.throwIfAborted();
			return cloudScriptNotRead(files, "it could not be read just now");
		}
	};

	const run: CloudNativeTool = {
		name: "machine_run" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: worker ? CLOUD_MACHINE_RUN_WORKER_DESCRIPTION : CLOUD_MACHINE_RUN_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "machine", "command"],
			properties: {
				operationKey,
				machine: machineName,
				command: { type: "string", minLength: 1, maxLength: 16384 },
				timeoutMs: { type: "integer", minimum: 1000 },
				...(worker ? {} : { notify: { type: "boolean" } }),
			},
		},
		parseArguments(value) {
			const input = closed(
				value,
				["operationKey", "machine", "command"],
				worker ? ["timeoutMs"] : ["timeoutMs", "notify"],
			);
			key(input.operationKey);
			name(input.machine);
			if (
				typeof input.command !== "string" ||
				!input.command.trim() ||
				input.command.includes("\0") ||
				Buffer.from(input.command).toString("utf8") !== input.command ||
				Buffer.byteLength(input.command) > 16384 ||
				Buffer.byteLength(JSON.stringify(input.command)) > 60000 ||
				(input.timeoutMs !== undefined &&
					(!Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1000)) ||
				(input.notify !== undefined && typeof input.notify !== "boolean")
			)
				throw new Error("Invalid machine command");
			return { ...input, notify: input.notify === true };
		},
		async prepare(value, context) {
			const input = value as Record<string, JsonValue>;
			const found = cloudCommandScripts(String(input.command));
			if (found.files.length === 0 && found.notShown.length === 0) return value;
			check(context);
			const machine = await find(String(input.machine), context.signal);
			if (!machine) throw new CloudToolRefusal(`MACHINE_NOT_FOUND: no machine is named ${String(input.machine)}`);
			if (machine.state !== "running")
				throw new CloudToolRefusal(`MACHINE_NOT_RUNNING: ${machine.name} is ${machine.state}`);
			const read = found.files.slice(0, CLOUD_SCRIPT_FILES);
			const files = [
				...(read.length > 0 ? await readScripts(machine, read, context) : []),
				...cloudScriptNotRead(
					found.files.slice(CLOUD_SCRIPT_FILES),
					`the command runs more than the ${CLOUD_SCRIPT_FILES} files the review reads`,
				),
			];
			return { ...input, scripts: { files, notShown: found.notShown } as unknown as JsonValue };
		},
		reviewContents(parsed) {
			const scripts = scriptsOf(parsed);
			return scripts === undefined ? undefined : cloudScriptContents(scripts, scriptTexts);
		},
		reviewIdentity(parsed) {
			const scripts = scriptsOf(parsed);
			return scripts === undefined ? undefined : cloudScriptIdentity(scripts);
		},
		async execute(value, context) {
			check(context);
			const { scripts: _scripts, ...input } = value as Record<string, JsonValue>;
			const machine = await find(String(input.machine), context.signal);
			if (!machine) return refused("MACHINE_NOT_FOUND", `no machine is named ${String(input.machine)}`);
			if (machine.state !== "running")
				return refused("MACHINE_NOT_RUNNING", `${machine.name} is ${machine.state}`, { state: machine.state });
			const scope = { machineId: machine.machineId };
			const started = await options.operations.execute({
				operation: {
					tool: "machine_run",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: String(input.operationKey),
					arguments: input,
					target: { realm: "company_machine", machineId: machine.machineId },
					requiresCompanyRevision: false,
				},
				signal: context.signal,
				observation: context.observation,
				performMs: CLOUD_MACHINE_START_ANSWER_MS,
				authorize: async (_operation, admitted) => {
					if (!isDeepStrictEqual(admitted, identity)) throw new Error("Machine command identity changed");
				},
				perform: async (_operation, effect) => {
					let started: CloudMachineCommandReceipt;
					try {
						started = await startWhileUnrecorded(
							machine.name,
							effect.receiptId,
							() =>
								options.gateway.start(
									scope,
									{
										commandId: effect.receiptId,
										inputSha256: effect.inputSha256,
										command: String(input.command),
										timeoutMs: input.timeoutMs === undefined ? null : Number(input.timeoutMs),
										notify: input.notify === true,
									},
									effect.signal,
								),
							effect.signal,
						);
					} catch (error) {
						// The executor refused before anything started.
						const refusal = cloudMachineCommandRefusal(error);
						if (refusal === "MACHINE_NOT_RUNNING")
							return { content: refused(refusal, `${machine.name} stopped before the command started`) };
						// 20260930713000: nothing started; commands that run already go on.
						if (refusal === "DESKTOP_MEMBER_IN_CONTROL")
							return {
								content: refused(
									refusal,
									`this command did not start, and commands already running on it go on: ${MEMBER_IN_CONTROL}`,
								),
							};
						if (refusal === "MACHINE_COMMAND_ENDED") {
							const lost = folderLost(error);
							return {
								content: refused(
									refusal,
									lost.lost !== undefined
										? "this command was lost after it started; start it again with a new operationKey"
										: "this start was given up earlier; start it again with a new operationKey",
									lost,
								),
							};
						}
						throw error;
					}
					return { content: receipt(started, machine.name) };
				},
			});
			return readStarted(machine, started, context);
		},
	};

	const read: CloudNativeTool = {
		name: "machine_read" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: worker ? CLOUD_MACHINE_READ_WORKER_DESCRIPTION : CLOUD_MACHINE_READ_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["machine", "commandId"],
			properties: {
				machine: machineName,
				commandId,
				offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
				limit: { type: "integer", minimum: 4, maximum: MAX_CLOUD_TOOL_RESULT_BYTES },
				tail: { type: "boolean" },
				...(worker ? { waitSeconds: waitSchema } : {}),
			},
		},
		parseArguments(value) {
			const input = closed(
				value,
				["machine", "commandId"],
				["offset", "limit", "tail", ...(worker ? ["waitSeconds"] : [])],
			);
			name(input.machine);
			const { machine, waitSeconds, ...rest } = input;
			// Without a limit, a read asks for what one result holds; a limit asks for less, up to one result's bound.
			const read = parseCloudCodingCommandRead(rest);
			if (rest.limit !== undefined && Number(rest.limit) > MAX_CLOUD_TOOL_RESULT_BYTES)
				throw new Error("Invalid coding log read");
			return {
				machine,
				...(waitSeconds === undefined ? {} : { waitSeconds: waitSecondsOf(waitSeconds, 1) }),
				...read,
				limit: rest.limit === undefined ? CLOUD_COMMAND_PAGE_ASK : Number(read.limit),
			} as unknown as JsonValue;
		},
		async execute(value, context) {
			check(context);
			const { machine: machineNameValue, waitSeconds, ...query } = value as Record<string, JsonValue>;
			const machine = await find(String(machineNameValue), context.signal);
			if (!machine) return refused("MACHINE_NOT_FOUND", `no machine is named ${String(machineNameValue)}`);
			if (machine.state !== "running")
				return refused(
					"MACHINE_NOT_RUNNING",
					`${machine.name} is ${machine.state}; its commands can be read while it runs`,
					{
						state: machine.state,
					},
				);
			// What the executor reports once stays with the answer, whichever read it came on, a refusal or a stop too: it
			// spends a report when it tells it (6e-2a).
			const reported: { folder?: CloudMachineCommandFolder } = {};
			const told = (answer: CloudToolContent): CloudToolContent => withFolder(answer, reported.folder);
			const page = () => readPage(machine, query as unknown as CloudCodingCommandRead, reported, context);
			if (waitSeconds !== undefined) {
				// A worker waits until the executor recorded the command's end (a pass every 10 s), its machine stopped
				// or the time passed. It looks at the kernel's status, which also says whether its work was stopped. A
				// command may have ended long before the kernel hears of it, and most short ones have by the time the
				// model reads them (7 Nov 2026): after the first look that finds it running, the machine is asked once.
				// That read is a look too: if it fails, the wait goes on. The read below answers otherwise.
				let asked = false;
				let answer: CloudToolContent | undefined;
				const outcome = await waitUntil(Number(waitSeconds), context.signal, async () => {
					const now = await status(machine.name, String(query.commandId), context.signal);
					if (now.workStopped) return "stopped";
					if (now.machine?.state !== "running" || now.command?.state !== "running") return true;
					if (asked) return false;
					asked = true;
					const first = await page();
					if (first.ended) answer = first.content;
					return first.ended;
				});
				check(context);
				if (outcome === "stopped") return told(workStopped());
				if (answer) return answer;
			}
			try {
				return (await page()).content;
			} catch (error) {
				// The executor has spent what it reports once, on a read before this one, and a run that is still going can
				// act on it, so it gets it now. A stopped run's goes with it: nothing would read it.
				context.signal.throwIfAborted();
				if (!reported.folder?.notSaved?.length && !reported.folder?.moreNotSaved) throw error;
				return told(
					refused(
						"MACHINE_READ_UNANSWERED",
						"this read did not answer, so how the command stands is unknown; read it again",
					),
				);
			}
		},
	};

	const cancel: CloudNativeTool = {
		name: "machine_cancel" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_MACHINE_CANCEL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "machine", "commandId"],
			properties: { operationKey, machine: machineName, commandId },
		},
		parseArguments(value) {
			const input = closed(value, ["operationKey", "machine", "commandId"]);
			key(input.operationKey);
			name(input.machine);
			if (typeof input.commandId !== "string" || !UUID.test(input.commandId))
				throw new Error("Invalid command handle");
			return input;
		},
		async execute(value, context) {
			check(context);
			const input = value as Record<string, JsonValue>;
			const machine = await find(String(input.machine), context.signal);
			if (!machine) return refused("MACHINE_NOT_FOUND", `no machine is named ${String(input.machine)}`);
			if (machine.state !== "running")
				return refused("MACHINE_NOT_RUNNING", `${machine.name} is ${machine.state}; its commands stopped with it`, {
					state: machine.state,
				});
			return options.operations.execute({
				operation: {
					tool: "machine_cancel",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: String(input.operationKey),
					arguments: input,
					target: { realm: "company_machine", machineId: machine.machineId },
					requiresCompanyRevision: false,
				},
				signal: context.signal,
				observation: context.observation,
				authorize: async (_operation, admitted) => {
					if (!isDeepStrictEqual(admitted, identity)) throw new Error("Machine command identity changed");
				},
				perform: async (_operation, effect) => {
					let cancelled: CloudMachineCommandReceipt;
					try {
						cancelled = await options.gateway.cancel(
							{ machineId: machine.machineId },
							String(input.commandId),
							effect.signal,
						);
					} catch (error) {
						return { content: commandGone(error, machine.name) };
					}
					return { content: receipt(cancelled, machine.name) };
				},
			});
		},
	};

	const change = (action: "stop" | "delete", description: string): CloudNativeTool => ({
		name: (action === "stop" ? "machine_stop" : "machine_delete") satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["machine"],
			properties: { machine: machineName },
		},
		parseArguments(value) {
			const input = closed(value, ["machine"]);
			return { machine: name(input.machine) };
		},
		async execute(value, context) {
			check(context);
			// The tool's first effect: a refusal of it is the tool's answer (control calls, 4 Oct 2026), unless an earlier
			// attempt at the same change ended unknown.
			const machine = (value as { machine: string }).machine;
			const result = await refusals.call(`${action}:${machine}`, () => manage({ action, machine }, context.signal));
			if (
				result.schema !== "qorpera.machine-change/v1" ||
				(result.machine === undefined) === (result.refused === undefined)
			)
				throw new Error("Machine change differs");
			return { kind: "text", value: cloudToolJsonText(result) };
		},
	});

	const listTool: CloudNativeTool = {
		name: "machine_list" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_MACHINE_LIST_DESCRIPTION,
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		parseArguments(value) {
			closed(value, []);
			return {};
		},
		async execute(_value, context) {
			check(context);
			return {
				kind: "text",
				value: cloudToolJsonText({ machines: (await list(context.signal)) as unknown as JsonValue }),
			};
		},
	};

	/**
	 * save_coding_value (20260930705000): a key the agent made on a service's site in its machine's browser and copied,
	 * from the machine's clipboard into the vault. The model passes only where it goes (the service, the variable, the
	 * repository, why) and the machine; never the value. One receipted call: the vault makes or keeps the value's capture
	 * key (the office's prepare, bound to this receipt), the executor runs the image's clipboard helper on the machine for
	 * this receipt (it seals the key to that capture key and clears the clipboard), and the vault opens the box, checks the
	 * key against the service's pattern again, stores it and grants it to the repository. The answer names the version.
	 */
	const codingValues = options.codingValues;
	const codingValueSaving = !worker && codingValues !== undefined && options.gateway.codingValue !== undefined;
	const notSaved = (reason: string, message: string, extra: Record<string, JsonValue> = {}) => ({
		kind: "json" as const,
		value: { saved: false, refused: { reason, message, ...extra } },
	});
	const save: CloudNativeTool = {
		name: "save_coding_value" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_MACHINE_SAVE_CODING_VALUE_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "machine", "service", "variable", "repository", "purpose"],
			properties: {
				operationKey,
				machine: {
					...machineName,
					description: "The running machine whose desktop's clipboard holds the key you copied.",
				},
				service: {
					type: "string",
					enum: [...CODING_VALUE_SERVICES],
					description:
						"Whose key: npm (npm_ and 36 letters or digits), github (github_pat_… or ghp_…), stripe (sk_ or rk_, test_ or live_) or resend (re_…).",
				},
				variable: {
					type: "string",
					pattern: "^[a-z][a-z0-9_]{0,63}$",
					description:
						"The environment variable's name in lower case, as coding sessions get it in upper case (npm_token is NPM_TOKEN). Not one a coding machine sets itself (path, home, the proxies), nor one starting lc_, git_, ld_, ssh_, qorpera_ or a model provider's.",
				},
				repository: {
					type: "string",
					pattern: CODING_VALUE_REPOSITORY.source,
					description: "The repository whose coding sessions get it: owner/name in lower case.",
				},
				purpose: {
					type: "string",
					minLength: 1,
					maxLength: 300,
					description: "What the key is for, in plain words (one line), as members see it beside the value.",
				},
			},
		},
		parseArguments(value) {
			const input = closed(value, ["operationKey", "machine", "service", "variable", "repository", "purpose"]);
			key(input.operationKey);
			name(input.machine);
			if (typeof input.service !== "string" || !(CODING_VALUE_SERVICES as readonly string[]).includes(input.service))
				throw new Error("Coding values come from npm, github, stripe or resend");
			if (typeof input.variable !== "string" || !codingValueNameAllowed(input.variable))
				throw new Error(
					"A coding value's variable is a lower-case environment variable name a coding session may get",
				);
			if (typeof input.repository !== "string" || !CODING_VALUE_REPOSITORY.test(input.repository))
				throw new Error("A coding value's repository is owner/name in lower case");
			const purpose = typeof input.purpose === "string" ? input.purpose.trim().replace(/\s+/g, " ") : "";
			if (!purpose || purpose.length > 300 || /\p{Cc}/u.test(purpose))
				throw new Error("A coding value needs a purpose of one line, at most 300 characters");
			return {
				operationKey: input.operationKey,
				machine: input.machine,
				service: input.service,
				variable: input.variable,
				repository: input.repository,
				purpose,
			};
		},
		async execute(value, context) {
			check(context);
			const input = value as Record<string, string>;
			const machine = await find(input.machine, context.signal);
			if (!machine) return notSaved("MACHINE_NOT_FOUND", `no machine is named ${input.machine}`);
			if (machine.state !== "running")
				return notSaved("MACHINE_NOT_RUNNING", `${machine.name} is ${machine.state}`, { state: machine.state });
			const vault = codingValues as CloudMachineCodingValues;
			const sealer = options.gateway.codingValue?.bind(options.gateway);
			if (!sealer) throw new Error("Coding values are unavailable");
			return options.operations.execute({
				operation: {
					tool: "save_coding_value",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: input.operationKey,
					arguments: input,
					target: { realm: "company_machine", machineId: machine.machineId },
					requiresCompanyRevision: false,
				},
				signal: context.signal,
				observation: context.observation,
				performMs: CLOUD_MACHINE_START_ANSWER_MS,
				authorize: async (_operation, admitted) => {
					if (!isDeepStrictEqual(admitted, identity)) throw new Error("Coding value identity changed");
				},
				perform: async (operation, effect) => {
					// The vault's calls and the executor's are bound to this receipt and this exact call (its digest).
					const call: CodingValueCaptureCall = {
						binding,
						receiptId: effect.receiptId,
						idempotencyKey: effect.idempotencyKey,
						envelope: cloudNativeToolOperationEnvelope(effect.identity, operation),
					};
					const prepared = await vault.codingValuePrepare(call, effect.signal);
					if (prepared.schema === "qorpera.coding-value-refusal/v1")
						return { content: notSaved("VAULT_REFUSED", prepared.message, { code: prepared.code }) };
					if (prepared.variable !== input.variable) throw new Error("Coding value capture unconfirmed");
					let sealed: { readonly box: Readonly<Record<string, string>> };
					try {
						sealed = await sealer(
							{ machineId: machine.machineId },
							{ commandId: effect.receiptId, envelope: call.envelope },
							effect.signal,
						);
					} catch (error) {
						if (error instanceof CloudMachineCodingValueRefusal)
							return { content: notSaved(error.code, CODING_VALUE_REFUSED[error.code]) };
						throw error;
					}
					const stored = await vault.codingValueCapture({ ...call, box: sealed.box }, effect.signal);
					if (stored.schema === "qorpera.coding-value-refusal/v1")
						return { content: notSaved("VAULT_REFUSED", stored.message, { code: stored.code }) };
					if (stored.variable !== input.variable || stored.repository !== input.repository)
						throw new Error("Coding value capture unconfirmed");
					return {
						content: {
							kind: "json",
							value: {
								saved: {
									service: input.service,
									variable: stored.variable,
									repository: stored.repository,
									version: stored.version,
									unchanged: stored.unchanged,
								},
							},
						},
					};
				},
			});
		},
	};

	const accountFilling = !worker && options.accountFills === true && options.gateway.accountFill !== undefined;
	const notFilled = (reason: string, message: string) => ({
		kind: "json" as const,
		value: {
			filled: false,
			refused: { reason, message: `${message.replace(/\.$/, "")}. ${ACCOUNT_FILL_NO_SCREENSHOT}` },
		},
	});
	const fill: CloudNativeTool = {
		name: "fill_company_account" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_MACHINE_FILL_COMPANY_ACCOUNT_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "machine", "account", "field"],
			properties: {
				operationKey,
				machine: {
					...machineName,
					description:
						"The running machine whose browser shows the account's page (opened with desktop open), with the focus in the field.",
				},
				account: {
					type: "string",
					pattern: UUID_PATTERN.source,
					description: "The account's id, as company_account find or open answers it.",
				},
				field: {
					type: "string",
					enum: ["login", "password", "code"],
					description:
						"Which of the account's values: login (its email address, into the email or username box), password (into the password box), or code (its authenticator's current code, only for an account whose twoStep is authenticator; a code the website mails or texts, you read and type yourself).",
				},
			},
		},
		parseArguments(value) {
			const input = closed(value, ["operationKey", "machine", "account", "field"]);
			key(input.operationKey);
			name(input.machine);
			if (!isUuid(input.account))
				throw new Error("account is a company account's id, as company_account find or open answers it");
			if (input.field !== "login" && input.field !== "password" && input.field !== "code")
				throw new Error("field is login, password or code");
			return {
				operationKey: input.operationKey,
				machine: input.machine,
				account: input.account,
				field: input.field,
			};
		},
		async execute(value, context) {
			check(context);
			const input = value as Record<string, string>;
			const machine = await find(input.machine, context.signal);
			if (!machine) return notFilled("MACHINE_NOT_FOUND", `no machine is named ${input.machine}`);
			if (machine.state !== "running")
				return notFilled("MACHINE_NOT_RUNNING", `${machine.name} is ${machine.state}`);
			const typist = options.gateway.accountFill?.bind(options.gateway);
			if (!typist) throw new Error("Company account fills are unavailable");
			return options.operations.execute({
				operation: {
					tool: "fill_company_account",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: input.operationKey,
					arguments: input,
					target: { realm: "company_machine", machineId: machine.machineId },
					requiresCompanyRevision: false,
				},
				signal: context.signal,
				observation: context.observation,
				// The executor's request is 30 s at most, and is sent once.
				performMs: 45_000,
				authorize: async (_operation, admitted) => {
					if (!isDeepStrictEqual(admitted, identity)) throw new Error("Company account fill identity changed");
				},
				perform: async (operation, effect) => {
					try {
						// The executor and the vault are bound to this receipt and this exact call (its digest).
						await typist(
							{ machineId: machine.machineId },
							{
								commandId: effect.receiptId,
								envelope: cloudNativeToolOperationEnvelope(effect.identity, operation),
								idempotencyKey: effect.idempotencyKey,
							},
							effect.signal,
						);
					} catch (error) {
						if (!(error instanceof CloudMachineAccountFillRefusal)) throw error;
						if (error.code === "VAULT_REFUSED")
							return { content: notFilled(error.code, error.vault ?? "the vault refused this account") };
						return { content: notFilled(error.code, ACCOUNT_FILL_REFUSED[error.code]) };
					}
					return {
						content: {
							kind: "json",
							value: {
								filled: { machine: machine.name, account: input.account, field: input.field },
								next: ACCOUNT_FILL_NO_SCREENSHOT,
							},
						},
					};
				},
			});
		},
	};

	/**
	 * machine_screen (20260930708000; Jonas, 10 November 2026: agents ask for a desktop computer and must see and drive
	 * it). A look carries no receipt and changes nothing; an action is one receipted call (exactly once per operationKey:
	 * the receipt, and the machine's own marker for it). The executor of the machine's node runs the image's screen helper
	 * once; its PNG is converted here (cloud-folder-images.ts: our own decoder, fitted to the fence's size) and shown with
	 * the answer that names its hash. Only that answer is kept (the receipt, the run log); the picture never is. A replay of
	 * a completed action never runs it again and shows no picture.
	 */
	const screenGateway = options.gateway.screen?.bind(options.gateway);
	/** The active window this run last saw on each machine: its next action's card names it (prepare). */
	const lastWindow = new Map<string, string>();
	const screenRefusal = (machine: string, reason: string, message: string): CloudToolContent => ({
		kind: "json",
		value: { machine, kind: "screen", refused: { reason, message } },
	});
	/** The answer the model reads, and the picture shown with it: the screen's size and the picture's, what the action
	 * did, the titles, and why anything is held back, fitted to one result. */
	const present = async (
		machine: string,
		answer: CloudMachineScreenAnswer,
		look: boolean,
		signal: AbortSignal,
	): Promise<{ value: Record<string, JsonValue>; image?: { png: Buffer; sha256: string } }> => {
		const { header } = answer;
		const value: Record<string, JsonValue> = { machine, kind: "screen" };
		let image: { png: Buffer; sha256: string } | undefined;
		if (answer.png !== null) {
			try {
				const bytes = Buffer.from(answer.png, "base64");
				const view = await oneImageAtATime(signal, async () => folderImageView(bytes));
				image = { png: view.png, sha256: view.sha256 };
				value.imageSha256 = view.sha256;
				value.screen = { width: view.width, height: view.height };
				value.shown = { width: view.shownWidth, height: view.shownHeight };
				if (view.shownWidth !== view.width || view.shownHeight !== view.height)
					value.scaled = "the picture is smaller than the screen: x and y are always the screen's pixels";
			} catch (error) {
				signal.throwIfAborted();
				if (!(error instanceof FolderImageRefusal)) throw error;
				value.noPicture = "the screenshot could not be shown: look again";
			}
		} else if (look && answer.heldBack === undefined) value.noPicture = "no screenshot was taken: look again";
		if (header.action)
			value.action = {
				type: header.action.type,
				exitCode: header.action.exitCode,
				...(header.action.error !== undefined ? { error: header.action.error } : {}),
			};
		if (header.started) value.started = true;
		if (answer.heldBack !== undefined)
			value.heldBack = `${answer.heldBack}; the picture and the titles stay on the machine: look again`;
		// 20260930734000: members share the screen with the agent; one of them used it since the agent was last told.
		if (answer.memberTouched !== undefined)
			value.memberTouched = `${[...answer.memberTouched.name].slice(0, 80).join("")} used this screen ${answer.memberTouched.secondsAgo} seconds ago (members can use it with you): what you saw before may have changed, so ${image ? "go by this picture" : "look again"} before you act`;
		value.activeWindow = header.activeWindow;
		const windows = [...header.windows];
		let more = header.moreWindows;
		const shown = () => ({ ...value, windows, ...(more ? { moreWindows: more } : {}) });
		while (windows.length && !fits(shown())) {
			windows.pop();
			more++;
		}
		if (answer.heldBack === undefined && header.activeWindow) lastWindow.set(machine, header.activeWindow);
		return { value: shown(), ...(image ? { image } : {}) };
	};
	const screenAction = {
		type: "object",
		additionalProperties: false,
		required: ["type"],
		description:
			"One action, then the screen is shown. x, y, toX and toY are screen pixels (0 to 3839, 0 to 2159), from the top left.",
		properties: {
			type: { type: "string", enum: [...MACHINE_SCREEN_VERBS] },
			x: { type: "integer", minimum: 0, maximum: 3839 },
			y: { type: "integer", minimum: 0, maximum: 2159 },
			toX: { type: "integer", minimum: 0, maximum: 3839 },
			toY: { type: "integer", minimum: 0, maximum: 2159 },
			button: { type: "string", enum: ["left", "middle", "right"] },
			text: { type: "string", minLength: 1, maxLength: 500 },
			keys: {
				type: "array",
				minItems: 1,
				maxItems: 16,
				items: { type: "string", pattern: "^[A-Za-z0-9_][A-Za-z0-9_+]{0,39}$" },
				description:
					"Key names such as Return, Tab, Escape or ctrl+l; never an xdotool command word such as exec or type.",
			},
			direction: { type: "string", enum: ["up", "down"] },
			steps: { type: "integer", minimum: 1, maximum: 30 },
			target: { type: "string", minLength: 1, maxLength: 2000 },
		},
	};
	const screen: CloudNativeTool = {
		name: "machine_screen" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		images: true,
		description: CLOUD_MACHINE_SCREEN_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["machine"],
			properties: {
				machine: { ...machineName, description: "The running machine whose desktop to see and drive." },
				action: screenAction,
				settleMs: {
					type: "integer",
					minimum: 0,
					maximum: MACHINE_SCREEN_MAX_SETTLE_MS,
					description: "The wait after the action: 500 by default, 2500 for open, 0 for a look.",
				},
				look: { type: "boolean", description: "false answers the titles without a picture." },
				intent: {
					type: "string",
					minLength: 1,
					maxLength: 200,
					description: "What the action is for, in a few words.",
				},
				operationKey,
			},
		},
		parseArguments(value) {
			const input = closed(value, ["machine"], ["action", "settleMs", "look", "intent", "operationKey"]);
			name(input.machine);
			const action: MachineScreenAction | null =
				input.action === undefined ? null : parseMachineScreenAction(input.action);
			if (action && input.operationKey === undefined)
				throw new Error("An action on the screen needs an operationKey; a look takes none");
			if (!action && input.operationKey !== undefined)
				throw new Error("A look takes no operationKey; only an action does");
			if (action) key(input.operationKey);
			const settleMs = input.settleMs ?? machineScreenDefaultSettleMs(action);
			if (!Number.isSafeInteger(settleMs) || Number(settleMs) < 0 || Number(settleMs) > MACHINE_SCREEN_MAX_SETTLE_MS)
				throw new Error(`machine_screen's settleMs is 0 to ${MACHINE_SCREEN_MAX_SETTLE_MS}`);
			if (input.look !== undefined && typeof input.look !== "boolean")
				throw new Error("machine_screen's look is true or false");
			const intent = typeof input.intent === "string" ? input.intent.trim().replace(/\s+/g, " ") : undefined;
			if (input.intent !== undefined && (!intent || [...intent].length > 200 || /\p{Cc}/u.test(intent)))
				throw new Error("machine_screen's intent is one line of 1 to 200 characters");
			if (action && MACHINE_SCREEN_REVIEWED_VERBS.includes(action.type) && intent === undefined)
				throw new Error(`machine_screen's ${action.type} needs an intent: what it is for, in a few words`);
			return {
				machine: input.machine,
				...(action ? { operationKey: input.operationKey, action: action as unknown as JsonValue } : {}),
				settleMs: Number(settleMs),
				look: input.look !== false,
				...(intent !== undefined ? { intent } : {}),
			};
		},
		// An action's card names the window the agent last saw on that machine, as this run's own looks told it.
		async prepare(value) {
			const input = value as Record<string, JsonValue>;
			const window = lastWindow.get(String(input.machine));
			return input.action !== undefined && window !== undefined ? { ...input, window } : value;
		},
		async execute(value, context) {
			check(context);
			const { window: _window, ...args } = value as Record<string, JsonValue>;
			const named = String(args.machine);
			const machine = await find(named, context.signal);
			if (!machine) return screenRefusal(named, "MACHINE_NOT_FOUND", `no machine is named ${named}`);
			if (machine.state !== "running")
				return screenRefusal(machine.name, "MACHINE_NOT_RUNNING", `${machine.name} is ${machine.state}`);
			if (!screenGateway) throw new Error("Machine screens are unavailable");
			const scope = { machineId: machine.machineId };
			const settleMs = Number(args.settleMs);
			const look = args.look !== false;
			if (args.action === undefined) {
				// A look: nothing changes, so an unanswered one is only looked at again.
				let answer: CloudMachineScreenAnswer;
				try {
					answer = await screenGateway(scope, { commandId: null, envelope: null, settleMs, look }, context.signal);
				} catch (error) {
					if (error instanceof CloudMachineScreenRefusal)
						return screenRefusal(machine.name, error.code, SCREEN_REFUSED[error.code]);
					if (error instanceof CloudMachineCommandUnanswered && !context.signal.aborted)
						return screenRefusal(
							machine.name,
							"MACHINE_UNANSWERED",
							"the machine did not answer in time: look again",
						);
					throw error;
				}
				check(context);
				const shown = await present(machine.name, answer, look, context.signal);
				return { kind: "json", value: shown.value, ...(shown.image ? { image: shown.image } : {}) };
			}
			let image: { png: Buffer; sha256: string } | undefined;
			let performed = false;
			const content = await options.operations.execute({
				operation: {
					tool: "machine_screen",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: String(args.operationKey),
					arguments: args,
					target: { realm: "company_machine", machineId: machine.machineId },
					requiresCompanyRevision: false,
				},
				signal: context.signal,
				observation: context.observation,
				performMs: CLOUD_MACHINE_SCREEN_PERFORM_MS,
				authorize: async (_operation, admitted) => {
					if (!isDeepStrictEqual(admitted, identity)) throw new Error("Machine screen identity changed");
				},
				perform: async (operation, effect) => {
					performed = true;
					// Sent once: an action that went unanswered is never sent again (the machine's marker refuses it too).
					const input: CloudMachineScreenInput = {
						commandId: effect.receiptId,
						envelope: cloudNativeToolOperationEnvelope(effect.identity, operation),
						settleMs,
						look,
					};
					let answer: CloudMachineScreenAnswer;
					try {
						answer = await screenGateway(scope, input, effect.signal);
					} catch (error) {
						if (error instanceof CloudMachineScreenRefusal)
							return { content: screenRefusal(machine.name, error.code, SCREEN_REFUSED[error.code]) };
						throw error;
					}
					const shown = await present(machine.name, answer, look, effect.signal);
					image = shown.image;
					return { content: { kind: "json", value: shown.value } };
				},
			});
			if (performed) {
				const shownImage = image as { png: Buffer; sha256: string } | undefined;
				const showsIt =
					shownImage !== undefined &&
					content.kind === "json" &&
					content.value !== null &&
					typeof content.value === "object" &&
					!Array.isArray(content.value) &&
					content.value.imageSha256 === shownImage.sha256;
				return showsIt ? { ...content, image: shownImage } : content;
			}
			// This operationKey's action ran before: it is never run again, and its picture is not kept.
			if (
				content.kind !== "json" ||
				!content.value ||
				typeof content.value !== "object" ||
				Array.isArray(content.value)
			)
				return content;
			const { imageSha256: _sha, screen: _screen, shown: _shown, scaled: _scaled, ...stored } = content.value;
			return {
				kind: "json",
				value: {
					...stored,
					replayed:
						"this action ran before under this operationKey and never runs again: look (no action) to see the screen now",
				},
			};
		},
	};

	return [
		start,
		run,
		read,
		cancel,
		change("stop", CLOUD_MACHINE_STOP_DESCRIPTION),
		change("delete", CLOUD_MACHINE_DELETE_DESCRIPTION),
		listTool,
		...(codingValueSaving ? [save] : []),
		...(accountFilling ? [fill] : []),
		...(screenGateway ? [screen] : []),
	];
}

export { CLOUD_MACHINE_TOOL_VERSION, cloudMachineCommandHead };
