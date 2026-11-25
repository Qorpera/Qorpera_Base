import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
	CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES,
	CLOUD_CODING_COMMAND_PAGE_BYTES,
	CLOUD_MACHINE_FOLDER_LIMITS,
	CLOUD_MACHINE_FOLDER_LOST,
	CLOUD_MACHINE_GUEST_PATHS,
	CLOUD_MACHINE_HOME,
	type CloudCodingCommandRead,
	type CloudCodingNasPolicy,
	type CloudMachineCommandFolder,
	type CloudMachineCommandReceipt,
	type CloudMachineFolderNotSaved,
	cloudMachineFolderBytes,
	type IdleRuleSample,
	idleRuleBusy,
	isCloudMachineFolderLost,
	isRecord,
	parseCloudCodingNasPolicy,
	parseCloudMachineCommandFolder,
	parseCloudMachineCommandReceipt,
	UUID_PATTERN,
} from "@qorpera/contracts";
import { withAbortScope, withTimeoutScope } from "./abort-scope.ts";
import type { AgentPlug } from "./agent-plug.ts";
import { CodingControlBusy, CodingControlRefused } from "./coding-executor.ts";
import { type CodingMachineIntent, reconcileCodingMachine, waitPendingLxdOperation } from "./coding-machine.ts";
import { type CodingNasStorage, createCodingNasStorage } from "./coding-storage.ts";
import {
	type CompanyMachinePolicy,
	type LxdCompanyMachineBinding,
	lxdCompanyMachineJournalPlan,
	lxdCompanyMachineName,
	parseCompanyMachinePolicy,
} from "./company-machine.ts";
import { type CompanyMachineDiskPlacement, CompanyMachineDiskReader } from "./company-machine-disk.ts";
import { COMPANY_MACHINE_DESKTOP_FIGURE, companyMachineDesktopFigure } from "./company-machine-figure.ts";
import {
	COMPANY_MACHINE_DESKTOP_VIEW,
	COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM,
	type DesktopStreamOptions,
	type DesktopStreamRelease,
	type DesktopStreamSink,
} from "./company-machine-stream.ts";
import type { DesktopRelaySpec, WatchedDesktop } from "./company-machine-stream-process.ts";
import { COMPANY_MACHINE_DESKTOP_TIME_ZONE, companyMachineDesktopTimeZone } from "./company-machine-time-zone.ts";
import type { FolderCommandWindow, FolderControl, MachineBoundary } from "./folder-control.ts";
import type {
	LxdInstanceExecPipeClient,
	LxdInstanceExecStreamClient,
	LxdStoragePoolUseClient,
	LxdTrackedClient,
} from "./lxd-client.ts";
import { checkDirectory, code } from "./lxd-office-journal-files.ts";
import { LINE_PIPE_BYTES, LinePipe, sftpBytes, sftpLines } from "./machine-exec-server.ts";
import { type HomeFolderSession, HomeOutputGate, parseHomeFolderAnswer } from "./machine-home-folder.ts";

async function awaitRaceAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<void>((resolve) => {
				onAbort = () => resolve();
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

async function runLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++]!;
			await run(item);
		}
	});
	await Promise.all(workers);
}

const SHA = /^[0-9a-f]{64}$/;
/** A view's pass, as the folder core makes it. */
const PASS = /^[A-Za-z0-9_-]{43}$/;
const PATHS = CLOUD_MACHINE_GUEST_PATHS;
/** Long on purpose: jobs of hours must outlive an executor restart or a
 * release cut. It stops the commands of a machine the control plane lost. */
export const COMPANY_MACHINE_LEASE_MS = 900000;
/** How long a start waits for its boot's folder: the gateway's request to the executor is bounded at 30 s. */
const FOLDER_WAIT_MS = 20000;
/** A boundary before a command's output leaves. */
const BOUNDARY_MS = 15000;
/** The windows of one pass's ended commands, all of them. */
const WINDOWS_MS = 30000;
/** A home's output (slice 3, 20260930754000): the least time between two releases of what its channel sends back, how
 * often a release that did not answer is tried before the channel ends, and what may wait for one. */
const HOME_RELEASE_SPACING_MS = 200;
/** How many of those releases an exec channel may start without waiting (HomeOutputGateOptions.burst): a shell command's
 * start answer, output and exit pass at once; a stream is still held to one release per 200 ms. */
const HOME_RELEASE_BURST = 4;
/** The file channel's (slice C1): none. SFTP is a request and its answer, one after another for most of what Claude
 * Code's file tools do (a Read is a stat, an open, a read and a close), and a release may come at most once per spacing,
 * so 200 ms there made each of those round trips 200 ms (C1's proof: 200 small files read one after another took 105 s
 * through the gate against 1.8 s without it). Every answer still leaves only after a release that began after it came:
 * one release at a time, each as soon as the one before it ended, so the round trip costs one release, and answers that
 * come while one is out leave together after the next. */
const HOME_SFTP_RELEASE_SPACING_MS = 0;
const HOME_RELEASE_TRIES = 3;
const HOME_OUTPUT_WAIT_BYTES = 16 * 1024 * 1024;
/** A boot's final boundary: what an unanswered final held is not applied, and the stop goes on. */
const FINAL_BOUNDARY_MS = 60000;
/** folder-mount: the guest waits up to 60 s for a mount still settling, then up to 100 × 200 ms for readiness. */
const FOLDER_MOUNT_MS = 100000;
/** Views one boot is opened, while its guest answers that the node closed them. */
const FOLDER_OPENS = 3;
/** How long a boot's own view may be missing from the service before its guest restarts: the folder program takes 45 s
 * without a frame for a dead link and connects again (a restarted service, say), and the service renews each view it
 * serves every 40 s. A view the core closed (a narrowing, or a crashed service's) does not come back. */
const FOLDER_GONE_MS = 90000;
/** The guest's own reboot, asked without waiting for it. */
const REBOOT_MS = 30000;
/** A start's delivery, which a restart waits for: the gateway's request to the executor is bounded at 30 s. */
const DELIVERY_MS = 30000;
/** A start on a machine with a folder runs in its guest only on the boot it was let in on (`$0`): the guest's shell
 * compares the kernel's boot id at the exec, then runs the helper (`$@`). The helper's own start takes no boot. */
const ON_BOOT = 'read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ] && exec "$@"';
/** The agent's home (lanes/agent-box-20261113): the machine's Codex, hashed as root on the boot SQL named (`$0`; else
 * exit 97) where the image has it (`$1`; else exit 98). */
const HOME_CODEX_ON_BOOT =
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97; [ -f "$1" ] || exit 98; exec /usr/bin/sha256sum -- "$1"';
/** How long the hash of the machine's Codex (319 MB) may take, once per boot. */
const HOME_CODEX_HASH_MS = 60000;
/** The file channel (slice C1): whether the machine has sftp-server, as root on the boot SQL named (`$0`; else exit 97);
 * exit 98 where the image has none (an earlier image's disk), 0 where it has it. */
const HOME_SFTP_ON_BOOT =
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97; [ -x "$1" ] || exit 98';

/**
 * The agent's home (lanes/agent-box-20261113): one channel's `codex exec-server --listen stdio`, started as root on the
 * boot SQL named (ON_BOOT) as a transient unit of its own in the machines' slice, run as the agent's account. So what
 * the agent starts in its own shell is the machine's work exactly as a machine_run command's unit is: the idle rule
 * counts it (the LXD agent's unit is the machine's own control, and is not counted), the slice's memory bound and the
 * memory guard apply to it (the LXD agent's OOMScoreAdjust=-900, deploy/machine/lxd-agent-memory.conf, is not
 * inherited), the watchdog and the machine's stop end it with the slice, and when its channel ends the whole unit ends
 * (KillMode=control-group), a process the agent detached included. `--pipe` hands the exec's stdin and stdout to the
 * service itself; the environment is the service's, never expanded by systemd. Proven on a real machine of the live
 * image (home-lxd, 14 Nov 2026).
 *
 * A channel of kind `sftp` (Claude Code on the home, slice C1) runs OpenSSH's `sftp-server` in the same shape, its unit
 * named `…-sftp-<channel>`: P4's file channel (lanes/agent-box-20261113/p4-claude-home), so what Claude Code's file
 * tools write is the agent's, in the company folder through the machine's own `/company` mount, as the exec-server's.
 * No shell is around either program: systemd starts it with the environment below and the channel's pipe as stdio.
 */
export function companyMachineHomeCommand(
	bootId: string,
	sessionId: string,
	channel: string,
	kind: "exec" | "sftp" = "exec",
): string[] {
	if (
		!UUID_PATTERN.test(bootId) ||
		!UUID_PATTERN.test(sessionId) ||
		!/^[0-9a-f]{8,32}$/.test(channel) ||
		(kind !== "exec" && kind !== "sftp")
	)
		throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
	const environment = {
		HOME: CLOUD_MACHINE_HOME.home,
		USER: CLOUD_MACHINE_HOME.account,
		LOGNAME: CLOUD_MACHINE_HOME.account,
		CODEX_HOME: `${CLOUD_MACHINE_HOME.home}/.codex`,
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		LANG: "C.UTF-8",
		TZ: "UTC",
		NO_COLOR: "1",
	};
	return [
		"/bin/sh",
		"-c",
		ON_BOOT,
		bootId,
		"/usr/bin/systemd-run",
		"--quiet",
		"--pipe",
		"--wait",
		"--collect",
		"--service-type=exec",
		"--expand-environment=no",
		`--unit=${CLOUD_MACHINE_HOME.unitPrefix}${sessionId}-${kind === "sftp" ? "sftp-" : ""}${channel}`,
		`--slice=${PATHS.slice}`,
		`--uid=${CLOUD_MACHINE_HOME.uid}`,
		`--gid=${CLOUD_MACHINE_HOME.gid}`,
		`--working-directory=${CLOUD_MACHINE_HOME.cwd}`,
		"--property=KillMode=control-group",
		"--property=TimeoutStopSec=10",
		...Object.entries(environment).map(([key, value]) => `--setenv=${key}=${value}`),
		...(kind === "sftp"
			? [CLOUD_MACHINE_HOME.sftpServer]
			: [CLOUD_MACHINE_HOME.codex, "exec-server", "--listen", "stdio"]),
	];
}
/** save_coding_value's clipboard helper (20260930705000), packaged beside the guest helper and installed by the image
 * (scripts/package-machine-guest.mjs). Not the guest helper: its pin stays as it was. */
export const COMPANY_MACHINE_CODING_VALUE_HELPER = "/opt/qorpera-machine/cloud-machine-coding-value.mjs";
/** The helper runs only on the boot SQL named (`$0`; else exit 97) and only where the image has it (`$2`; else exit 98,
 * an earlier image: a machine made from the current one has it). */
const CODING_VALUE_ON_BOOT =
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97; [ -f "$2" ] || exit 98; exec "$@"';
/** One JSON line: a box (five base64url parts) or a refusal's code. */
const CODING_VALUE_OUTPUT_BYTES = 16384;
/** The helper reads the clipboard and clears it, each xsel killed after 4 s (cloud-machine-coding-value.ts,
 * MACHINE_XSEL_MS; the clears side by side): about 8 s, so its own clear runs well before this deadline, which is inside
 * the gateway's 30 s. */
const CODING_VALUE_MS = 20000;
/** How long save_coding_value waits for a desktop an agent's action holds (F29): the runtime gives the whole call 30 s,
 * and the helper itself 20 s of it. */
const CODING_VALUE_WAIT_MS = 6000;
/** A clear's own deadline. The helper's `--clear-only` after a save that did not end cleanly or a member's paste runs
 * under it alone, never the request's signal (the request may be what ended the run; two xsels side by side, 4 s each at
 * most, and the helper's start). The host's own clear script at save time (COMPANY_MACHINE_CLIPBOARD_CLEAR: four xsels
 * one after another, 2 s each at most inside the machine, so 8 s) runs under it and the request's signal (round 25 P2 of
 * #1661): a request that ends cuts it off, and a cut-off clear failed, records nothing and stays owed. */
const CODING_VALUE_CLEAR_MS = 10000;
export const COMPANY_MACHINE_ACCOUNT_FILL_HELPER = "/opt/qorpera-machine/cloud-machine-account-fill.mjs";
/** Two JSON lines at most: the key's public half, then a code. */
const ACCOUNT_FILL_OUTPUT_BYTES = 4096;
/** The helper gives itself 20 s (cloud-machine-account-fill.ts, MACHINE_ACCOUNT_FILL_MS); the exec ends 4 s later at
 * most, inside the command service's 30 s for the whole request. */
const ACCOUNT_FILL_MS = 24000;
/** The owed clear at an agent's screen call (F35 of #1661, round 24 N2): the fence, the host's own clear script and the
 * record together, at most this long. The caller gives the call 30 s; the helper takes 22 s at most (SCREEN_MS) and the
 * folder's boundary 4 s (SCREEN_BOUNDARY_MS): 3 s is what is left with a second for the way back. The script bounds
 * itself to 2 s here (four xsels, 0.5 s each inside the machine), leaving 1 s for the fence, its start and the record. A
 * healthy desktop clears in well under a second; a slow one ends its own clear (an xsel killed at its bound: failed), or
 * is cut off here; either way nothing is recorded and the clear stays owed (the next screen call, or save_coding_value's
 * own clear, does it). */
const SCREEN_CLEAR_MS = 3000;
/** machine_screen's helper (20260930708000), packaged beside the guest helper and installed by the image
 * (scripts/package-machine-guest.mjs). Not the guest helper: its pin stays as it was. It runs under the same wrapper as
 * save_coding_value's (CODING_VALUE_ON_BOOT): on the boot SQL named (else exit 97) and where the image has it (else 98). */
export const COMPANY_MACHINE_SCREEN_HELPER = "/opt/qorpera-machine/cloud-machine-screen.mjs";
/** The helper's answer: one header line (64 KiB at most) and a PNG of 8 MiB at most (cloud-machine-screen.ts). */
const SCREEN_HEADER_BYTES = 65536;
const SCREEN_PNG_BYTES = 8 * 1024 * 1024;
const SCREEN_OUTPUT_BYTES = SCREEN_PNG_BYTES + SCREEN_HEADER_BYTES;
/** The helper's steps take 21 s at most (cloud-machine-screen.ts, MACHINE_SCREEN_STEP_MS: the desktop's status, its
 * start or the action, the settle and the shot); then the company folder's release (SCREEN_BOUNDARY_MS) and the run's
 * take-in. With an owed clear before it (SCREEN_CLEAR_MS, 3 s) that is 29 s, inside the gateway's 30 s. */
const SCREEN_MS = 22000;
/** A boundary before a screen leaves: short, as the request is bounded at 30 s. One that does not answer in time holds
 * the picture back (the agent looks again), as a read's holds its output. */
const SCREEN_BOUNDARY_MS = 4000;
/** How long a desktop stays busy after an action that did not end cleanly (the request aborted, SCREEN_MS ran out, or
 * the helper returned without reaching its own end, such as exit 137 when it was killed inside the machine):
 * the helper is killed, but what it started (an xdotool typing, a `desktop open` waiting on the desktop's lock) goes on
 * until the action's own deadline, which its transient unit's RuntimeMaxSec keeps in the machine apart from the helper
 * (cloud-machine-screen.ts: MACHINE_SCREEN_STEP_MS.action, 10 s), and then a second for its kill to land
 * (MACHINE_SCREEN_KILL_MS). Measured on a real machine: a killed helper's xdotool kept typing (review r1 F4, r2 F4). */
const SCREEN_ACTION_GRACE_MS = 11000;
/** The helper's exits besides 0: an action taken on this boot before (96), another boot (97), an earlier image (98). */
const SCREEN_EXITS: Readonly<Record<number, string>> = Object.freeze({
	96: "SCREEN_ACTION_TAKEN",
	97: "MACHINE_BOOT_CHANGED",
	98: "MACHINE_IMAGE_WITHOUT_SCREEN",
});
const SCREEN_VERBS = ["click", "double", "move", "drag", "type", "key", "scroll", "open"];
/** A screen of at most 3840 x 2160 (`desktop size`). */
const SCREEN_MAX_WIDTH = 3840;
const SCREEN_MAX_HEIGHT = 2160;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A member's look at a desktop (20260930712000, memberLook): one fixed script run as root on exactly the boot SQL named
 * (`$0`, else exit 97), with no helper of the image. scrot must be there (else 98, an earlier image), and the desktop's
 * unit active with its display answering (else 95: the screen is off; a look never starts it). With `$1` = keep it puts
 * off the desktop's own idle stop (touch -c: a desktop whose note is gone is stopping anyway). The screenshot, with the
 * pointer drawn, goes to a root-only folder and out on stdout; the file goes with the script. A plain scrot does not
 * touch the desktop's note, so only `keep` does (measured on a 2 cpu / 4 GiB machine, 10 Nov 2026: 42 ms a look).
 *
 * LXD ends the shell with SIGKILL when the look is cut off (the request, its 6 s deadline), which no trap outlives, so
 * each look first removes the pictures of earlier looks that can no longer be in flight: named as its own and over a
 * minute old (review r1 F1). And a picture larger than the host takes is never streamed (exit 94): the trap removes it,
 * and the host never has to cut the exec off for its output. Plain sh, with date, stat, rm and cat. */
export const COMPANY_MACHINE_MEMBER_LOOK = [
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97',
	"command -v scrot >/dev/null 2>&1 || exit 98",
	"{ systemctl is-active --quiet qorpera-machine-desktop.service && DISPLAY=:1 xdpyinfo >/dev/null 2>&1; } || exit 95",
	// While a mover may run (20260930744000, review r3 F1 of #1733): no picture unless the desktop holds the fence the host
	// confirmed (`$3`, `FENCE INCARNATION`) and runs that incarnation now (else 93: the host writes it again).
	'if [ "$3" != - ]; then',
	"	{ exec 9>>/run/qorpera-pointer/lock && flock -w 2 9; } 2>/dev/null || exit 93",
	"	inc=$(readlink /run/systemd/units/invocation:qorpera-machine-desktop.service 2>/dev/null) || exit 93",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter expansion, not a template.
	'	[ "$(cat /run/qorpera-pointer/fence 2>/dev/null)" = "$3" ] && [ "$inc" = "${3#* }" ] || exit 93',
	"	exec 9>&-",
	"fi",
	'if [ "$1" = keep ]; then touch -c /run/qorpera-desktop/last-use; fi',
	"umask 077",
	"d=/run/qorpera-view",
	'mkdir -p "$d" || exit 1',
	'if now=$(date +%s) && [ -n "$now" ]; then',
	'\tfor old in "$d"/look-*.png; do',
	'\t\tm=$(stat -c %Y "$old" 2>/dev/null) && [ -n "$m" ] && [ $((now - m)) -gt 60 ] && rm -f "$old"',
	"\tdone",
	"fi",
	'f="$d/look-$$.png"',
	"trap 'rm -f \"$f\"' EXIT",
	// The member who moves the pointer with their own sees no second, drawn one (20260930744000: `$2` = plain); everyone
	// else's picture shows where it is.
	'if [ "$2" = plain ]; then DISPLAY=:1 scrot --overwrite --silent "$f" 2>/dev/null || exit 1;',
	'else DISPLAY=:1 scrot --pointer --overwrite --silent "$f" 2>/dev/null || exit 1; fi',
	`s=$(stat -c %s "$f" 2>/dev/null) && [ -n "$s" ] && [ "$s" -le ${SCREEN_PNG_BYTES} ] || exit 94`,
	'cat "$f"',
].join("\n");
/** The pointer's mover (20260930744000): one held-open X connection per desktop while a member's pointer moves, run as
 * root on exactly the boot SQL named (`$0`, else 97), with what the image has (python3, libX11, libXtst; else 98) and the
 * desktop's display answering (else 95). Its program (`$1`) gets the desktop's INCARNATION (`$2`): the invocation id of
 * qorpera-machine-desktop.service, as the host's own fence write read it the moment before (systemd's root-owned link
 * /run/systemd/units/invocation:qorpera-machine-desktop.service; it changes at every start of the desktop, and the X
 * server lives and dies inside one). It reads `X Y FENCE` lines on stdin and moves the pointer to X, Y; nothing else is
 * ever read or done: a line that is not two whole numbers of at most four digits and a fence is skipped. It touches the
 * desktop's idle clock at most every 30 s (a member at the desktop). It prints nothing.
 *
 * The fence, by construction (review r1 F1 and F2, r2 F1 and r3 F1 of #1733): a move can wait in the host's pipe, LXD's
 * websocket, the program's stdin and its read buffer, and the program itself can wait (before it opens X). ONLY THE HOST
 * WRITES THE FENCE (COMPANY_MACHINE_POINTER_FENCE): root's own folder /run/qorpera-pointer (0700), which no start or stop
 * of the desktop empties, holds `FENCE INCARNATION` and the lock; a mover never creates, initialises or writes either.
 * Under the lock (taken within 2 s, else it ends), the program checks that the fence file is there, that its incarnation
 * is the program's own, and that the desktop running now is that incarnation: before it opens X, again after, and
 * before every move, together with the line's fence being the file's. Anything else ends it at once (96 before any
 * line, 94 after): missing is closed, and a mover never lives into another incarnation of the desktop. It moves the
 * pointer only while holding the lock and waits for the X server to have done it (XSync) before it lets go. So a move
 * either took effect before the fence moved (an action, a newer generation's look) or never does, in this desktop or
 * any later one. Measured on a machine of the live image (13 Nov 2026): 0.2 to 0.4 ms a move, no process per move. */
export const COMPANY_MACHINE_MEMBER_POINTER = [
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97',
	"command -v python3 >/dev/null 2>&1 || exit 98",
	"{ systemctl is-active --quiet qorpera-machine-desktop.service && DISPLAY=:1 xdpyinfo >/dev/null 2>&1; } || exit 95",
	'exec python3 -c "$1" "$2"',
].join("\n");
/** The mover's program (COMPANY_MACHINE_MEMBER_POINTER's `$1`; the desktop's incarnation it is bound to is `sys.argv[1]`).
 * Its checks come before X is even loaded, so a machine without X or with a desktop of another incarnation ends it
 * having opened nothing. */
export const COMPANY_MACHINE_MEMBER_POINTER_PROGRAM = [
	"import ctypes, fcntl, os, re, sys, time",
	"FENCE = re.compile(r'([0-9a-f]{16}:[0-9]{1,15}) ([0-9a-f]{32})')",
	"mine = sys.argv[1] if len(sys.argv) > 1 else ''",
	"if not re.fullmatch(r'[0-9a-f]{32}', mine):",
	"    sys.exit(1)",
	"try:",
	"    lock = os.open('/run/qorpera-pointer/lock', os.O_WRONLY)",
	"except OSError:",
	"    sys.exit(96)",
	"def hold():",
	"    until = time.monotonic() + 2",
	"    while True:",
	"        try:",
	"            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)",
	"            return True",
	"        except BlockingIOError:",
	"            if time.monotonic() >= until:",
	"                return False",
	"            time.sleep(0.002)",
	"def current():",
	"    try:",
	"        with open('/run/qorpera-pointer/fence') as f:",
	"            kept = FENCE.fullmatch(f.read().strip())",
	"        now = os.readlink('/run/systemd/units/invocation:qorpera-machine-desktop.service')",
	"    except OSError:",
	"        return None",
	"    if not kept or kept.group(2) != mine or now != mine:",
	"        return None",
	"    return kept.group(1)",
	"def still():",
	"    if not hold():",
	"        return False",
	"    try:",
	"        return current() is not None",
	"    finally:",
	"        fcntl.flock(lock, fcntl.LOCK_UN)",
	"if not still():",
	"    sys.exit(96)",
	"try:",
	"    x11 = ctypes.CDLL('libX11.so.6')",
	"    xtest = ctypes.CDLL('libXtst.so.6')",
	"except OSError:",
	"    sys.exit(98)",
	"x11.XOpenDisplay.restype = ctypes.c_void_p",
	"x11.XOpenDisplay.argtypes = [ctypes.c_char_p]",
	"x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]",
	"xtest.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]",
	"display = x11.XOpenDisplay(b':1')",
	"if not display:",
	"    sys.exit(95)",
	"if not still():",
	"    sys.exit(96)",
	"touched = 0.0",
	"for line in sys.stdin.buffer:",
	"    words = line.split()",
	"    if len(words) != 3 or not all(word.isdigit() and len(word) <= 4 for word in words[:2]):",
	"        continue",
	"    if not hold():",
	"        sys.exit(94)",
	"    try:",
	"        fence = current()",
	"        if fence is None or words[2].decode('ascii', 'replace') != fence:",
	"            sys.exit(94)",
	"        xtest.XTestFakeMotionEvent(display, -1, int(words[0]), int(words[1]), 0)",
	"        x11.XSync(display, 0)",
	"    finally:",
	"        fcntl.flock(lock, fcntl.LOCK_UN)",
	"    now = time.monotonic()",
	"    if now - touched >= 30:",
	"        touched = now",
	"        try:",
	"            os.utime('/run/qorpera-desktop/last-use')",
	"        except OSError:",
	"            pass",
].join("\n");
/** The host writes its pointer fence on the desktop (COMPANY_MACHINE_MEMBER_POINTER, the fence), the only one who ever
 * does: as root on exactly the boot SQL named (`$0`, else 97), the fence `$1` (`NONCE:COUNT`, else 1), into root's own
 * /run/qorpera-pointer (made 0700 if missing; no start or stop of the desktop touches it), holding its lock (flock, at
 * most 2 s, else 1). The file holds `FENCE INCARNATION`: the incarnation is the desktop's now (its unit's invocation id
 * while it runs, else `none`), and the fence the newer of the file's and `$1` (same NONCE and a higher COUNT, or another
 * NONCE, a new host process). It is written whole (a new file renamed over the old), only when it changes, and printed:
 * what the desktop now holds is the host's confirmation, nothing less. Plain sh, with flock, readlink, cat and mv. */
export const COMPANY_MACHINE_POINTER_FENCE = [
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97',
	'printf %s "$1" | grep -qxE "[0-9a-f]{16}:[0-9]{1,15}" || exit 1',
	"install -d -o root -g root -m 0700 /run/qorpera-pointer || exit 1",
	"exec 9>>/run/qorpera-pointer/lock || exit 1",
	"flock -w 2 9 || exit 1",
	"now=$(readlink /run/systemd/units/invocation:qorpera-machine-desktop.service 2>/dev/null) || now=",
	"systemctl is-active --quiet qorpera-machine-desktop.service || now=",
	'printf %s "$now" | grep -qxE "[0-9a-f]{32}" || now=none',
	"old=$(cat /run/qorpera-pointer/fence 2>/dev/null) || old=",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter expansion, not a template.
	"kept=${old%% *}",
	"fence=$1",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter expansion, not a template.
	'if printf %s "$kept" | grep -qxE "[0-9a-f]{16}:[0-9]{1,15}" && [ "${kept%%:*}" = "${1%%:*}" ]; then',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter expansion, not a template.
	'\t[ "${kept##*:}" -gt "${1##*:}" ] && fence=$kept',
	"fi",
	'if [ "$old" != "$fence $now" ]; then',
	'\tprintf "%s %s" "$fence" "$now" > /run/qorpera-pointer/fence.new || exit 1',
	"\tmv -f /run/qorpera-pointer/fence.new /run/qorpera-pointer/fence || exit 1",
	"fi",
	"cat /run/qorpera-pointer/fence || exit 1",
].join("\n");
/** The fence's own deadline: a healthy desktop writes it in a few milliseconds. */
const POINTER_FENCE_MS = 3000;
/** A mover that ended within this long may still have had moves on their way when it did: the fence is written then too. */
const POINTER_FENCE_AFTER_MOVER_MS = 5000;
/** How many times one caller looks again for a confirmed fence while it keeps moving (#confirmFence) before it gives up. */
const POINTER_FENCE_ROUNDS = 4;
/** The largest of LXD's messages a desktop's live picture takes from its relay (20260930745000). */
const MEMBER_STREAM_MESSAGE_BYTES = 4 * 1024 * 1024;
/** At most this many desktops watched at once on this node, each in a process of its own that systemd starts in its own
 * cgroup (`qorpera-desktop-stream@.service`, deploy/coding-worker/): the socket's MaxConnections is 12, four more for
 * instances still stopping, and the kernel holds each instance to 512 MiB and one core, all of them to 3 GiB and four
 * (`qorpera_desktop_streams.slice`), apart from the executor's own 2 GiB and two. A member asking for a further desktop
 * is refused STREAM_BUSY: the window keeps its pictures and its sharing as they were, and asks again 30 s later. */
export const MAX_WATCHED_DESKTOPS = 8;
/** Starts are paced here, far under the socket's trigger limit (TriggerLimitBurst=50 in 2 s; past it systemd fails the
 * socket unit and it stays failed): one desktop's instance at most once every DESKTOP_START_GAP_MS, the node's at most
 * one every NODE_START_GAP_MS, so at most 5 in any 2 s. A member's start waits its turn; it is never refused for it. */
const DESKTOP_START_GAP_MS = 2000;
const NODE_START_GAP_MS = 500;

/** Waits `ms`, or until `signal` aborts; leaves no timer or listener behind. */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			globalThis.clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = globalThis.setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** A watched desktop's relay, through `client`'s exec: in the desktop's own instance, its own client on the node's
 * socket. */
export function desktopRelay(
	client: Required<LxdInstanceExecPipeClient>,
	spec: DesktopRelaySpec,
): DesktopStreamOptions["run"] {
	return (stdout, stdin, signal) =>
		client
			.execInstancePipe(
				spec.project,
				spec.name,
				{
					command: [...spec.command],
					environment: {},
					cwd: "/",
					stdin,
					// Each of LXD's messages, never the whole: the picture flows for as long as it is watched.
					maxStdoutBytes: spec.maxStdoutBytes,
					stdout,
					stderrTailBytes: 0,
				},
				signal,
			)
			.then((result) => result.exitCode);
}
/** A mover with no move for this long is closed (its stdin ends); the next move starts another. */
const MEMBER_POINTER_IDLE_MS = 20000;
/** After a mover failed (the screen off, another boot, no X), moves are refused with its reason for this long, then a
 * move starts another. */
const MEMBER_POINTER_FAILED_MS = 3000;
/** The member whose pointer moved a desktop within this long sees their own pointer only (their looks are plain). */
const MEMBER_POINTER_PLAIN_MS = 10000;
const MEMBER_POINTER_EXITS: Readonly<
	Record<number, "DESKTOP_NOT_RUNNING" | "MACHINE_BOOT_CHANGED" | "MACHINE_IMAGE_WITHOUT_SCREEN">
> = Object.freeze({
	95: "DESKTOP_NOT_RUNNING",
	// It ended before any line: no fence, no lock, or not this desktop's incarnation (a restart came in between).
	96: "DESKTOP_NOT_RUNNING",
	97: "MACHINE_BOOT_CHANGED",
	98: "MACHINE_IMAGE_WITHOUT_SCREEN",
});
/** A desktop's mover (20260930744000): the boot it runs on, the newest position not given yet (a newer move replaces
 * it: never a queue), how to wake its stdin, and how it stops. */
/** What a desktop confirmed it holds (COMPANY_MACHINE_POINTER_FENCE's answer): on which boot, the fence, and the
 * desktop's incarnation (`none` when it was not running). */
interface PointerFence {
	readonly bootId: string;
	readonly fence: string;
	readonly incarnation: string;
}
interface PointerMover {
	readonly bootId: string;
	readonly stop: AbortController;
	/** The newest move not given yet, with the host's fence and the pass's lease generation of the moment it was taken. */
	pending: { x: number; y: number; fence: string; generation: number } | null;
	wake: () => void;
}
/** A member's look takes 42 ms on the machine; this bounds a busy one, inside the member's request of 30 s. */
const MEMBER_LOOK_MS = 6000;
/** The script's exits besides 0: the screen is off (95), another boot (97), an image without scrot (98). */
const MEMBER_LOOK_EXITS: Readonly<Record<number, CompanyMachineMemberLookRefusal>> = Object.freeze({
	95: "DESKTOP_NOT_RUNNING",
	97: "MACHINE_BOOT_CHANGED",
	98: "MACHINE_IMAGE_WITHOUT_SCREEN",
});
/**
 * The host's own clear of a desktop's clipboard after a member held it (F32 to F35 of #1661; the one clear that is
 * recorded), as root on exactly the boot SQL named, with no helper of the image: the helper's `--clear-only` answers cleared whatever xsel did, so it confirms
 * nothing. With no display there is no clipboard (exit 0): image 91d433c0 keeps none past its desktop's session (no
 * clipboard manager, nothing saved; measured 11 Nov 2026). Otherwise both selections are cleared, each xsel must
 * succeed (else 1), and then each is read back and only its byte count kept (a read that fails counts its own word, so
 * it is never taken for empty): a byte left is 2. 97 is another boot, 98 an image without xsel. Nothing of a selection
 * leaves the pipe into wc. Plain sh; its arguments: the boot id, then where it runs, a fixed word that sets each xsel's
 * bound inside the machine (round 25 P1 of #1661: the host's cut kills only the shell, and an xsel would run on): at a
 * screen call 0.5 s, so the four end within 2 s, under SCREEN_CLEAR_MS (3 s, with the fence and the record); at save time
 * 2 s, so within 8 s, under CODING_VALUE_CLEAR_MS (10 s from the script's start). Any other word is 1. Each xsel is
 * killed (SIGKILL) at its bound, so none outlives the script's own end.
 */
/** Where the host's clear runs (COMPANY_MACHINE_CLIPBOARD_CLEAR's second argument): a closed list of fixed words. */
type ClipboardClearUse = "screen" | "save";
export const COMPANY_MACHINE_CLIPBOARD_CLEAR = [
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97',
	'case "$1" in screen) bound=0.5 ;; save) bound=2 ;; *) exit 1 ;; esac',
	"[ -S /tmp/.X11-unix/X1 ] || exit 0",
	"[ -x /usr/bin/xsel ] || exit 98",
	"export DISPLAY=:1",
	"for selection in --clipboard --primary; do",
	'\t/usr/bin/timeout --signal=KILL "$bound" /usr/bin/xsel --logfile /dev/null "$selection" --clear || exit 1',
	"done",
	"for selection in --clipboard --primary; do",
	'\tleft=$({ /usr/bin/timeout --signal=KILL "$bound" /usr/bin/xsel --logfile /dev/null "$selection" --output --selectionTimeout 3000 || echo failed; } | /usr/bin/wc -c)',
	'\t[ "$left" -eq 0 ] || exit 2',
	"done",
].join("\n");

/** A member's typed text on a desktop (20260930713000, memberAct): one fixed script run as root on exactly the boot SQL
 * named (`$0`, else exit 97, before anything acts), with the text on its stdin and never in an argument or a file. It is
 * not the screen helper's `type`: that runs `desktop type TEXT` as a transient systemd unit described by its command
 * line, which systemd writes into the machine's journal ("Started run-….service - [systemd-run] … desktop type TEXT",
 * measured with systemd 259 on 10 Nov 2026), where a member's password must never be. xdotool and xsel must be there
 * (else 98, an earlier image), and the desktop's unit active with its display answering (else 95: no action runs on a
 * screen that is off). The text stays in the shell's memory (`printf` is dash's own, so no process shows it). `$1` =
 * paste puts it on both selections and presses shift+Insert, as `desktop type` does for text beyond plain ASCII (a
 * letter outside the keyboard's layout comes out wrong through xdotool), and the executor clears both selections
 * after; otherwise xdotool types it from its stdin. The desktop's idle clock is touched, as the screen helper's action
 * touches it. Plain sh, with cat and touch. It runs in a transient unit of its own (companyMachineMemberTypeCommand). */
export const COMPANY_MACHINE_MEMBER_TYPE = [
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97',
	"{ command -v xdotool && command -v xsel; } >/dev/null 2>&1 || exit 98",
	"{ systemctl is-active --quiet qorpera-machine-desktop.service && DISPLAY=:1 xdpyinfo >/dev/null 2>&1; } || exit 95",
	"touch -c /run/qorpera-desktop/last-use",
	// The text whole, its last line breaks too (the x keeps them from the command substitution).
	"text=$(cat; printf x) || exit 1",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter expansion, not a template.
	"text=${text%x}",
	"export DISPLAY=:1",
	'if [ "$1" = paste ]; then',
	"\tfor selection in --clipboard --primary; do",
	// xsel stays behind to own the selection, in the unit's control group: it ends with the unit, 0.2 s after the paste.
	'\t\tprintf %s "$text" | xsel --logfile /dev/null "$selection" --input >/dev/null 2>&1 || exit 1',
	"\tdone",
	"\txdotool key --clearmodifiers shift+Insert || exit 1",
	"\tsleep 0.2",
	"else",
	'\tprintf %s "$text" | xdotool type --delay 12 --file - || exit 1',
	"fi",
].join("\n");
/** A member's typed text runs at most this long in the machine (its unit's RuntimeMaxSec): 500 characters at 12 ms a
 * key take 6 s. The same as a helper action's deadline, so the busy grace after a text that was cut off is the same
 * (SCREEN_ACTION_GRACE_MS: this and a second for the kill to land). */
const MEMBER_TYPE_UNIT_SECONDS = 10;
/** The executor's own deadline for a typed text: the unit's limit and the way back. */
const MEMBER_TYPE_MS = 12000;
/** What a typed text's unit is called in the journal: a fixed few words, never its command line. */
const MEMBER_TYPE_DESCRIPTION = "qorpera member text";
/**
 * How a member's typed text runs (review r1 F3): COMPANY_MACHINE_MEMBER_TYPE as a transient service, as the screen
 * helper runs an action's command (cloud-machine-screen.ts, machineScreenActionCommand), so systemd and not the shell
 * ends it: at RuntimeMaxSec it kills the unit's whole control group with SIGKILL (the shell, xdotool and any xsel),
 * also when the executor cut its client off, so nothing it started acts after the busy grace. `--pipe` hands the
 * unit the text on its stdin. The unit is described by a fixed text (MEMBER_TYPE_DESCRIPTION), so the journal's line
 * names neither the script nor the text, and its command line holds the constant script, the boot and the mode alone.
 * `--expand-environment=no` keeps the script's `$` as written. The xsel that owns a pasted text's selections is in the
 * unit's control group and ends with it, 0.2 s after the paste; the executor's clear runs all the same. `path` and
 * `slice` are the tests' own (stand-in tools).
 */
export function companyMachineMemberTypeCommand(
	bootId: string,
	mode: "type" | "paste",
	options: { seconds?: number; path?: string; slice?: string } = {},
): string[] {
	return [
		"/usr/bin/systemd-run",
		"--quiet",
		"--wait",
		"--pipe",
		"--collect",
		"--expand-environment=no",
		`--slice=${options.slice ?? "qorpera-machine.slice"}`,
		"-p",
		`RuntimeMaxSec=${options.seconds ?? MEMBER_TYPE_UNIT_SECONDS}`,
		"-p",
		"KillMode=control-group",
		"-p",
		"KillSignal=SIGKILL",
		`--description=${MEMBER_TYPE_DESCRIPTION}`,
		"--setenv=DISPLAY=:1",
		`--setenv=PATH=${options.path ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
		"--setenv=HOME=/root",
		"--setenv=LANG=C.UTF-8",
		"--setenv=USER=root",
		"--",
		"/bin/sh",
		"-c",
		COMPANY_MACHINE_MEMBER_TYPE,
		bootId,
		mode,
	];
}
/** The script's exits besides 0: the screen is off (95), another boot (97), an image without xdotool or xsel (98). */
const MEMBER_TYPE_EXITS: Readonly<Record<number, string>> = Object.freeze({
	95: "DESKTOP_NOT_RUNNING",
	97: "MACHINE_BOOT_CHANGED",
	98: "MACHINE_IMAGE_WITHOUT_SCREEN",
});
/** A member turns the desktop on (20260930714000): the image's own `desktop start` (/usr/local/bin/desktop, on the
 * unit's PATH), with no arguments, as root, on the boot named in `$0` (else 97). The helper must be there (else 98, an
 * image without a desktop). It takes the desktop's
 * own lock (`/run/qorpera-desktop.lock`: it waits for an agent's `desktop` command that holds it), checks the machine's
 * size only when the desktop is off (exit 3: too small), runs `systemctl start qorpera-machine-desktop.service`, and
 * waits until the display answers, the session runs and the screen is drawn (about 3 to 6 s); on a desktop that runs
 * it only touches its idle clock. Whether the desktop ran before is read first, without the lock, as the agent's helper
 * reads it (`desktop status` alone takes no lock either): 92 then, 0 when this start started it. Its output goes
 * nowhere: a failure is told by a fixed code. Plain sh. It runs in a transient unit of its own
 * (companyMachineMemberStartCommand). */
export const COMPANY_MACHINE_MEMBER_START = [
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97',
	"command -v desktop >/dev/null 2>&1 || exit 98",
	"running=0",
	"{ systemctl is-active --quiet qorpera-machine-desktop.service && DISPLAY=:1 xdpyinfo >/dev/null 2>&1; } && running=1",
	"desktop start >/dev/null 2>&1",
	"code=$?",
	'[ "$code" = 0 ] && [ "$running" = 1 ] && exit 92',
	'exit "$code"',
].join("\n");
/** A member's start runs at most this long in the machine (its unit's RuntimeMaxSec): the helper waits up to about 10 s
 * for the display, 10 s for the session and 6 s for the drawn screen, after its lock; the member bridge gives a request
 * 25 s. The desktop itself is a unit of its own (`systemctl start`), outside this unit's control group: the limit and
 * KillMode end the script and what it waits with, never a desktop that started. */
const MEMBER_START_UNIT_SECONDS = 20;
/** The executor's own deadline for a start: the unit's limit and the way back. */
const MEMBER_START_MS = 22000;
/** What a start's unit is called in the journal: a fixed few words. */
const MEMBER_START_DESCRIPTION = "qorpera member desktop start";
/**
 * How a member's start runs (20260930714000): COMPANY_MACHINE_MEMBER_START as a transient service, as a member's typed
 * text runs (companyMachineMemberTypeCommand), so systemd ends it at its limit with everything it started in its own
 * control group (the script, the helper, the helper's `systemctl`, `xdpyinfo`, `wmctrl`, `scrot` and `sleep`), also when
 * the executor cut its client off. The desktop's own service is started by systemd outside that group and runs on.
 * `path` and `slice` are the tests' own (stand-in tools).
 */
export function companyMachineMemberStartCommand(
	bootId: string,
	options: { seconds?: number; path?: string; slice?: string } = {},
): string[] {
	return [
		"/usr/bin/systemd-run",
		"--quiet",
		"--wait",
		"--collect",
		"--expand-environment=no",
		`--slice=${options.slice ?? "qorpera-machine.slice"}`,
		"-p",
		`RuntimeMaxSec=${options.seconds ?? MEMBER_START_UNIT_SECONDS}`,
		"-p",
		"KillMode=control-group",
		"-p",
		"KillSignal=SIGKILL",
		`--description=${MEMBER_START_DESCRIPTION}`,
		`--setenv=PATH=${options.path ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
		"--setenv=HOME=/root",
		"--setenv=LANG=C.UTF-8",
		"--setenv=USER=root",
		"--",
		"/bin/sh",
		"-c",
		COMPANY_MACHINE_MEMBER_START,
		bootId,
	];
}
/** The start's exits: 0 started, 92 running already, 3 too small (`desktop`'s own), 97 another boot, 98 no desktop in the
 * image. Anything else (the helper failed: 1, or systemd's for a unit killed at its limit) is a desktop that did not
 * start. */
const MEMBER_START_EXITS: Readonly<Record<number, CompanyMachineMemberStartOutcome>> = Object.freeze({
	0: { outcome: "started" },
	92: { outcome: "running" },
	3: { refused: "DESKTOP_MACHINE_TOO_SMALL" },
	97: { refused: "MACHINE_BOOT_CHANGED" },
	98: { refused: "MACHINE_IMAGE_WITHOUT_SCREEN" },
});
/** A member opens something of the company folder on the desktop (20260930758000), once the desktop runs: the image's own
 * `desktop open` with ONE word, the path's real place in the machine. The path comes on stdin, whole (the x keeps its
 * last line breaks from the command substitution; a path with a line break, which SQL's rule and the host's check never
 * let through, opens nothing): no shell parses it, and nothing of ours carries it (our unit's name, its description and
 * its arguments, our log lines). The image's own helper does name the opened folder in the machine's own journal (the
 * `systemd-run` lines of the page's server and the browser it starts), exactly as for an agent's `desktop open`. On the boot
 * named in `$0` (else 97), with the helper (else 98). The company folder is there when `/company` is a mount of its own
 * (else 89: a machine on an earlier helper has no `/company`, and one whose view is not mounted has an empty directory on
 * the root's device). The path's real place (every link
 * followed, `realpath -e`) must be inside `/company` and exist (else 91: not there, or a link that leads out): what is
 * opened is that real place, so a link swapped afterwards opens nothing else. The helper's own failure is 1 or 2, and
 * anything else is too: the open failed. Its output goes nowhere. Plain sh, in a transient unit of its own
 * (companyMachineMemberOpenCommand); what the helper starts runs on after the unit ends (its programs are launched
 * outside the unit, as an agent's `desktop open` launches them outside its action's unit). */
export const COMPANY_MACHINE_MEMBER_OPEN = [
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97',
	"command -v desktop >/dev/null 2>&1 || exit 98",
	'dev=$(stat -c %d /company 2>/dev/null) && [ "$dev" != "$(stat -c %d /)" ] || exit 89',
	"path=$(cat; printf x) || exit 1",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter expansion, not a template.
	"path=${path%x}",
	// No path of the folder has a line break (SQL's rule and the host's check refuse one): one here is no path at all.
	"case $path in '' | *'",
	"'*) exit 91 ;; esac",
	'real=$(realpath -e -- "/company/$path" 2>/dev/null) || exit 91',
	"case $real in /company/*) ;; *) exit 91 ;; esac",
	'desktop open "$real" >/dev/null 2>&1 || exit 1',
].join("\n");
/** An open runs at most this long in the machine (its unit's RuntimeMaxSec): the helper waits for the desktop's own lock
 * (an agent's desktop command holds it a few seconds at most), then starts a server and the browser and returns. */
const MEMBER_OPEN_UNIT_SECONDS = 8;
/** The executor's own deadline for an open: the unit's limit and the way back. */
const MEMBER_OPEN_MS = 10000;
/** What an open's unit is called in the journal: a fixed few words, never its path. */
const MEMBER_OPEN_DESCRIPTION = "qorpera member desktop open";
/** How long an open waits for the desktop's one actor (an agent's action, a member's) to be done before it says the
 * desktop is busy. */
const MEMBER_OPEN_WAIT_MS = 3000;
/** How long the desktop stays held after an open's unit ended: what it opened maps its window and takes the focus within
 * about this, so a member's next input waits for it rather than landing in it. */
const MEMBER_OPEN_SETTLE_MS = 2000;
/**
 * How a member's open runs (20260930758000): COMPANY_MACHINE_MEMBER_OPEN as a transient service, as a member's typed text
 * runs (companyMachineMemberTypeCommand): `--pipe` hands it the path on stdin; its command line holds the constant
 * script and the boot alone; systemd ends it at its limit with everything in its control group. `path` and `slice` are
 * the tests' own (stand-in tools).
 */
export function companyMachineMemberOpenCommand(
	bootId: string,
	options: { seconds?: number; path?: string; slice?: string } = {},
): string[] {
	return [
		"/usr/bin/systemd-run",
		"--quiet",
		"--wait",
		"--pipe",
		"--collect",
		"--expand-environment=no",
		`--slice=${options.slice ?? "qorpera-machine.slice"}`,
		"-p",
		`RuntimeMaxSec=${options.seconds ?? MEMBER_OPEN_UNIT_SECONDS}`,
		"-p",
		"KillMode=control-group",
		"-p",
		"KillSignal=SIGKILL",
		`--description=${MEMBER_OPEN_DESCRIPTION}`,
		`--setenv=PATH=${options.path ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
		"--setenv=HOME=/root",
		"--setenv=LANG=C.UTF-8",
		"--setenv=USER=root",
		"--",
		"/bin/sh",
		"-c",
		COMPANY_MACHINE_MEMBER_OPEN,
		bootId,
	];
}
/** The open's exits: 0 opened, 89 no company folder on this computer, 91 not in it, 97 another boot, 98 no desktop in the
 * image. Anything else (the helper failed, or systemd's for a unit killed at its limit) is an open that failed. */
const MEMBER_OPEN_EXITS: Readonly<Record<number, CompanyMachineMemberStartOutcome>> = Object.freeze({
	0: { outcome: "opened" },
	89: { refused: "DESKTOP_OPEN_NO_FOLDER" },
	91: { refused: "DESKTOP_OPEN_NOT_FOUND" },
	97: { refused: "MACHINE_BOOT_CHANGED" },
	98: { refused: "MACHINE_IMAGE_WITHOUT_SCREEN" },
});
/** A path SQL kept for an open, checked again here before it goes to a machine: the folder's rule in its plain part (no
 * empty piece, `.` or `..`, no leading `/`, no control character or backslash), at most 500 bytes. SQL's rule is the
 * whole one; this one keeps anything else from ever reaching the script. */
export function memberOpenPathValid(path: unknown): path is string {
	return (
		typeof path === "string" &&
		Buffer.byteLength(path, "utf8") >= 1 &&
		Buffer.byteLength(path, "utf8") <= 500 &&
		!/[\p{Cc}\p{Cs}\\]/u.test(path) &&
		path.split("/").every((piece) => piece !== "" && piece !== "." && piece !== "..")
	);
}
/** Text `desktop type` pastes rather than types: anything beyond printable ASCII (deploy/machine/desktop, `type`). */
const PASTED = /[^\x20-\x7e]/;
/** The member read check's refusal: a read the machine was served is not the watching member's to read. */
const MEMBER_UNREADABLE = "qorpera.test-machine/member-unreadable";
/** Why a member's look is held for good while the machine holds such a read (#memberReads), told apart from a hold that
 * passes (HELD). */
const MEMBER_HIDDEN = "the screen may show a file of the company folder the member may not read";
/** A window title or an error as the helper prints it: no control character. */
const SCREEN_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** A command's log limit in the guest (the helper's MACHINE_GUEST_MAX_LOG_BYTES), as a held receipt states it. */
const LOG_LIMIT_BYTES = 67108864;
/** One NAS storage check's own bound, as the coding host's. It runs from the check's start: the wait for the checks
 * before it is bounded only by its caller's own signal (a start's 300 s, a stop's 120 s). */
const STORAGE_TASK_MS = 5000;
/** Between passes, how often the guests still starting are asked whether they are up (#lookAtStarting). */
const STARTING_LOOK_MS = 1000;
/** One look at a starting guest answers within this, or counts as not yet. */
const STARTING_LOOK_LIMIT_MS = 5000;
/** A boot that reached these runs commands: systemd's basic system is up (sockets too, so a first `docker` waits for its
 * daemon instead of failing) and the network answers. */
const BOOT_USABLE = ["/usr/bin/systemctl", "is-active", "--quiet", "basic.target", "network-online.target"];
/** How long a new boot waits to be usable, counted from when its agent first answered, before it is marked running all the
 * same (a boot that never gets there runs as it always did). */
const BOOT_USABLE_GRACE_MS = 60000;
/** How long one write of a word the machine's desktop reads (its starter's figure, its company's time zone) may take,
 * and how often it is tried on one boot (#desktopWord). Each is only a look: a machine's start never waits longer for
 * them, and a machine that does not take one (an image from before the desktop's look has no folder for it) is left
 * alone after these tries. */
const DESKTOP_WORD_MS = 2000;
const DESKTOP_WORD_TRIES = 3;
/** How often a starting boot's looks may ask for a pass. */
const STARTING_WAKES = 3;
/** The least time between passes, however many wakes come. */
const PASS_FLOOR_MS = 1000;
/** The most time between passes. */
export const COMPANY_MACHINE_PASS_EVERY_MS = 10000;
/** How often a pass reads its storage pool's real use for the kernel (20260930757000), at most: the kernel decides on a
 * report for 2 minutes, then on the paper budget. */
export const COMPANY_MACHINE_DISK_REPORT_EVERY_MS = 30000;
/** How long one disk report may take in all (its disk reads, within their own 10 s budget, the pool's and the kernel's
 * call): it runs beside the passes and never holds up admission. */
const DISK_REPORT_MS = 20000;
/** How long a pass waits for its placements' steps by default. */
const PASS_HOLD_MS = 2000;

/** Why a boot whose folder ended (6d-2) has no /company, by the cause its ending keeps (#endings). */
const FOLDER_ENDED: Readonly<Record<string, string>> = Object.freeze({
	restart_unproven:
		"the executor is restarting the machine because it could not prove what the machine read in /company",
	restart_view_closed: "the executor is restarting the machine because its /company view was closed",
	restart_view_gone:
		"the executor is restarting the machine because the company folder service lost its /company view",
	moved_unchecked: "the machine is moving to a new disk because a command ran on this one before /company was checked",
	moved_starter:
		"the machine is moving to a new disk because the agent or member who started it no longer reads the whole company folder",
	moved_unreadable: "the machine is moving to a new disk because something it read in /company is no longer readable",
	stale: "this boot of the machine is no longer the current one",
});
/** Why a boot without a view of its own has no /company (#viewless). */
const FOLDER_VIEWLESS = Object.freeze({
	"old-helper":
		"this machine was made from an earlier image that gets no /company; a new machine has it (start a new machine)",
	refused: "the company folder refused this machine's view",
	closed: "the machine could not mount /company: the company folder closed each view it was handed",
});
/** The core's refusal of a view of a machine that is stopping, moving or on another boot (20260928549400). */
const VIEW_NOT_CURRENT = "Folder view machine is not current";
/** Why a receipt's output is held back. */
const HELD = Object.freeze({
	ended: "this boot's output stays on the machine: the boot no longer has /company, as `why` says",
	start: "a start shows no output: machine_read shows it once the company folder has released what the machine read",
	unanswered: "the company folder has not said yet whether what the machine read may be shown; read again",
	unproven:
		"the executor cannot prove what the machine read in /company: it restarts the machine, and this boot's output stays on it",
	unreadable:
		"something the machine read in /company is no longer readable: this boot's output stays on it, and the machine moves to a new disk",
	paused: "the company folder is paused; read again later",
	unreleased: "the company folder did not release what the machine read; read again",
	// As SQL tells a woken run (qorpera_folder_test_machine_event_report).
	refused:
		"this run could not take in what the machine read in /company: a read is no longer readable to it, or it does not read the whole company folder",
	untaken: "the company folder did not answer this run's take-in of what the machine read; read again",
});

export const COMPANY_MACHINE_HOST_RPCS = [
	"qorpera_admit_executor_machines",
	// The pool's real use, for the room a new machine's disk needs (20260930757000).
	"qorpera_report_executor_disk",
	"qorpera_list_executor_machines",
	"qorpera_authorize_executor_machine",
	"qorpera_mark_company_machine_running",
	"qorpera_suspend_company_machine",
	"qorpera_release_company_machine",
	"qorpera_record_company_machine_error",
	"qorpera_record_company_machine_commands",
	"qorpera_record_company_machine_stop",
	"qorpera_folder_view_open",
	"qorpera_folder_view_close",
	"qorpera_retire_company_machine",
	"qorpera_folder_test_machine_inherit_reads",
	"qorpera_mark_company_machine_folder_restart",
	"qorpera_folder_member_machine_reads",
	// The fence after a capture (20260930713000, review r1 F1).
	"qorpera_machine_desktop_picture_check",
	// The record of a desktop clipboard the host cleared after a member held it (F32 of #1661; F33: it was missing here,
	// so the executor's closed control refused it in production).
	"qorpera_machine_desktop_clipboard_cleared",
	// A member's live picture, one release cycle (20260930745000).
	"qorpera_member_machine_stream_release",
	// The agent's home (slice 3, 20260930754000): whether a session may share its machine, and its window's ids.
	"qorpera_folder_home_session_window",
	// A member's open, right before it touches the desktop (20260930758000, review r1 F1 of #1781).
	"qorpera_member_machine_desktop_open_check",
] as const;

export interface CompanyMachineHostOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	owner: string;
	machineIdSha256: string;
	policy: CompanyMachinePolicy;
	client: Pick<
		LxdTrackedClient,
		| "getInstance"
		| "submitInstanceOperation"
		| "inspectInstanceOperation"
		| "readInstanceFile"
		| "pushInstanceFile"
		| "execInstance"
	> &
		Partial<LxdInstanceExecStreamClient> &
		Partial<LxdInstanceExecPipeClient> &
		// The pool's real use (20260930757000); without both reads the executor reports nothing and the kernel keeps the
		// paper budget.
		Partial<LxdStoragePoolUseClient>;
	/** The node's folder service (F3 6d): each boot of a test machine gets its own company folder view, its commands'
	 * windows and boundaries go through it, and their output leaves only once the machine's reads are released. Without
	 * it, machines run without /company. It needs the client's execInstanceStream (the view's hand-over). */
	folder?: FolderControl;
	/** The executor's NAS control root (createCodingNasStorage(...).prepareControl()). */
	journalRoot: string;
	/** The coding NAS: its control path holds the journals. */
	storagePolicy: CloudCodingNasPolicy;
	/** The sha-256 of the packaged machine guest helper the image carries. */
	helperSha256: string;
	/** Helpers of earlier images whose machines this node still runs or wakes on their own disks (20260930760000): trusted
	 * as the current one is while any placement of their image exists, sleeping ones included. */
	previousHelperSha256s?: readonly string[];
	/** Given, the only earlier helpers that take the company folder as the current one does (its `folder-mount` and the
	 * folder program), each also in previousHelperSha256s; an empty list: none. Absent: every earlier helper does, as
	 * every image's has since v183 (19 Oct 2026). A boot of one that does gets a view and keeps the one the service holds,
	 * as the current helper's do; any other earlier helper's boot gets none (#settle). */
	folderHelperSha256s?: readonly string[];
	/** How long a started guest may take before its agent answers (default 180 s). */
	guestReadyTimeoutMs?: number;
	/** How long a pass waits for its placements' steps (default 2 s; `Infinity`: for every step). One still running then
	 * goes on by itself, and no pass starts another for its placement until it ends, so one machine's slow guest holds up
	 * no other machine's wake. Its outcome comes with the next pass. */
	passHoldMs?: number;
	/** The node's agent plug (default: its plug tool, deploy/agent-exit). */
	agentPlug?: AgentPlug;
	/** How long save_coding_value's helper may run (default 20 s), and the executor's own clear after it (10 s): the
	 * tests' own shorter ones. */
	codingValueTimeoutMs?: number;
	codingValueClearTimeoutMs?: number;
	/** How long fill_company_account's helper may run, in all (default 24 s): the tests' own shorter one. */
	accountFillTimeoutMs?: number;
	/** How long the owed clipboard clear at a screen call may take (default 3 s, SCREEN_CLEAR_MS): the tests' own. */
	screenClearTimeoutMs?: number;
	/** How long machine_screen's helper may run (default 22 s): the tests' own shorter one. */
	screenTimeoutMs?: number;
	/** How long a member's look may run on the machine (default 6 s): the tests' own shorter one. */
	memberLookTimeoutMs?: number;
	/** How long a member's typed text may take on the machine (default 10 s): the tests' own shorter one. */
	memberTypeTimeoutMs?: number;
	/** How long a member's start may take on the machine (default 22 s): the tests' own shorter one. */
	memberStartTimeoutMs?: number;
	/** A member's open's deadline (20260930758000; the tests' own). */
	memberOpenTimeoutMs?: number;
	/** How long one write of a word the desktop reads may take (default 2 s, DESKTOP_WORD_MS): the tests' own shorter one. */
	desktopWordTimeoutMs?: number;
	/** Watches a desktop for members' live pictures (20260930745000): the executor's starts a process of its own for
	 * every desktop, in its own cgroup, which opens the relay itself, so no byte of the guest's is read in the executor
	 * (company-machine-stream-process.ts). Without it, members' live pictures are refused: the rule cannot be skipped by
	 * an option left out. The host's own tests give one in this process, with their fake client. */
	desktopStreams?: (spec: DesktopRelaySpec, ended: () => void) => WatchedDesktop;
	/** How far apart one desktop's instances, and the node's, may start (DESKTOP_START_GAP_MS, NODE_START_GAP_MS): the
	 * tests' own. */
	desktopStartGapMs?: number;
	nodeStartGapMs?: number;
	/** The clock a desktop's busy grace and the disk report's 30 s are counted on (default Date.now): the tests' own. */
	now?: () => number;
}

/** One placement of a machine as SQL lists it for this executor
 * (qorpera_list_executor_machines). A retired placement (its machine moved on
 * or was deleted) is only ever deleted. */
export interface CompanyMachineEntry {
	machineId: string;
	placementId: string;
	retired: boolean;
	binding: LxdCompanyMachineBinding;
	bindingText: string;
	instanceSha256: string;
	desiredState: "running" | "stopped" | "deleted";
	lifetime: "task" | "always-on";
	reserved: boolean;
	asleepSince: string | null;
	removing: boolean;
	released: boolean;
	runningAt: string | null;
	bootId: string | null;
	commands: string[];
	sleepDue: boolean;
	stopDue: boolean;
	removeDue: boolean;
	/** Who the machine was started by, with what every client draws that agent's figure from (20260930737000): read
	 * only by companyMachineDesktopFigure, which trusts none of it. Absent from an SQL before that migration. */
	starter?: unknown;
	/** The company's time zone, null while it is not known (20260930739000): read only by
	 * companyMachineDesktopTimeZone, which trusts none of it. Absent from an SQL before that migration. */
	timeZone?: unknown;
}
export interface CompanyMachineOutcome {
	/** null for admission, which is not one placement's step. */
	placementId: string | null;
	step: "admit" | "start" | "guest" | "stop" | "delete" | "release" | "commands" | "wait";
	state: "done" | "pending" | "not-now" | "failed";
	code?: string;
	/** What came of the boot's folder this pass, when it was being settled (a code, or the error's). */
	folder?: string;
}
/** A command the gateway authorized in SQL for a machine placed on this node. */
export interface CompanyMachineCommandAuthority {
	machineId: string;
	placementId: string;
	commandId: string;
	inputSha256: string;
	/** The boot SQL knows the placement runs, and the command's run, staff agent and requesting user: a start on a
	 * machine with a folder waits for that boot's folder and opens the command's window with them. */
	bootId?: string | null;
	runId?: string;
	staffAgentId?: string;
	requestedByUserId?: string;
	/** Why the machine lost the command, when SQL ended it lost for the machine's folder (6e-2a): a key of CLOUD_MACHINE_FOLDER_LOST. */
	folderLost?: string | null;
}

export interface CompanyMachineAppAuthority {
	readonly machineId: string;
	readonly placementId: string;
	readonly bootId?: string | null;
	readonly runId?: string;
}

export interface CompanyMachineAppStartRequest {
	readonly slug: string;
	readonly command: string;
	readonly port: number;
	readonly healthPath?: string;
	readonly cwd?: string;
}

export interface CompanyMachineAppStartResult {
	readonly schema: "qorpera.machine-app-started/v1";
	readonly machineId: string;
	readonly slug: string;
	readonly unit: string;
	readonly port: number;
}

export interface CompanyMachineAppStopResult {
	readonly schema: "qorpera.machine-app-stopped/v1";
	readonly slug: string;
	readonly unit: string;
}

export interface CompanyMachineAppHealthResult {
	readonly schema: "qorpera.machine-app-health/v1";
	readonly slug: string;
	readonly unit: string;
	readonly activeState: string;
	readonly subState: string;
	readonly restarts: number;
	readonly port: number | null;
	readonly healthy: boolean;
	readonly lastStatus: number | null;
	readonly lastLatencyMs: number | null;
	readonly crashSummary: Record<string, unknown> | null;
}

export interface CompanyMachineAppReloadRequest {
	readonly slug: string;
	readonly port?: number;
	readonly healthPath?: string;
}

export interface CompanyMachineAppReloadResult {
	readonly schema: "qorpera.machine-app-reload/v1";
	readonly slug: string;
	readonly previousPort: number | null;
	readonly activePort: number;
	readonly healthy: boolean;
	readonly restarted: boolean;
}

export interface CompanyMachineAppLogsRequest {
	readonly slug: string;
	readonly grep?: string;
	readonly tail?: number;
	readonly stream?: "stdout" | "stderr" | "all";
	readonly since?: string;
}

export interface CompanyMachineAppLogLine {
	readonly ts: string;
	readonly seq: number;
	readonly stream: "stdout" | "stderr";
	readonly line: string;
}

export interface CompanyMachineAppLogsResult {
	readonly schema: "qorpera.machine-app-logs/v1";
	readonly slug: string;
	readonly lines: readonly CompanyMachineAppLogLine[];
	readonly totalMatched: number;
	readonly truncated: boolean;
	readonly crashSummary: Record<string, unknown> | null;
}

const APP_SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
/** save_coding_value's run on a machine of this node (20260930705000), as SQL authorized it
 * (qorpera_authorize_machine_coding_value): where it runs, and the helper's target, given to the helper as SQL wrote it. */
export interface CompanyMachineCodingValue {
	placementId: string;
	bootId: string;
	receiptId: string;
	target: Record<string, unknown>;
	/** The lease generation SQL's read saw (20260930713000): the box leaves only while it stands and no member holds the
	 * desktop (v233 release review r1, F29 of #1661). */
	desktopGeneration: number;
}
/** The clipboard clear owed after a member held a desktop, as SQL answered save_coding_value (its backstop, F32 to F35
 * of #1661): where it runs, and the lease generation SQL saw. */
export interface CompanyMachineClipboardClear {
	placementId: string;
	bootId: string;
	desktopGeneration: number;
}
/** Whether the clear was done and SQL recorded it (`cleared`), or the agent's refusal by code: another boot, or an image
 * without xsel (the host's own clear script's 98). */
export type CompanyMachineClipboardCleared =
	| { readonly cleared: boolean }
	| { readonly refused: "MACHINE_BOOT_CHANGED" | "MACHINE_IMAGE_WITHOUT_CODING_VALUES" };
/** The helper's answer: the box it sealed the key in, or why it sealed nothing (its code). */
export type CompanyMachineCodingValueOutcome =
	| { readonly box: Readonly<Record<string, string>> }
	| { readonly refused: string };
/** machine_screen's run on a machine of this node (20260930708000), as SQL authorized it
 * (qorpera_authorize_machine_screen): where it runs, the run that sees the screen (it takes in the machine's reads
 * first), and the helper's request (cloud-machine-screen.ts), given to the helper on stdin as the router built it. */
export interface CompanyMachineScreen {
	placementId: string;
	bootId: string;
	runId: string;
	request: Record<string, unknown>;
	/** The lease generation SQL's read saw (20260930713000): the picture leaves only while it stands (review r1 F1). */
	desktopGeneration: number;
	/** A member held the desktop since its clipboard was last confirmed clear (F35 of #1661): cleared and recorded under this
	 * call's hold of the desktop before it looks or acts; a clear that fails fails nothing (it stays owed). */
	clearClipboard?: boolean;
}
/** What the helper answered: its header and the PNG (null: none), or why the company folder held both the picture and
 * the windows' titles back (`heldBack`, a HELD text; what the action did is still told). */
export interface CompanyMachineScreenShot {
	readonly header: Readonly<Record<string, unknown>>;
	readonly png: Buffer | null;
	readonly heldBack?: string;
}
export type CompanyMachineScreenOutcome = CompanyMachineScreenShot | { readonly refused: string };
/** A member's look at a desktop on this node (20260930712000), as SQL authorized it
 * (qorpera_member_machine_screen_authority): where it runs, the member it is for, and whether it puts off the desktop's
 * own idle stop (keepDesktop: the member said within 30 minutes that they still watch). */
export interface CompanyMachineMemberLook {
	placementId: string;
	bootId: string;
	userId: string;
	keepDesktop: boolean;
	/** The lease generation SQL's read saw (20260930713000): the picture leaves only while it stands (review r1 F1). */
	desktopGeneration: number;
}
export type CompanyMachineMemberLookRefusal =
	| "DESKTOP_NOT_RUNNING"
	| "MACHINE_BOOT_CHANGED"
	| "MACHINE_IMAGE_WITHOUT_SCREEN"
	// Another member took the desktop over since the look was read (20260930713000).
	| "DESKTOP_MEMBER_IN_CONTROL";
/** The picture and its etag (the hex sha-256 of its bytes), the screen off or the machine changed (`refused`), or the
 * picture held back (`held`): `hidden` while the machine holds a read the member may not read, `pending` while the
 * company folder has not released what the machine read (the member looks again). A held look carries neither the
 * picture, its size nor its etag. */
export type CompanyMachineMemberLookOutcome =
	| { readonly png: Buffer; readonly etag: string }
	| { readonly refused: CompanyMachineMemberLookRefusal }
	| { readonly held: "hidden" | "pending" };
/** A member's action on a desktop of this node (20260930713000), as SQL authorized it
 * (qorpera_member_machine_desktop_act_authority) and the member sent it: where it runs, its single-use id (the screen
 * helper's receipt), and the action of machine_screen's shape (never `open`), a `type` with its text. */
export interface CompanyMachineMemberAct {
	placementId: string;
	bootId: string;
	actionId: string;
	action: Record<string, unknown>;
	/** The seat the action was begun in, and its member: the fence is asked again once the desktop is held (round 23). */
	seat: number;
	userId: string;
	/** A shared action (20260930734000): begun with no hold of the member's, at the lease generation `seat` (0 or more).
	 * The fence then names no member: a private hold by anyone since, the member's own too, stops it. */
	shared?: boolean;
}
/** The action ran (`exitCode`: `desktop`'s, null when it was killed at its deadline), or why it did not: the desktop is
 * busy with another action (DESKTOP_BUSY), off, or the machine changed. Nothing of the screen comes back. */
export type CompanyMachineMemberActOutcome =
	| { readonly done: { readonly exitCode: number | null } }
	| { readonly refused: string };
/** A member's live picture of a desktop of this node (20260930745000), as the executor that took the member's stream
 * read it (the member's pointer pass): where it runs, whose it is, and its hold: shared at a lease generation (`epoch`
 * null), or the member's own private hold under `epoch` in its seat (`generation`). */
export interface CompanyMachineMemberStream {
	placementId: string;
	bootId: string;
	userId: string;
	generation: number;
	epoch: number | null;
}
/** A member's pointer move on a desktop of this node (20260930744000), on the pass SQL gave (read once, kept by the
 * executor): where it runs, whose pass it is, the lease generation that stood at its read (the shared pass's generation,
 * or the private holder's seat), and where the pointer goes, in the screen's own pixels. */
export interface CompanyMachineMemberPointer {
	placementId: string;
	bootId: string;
	userId: string;
	generation: number;
	private: boolean;
	x: number;
	y: number;
}
/** The pointer was given the position (`moved`), or the move was dropped (an action holds the desktop); or why the
 * pass moves nothing any more: someone took the desktop since its generation (shared: DESKTOP_HELD_SINCE; private:
 * DESKTOP_CONTROL_ENDED), the screen is off, the machine restarted, or its image cannot move the pointer. */
export type CompanyMachineMemberPointerOutcome =
	| { readonly moved: boolean }
	| {
			readonly refused:
				| "DESKTOP_HELD_SINCE"
				| "DESKTOP_CONTROL_ENDED"
				| "DESKTOP_NOT_RUNNING"
				| "MACHINE_BOOT_CHANGED"
				| "MACHINE_IMAGE_WITHOUT_SCREEN";
	  };
/** A member's start of the desktop (20260930714000): the machine's placement and boot, and the start SQL served. */
export interface CompanyMachineMemberStart {
	placementId: string;
	bootId: string;
	startId: string;
	/** What the start opens on the desktop once it runs (20260930758000): a path of the company folder relative to its
	 * root, as SQL kept it on the start (the company folder's own path rule, at most 500 bytes). */
	open?: string;
}
/** The desktop runs now (started by this start, or running already; with `open`, and what it opens is open), or why not:
 * too small, the machine changed, no desktop in the image, the desktop did not start (DESKTOP_DID_NOT_START); and for an
 * open, not in the company folder (DESKTOP_OPEN_NOT_FOUND), no company folder on this computer (DESKTOP_OPEN_NO_FOLDER),
 * or the helper could not open it (DESKTOP_DID_NOT_OPEN). */
export type CompanyMachineMemberStartOutcome =
	| { readonly outcome: "started" | "running" | "opened" }
	| { readonly refused: string };
/** What the company folder's release of a boot's reads needs (#release): the boot, and the run that takes them in. */
type FolderRelease = Pick<CompanyMachineCommandAuthority, "placementId" | "bootId" | "runId">;

export interface CompanyMachineAccountFill {
	placementId: string;
	bootId: string;
	receiptId: string;
	desktopGeneration: number;
	target: Record<string, unknown>;
}
/** The vault's side of one fill: the value sealed to the helper's public key for this call, or the vault's refusal in
 * the database's own words. */
export type CompanyMachineAccountFillSeal = (
	publicKey: string,
	signal: AbortSignal,
) => Promise<
	{ readonly box: Readonly<Record<string, string>> } | { readonly refused: { code: string; message: string } }
>;
/** The helper typed the value, or why not: its code, or the vault's refusal. */
export type CompanyMachineAccountFillOutcome =
	| { readonly filled: true }
	| { readonly refused: string }
	| { readonly vaultRefused: { readonly code: string; readonly message: string } };

/** A boot's company folder (F3 6d), in this process's memory only (the pass is never written anywhere). */
interface BootFolder {
	bootId: string;
	/** pending: not settled yet, and a start waits; open: the boot's commands are fenced, by their windows and the
	 * machine's boundaries, with or without a view; none: no pass can have reached the boot's guest (#viewless), which
	 * runs without /company. A boot whose folder ended (6d-2) is kept apart from its folder (#endings). */
	state: "pending" | "open" | "none";
	/** This process saw the boot start; false once it restarted, and then the service's views decide. */
	known: boolean;
	/** This process handed the guest a pass of the boot (answered or not): the boot is fenced for good. */
	handed: boolean;
	/** The view this process opened, with its pass. */
	view?: { viewId: string; pass: string };
	/** Every view of the boot the service may hold, which its final boundary closes. */
	views: Set<string>;
	opens: number;
	/** Whether the service was asked which views of the boot it holds (after a restart). */
	asked: boolean;
	/** Why the boot has no view of its own (#viewless), and for a refused open the core's words, when the control keeps
	 * them. */
	reason?: "old-helper" | "refused" | "closed";
	refusal?: string;
	/** The service listed a view of the boot's own: from then on, that view missing restarts the guest (#watch). */
	held: boolean;
	/** Since when the boot's own view is missing from the service's answers. */
	missing?: number;
	/** A run's take-in of the machine's reads was refused as no longer readable (#inherit): the boot's output stays
	 * held, and the next pass retires its placement. */
	unreadable?: boolean;
	/** The windows this process opened for the boot's commands, until their command ends: the service keeps them in
	 * memory, so each pass opens them again (#reopen). */
	windows: Map<string, FolderCommandWindow>;
	/** The windows this process opened for the boot's home sessions (slice 3, 20260930754000), until their channel
	 * ends: opened again each pass as the commands' are (#reopen). */
	homes: Map<string, FolderCommandWindow>;
	/** How many channels each of those sessions has open (slice C1): its window closes with the last one. */
	homeChannels: Map<string, number>;
	/** The paths the boot's boundaries said the company folder let go unsaved, for its next receipt whose output leaves
	 * (6e-2a, #noted), and how many more there were. */
	notSaved: CloudMachineFolderNotSaved[];
	moreNotSaved: number;
	/** The paths the folder did not save that each open view of the boot keeps pending, as the view's newest boundary
	 * reported them (#noted): every receipt whose output leaves says them while they last. */
	stillNotSaved: Map<string, StillNotSaved>;
}
/** One view's paths not saved that it keeps pending: at most 8, and a count of the rest (6e-2a). */
interface StillNotSaved {
	paths: CloudMachineFolderNotSaved[];
	more: number;
}
export type CompanyMachineCommand =
	| { action: "start"; commandId: string; inputSha256: string; command: string; timeoutMs: number | null }
	| { action: "read"; read: CloudCodingCommandRead }
	| { action: "cancel"; commandId: string };

function machineRecord(value: unknown, error: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(error);
	return value;
}
/** A receipt whose output is held back, made from the request alone: still running, and nothing printed past where
 * the reader stands (`offset`). No size, end or exit of the guest's is in it. */
function held(receipt: CloudMachineCommandReceipt, offset: number): CloudMachineCommandReceipt {
	const at = Math.min(offset, LOG_LIMIT_BYTES);
	const kept: CloudMachineCommandReceipt = {
		...receipt,
		state: "running",
		exitCode: null,
		output: "",
		truncated: false,
		log: Object.freeze({
			offset: at,
			nextOffset: at,
			totalBytes: at,
			limitBytes: LOG_LIMIT_BYTES,
			limitReached: false,
		}),
	};
	return Object.freeze(kept);
}
/** Why a boundary that did not release the machine's reads holds its output (6e-2a). */
function unreleased(boundary: MachineBoundary | undefined): string {
	switch (boundary?.reads) {
		case undefined:
		case "unanswered":
			return HELD.unanswered;
		case "unproven":
			return HELD.unproven;
		case "unreadable":
			return HELD.unreadable;
		case "stopped":
			return HELD.paused;
		default:
			return HELD.unreleased;
	}
}
/** What a boundary's reports say the company folder did not take (6e-2a), for the boot's receipts whose output leaves,
 * each path as the receipt's report checks it: at most 8, and a count of the rest. A path the folder let go unsaved is
 * said once, on the next such receipt (`notSaved`). A path its view keeps pending for the service to try again at each
 * boundary (a write the core refused, or a conflict whose bytes the receipt did not keep) is said on every such receipt
 * while the view's newest boundary still reports it so (`stillNotSaved`): one saved meanwhile (by a quiet publish, whose
 * outcome only the service's notices keep) is no longer said, and one refused again is. A path still on its way (kept
 * `waiting`, an open file, or `not_applied`, not sent or not answered yet), or kept by a change set refused whole in a
 * way that may lift (the pause, the run check), is said once it settles. */
function noted(boot: BootFolder | undefined, boundary: MachineBoundary | undefined): void {
	if (!boot || !boundary) return;
	// A view the boundary no longer lists, or says is closed, keeps nothing pending.
	for (const viewId of boot.stillNotSaved.keys())
		if (!boundary.views.some((view) => view.viewId === viewId && view.error?.code !== "VIEW_CLOSED"))
			boot.stillNotSaved.delete(viewId);
	for (const view of boundary.views) {
		const paths = view.report?.paths;
		// A view without a report this time keeps what its last one said.
		if (!Array.isArray(paths)) continue;
		const lifts = view.report?.refused === "stopped" || view.report?.refused === "run_ended";
		const still: StillNotSaved = { paths: [], more: 0 };
		for (const item of paths as unknown[]) {
			const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
			if (entry.outcome === "saved") continue;
			const kept = entry.kept === true;
			if (kept && (lifts || entry.outcome === "waiting" || entry.outcome === "not_applied")) continue;
			const list = kept ? still.paths : boot.notSaved;
			const shown = list.length < CLOUD_MACHINE_FOLDER_LIMITS.notSaved ? notSavedOf(entry) : undefined;
			if (shown) list.push(shown);
			else if (kept) still.more++;
			else boot.moreNotSaved++;
		}
		if (still.paths.length || still.more) boot.stillNotSaved.set(view.viewId, still);
		else boot.stillNotSaved.delete(view.viewId);
	}
}
/** One path not saved as a receipt shows it, or none when it cannot be (its reason dropped first). */
function notSavedOf(entry: Record<string, unknown>): CloudMachineFolderNotSaved | undefined {
	const { path, outcome, reason } = entry;
	if (typeof path !== "string" || typeof outcome !== "string") return undefined;
	const tries = [
		...(typeof reason === "string"
			? [{ path, outcome, reason: reason.slice(0, CLOUD_MACHINE_FOLDER_LIMITS.reason) }]
			: []),
		{ path, outcome },
	];
	for (const shown of tries)
		try {
			return parseCloudMachineCommandFolder({ company: "pending", notSaved: [shown] }).notSaved?.[0];
		} catch {
			// The next try, or none.
		}
	return undefined;
}
function errorCode(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return /^[A-Z][A-Z0-9_]{2,80}(:[A-Z][A-Z0-9_]{0,63})?$/.test(message) ? message : "UNCLASSIFIED";
}
/** The helper's answer in its reply file; its refusal throws its code. */
function guestAnswer(content: Buffer): Record<string, unknown> {
	const value = machineRecord(
		JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(content)),
		"COMPANY_MACHINE_GUEST_REPLY_INVALID",
	);
	if (value.schema === "qorpera.machine-guest-refusal/v1")
		throw new Error(
			typeof value.code === "string" && /^[A-Z][A-Z0-9_:]{2,120}$/.test(value.code)
				? value.code
				: "MACHINE_GUEST_REFUSED",
		);
	return value;
}
/** A title or an error as the helper prints it: text of at most `chars` characters (or `bytes` bytes), no control. */
function screenText(value: unknown, chars: number, bytes = Number.POSITIVE_INFINITY): value is string {
	return (
		typeof value === "string" &&
		[...value].length <= chars &&
		Buffer.byteLength(value) <= bytes &&
		!SCREEN_CONTROL.test(value)
	);
}
/** machine_screen's helper answer (cloud-machine-screen.ts, runMachineScreenCli): a refusal's line, or one header line
 * of exactly its fields and then exactly as many bytes of PNG as it says, a PNG of a screen of at most 3840 x 2160. */
function screenOutput(stdout: Buffer): CompanyMachineScreenOutcome {
	const invalid = () => new Error("COMPANY_MACHINE_SCREEN_INVALID");
	const end = stdout.indexOf(0x0a);
	if (end < 0 || end > SCREEN_HEADER_BYTES) throw invalid();
	let header: Record<string, unknown>;
	try {
		header = machineRecord(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(stdout.subarray(0, end))),
			"COMPANY_MACHINE_SCREEN_INVALID",
		);
	} catch {
		throw invalid();
	}
	const keys = Object.keys(header).sort().join();
	if (header.schema === "qorpera.machine-screen-refusal/v1" && keys === "code,schema") {
		if (typeof header.code !== "string" || !/^[A-Z][A-Z0-9_]{2,60}$/.test(header.code) || end + 1 !== stdout.length)
			throw invalid();
		return { refused: header.code };
	}
	const action = header.action;
	const done =
		action && typeof action === "object" && !Array.isArray(action) ? (action as Record<string, unknown>) : null;
	if (
		header.schema !== "qorpera.machine-screen/v1" ||
		keys !== "action,activeWindow,moreWindows,png,schema,started,windows" ||
		typeof header.started !== "boolean" ||
		(action !== null &&
			(!done ||
				!["exitCode,type", "error,exitCode,type"].includes(Object.keys(done).sort().join()) ||
				!SCREEN_VERBS.includes(done.type as string) ||
				(done.exitCode !== null &&
					(!Number.isSafeInteger(done.exitCode) ||
						(done.exitCode as number) < 0 ||
						(done.exitCode as number) > 255)) ||
				(done.error !== undefined && (!screenText(done.error, 300, 300) || done.error === "")))) ||
		(header.activeWindow !== null && !screenText(header.activeWindow, 120)) ||
		!Array.isArray(header.windows) ||
		header.windows.length > 16 ||
		header.windows.some((title) => !screenText(title, 120)) ||
		!Number.isSafeInteger(header.moreWindows) ||
		(header.moreWindows as number) < 0 ||
		(header.moreWindows as number) > 100000 ||
		!Number.isSafeInteger(header.png) ||
		(header.png as number) < 0 ||
		(header.png as number) > SCREEN_PNG_BYTES ||
		stdout.length !== end + 1 + (header.png as number)
	)
		throw invalid();
	if (header.png === 0) return Object.freeze({ header: Object.freeze({ ...header }), png: null });
	const png = Buffer.from(stdout.subarray(end + 1));
	if (!screenPicture(png)) throw invalid();
	return Object.freeze({ header: Object.freeze({ ...header }), png });
}
/** A PNG of a screen: the signature, then IHDR first (its 13 bytes) with the screen's size, which no picture of it may
 * pass (3840 x 2160), and at most 8 MiB. */
function screenPicture(png: Buffer): boolean {
	return (
		png.length >= 33 &&
		png.length <= SCREEN_PNG_BYTES &&
		png.subarray(0, 8).equals(PNG_SIGNATURE) &&
		png.readUInt32BE(8) === 13 &&
		png.toString("latin1", 12, 16) === "IHDR" &&
		png.readUInt32BE(16) >= 1 &&
		png.readUInt32BE(16) <= SCREEN_MAX_WIDTH &&
		png.readUInt32BE(20) >= 1 &&
		png.readUInt32BE(20) <= SCREEN_MAX_HEIGHT
	);
}
function entry(value: unknown): CompanyMachineEntry {
	const e = machineRecord(value, "COMPANY_MACHINE_LIST_INVALID");
	if (
		e.schema !== "qorpera.company-machine-state/v2" ||
		![e.machineId, e.placementId].every((id) => typeof id === "string" && UUID_PATTERN.test(id)) ||
		typeof e.bindingText !== "string" ||
		typeof e.instanceSha256 !== "string" ||
		!SHA.test(e.instanceSha256) ||
		!["running", "stopped", "deleted"].includes(e.desiredState as string) ||
		!["task", "always-on"].includes(e.lifetime as string) ||
		![e.retired, e.reserved, e.removing, e.released, e.sleepDue, e.stopDue, e.removeDue].every(
			(flag) => typeof flag === "boolean",
		) ||
		(e.bootId !== null && (typeof e.bootId !== "string" || !UUID_PATTERN.test(e.bootId))) ||
		!Array.isArray(e.commands) ||
		e.commands.length > 64 ||
		e.commands.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
	)
		throw new Error("COMPANY_MACHINE_LIST_INVALID");
	return e as unknown as CompanyMachineEntry;
}

/** The machine workload of a node's executor: every pass it admits waiting
 * machines on this node, then brings each placement on it to the state SQL
 * wants (running, asleep or deleted) through the coding machine's journaled
 * lifecycle, keeps each running guest's lease, and records how the commands
 * it started ended. It also runs the commands the gateway authorized. */
export class LxdCompanyMachineHost {
	readonly #options: CompanyMachineHostOptions;
	readonly #policy: Readonly<CompanyMachinePolicy>;
	readonly #storage: CodingNasStorage;
	readonly #work = new Map<string, Promise<unknown>>();
	/** The last NAS storage check (#storageTask). */
	#storageWork: Promise<unknown> = Promise.resolve();
	/** Per placement: the boot whose helper was checked and prepared, the whole machine's last sample, and whether it was
	 * busy since SQL last took that. */
	readonly #guests = new Map<string, { bootId: string; sample: IdleRuleSample; busy: boolean }>();
	/** Per placement: what its guest's helper said, when the executor last claimed its boot (`prepare`), it takes for a
	 * page of a command's log (keyholes S1). A helper from before says nothing: it takes the legacy 16,384, and a read is
	 * asked of it for no more. Its image's helper is the placement's for as long as the placement lives. */
	readonly #pages = new Map<string, number>();
	/** Per placement and file: the word last written into the machine for its desktop, the boot it was written on, whether
	 * the write went through and how often it was tried (#desktopWord). */
	readonly #desktopWords = new Map<
		string,
		Map<string, { bootId: string; word: string; written: boolean; tries: number }>
	>();
	/** When this process first saw the placement started and its guest not yet answering, and the placement as SQL last
	 * listed it. */
	readonly #starting = new Map<
		string,
		{
			since: number;
			entry: CompanyMachineEntry;
			/** How often its looks asked for a pass (STARTING_WAKES at most). */
			wakes: number;
			/** Its step failed for another reason than not being up yet: only the passes look at it. */
			failing: boolean;
			/** When its agent first answered: BOOT_USABLE_GRACE_MS counts from then. */
			answered?: number;
		}
	>();
	/** The starting guests being looked at now (#lookAtStarting). */
	readonly #looking = new Set<string>();
	/** The placements whose step runs, in a pass or past the end of its hold. */
	readonly #stepping = new Set<string>();
	/** Steps ended so far, and per placement the count when its last one ended: a list asked before a step ended may
	 * show its placement as it was before that step, so that pass leaves the placement to the next. */
	#stepEnds = 0;
	/** The placements of the last listing: whose disks the next disk report reads (20260930757000). */
	#listed: readonly CompanyMachineEntry[] = [];
	/** When the last disk report began (the host's clock), whether or not it reached the kernel. */
	#diskReadAt = Number.NEGATIVE_INFINITY;
	/** The reader of the pool, which keeps sleeping disks' reads between reports; none without LXD's two reads. */
	readonly #diskReader?: CompanyMachineDiskReader;
	/** The disk report under way, beside the passes. */
	#diskReport?: Promise<void>;
	readonly #endedAt = new Map<string, number>();
	/** What steps that outlasted their pass came to, for the next pass to hand over. */
	readonly #late: CompanyMachineOutcome[] = [];
	/** A wake came: the next pass starts as soon as the one running ends (#pause). */
	#woken = false;
	/** Ends the wait before the next pass, while there is one. */
	#ending: (() => void) | undefined;
	/** Who waits to hear that a machine got somewhere (#changed), per machine. */
	readonly #listeners = new Map<string, Set<() => void>>();
	/** Per placement: its running boot's folder. */
	readonly #folders = new Map<string, BootFolder>();
	/** Per placement (machine_screen, review r1 F4): an action runs on its desktop now ("acting"), or one ended abnormally
	 * and what it started may still type until this time. A second action is refused meanwhile (DESKTOP_BUSY); a look is
	 * not. One executor process serves every screen call of a placement on its node (a peer's forwarded one too), so
	 * this is the whole of it; a restarted executor starts with none. */
	readonly #screenBusy = new Map<string, "acting" | number>();
	/** Per placement (20260930744000): the newest lease generation this host saw, from every look, action and pointer pass
	 * it served; a pointer pass of an older one moves nothing (a private hold began since). */
	readonly #generations = new Map<string, number>();
	/** Per placement: its pointer's mover while a member's pointer moves, the last mover's failure (its boot, reason and
	 * when), and who moved its pointer when (their looks show no drawn pointer). */
	readonly #movers = new Map<string, PointerMover>();
	/** Per placement, its desktop's live picture while any member watches it (20260930745000): one relay, ended with the
	 * last member's stream, the boot's, or the X server's. */
	readonly #streams = new Map<string, { readonly bootId: string; readonly stream: WatchedDesktop }>();
	/** When each desktop's next instance may start, and the node's next. */
	readonly #streamStarts = new Map<string, number>();
	#nodeStreamStart = 0;
	readonly #moverFailed = new Map<
		string,
		{
			bootId: string;
			refused: "DESKTOP_NOT_RUNNING" | "MACHINE_BOOT_CHANGED" | "MACHINE_IMAGE_WITHOUT_SCREEN";
			at: number;
		}
	>();
	readonly #pointerUsers = new Map<string, Map<string, number>>();
	/** The pointer fence (COMPANY_MACHINE_MEMBER_POINTER, review r1 F1 and F2 of #1733): this process's own NONCE, each
	 * placement's COUNT, and when its last mover ended (a fence is written while one runs and for a while after). */
	readonly #fenceNonce = randomBytes(8).toString("hex");
	readonly #fenceCounts = new Map<string, number>();
	readonly #moverEnded = new Map<string, number>();
	/** Per placement, what the desktop CONFIRMED it holds (the fence script's own answer: its boot, the fence and the
	 * desktop's incarnation then), and the write on its way (review r2 F1, r3 F1 of #1733): observing a newer generation
	 * moves the fence at once, but no look, action or mover counts on the desktop having it until a write of it was
	 * confirmed (#confirmFence). A mover that ended on a check of its own, or a look that found the desktop holding
	 * something else (a restart: another incarnation), makes it unconfirmed again. */
	readonly #fencePublished = new Map<string, PointerFence>();
	readonly #fenceWrites = new Map<string, Promise<void>>();
	/** Per placement and boot (`placementId/bootId`): a boot whose folder ended (6d-2), and how: its guest restarts
	 * (asked again each pass until the next boot comes), or its placement was retired; and the code each pass reports.
	 * Kept apart from the boot's folder, which its end, a stop or the next boot removes, so nothing of the boot leaves
	 * it whatever came of its folder, a stop or a record (#ended). Dropped only with the placement (#remove). Its cause,
	 * a key of FOLDER_ENDED, says why in each receipt of the boot (6e-2a). */
	readonly #endings = new Map<string, { by: "restart" | "retirement"; code: string; cause: string }>();
	/** Per placement and command: the starts being delivered (from their window's open to the guest's answer). */
	readonly #delivering = new Map<string, number>();
	/** Per look inside a machine with a folder, until its ends are worked out: the commands whose start's delivery
	 * began or ended since the look began. What that look says of them is stale. */
	readonly #looks = new Set<Set<string>>();
	/** Per placement and command: a window close on its way, answered with the machine's boundary (or none). */
	readonly #closing = new Map<string, Promise<MachineBoundary | undefined>>();
	/** Per placement: the boot whose Codex was hashed, and its sha-256 (#homeCodex). */
	readonly #homeCodexes = new Map<
		string,
		{ bootId: string; sha: Promise<string>; waiters: number; controller: AbortController; settled: boolean }
	>();
	/** The boot of each placement whose machine was found to have sftp-server (#homeSftp); a missing one is asked again,
	 * since the agent, root on its home, may install it. */
	readonly #homeSftps = new Map<string, string>();
	// WHY: Skip re-reading and rehashing the immutable 50 KiB guest helper on every 10s heartbeat while bootId is unchanged.
	readonly #verifiedHelpers = new Map<string, { readonly bootId: string; readonly sha256: string }>();
	readonly #generation = Math.floor(Date.now() / 1000);
	constructor(options: CompanyMachineHostOptions) {
		if (
			!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.owner) ||
			!SHA.test(options.machineIdSha256) ||
			!SHA.test(options.helperSha256) ||
			(options.previousHelperSha256s ?? []).some((sha) => !SHA.test(sha)) ||
			(options.folderHelperSha256s ?? []).some((sha) => !options.previousHelperSha256s?.includes(sha)) ||
			new Set(options.folderHelperSha256s).size !== (options.folderHelperSha256s ?? []).length ||
			resolve(options.journalRoot) !== options.journalRoot ||
			(options.folder !== undefined && typeof options.client.execInstanceStream !== "function")
		)
			throw new Error("COMPANY_MACHINE_HOST_CONFIGURATION_INVALID");
		this.#policy = parseCompanyMachinePolicy(options.policy);
		this.#storage = createCodingNasStorage(parseCloudCodingNasPolicy(options.storagePolicy));
		const client = options.client;
		if (typeof client.readStorageVolumeUse === "function" && typeof client.readStoragePoolSpace === "function")
			this.#diskReader = new CompanyMachineDiskReader({
				client: {
					readStorageVolumeUse: client.readStorageVolumeUse.bind(client),
					readStoragePoolSpace: client.readStoragePoolSpace.bind(client),
				},
				pool: this.#policy.storagePool,
				...(options.now ? { now: options.now } : {}),
			});
		if (options.journalRoot !== this.#storage.controlPath) throw new Error("COMPANY_MACHINE_JOURNAL_NOT_ON_NAS");
		this.#options = Object.freeze({ ...options });
	}

	async #call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		return withTimeoutScope(signal, 10000, (checked) => this.#options.control.call(method, args, checked));
	}
	/** Lifecycle steps of one placement never overlap. */
	async #exclusive<T>(placementId: string, use: () => Promise<T>): Promise<T> {
		const previous = this.#work.get(placementId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(use);
		this.#work.set(placementId, next);
		try {
			return await next;
		} finally {
			if (this.#work.get(placementId) === next) this.#work.delete(placementId);
		}
	}
	/** NAS storage checks run one at a time, each once the one before it settled: the storage refuses a check while
	 * another runs (CODING_STORAGE_IO_PENDING), and a pass steps all its placements at once. Its caller leaves on its own
	 * signal, or on the check's bound once the check began; a check whose caller left before it began never runs. The
	 * chain keeps the real promise, so a check that outlives its caller (hard-NFS IO answers no signal) still holds off
	 * the next. */
	async #storageTask<T>(use: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		const bound = new AbortController();
		const work = this.#storageWork
			.catch(() => undefined)
			.then(() => {
				signal.throwIfAborted();
				const checked = AbortSignal.any([signal, AbortSignal.timeout(STORAGE_TASK_MS)]);
				checked.addEventListener("abort", () => bound.abort(checked.reason), { once: true });
				return use(checked);
			});
		this.#storageWork = work;
		let abort: (() => void) | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(signal.aborted ? signal.reason : bound.signal.reason);
					if (signal.aborted || bound.signal.aborted) {
						abort();
						return;
					}
					signal.addEventListener("abort", abort, { once: true });
					bound.signal.addEventListener("abort", abort, { once: true });
				}),
			]);
		} finally {
			if (abort) {
				signal.removeEventListener("abort", abort);
				bound.signal.removeEventListener("abort", abort);
			}
		}
	}
	async #journalRoot(signal: AbortSignal): Promise<string> {
		return this.#storageTask(async (checked) => {
			await this.#storage.assertControl(checked);
			await checkDirectory(this.#options.journalRoot);
			const path = join(this.#options.journalRoot, "company-machines");
			await mkdir(path, { mode: 0o700 }).catch((error) => {
				if (!code(error, "EEXIST")) throw error;
			});
			await checkDirectory(path);
			return path;
		}, signal);
	}
	#plan(e: CompanyMachineEntry) {
		const plan = lxdCompanyMachineJournalPlan(e.binding);
		if (
			plan.text !== e.bindingText ||
			plan.instanceSha256 !== e.instanceSha256 ||
			e.binding.machineId !== e.machineId ||
			e.binding.placementId !== e.placementId ||
			e.binding.project !== this.#policy.project ||
			e.binding.providerId !== this.#policy.providerId
		)
			throw new Error("COMPANY_MACHINE_BINDING_DIFFERS");
		return plan;
	}
	#custody(e: CompanyMachineEntry, method: string, signal: AbortSignal, extra: Record<string, unknown> = {}) {
		return this.#call(
			method,
			{
				p_placement_id: e.placementId,
				p_owner: this.#options.owner,
				p_binding_text: e.bindingText,
				p_machine_id_sha256: this.#options.machineIdSha256,
				...extra,
			},
			signal,
		);
	}
	/** SQL's authority for one LXD effect; a refusal it can wait out throws COMPANY_MACHINE_REFUSED. */
	async #authorize(e: CompanyMachineEntry, intent: CodingMachineIntent, signal: AbortSignal): Promise<unknown> {
		const receipt = machineRecord(
			await this.#custody(e, "qorpera_authorize_executor_machine", signal, { p_intent: intent }),
			"COMPANY_MACHINE_AUTHORITY_INVALID",
		);
		if (receipt.state === "refused")
			throw new Error(
				`COMPANY_MACHINE_REFUSED:${
					String(receipt.reason)
						.replace(/[^A-Z0-9_]/g, "")
						.slice(0, 60) || "UNKNOWN"
				}`,
			);
		return receipt;
	}
	/** Drives the journaled LXD lifecycle to one state, re-fetching SQL
	 * authority before every effect. A refusal SQL can wait out is "not-now". */
	async #physical(
		e: CompanyMachineEntry,
		desiredState: "running" | "stopped" | "deleted",
		signal: AbortSignal,
	): Promise<"running" | "stopped" | "absent" | "deleted" | "not-now"> {
		const plan = this.#plan(e);
		let refused = false;
		const authorize = async (intent: CodingMachineIntent, checked: AbortSignal): Promise<unknown> => {
			try {
				return await this.#authorize(e, intent, checked);
			} catch (error) {
				// Refused, or the company's locks busy past SQL's short wait: no new run authority this
				// pass, but a machine that already runs keeps its lease (see #step).
				if (errorCode(error).startsWith("COMPANY_MACHINE_REFUSED:") || error instanceof CodingControlBusy)
					refused = true;
				throw error;
			}
		};
		return withTimeoutScope(signal, desiredState === "running" ? 300000 : 120000, async (checked) => {
			for (;;) {
				checked.throwIfAborted();
				let result: Awaited<ReturnType<typeof reconcileCodingMachine>>;
				try {
					result = await reconcileCodingMachine({
						plan,
						journalRoot: await this.#journalRoot(checked),
						desiredState,
						client: this.#options.client,
						authorize,
						signal: checked,
						plug: this.#options.agentPlug,
					});
				} catch (error) {
					if (refused) return "not-now";
					throw error;
				}
				if (result.state === "pending") {
					if (
						!(await waitPendingLxdOperation(
							this.#options.client,
							{ project: plan.project, instanceName: plan.name, operationId: result.pendingOperationId },
							checked,
						))
					) {
						await setTimeout(500, undefined, { signal: checked });
					}
					continue;
				}
				if (result.state === "recovery-required") throw new Error("COMPANY_MACHINE_RECOVERY_REQUIRED");
				if (desiredState === "running" && result.state !== "running")
					throw new Error("COMPANY_MACHINE_RECOVERY_REQUIRED");
				if (desiredState === "stopped" && result.state !== "stopped" && result.state !== "absent")
					throw new Error("COMPANY_MACHINE_RECOVERY_REQUIRED");
				if (desiredState === "deleted" && result.state !== "deleted" && result.state !== "absent")
					throw new Error("COMPANY_MACHINE_RECOVERY_REQUIRED");
				return result.state;
			}
		});
	}

	/** Runs the helper as root with a fresh reply file and reads its answer. */
	async #helper(
		e: CompanyMachineEntry,
		args: readonly string[],
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		return guestAnswer(await this.#ask(e, args, signal));
	}
	/** Runs the helper as root with a fresh reply file and reads that file, unchecked. It throws only when no answer came
	 * back (LXD's exec failed, the helper could not write its reply, or the file could not be read). */
	async #ask(e: CompanyMachineEntry, args: readonly string[], signal: AbortSignal): Promise<Buffer> {
		const plan = this.#plan(e);
		const nonce = randomUUID();
		await this.#options.client.execInstance(
			plan.project,
			plan.name,
			["/usr/bin/node", PATHS.helper, nonce, ...args],
			signal,
		);
		return this.#reply(plan, nonce, signal);
	}
	/** The helper's reply file. */
	async #reply(plan: { project: string; name: string }, nonce: string, signal: AbortSignal): Promise<Buffer> {
		const file = await this.#options.client.readInstanceFile(
			plan.project,
			plan.name,
			`${PATHS.runtime}/replies/${nonce}.json`,
			65536,
			signal,
		);
		return file.content;
	}
	/** Until the guest agent answers both the boot's claim and its lease, the machine is still starting: early in a boot,
	 * or on a boot going down, LXD's agent may answer one and drop at the next (LXD ends the exec without a code). For
	 * `guestReadyTimeoutMs` at most from the first pass it did not answer; then the pass fails with the error. */
	#unready(e: CompanyMachineEntry, error: unknown): CompanyMachineOutcome {
		const known = this.#starting.get(e.placementId);
		const since = known?.since ?? Date.now();
		const starting = {
			since,
			entry: e,
			wakes: known?.wakes ?? 0,
			failing: errorCode(error) === "COMPANY_MACHINE_HELPER_DIFFERS",
			...(known?.answered === undefined ? {} : { answered: known.answered }),
		};
		this.#starting.set(e.placementId, starting);
		if (Date.now() - since < (this.#options.guestReadyTimeoutMs ?? 180000) && !starting.failing)
			return { placementId: e.placementId, step: "guest", state: "pending" };
		starting.failing = true;
		throw error;
	}
	/** What the machine's desktop reads of whose it is, each written into the machine as one word in root's file: the
	 * figure of the agent the machine was started by (COMPANY_MACHINE_DESKTOP_FIGURE; SQL names the starter since
	 * 20260930737000) and its company's time zone (COMPANY_MACHINE_DESKTOP_TIME_ZONE; SQL names it since 20260930739000,
	 * once a member's browser has handed one in). When a boot becomes usable, before SQL is told it runs, so the words
	 * are there before anybody can start the desktop; and on a later pass when one changed or this process never wrote
	 * it (the desktop follows the figure while it runs, and takes the time zone at its next start). The two go side by
	 * side, so a start waits DESKTOP_WORD_MS at most for both. */
	async #desktop(e: CompanyMachineEntry, bootId: string, signal: AbortSignal): Promise<void> {
		await Promise.all([
			this.#desktopWord(e, bootId, COMPANY_MACHINE_DESKTOP_FIGURE, companyMachineDesktopFigure(e.starter), signal),
			this.#desktopWord(
				e,
				bootId,
				COMPANY_MACHINE_DESKTOP_TIME_ZONE,
				companyMachineDesktopTimeZone(e.timeZone),
				signal,
			),
		]);
	}
	/** One word for the machine's desktop, written to `path` (root's, 0644, the word and a line end); nothing for no
	 * word. It is only a look. Nothing here fails or holds a step: a write that fails, or takes longer than
	 * DESKTOP_WORD_MS, is left (the desktop then shows its neutral backdrop, or its clock stays on UTC), and a later pass
	 * tries again, DESKTOP_WORD_TRIES times at most for one boot and word. */
	async #desktopWord(
		e: CompanyMachineEntry,
		bootId: string,
		path: string,
		word: string | undefined,
		signal: AbortSignal,
	): Promise<void> {
		if (!word) return;
		const words = this.#desktopWords.get(e.placementId) ?? new Map();
		this.#desktopWords.set(e.placementId, words);
		const known = words.get(path);
		const same = known?.bootId === bootId && known.word === word ? known : undefined;
		if (same && (same.written || same.tries >= DESKTOP_WORD_TRIES)) return;
		const { project, name } = this.#plan(e);
		let written = false;
		try {
			await withTimeoutScope(signal, this.#options.desktopWordTimeoutMs ?? DESKTOP_WORD_MS, (checked) =>
				this.#options.client.pushInstanceFile(project, name, path, `${word}\n`, 0o644, checked),
			);
			written = true;
		} catch {
			// Left for a later pass: the machine starts and runs all the same.
		}
		words.set(path, { bootId, word, written, tries: (same?.tries ?? 0) + 1 });
	}
	/** A started guest: its helper is the packaged one, this boot is claimed
	 * for the machine, SQL knows it runs, and its lease is renewed. */
	async #guest(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		const plan = this.#plan(e);
		const verifyHelper = async (): Promise<string> => {
			const helper = await this.#options.client.readInstanceFile(
				plan.project,
				plan.name,
				PATHS.helper,
				65536,
				signal,
			);
			const sha = createHash("sha256").update(helper.content).digest("hex");
			if (sha !== this.#options.helperSha256 && !(this.#options.previousHelperSha256s ?? []).includes(sha))
				throw new Error("COMPANY_MACHINE_HELPER_DIFFERS");
			return sha;
		};
		const cachedHelper = e.bootId !== null ? this.#verifiedHelpers.get(e.placementId) : undefined;
		let prepared: Record<string, unknown>;
		let helperSha256: string;
		try {
			if (cachedHelper && cachedHelper.bootId === e.bootId) {
				prepared = await this.#helper(e, ["prepare", e.machineId, String(this.#generation)], signal);
				if (prepared.bootId === cachedHelper.bootId) {
					helperSha256 = cachedHelper.sha256;
				} else {
					this.#verifiedHelpers.delete(e.placementId);
					helperSha256 = await verifyHelper();
				}
			} else {
				helperSha256 = await verifyHelper();
				prepared = await this.#helper(e, ["prepare", e.machineId, String(this.#generation)], signal);
			}
		} catch (error) {
			return this.#unready(e, error);
		}
		if (
			prepared.schema !== "qorpera.machine-guest/v1" ||
			prepared.machineId !== e.machineId ||
			typeof prepared.bootId !== "string" ||
			!UUID_PATTERN.test(prepared.bootId)
		)
			throw new Error("COMPANY_MACHINE_GUEST_REPLY_INVALID");
		this.#verifiedHelpers.set(e.placementId, { bootId: prepared.bootId, sha256: helperSha256 });
		this.#pages.set(
			e.placementId,
			Number.isSafeInteger(prepared.pageBytes) && (prepared.pageBytes as number) >= 4
				? Math.min(prepared.pageBytes as number, CLOUD_CODING_COMMAND_PAGE_BYTES)
				: CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES,
		);
		const bootId = prepared.bootId;
		// A guest whose boot's folder ended (6d-2), whatever came of that folder: nothing of the boot is looked at,
		// recorded or marked running, nor is its lease renewed (its commands are lost, and its watchdog stops any still
		// running once the last lease runs out). The boot is the one the guest says it runs, so a guest that restarts is
		// asked again, its agent going down or not, until its next boot comes, and a retired placement waits for its stop.
		const over = this.#endings.get(`${e.placementId}/${bootId}`);
		if (over) {
			this.#starting.delete(e.placementId);
			if (over.by === "restart") {
				await this.#mark(e, bootId, over.cause, signal);
				await this.#reboot(e, signal);
			}
			return { placementId: e.placementId, step: "commands", state: "done", folder: over.code };
		}
		// Only a lease ask that got no answer is still starting; what the helper answered is checked at once, as on any
		// pass (an invalid reply or a refusal fails the pass).
		let leased: Buffer;
		try {
			leased = await this.#ask(e, ["refresh-lease", String(COMPANY_MACHINE_LEASE_MS)], signal);
		} catch (error) {
			return this.#unready(e, error);
		}
		// A new boot is marked running once it is usable (BOOT_USABLE: commands find the network and Docker's socket), for
		// BOOT_USABLE_GRACE_MS at most from when its agent first answered.
		if (e.bootId !== prepared.bootId && !(await this.#usable(e, signal))) {
			const known = this.#starting.get(e.placementId);
			const answered = known?.answered ?? Date.now();
			if (Date.now() - answered < BOOT_USABLE_GRACE_MS) {
				this.#starting.set(e.placementId, {
					since: known?.since ?? answered,
					entry: e,
					wakes: known?.wakes ?? 0,
					failing: false,
					answered,
				});
				return { placementId: e.placementId, step: "guest", state: "pending" };
			}
		}
		this.#starting.delete(e.placementId);
		const lease = guestAnswer(leased);
		if (lease.schema !== "qorpera.machine-guest-lease-receipt/v1" || lease.bootId !== bootId)
			throw new Error("COMPANY_MACHINE_GUEST_REPLY_INVALID");
		const folder = this.#options.folder;
		if (e.bootId !== bootId) {
			// The boot before ends first: its views' final boundary, before the new boot is recorded.
			if (folder && e.runningAt !== null && e.bootId !== null) await this.#endFolder(e, e.bootId, signal, true);
			else if (folder) {
				// No boot before that SQL counts as running (a first boot, or one after a stop): the machine is said to have
				// restarted all the same, before the boot's view opens (F3 5g-5). A folder service run that started since its
				// boot before does not vouch for it otherwise, and its first boundary would answer unproven.
				await withTimeoutScope(signal, BOUNDARY_MS, (checked) =>
					folder.restarted(e.placementId, checked).catch(() => undefined),
				);
			}
			// The desktop's figure and time zone are in the machine before SQL says the boot runs: nobody starts a desktop
			// earlier.
			await this.#desktop(e, bootId, signal);
			const marked = machineRecord(
				await this.#custody(e, "qorpera_mark_company_machine_running", signal, { p_boot_id: bootId }),
				"COMPANY_MACHINE_RUNNING_INVALID",
			);
			if (marked.state !== "running") return { placementId: e.placementId, step: "guest", state: "not-now" };
			this.#guests.delete(e.placementId);
			if (!folder) return { placementId: e.placementId, step: "start", state: "done" };
			// Then the boot's own view, opened once SQL knows the boot (the view's anchor), and handed to its guest.
			const f: BootFolder = {
				bootId,
				state: "pending",
				known: true,
				handed: false,
				views: new Set(),
				opens: 0,
				asked: true,
				held: false,
				windows: new Map(),
				homes: new Map(),
				homeChannels: new Map(),
				notSaved: [],
				moreNotSaved: 0,
				stillNotSaved: new Map(),
			};
			this.#folders.set(e.placementId, f);
			return {
				placementId: e.placementId,
				step: "start",
				state: "done",
				folder: await this.#settle(e, f, helperSha256, signal),
			};
		}
		// A running machine of this boot: its desktop's figure and time zone when one changed (or this process never
		// wrote it), its folder settled, how its commands ended, and whether it is busy.
		await this.#desktop(e, bootId, signal);
		let settled: string | undefined;
		let f: BootFolder | undefined;
		if (folder) {
			f = this.#folders.get(e.placementId);
			if (f?.bootId !== bootId) {
				// This process did not see the boot start (it restarted): the views the service holds decide.
				f = {
					bootId,
					state: "pending",
					known: false,
					handed: false,
					views: new Set(),
					opens: 0,
					asked: false,
					held: false,
					windows: new Map(),
					homes: new Map(),
					homeChannels: new Map(),
					notSaved: [],
					moreNotSaved: 0,
					stillNotSaved: new Map(),
				};
				this.#folders.set(e.placementId, f);
			}
			if (f.state === "pending") {
				settled = await this.#settle(e, f, helperSha256, signal);
				// A settle that ended the boot (its new disk retired) leaves it as above.
				if (this.#ended(e.placementId, bootId))
					return { placementId: e.placementId, step: "commands", state: "done", folder: settled };
			}
		}
		// A boot settled before this pass is watched: its windows opened again first, then its reads and views checked.
		const watching = f?.state === "open" && settled === undefined ? f : undefined;
		if (watching) await this.#reopen(e, watching, signal);
		const look = await this.#ends(e, bootId, () => this.#look(e, bootId, signal), signal);
		// Checked again once the look's windows closed, as a read is after its boundary (#ended).
		if (this.#ended(e.placementId, bootId)) return { placementId: e.placementId, step: "commands", state: "done" };
		await this.#record(e, bootId, look, signal);
		// A run's take-in the core refused as no longer readable (#inherit) retires the placement, whatever the boot's
		// folder: the disk keeps what its views were served.
		let watched: string | undefined;
		if (f?.unreadable) watched = await this.#retire(e, f, "unreadable", signal);
		else if (watching) watched = await this.#watch(e, watching, look.boundary, signal);
		const said = watched ?? settled;
		return {
			placementId: e.placementId,
			step: "commands",
			state: "done",
			...(said === undefined ? {} : { folder: said }),
		};
	}
	/** One look inside a running machine of this boot: the listed commands that ended, and whether the whole machine,
	 * apart from its own control, was busy since the last look (the one idle rule: 5% of one core, or 512 KiB read or
	 * written in 30 seconds). Busy stays owed until SQL takes it. */
	async #look(
		e: CompanyMachineEntry,
		bootId: string,
		signal: AbortSignal,
	): Promise<{ ended: Record<string, unknown>[]; busy: boolean }> {
		const observed = await this.#helper(e, ["observe", e.commands.length ? e.commands.join(",") : "-"], signal);
		if (
			observed.schema !== "qorpera.machine-observation/v2" ||
			observed.bootId !== bootId ||
			![observed.at, observed.cpuUsec, observed.ioBytes].every(
				(value) => Number.isSafeInteger(value) && Number(value) >= 0,
			) ||
			!Array.isArray(observed.ended) ||
			observed.ended.length > 64
		)
			throw new Error("COMPANY_MACHINE_GUEST_REPLY_INVALID");
		const sample = {
			cpuSeconds: Number(observed.cpuUsec) / 1e6,
			ioBytes: Number(observed.ioBytes),
			at: Number(observed.at),
		};
		const previous = this.#guests.get(e.placementId);
		const same = previous?.bootId === bootId ? previous : undefined;
		const busy = !!same && (same.busy || idleRuleBusy(same.sample, sample));
		this.#guests.set(e.placementId, { bootId, sample, busy });
		const ended = observed.ended
			.map((item) => machineRecord(item, "COMPANY_MACHINE_GUEST_REPLY_INVALID"))
			.filter((item) => typeof item.commandId === "string" && e.commands.includes(item.commandId))
			.map((item) => ({
				commandId: item.commandId,
				state: item.state,
				...(item.state === "succeeded" || item.state === "failed" ? { exitCode: item.exitCode } : {}),
				outputTail: typeof item.outputTail === "string" ? item.outputTail.slice(-4000) : "",
			}));
		return { ended, busy };
	}
	/** What a look saw, recorded in SQL: the ended commands, and a busy machine, which moves its idle clock. */
	async #record(
		e: CompanyMachineEntry,
		bootId: string,
		look: { ended: unknown[]; busy: boolean },
		signal: AbortSignal,
	): Promise<void> {
		if (!look.ended.length && !look.busy) return;
		await this.#custody(e, "qorpera_record_company_machine_commands", signal, {
			p_boot_id: bootId,
			p_ended: look.ended,
			p_busy: look.busy,
		});
		const kept = this.#guests.get(e.placementId);
		if (kept?.bootId === bootId) kept.busy = false;
	}

	/** Settles a boot's folder (F3 6d) as far as it can this pass, and says what came of it. A boot this process saw
	 * start gets a view of its own: opened in SQL as the platform for this boot, then handed to the guest. After this
	 * process restarted, a view the service still holds keeps the boot's /company (a new one would take it away from the
	 * commands that run) and its boundaries keep fencing. A boot that gets no view of its own (a guest of an earlier
	 * image whose helper does not take the folder, a refused open, views the guest answers closed) is left to
	 * #viewless; a busy or unconfirmed open, or a hand-over without an answer, is tried again next pass, and starts wait
	 * meanwhile. */
	async #settle(e: CompanyMachineEntry, f: BootFolder, helperSha256: string, signal: AbortSignal): Promise<string> {
		const folder = this.#options.folder as FolderControl;
		// A guest of an earlier image settles as any other when its helper takes the company folder as the current one
		// does: one folderHelperSha256s names, or without that list any earlier one this node trusts. After this process
		// restarted, the views the service holds then keep its /company. Any other earlier helper is handed no view:
		// whether it ever took one is not this image's to say.
		if (
			helperSha256 !== this.#options.helperSha256 &&
			!(this.#options.folderHelperSha256s ?? this.#options.previousHelperSha256s ?? []).includes(helperSha256)
		)
			return this.#viewless(e, f, "old-helper", signal);
		if (!f.asked) {
			let held: string[];
			try {
				const boundary = await withTimeoutScope(signal, BOUNDARY_MS, (checked) =>
					folder.boundary(e.placementId, [], checked),
				);
				noted(f, boundary);
				held = boundary.views.map((view) => view.viewId);
			} catch (error) {
				return errorCode(error);
			}
			f.asked = true;
			if (held.length) {
				for (const viewId of held) f.views.add(viewId);
				f.state = "open";
				f.held = true;
				return "FOLDER_HELD";
			}
		}
		if (!f.view) {
			let opened: Record<string, unknown>;
			try {
				opened = machineRecord(
					await this.#call(
						"qorpera_folder_view_open",
						{
							p_environment_id: e.binding.environmentId,
							p_opener: { kind: "platform" },
							p_kind: "test_machine",
							p_anchor: { companyMachineId: e.machineId, placementId: e.placementId, bootId: f.bootId },
						},
						signal,
					),
					"COMPANY_MACHINE_FOLDER_VIEW_INVALID",
				);
			} catch (error) {
				if (!(error instanceof CodingControlRefused)) return errorCode(error);
				// A disk the core cannot prove (a test machine's new disk) moves the machine to a new one (6d-2).
				if (error.detail === "qorpera.test-machine/new-disk") return this.#retire(e, f, "new-disk", signal);
				f.refusal = error.reason ?? undefined;
				return this.#viewless(e, f, "refused", signal);
			}
			if (
				opened.schema !== "qorpera.folder-view/v1" ||
				typeof opened.viewId !== "string" ||
				!UUID_PATTERN.test(opened.viewId) ||
				typeof opened.pass !== "string" ||
				!PASS.test(opened.pass)
			)
				return "COMPANY_MACHINE_FOLDER_VIEW_INVALID";
			f.view = { viewId: opened.viewId, pass: opened.pass };
			f.opens++;
		}
		// From here the guest may hold the pass, whatever it answers: the boot is fenced for good.
		f.handed = true;
		f.views.add(f.view.viewId);
		let mount: string;
		try {
			mount = await this.#mount(e, f.view, signal);
		} catch (error) {
			// The guest refused or did not answer: the view is handed over again next pass.
			return errorCode(error);
		}
		if (mount === "closed") {
			// The node closed or refused the view: another one, a few times.
			await this.#closeView(f.view, signal);
			f.view = undefined;
			if (f.opens < FOLDER_OPENS) return "MACHINE_FOLDER_CLOSED";
			return this.#viewless(e, f, "closed", signal);
		}
		f.state = "open";
		if (mount !== "mounted") return "FOLDER_UNANSWERED";
		f.held = true;
		return "FOLDER_MOUNTED";
	}
	/** A boot without a view of its own runs without /company only when no pass can have reached its guest: this
	 * process saw it start, handed it none, and the service holds no view of the machine and has its reads released.
	 * Any other boot stays fenced, by its windows and the machine's boundaries; reads that stay unproven then restart
	 * its guest (#watch). */
	async #viewless(
		e: CompanyMachineEntry,
		f: BootFolder,
		reason: NonNullable<BootFolder["reason"]>,
		signal: AbortSignal,
	): Promise<string> {
		const code = reason.toUpperCase().replace("-", "_");
		f.reason = reason;
		if (f.known && !f.handed) {
			let boundary: MachineBoundary;
			try {
				boundary = await withTimeoutScope(signal, BOUNDARY_MS, (checked) =>
					(this.#options.folder as FolderControl).boundary(e.placementId, [], checked),
				);
			} catch (error) {
				return errorCode(error);
			}
			noted(f, boundary);
			if (!boundary.views.length && boundary.reads === "released") {
				f.state = "none";
				return `FOLDER_NONE:${code}`;
			}
			for (const view of boundary.views) f.views.add(view.viewId);
		}
		f.state = "open";
		return `FOLDER_FENCED:${code}`;
	}
	/** A disk that may never be proven (6d-2): a new disk the open refuses, or reads on its view the core cannot read (a
	 * boundary's, or a run's take-in of them, 6d-3b).
	 * SQL checks the cause again: it retires the placement (its commands end lost, and admission starts the machine on a
	 * new disk once this one is stopped and removed), or keeps a disk that may still get a view, as the boot it is. A
	 * boot SQL no longer runs (stale) or a retired placement only waits for its stop: its starts are refused. */
	async #retire(
		e: CompanyMachineEntry,
		f: BootFolder,
		reason: "new-disk" | "unreadable",
		signal: AbortSignal,
	): Promise<string> {
		let retired: Record<string, unknown>;
		try {
			retired = machineRecord(
				await this.#custody(e, "qorpera_retire_company_machine", signal, { p_boot_id: f.bootId, p_reason: reason }),
				"COMPANY_MACHINE_RETIRE_INVALID",
			);
		} catch (error) {
			return errorCode(error);
		}
		if (retired.state === "kept" && retired.reason === "FOLDER_DISK_USABLE") return "FOLDER_DISK_USABLE";
		let code: string;
		let cause: string;
		if (retired.state === "stale") {
			code = "FOLDER_RETIRE_STALE";
			cause = "stale";
		} else if (
			retired.state === "retired" &&
			retired.placementId === e.placementId &&
			["unchecked", "starter", "unreadable"].includes(retired.reason as string)
		) {
			code = `FOLDER_RETIRED:${String(retired.reason).toUpperCase()}`;
			cause = `moved_${String(retired.reason)}`;
		} else return "COMPANY_MACHINE_RETIRE_INVALID";
		this.#endings.set(`${e.placementId}/${f.bootId}`, { by: "retirement", code, cause });
		return code;
	}
	/** A boot whose folder can never be proven again (6d-2): its reads stay unproven, or its own view was closed or is
	 * gone. Its guest restarts, and the next boot gets a view of its own; until then its starts are refused, and its
	 * output and its ends stay held. A start on its way into the guest goes in before the reboot is asked
	 * (#delivered), and SQL keeps why for the commands the restart loses (#mark). */
	async #restart(
		e: CompanyMachineEntry,
		f: BootFolder,
		why: "UNPROVEN" | "VIEW_CLOSED" | "VIEW_GONE",
		signal: AbortSignal,
	): Promise<string> {
		const code = `FOLDER_RESTART:${why}`;
		const cause = `restart_${why.toLowerCase()}`;
		this.#endings.set(`${e.placementId}/${f.bootId}`, { by: "restart", code, cause });
		await this.#delivered(e, signal);
		await this.#mark(e, f.bootId, cause, signal);
		await this.#reboot(e, signal);
		return code;
	}
	/** The commands still open on a boot the executor restarts end lost in its restart: SQL keeps why for their runs
	 * (6e-2a). Asked before each reboot, at best: a mark that fails, or a start let in after it, leaves a command lost
	 * without a cause. */
	async #mark(e: CompanyMachineEntry, bootId: string, cause: string, signal: AbortSignal): Promise<void> {
		await this.#custody(e, "qorpera_mark_company_machine_folder_restart", signal, {
			p_boot_id: bootId,
			p_reason: cause.slice("restart_".length),
		}).catch(() => undefined);
	}
	/** Waits until no start is being delivered to the machine, for at most a delivery's 30 s: one let in before its boot
	 * ended reaches its guest first (and is lost in the restart), and one not yet in is refused (#command). */
	async #delivered(e: CompanyMachineEntry, signal: AbortSignal): Promise<void> {
		await withTimeoutScope(signal, DELIVERY_MS, async (waited) => {
			while (!waited.aborted && [...this.#delivering.keys()].some((key) => key.startsWith(`${e.placementId}/`)))
				await setTimeout(200, undefined, { signal: waited }).catch(() => undefined);
		});
	}
	/** The guest reboots itself, unwaited: a stop from here would wait for its commands to end (SQL refuses a stop while
	 * one runs). A guest that does not reboot stays held until it does, or stops. */
	async #reboot(e: CompanyMachineEntry, signal: AbortSignal): Promise<void> {
		await withTimeoutScope(signal, REBOOT_MS, (checked) =>
			this.#options.client
				.execInstance(
					e.binding.project,
					this.#plan(e).name,
					["/bin/sh", "-c", "systemctl --no-block reboot"],
					checked,
				)
				.catch(() => undefined),
		);
	}
	/** A boot whose folder ended (6d-2): nothing of it is looked at or recorded any more, by a pass or its stop, and
	 * nothing its commands printed, nor how they ended, leaves it (#command). Its starts are refused (#settled). */
	#ended(placementId: string, bootId: string): boolean {
		return this.#endings.has(`${placementId}/${bootId}`);
	}
	/** Hands a view to the guest's folder program (folder-mount, F3 6c) on exec stdin: its pass is never in an argument,
	 * a file on this host or a log. The newest view the guest is handed wins. */
	async #mount(
		e: CompanyMachineEntry,
		view: { viewId: string; pass: string },
		signal: AbortSignal,
	): Promise<"mounted" | "closed" | "unanswered"> {
		const plan = this.#plan(e);
		const nonce = randomUUID();
		const client = this.#options.client as LxdInstanceExecStreamClient;
		await client.execInstanceStream(
			plan.project,
			plan.name,
			{
				command: ["/usr/bin/node", PATHS.helper, nonce, "folder-mount"],
				stdin: Buffer.from(JSON.stringify({ environmentId: e.binding.environmentId, ...view })),
				maxStdoutBytes: 65536,
				maxStderrBytes: 65536,
				timeoutMs: FOLDER_MOUNT_MS,
			},
			signal,
		);
		const answer = guestAnswer(await this.#reply(plan, nonce, signal));
		if (
			answer.schema !== "qorpera.machine-guest-folder/v1" ||
			answer.viewId !== view.viewId ||
			(answer.mount !== "mounted" && answer.mount !== "closed" && answer.mount !== "unanswered")
		)
			throw new Error("COMPANY_MACHINE_GUEST_REPLY_INVALID");
		return answer.mount as "mounted" | "closed" | "unanswered";
	}
	/** The view's close in SQL (said again, it changes nothing). Not closed, it lapses with its lease. */
	async #closeView(view: { viewId: string; pass: string }, signal: AbortSignal): Promise<void> {
		await this.#call("qorpera_folder_view_close", { p_view_id: view.viewId, p_pass: view.pass }, signal).catch(
			() => undefined,
		);
	}
	/** A boot's folder ends (F3 6d), with its machine up: the final boundary of every view of the boot the service may
	 * hold, which closes them in the core (at most a minute: what an unanswered final held is not applied), then the
	 * view's close. A machine that restarted is then said to have (`restarted`): its command windows end, and a read it
	 * lost no longer makes its next views unproven. Nothing here holds up the stop or the next boot. A boot whose folder
	 * ended (6d-2) stays so once its folder is gone (#endings): a stop, or a next boot, that SQL did not take yet comes
	 * back to it. */
	async #endFolder(e: CompanyMachineEntry, bootId: string, signal: AbortSignal, restarted: boolean): Promise<void> {
		const folder = this.#options.folder as FolderControl;
		const kept = this.#folders.get(e.placementId);
		const f = kept?.bootId === bootId ? kept : undefined;
		if (f?.state !== "none") {
			await withTimeoutScope(signal, FINAL_BOUNDARY_MS, async (checked) => {
				try {
					const views = new Set([...(f?.views ?? []), ...(f?.view ? [f.view.viewId] : [])]);
					// Unseen by this process, the boot's views are the ones the service holds for the machine.
					if (!f?.known)
						for (const view of (await folder.boundary(e.placementId, [], checked)).views) views.add(view.viewId);
					if (views.size) await folder.boundary(e.placementId, [...views].slice(0, 256), checked);
				} catch {
					// Unanswered: the service applies nothing it held for the final.
				}
			});
			if (f?.view) await this.#closeView(f.view, signal);
		}
		if (restarted) {
			await withTimeoutScope(signal, BOUNDARY_MS, (checked) =>
				folder.restarted(e.placementId, checked).catch(() => undefined),
			);
		}
		this.#folders.delete(e.placementId);
	}
	/** A look (`looking`) and its ends, in the end order (F3 6d): each ended command's window closes first, and its end
	 * (how it ended, its exit and its output tail) is recorded only once that close answers the machine's reads
	 * released. Any other answer, or none, leaves the end for a later look. A start being delivered at any time from
	 * the look's beginning is not ended by it: its guest may have looked before it had the command, so its window stays
	 * open (or opens again, after the close), and a later look decides. The last boundary a close answered comes back
	 * too, for #watch. */
	async #ends(
		e: CompanyMachineEntry,
		bootId: string,
		looking: () => Promise<{ ended: Record<string, unknown>[]; busy: boolean }>,
		signal: AbortSignal,
	): Promise<{ ended: Record<string, unknown>[]; busy: boolean; boundary?: MachineBoundary }> {
		const folder = this.#options.folder;
		if (!folder) return looking();
		const touched = new Set<string>();
		this.#looks.add(touched);
		try {
			const look = await looking();
			const keyOf = (item: Record<string, unknown>) => `${e.placementId}/${item.commandId as string}`;
			const stale = (item: Record<string, unknown>) => touched.has(keyOf(item)) || this.#delivering.has(keyOf(item));
			// A boot without /company has no windows to close, but a start delivered meanwhile is not ended either.
			const f = this.#folders.get(e.placementId);
			if (f?.bootId === bootId && f.state === "none")
				return { ended: look.ended.filter((item) => !stale(item)), busy: look.busy };
			return await withTimeoutScope(signal, WINDOWS_MS, async (checked) => {
				const ended: Record<string, unknown>[] = [];
				let boundary: MachineBoundary | undefined;
				for (const item of look.ended) {
					if (stale(item)) continue;
					const commandId = item.commandId as string;
					const key = keyOf(item);
					// The command ended: its window is not opened again (#reopen), whatever its close answers.
					if (f?.bootId === bootId) f.windows.delete(commandId);
					// A start that comes meanwhile opens its window (again) only once this close is answered (#command).
					const closing = folder.closeWindow(e.placementId, commandId, checked).catch(() => undefined);
					this.#closing.set(key, closing);
					const answer = await closing;
					if (this.#closing.get(key) === closing) this.#closing.delete(key);
					if (f?.bootId === bootId) noted(f, answer);
					boundary = answer ?? boundary;
					if (answer?.reads === "released") ended.push(item);
				}
				// A start that came while the windows closed is not ended either: its window opens again after the close.
				return { ended: ended.filter((item) => !stale(item)), busy: look.busy, ...(boundary ? { boundary } : {}) };
			});
		} finally {
			this.#looks.delete(touched);
		}
	}
	/** The boot's command windows, opened again (said again, it changes nothing): the service keeps them in memory, so
	 * after it restarted, what the machine changes is credited to the commands that run again. A start still being
	 * delivered opens its own, and a command SQL does not list now is left for its close (#ends). */
	async #reopen(e: CompanyMachineEntry, f: BootFolder, signal: AbortSignal): Promise<void> {
		const folder = this.#options.folder as FolderControl;
		await withTimeoutScope(signal, WINDOWS_MS, async (checked) => {
			const windows = [...f.windows].filter(
				([commandId]) => e.commands.includes(commandId) && !this.#delivering.has(`${e.placementId}/${commandId}`),
			);
			await runLimited(windows, 4, async ([, window]) => {
				if (checked.aborted) return;
				await folder.openWindow(e.placementId, window, checked).catch(() => undefined);
			});
			// A home's window closes when its channel ends, at any time: one that closed while this open was out (the service
			// may take the two in either order) is closed again, so no window outlives its session.
			await runLimited([...f.homes], 4, async ([sessionId, window]) => {
				if (checked.aborted) return;
				await folder.openWindow(e.placementId, window, checked).catch(() => undefined);
				if (!f.homes.has(sessionId))
					noted(f, await folder.closeWindow(e.placementId, sessionId, checked).catch(() => undefined));
			});
		});
	}
	/** A settled boot's folder, watched each pass (6d-2) at the boundary its ends' closes answered, or a plain one.
	 * Reads the core cannot read retire the placement (#retire): a read being released, or one released before that a
	 * view's publish found no longer readable (the view's report says so, with the machine's reads released). Reads
	 * that stay unproven (a read went unreleased, which only the machine's restart forgives), a view of the boot's own
	 * the core closed (a narrowing, or a crashed service's view refused to the next one), or that view missing from the
	 * service for longer than its folder program takes to connect again, restart its guest (#restart). Any other
	 * answer, or none, changes nothing. */
	async #watch(
		e: CompanyMachineEntry,
		f: BootFolder,
		given: MachineBoundary | undefined,
		signal: AbortSignal,
	): Promise<string | undefined> {
		let boundary = given;
		if (!boundary)
			try {
				boundary = await withTimeoutScope(signal, BOUNDARY_MS, (checked) =>
					(this.#options.folder as FolderControl).boundary(e.placementId, [], checked),
				);
				noted(f, boundary);
			} catch {
				return undefined;
			}
		// A view's publish the core refused for a read it can no longer read: a read released before, which its commit's
		// read set checked again, while no read was left to release (so the machine's reads answer released).
		if (boundary.reads === "unreadable" || boundary.views.some((view) => view.report?.refused === "unreadable"))
			return this.#retire(e, f, "unreadable", signal);
		if (boundary.reads === "unproven") return this.#restart(e, f, "UNPROVEN", signal);
		// The boot's own views: the one this process opened, or (after it restarted) the ones the service held.
		const own = f.view ? [f.view.viewId] : f.reason ? [] : [...f.views];
		const listed = boundary.views.filter((view) => own.includes(view.viewId));
		if (listed.some((view) => view.error?.code === "VIEW_CLOSED")) return this.#restart(e, f, "VIEW_CLOSED", signal);
		if (listed.length) {
			f.held = true;
			f.missing = undefined;
		} else if (f.held) {
			f.missing ??= Date.now();
			if (Date.now() - f.missing >= FOLDER_GONE_MS) return this.#restart(e, f, "VIEW_GONE", signal);
		}
		return undefined;
	}
	async #stop(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		// A last look first, when this boot was seen before, so a machine busy again since the last pass keeps running
		// (stop custody then refuses). A guest that does not answer still stops, once busy work seen earlier is recorded;
		// a record SQL does not take leaves the machine running until a later pass records it. A boot whose folder ended
		// (6d-2) is neither looked at nor recorded, before its windows close or after, and at every stop again after one
		// whose record or power-off failed (its folder gone by then): how its commands ended, and what they printed, stay
		// held whatever a boundary answers (#ended).
		const kept = this.#guests.get(e.placementId);
		const bootId = e.bootId;
		const ended = () => bootId !== null && this.#ended(e.placementId, bootId);
		if (bootId !== null && kept?.bootId === bootId && !ended()) {
			const look = await withTimeoutScope(signal, 30000, (checked) => {
				const looking = () => this.#look(e, bootId, checked).catch(() => ({ ended: [], busy: kept.busy }));
				return this.#ends(e, bootId, looking, signal);
			});
			if (!ended()) await this.#record(e, bootId, look, signal);
		}
		// SQL agrees first: an idle machine someone just used again keeps running, programs and all.
		try {
			await this.#authorize(e, "stop", signal);
		} catch (error) {
			if (errorCode(error).startsWith("COMPANY_MACHINE_REFUSED:"))
				return { placementId: e.placementId, step: "stop", state: "not-now" };
			throw error;
		}
		// Right before it stops the programs, the guest lists what runs (its command units, at most 32 oldest first,
		// and whether Docker ran containers); SQL ends those commands with the stop's cause and tells them, before the
		// machine is powered off (its disk stays). A guest without the helper's stop is stopped as before; a snapshot
		// that is not the listed shape, or of a boot SQL does not know, is left out. Either way what still runs is told
		// at the power-off. A power-off that then fails ends this stop: the next one takes its own snapshot.
		if (e.runningAt !== null) {
			const stopped = await withTimeoutScope(signal, 30000, async (stopping) => {
				const answer = await this.#helper(e, ["stop-commands"], stopping).catch(() => undefined);
				if (!answer)
					await this.#options.client
						.execInstance(
							e.binding.project,
							this.#plan(e).name,
							["/bin/sh", "-c", `systemctl stop ${PATHS.slice} docker.service containerd.service; sync`],
							stopping,
						)
						.catch(() => undefined);
				return answer;
			});
			// A boot whose folder ended lists none of its commands either: which still ran says how the others ended, so
			// SQL ends them all lost at the power-off (#ended). Its stopped containers are the stop's own.
			const silent = ended();
			// With its programs stopped and the machine still up, the boot's folder ends (F3 6d): the final boundary of
			// its views, then their close, before SQL ends the commands and the machine is powered off.
			if (this.#options.folder && e.bootId !== null) await this.#endFolder(e, e.bootId, signal, false);
			if (
				stopped &&
				stopped.schema === "qorpera.machine-commands-stopped/v1" &&
				stopped.bootId === e.bootId &&
				Array.isArray(stopped.commands) &&
				stopped.commands.length <= 32 &&
				stopped.commands.every((id) => typeof id === "string" && UUID_PATTERN.test(id)) &&
				typeof stopped.containers === "boolean"
			)
				// SQL takes the snapshot before the power-off; a record it does not take leaves the machine running.
				await this.#custody(e, "qorpera_record_company_machine_stop", signal, {
					p_boot_id: e.bootId,
					p_commands: silent ? [] : stopped.commands,
					p_containers: stopped.containers,
				});
			// What the stop ended is never measured as busy afterwards: a look after a failed power-off starts afresh.
			this.#guests.delete(e.placementId);
		}
		const state = await this.#physical(e, "stopped", signal);
		if (state === "not-now") return { placementId: e.placementId, step: "stop", state: "not-now" };
		this.#guests.delete(e.placementId);
		this.#verifiedHelpers.delete(e.placementId);
		// Its next boot has its own time to come up.
		this.#starting.delete(e.placementId);
		if (this.#options.folder && e.bootId !== null) {
			// Powered off: the machine's command windows end, and what it was served is gone with it.
			await withTimeoutScope(signal, BOUNDARY_MS, (checked) =>
				this.#options.folder!.restarted(e.placementId, checked).catch(() => undefined),
			);
			this.#folders.delete(e.placementId);
		}
		const suspended = machineRecord(
			await this.#custody(e, "qorpera_suspend_company_machine", signal),
			"COMPANY_MACHINE_SUSPEND_INVALID",
		);
		return { placementId: e.placementId, step: "stop", state: suspended.state === "suspended" ? "done" : "not-now" };
	}
	async #remove(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		if (!e.released) {
			// A machine SQL still counts as running (its VM powered off by itself; LXD deletes only a stopped
			// one) ends its boot's folder before it goes (F3 6d).
			if (this.#options.folder && e.runningAt !== null && e.bootId !== null)
				await this.#endFolder(e, e.bootId, signal, false);
			const state = await this.#physical(e, "deleted", signal);
			if (state === "not-now") return { placementId: e.placementId, step: "delete", state: "not-now" };
		}
		const released = machineRecord(
			await this.#custody(e, "qorpera_release_company_machine", signal),
			"COMPANY_MACHINE_RELEASE_INVALID",
		);
		if (released.state !== "released") throw new Error("COMPANY_MACHINE_RELEASE_INVALID");
		this.#guests.delete(e.placementId);
		this.#verifiedHelpers.delete(e.placementId);
		this.#pages.delete(e.placementId);
		this.#starting.delete(e.placementId);
		this.#folders.delete(e.placementId);
		this.#desktopWords.delete(e.placementId);
		// Its pointer (20260930744000): the mover ends with the instance anyway; what was known of it goes.
		this.#movers.get(e.placementId)?.stop.abort();
		this.#movers.delete(e.placementId);
		const stream = this.#streams.get(e.placementId);
		this.#streams.delete(e.placementId);
		this.#streamStarts.delete(e.placementId);
		stream?.stream.close?.();
		this.#moverEnded.delete(e.placementId);
		this.#fenceCounts.delete(e.placementId);
		this.#fencePublished.delete(e.placementId);
		this.#fenceWrites.delete(e.placementId);
		this.#moverFailed.delete(e.placementId);
		this.#pointerUsers.delete(e.placementId);
		this.#generations.delete(e.placementId);
		this.#screenBusy.delete(e.placementId);
		const codex = this.#homeCodexes.get(e.placementId);
		this.#homeCodexes.delete(e.placementId);
		codex?.controller.abort();
		this.#homeSftps.delete(e.placementId);
		// Its instance deleted and the placement released, no boot of it runs or is read again: its ends go with it. Only
		// here: after a power-off, or the next boot's mark, a read let in for the boot before may still come.
		for (const key of this.#endings.keys()) if (key.startsWith(`${e.placementId}/`)) this.#endings.delete(key);
		return { placementId: e.placementId, step: "release", state: "done" };
	}
	/** This placement's own instance exists, unchanged, and runs. */
	async #instanceRunning(e: CompanyMachineEntry, signal: AbortSignal): Promise<boolean> {
		const plan = this.#plan(e);
		const instance = await this.#options.client.getInstance(plan.project, plan.name, signal);
		if (!instance) return false;
		plan.assertInstance(instance, "run");
		return instance.status === "Running";
	}
	async #step(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		if (e.released) return this.#remove(e, signal);
		if ((e.stopDue || e.sleepDue) && e.reserved) return this.#stop(e, signal);
		if (e.removeDue && !e.reserved) return this.#remove(e, signal);
		if (e.desiredState === "running" && e.reserved) {
			const state = await this.#physical(e, "running", signal);
			// Without new run authority (its node looks unavailable, or machines are switched off), a
			// machine that already runs keeps its lease and its commands are still watched: only
			// creating or starting it needs the node's room.
			if (state === "not-now" && !(e.runningAt !== null && (await this.#instanceRunning(e, signal))))
				return { placementId: e.placementId, step: "start", state: "not-now" };
			return this.#guest(e, signal);
		}
		return { placementId: e.placementId, step: "wait", state: "not-now" };
	}
	async #recordError(
		e: CompanyMachineEntry,
		stage: string,
		errorCodeValue: string | null,
		signal: AbortSignal,
	): Promise<void> {
		await this.#call(
			"qorpera_record_company_machine_error",
			{
				p_placement_id: e.placementId,
				p_owner: this.#options.owner,
				p_machine_id_sha256: this.#options.machineIdSha256,
				p_stage: stage,
				p_code: errorCodeValue,
			},
			signal,
		).catch(() => undefined);
	}

	/** The pool's real use, for the kernel's room (20260930757000): at most every 30 s, one report at a time, beside the
	 * passes (it never holds up admission). The reader reads the awake disks and the sleeping ones it keeps no read of
	 * (each listed placement's disk of the policy's pool, by its own name), then the pool, and the report goes to the
	 * kernel with qorpera_report_executor_disk. A report that fails is left (the kernel decides on the paper budget once
	 * its last report is 2 minutes old); it never fails a pass. */
	#startDiskReport(lasting: AbortSignal): void {
		const reader = this.#diskReader;
		const now = (this.#options.now ?? Date.now)();
		if (!reader || this.#diskReport || now - this.#diskReadAt < COMPANY_MACHINE_DISK_REPORT_EVERY_MS) return;
		this.#diskReadAt = now;
		const pool = this.#policy.storagePool;
		const placements: CompanyMachineDiskPlacement[] = [];
		for (const e of this.#listed) {
			if (e.binding.storagePool !== pool) continue;
			try {
				const { project, name } = this.#plan(e);
				placements.push({ placementId: e.placementId, project, name, asleepSince: e.asleepSince });
			} catch {
				// A placement whose binding is not this executor's: its use stays unknown.
			}
		}
		const report = (async () => {
			try {
				await withTimeoutScope(lasting, DISK_REPORT_MS, async (checked) => {
					const reading = await reader.read(placements, checked);
					await this.#call(
						"qorpera_report_executor_disk",
						{
							p_owner: this.#options.owner,
							p_machine_id_sha256: this.#options.machineIdSha256,
							p_report: reading.report,
						},
						checked,
					);
				});
			} catch {
				// Left for the next report: the kernel's paper budget stands in once the last report is old.
			}
		})();
		const settled: Promise<void> = report.finally(() => {
			if (this.#diskReport === settled) this.#diskReport = undefined;
		});
		this.#diskReport = settled;
	}

	/** One pass. Placements progress side by side; a failed step is recorded
	 * on its machine and retried at the next pass, never hidden. Admission
	 * takes one machine per call (one reservation per transaction) and never
	 * holds up the rest of the pass. */
	pass(signal: AbortSignal): Promise<CompanyMachineOutcome[]> {
		return withAbortScope(signal, (scoped) => this.#pass(scoped, signal));
	}
	/** `lasting` outlasts this pass: a step that outlasts it goes on under it, each step under a scope of its own. */
	async #pass(signal: AbortSignal, lasting: AbortSignal): Promise<CompanyMachineOutcome[]> {
		const admission: CompanyMachineOutcome[] = [];
		this.#startDiskReport(lasting);
		for (let admitted = 0; admitted < 8; admitted++) {
			let taken: unknown;
			try {
				taken = await this.#call(
					"qorpera_admit_executor_machines",
					{ p_owner: this.#options.owner, p_machine_id_sha256: this.#options.machineIdSha256, p_limit: 64 },
					signal,
				);
			} catch (error) {
				admission.push({ placementId: null, step: "admit", state: "failed", code: errorCode(error) });
				break;
			}
			if (!Array.isArray(taken) || taken.length === 0) break;
		}
		const asked = this.#stepEnds;
		const listed = await this.#call(
			"qorpera_list_executor_machines",
			{ p_owner: this.#options.owner, p_machine_id_sha256: this.#options.machineIdSha256 },
			signal,
		);
		if (!Array.isArray(listed)) throw new Error("COMPANY_MACHINE_LIST_INVALID");
		const entries = listed.map(entry);
		this.#listed = entries;
		const outcomes: (CompanyMachineOutcome | undefined)[] = [];
		let over = false;
		const steps = Promise.all(
			entries.map(async (e, index) => {
				if (this.#stepping.has(e.placementId) || (this.#endedAt.get(e.placementId) ?? -1) >= asked) return;
				this.#stepping.add(e.placementId);
				try {
					const outcome = await withAbortScope(lasting, (scoped) =>
						this.#exclusive(e.placementId, () => this.#stepped(e, scoped)),
					);
					this.#after(e, outcome);
					if (over) this.#late.push(outcome);
					else outcomes[index] = outcome;
				} finally {
					this.#stepping.delete(e.placementId);
					this.#endedAt.set(e.placementId, this.#stepEnds++);
				}
			}),
		);
		const hold = this.#options.passHoldMs ?? PASS_HOLD_MS;
		if (!Number.isFinite(hold)) await steps;
		else {
			const done = new AbortController();
			await Promise.race([
				steps.finally(() => done.abort()),
				setTimeout(hold, undefined, { signal: done.signal }).catch(() => undefined),
			]);
		}
		over = true;
		const listedIds = new Set(entries.map((item) => item.placementId));
		for (const placementId of this.#endedAt.keys()) {
			if (!listedIds.has(placementId) && !this.#stepping.has(placementId)) this.#endedAt.delete(placementId);
		}
		return [
			...this.#late.splice(0),
			...admission,
			...outcomes.filter((outcome): outcome is CompanyMachineOutcome => outcome !== undefined),
		];
	}
	/** One placement's step: what came of it. A failed step is recorded on its machine. */
	async #stepped(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		const stage = (step: CompanyMachineOutcome["step"]) =>
			step === "guest" || step === "commands"
				? step === "guest"
					? "guest"
					: "commands"
				: step === "wait"
					? "start"
					: step;
		try {
			const outcome = await this.#step(e, signal);
			if (outcome.state === "done" && outcome.step !== "commands")
				await this.#recordError(e, stage(outcome.step), null, signal);
			return outcome;
		} catch (error) {
			const step: CompanyMachineOutcome["step"] =
				e.released || (e.removeDue && !e.reserved)
					? "delete"
					: (e.stopDue || e.sleepDue) && e.reserved
						? "stop"
						: "start";
			// The company's locks were busy past SQL's short wait (lock_not_available): no fault
			// of the machine's, and nothing to show; the next pass tries again.
			if (error instanceof CodingControlBusy)
				return {
					placementId: e.placementId,
					step,
					state: "not-now" as const,
					code: "CODING_CONTROL_BUSY",
				};
			const failed = errorCode(error);
			await this.#recordError(e, stage(step), failed, signal);
			return { placementId: e.placementId, step, state: "failed" as const, code: failed };
		}
	}
	/** A step that took its machine somewhere tells who waits to hear it. A stop or a release may have freed the room a
	 * machine in line waits for, and only a pass admits it: the next one comes at once. */
	#after(e: CompanyMachineEntry, outcome: CompanyMachineOutcome): void {
		if (outcome.state !== "done" || outcome.step === "commands") return;
		for (const tell of [...(this.#listeners.get(e.machineId) ?? [])]) tell();
		if (outcome.step === "stop" || outcome.step === "release") this.wake();
	}

	/** Asks for the next pass now, instead of at the end of the wait before it (or right after the pass that runs). A wake
	 * carries no authority: each step of that pass asks SQL as ever. */
	wake(): void {
		this.#woken = true;
		this.#ending?.();
	}
	/** A wake, and the answer once a step took this machine somewhere: true when its start is done (its folder settled
	 * too) or it stopped or went, false when the signal ended first. The answer only says to look: what SQL says stands. */
	changed(machineId: string, signal: AbortSignal): Promise<boolean> {
		this.wake();
		return new Promise((settle) => {
			if (signal.aborted) return settle(false);
			const listeners = this.#listeners.get(machineId) ?? new Set<() => void>();
			this.#listeners.set(machineId, listeners);
			const finish = (answer: boolean): void => {
				signal.removeEventListener("abort", left);
				listeners.delete(told);
				if (!listeners.size && this.#listeners.get(machineId) === listeners) this.#listeners.delete(machineId);
				settle(answer);
			};
			const told = (): void => finish(true);
			const left = (): void => finish(false);
			listeners.add(told);
			signal.addEventListener("abort", left, { once: true });
		});
	}
	/** The wait before the next pass, `ms` at most. A wake ends it. So does a guest still starting whose boot became usable:
	 * each is asked every second, of LXD alone, so a boot costs SQL nothing more. A boot that never gets there is left to
	 * the passes, as it would be without this. */
	async pause(ms: number, signal: AbortSignal): Promise<void> {
		const started = Date.now();
		const deadline = started + ms;
		// However many wakes come, passes come a second apart at most.
		const earliest = started + Math.min(PASS_FLOOR_MS, ms);
		while (!signal.aborted) {
			const now = Date.now();
			if (now >= deadline || (this.#woken && now >= earliest)) break;
			if (!this.#woken) this.#lookAtStarting(signal);
			await new Promise<void>((settle) => {
				const end = (): void => {
					clearTimeout(timer);
					signal.removeEventListener("abort", end);
					this.#ending = undefined;
					settle();
				};
				const wait = this.#woken
					? earliest - now
					: this.#starting.size > 0
						? Math.min(STARTING_LOOK_MS, deadline - now)
						: deadline - now;
				const timer = globalThis.setTimeout(end, Math.max(0, wait));
				signal.addEventListener("abort", end, { once: true });
				this.#ending = end;
			});
		}
		this.#woken = false;
	}
	/** The machine workload's loop: a pass, what came of it, then the wait before the next. */
	async run(
		signal: AbortSignal,
		log: (outcomes: CompanyMachineOutcome[] | { failed: string }) => void,
	): Promise<void> {
		while (!signal.aborted) {
			try {
				log(await this.pass(signal));
			} catch (error) {
				if (!signal.aborted) log({ failed: errorCode(error) });
			}
			await this.pause(COMPANY_MACHINE_PASS_EVERY_MS, signal);
		}
	}
	#lookAtStarting(signal: AbortSignal): void {
		const limit = this.#options.guestReadyTimeoutMs ?? 180000;
		for (const [placementId, starting] of this.#starting) {
			if (
				starting.failing ||
				starting.wakes >= STARTING_WAKES ||
				Date.now() - starting.since >= limit ||
				this.#looking.has(placementId) ||
				this.#stepping.has(placementId)
			)
				continue;
			this.#looking.add(placementId);
			void withTimeoutScope(signal, STARTING_LOOK_LIMIT_MS, (checked) => this.#bootUsable(starting.entry, checked))
				.then((usable) => {
					if (!usable || this.#starting.get(placementId) !== starting) return;
					starting.wakes++;
					this.wake();
				})
				.finally(() => this.#looking.delete(placementId));
		}
	}
	/** Whether the guest's agent answers (a file read, which fails at once and leaves no operation behind) and its boot
	 * reached BOOT_USABLE. */
	async #bootUsable(e: CompanyMachineEntry, signal: AbortSignal): Promise<boolean> {
		try {
			const { project, name } = this.#plan(e);
			await this.#options.client.readInstanceFile(project, name, PATHS.helper, 65536, signal);
			await this.#options.client.execInstance(
				project,
				name,
				BOOT_USABLE,
				signal,
				Math.ceil(STARTING_LOOK_LIMIT_MS / 1000),
			);
			return true;
		} catch {
			return false;
		}
	}
	/** Whether a boot whose agent answers reached BOOT_USABLE. */
	async #usable(e: CompanyMachineEntry, signal: AbortSignal): Promise<boolean> {
		try {
			const { project, name } = this.#plan(e);
			await withTimeoutScope(signal, STARTING_LOOK_LIMIT_MS, (checked) =>
				this.#options.client.execInstance(
					project,
					name,
					BOOT_USABLE,
					checked,
					Math.ceil(STARTING_LOOK_LIMIT_MS / 1000),
				),
			);
			return true;
		} catch {
			signal.throwIfAborted();
			return false;
		}
	}
	/** The steps still running, once they ended. */
	async settled(): Promise<void> {
		await Promise.allSettled([...this.#work.values(), this.#diskReport]);
	}

	/**
	 * save_coding_value (20260930705000): the image's clipboard helper on a machine of this node, as root, on exactly the
	 * boot SQL named, with SQL's target on its stdin. It reads the desktop's clipboard, seals the one key of the service
	 * in it to the value's capture key and clears the clipboard; its stdout (one JSON line: the box or a refusal code) is
	 * read here within its bound and never logged, and its stderr is dropped. LXD records no output. It runs once: a
	 * failure is the call's, never run again.
	 *
	 * A run that did not end cleanly (the request cancelled or past its deadline, which kills the helper, a failed exit,
	 * an answer lost or not the helper's) may have left the key on the clipboard, which Chromium keeps owning: the
	 * executor then clears it itself (#clearCodingValue), on the same boot, whatever ended the run.
	 *
	 * The clipboard is a member's while they hold the desktop (20260930713000; v233 release review r1, F29 of #1661). The
	 * helper takes the desktop as an action does (#holdDesktop), so a member's action (a copy, a paste) and the clipboard
	 * read never interleave: while a member's action runs, the read is refused at once (a member holds the desktop); while
	 * an agent's runs, it waits for it (CODING_VALUE_WAIT_MS). Before the helper reads the clipboard and again after it,
	 * before the box leaves, SQL is asked what a picture is asked (#pictureAllowed, no looker): the lease generation the
	 * read saw, and no live hold. A take-over at any moment since the read drops the box whole: the outcome is
	 * DESKTOP_MEMBER_IN_CONTROL, and nothing of the box is kept or logged. What cannot be undone: a helper that had begun
	 * before the take-over may already have cleared the clipboard.
	 */
	async codingValue(run: CompanyMachineCodingValue, signal: AbortSignal): Promise<CompanyMachineCodingValueOutcome> {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_CODING_VALUE_UNAVAILABLE");
		if (
			![run.placementId, run.bootId, run.receiptId].every((id) => UUID_PATTERN.test(id)) ||
			!Number.isSafeInteger(run.desktopGeneration) ||
			run.desktopGeneration < 0
		)
			throw new Error("COMPANY_MACHINE_CODING_VALUE_INVALID");
		if (!this.#holdDesktop(run.placementId)) {
			// Busy: a member's action holds it (a member holds the desktop: refused now), or an agent's (waited for).
			if (!(await this.#pictureAllowed(run.placementId, run.desktopGeneration, null, signal)))
				return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
			if (!(await this.#holdDesktopWithin(run.placementId, CODING_VALUE_WAIT_MS, signal)))
				throw new Error("COMPANY_MACHINE_CODING_VALUE_BUSY");
		}
		let ended = true;
		try {
			// Before anything is read off the clipboard.
			if (!(await this.#pictureAllowed(run.placementId, run.desktopGeneration, null, signal)))
				return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
			ended = false;
			let clean = false;
			try {
				const outcome = await this.#runCodingValue(pipe, run, signal);
				clean = true;
				// After it, before the box leaves.
				if ("box" in outcome && !(await this.#pictureAllowed(run.placementId, run.desktopGeneration, null, signal)))
					return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
				return outcome;
			} finally {
				if (!clean) await this.#clearCodingValue(pipe, run);
				ended = clean;
			}
		} finally {
			this.#releaseDesktop(run.placementId, ended);
		}
	}
	/** One run of the helper and its answer. Another boot (exit 97) and an earlier image (98) never ran it. */
	async #runCodingValue(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		run: CompanyMachineCodingValue,
		signal: AbortSignal,
	): Promise<CompanyMachineCodingValueOutcome> {
		const result = await withTimeoutScope(signal, this.#options.codingValueTimeoutMs ?? CODING_VALUE_MS, (checked) =>
			pipe(
				this.#policy.project,
				lxdCompanyMachineName(run.placementId),
				{
					command: [
						"/bin/sh",
						"-c",
						CODING_VALUE_ON_BOOT,
						run.bootId,
						"/usr/bin/node",
						COMPANY_MACHINE_CODING_VALUE_HELPER,
					],
					environment: {},
					cwd: "/",
					stdin: Buffer.from(JSON.stringify(run.target), "utf8"),
					maxStdoutBytes: CODING_VALUE_OUTPUT_BYTES,
					stderrTailBytes: 0,
				},
				checked,
			),
		);
		if (result.exitCode === 97) return { refused: "MACHINE_BOOT_CHANGED" };
		if (result.exitCode === 98) return { refused: "MACHINE_IMAGE_WITHOUT_CODING_VALUES" };
		if (result.exitCode !== 0) throw new Error("COMPANY_MACHINE_CODING_VALUE_FAILED");
		let output: Record<string, unknown>;
		try {
			output = machineRecord(
				JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(result.stdout)),
				"COMPANY_MACHINE_CODING_VALUE_INVALID",
			);
		} catch {
			throw new Error("COMPANY_MACHINE_CODING_VALUE_INVALID");
		}
		const keys = Object.keys(output).sort().join();
		if (output.schema === "qorpera.machine-coding-value-refusal/v1" && keys === "code,schema") {
			if (typeof output.code !== "string" || !/^[A-Z][A-Z0-9_]{2,60}$/.test(output.code))
				throw new Error("COMPANY_MACHINE_CODING_VALUE_INVALID");
			return { refused: output.code };
		}
		const box = output.box;
		if (
			output.schema !== "qorpera.machine-coding-value-box/v1" ||
			keys !== "box,schema" ||
			!box ||
			typeof box !== "object" ||
			Array.isArray(box) ||
			Object.keys(box).sort().join() !== "ciphertext,ephemeralPublicKey,iv,schema,tag" ||
			Object.values(box).some((part) => typeof part !== "string" || !/^[A-Za-z0-9_./-]{1,8192}$/.test(part))
		)
			throw new Error("COMPANY_MACHINE_CODING_VALUE_INVALID");
		return { box: Object.freeze({ ...(box as Record<string, string>) }) };
	}
	/** The executor's own clear of the machine's clipboard and primary selection after a save that did not end cleanly, or
	 * a member's pasted text (20260930713000): the same packaged helper with `--clear-only`, on the run's boot only
	 * (another boot's clipboard went with it: exit 97, nothing to do), under its own deadline and never the request's
	 * signal. It never throws; a failure is logged as a fixed word alone (`failed`). It confirms nothing (the helper says
	 * cleared whatever xsel did), and nothing of it is recorded: the clear owed after a member's hold is the host's own
	 * script's (#clearAndRecord). It answers what came of it: cleared as the helper says, another boot (97), an image
	 * without the helper (98), or failed. */
	async #clearCodingValue(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		run: Pick<CompanyMachineCodingValue, "placementId" | "bootId">,
		failed = "COMPANY_MACHINE_CODING_VALUE_CLEAR_FAILED",
	): Promise<"cleared" | "boot" | "image" | "failed"> {
		try {
			const cleared = await withTimeoutScope(
				undefined,
				this.#options.codingValueClearTimeoutMs ?? CODING_VALUE_CLEAR_MS,
				(checked) =>
					pipe(
						this.#policy.project,
						lxdCompanyMachineName(run.placementId),
						{
							command: [
								"/bin/sh",
								"-c",
								CODING_VALUE_ON_BOOT,
								run.bootId,
								"/usr/bin/node",
								COMPANY_MACHINE_CODING_VALUE_HELPER,
								"--clear-only",
							],
							environment: {},
							cwd: "/",
							maxStdoutBytes: 4096,
							stderrTailBytes: 0,
						},
						checked,
					),
			);
			if (cleared.exitCode === 97) return "boot";
			if (
				cleared.exitCode !== 0 ||
				new TextDecoder("utf8", { fatal: true }).decode(cleared.stdout).trim() !==
					JSON.stringify({ schema: "qorpera.machine-coding-value-cleared/v1" })
			)
				throw new Error(cleared.exitCode === 98 ? "image" : failed);
			return "cleared";
		} catch (error) {
			console.error(failed);
			return error instanceof Error && error.message === "image" ? "image" : "failed";
		}
	}

	/**
	 * After a member held a desktop, its clipboard is cleared by the platform before an agent may read a key from it (F32
	 * to F35 of #1661). The clear is owed from the hold on (SQL: desktop_clipboard_generation differs from the lease
	 * generation), and only the platform's confirmed clear lifts it. It is done at the agent's first screen call after the
	 * hold (#clearOwed, under that call's hold of the desktop, before it looks or acts); this is the backstop, when SQL
	 * answered save_coding_value `clear` with the lease generation it saw (the agent called it without a screen call
	 * since, or the clear there did not get through). It takes the desktop as an action does (#holdDesktop: a member's
	 * action meanwhile is DESKTOP_BUSY; one that runs now is refused at once, as a member holds the desktop, and an agent's
	 * action is waited for CODING_VALUE_WAIT_MS at most), then #clearAndRecord: the fence, the host's own clear script
	 * (COMPANY_MACHINE_CLIPBOARD_CLEAR, never the helper's `--clear-only`, which answers cleared whatever xsel did), and
	 * only on its success SQL's record, still holding the desktop. A fence or a record that says a member holds the
	 * desktop, or a clear that failed, records nothing (`cleared: false`): the clear stays owed. A desktop that is not
	 * running has no clipboard: the script finds no display and exits 0, and the image keeps no clipboard past its
	 * desktop's session (no clipboard manager, no saved history; measured on 91d433c0, 11 Nov 2026), so that counts as
	 * clear.
	 */
	async clearClipboard(
		run: CompanyMachineClipboardClear,
		signal: AbortSignal,
	): Promise<CompanyMachineClipboardCleared> {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_CODING_VALUE_UNAVAILABLE");
		if (
			![run.placementId, run.bootId].every((id) => UUID_PATTERN.test(id)) ||
			!Number.isSafeInteger(run.desktopGeneration) ||
			run.desktopGeneration < 0
		)
			throw new Error("COMPANY_MACHINE_CODING_VALUE_INVALID");
		if (!this.#holdDesktop(run.placementId)) {
			if (!(await this.#pictureAllowed(run.placementId, run.desktopGeneration, null, signal)))
				return { cleared: false };
			if (!(await this.#holdDesktopWithin(run.placementId, CODING_VALUE_WAIT_MS, signal)))
				throw new Error("COMPANY_MACHINE_CODING_VALUE_BUSY");
		}
		try {
			const outcome = await this.#clearAndRecord(pipe, run, signal, signal, "save");
			return outcome === "held" || outcome === "failed" ? { cleared: false } : outcome;
		} finally {
			// The clear script ends by itself within 8 s (each xsel killed at 2 s inside the machine), before its 10 s
			// deadline, so a clear cut off at that deadline leaves nothing running. A request that ends cuts it off sooner;
			// then one xsel of it may run on for 2 s at most, which clears a selection or counts its bytes and reads nothing
			// out (round 25 P1 of #1661).
			this.#releaseDesktop(run.placementId, true);
		}
	}
	/** Holding the desktop: the fence (that generation, no one holding), the host's own clear of both selections
	 * (COMPANY_MACHINE_CLIPBOARD_CLEAR), and only on its success SQL's record of that generation. `held` when the fence or
	 * the record says a member holds the desktop (round 24 N1: the caller knows it, and an action does not run), `failed`
	 * when the clear did not get through (nothing recorded either way). `limit` bounds the script (with its own deadline),
	 * and `use` sets the script's own bound inside the machine. */
	async #clearAndRecord(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		run: CompanyMachineClipboardClear,
		signal: AbortSignal,
		limit: AbortSignal,
		use: ClipboardClearUse,
	): Promise<CompanyMachineClipboardCleared | "held" | "failed"> {
		if (!(await this.#pictureAllowed(run.placementId, run.desktopGeneration, null, signal))) return "held";
		const cleared = await this.#clearSelections(pipe, run, limit, use);
		if (cleared === "boot") return { refused: "MACHINE_BOOT_CHANGED" };
		if (cleared === "image") return { refused: "MACHINE_IMAGE_WITHOUT_CODING_VALUES" };
		if (cleared === "failed") return "failed";
		const answer = machineRecord(
			await this.#call(
				"qorpera_machine_desktop_clipboard_cleared",
				{ p_placement_id: run.placementId, p_generation: run.desktopGeneration },
				signal,
			),
			"COMPANY_MACHINE_CLIPBOARD_CLEARED_INVALID",
		);
		if (answer.schema !== "qorpera.machine-desktop-clipboard/v1")
			throw new Error("COMPANY_MACHINE_CLIPBOARD_CLEARED_INVALID");
		if (answer.state === "ok") return { cleared: true };
		if (answer.state === "refused" && answer.reason === "DESKTOP_MEMBER_IN_CONTROL") return "held";
		throw new Error("COMPANY_MACHINE_CLIPBOARD_CLEARED_INVALID");
	}
	/** COMPANY_MACHINE_CLIPBOARD_CLEAR once, bounded inside the machine by `use` (each xsel 0.5 s at a screen call, 2 s at
	 * save time) and here by its own deadline (CODING_VALUE_CLEAR_MS) and `limit`: cleared (exit 0), another boot (97), an
	 * image without xsel (98), or failed (1: an xsel failed or met its bound; 2: a byte left; anything else, or cut off;
	 * logged as a fixed word alone). */
	async #clearSelections(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		run: Pick<CompanyMachineClipboardClear, "placementId" | "bootId">,
		limit: AbortSignal,
		use: ClipboardClearUse,
	): Promise<"cleared" | "boot" | "image" | "failed"> {
		try {
			const result = await withTimeoutScope(
				limit,
				this.#options.codingValueClearTimeoutMs ?? CODING_VALUE_CLEAR_MS,
				(checked) =>
					pipe(
						this.#policy.project,
						lxdCompanyMachineName(run.placementId),
						{
							command: ["/bin/sh", "-c", COMPANY_MACHINE_CLIPBOARD_CLEAR, run.bootId, use],
							environment: {},
							cwd: "/",
							maxStdoutBytes: 4096,
							stderrTailBytes: 0,
						},
						checked,
					),
			);
			if (result.exitCode === 0) return "cleared";
			if (result.exitCode === 97) return "boot";
			if (result.exitCode === 98) return "image";
		} catch {
			// Logged below.
		}
		console.error("COMPANY_MACHINE_CLIPBOARD_CLEAR_FAILED");
		return "failed";
	}
	/** An agent's screen call that owes the clear (F35 of #1661): under its hold of the desktop (an action's; a look takes
	 * the desktop for the clear alone when it is free), before it looks or acts, within SCREEN_CLEAR_MS (round 24 N2).
	 * `held` when the fence or the record says a member holds the desktop (round 24 N1): an action then does not run. Any
	 * other outcome fails nothing: a desktop someone else's action holds, a failed clear or record, a clear cut off at its
	 * limit, any error: the clear stays owed (the next screen call, or save_coding_value's own clear, does it). */
	async #clearOwed(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		run: CompanyMachineScreen,
		holding: boolean,
		signal: AbortSignal,
	): Promise<"held" | "owed" | "cleared"> {
		const took = !holding && this.#holdDesktop(run.placementId);
		if (!holding && !took) return "owed";
		try {
			return await withTimeoutScope(signal, this.#options.screenClearTimeoutMs ?? SCREEN_CLEAR_MS, async (limit) => {
				const outcome = await this.#clearAndRecord(
					pipe,
					{ placementId: run.placementId, bootId: run.bootId, desktopGeneration: run.desktopGeneration },
					limit,
					limit,
					"screen",
				);
				if (outcome === "held") return "held";
				return typeof outcome === "object" && "cleared" in outcome && outcome.cleared ? "cleared" : "owed";
			});
		} catch {
			signal.throwIfAborted();
			console.error("COMPANY_MACHINE_CLIPBOARD_CLEAR_FAILED");
			return "owed";
		} finally {
			if (took) this.#releaseDesktop(run.placementId, true);
		}
	}

	/**
	 * machine_screen (20260930708000): the image's screen helper on a machine of this node, as root, on exactly the boot
	 * SQL named, with the request on its stdin: it takes the one action (at most once per receipt on this boot), waits,
	 * and answers the screen's PNG with a header of what the action did and the windows' titles. Its stdout is read here
	 * within its bound and never logged, and its stderr is dropped; LXD records no output. It runs once: a failure is the
	 * call's, never run again.
	 *
	 * A machine with /company shows what it read there: its screen leaves as a command's output does (#command), only
	 * once the company folder released the machine's reads and the run that sees it took them in (6d-3b). Otherwise the
	 * picture and the titles stay on the machine and the answer says why (`heldBack`); the action happened all the same.
	 * Programs on the desktop run as `desktop` and cannot write /company, so the screen needs no window of its own.
	 *
	 * One action at a time per desktop (review r1 F4): while one runs, or for SCREEN_ACTION_GRACE_MS after one that did
	 * not end cleanly, another run's action is refused before the helper runs (DESKTOP_BUSY, no receipt marker made), so
	 * it can never type into a window the first one changed. A look is always served. A member's action
	 * (20260930713000, memberAct) holds the same desktop the same way.
	 *
	 * A look authorized before a member took the desktop over may capture what the member did after it, however the steps
	 * interleave: after the capture, before anything leaves, SQL is asked whether the lease generation the read saw still
	 * stands and no member holds the desktop (#pictureAllowed). If not, the outcome is DESKTOP_MEMBER_IN_CONTROL, without
	 * the picture or the titles.
	 *
	 * A call that owes the clipboard clear after a member's hold (`clearClipboard`, F35 of #1661) does it first, under its
	 * hold of the desktop, within SCREEN_CLEAR_MS (#clearOwed). If the fence or the record says a member holds the desktop
	 * again, an action does not run (DESKTOP_MEMBER_IN_CONTROL, no receipt marker made); a look goes on, and its fence
	 * after the capture refuses the picture. Any other failure of the clear fails nothing: it stays owed.
	 */
	async screen(run: CompanyMachineScreen, signal: AbortSignal): Promise<CompanyMachineScreenOutcome> {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_SCREEN_UNAVAILABLE");
		if (
			![run.placementId, run.bootId, run.runId].every((id) => UUID_PATTERN.test(id)) ||
			!Number.isSafeInteger(run.desktopGeneration) ||
			run.desktopGeneration < 0
		)
			throw new Error("COMPANY_MACHINE_SCREEN_INVALID");
		this.#seeGeneration(run.placementId, run.desktopGeneration);
		const acting = run.request.action !== null && run.request.action !== undefined;
		if (acting && !this.#holdDesktop(run.placementId)) return { refused: "DESKTOP_BUSY" };
		// An action moves the pointer fence (20260930744000, review r1 F1 of #1733): no move a member made before it moves
		// the pointer once it runs.
		if (acting) this.#moveFence(run.placementId);
		let ended = false;
		let result: Awaited<ReturnType<typeof pipe>>;
		try {
			// Before the action, and before any look while a mover runs: the desktop has confirmed the host's fence of now
			// (review r2 F1 of #1733). Nothing ran if it could not: no action, no picture, the desktop free again at once.
			try {
				await this.#confirmFence(pipe, run.placementId, run.bootId, signal);
			} catch (error) {
				ended = true;
				throw error;
			}
			// A member held the desktop since its clipboard was last confirmed clear: cleared and recorded first (F35). If the
			// fence or the record says a member holds the desktop now, an action does not run (round 24 N1: no receipt
			// marker is made yet); a look goes on, and its fence after the capture refuses the picture.
			if (run.clearClipboard === true && (await this.#clearOwed(pipe, run, acting, signal)) === "held" && acting) {
				ended = true;
				return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
			}
			result = await this.#screenHelper(pipe, run.placementId, run.bootId, run.request, signal);
			// The helper reached its own end (an answer, or one of its own exits) only then: it waits for the action's unit.
			// Any other exit (137 when it was killed inside the machine, 1 when it failed) says nothing of the unit, which
			// lives on to its limit (review r3 F4).
			ended = result.exitCode === 0 || SCREEN_EXITS[result.exitCode] !== undefined;
		} finally {
			if (acting) this.#releaseDesktop(run.placementId, ended);
		}
		const exit = SCREEN_EXITS[result.exitCode];
		if (exit !== undefined) return { refused: exit };
		if (result.exitCode !== 0) throw new Error("COMPANY_MACHINE_SCREEN_FAILED");
		const shot = screenOutput(result.stdout);
		if ("refused" in shot) return shot;
		// The fence: nothing of a screen a member took over since the read leaves, for an agent (review r1 F1).
		if (!(await this.#pictureAllowed(run.placementId, run.desktopGeneration, null, signal)))
			return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
		const folder = this.#options.folder;
		if (!folder) return shot;
		const at: FolderRelease = { placementId: run.placementId, bootId: run.bootId, runId: run.runId };
		const f = this.#folders.get(run.placementId);
		const boot = f?.bootId === run.bootId ? f : undefined;
		const heldBack =
			this.#heldAlready(at, boot) ?? (await this.#release(folder, at, boot, SCREEN_BOUNDARY_MS, signal));
		if (heldBack === undefined) return shot;
		// A title can name what a page or a file of /company holds: the titles stay with the picture. So does the action's
		// error text (review r1 F3): the guest is the agent's root, and its helper's header could carry anything there.
		// Only the verb and its exit code are told.
		const done = shot.header.action as { type?: unknown; exitCode?: unknown } | null;
		return Object.freeze({
			header: Object.freeze({
				...shot.header,
				action: done ? Object.freeze({ type: done.type, exitCode: done.exitCode }) : null,
				activeWindow: null,
				windows: Object.freeze([]),
				moreWindows: 0,
				png: 0,
			}),
			png: null,
			heldBack,
		});
	}
	/** The screen helper once, as root on exactly the boot SQL named (CODING_VALUE_ON_BOOT), with the request on its stdin;
	 * its stdout read within its bound and never logged, its stderr dropped. */
	#screenHelper(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		placementId: string,
		bootId: string,
		request: Record<string, unknown>,
		signal: AbortSignal,
	): ReturnType<NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>> {
		return withTimeoutScope(signal, this.#options.screenTimeoutMs ?? SCREEN_MS, (checked) =>
			pipe(
				this.#policy.project,
				lxdCompanyMachineName(placementId),
				{
					command: ["/bin/sh", "-c", CODING_VALUE_ON_BOOT, bootId, "/usr/bin/node", COMPANY_MACHINE_SCREEN_HELPER],
					environment: {},
					cwd: "/",
					stdin: Buffer.from(JSON.stringify(request), "utf8"),
					maxStdoutBytes: SCREEN_OUTPUT_BYTES,
					stderrTailBytes: 0,
				},
				checked,
			),
		);
	}
	/** An action takes the placement's desktop, unless one runs there or one that did not end cleanly may still act
	 * (false: DESKTOP_BUSY). */
	#holdDesktop(placementId: string): boolean {
		const now = this.#options.now ?? Date.now;
		const busy = this.#screenBusy.get(placementId);
		if (busy === "acting" || (typeof busy === "number" && busy > now())) return false;
		this.#screenBusy.set(placementId, "acting");
		return true;
	}
	/** #holdDesktop, waiting up to `ms` for the desktop to be free (save_coding_value, F29). */
	async #holdDesktopWithin(placementId: string, ms: number, signal: AbortSignal): Promise<boolean> {
		const now = this.#options.now ?? Date.now;
		const until = now() + ms;
		for (;;) {
			if (this.#holdDesktop(placementId)) return true;
			if (now() >= until) return false;
			await setTimeout(100, undefined, { signal });
		}
	}
	/** The action ended by itself: the desktop is free. Cut off (aborted, past its deadline, the exec lost, or gone before
	 * its own end): it stays busy for as long as what it started may still act. */
	#releaseDesktop(placementId: string, ended: boolean): void {
		const now = this.#options.now ?? Date.now;
		if (ended) this.#screenBusy.delete(placementId);
		else this.#screenBusy.set(placementId, now() + SCREEN_ACTION_GRACE_MS);
	}
	/** The fence after a capture (20260930713000, review r1 F1): whether SQL still lets the picture of this placement out
	 * to this looker (`userId`; null for an agent): its lease generation the one the look's read saw, and no live hold by
	 * anyone else. Asked after the capture and before anything of the screen leaves; a take-over at any moment since the
	 * read moved the generation. A refusal is false; any other failure throws (the look fails, and is asked again). */
	async #pictureAllowed(
		placementId: string,
		generation: number,
		userId: string | null,
		signal: AbortSignal,
	): Promise<boolean> {
		const answer = machineRecord(
			await this.#call(
				"qorpera_machine_desktop_picture_check",
				{ p_placement_id: placementId, p_generation: generation, p_user_id: userId },
				signal,
			),
			"COMPANY_MACHINE_PICTURE_CHECK_INVALID",
		);
		if (answer.schema !== "qorpera.machine-desktop-picture/v1")
			throw new Error("COMPANY_MACHINE_PICTURE_CHECK_INVALID");
		if (answer.state === "ok") return true;
		if (answer.state === "refused" && answer.reason === "DESKTOP_MEMBER_IN_CONTROL") return false;
		throw new Error("COMPANY_MACHINE_PICTURE_CHECK_INVALID");
	}

	/** A member turns the desktop on (20260930714000): the image's own `desktop start` on the boot SQL named, in a transient
	 * unit of its own. Never refused because the desktop is busy (it takes the desktop's own lock, and an agent's action
	 * does not), and nothing is held: starting is not taking over. */
	async memberStart(start: CompanyMachineMemberStart, signal: AbortSignal): Promise<CompanyMachineMemberStartOutcome> {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_MEMBER_START_UNAVAILABLE");
		if (
			![start.placementId, start.bootId, start.startId].every((id) => UUID_PATTERN.test(id)) ||
			(start.open !== undefined && !memberOpenPathValid(start.open))
		)
			throw new Error("COMPANY_MACHINE_MEMBER_START_INVALID");
		let exitCode: number;
		try {
			exitCode = (
				await withTimeoutScope(signal, this.#options.memberStartTimeoutMs ?? MEMBER_START_MS, (checked) =>
					pipe(
						this.#policy.project,
						lxdCompanyMachineName(start.placementId),
						{
							command: companyMachineMemberStartCommand(start.bootId),
							environment: {},
							cwd: "/",
							maxStdoutBytes: 4096,
							stderrTailBytes: 0,
						},
						checked,
					),
				)
			).exitCode;
		} catch {
			signal.throwIfAborted();
			// Not answered in time: the unit ends at its own limit, and a desktop it started runs on.
			return { refused: "DESKTOP_DID_NOT_START" };
		}
		const started = MEMBER_START_EXITS[exitCode] ?? { refused: "DESKTOP_DID_NOT_START" };
		if (start.open === undefined || "refused" in started) return started;
		// The desktop runs. What the member chose opens on it (20260930758000), and an open is a member's action on the
		// desktop (review r1 F1 of #1781): right before it touches the desktop it passes what a member's click passes on
		// this host and in SQL. The one-actor rule (#holdDesktop, its grace as it stands: an agent's action or a member's
		// on its way is waited for a moment, else DESKTOP_BUSY), the pointer's fence as a click moves and confirms it, and
		// SQL's decision now, under the machine's lock (qorpera_member_machine_desktop_open_check, once): no other member
		// types privately and none did since the open was begun, the member may still act and still reads the path. Else
		// nothing opens, and the desktop the start started stays on.
		if (!(await this.#holdDesktopWithin(start.placementId, MEMBER_OPEN_WAIT_MS, signal)))
			return { refused: "DESKTOP_BUSY" };
		this.#moveFence(start.placementId);
		let checked: string;
		try {
			checked = await this.#openAllowed(start, signal);
			if (checked === "ok") await this.#confirmFence(pipe, start.placementId, start.bootId, signal);
		} catch (error) {
			this.#releaseDesktop(start.placementId, true);
			throw error;
		}
		if (checked !== "ok") {
			this.#releaseDesktop(start.placementId, true);
			return { refused: checked };
		}
		const openPath = start.open;
		let ended = false;
		try {
			exitCode = (
				await withTimeoutScope(signal, this.#options.memberOpenTimeoutMs ?? MEMBER_OPEN_MS, (checked) =>
					pipe(
						this.#policy.project,
						lxdCompanyMachineName(start.placementId),
						{
							command: companyMachineMemberOpenCommand(start.bootId),
							environment: {},
							cwd: "/",
							stdin: Buffer.from(openPath, "utf8"),
							maxStdoutBytes: 4096,
							stderrTailBytes: 0,
						},
						checked,
					),
				)
			).exitCode;
			// systemd-run answered: its unit ended (by itself, or at its limit) with everything in it.
			ended = exitCode < 128;
		} catch {
			signal.throwIfAborted();
			return { refused: "DESKTOP_DID_NOT_OPEN" };
		} finally {
			// What it opened gets a moment to show before the next action (its window takes the focus as it maps); a unit
			// that did not answer keeps the desktop for the grace, as a member's action that did not end cleanly does.
			const now = this.#options.now ?? Date.now;
			this.#screenBusy.set(start.placementId, now() + (ended ? MEMBER_OPEN_SETTLE_MS : SCREEN_ACTION_GRACE_MS));
		}
		return MEMBER_OPEN_EXITS[exitCode] ?? { refused: "DESKTOP_DID_NOT_OPEN" };
	}

	/** SQL's decision right before an open touches the desktop (20260930758000, review r1 F1 of #1781): "ok", or why not. */
	async #openAllowed(start: CompanyMachineMemberStart, signal: AbortSignal): Promise<string> {
		const answer = machineRecord(
			await this.#call(
				"qorpera_member_machine_desktop_open_check",
				{ p_start_id: start.startId, p_placement_id: start.placementId, p_boot_id: start.bootId },
				signal,
			),
			"COMPANY_MACHINE_OPEN_CHECK_INVALID",
		);
		if (answer.schema !== "qorpera.member-machine-desktop-open-check/v1")
			throw new Error("COMPANY_MACHINE_OPEN_CHECK_INVALID");
		if (answer.state === "ok" && Object.keys(answer).length === 2) return "ok";
		if (
			answer.state === "refused" &&
			typeof answer.reason === "string" &&
			[
				"DESKTOP_MEMBER_IN_CONTROL",
				"DESKTOP_OPEN_NOT_FOUND",
				"MACHINE_NOT_RUNNING",
				"MACHINE_BOOT_CHANGED",
			].includes(answer.reason)
		)
			return answer.reason;
		throw new Error("COMPANY_MACHINE_OPEN_CHECK_INVALID");
	}

	/**
	 * A member's action on a desktop of this node (20260930713000): the member's click, drag, scroll or keys through the
	 * image's screen helper, as an agent's machine_screen action runs (the action id is its receipt, so it runs at most
	 * once on this boot; its transient unit's deadline and the xdotool word check apply), with no settle and no look: the
	 * member's window looks again itself (memberLook), so nothing of the screen, no title and no error text comes back
	 * here. A typed text never goes through the helper, whose unit's description (the command line, the text in it) systemd
	 * writes to the machine's journal: COMPANY_MACHINE_MEMBER_TYPE types it from its stdin, in a transient unit of its own
	 * with a deadline systemd keeps (companyMachineMemberTypeCommand). After a text the desktop pasted (beyond plain ASCII,
	 * on both selections), both selections are cleared before the desktop is let go.
	 *
	 * It holds the desktop as an agent's action does (#holdDesktop: one action at a time, and the grace after one that
	 * did not end cleanly). An agent's look that overlapped it never shows it: the fence after each capture
	 * (#pictureAllowed) refuses every picture once a member took the desktop over.
	 */
	async memberAct(act: CompanyMachineMemberAct, signal: AbortSignal): Promise<CompanyMachineMemberActOutcome> {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_MEMBER_ACT_UNAVAILABLE");
		const verb = act.action?.type;
		const text = act.action?.text;
		const shared = act.shared === true;
		if (
			![act.placementId, act.bootId, act.actionId, act.userId].every((id) => UUID_PATTERN.test(id)) ||
			(act.shared !== undefined && typeof act.shared !== "boolean") ||
			!Number.isSafeInteger(act.seat) ||
			act.seat < (shared ? 0 : 1) ||
			typeof verb !== "string" ||
			!SCREEN_VERBS.includes(verb) ||
			verb === "open" ||
			(verb === "type") !== (typeof text === "string") ||
			(typeof text === "string" && (text.length === 0 || [...text].length > 500))
		)
			throw new Error("COMPANY_MACHINE_MEMBER_ACT_INVALID");
		this.#seeGeneration(act.placementId, act.seat);
		const pasted = typeof text === "string" && PASTED.test(text);
		if (!this.#holdDesktop(act.placementId)) return { refused: "DESKTOP_BUSY" };
		// The action moves the pointer fence (20260930744000, review r1 F1 of #1733).
		this.#moveFence(act.placementId);
		// Holding the desktop, the action's seat is asked again (round 23 of #1661): an action authorized before a hand-back
		// never runs after it, nor after a clear of the clipboard recorded since. A shared one (20260930734000) is asked as
		// an agent's action is, with no member: the generation it was begun at must stand and no one may hold the desktop
		// privately, so a take-over since stops it here. Nothing ran: the desktop is free again.
		let seated: boolean;
		try {
			seated = await this.#pictureAllowed(act.placementId, act.seat, shared ? null : act.userId, signal);
		} catch (error) {
			this.#releaseDesktop(act.placementId, true);
			throw error;
		}
		if (!seated) {
			this.#releaseDesktop(act.placementId, true);
			return { refused: shared ? "DESKTOP_MEMBER_IN_CONTROL" : "DESKTOP_CONTROL_ENDED" };
		}
		// No move a member made before it may move the pointer once it runs: the desktop has the fence first. Nothing ran
		// if that failed: the desktop is free again.
		try {
			await this.#confirmFence(pipe, act.placementId, act.bootId, signal);
		} catch (error) {
			this.#releaseDesktop(act.placementId, true);
			throw error;
		}
		let ended = false;
		try {
			if (typeof text === "string") {
				const began = Date.now();
				const typed = await withTimeoutScope(
					signal,
					this.#options.memberTypeTimeoutMs ?? MEMBER_TYPE_MS,
					(checked) =>
						pipe(
							this.#policy.project,
							lxdCompanyMachineName(act.placementId),
							{
								command: companyMachineMemberTypeCommand(act.bootId, pasted ? "paste" : "type"),
								environment: {},
								cwd: "/",
								stdin: Buffer.from(text, "utf8"),
								maxStdoutBytes: 4096,
								stderrTailBytes: 0,
							},
							checked,
						),
				);
				// systemd-run answered: it waited for its unit, which ended (by itself, or killed at its limit) with
				// everything it started. Killed itself (a signal's exit), it says nothing of the unit, which runs on to its
				// limit: the desktop stays busy for the grace.
				ended = typed.exitCode < 128;
				const refused = MEMBER_TYPE_EXITS[typed.exitCode];
				if (refused !== undefined) return { refused };
				if (typed.exitCode === 0) return { done: { exitCode: 0 } };
				// 1: xdotool or xsel failed, or the unit was killed at its limit (systemd-run answers 1 for both: one that
				// ended at its limit is told as cut off); anything else: cut off, the text maybe typed in part.
				const atLimit = Date.now() - began >= MEMBER_TYPE_UNIT_SECONDS * 1000;
				return { done: { exitCode: typed.exitCode === 1 && !atLimit ? 1 : null } };
			}
			const result = await this.#screenHelper(
				pipe,
				act.placementId,
				act.bootId,
				{
					schema: "qorpera.machine-screen-request/v1",
					receiptId: act.actionId,
					action: act.action,
					settleMs: 0,
					look: false,
				},
				signal,
			);
			ended = result.exitCode === 0 || SCREEN_EXITS[result.exitCode] !== undefined;
			const exit = SCREEN_EXITS[result.exitCode];
			if (exit !== undefined) return { refused: exit };
			if (result.exitCode !== 0) throw new Error("COMPANY_MACHINE_MEMBER_ACT_FAILED");
			const shot = screenOutput(result.stdout);
			if ("refused" in shot) return { refused: shot.refused };
			const done = shot.header.action as { type?: unknown; exitCode?: unknown } | null;
			if (!done || done.type !== verb) throw new Error("COMPANY_MACHINE_MEMBER_ACT_INVALID");
			return { done: { exitCode: done.exitCode as number | null } };
		} finally {
			try {
				// The desktop pasted the text: neither selection keeps it (the selection's owner, xsel, holds it until then).
				if (pasted) await this.#clearCodingValue(pipe, act, "COMPANY_MACHINE_MEMBER_TEXT_CLEAR_FAILED");
			} finally {
				this.#releaseDesktop(act.placementId, ended);
			}
		}
	}

	/**
	 * A member's live picture of a desktop of this node (20260930745000): streams the desktop's changed areas to `sink`
	 * until `signal` aborts (the member's stream ended at the executor that took it), a release cycle ends it, or the
	 * desktop's relay ends (the X server, the boot). Answers why it ended.
	 *
	 * Every member watching a desktop shares its one relay (COMPANY_MACHINE_DESKTOP_VIEW: the machine's own VNC server,
	 * through which nothing but the handshake, the pixel format, the encodings and update requests can pass: it only
	 * shows). Each member's changes are let go by that member's own release cycles: what changed before a cycle began
	 * leaves once the cycle passed, as every look's picture passes today (#streamCycle): the pointer fence confirmed on
	 * the desktop while a mover is around (no picture while an older move could still run), the company folder's boundary
	 * when the boot has /company, and SQL's one read (qorpera_member_machine_stream_release: the member may still act,
	 * the machine runs on this boot, the take-over fence of the stream's hold, the disk's root rule and the member's own
	 * read check of what the machine read). A refusal there ends the stream with its reason; a boundary not answered holds
	 * the changes for the next cycle.
	 */
	async memberStream(
		stream: CompanyMachineMemberStream,
		sink: DesktopStreamSink,
		signal: AbortSignal,
	): Promise<string> {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_MEMBER_STREAM_UNAVAILABLE");
		if (
			![stream.placementId, stream.bootId, stream.userId].every((id) => UUID_PATTERN.test(id)) ||
			!Number.isSafeInteger(stream.generation) ||
			stream.generation < 0 ||
			!(stream.epoch === null || (Number.isSafeInteger(stream.epoch) && stream.epoch >= 0))
		)
			throw new Error("COMPANY_MACHINE_MEMBER_STREAM_INVALID");
		this.#seeGeneration(stream.placementId, stream.generation);
		const desktops = this.#options.desktopStreams;
		// No instance to watch it in: refused, never read in the executor.
		if (!desktops) return "STREAM_UNAVAILABLE";
		// Paced on a monotonic clock: a wall clock stepped back must not hold a start for the hour it went back.
		const now = () => performance.now();
		let kept = this.#streams.get(stream.placementId);
		while (!kept || kept.bootId !== stream.bootId || kept.stream.ended) {
			// A desktop not watched yet, past the node's cap of watched desktops: refused, the window keeps its pictures.
			let live = 0;
			for (const [placementId, entry] of this.#streams)
				if (placementId !== stream.placementId && !entry.stream.ended) live++;
			if (live >= MAX_WATCHED_DESKTOPS) return "STREAM_BUSY";
			// Its start waits its turn (DESKTOP_START_GAP_MS, NODE_START_GAP_MS), then everything is looked at again.
			const at = Math.max(this.#streamStarts.get(stream.placementId) ?? 0, this.#nodeStreamStart);
			if (at > now()) {
				await waitOrAbort(at - now(), signal);
				if (signal.aborted) return "closed";
				kept = this.#streams.get(stream.placementId);
				continue;
			}
			for (const [placementId, until] of this.#streamStarts)
				if (until <= now()) this.#streamStarts.delete(placementId);
			this.#streamStarts.set(stream.placementId, now() + (this.#options.desktopStartGapMs ?? DESKTOP_START_GAP_MS));
			this.#nodeStreamStart = now() + (this.#options.nodeStartGapMs ?? NODE_START_GAP_MS);
			const placementId = stream.placementId;
			const bootId = stream.bootId;
			const desktop: WatchedDesktop = desktops(
				{
					project: this.#policy.project,
					name: lxdCompanyMachineName(placementId),
					command: ["/bin/sh", "-c", COMPANY_MACHINE_DESKTOP_VIEW, bootId, COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM],
					maxStdoutBytes: MEMBER_STREAM_MESSAGE_BYTES,
				},
				() => {
					if (this.#streams.get(placementId)?.stream === desktop) this.#streams.delete(placementId);
				},
			);
			const superseded = this.#streams.get(placementId);
			const currentBoot = this.#guests.get(placementId)?.bootId ?? this.#folders.get(placementId)?.bootId;
			if (superseded && superseded.stream !== desktop && !superseded.stream.ended) {
				if (currentBoot !== undefined && superseded.bootId === currentBoot && bootId !== currentBoot) {
					// WHY: A stale-boot reconnect must not displace or close the live relay for the current boot.
					try {
						return await desktop.watch(
							(cycleSignal) => this.#streamCycle(pipe, stream, cycleSignal),
							sink,
							signal,
						);
					} finally {
						desktop.close?.();
					}
				}
				if (currentBoot !== undefined && bootId === currentBoot) superseded.stream.close?.();
			}
			kept = { bootId, stream: desktop };
			this.#streams.set(placementId, kept);
		}
		return kept.stream.watch((cycleSignal) => this.#streamCycle(pipe, stream, cycleSignal), sink, signal);
	}
	/** One release cycle of a member's live picture (memberStream). */
	async #streamCycle(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		stream: CompanyMachineMemberStream,
		signal: AbortSignal,
	): ReturnType<DesktopStreamRelease> {
		// No picture while an older move could still run (as a look: review r2 and r3 of #1733).
		await this.#confirmFence(pipe, stream.placementId, stream.bootId, signal);
		const asked = async (): Promise<"ok" | { readonly end: string }> => {
			try {
				const answer = machineRecord(
					await this.#call(
						"qorpera_member_machine_stream_release",
						{
							p_placement_id: stream.placementId,
							p_boot_id: stream.bootId,
							p_user_id: stream.userId,
							p_generation: stream.generation,
							p_epoch: stream.epoch,
						},
						signal,
					),
					"COMPANY_MACHINE_MEMBER_STREAM_INVALID",
				);
				if (answer.schema !== "qorpera.member-machine-stream-release/v1")
					throw new Error("COMPANY_MACHINE_MEMBER_STREAM_INVALID");
				if (answer.state === "ok") return "ok";
				if (answer.state === "refused" && typeof answer.reason === "string" && /^[A-Z_]{1,64}$/.test(answer.reason))
					return { end: answer.reason };
				throw new Error("COMPANY_MACHINE_MEMBER_STREAM_INVALID");
			} catch (error) {
				// A read of the machine's the member may not read: this member's stream ends, nothing else.
				if (error instanceof CodingControlRefused && error.detail === MEMBER_UNREADABLE)
					return { end: "MEMBER_CANNOT_READ" };
				throw error;
			}
		};
		const folder = this.#options.folder;
		if (!folder) return asked();
		const at: FolderRelease = { placementId: stream.placementId, bootId: stream.bootId };
		const f = this.#folders.get(stream.placementId);
		const boot = f?.bootId === stream.bootId ? f : undefined;
		// A boot whose folder ended, or that read something no longer readable, shows nothing more.
		if (this.#heldAlready(at, boot) !== undefined) return { end: "DESKTOP_NOT_SHOWN" };
		let verdict: "ok" | { readonly end: string } = "ok";
		const held = await this.#release(folder, at, boot, SCREEN_BOUNDARY_MS, signal, async () => {
			verdict = await asked();
			return verdict === "ok" ? undefined : HELD.untaken;
		});
		if (verdict !== "ok") return verdict;
		if (held === undefined) return "ok";
		if (held === HELD.ended || held === HELD.unreadable) return { end: "DESKTOP_NOT_SHOWN" };
		return "pending";
	}

	/**
	 * A member's pointer move on a desktop of this node (20260930744000), on the pass SQL gave. It answers at once and
	 * waits for nothing: the position goes to the desktop's mover (one held-open X connection per desktop while a member's
	 * pointer moves, COMPANY_MACHINE_MEMBER_POINTER), replacing a position not given yet, so a move never waits behind a
	 * move. No receipt, no run-once marker, no SQL and no log line.
	 *
	 * Refused once this host saw a newer lease generation than the pass's (a take-over since, which every look, action and
	 * pass it serves tells it: the private holder's own window looks before it can type). Dropped, never queued, while an
	 * action holds the desktop (#screenBusy: an agent's or a member's, and the grace after one that did not end cleanly). A
	 * move taken before an action or a newer generation and still waiting anywhere on its way (here, in the pipe, in the
	 * program's stdin) never moves the pointer after either: it carries the fence of the moment it was taken, and the
	 * desktop's fence has moved before the action runs and before the newer holder's look (COMPANY_MACHINE_MEMBER_POINTER,
	 * review r1 F1 and F2 of #1733). A move is never an action: it holds nothing, so it delays no action and is never
	 * refused DESKTOP_BUSY. Its answer (moved) means it was taken in that order: an action the member sends after it comes
	 * after it.
	 */
	memberPointer(move: CompanyMachineMemberPointer): CompanyMachineMemberPointerOutcome {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_MEMBER_POINTER_UNAVAILABLE");
		if (
			![move.placementId, move.bootId, move.userId].every((id) => UUID_PATTERN.test(id)) ||
			!Number.isSafeInteger(move.generation) ||
			move.generation < 0 ||
			typeof move.private !== "boolean" ||
			![move.x, move.y].every((value) => Number.isInteger(value) && value >= 0) ||
			move.x > SCREEN_MAX_WIDTH - 1 ||
			move.y > SCREEN_MAX_HEIGHT - 1
		)
			throw new Error("COMPANY_MACHINE_MEMBER_POINTER_INVALID");
		// A pass that shows a newer generation: the mover of the older one is stopped, and the next starts with the new fence.
		if (this.#seeGeneration(move.placementId, move.generation)) this.#movers.get(move.placementId)?.stop.abort();
		if ((this.#generations.get(move.placementId) ?? 0) > move.generation)
			return { refused: move.private ? "DESKTOP_CONTROL_ENDED" : "DESKTOP_HELD_SINCE" };
		const now = this.#options.now ?? Date.now;
		const failed = this.#moverFailed.get(move.placementId);
		if (failed?.bootId === move.bootId && now() - failed.at < MEMBER_POINTER_FAILED_MS)
			return { refused: failed.refused };
		// The member is at the desktop: their own looks show no drawn pointer.
		let users = this.#pointerUsers.get(move.placementId);
		if (!users) {
			users = new Map();
			this.#pointerUsers.set(move.placementId, users);
		}
		users.set(move.userId, now());
		if (this.#acting(move.placementId)) return { moved: false };
		let mover = this.#movers.get(move.placementId);
		if (mover && (mover.bootId !== move.bootId || mover.stop.signal.aborted)) {
			mover.stop.abort();
			this.#movers.delete(move.placementId);
			mover = undefined;
		}
		mover ??= this.#startMover(pipe, move.placementId, move.bootId);
		// Stamped with the fence and the generation of now: an action or a newer generation since drops it, wherever it waits.
		mover.pending = { x: move.x, y: move.y, fence: this.#fence(move.placementId), generation: move.generation };
		mover.wake();
		return { moved: true };
	}
	/** Whether an action holds the placement's desktop now, or one that did not end cleanly may still act. */
	#acting(placementId: string): boolean {
		const now = this.#options.now ?? Date.now;
		const busy = this.#screenBusy.get(placementId);
		return busy === "acting" || (typeof busy === "number" && busy > now());
	}
	/** The newest lease generation of a placement this host saw; true when this one is newer than any before (the pointer
	 * fence moves then). */
	#seeGeneration(placementId: string, generation: number): boolean {
		const seen = this.#generations.get(placementId);
		if (seen !== undefined && generation <= seen) return false;
		this.#generations.set(placementId, generation);
		if (seen === undefined) return false;
		this.#moveFence(placementId);
		return true;
	}
	/** The placement's pointer fence now (`NONCE:COUNT`). */
	#fence(placementId: string): string {
		return `${this.#fenceNonce}:${this.#fenceCounts.get(placementId) ?? 0}`;
	}
	/** The pointer fence moves: every move taken before now is stale. */
	#moveFence(placementId: string): void {
		this.#fenceCounts.set(placementId, (this.#fenceCounts.get(placementId) ?? 0) + 1);
	}
	/**
	 * Makes sure the desktop has CONFIRMED the placement's fence of now before the caller goes on (an action runs, a picture
	 * is taken, a mover starts; review r2 F1 and r3 F1 of #1733), and answers what it confirmed (its incarnation too). A
	 * look or an action needs it only while a mover runs there or ended within POINTER_FENCE_AFTER_MOVER_MS (otherwise no
	 * move can be waiting anywhere: null); a mover's start (`fresh`) always writes, so the incarnation it is bound to is
	 * the desktop's of the moment before.
	 *
	 * Observed is not confirmed: #seeGeneration and #moveFence move the fence at once, and only the fence script's own
	 * answer marks what the desktop holds (#fencePublished). One write at a time per placement: a caller that finds one on
	 * its way waits for it and then looks again (the fence may have moved meanwhile, or that write failed: it then writes
	 * itself). A write of its own that fails throws: the caller runs nothing and shows nothing, and the next caller writes
	 * again. Another boot (97) is no confirmation: the caller's own exec meets the same boot change.
	 */
	async #confirmFence(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		placementId: string,
		bootId: string,
		signal: AbortSignal,
		fresh = false,
	): Promise<PointerFence | null> {
		const now = this.#options.now ?? Date.now;
		let wrote = false;
		for (let round = 0; ; round++) {
			const ended = this.#moverEnded.get(placementId);
			if (
				!fresh &&
				!this.#movers.has(placementId) &&
				(ended === undefined || now() - ended > POINTER_FENCE_AFTER_MOVER_MS)
			)
				return null;
			const fence = this.#fence(placementId);
			const published = this.#fencePublished.get(placementId);
			if (published?.bootId === bootId && published.fence === fence && (!fresh || wrote)) return published;
			// The fence keeps moving under us (actions, generations): never endlessly.
			if (round >= POINTER_FENCE_ROUNDS) throw new Error("COMPANY_MACHINE_POINTER_FENCE_FAILED");
			const writing = this.#fenceWrites.get(placementId);
			if (writing) {
				await writing.catch(() => undefined);
				signal.throwIfAborted();
				continue;
			}
			const write = this.#writeFence(pipe, placementId, bootId, fence, signal).then((held) => {
				if (held) this.#fencePublished.set(placementId, held);
				else this.#fencePublished.delete(placementId);
			});
			this.#fenceWrites.set(placementId, write);
			try {
				await write;
			} finally {
				if (this.#fenceWrites.get(placementId) === write) this.#fenceWrites.delete(placementId);
			}
			wrote = true;
			// Another boot: nothing here to confirm, and nothing of this boot can move.
			if (!this.#fencePublished.has(placementId)) return null;
		}
	}
	/** Writes `fence` on the desktop (COMPANY_MACHINE_POINTER_FENCE) and answers what the desktop holds now (the fence,
	 * or a newer one, with its incarnation); null on another boot (97). Anything else, or an answer that is not exactly
	 * `FENCE INCARNATION`, throws. */
	async #writeFence(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		placementId: string,
		bootId: string,
		fence: string,
		signal: AbortSignal,
	): Promise<PointerFence | null> {
		const written = await withTimeoutScope(signal, POINTER_FENCE_MS, (checked) =>
			pipe(
				this.#policy.project,
				lxdCompanyMachineName(placementId),
				{
					command: ["/bin/sh", "-c", COMPANY_MACHINE_POINTER_FENCE, bootId, fence],
					environment: {},
					cwd: "/",
					maxStdoutBytes: 128,
					stderrTailBytes: 0,
				},
				checked,
			),
		);
		if (written.exitCode === 97) return null;
		const held = /^([0-9a-f]{16}:[0-9]{1,15}) ([0-9a-f]{32}|none)$/.exec(
			Buffer.from(written.stdout).toString("ascii"),
		);
		if (written.exitCode !== 0 || !held) throw new Error("COMPANY_MACHINE_POINTER_FENCE_FAILED");
		return { bootId, fence: held[1] as string, incarnation: held[2] as string };
	}
	/** Whether this member's own pointer moved the desktop lately (their looks are plain). */
	#movesPointer(placementId: string, userId: string): boolean {
		const now = this.#options.now ?? Date.now;
		const at = this.#pointerUsers.get(placementId)?.get(userId);
		return at !== undefined && now() - at < MEMBER_POINTER_PLAIN_MS;
	}
	/** Starts a desktop's mover: first the desktop's fence, written fresh (the mover is bound to the incarnation the desktop
	 * has right then: review r3 F1 of #1733), then the program; its stdin gives the newest position each time the program
	 * has read the last one, and nothing while an action holds the desktop; it ends after MEMBER_POINTER_IDLE_MS without a
	 * move. A fence that cannot be written, a desktop that is not running, or a program that ended on its own first check
	 * (96) refuse moves for MEMBER_POINTER_FAILED_MS; one that ended on a later check (94: a stale line, another
	 * incarnation) only makes what the desktop holds unconfirmed, and the next move starts another. */
	#startMover(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		placementId: string,
		bootId: string,
	): PointerMover {
		const mover: PointerMover = { bootId, stop: new AbortController(), pending: null, wake: () => {} };
		this.#movers.set(placementId, mover);
		// A move goes only while it is current: no action holds the desktop, the fence has not moved since it was taken (an
		// action, a newer generation) and no newer generation was seen; else it is dropped, never kept for after.
		const current = (next: NonNullable<PointerMover["pending"]>) =>
			!this.#acting(placementId) &&
			next.fence === this.#fence(placementId) &&
			next.generation >= (this.#generations.get(placementId) ?? 0);
		async function* positions(): AsyncGenerator<Uint8Array> {
			while (!mover.stop.signal.aborted) {
				const next = mover.pending;
				if (next) {
					mover.pending = null;
					if (current(next)) yield Buffer.from(`${next.x} ${next.y} ${next.fence}\n`, "ascii");
					continue;
				}
				const idle = await new Promise<boolean>((resolve) => {
					const stopped = () => {
						globalThis.clearTimeout(timer);
						resolve(true);
					};
					// The timers' own (this module's setTimeout is the promise one).
					const timer = globalThis.setTimeout(() => {
						mover.stop.signal.removeEventListener("abort", stopped);
						resolve(true);
					}, MEMBER_POINTER_IDLE_MS);
					timer.unref?.();
					mover.stop.signal.addEventListener("abort", stopped, { once: true });
					mover.wake = () => {
						globalThis.clearTimeout(timer);
						mover.stop.signal.removeEventListener("abort", stopped);
						resolve(false);
					};
				});
				mover.wake = () => {};
				if (idle) return;
			}
		}
		const now = this.#options.now ?? Date.now;
		const fail = (refused: "DESKTOP_NOT_RUNNING" | "MACHINE_BOOT_CHANGED" | "MACHINE_IMAGE_WITHOUT_SCREEN") =>
			this.#moverFailed.set(placementId, { bootId, refused, at: now() });
		void (async () => {
			const fence = await this.#confirmFence(pipe, placementId, bootId, mover.stop.signal, true);
			if (!fence) return fail("MACHINE_BOOT_CHANGED");
			if (fence.incarnation === "none") return fail("DESKTOP_NOT_RUNNING");
			mover.stop.signal.throwIfAborted();
			const result = await pipe(
				this.#policy.project,
				lxdCompanyMachineName(placementId),
				{
					command: [
						"/bin/sh",
						"-c",
						COMPANY_MACHINE_MEMBER_POINTER,
						bootId,
						COMPANY_MACHINE_MEMBER_POINTER_PROGRAM,
						fence.incarnation,
					],
					environment: {},
					cwd: "/",
					stdin: positions(),
					maxStdoutBytes: 64,
					stderrTailBytes: 0,
				},
				mover.stop.signal,
			);
			const refused = MEMBER_POINTER_EXITS[result.exitCode];
			if (refused) fail(refused);
			// It ended on a check of its own: what the desktop holds is asked again before anything counts on it.
			if (result.exitCode === 94 || result.exitCode === 96) this.#fencePublished.delete(placementId);
		})()
			.catch(() => {
				// The fence could not be written (or the exec failed): no mover now, and none for a moment.
				if (!mover.stop.signal.aborted) fail("DESKTOP_NOT_RUNNING");
			})
			.finally(() => {
				mover.stop.abort();
				this.#moverEnded.set(placementId, now());
				if (this.#movers.get(placementId) === mover) this.#movers.delete(placementId);
			});
		return mover;
	}

	/**
	 * A member's look at a desktop on this node (20260930712000): COMPANY_MACHINE_MEMBER_LOOK as root on exactly the boot
	 * SQL named, with no helper of the image and nothing on stdin. Its stdout (the PNG) is read within its bound and never
	 * logged, its stderr dropped; LXD records no output. It acts on nothing and starts nothing: a desktop that is off
	 * stays off. A look is never held up by an agent's action in flight (#screenBusy): a picture changes nothing.
	 *
	 * A machine with /company releases the picture as an agent's (#release): a boundary first, then, in place of a run's
	 * take-in, the member's own read check (qorpera_folder_member_machine_reads): every read the machine's newest view
	 * holds must be the member's to read now. A refusal there is the member's alone (`hidden`): unlike a run's take-in it
	 * marks nothing of the boot, and the machine goes on. Anything else that holds the picture is `pending`. A held look
	 * tells nothing of the picture: no bytes, no size, no etag.
	 *
	 * The machine's idle measure counts the desktop's own work, not this exec (lxd-agent.service is the machine's own
	 * unit): a look a second costs the X server about 3 % of one core and Xvnc about 6 KiB (measured 10 Nov 2026), under
	 * the busy marks (5 % of a core, 512 KiB per 30 s) but close for the processor, so a watched desktop that moves may
	 * keep its machine awake while it is watched. The web stops looking when the window is put away or its tab hidden,
	 * and pauses after 30 minutes without a touch. Since 20260930714000 SQL keeps the machine awake itself while a member
	 * watches: the look's read moves the machine's last use (at most every 30 s) when the member's word that they watch is
	 * at most 30 minutes old, so a quiet desktop does not sleep under them either.
	 */
	async memberLook(look: CompanyMachineMemberLook, signal: AbortSignal): Promise<CompanyMachineMemberLookOutcome> {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_MEMBER_LOOK_UNAVAILABLE");
		if (
			![look.placementId, look.bootId, look.userId].every((id) => UUID_PATTERN.test(id)) ||
			typeof look.keepDesktop !== "boolean" ||
			!Number.isSafeInteger(look.desktopGeneration) ||
			look.desktopGeneration < 0
		)
			throw new Error("COMPANY_MACHINE_MEMBER_LOOK_INVALID");
		// A look that shows a newer generation (a member took the desktop since: the private holder's own window looks before
		// it can type) moves the fence (review r1 F2 of #1733). No picture is taken until the desktop confirmed the fence of
		// now, this look's or one before it that is still on its way or failed (review r2 F1): if it cannot, the look
		// fails, and no picture shows while an older move could still run.
		this.#seeGeneration(look.placementId, look.desktopGeneration);
		// The script itself checks, under the lock, that the desktop holds the fence confirmed here and runs the incarnation
		// it was confirmed with (review r3 F1): a desktop restarted since answers 93, the confirmation is dropped, and the
		// look writes the fence again and looks once more; a second 93 shows nothing.
		let result: Awaited<ReturnType<typeof pipe>> | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			const fence = await this.#confirmFence(pipe, look.placementId, look.bootId, signal);
			result = await withTimeoutScope(signal, this.#options.memberLookTimeoutMs ?? MEMBER_LOOK_MS, (checked) =>
				pipe(
					this.#policy.project,
					lxdCompanyMachineName(look.placementId),
					{
						command: [
							"/bin/sh",
							"-c",
							COMPANY_MACHINE_MEMBER_LOOK,
							look.bootId,
							look.keepDesktop ? "keep" : "look",
							// The member whose own pointer moves this desktop sees no drawn one (20260930744000).
							this.#movesPointer(look.placementId, look.userId) ? "plain" : "drawn",
							fence ? `${fence.fence} ${fence.incarnation}` : "-",
						],
						environment: {},
						cwd: "/",
						maxStdoutBytes: SCREEN_PNG_BYTES,
						stderrTailBytes: 0,
					},
					checked,
				),
			);
			if (result.exitCode !== 93) break;
			if (this.#fencePublished.get(look.placementId) === fence) this.#fencePublished.delete(look.placementId);
		}
		if (!result || result.exitCode === 93) throw new Error("COMPANY_MACHINE_POINTER_FENCE_FAILED");
		const refused = MEMBER_LOOK_EXITS[result.exitCode];
		if (refused !== undefined) return { refused };
		// A picture larger than a screen's: not streamed, and removed on the machine.
		if (result.exitCode === 94) throw new Error("COMPANY_MACHINE_MEMBER_LOOK_TOO_LARGE");
		if (result.exitCode !== 0) throw new Error("COMPANY_MACHINE_MEMBER_LOOK_FAILED");
		const png = Buffer.from(result.stdout);
		if (!screenPicture(png)) throw new Error("COMPANY_MACHINE_MEMBER_LOOK_INVALID");
		// The fence (20260930713000, review r1 F1): another member took the desktop over since this look was read, or the
		// one who held it gave it back and took it again: nothing of the picture leaves, and the window says who holds it.
		if (!(await this.#pictureAllowed(look.placementId, look.desktopGeneration, look.userId, signal)))
			return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
		const folder = this.#options.folder;
		if (folder) {
			const at: FolderRelease = { placementId: look.placementId, bootId: look.bootId };
			const f = this.#folders.get(look.placementId);
			const boot = f?.bootId === look.bootId ? f : undefined;
			const heldBack =
				this.#heldAlready(at, boot) ??
				(await this.#release(folder, at, boot, SCREEN_BOUNDARY_MS, signal, () => this.#memberReads(look, signal)));
			if (heldBack !== undefined) return { held: heldBack === MEMBER_HIDDEN ? "hidden" : "pending" };
		}
		return Object.freeze({ png, etag: createHash("sha256").update(png).digest("hex") });
	}

	async accountFill(
		run: CompanyMachineAccountFill,
		seal: CompanyMachineAccountFillSeal,
		signal: AbortSignal,
	): Promise<CompanyMachineAccountFillOutcome> {
		const pipe = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!pipe) throw new Error("COMPANY_MACHINE_ACCOUNT_FILL_UNAVAILABLE");
		if (
			![run.placementId, run.bootId, run.receiptId].every((id) => UUID_PATTERN.test(id)) ||
			!Number.isSafeInteger(run.desktopGeneration) ||
			run.desktopGeneration < 0
		)
			throw new Error("COMPANY_MACHINE_ACCOUNT_FILL_INVALID");
		const memberHolds = async () =>
			!(await this.#pictureAllowed(run.placementId, run.desktopGeneration, null, signal));
		if (!this.#holdDesktop(run.placementId)) {
			if (await memberHolds()) return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
			if (!(await this.#holdDesktopWithin(run.placementId, CODING_VALUE_WAIT_MS, signal)))
				throw new Error("COMPANY_MACHINE_ACCOUNT_FILL_BUSY");
		}
		let ended = true;
		try {
			if (await memberHolds()) return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
			ended = false;
			const outcome = await this.#runAccountFill(pipe, run, seal, memberHolds, signal);
			ended = true;
			return outcome;
		} finally {
			this.#releaseDesktop(run.placementId, ended);
		}
	}
	async #runAccountFill(
		pipe: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		run: CompanyMachineAccountFill,
		seal: CompanyMachineAccountFillSeal,
		memberHolds: () => Promise<boolean>,
		signal: AbortSignal,
	): Promise<CompanyMachineAccountFillOutcome> {
		return withTimeoutScope(signal, this.#options.accountFillTimeoutMs ?? ACCOUNT_FILL_MS, async (deadline) => {
			// The helper's second line on stdin: the box, or nothing (stdin ends).
			let send: (line: Buffer | null) => void = () => undefined;
			const second = new Promise<Buffer | null>((resolve) => {
				send = resolve;
			});
			const sealStop = new AbortController();
			const onDeadlineAbort = () => {
				send(null);
				sealStop.abort(deadline.reason);
			};
			if (deadline.aborted) onDeadlineAbort();
			else deadline.addEventListener("abort", onDeadlineAbort, { once: true });
			const target = Buffer.from(
				`${JSON.stringify(run.target)}
`,
				"utf8",
			);
			async function* stdin(): AsyncGenerator<Uint8Array> {
				yield target;
				const line = await second;
				if (line) yield line;
			}
			let held = Buffer.alloc(0);
			let ready: string | undefined;
			let code: string | undefined;
			let vaultRefused: { code: string; message: string } | undefined;
			let sealFailure: unknown;
			let sealCancelled = false;
			let memberTookOver = false;
			let sealing: Promise<void> | undefined;
			// A line that is not the helper's fails the call, whatever came before it.
			let invalid = false;
			const line = (text: string) => {
				let output: Record<string, unknown>;
				try {
					output = machineRecord(JSON.parse(text), "COMPANY_MACHINE_ACCOUNT_FILL_INVALID");
				} catch {
					invalid = true;
					throw new Error("COMPANY_MACHINE_ACCOUNT_FILL_INVALID");
				}
				const keys = Object.keys(output).sort().join();
				if (
					ready === undefined &&
					code === undefined &&
					output.schema === "qorpera.machine-account-fill-ready/v1" &&
					keys === "publicKey,schema" &&
					typeof output.publicKey === "string" &&
					/^[A-Za-z0-9_-]{43}$/.test(output.publicKey)
				) {
					const publicKey = output.publicKey;
					ready = publicKey;
					const sealFailed = (error: unknown) => {
						if (sealCancelled && sealFailure === undefined) return;
						sealFailure = error ?? new Error("COMPANY_MACHINE_ACCOUNT_FILL_SEAL_FAILED");
						send(null);
					};
					sealing = seal(publicKey, sealStop.signal)
						.then(async (answer) => {
							if (!("box" in answer)) {
								vaultRefused = answer.refused;
								send(null);
							} else if (await memberHolds()) {
								memberTookOver = true;
								send(null);
							} else send(Buffer.from(`${JSON.stringify(answer.box)}\n`, "utf8"));
						})
						.catch(sealFailed);
					return;
				}
				if (
					code === undefined &&
					output.schema === "qorpera.machine-account-fill-result/v1" &&
					keys === "code,schema" &&
					typeof output.code === "string" &&
					/^[A-Z][A-Z0-9_]{2,60}$/.test(output.code)
				) {
					code = output.code;
					send(null);
					return;
				}
				invalid = true;
				throw new Error("COMPANY_MACHINE_ACCOUNT_FILL_INVALID");
			};
			const onStdout = (chunk: Buffer) => {
				held = Buffer.concat([held, chunk]);
				for (let end = held.indexOf(10); end >= 0; end = held.indexOf(10)) {
					const text = held.subarray(0, end).toString("utf8");
					held = Buffer.from(held.subarray(end + 1));
					line(text);
				}
			};
			let exitCode: number | undefined;
			try {
				exitCode = (
					await pipe(
						this.#policy.project,
						lxdCompanyMachineName(run.placementId),
						{
							command: [
								"/bin/sh",
								"-c",
								CODING_VALUE_ON_BOOT,
								run.bootId,
								"/usr/bin/node",
								COMPANY_MACHINE_ACCOUNT_FILL_HELPER,
							],
							environment: {},
							cwd: "/",
							stdin: stdin(),
							maxStdoutBytes: ACCOUNT_FILL_OUTPUT_BYTES,
							stderrTailBytes: 0,
							onStdout,
						},
						deadline,
					)
				).exitCode;
			} catch (error) {
				// The helper said how it ended before the exec ended badly (its stdin closed under it after its answer): that
				// answer stands. Anything else is the call's failure.
				if (code === undefined || invalid) throw error;
			} finally {
				send(null);
				if (!deadline.aborted) sealCancelled = true;
				sealStop.abort();
				deadline.removeEventListener("abort", onDeadlineAbort);
			}
			await sealing;
			if (invalid) throw new Error("COMPANY_MACHINE_ACCOUNT_FILL_INVALID");
			if (exitCode === 97) return { refused: "MACHINE_BOOT_CHANGED" };
			if (exitCode === 98) return { refused: "MACHINE_IMAGE_WITHOUT_ACCOUNT_FILLS" };
			if (exitCode !== undefined && exitCode !== 0) throw new Error("COMPANY_MACHINE_ACCOUNT_FILL_FAILED");
			if (vaultRefused) return { vaultRefused };
			if (sealFailure !== undefined) throw sealFailure;
			if (memberTookOver) return { refused: "DESKTOP_MEMBER_IN_CONTROL" };
			if (code === "FILLED") return { filled: true };
			// FILL_NO_BOX only follows the vault's refusal or failure, both answered above.
			if (code === undefined || code === "FILL_NO_BOX") throw new Error("COMPANY_MACHINE_ACCOUNT_FILL_INVALID");
			return { refused: code };
		});
	}

	/**
	 * The agent's home (lanes/agent-box-20261113, slice 1): `codex exec-server --listen stdio` inside the machine, as
	 * the machine's agent account (`qorpera-agent`, which reaches root through sudo, as a coding session's user does),
	 * with its lines carried both ways for as long as the run's channel lasts. The ingress has proven the run's holder
	 * and SQL has authorized this session on this boot; the guest's own shell checks that boot again at the exec
	 * (ON_BOOT), so a machine that restarted in between never runs it, as a machine command's start never does. Each
	 * channel's exec-server is a unit of its own in the machines' slice (companyMachineHomeCommand), and runs only when
	 * the machine's Codex is the pinned build (#homeCodex): a home whose Codex is another is refused
	 * HOME_CODEX_NOT_PINNED.
	 *
	 * It writes no inbox file and leaves no command row. What the model does through it is reviewed by
	 * the run's own host before a line gets here (slice 4) and kept as the run's steps (slice 2); the changes it makes
	 * land in the company folder through the machine's `/company` mount, as every change on a machine does.
	 * On a machine with a folder (slice 3, 20260930754000) the session first gets its own folder window, so those
	 * changes are credited to its run, and what the machine sends back leaves only once the folder released the
	 * machine's reads and the run took them in (#homeFolder).
	 *
	 * Kind `sftp` (Claude Code on the home, slice C1): the same session, ask, boot check, unit, window and release, but
	 * the program is OpenSSH's `sftp-server` (refused HOME_SFTP_MISSING on a machine whose image has none, #homeSftp) and
	 * its byte stream travels as lines of base64 (sftpLines, sftpBytes): a line that is not base64 ends the channel. Every
	 * channel of one session shares the session's one window, which closes with the last of them.
	 */
	async execServer(
		input: {
			readonly placementId: string;
			readonly sessionId: string;
			readonly bootId: string;
			readonly kind?: "exec" | "sftp";
		},
		signal: AbortSignal,
	): Promise<{ write(line: string): void; lines: AsyncIterable<string>; close(): Promise<void> }> {
		const kind = input.kind ?? "exec";
		if (
			!UUID_PATTERN.test(input.placementId) ||
			!UUID_PATTERN.test(input.sessionId) ||
			!UUID_PATTERN.test(input.bootId) ||
			(kind !== "exec" && kind !== "sftp")
		)
			throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
		const exec = this.#options.client.execInstancePipe?.bind(this.#options.client);
		if (!exec) throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
		// Slice 3 (20260930754000): SQL says whether the session may share its machine, on every executor; the folder's
		// part (the window and the release of the output) only where the machines have a folder.
		const answer = parseHomeFolderAnswer(
			await this.#call("qorpera_folder_home_session_window", { p_session_id: input.sessionId }, signal),
			input,
		);
		if (answer.state === "refused") throw new Error(answer.reason);
		if (answer.session.bootId !== input.bootId) throw new Error("HOME_SESSION_ENDED");
		if (kind === "sftp") {
			if (!(await this.#homeSftp(input.placementId, input.bootId, exec, signal)))
				throw new Error("HOME_SFTP_MISSING");
		} else if (
			(await this.#homeCodex(input.placementId, input.bootId, exec, signal)) !== CLOUD_MACHINE_HOME.codexSha256
		)
			throw new Error("HOME_CODEX_NOT_PINNED");
		const home = this.#options.folder ? await this.#homeFolder(answer.session, signal) : undefined;
		if (signal.aborted) {
			await home?.close();
			throw signal.reason;
		}
		const toMachine = new LinePipe();
		const fromMachine = new LinePipe();
		const run = new AbortController();
		const stop = (): void => run.abort();
		let gate: ReturnType<NonNullable<typeof home>["gate"]> | undefined;
		let execPipe: ReturnType<NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>>;
		try {
			signal.addEventListener("abort", stop, { once: true });
			gate = home?.gate(
				(chunk) => fromMachine.push(chunk),
				() => {
					run.abort();
					fromMachine.end();
				},
				kind === "sftp"
					? { spacingMs: HOME_SFTP_RELEASE_SPACING_MS, burst: 1 }
					: { spacingMs: HOME_RELEASE_SPACING_MS, burst: HOME_RELEASE_BURST },
			);
			execPipe = exec(
				this.#policy.project,
				lxdCompanyMachineName(input.placementId),
				{
					// Root only to hand the program to systemd; the unit runs it as the agent's account.
					command: companyMachineHomeCommand(input.bootId, input.sessionId, randomBytes(8).toString("hex"), kind),
					environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
					cwd: "/",
					stdin: toMachine.read(),
					stdout: (chunk) => (gate ? gate.push(chunk) : fromMachine.push(chunk)),
					// Streamed, so nothing is kept here and this bounds only each of LXD's messages: fromMachine ends the
					// channel when more than its own bound (the same 16 MiB) waits unread, and the gate when more than its own
					// waits for a release.
					maxStdoutBytes: LINE_PIPE_BYTES,
					stderrTailBytes: 4096,
				},
				run.signal,
			);
		} catch (error) {
			signal.removeEventListener("abort", stop);
			gate?.close();
			fromMachine.end();
			toMachine.end();
			await home?.close();
			throw error;
		}
		const pipe = execPipe
			.catch(() => undefined)
			.then(async () => {
				signal.removeEventListener("abort", stop);
				// What the machine sent before it ended still leaves once released; then the session's window closes.
				await gate?.drained();
				fromMachine.end();
				toMachine.end();
				await home?.close();
			});
		const ended = (): void => {
			toMachine.end();
			gate?.close();
			run.abort();
		};
		return {
			write:
				kind === "sftp"
					? (line) => {
							// Not the stream: nothing of it reaches sftp-server, and the channel ends.
							const bytes = sftpBytes(line);
							if (bytes) toMachine.push(bytes);
							else ended();
						}
					: (line) => toMachine.push(Buffer.from(`${line}\n`, "utf8")),
			lines: kind === "sftp" ? sftpLines(fromMachine.read()) : fromMachine.lines(),
			close: async () => {
				ended();
				await pipe;
			},
		};
	}
	/** The sha-256 of the machine's Codex on this boot, read once per boot (the file is 319 MB; every later channel of the
	 * boot takes the answer kept here), or "missing" where the image has none. A boot that is not the machine's is
	 * HOME_SESSION_ENDED; a read that failed otherwise is not kept, so the next channel reads again. */
	async #homeCodex(
		placementId: string,
		bootId: string,
		exec: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		signal: AbortSignal,
	): Promise<string> {
		signal.throwIfAborted();
		let entry = this.#homeCodexes.get(placementId);
		if (!entry || entry.bootId !== bootId) {
			const controller = new AbortController();
			const created = {
				bootId,
				sha: undefined as unknown as Promise<string>,
				waiters: 0,
				controller,
				settled: false,
			};
			created.sha = withTimeoutScope(controller.signal, HOME_CODEX_HASH_MS, async (checked) => {
				const result = await exec(
					this.#policy.project,
					lxdCompanyMachineName(placementId),
					{
						command: ["/bin/sh", "-c", HOME_CODEX_ON_BOOT, bootId, CLOUD_MACHINE_HOME.codex],
						environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
						cwd: "/",
						maxStdoutBytes: 1024,
						stderrTailBytes: 512,
					},
					checked,
				);
				if (result.exitCode === 97) throw new Error("HOME_SESSION_ENDED");
				if (result.exitCode === 98) return "missing";
				const read = /^([0-9a-f]{64}) /.exec(result.stdout.toString("utf8"));
				if (result.exitCode !== 0 || !read) throw new Error("HOME_CODEX_UNREADABLE");
				return read[1] as string;
			}).then(
				(value) => {
					created.settled = true;
					return value;
				},
				(error) => {
					created.settled = true;
					if (this.#homeCodexes.get(placementId) === created) this.#homeCodexes.delete(placementId);
					throw error;
				},
			);
			created.sha.catch(() => undefined);
			const currentBoot = this.#guests.get(placementId)?.bootId ?? this.#folders.get(placementId)?.bootId;
			if (entry && currentBoot !== undefined && entry.bootId === currentBoot && bootId !== currentBoot) {
				// WHY: A stale-boot request must not abort or overwrite the current boot's in-flight Codex hash.
				entry = created;
			} else {
				if (entry && !entry.settled && currentBoot !== undefined && bootId === currentBoot)
					entry.controller.abort();
				this.#homeCodexes.set(placementId, created);
				entry = created;
			}
		}
		if (entry.settled) return await entry.sha;
		entry.waiters += 1;
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				entry.sha,
				new Promise<never>((_, reject) => {
					onAbort = () => reject(signal.reason);
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
			entry.waiters -= 1;
			if (!entry.settled && entry.waiters === 0) {
				if (this.#homeCodexes.get(placementId) === entry) this.#homeCodexes.delete(placementId);
				entry.controller.abort(signal.reason);
			}
		}
	}
	/** Whether the machine has sftp-server on this boot (the file channel, slice C1), asked as root on the boot SQL named.
	 * Kept once found for the boot; a machine without it is asked again at its next channel. A boot that is not the
	 * machine's is HOME_SESSION_ENDED. */
	async #homeSftp(
		placementId: string,
		bootId: string,
		exec: NonNullable<LxdInstanceExecPipeClient["execInstancePipe"]>,
		signal: AbortSignal,
	): Promise<boolean> {
		if (this.#homeSftps.get(placementId) === bootId) return true;
		const result = await withTimeoutScope(signal, HOME_CODEX_HASH_MS, (checked) =>
			exec(
				this.#policy.project,
				lxdCompanyMachineName(placementId),
				{
					command: ["/bin/sh", "-c", HOME_SFTP_ON_BOOT, bootId, CLOUD_MACHINE_HOME.sftpServer],
					environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
					cwd: "/",
					maxStdoutBytes: 1024,
					stderrTailBytes: 512,
				},
				checked,
			),
		);
		if (result.exitCode === 97) throw new Error("HOME_SESSION_ENDED");
		if (result.exitCode === 98) return false;
		if (result.exitCode !== 0) throw new Error("HOME_SFTP_UNREADABLE");
		this.#homeSftps.set(placementId, bootId);
		return true;
	}
	/** A home session's own place in the company folder (slice 3, 20260930754000), before its channel starts, once SQL
	 * said the session stands and may share its machine (its agent's, for the same member and worker access, and only
	 * while they read the whole folder) and named the ids its window carries (execServer). Once the boot's folder
	 * settled: on a boot with /company the session's command window opens,
	 * its id the session's, so what the machine changes until it closes is credited to the session's run (opened again
	 * each pass, #reopen); and the run takes in every read the disk was served before anything of the channel's reaches
	 * it, so what an earlier run left on this disk is in this run's read set. A take-in that holds starts no channel.
	 * The gate holds each later batch of output for the same release; `close` closes the window, once, with the
	 * boundary that publishes what the session changed last. */
	async #homeFolder(
		session: HomeFolderSession,
		signal: AbortSignal,
	): Promise<{
		gate(
			pass: (chunk: Buffer) => void,
			fail: (why: string) => void,
			pace: { readonly spacingMs: number; readonly burst: number },
		): HomeOutputGate;
		close(): Promise<void>;
	}> {
		const folder = this.#options.folder as FolderControl;
		const boot = await this.#settled(session, signal);
		const at: FolderRelease = { placementId: session.placementId, bootId: session.bootId, runId: session.runId };
		// One window per session, however many channels it has open (slice C1: Claude Code's shell and files are two
		// channels of one session; a reconnect may overlap the channel it replaces): opened by each (said again, it
		// changes nothing), closed only with the last, so a change made over one channel is credited while another ends.
		let counted = false;
		const leave = (): boolean => {
			if (!counted) return false;
			counted = false;
			const left = (boot.homeChannels.get(session.sessionId) ?? 1) - 1;
			if (left > 0) boot.homeChannels.set(session.sessionId, left);
			else boot.homeChannels.delete(session.sessionId);
			return left === 0;
		};
		if (boot.state === "open") {
			const window: FolderCommandWindow = {
				commandId: session.sessionId,
				runId: session.runId,
				staffAgentId: session.staffAgentId,
				requestedByUserId: session.requestedByUserId,
			};
			boot.homeChannels.set(session.sessionId, (boot.homeChannels.get(session.sessionId) ?? 0) + 1);
			counted = true;
			try {
				await withTimeoutScope(signal, 5000, (checked) => folder.openWindow(session.placementId, window, checked));
			} catch (error) {
				// The service may have taken the open although it did not answer in time: no channel starts, so the
				// window is closed again, at best, as a window whose channel ended (review r11 F1), unless another channel
				// of the session still has it open.
				if (leave()) {
					boot.homes.delete(session.sessionId);
					const answered = await withTimeoutScope(undefined, WINDOWS_MS, (checked) =>
						folder.closeWindow(session.placementId, session.sessionId, checked),
					).catch(() => undefined);
					noted(boot, answered);
				}
				throw error;
			}
			boot.homes.set(session.sessionId, window);
		}
		let closing: Promise<void> | undefined;
		const close = (): Promise<void> => {
			closing ??= (async () => {
				if (!leave() || !boot.homes.delete(session.sessionId)) return;
				const answered = await withTimeoutScope(undefined, WINDOWS_MS, (checked) =>
					folder.closeWindow(session.placementId, session.sessionId, checked),
				).catch(() => undefined);
				noted(boot, answered);
			})();
			return closing;
		};
		// A release that did not answer (the service or SQL busy) is tried again a few times; any other hold is final.
		const transient = new Set<string>([HELD.unanswered, HELD.unreleased, HELD.untaken, HELD.paused]);
		const release = async (): Promise<string | undefined> => {
			for (let tries = 1; ; tries++) {
				const held = this.#heldAlready(at, boot) ?? (await this.#release(folder, at, boot, BOUNDARY_MS, signal));
				if (held === undefined || !transient.has(held) || tries >= HOME_RELEASE_TRIES || signal.aborted)
					return held;
				await setTimeout(250 * tries, undefined, { signal }).catch(() => undefined);
			}
		};
		const first = await release().catch(() => HELD.untaken);
		if (first !== undefined) {
			await close();
			throw new Error("HOME_FOLDER_HELD");
		}
		return {
			gate: (pass, fail, pace) =>
				new HomeOutputGate({
					release,
					pass,
					fail,
					spacingMs: pace.spacingMs,
					burst: pace.burst,
					limitBytes: HOME_OUTPUT_WAIT_BYTES,
				}),
			close,
		};
	}
	/** Runs one authorized command action on a machine of this node. A start on a machine with a folder is delivered
	 * meanwhile: a look from before its guest had it, or from while it was delivered, leaves its window open (#ends),
	 * and a restart of its guest waits for it (#delivered). */
	async command(
		authority: CompanyMachineCommandAuthority,
		request: CompanyMachineCommand,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt> {
		if (request.action !== "start" || !this.#options.folder) return this.#command(authority, request, signal);
		const key = `${authority.placementId}/${authority.commandId}`;
		this.#delivery(key, 1);
		try {
			return await this.#command(authority, request, signal);
		} finally {
			this.#delivery(key, -1);
		}
	}
	/** A start's delivery begins (1) or ends (-1): every look on its way no longer speaks for its command. */
	#delivery(key: string, by: 1 | -1): void {
		const left = (this.#delivering.get(key) ?? 0) + by;
		if (left > 0) this.#delivering.set(key, left);
		else this.#delivering.delete(key);
		for (const touched of this.#looks) touched.add(key);
	}
	async #command(
		authority: CompanyMachineCommandAuthority,
		request: CompanyMachineCommand,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt> {
		const machine = { machineId: authority.machineId, project: this.#policy.project };
		if (
			!UUID_PATTERN.test(machine.machineId) ||
			!UUID_PATTERN.test(authority.placementId) ||
			!SHA.test(authority.inputSha256)
		)
			throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
		const name = lxdCompanyMachineName(authority.placementId);
		const commandId = request.action === "read" ? request.read.commandId : request.commandId;
		if (commandId !== authority.commandId) throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
		const nonce = randomUUID();
		const folder = this.#options.folder;
		let args: string[];
		// The boot a start on a machine with a folder was let in on, which its guest checks at the start's exec.
		let on: string | undefined;
		if (request.action === "start") {
			if (request.inputSha256 !== authority.inputSha256) throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
			// A machine with a folder starts a command only once its boot's folder settled, and with its window open: what
			// the machine changes from now on is credited to the command's run (F3 6d).
			const boot = folder ? await this.#settled(authority, signal) : undefined;
			// A pass can end the boot's folder (6d-2), or see its next boot, while the start waits: after each wait, up to
			// the guest's exec, the start goes on only on the boot it was let in on, and its folder not ended.
			const fenced = () => {
				if (
					boot &&
					(this.#folders.get(authority.placementId) !== boot || this.#ended(authority.placementId, boot.bootId))
				)
					throw new Error("COMPANY_MACHINE_FOLDER_ENDED");
			};
			if (folder && boot?.state === "open") {
				const { runId, staffAgentId, requestedByUserId } = authority;
				if (
					typeof runId !== "string" ||
					typeof staffAgentId !== "string" ||
					typeof requestedByUserId !== "string" ||
					![runId, staffAgentId, requestedByUserId].every((id) => UUID_PATTERN.test(id))
				)
					throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
				const window = { commandId, runId, staffAgentId, requestedByUserId };
				// The service opens a window in memory: a few seconds are ample, and the start stays in the gateway's 30.
				await withTimeoutScope(signal, 5000, async (checked) => {
					// A pass that saw the command before its guest had it closes its window: that close is answered first, so
					// the open comes after it.
					const closing = this.#closing.get(`${authority.placementId}/${commandId}`);
					if (closing && !checked.aborted) await awaitRaceAbort(closing, checked);
					if (checked.aborted) throw new Error("FOLDER_CONTROL_UNANSWERED");
					fenced();
					await folder.openWindow(authority.placementId, window, checked);
				});
				// Opened again each pass until the command ends (#reopen).
				boot.windows.set(commandId, window);
			}
			fenced();
			await this.#options.client.pushInstanceFile(
				machine.project,
				name,
				`${PATHS.state}/inbox/${commandId}.json`,
				JSON.stringify({
					schema: "qorpera.machine-command-request/v1",
					machineId: machine.machineId,
					commandId,
					inputSha256: request.inputSha256,
					command: request.command,
					timeoutMs: request.timeoutMs,
				}),
				0o400,
				signal,
			);
			fenced();
			on = boot?.bootId;
			args = ["start", commandId];
		} else if (request.action === "cancel") args = ["cancel", commandId];
		else {
			// The guest is asked for no more than its helper said it takes; a smaller page answers the read as well.
			const limit = String(
				Math.min(
					request.read.limit ?? 4096,
					this.#pages.get(authority.placementId) ?? CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES,
				),
			);
			args = [
				"read",
				commandId,
				...(request.read.tail ? ["tail", limit] : [String(request.read.offset ?? 0), limit]),
			];
		}
		const helper = ["/usr/bin/node", PATHS.helper, nonce, ...args];
		// A start that crosses its guest's restart (it was let in before, and reaches the next boot) fails in the guest's
		// shell, and nothing starts (ON_BOOT).
		await this.#options.client.execInstance(
			machine.project,
			name,
			on ? ["/bin/sh", "-c", ON_BOOT, on, ...helper] : helper,
			signal,
		);
		const file = await this.#options.client.readInstanceFile(
			machine.project,
			name,
			`${PATHS.runtime}/replies/${nonce}.json`,
			65536,
			signal,
		);
		const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)) as Record<
			string,
			unknown
		>;
		if (value?.schema === "qorpera.machine-guest-refusal/v1")
			throw new Error(
				typeof value.code === "string" && /^[A-Z][A-Z0-9_:]{2,120}$/.test(value.code)
					? value.code
					: "MACHINE_GUEST_REFUSED",
			);
		const receipt = parseCloudMachineCommandReceipt(value);
		// The company folder's report is the executor's to make, never the guest's (6e-2a).
		if (
			receipt.machineId !== machine.machineId ||
			receipt.commandId !== commandId ||
			receipt.inputSha256 !== authority.inputSha256 ||
			receipt.companyFolder !== undefined
		)
			throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
		if (!folder) return receipt;
		// What the command printed, and how it ended, leave only once every read the machine was served is released
		// (F3 6d): a boundary first. A start, whose wait took most of the gateway's time, holds them for the next read,
		// and a command still running with nothing printed has nothing to let out. Nothing leaves a boot whose folder
		// ended (6d-2), whatever a boundary answers (a crashed service's successor releases reads it never served) and
		// whatever came of its folder: its guest may still run, its reboot not taken yet. A boot can end while its guest
		// answers or the boundary is out, so it is checked after each. Only a boot without /company (none) skips the
		// boundary. Then the run that gets the output takes in the reads of the machine's views (6d-3b, "Reads" rule 3),
		// on a boot without /company too: the disk keeps what any boot of it was served. Each receipt says why what it
		// holds back is held (6e-2a, #told).
		const f = this.#folders.get(authority.placementId);
		const boot = f?.bootId === authority.bootId ? f : undefined;
		const at = (request.action === "read" && !request.read.tail && request.read.offset) || 0;
		const holding = (heldBack?: string) => this.#told(authority, boot, held(receipt, at), heldBack, false);
		const already = this.#heldAlready(authority, boot);
		if (already !== undefined) return holding(already);
		if (request.action === "start" && boot?.state !== "none") return holding(HELD.start);
		if (receipt.state === "running" && receipt.log.totalBytes === 0) return holding();
		const heldBack = await this.#release(folder, authority, boot, BOUNDARY_MS, signal);
		return heldBack === undefined ? this.#told(authority, boot, receipt, undefined, true) : holding(heldBack);
	}
	/** Why a boot's output is held before any boundary: its folder ended (6d-2), or a run's take-in found a read no
	 * longer readable (#inherit). */
	#heldAlready(at: FolderRelease, boot: BootFolder | undefined): string | undefined {
		if (at.bootId && this.#ended(at.placementId, at.bootId)) return HELD.ended;
		if (boot?.unreadable) return HELD.unreadable;
		return undefined;
	}
	/** The company folder's release of what a boot's output may show (#command, screen): a boundary first, unless the boot
	 * has no /company (none); then the run that gets the output takes in the reads of the machine's views (6d-3b), on a
	 * boot without /company too. A boot can end while the boundary or the take-in is out, so it is checked after each.
	 * Undefined: released; otherwise why it is held (a HELD text). A member's look (memberLook) takes `takeIn`, the
	 * member's read check, in place of the run's take-in. */
	async #release(
		folder: FolderControl,
		at: FolderRelease,
		boot: BootFolder | undefined,
		boundaryMs: number,
		signal: AbortSignal,
		takeIn: () => Promise<string | undefined> = () => this.#inherit(at, boot, signal),
	): Promise<string | undefined> {
		const ended = () => !!at.bootId && this.#ended(at.placementId, at.bootId);
		if (boot?.state !== "none") {
			const answer = await withTimeoutScope(signal, boundaryMs, (checked) =>
				folder.boundary(at.placementId, [], checked),
			).catch(() => undefined);
			noted(boot, answer);
			if (ended()) return HELD.ended;
			if (answer?.reads !== "released") return unreleased(answer);
		}
		const refused = await takeIn();
		if (ended()) return HELD.ended;
		return refused;
	}
	/** Why a boot whose folder ended has no /company (6e-2a). */
	#endedWhy(authority: CompanyMachineCommandAuthority): string {
		const ending =
			typeof authority.bootId === "string"
				? this.#endings.get(`${authority.placementId}/${authority.bootId}`)
				: undefined;
		return (ending && FOLDER_ENDED[ending.cause]) || FOLDER_ENDED.stale;
	}
	/** A receipt with the company folder's report (6e-2a): whether the command's boot has /company, and why not; why
	 * its output is held back (`heldBack`); why the machine lost the command (`lost`, SQL's cause); and, on a receipt
	 * whose output leaves (`released`), the paths the folder let go unsaved since the boot's last such receipt, once
	 * (`notSaved`), and those it did not save that the boot's views still keep pending (`stillNotSaved`, #noted). The
	 * report fits the agent's tool result as it measures it: paths that do not are counted instead. */
	#told(
		authority: CompanyMachineCommandAuthority,
		boot: BootFolder | undefined,
		receipt: CloudMachineCommandReceipt,
		heldBack: string | undefined,
		released: boolean,
	): CloudMachineCommandReceipt {
		const ended = typeof authority.bootId === "string" && this.#ended(authority.placementId, authority.bootId);
		let why: string | undefined;
		if (ended) why = this.#endedWhy(authority);
		else if (boot?.reason === "refused" && boot.refusal !== undefined)
			why =
				boot.refusal === VIEW_NOT_CURRENT
					? `${FOLDER_VIEWLESS.refused} because the machine is stopping, moving or starting again`
					: `${FOLDER_VIEWLESS.refused}: ${boot.refusal}`;
		else if (boot?.reason) why = FOLDER_VIEWLESS[boot.reason];
		// Why the machine lost the command, by the authority's `folderLost`: the words SQL tells its run.
		const lost =
			receipt.state === "lost" && isCloudMachineFolderLost(authority.folderLost)
				? CLOUD_MACHINE_FOLDER_LOST[authority.folderLost]
				: undefined;
		const report: CloudMachineCommandFolder = {
			company: why !== undefined ? "none" : boot?.held ? "mounted" : "pending",
			...(why !== undefined ? { why } : {}),
			...(heldBack !== undefined ? { heldBack } : {}),
			...(lost !== undefined ? { lost } : {}),
		};
		// What was let go unsaved since the last such receipt, once; and what the boot's views still keep pending.
		const notSaved = released && boot ? boot.notSaved.splice(0) : [];
		let more = 0;
		const still: CloudMachineFolderNotSaved[] = [];
		let moreStill = 0;
		if (released && boot) {
			more = boot.moreNotSaved;
			boot.moreNotSaved = 0;
			for (const view of boot.stillNotSaved.values()) {
				moreStill += view.more;
				for (const item of view.paths)
					if (still.length < CLOUD_MACHINE_FOLDER_LIMITS.notSaved) still.push(item);
					else moreStill++;
			}
		}
		const shown = () => ({
			...report,
			...(notSaved.length ? { notSaved } : {}),
			...(more ? { moreNotSaved: more } : {}),
			...(still.length ? { stillNotSaved: still } : {}),
			...(moreStill ? { moreStillNotSaved: moreStill } : {}),
		});
		// Over the bytes, what the next receipt says again goes first.
		while (still.length && cloudMachineFolderBytes(shown()) > CLOUD_MACHINE_FOLDER_LIMITS.bytes) {
			still.pop();
			moreStill++;
		}
		while (notSaved.length && cloudMachineFolderBytes(shown()) > CLOUD_MACHINE_FOLDER_LIMITS.bytes) {
			notSaved.pop();
			more++;
		}
		return Object.freeze({ ...receipt, companyFolder: parseCloudMachineCommandFolder(shown()) });
	}
	/** The run a command's output goes to takes in the reads of its machine's newest view first (6d-3b): SQL builds the
	 * run's actor, and answers a placement that never had a view with nothing to take in. Each take-in has its own id:
	 * SQL checks the view's whole read set for the run each time, and copies only what the run has not taken in from
	 * that view (20260930498000). Any failure holds the output, and says why (6e-2a): undefined means taken in. The
	 * core's refusal of a read it can no longer read ("qorpera.test-machine/unreadable") marks the boot, which holds
	 * every later output of it, and the next pass retires the placement (rule 5). */
	async #inherit(
		authority: FolderRelease,
		boot: BootFolder | undefined,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const { placementId, bootId, runId } = authority;
		if (
			typeof bootId !== "string" ||
			typeof runId !== "string" ||
			!UUID_PATTERN.test(bootId) ||
			!UUID_PATTERN.test(runId)
		)
			return HELD.untaken;
		const inheritId = randomUUID();
		try {
			const taken = machineRecord(
				await this.#call(
					"qorpera_folder_test_machine_inherit_reads",
					{ p_placement_id: placementId, p_boot_id: bootId, p_run_id: runId, p_inherit_id: inheritId },
					signal,
				),
				"COMPANY_MACHINE_INHERIT_INVALID",
			);
			return taken.schema === "qorpera.folder-inherit/v1" && taken.inheritId === inheritId
				? undefined
				: HELD.untaken;
		} catch (error) {
			if (!(error instanceof CodingControlRefused)) return HELD.untaken;
			if (boot && error.detail === "qorpera.test-machine/unreadable") boot.unreadable = true;
			return HELD.refused;
		}
	}
	/** A member's read check of what the machine read (20260930712000), after the boundary: undefined when every read the
	 * machine's newest view holds is the member's to read; MEMBER_HIDDEN when SQL refused one as not theirs (a refusal of
	 * this member alone: nothing of the boot is marked); otherwise held until the member looks again. */
	async #memberReads(look: CompanyMachineMemberLook, signal: AbortSignal): Promise<string | undefined> {
		try {
			const checked = machineRecord(
				await this.#call(
					"qorpera_folder_member_machine_reads",
					{ p_placement_id: look.placementId, p_boot_id: look.bootId, p_user_id: look.userId },
					signal,
				),
				"COMPANY_MACHINE_MEMBER_READS_INVALID",
			);
			return checked.schema === "qorpera.folder-member-reads/v1" ? undefined : HELD.untaken;
		} catch (error) {
			return error instanceof CodingControlRefused && error.detail === MEMBER_UNREADABLE
				? MEMBER_HIDDEN
				: HELD.untaken;
		}
	}
	async #checkAppFolder(authority: CompanyMachineAppAuthority, signal: AbortSignal): Promise<void> {
		const folder = this.#options.folder;
		if (!folder) return;
		const f = this.#folders.get(authority.placementId);
		const boot = f?.bootId === authority.bootId ? f : undefined;
		const at: FolderRelease = {
			placementId: authority.placementId,
			bootId: authority.bootId ?? undefined,
			runId: authority.runId,
		};
		if (this.#heldAlready(at, boot) !== undefined) throw new Error("COMPANY_MACHINE_FOLDER_HELD");
		if ((await this.#release(folder, at, boot, BOUNDARY_MS, signal)) !== undefined)
			throw new Error("COMPANY_MACHINE_FOLDER_HELD");
	}

	async appStart(
		authority: CompanyMachineAppAuthority,
		request: CompanyMachineAppStartRequest,
		signal: AbortSignal,
	): Promise<CompanyMachineAppStartResult> {
		if (
			!UUID_PATTERN.test(authority.machineId) ||
			!UUID_PATTERN.test(authority.placementId) ||
			!APP_SLUG.test(request.slug) ||
			typeof request.command !== "string" ||
			!request.command.trim() ||
			request.command.includes("\0") ||
			Buffer.byteLength(request.command) > 16384 ||
			Buffer.byteLength(JSON.stringify(request.command)) > 32768 ||
			!Number.isInteger(request.port) ||
			request.port < 1 ||
			request.port > 65535
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		if (
			request.healthPath !== undefined &&
			(typeof request.healthPath !== "string" ||
				(request.healthPath !== "" &&
					(!request.healthPath.startsWith("/") ||
						request.healthPath.length > 256 ||
						/[\x00-\x1f\x7f\s]/.test(request.healthPath))))
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		if (
			request.cwd !== undefined &&
			(typeof request.cwd !== "string" ||
				!request.cwd.startsWith("/") ||
				request.cwd.length > 512 ||
				/[\0\r\n]/.test(request.cwd))
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		await this.#checkAppFolder(authority, signal);
		const payload = {
			slug: request.slug,
			command: request.command,
			port: request.port,
			...(request.healthPath !== undefined ? { healthPath: request.healthPath } : {}),
			...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
		};
		const value = await this.#runAppGuestCommand(authority.placementId, ["app-start"], payload, signal);
		if (
			value.schema !== "qorpera.machine-app-started/v1" ||
			value.slug !== request.slug ||
			typeof value.machineId !== "string" ||
			typeof value.unit !== "string" ||
			!Number.isInteger(value.port)
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		return value as unknown as CompanyMachineAppStartResult;
	}

	async appStop(
		authority: CompanyMachineAppAuthority,
		slug: string,
		signal: AbortSignal,
	): Promise<CompanyMachineAppStopResult> {
		if (!UUID_PATTERN.test(authority.machineId) || !UUID_PATTERN.test(authority.placementId) || !APP_SLUG.test(slug))
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		await this.#checkAppFolder(authority, signal);
		const value = await this.#runAppGuestCommand(authority.placementId, ["app-stop", slug], null, signal);
		if (value.schema !== "qorpera.machine-app-stopped/v1" || value.slug !== slug || typeof value.unit !== "string")
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		return value as unknown as CompanyMachineAppStopResult;
	}

	async appHealth(
		authority: CompanyMachineAppAuthority,
		slug: string,
		signal: AbortSignal,
	): Promise<CompanyMachineAppHealthResult> {
		if (!UUID_PATTERN.test(authority.machineId) || !UUID_PATTERN.test(authority.placementId) || !APP_SLUG.test(slug))
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		await this.#checkAppFolder(authority, signal);
		const value = await this.#runAppGuestCommand(authority.placementId, ["app-health", slug], null, signal);
		if (
			value.schema !== "qorpera.machine-app-health/v1" ||
			value.slug !== slug ||
			typeof value.unit !== "string" ||
			typeof value.activeState !== "string" ||
			typeof value.subState !== "string" ||
			!Number.isSafeInteger(value.restarts) ||
			typeof value.healthy !== "boolean"
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		return value as unknown as CompanyMachineAppHealthResult;
	}

	async appReload(
		authority: CompanyMachineAppAuthority,
		request: CompanyMachineAppReloadRequest,
		signal: AbortSignal,
	): Promise<CompanyMachineAppReloadResult> {
		if (
			!UUID_PATTERN.test(authority.machineId) ||
			!UUID_PATTERN.test(authority.placementId) ||
			!APP_SLUG.test(request.slug)
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		if (request.port !== undefined && (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535))
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		if (
			request.healthPath !== undefined &&
			(typeof request.healthPath !== "string" ||
				(request.healthPath !== "" &&
					(!request.healthPath.startsWith("/") ||
						request.healthPath.length > 256 ||
						/[\x00-\x1f\x7f\s]/.test(request.healthPath))))
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		await this.#checkAppFolder(authority, signal);
		const hasOptions = request.port !== undefined || request.healthPath !== undefined;
		const payload = hasOptions
			? {
					...(request.port !== undefined ? { port: request.port } : {}),
					...(request.healthPath !== undefined ? { healthPath: request.healthPath } : {}),
				}
			: null;
		const value = await this.#runAppGuestCommand(
			authority.placementId,
			["app-reload", request.slug],
			payload,
			signal,
		);
		if (
			value.schema !== "qorpera.machine-app-reload/v1" ||
			value.slug !== request.slug ||
			!Number.isInteger(value.activePort) ||
			typeof value.healthy !== "boolean" ||
			typeof value.restarted !== "boolean"
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		return value as unknown as CompanyMachineAppReloadResult;
	}

	async appLogs(
		authority: CompanyMachineAppAuthority,
		request: CompanyMachineAppLogsRequest,
		signal: AbortSignal,
	): Promise<CompanyMachineAppLogsResult> {
		if (
			!UUID_PATTERN.test(authority.machineId) ||
			!UUID_PATTERN.test(authority.placementId) ||
			!APP_SLUG.test(request.slug)
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		if (request.stream !== undefined && !["stdout", "stderr", "all"].includes(request.stream))
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		if (request.tail !== undefined && (!Number.isInteger(request.tail) || request.tail < 1 || request.tail > 500))
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		if (request.grep !== undefined && (typeof request.grep !== "string" || request.grep.length > 256))
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		if (
			request.since !== undefined &&
			(typeof request.since !== "string" || request.since.length > 64 || Number.isNaN(Date.parse(request.since)))
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		await this.#checkAppFolder(authority, signal);
		const payload = {
			...(request.grep !== undefined ? { grep: request.grep } : {}),
			...(request.tail !== undefined ? { tail: request.tail } : {}),
			...(request.stream !== undefined ? { stream: request.stream } : {}),
			...(request.since !== undefined ? { since: request.since } : {}),
		};
		const value = await this.#runAppGuestCommand(authority.placementId, ["app-logs", request.slug], payload, signal);
		if (
			value.schema !== "qorpera.machine-app-logs/v1" ||
			value.slug !== request.slug ||
			!Array.isArray(value.lines) ||
			!Number.isSafeInteger(value.totalMatched) ||
			typeof value.truncated !== "boolean"
		)
			throw new Error("COMPANY_MACHINE_APP_INVALID");
		return value as unknown as CompanyMachineAppLogsResult;
	}

	async #runAppGuestCommand(
		placementId: string,
		commandArgs: readonly string[],
		inboxPayload: Record<string, unknown> | null,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const name = lxdCompanyMachineName(placementId);
		const nonce = randomUUID();
		const args = [...commandArgs];
		if (inboxPayload !== null) {
			const inboxId = randomUUID();
			await this.#options.client.pushInstanceFile(
				this.#policy.project,
				name,
				`${PATHS.state}/inbox/${inboxId}.json`,
				JSON.stringify(inboxPayload),
				0o400,
				signal,
			);
			args.push(inboxId);
		}
		await this.#options.client.execInstance(
			this.#policy.project,
			name,
			["/usr/bin/node", PATHS.helper, nonce, ...args],
			signal,
		);
		const file = await this.#options.client.readInstanceFile(
			this.#policy.project,
			name,
			`${PATHS.runtime}/replies/${nonce}.json`,
			65536,
			signal,
		);
		const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)) as Record<
			string,
			unknown
		>;
		if (value?.schema === "qorpera.machine-guest-refusal/v1")
			throw new Error(
				typeof value.code === "string" && /^[A-Z][A-Z0-9_:]{2,120}$/.test(value.code)
					? value.code
					: "MACHINE_GUEST_REFUSED",
			);
		return value;
	}

	async #settled(
		authority: Pick<CompanyMachineCommandAuthority, "placementId" | "bootId">,
		signal: AbortSignal,
	): Promise<BootFolder> {
		const deadline = Date.now() + FOLDER_WAIT_MS;
		for (;;) {
			if (typeof authority.bootId === "string" && this.#ended(authority.placementId, authority.bootId))
				throw new Error("COMPANY_MACHINE_FOLDER_ENDED");
			const f = this.#folders.get(authority.placementId);
			if (typeof authority.bootId === "string" && f?.bootId === authority.bootId && f.state !== "pending") return f;
			if (typeof authority.bootId !== "string" || Date.now() >= deadline)
				throw new Error("COMPANY_MACHINE_FOLDER_UNANSWERED");
			await setTimeout(200, undefined, { signal });
		}
	}
}
