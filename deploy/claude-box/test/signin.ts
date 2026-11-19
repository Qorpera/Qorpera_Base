// C2i proof: the members' Claude sign-in (#1428) on a given Claude Code build, with NO real sign-in. The helper's own
// code (CodexSignIns over OfficialCliNativeHarnessDriver, in the vault helper's isolation: bwrap and the egress relay
// to Anthropic's sign-in hosts) starts the official `claude auth login --claudeai`, reads Anthropic's link out of what
// it prints and hands it a made-up code, which Anthropic then refuses. ENTRY_POINT `none` runs the same helper code
// without the isolation (the driver's own plain spawn), for a host whose node is not /usr/bin/node or whose relay
// reaches no network. `raw` runs the same command without the helper and prints what Claude Code itself printed
// before and after the code (the link's query values shortened). signin.sh and image.sh bundle it (esbuild) and run
// it as an unprivileged account in the login helper unit's hardening.
// Usage: node signin.bundle.mjs helper CLAUDE ENTRY_POINT|none ROOT | raw CLAUDE ROOT

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodexSignIns } from "../../../packages/runtime/src/cloud-model-login-sign-in.ts";
import { OfficialCliNativeHarnessDriver } from "../../../packages/runtime/src/cloud-native-provider-host.ts";

const [mode, claude, ...rest] = process.argv.slice(2);

/** A made-up code in Anthropic's shape (`<code>#<state>`), with the state of the link Claude Code printed. */
function madeUpCode(link: string | undefined): string {
	const state = link ? new URL(link).searchParams.get("state") : null;
	return `c2i-made-up-${randomBytes(12).toString("hex")}${state ? `#${state}` : ""}`;
}

/** The link without its long query values (a PKCE challenge and a state; neither is a secret, both are noise). */
function shortLink(text: string): string {
	return text.replace(/=([A-Za-z0-9_-]{12})[A-Za-z0-9_%.-]*/g, "=$1...");
}

async function helper(entryPoint: string, root: string): Promise<void> {
	const signIns = new CodexSignIns({
		driver: new OfficialCliNativeHarnessDriver(
			"/nonexistent/codex",
			claude,
			entryPoint === "none" ? undefined : { entryPoint },
			{ scratchParent: root },
		),
		temporaryRoot: root,
		claude: true,
	});
	const binding = {
		signInId: randomUUID(),
		companyId: randomUUID(),
		computeIdentityId: randomUUID(),
		capabilitySha256: randomBytes(32).toString("hex"),
		expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		harness: "claude-code" as const,
	};
	const signal = new AbortController().signal;
	const t0 = Date.now();
	let state = await signIns.beginSignIn(binding, signal);
	while (state.status === "preparing" && Date.now() - t0 < 30_000) state = await signIns.beginSignIn(binding, signal);
	const link = state.status === "awaiting_member" ? state.interactionUrl : undefined;
	console.log(
		`SIGNIN-PROMPT ${JSON.stringify({ ms: Date.now() - t0, status: state.status, ...(state.status === "failed" ? { reason: state.reason } : {}), interactionUrl: link ? shortLink(link) : undefined, host: link ? new URL(link).host : undefined, userCode: state.status === "awaiting_member" ? (state.userCode ?? null) : undefined })}`,
	);
	if (state.status === "awaiting_member") {
		const t1 = Date.now();
		const after = await signIns.submitCode(
			{ signInId: binding.signInId, companyId: binding.companyId, code: madeUpCode(link) },
			signal,
		);
		console.log(
			`SIGNIN-AFTER-CODE ${JSON.stringify({ ms: Date.now() - t1, status: after.status, ...(after.status === "failed" ? { reason: after.reason } : {}) })}`,
		);
	}
	await signIns.close();
}

async function raw(root: string): Promise<void> {
	const home = mkdtempSync(join(root, "raw-"));
	const child = spawn(claude, ["auth", "login", "--claudeai"], {
		cwd: home,
		env: {
			PATH: "/usr/bin:/bin",
			HOME: home,
			CLAUDE_CONFIG_DIR: home,
			DISABLE_AUTOUPDATER: "1",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			TERM: "dumb",
			NO_COLOR: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let out = "";
	let err = "";
	child.stdout.setEncoding("utf8").on("data", (text: string) => {
		out += text;
	});
	child.stderr.setEncoding("utf8").on("data", (text: string) => {
		err += text;
	});
	const exited = new Promise<number | string>((resolve) =>
		child.once("close", (code, signal) => resolve(code ?? signal ?? "?")),
	);
	await new Promise((resolve) => setTimeout(resolve, 8000));
	console.log(`RAW-BEFORE-CODE stdout: ${JSON.stringify(shortLink(out))}`);
	console.log(`RAW-BEFORE-CODE stderr: ${JSON.stringify(shortLink(err))}`);
	const link = out.match(/https:\/\/[^\s<>'"`]+/)?.[0];
	const before = out.length;
	const beforeErr = err.length;
	child.stdin.end(`${madeUpCode(link)}\n`);
	const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 30_000))]);
	console.log(`RAW-AFTER-CODE exit: ${code}`);
	console.log(`RAW-AFTER-CODE stdout: ${JSON.stringify(shortLink(out.slice(before)))}`);
	console.log(`RAW-AFTER-CODE stderr: ${JSON.stringify(shortLink(err.slice(beforeErr)))}`);
	child.kill("SIGKILL");
	rmSync(home, { recursive: true, force: true });
}

if (mode === "helper") await helper(rest[0] as string, rest[1] as string);
else await raw(rest[0] as string);
console.log("SIGNIN-END");
