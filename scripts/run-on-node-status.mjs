import { spawnSync } from "node:child_process";

/** GitHub commit statuses for run-on-node results. With GitHub Actions switched off, a PR shows its test
 * machine result as an ordinary status check on the tested commit (the statuses API uses no Actions minutes).
 * A status is posted only when what ran is exactly a pushed commit: a clean working tree whose HEAD
 * GitHub knows. Posting never changes the run's exit code. */

/** `owner/repo` from a GitHub remote URL (https or ssh), or null. */
export function repoSlug(remoteUrl) {
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
		remoteUrl.trim(),
	);
	return match ? match[1] : null;
}

/** The status context for a named suite; ad-hoc `-- command` runs get none. */
export function statusContext(suite) {
	return suite ? `qorpera-ci/${suite}` : null;
}

/** Whether to post, and why not when not. Only a plain run of a named suite speaks for the suite, and
 * `changed` only against origin/master (a later base can make its plan empty). */
export function statusDecision({ suite, dirty, disabled, slug, plain = true, base = "origin/master" }) {
	if (disabled) return { post: false, reason: "--no-status" };
	if (!suite) return { post: false, reason: "ad-hoc command, not a named suite" };
	if (!slug) return { post: false, reason: "origin is not a GitHub repository" };
	if (dirty) return { post: false, reason: "uncommitted or untracked changes: the result is not a commit's" };
	if (!plain) return { post: false, reason: "suite arguments, --env, --sudo or an install/build override narrow the run" };
	if (suite === "changed" && base !== "origin/master")
		return { post: false, reason: `--base ${base}: only a run against origin/master posts qorpera-ci/changed` };
	return { post: true, reason: null };
}

/** How a status names the machine a run used: node01 is "node 1"; a run in parts (node02+node01) "node 2 + node 1". */
export function machineLabel(name) {
	return name
		.split("+")
		.map((one) => {
			const node = /^node0*([1-9][0-9]*)$/.exec(one);
			return node ? `node ${node[1]}` : one;
		})
		.join(" + ");
}

function duration(seconds) {
	const whole = Math.round(seconds);
	return whole >= 60 ? `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s` : `${whole}s`;
}

/** At most 140 characters, as GitHub requires. */
export function statusDescription(record) {
	const where = `on ${machineLabel(record.machine)} in ${duration(record.elapsedSeconds)}`;
	const who = record.runner ? ` (${record.runner})` : "";
	let text;
	if (record.result === "passed")
		text = record.changed ? `passed ${where}: ${record.changed.steps.length} steps${who}` : `passed ${where}${who}`;
	else if (record.result === "failed") {
		// The steps --fail-fast stopped had no result: only their number.
		const named = [...(record.failedSteps ?? []), ...(record.stoppedSteps?.length ? [`${record.stoppedSteps.length} stopped`] : [])];
		text = named.length ? `failed ${where}: ${named.join(", ")}${who}` : `failed ${where}${who}`;
	}
	else if (record.result === "install-failed") text = `failed ${where}: npm ci or the build${who}`;
	else text = `${record.result} ${where}${who}: the harness, not the suite`;
	return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/** success; failure for the suite or its install and build (usually the change's fault); error for a run
 * the harness never brought to a result. */
export function statusState(result) {
	return result === "passed" ? "success" : result === "failed" || result === "install-failed" ? "failure" : "error";
}

function gh(args) {
	const result = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
	return { ok: result.status === 0, error: (result.stderr || result.error?.message || "").trim().slice(-300) };
}

/** GitHub has the commit: `{ ok: true }`; it does not: `{ ok: false }`; gh itself failed (missing, logged
 * out, offline): `{ ok: false, error }`. */
export function commitPushed(slug, sha) {
	const result = gh(["api", `repos/${slug}/commits/${sha}`, "--silent"]);
	if (result.ok) return { ok: true };
	return /HTTP 404|HTTP 422|No commit found/i.test(result.error) ? { ok: false } : { ok: false, error: result.error || "gh failed" };
}

export function postStatus({ slug, sha, state, context, description }) {
	return gh([
		"api",
		"--method",
		"POST",
		`repos/${slug}/statuses/${sha}`,
		"-f",
		`state=${state}`,
		"-f",
		`context=${context}`,
		"-f",
		`description=${description}`,
		"--silent",
	]);
}
