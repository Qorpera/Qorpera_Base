#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildWakeQueryScript,
	MACHINES,
	parseWakeQueryOutput,
	SLEEP_MARKER_DIR,
	shellQuote,
	sshArgs,
	vmNameForMachine,
	WAKE_PROJECT,
} from "./run-on-node.mjs";

export const ALLOWED_ACTIONS = new Set(["keep_awake", "tidy_disk", "sleep_vm", "tidy_and_sleep"]);
export const DEFAULT_MIN_IDLE_MINUTES = 5;
export const DEFAULT_LLM_DISK_GIB = 25;
export const DEFAULT_CRITICAL_DISK_GIB = 15;
export const DEFAULT_LOW_TMP_GIB = 2.0;
export const DEFAULT_CRITICAL_TMP_GIB = 1.5;
export const DEFAULT_FALLBACK_SLEEP_MINUTES = 45;
export const DEFAULT_MODEL = "haiku";
const LOCK_DIR = "/tmp/qorpera-test-machine-caretaker.lock";

export function isMachineBusy(machine) {
	return (
		(machine.busy ?? 0) > 0 ||
		(machine.waiting ?? 0) > 0 ||
		(machine.quickBusy ?? 0) > 0 ||
		(machine.quickWaiting ?? 0) > 0 ||
		(machine.arriving ?? 0) > 0 ||
		(machine.activeCiProcs ?? 0) > 0 ||
		(machine.otherSshSessions ?? 0) > 0
	);
}

export function shouldConsultLlm(
	machine,
	{
		minIdleMinutes = DEFAULT_MIN_IDLE_MINUTES,
		diskThresholdGiB = DEFAULT_LLM_DISK_GIB,
		tmpThresholdGiB = DEFAULT_LOW_TMP_GIB,
	} = {},
) {
	if (machine.status !== "RUNNING" || machine.unreachable) return false;
	const lowDisk = machine.diskFreeGiB !== null && machine.diskFreeGiB < diskThresholdGiB;
	const lowTmp = machine.tmpFreeGiB !== null && machine.tmpFreeGiB < tmpThresholdGiB;
	if (lowDisk || lowTmp) return true;
	if (isMachineBusy(machine)) return false;
	return machine.idleMinutes !== null && machine.idleMinutes >= minIdleMinutes;
}

export function parseCaretakerDecision(rawOutput) {
	if (typeof rawOutput !== "string" || !rawOutput.trim()) return null;
	let text = rawOutput.trim();
	try {
		const outer = JSON.parse(text);
		if (outer && typeof outer === "object" && typeof outer.result === "string") {
			text = outer.result.trim();
		} else if (outer && typeof outer === "object" && typeof outer.action === "string") {
			return validateDecision(outer);
		}
	} catch {
		/* WHY: Plain-text or fenced model output falls through to direct JSON extraction below. */
	}
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced) text = fenced[1].trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return validateDecision(JSON.parse(text.slice(start, end + 1)));
	} catch {
		return null;
	}
}

function validateDecision(obj) {
	if (!obj || typeof obj !== "object") return null;
	const action = typeof obj.action === "string" ? obj.action.trim() : "";
	if (!ALLOWED_ACTIONS.has(action)) return null;
	const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 240) : "";
	return { action, reason: reason || "llm decision" };
}

export function fallbackDecision(
	machine,
	queue,
	{
		fallbackSleepMinutes = DEFAULT_FALLBACK_SLEEP_MINUTES,
		tidyDiskGiB = 20,
		lowTmpGiB = DEFAULT_LOW_TMP_GIB,
	} = {},
) {
	const needsTidy =
		(machine.diskFreeGiB !== null && machine.diskFreeGiB < tidyDiskGiB) ||
		(machine.tmpFreeGiB !== null && machine.tmpFreeGiB < lowTmpGiB);
	const queueClear = !queue || (queue.readyPrs === 0 && queue.pendingCi === 0);
	const canSleep =
		machine.wakeable === true &&
		!isMachineBusy(machine) &&
		machine.idleMinutes !== null &&
		machine.idleMinutes >= fallbackSleepMinutes &&
		queueClear;
	if (canSleep) {
		return {
			action: needsTidy ? "tidy_and_sleep" : "sleep_vm",
			reason: `fallback: idle ${Math.round(machine.idleMinutes)}m with clear PR queue`,
		};
	}
	if (needsTidy) {
		return {
			action: "tidy_disk",
			reason: `fallback: low disk (${machine.diskFreeGiB} GiB free, /tmp ${machine.tmpFreeGiB} GiB free)`,
		};
	}
	return { action: "keep_awake", reason: "fallback: keep awake until idle threshold or queue clears" };
}

export function enforceSafetyGuards(
	decision,
	machine,
	{
		minIdleMinutes = DEFAULT_MIN_IDLE_MINUTES,
		criticalDiskGiB = DEFAULT_CRITICAL_DISK_GIB,
		criticalTmpGiB = DEFAULT_CRITICAL_TMP_GIB,
	} = {},
) {
	let { action, reason } = decision;
	const wantsSleep = action === "sleep_vm" || action === "tidy_and_sleep";
	const wantsTidy = action === "tidy_disk" || action === "tidy_and_sleep";
	const criticalDisk =
		(machine.diskFreeGiB !== null && machine.diskFreeGiB < criticalDiskGiB) ||
		(machine.tmpFreeGiB !== null && machine.tmpFreeGiB < criticalTmpGiB);
	let sleepBlockedReason = null;
	if (wantsSleep) {
		if (isMachineBusy(machine)) {
			sleepBlockedReason = "guard: active CI/SSH work detected";
		} else if (machine.idleMinutes === null || machine.idleMinutes < minIdleMinutes) {
			sleepBlockedReason = `guard: idle ${machine.idleMinutes ?? "?"}m < ${minIdleMinutes}m minimum`;
		} else if (!machine.wakeable) {
			sleepBlockedReason = "guard: lxc wake unavailable on jump host";
		}
	}
	const finalSleep = wantsSleep && !sleepBlockedReason;
	const finalTidy = wantsTidy || criticalDisk;
	if (finalTidy && finalSleep) action = "tidy_and_sleep";
	else if (finalSleep) action = "sleep_vm";
	else if (finalTidy) action = "tidy_disk";
	else action = "keep_awake";
	const notes = [reason];
	if (sleepBlockedReason) notes.push(sleepBlockedReason);
	if (criticalDisk && !wantsTidy) notes.push("guard: forced tidy due to low free disk/tmp");
	return { action, reason: notes.filter(Boolean).join("; ") };
}

export function buildTelemetryPrompt(snapshot) {
	return [
		"You are the Qorpera CI test-VM caretaker. Decide the single best maintenance action for this operator test VM.",
		"Allowed actions (choose exactly one):",
		'- "keep_awake": keep VM running (prefer when pr-loop has ready PRs/pending CI, or an active burst of runs happened in the last 15-20m so stopping now would cause a cold reboot bounce).',
		'- "tidy_disk": run the safe deterministic disk/container cleanup script while keeping the VM running (prefer when diskFreeGiB < 25, tmpFreeGiB < 2, or stale containers/volumes accumulated).',
		'- "sleep_vm": cleanly stop the VM to free host RAM (only when wakeable=true, idleMinutes >= 5, no active work, and burst/PR queue looks quiet; run-on-node will auto-wake it on the next CI run).',
		'- "tidy_and_sleep": run tidy_disk first, then stop the VM.',
		'Never invent other actions. Reply with ONLY compact JSON: {"action":"...","reason":"short 1-sentence reason"}.',
		`Telemetry: ${JSON.stringify(snapshot)}`,
	].join("\n");
}

export function telemetryScript({
	locksDir = "/run/lock",
	homeDir = "/home/tester",
	historyDir = "/home/tester/run-history",
	psArgsCmd = "ps -eo args=",
	psUserCmd = "ps -eo user=",
} = {}) {
	const qLocks = shellQuote(locksDir);
	const qHome = shellQuote(homeDir);
	const qHist = shellQuote(historyDir);
	return [
		"set -u",
		`locks=${qLocks}`,
		`home=${qHome}`,
		`hist_dir=${qHist}`,
		'busy=0; for n in 1 2 3 4 5 6 7; do f="${locks}/qorpera-test-machine-slot${n}.lock"; if [ -e "$f" ] && ! flock -n "$f" true 2>/dev/null; then busy=$((busy+1)); fi; done',
		'qbusy=0; for n in 1 2; do f="${locks}/qorpera-test-machine-quick-slot${n}.lock"; if [ -e "$f" ] && ! flock -n "$f" true 2>/dev/null; then qbusy=$((qbusy+1)); fi; done',
		'waiting=$(ls -1 "${locks}/qorpera-test-machine-queue" 2>/dev/null | wc -l | tr -d " ")',
		'qwaiting=$(ls -1 "${locks}/qorpera-test-machine-quick-queue" 2>/dev/null | wc -l | tr -d " ")',
		'arriving=$(ls -1 "${home}/arriving" 2>/dev/null | wc -l | tr -d " ")',
		`ci_procs=$(${psUserCmd} 2>/dev/null | awk '/^ci[0-9][0-9]$/ { n++ } END { print n + 0 }')`,
		`ssh_sessions=$(${psArgsCmd} 2>/dev/null | awk '/^sshd(-session)?: tester@/ { n++ } END { print n + 0 }')`,
		"disk_mib=$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}')",
		"tmp_mib=$(df -Pm /tmp 2>/dev/null | awk 'NR==2 {print $4}')",
		"mem_mib=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || true)",
		"load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || true)",
		"now=$(date +%s)",
		"uptime_s=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || true)",
		'idle_min=""',
		'if [ -n "$uptime_s" ]; then',
		"  last_act=$((now - uptime_s))",
		'  for f in "${locks}"/qorpera-test-machine-ci*.lock "${hist_dir}"/*.jsonl; do [ -e "$f" ] || continue; mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0); [ "$mt" -gt "$last_act" ] && last_act=$mt; done',
		"  idle_min=$(( (now - last_act) / 60 ))",
		"fi",
		"runs_60m=0",
		"cutoff_sec=$((now - 3600))",
		"today=$(date -u +%Y%m%d)",
		"yest=$(date -u -d '-1 day' +%Y%m%d 2>/dev/null || date -u -v-1d +%Y%m%d 2>/dev/null || true)",
		'for d in "$today" "$yest"; do',
		'  [ -n "$d" ] || continue',
		'  hist="${hist_dir}/${d}.jsonl"',
		'  if [ -f "$hist" ]; then',
		'    c=$(awk -v c="$cutoff_sec" \'{ if (match($0, /"endedAt":[0-9]+/)) { s = substr($0, RSTART + 10, RLENGTH - 10) + 0; if (s >= c) n++ } } END { print n + 0 }\' "$hist" 2>/dev/null || echo 0)',
		"    runs_60m=$((runs_60m + c))",
		"  fi",
		"done",
		'stale_ct=$(docker ps -aq 2>/dev/null | wc -l | tr -d " " || echo 0)',
		'vol_count=$(docker volume ls -q 2>/dev/null | wc -l | tr -d " " || echo 0)',
		'run_dirs=$(ls -1d "${home}/runs"/*/ 2>/dev/null | wc -l | tr -d " " || echo 0)',
		'tree_dirs=$(ls -1d "${home}/trees"/*/ 2>/dev/null | wc -l | tr -d " " || echo 0)',
		"printf 'busy=%s\\nwaiting=%s\\nquick_busy=%s\\nquick_waiting=%s\\narriving=%s\\nci_procs=%s\\nssh_sessions=%s\\ndisk_mib=%s\\ntmp_mib=%s\\nmem_mib=%s\\nload=%s\\nidle_min=%s\\nruns_60m=%s\\nstale_ct=%s\\nvol_count=%s\\nrun_dirs=%s\\ntree_dirs=%s\\n' \"$busy\" \"$waiting\" \"$qbusy\" \"$qwaiting\" \"$arriving\" \"$ci_procs\" \"$ssh_sessions\" \"$disk_mib\" \"$tmp_mib\" \"$mem_mib\" \"$load\" \"$idle_min\" \"$runs_60m\" \"$stale_ct\" \"$vol_count\" \"$run_dirs\" \"$tree_dirs\"",
	].join("\n");
}

export function buildTidyScript() {
	return "if [ -x /usr/local/sbin/qorpera-test-machine-tidy.sh ]; then sudo -n /usr/local/sbin/qorpera-test-machine-tidy.sh; else docker volume prune -f && docker image prune -f; fi";
}

export function buildClearSleepMarkerScript(vmName) {
	return `vm=${shellQuote(vmName)}; rm -f -- "${SLEEP_MARKER_DIR}/\${vm}"`;
}

export function buildJumpStopScript(vmName) {
	const qVm = shellQuote(vmName);
	return [
		"set -eu",
		`vm=${qVm}`,
		`json=$(lxc query "/1.0/instances/\${vm}?project=${WAKE_PROJECT}")`,
		`last_used=$(printf '%s' "$json" | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("last_used_at") or ""))')`,
		'[ -n "$last_used" ] || exit 2',
		`lxc stop "$vm" --project ${WAKE_PROJECT} --timeout 60`,
		`mkdir -p "${SLEEP_MARKER_DIR}"`,
		`printf '%s\\n' "$last_used" > "${SLEEP_MARKER_DIR}/\${vm}"`,
	].join("\n");
}

export function buildTelemetrySshArgs(machine, key, scriptOpts) {
	return ["-o", "ConnectTimeout=8", ...sshArgs(machine, key), machine.host, "bash", "-c", shellQuote(telemetryScript(scriptOpts))];
}

export function buildTidySshArgs(machine, key) {
	return ["-o", "ConnectTimeout=8", ...sshArgs(machine, key), machine.host, "bash", "-c", shellQuote(buildTidyScript())];
}

export function buildJumpQuerySshArgs(machine) {
	const vmName = vmNameForMachine(machine);
	if (!vmName) throw new Error(`Invalid machine name: ${machine?.name}`);
	return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", machine.jump, "bash", "-c", shellQuote(buildWakeQueryScript(vmName))];
}

export function buildJumpClearMarkerSshArgs(machine) {
	const vmName = vmNameForMachine(machine);
	if (!vmName) throw new Error(`Invalid machine name: ${machine?.name}`);
	return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", machine.jump, "bash", "-c", shellQuote(buildClearSleepMarkerScript(vmName))];
}

export function buildJumpStopSshArgs(machine) {
	const vmName = vmNameForMachine(machine);
	if (!vmName) throw new Error(`Invalid machine name: ${machine?.name}`);
	return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", machine.jump, "bash", "-c", shellQuote(buildJumpStopScript(vmName))];
}

export function parseTelemetryOutput(stdout, machine, lxd = { vmName: null, wakeable: false }) {
	const kv = {};
	for (const line of String(stdout ?? "").split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	const optNum = (k) => (kv[k] !== undefined && /^-?\d+(\.\d+)?$/.test(kv[k]) ? Number(kv[k]) : null);
	const num = (k) => optNum(k) ?? 0;
	const diskMiB = optNum("disk_mib");
	const tmpMiB = optNum("tmp_mib");
	const memMiB = optNum("mem_mib");
	const idleMin = optNum("idle_min");
	return {
		name: machine.name,
		vmName: lxd.vmName,
		status: "RUNNING",
		wakeable: lxd.wakeable,
		unreachable: false,
		busy: num("busy"),
		waiting: num("waiting"),
		quickBusy: num("quick_busy"),
		quickWaiting: num("quick_waiting"),
		arriving: num("arriving"),
		activeCiProcs: num("ci_procs"),
		otherSshSessions: Math.max(0, num("ssh_sessions") - 1),
		diskFreeGiB: diskMiB === null ? null : Math.round((diskMiB / 1024) * 10) / 10,
		tmpFreeGiB: tmpMiB === null ? null : Math.round((tmpMiB / 1024) * 10) / 10,
		memAvailGiB: memMiB === null ? null : Math.round((memMiB / 1024) * 10) / 10,
		load: optNum("load"),
		idleMinutes: idleMin === null ? null : Math.max(0, idleMin),
		runsLast60m: num("runs_60m"),
		containers: num("stale_ct"),
		dockerVolumes: num("vol_count"),
		runDirs: num("run_dirs"),
		treeDirs: num("tree_dirs"),
	};
}

function queryLxdMachine(machine) {
	const vmName = vmNameForMachine(machine);
	if (!vmName || !machine.jump) return { vmName, lxdStatus: null, lastUsedAt: null, sleepMarker: null, wakeable: false };
	const res = spawnSync("ssh", buildJumpQuerySshArgs(machine), { encoding: "utf8", timeout: 12_000 });
	if (res.status !== 0) return { vmName, lxdStatus: null, lastUsedAt: null, sleepMarker: null, wakeable: false };
	const parsed = parseWakeQueryOutput(res.stdout);
	if (!parsed.status) return { vmName, lxdStatus: null, lastUsedAt: null, sleepMarker: null, wakeable: false };
	if (parsed.status === "RUNNING" && parsed.sleepMarker) {
		spawnSync("ssh", buildJumpClearMarkerSshArgs(machine), { encoding: "utf8", timeout: 10_000 });
	}
	return {
		vmName,
		lxdStatus: parsed.status,
		lastUsedAt: parsed.lastUsedAt,
		sleepMarker: parsed.sleepMarker,
		wakeable: true,
	};
}

function probeTelemetry(machine, key) {
	const lxd = queryLxdMachine(machine);
	if (lxd.lxdStatus === "STOPPED") {
		return {
			name: machine.name,
			vmName: lxd.vmName,
			status: "STOPPED",
			wakeable: lxd.wakeable,
			unreachable: false,
			busy: 0,
			waiting: 0,
			quickBusy: 0,
			quickWaiting: 0,
			arriving: 0,
			activeCiProcs: 0,
			otherSshSessions: 0,
			diskFreeGiB: null,
			tmpFreeGiB: null,
			memAvailGiB: null,
			load: 0,
			idleMinutes: null,
			runsLast60m: 0,
		};
	}
	const res = spawnSync("ssh", buildTelemetrySshArgs(machine, key), {
		encoding: "utf8",
		timeout: 15_000,
	});
	if (res.status !== 0) {
		return {
			name: machine.name,
			vmName: lxd.vmName,
			status: lxd.lxdStatus ?? "UNREACHABLE",
			wakeable: lxd.wakeable,
			unreachable: true,
			error: (res.stderr || res.stdout || `exit ${res.status}`).trim().slice(0, 160),
		};
	}
	return parseTelemetryOutput(res.stdout, machine, lxd);
}

function queryPrQueue() {
	const res = spawnSync(
		"gh",
		[
			"pr",
			"list",
			"--repo",
			"Qorpera/Qorpera_Base",
			"--state",
			"open",
			"--limit",
			"60",
			"--json",
			"number,isDraft,labels,statusCheckRollup",
		],
		{ encoding: "utf8", timeout: 12_000 },
	);
	if (res.status !== 0) return null;
	try {
		const prs = JSON.parse(res.stdout);
		let readyPrs = 0;
		let pendingCi = 0;
		for (const pr of prs) {
			const hasHold = (pr.labels ?? []).some((l) => l.name === "hold");
			if (!pr.isDraft && !hasHold) readyPrs += 1;
			const checks = pr.statusCheckRollup ?? [];
			if (checks.some((c) => (c.context ?? c.name) === "qorpera-ci/changed" && (c.state ?? c.conclusion) === "PENDING")) {
				pendingCi += 1;
			}
		}
		return { openPrs: prs.length, readyPrs, pendingCi };
	} catch {
		return null;
	}
}

function consultClaudeHaiku(snapshot, model = DEFAULT_MODEL) {
	const prompt = buildTelemetryPrompt(snapshot);
	const env = { ...process.env };
	for (const k of Object.keys(env)) {
		if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
	}
	const res = spawnSync(
		"claude",
		["-p", "--model", model, "--no-session-persistence", "--tools", "", "--output-format", "json", prompt],
		{ encoding: "utf8", timeout: 25_000, env },
	);
	if (res.status !== 0) return null;
	return parseCaretakerDecision(res.stdout);
}

function runRemoteTidy(machine, key) {
	const res = spawnSync("ssh", buildTidySshArgs(machine, key), {
		encoding: "utf8",
		timeout: 180_000,
	});
	return { ok: res.status === 0, out: (res.stdout || res.stderr || "").trim().slice(0, 300) };
}

function stopRemoteVm(machine, key) {
	const recheck = probeTelemetry(machine, key);
	if (recheck.status !== "RUNNING" || isMachineBusy(recheck)) {
		return { ok: false, skipped: "activity appeared during final safety recheck" };
	}
	const res = spawnSync("ssh", buildJumpStopSshArgs(machine), { encoding: "utf8", timeout: 75_000 });
	return { ok: res.status === 0, out: (res.stdout || res.stderr || "").trim().slice(0, 200) };
}

function acquireLock() {
	try {
		mkdirSync(LOCK_DIR);
		writeFileSync(join(LOCK_DIR, "pid"), String(process.pid));
		return true;
	} catch {
		try {
			const pid = Number(readFileSync(join(LOCK_DIR, "pid"), "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					/* WHY: Stale lock from an exited caretaker process is safe to reclaim. */
				}
			}
			rmSync(LOCK_DIR, { recursive: true, force: true });
			mkdirSync(LOCK_DIR);
			writeFileSync(join(LOCK_DIR, "pid"), String(process.pid));
			return true;
		} catch {
			return false;
		}
	}
}

function releaseLock() {
	rmSync(LOCK_DIR, { recursive: true, force: true });
}

export function parseCliArgs(argv) {
	const opts = { dryRun: false, noLlm: false, model: DEFAULT_MODEL, machine: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") opts.dryRun = true;
		else if (arg === "--no-llm") opts.noLlm = true;
		else if (arg === "--model" && argv[i + 1]) opts.model = argv[++i];
		else if (arg === "--machine" && argv[i + 1]) opts.machine = argv[++i];
	}
	return opts;
}

async function main() {
	const opts = parseCliArgs(process.argv.slice(2));
	const key = process.env.QORPERA_TEST_MACHINE_KEY ?? join(homedir(), ".ssh", "id_ed25519_qorpera_testvm");
	if (!existsSync(key)) {
		console.error(`[caretaker] missing key ${key}`);
		return 1;
	}
	if (!opts.dryRun && !acquireLock()) {
		console.log(`[${new Date().toISOString()}] caretaker: previous run still active, skipping`);
		return 0;
	}
	try {
		const targets = opts.machine ? MACHINES.filter((m) => m.name === opts.machine) : MACHINES;
		const queue = queryPrQueue();
		const localHour = new Date().getHours();
		const summary = [];
		for (const machine of targets) {
			const state = probeTelemetry(machine, key);
			if (!shouldConsultLlm(state)) {
				const note =
					state.status === "STOPPED"
						? "already asleep (0 LLM calls)"
						: state.unreachable
							? `unreachable: ${state.error ?? "unknown"}`
							: `active or recently used (busy=${state.busy}, idle=${state.idleMinutes}m, disk=${state.diskFreeGiB}GiB)`;
				summary.push({ machine: machine.name, action: "skip", reason: note, state });
				continue;
			}
			const snapshot = { localHour, machine: state, prQueue: queue };
			let raw = null;
			let source = "fallback";
			if (!opts.noLlm) {
				raw = consultClaudeHaiku(snapshot, opts.model);
				if (raw) source = `claude:${opts.model}`;
			}
			const decided = raw ?? fallbackDecision(state, queue);
			const safe = enforceSafetyGuards(decided, state);
			let execResult = null;
			if (!opts.dryRun) {
				if (safe.action === "tidy_disk" || safe.action === "tidy_and_sleep") {
					execResult = { tidy: runRemoteTidy(machine, key) };
				}
				if (safe.action === "sleep_vm" || safe.action === "tidy_and_sleep") {
					execResult = { ...(execResult ?? {}), sleep: stopRemoteVm(machine, key) };
				}
			}
			summary.push({
				machine: machine.name,
				source,
				action: safe.action,
				reason: safe.reason,
				dryRun: opts.dryRun,
				execResult,
			});
		}
		console.log(JSON.stringify({ timestamp: new Date().toISOString(), queue, results: summary }));
		return 0;
	} finally {
		if (!opts.dryRun) releaseLock();
	}
}

function isDirectEntry() {
	if (!process.argv[1]) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return import.meta.url === pathToFileURL(process.argv[1]).href;
	}
}

if (isDirectEntry()) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
