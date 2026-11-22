import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const WATCH_KINDS = new Set(["home-watch", "claude-watch", "smoke-watch"]);

export function dollarQuote(value, tagBase = null) {
	const text = String(value);
	if (text.includes("\0")) {
		throw new Error("dollarQuote cannot encode NUL bytes for PostgreSQL text");
	}
	const base =
		tagBase === null
			? `q_${createHash("sha256").update(text).digest("hex").slice(0, 12)}`
			: tagBase;
	if (typeof base !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(base)) {
		throw new Error(`Invalid dollarQuote tagBase: ${base}`);
	}
	let tag = `$${base}$`;
	let salt = 0;
	while (text.includes(tag.slice(0, -1))) {
		salt += 1;
		tag = `$${base}_${salt}$`;
	}
	return `${tag}${text}${tag}`;
}

export function buildAnchorCheckSql(anchors) {
	if (!Array.isArray(anchors)) {
		throw new Error("anchors must be an array");
	}
	if (!anchors.length) {
		return "select '[]'::jsonb as anchors;";
	}
	const rows = anchors.map((anchor, index) => {
		if (typeof anchor?.functionSignature !== "string" || anchor.functionSignature.length === 0) {
			throw new Error(`anchor[${index}].functionSignature must be a non-empty string`);
		}
		if (typeof anchor?.snippet !== "string" || anchor.snippet.length === 0) {
			throw new Error(`anchor[${index}].snippet must be a non-empty string`);
		}
		if (!Number.isSafeInteger(anchor?.expectedCount) || anchor.expectedCount < 0) {
			throw new Error(`anchor[${index}].expectedCount must be a non-negative integer`);
		}
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
		if (!present || !isDeepStrictEqual(actual, check.expected)) {
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

export function evaluateWatchTick({ kind, windowMinutes, earlyExitOnCompletedRuns }, stats = {}) {
	if (typeof kind !== "string" || !WATCH_KINDS.has(kind)) {
		throw new Error(`Invalid watch kind: ${kind}`);
	}
	if ((stats.codexHomeFailures ?? 0) > 0) {
		return { done: true, ok: false, exitCode: 83, reason: "codex-home-failure" };
	}
	if ((stats.claudeWorkerFailures ?? 0) > 0) {
		return { done: true, ok: false, exitCode: 85, reason: "claude-worker-failure" };
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
