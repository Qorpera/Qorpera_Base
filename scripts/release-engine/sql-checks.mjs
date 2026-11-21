import { createHash } from "node:crypto";

export function dollarQuote(value) {
	const text = String(value);
	const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
	let tag = `$q_${digest}$`;
	let salt = 0;
	while (text.includes(tag)) {
		salt += 1;
		tag = `$q_${digest}_${salt}$`;
	}
	return `${tag}${text}${tag}`;
}

export function buildAnchorCheckSql(anchors) {
	if (!anchors.length) {
		return "select '[]'::jsonb as anchors;";
	}
	const rows = anchors.map((anchor, index) => {
		const fnQuoted = dollarQuote(anchor.functionSignature);
		const snippetQuoted = dollarQuote(anchor.snippet);
		return `(${index}, ${fnQuoted}, ${snippetQuoted}, ${anchor.expectedCount})`;
	});
	return [
		"with checks(idx, fn_sig, snippet, expected) as (",
		`  values ${rows.join(",\n    ")}`,
		"), measured as (",
		"  select idx, fn_sig, expected,",
		"    case",
		"      when to_regprocedure(fn_sig) is null then -1",
		"      else (length(pg_get_functiondef(to_regprocedure(fn_sig))) - length(replace(pg_get_functiondef(to_regprocedure(fn_sig)), snippet, ''))) / greatest(length(snippet), 1)",
		"    end as actual",
		"  from checks",
		")",
		"select coalesce(jsonb_agg(jsonb_build_object('index', idx, 'functionSignature', fn_sig, 'expectedCount', expected, 'actualCount', actual) order by idx), '[]'::jsonb) as anchors",
		"from measured;",
	].join("\n");
}

export function evaluateAnchorResults(anchors, measuredRows) {
	const byIndex = new Map((measuredRows ?? []).map((row) => [row.index, row]));
	const mismatches = [];
	for (let index = 0; index < anchors.length; index++) {
		const expected = anchors[index];
		const actualRow = byIndex.get(index);
		if (!actualRow || actualRow.actualCount !== expected.expectedCount) {
			mismatches.push({
				index,
				functionSignature: expected.functionSignature,
				expectedCount: expected.expectedCount,
				actualCount: actualRow ? actualRow.actualCount : null,
			});
		}
	}
	return {
		ok: mismatches.length === 0,
		exitCode: mismatches.length === 0 ? 0 : 88,
		mismatches,
	};
}

export function evaluatePostChecks(checks, actualByName) {
	const failures = [];
	for (const check of checks) {
		const present = actualByName !== null && actualByName !== undefined && Object.hasOwn(actualByName, check.name);
		const actual = present ? actualByName[check.name] : undefined;
		if (!present || JSON.stringify(actual) !== JSON.stringify(check.expected)) {
			failures.push({
				name: check.name,
				expected: check.expected,
				actual: present ? actual : "<missing>",
			});
		}
	}
	return {
		ok: failures.length === 0,
		exitCode: failures.length === 0 ? 0 : 87,
		failures,
	};
}

export function evaluateWatchTick({ kind, windowMinutes, earlyExitOnCompletedRuns }, stats) {
	if (kind === "home-watch" && (stats.codexHomeFailures ?? 0) > 0) {
		return { done: true, ok: false, exitCode: 83, reason: "codex-home-failure" };
	}
	if (kind === "claude-watch" && (stats.claudeWorkerFailures ?? 0) > 0) {
		return { done: true, ok: false, exitCode: 85, reason: "claude-worker-failure" };
	}
	if (kind === "smoke-watch" && ((stats.codexHomeFailures ?? 0) > 0 || (stats.claudeWorkerFailures ?? 0) > 0)) {
		const exitCode = (stats.codexHomeFailures ?? 0) > 0 ? 83 : 85;
		return { done: true, ok: false, exitCode, reason: "smoke-failure" };
	}
	if (windowMinutes <= 0) {
		return { done: true, ok: true, exitCode: 0, reason: "skipped-zero-window" };
	}
	if (earlyExitOnCompletedRuns > 0 && (stats.completedRuns ?? 0) >= earlyExitOnCompletedRuns) {
		return { done: true, ok: true, exitCode: 0, reason: "early-exit-proven" };
	}
	if ((stats.elapsedSeconds ?? 0) >= windowMinutes * 60) {
		return {
			done: true,
			ok: true,
			exitCode: 0,
			reason: (stats.completedRuns ?? 0) > 0 ? "window-elapsed-with-runs" : "window-elapsed-no-runs",
		};
	}
	return { done: false, ok: true, exitCode: 0, reason: "watching" };
}
