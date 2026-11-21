import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateReleaseManifest } from "./manifest.mjs";

export const NON_RETRYABLE_CODES = new Set([77, 78, 79, 81, 82, 83, 84, 85, 87, 88]);
export const WRITE_PHASES = new Set(["migrate", "a-apply", "switch", "web"]);
export const ONCE_PHASES = new Set(["web"]);

export function stepsForManifest(manifest) {
	validateReleaseManifest(manifest);
	if (manifest.mode === "sql-only") {
		return ["target", "packets", "rehearse", "migrate", "models-read", "after-read"];
	}
	const watches = [];
	if (manifest.watchPolicy.homeWatchMinutes > 0) watches.push("home-watch");
	if (manifest.watchPolicy.claudeWatchMinutes > 0) watches.push("claude-watch");
	if (watches.length === 0 && manifest.watchPolicy.smokeMinutes > 0) watches.push("smoke-watch");
	return [
		"target",
		"prep",
		"packets",
		"rehearse",
		"migrate",
		"home-read",
		"claude-read",
		"models-read",
		"a-drain",
		"a-apply",
		"switch",
		...watches,
		"n",
		"web",
		`rundoor-gate-${manifest.nodes.nodeB}`,
		"b-drain",
		"b-apply",
		"b3",
		"b-return",
		`rundoor-read-${manifest.nodes.nodeB}`,
		"finish",
		"gc",
		"after-read",
		`${manifest.nodes.nodeB}-gc`,
	];
}

export function atomicWriteFile(filePath, content) {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(temporary, content, "utf8");
	renameSync(temporary, filePath);
}

export function keptHoldText({ manifest, stoppedAt, atIso, firstWritePhase, stopWhy, prStateSummary }) {
	const prLabel = manifest.releasePrNumber ? `release PR #${manifest.releasePrNumber}` : "sql-only release";
	const line1 = `MERGE-HOLD KEPT by the v${manifest.version} roll (release-engine, ${prLabel}): the roll STOPPED with part of the release on production.`;
	const line2 = `Stopped at: ${stoppedAt} (${stopWhy}), ${atIso}; the first phase that wrote the release: ${firstWritePhase}. ${prStateSummary}`;
	const line3 =
		manifest.releasePrNumber !== null
			? `No merges into master until release PR #${manifest.releasePrNumber} merges and Pages serves it, or the release is rolled back.`
			: "No merges into master until the lead verifies production state and clears this hold.";
	const line4 = `The lead removes this file by its exact path, or resumes this manifest with --from <step>.`;
	return `${line1}\n${line2}\n${line3}\n${line4}\n`;
}

function isMatchingKeptHold(text, manifest) {
	const lines = text.trimEnd().split("\n");
	if (lines.length !== 4) return false;
	const prLabel = manifest.releasePrNumber ? `release PR #${manifest.releasePrNumber}` : "sql-only release";
	return (
		lines[0] ===
			`MERGE-HOLD KEPT by the v${manifest.version} roll (release-engine, ${prLabel}): the roll STOPPED with part of the release on production.` &&
		lines[3] === "The lead removes this file by its exact path, or resumes this manifest with --from <step>."
	);
}

export async function runReleaseDriver(manifest, options = {}, ports = {}) {
	validateReleaseManifest(manifest);
	const dryRun = Boolean(options.dryRun);
	const env = options.env ?? process.env;
	const stateDir = options.stateDir;
	const holdFile = options.holdFile ?? (stateDir ? join(stateDir, "MERGE-HOLD") : null);
	const prepHoldFile = options.prepHoldFile ?? null;
	const fromStep = options.from ?? null;
	const maxTries = options.maxTries ?? 3;
	const nowIso = ports.nowIso ?? (() => new Date().toISOString());
	const sleep = ports.sleep ?? (async () => {});
	const runPhase = ports.runPhase;
	const readPrState = ports.readPrState ?? (async () => ({ state: "OPEN", mergeable: "MERGEABLE" }));
	const log = [];

	if (env.QORPERA_ROLL_TEST && !dryRun) {
		return { ok: false, exitCode: 2, reason: "REFUSED: QORPERA_ROLL_TEST requires --dry-run", log };
	}
	if (!dryRun && manifest.armed !== true) {
		return { ok: false, exitCode: 2, reason: "REFUSED: manifest.armed is false (held)", log };
	}
	if (stateDir) {
		for (const marker of ["WAY-BACK-STARTED", "WAY-BACK-TAKEN"]) {
			if (existsSync(join(stateDir, marker))) {
				return {
					ok: false,
					exitCode: 2,
					reason: `REFUSED: ${marker} is present; re-cut as a fresh release`,
					log,
				};
			}
		}
	}

	const steps = stepsForManifest(manifest);
	let startIndex = 0;
	if (fromStep) {
		startIndex = steps.indexOf(fromStep);
		if (startIndex < 0) {
			return { ok: false, exitCode: 2, reason: `Unknown --from step '${fromStep}'`, log };
		}
	}

	if (!dryRun && manifest.releasePrNumber !== null) {
		const pr = await readPrState(manifest.releasePrNumber);
		const tag = `${pr?.state ?? ""} ${pr?.mergeable ?? ""}`.trim();
		if (pr?.state === "MERGED" || tag === "OPEN MERGEABLE") {
			log.push(`pr-check ok: ${tag}`);
		} else if (tag === "OPEN UNKNOWN" || !pr?.state) {
			return { ok: false, exitCode: 77, reason: `COULD NOT READ release PR #${manifest.releasePrNumber}: ${tag || "empty"}`, log };
		} else {
			return { ok: false, exitCode: 4, reason: `REFUSED: release PR #${manifest.releasePrNumber} is ${tag}`, log };
		}
	}

	let onProd = null;
	if (startIndex > 0) {
		const earlierWrite = steps.slice(0, startIndex).find((step) => WRITE_PHASES.has(step));
		if (earlierWrite) onProd = `resumed-from-${fromStep}`;
	}

	const prLabel = manifest.releasePrNumber ? `release PR #${manifest.releasePrNumber}` : "sql-only release";
	const driverHoldText = `v${manifest.version} roll (release-engine, ${prLabel}, started ${nowIso()}): no merges until complete.\n`;
	let holdOwned = false;
	let holdOrigin = null;
	const holdReleaseStep = manifest.mode === "sql-only" ? "after-read" : "web";
	const holdNeeded = startIndex <= steps.indexOf(holdReleaseStep);

	if (holdFile && holdNeeded) {
		const prepText = prepHoldFile && existsSync(prepHoldFile) ? readFileSync(prepHoldFile, "utf8") : null;
		if (existsSync(holdFile)) {
			const existing = readFileSync(holdFile, "utf8");
			if (prepText && existing === prepText) {
				atomicWriteFile(holdFile, driverHoldText);
				holdOwned = true;
				holdOrigin = "prep";
			} else if (isMatchingKeptHold(existing, manifest)) {
				atomicWriteFile(holdFile, driverHoldText);
				holdOwned = true;
				holdOrigin = "kept";
				if (!onProd) onProd = "earlier-kept-hold";
			} else {
				log.push("foreign MERGE-HOLD present: left untouched");
			}
		} else {
			atomicWriteFile(holdFile, driverHoldText);
			holdOwned = true;
			holdOrigin = "driver";
		}
	}

	const finalizeHold = async ({ completed, failedStep, stopWhy }) => {
		if (!holdFile || !holdOwned) return;
		if (completed) {
			if (existsSync(holdFile) && readFileSync(holdFile, "utf8") === driverHoldText) {
				rmSync(holdFile, { force: true });
			}
			holdOwned = false;
			return;
		}
		if (onProd) {
			let prSummary = "SQL-only release (no release PR).";
			if (!dryRun && manifest.releasePrNumber !== null) {
				const pr = await readPrState(manifest.releasePrNumber).catch(() => null);
				prSummary = pr?.state ? `Release PR #${manifest.releasePrNumber} state: ${pr.state}.` : `Release PR #${manifest.releasePrNumber} state unreadable.`;
			}
			atomicWriteFile(
				holdFile,
				keptHoldText({
					manifest,
					stoppedAt: failedStep,
					atIso: nowIso(),
					firstWritePhase: onProd,
					stopWhy,
					prStateSummary: prSummary,
				}),
			);
			holdOwned = false;
			return;
		}
		if (holdOrigin === "prep" && prepHoldFile && existsSync(prepHoldFile)) {
			atomicWriteFile(holdFile, readFileSync(prepHoldFile, "utf8"));
		} else if (existsSync(holdFile) && readFileSync(holdFile, "utf8") === driverHoldText) {
			rmSync(holdFile, { force: true });
		}
		holdOwned = false;
	};

	const executed = [];
	for (let idx = startIndex; idx < steps.length; idx++) {
		const step = steps[idx];
		if (!onProd && WRITE_PHASES.has(step)) {
			onProd = step;
		}
		const attemptsAllowed = ONCE_PHASES.has(step) ? 1 : maxTries;
		let lastCode = 0;
		let lastReason = "";
		for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
			const result = await runPhase(step, { manifest, dryRun, attempt });
			lastCode = result?.exitCode ?? 0;
			lastReason = result?.reason ?? "";
			log.push(`${step} try ${attempt} rc=${lastCode}`);
			if (lastCode === 0) break;
			if (NON_RETRYABLE_CODES.has(lastCode)) {
				log.push(`${step} non-retryable rc=${lastCode}`);
				break;
			}
			if (attempt < attemptsAllowed) {
				await sleep(dryRun ? 0 : (options.retryDelayMs ?? 90_000));
			}
		}
		if (lastCode !== 0) {
			await finalizeHold({ completed: false, failedStep: step, stopWhy: lastReason || `exit ${lastCode}` });
			return {
				ok: false,
				exitCode: lastCode,
				failedStep: step,
				onProd,
				executed,
				reason: lastReason || `${step} failed with exit ${lastCode}`,
				log,
			};
		}
		executed.push(step);
		if (step === holdReleaseStep) {
			await finalizeHold({ completed: true, failedStep: null, stopWhy: null });
		}
	}

	return {
		ok: true,
		exitCode: 0,
		executed,
		mode: manifest.mode,
		log,
	};
}
