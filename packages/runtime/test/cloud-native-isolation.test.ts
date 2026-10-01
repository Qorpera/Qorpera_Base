import { NATIVE_CHATGPT_PLAN_EGRESS_HOSTS, NATIVE_CODEX_EGRESS_HOSTS } from "@qorpera/runtime/cloud-native-egress";
import {
	CHATGPT_PLAN_TOKEN_ENVIRONMENT,
	nativeIsolationEgressHosts,
	nativeIsolationInvocation,
} from "@qorpera/runtime/cloud-native-isolation";
import { expect, it } from "vitest";

const scratch = "/run/qorpera/runs/abc/runtime";
const base = {
	configuration: { entryPoint: "/opt/qorpera-runner/qorpera-native-isolation-child.mjs" },
	command: "/opt/qorpera-runner/codex",
	args: ["app-server", "--strict-config"],
	scratchRoot: scratch,
	codexHome: "/run/qorpera/identity/codex",
	relayPath: `${scratch}/egress.sock`,
	fenceSocket: `${scratch}/fence.sock`,
};

it("gives a Codex login's run exactly the namespace it had before plan runs existed", () => {
	expect(nativeIsolationInvocation(base)).toEqual({
		args: [
			"--unshare-user",
			"--unshare-pid",
			"--unshare-net",
			"--unshare-ipc",
			"--unshare-uts",
			"--unshare-cgroup",
			"--disable-userns",
			"--assert-userns-disabled",
			"--die-with-parent",
			"--new-session",
			"--cap-drop",
			"ALL",
			"--clearenv",
			"--ro-bind",
			"/usr",
			"/usr",
			"--symlink",
			"usr/bin",
			"/bin",
			"--symlink",
			"usr/lib",
			"/lib",
			"--symlink",
			"usr/lib64",
			"/lib64",
			"--ro-bind",
			"/etc/ssl/certs",
			"/etc/ssl/certs",
			"--ro-bind",
			"/etc/ld.so.cache",
			"/etc/ld.so.cache",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--size",
			"67108864",
			"--tmpfs",
			"/tmp",
			"--ro-bind",
			base.command,
			base.command,
			"--ro-bind",
			base.configuration.entryPoint,
			"/qorpera/native-entry.mjs",
			...["workspace", "home", "config", "data", "cache"].flatMap((name) => [
				"--bind",
				`${scratch}/${name}`,
				`${scratch}/${name}`,
			]),
			"--bind",
			base.codexHome,
			base.codexHome,
			"--ro-bind",
			base.relayPath,
			base.relayPath,
			"--ro-bind",
			base.fenceSocket,
			base.fenceSocket,
			"--setenv",
			"HOME",
			`${scratch}/home`,
			"--setenv",
			"CODEX_HOME",
			base.codexHome,
			"--setenv",
			"XDG_CONFIG_HOME",
			`${scratch}/config`,
			"--setenv",
			"XDG_DATA_HOME",
			`${scratch}/data`,
			"--setenv",
			"XDG_CACHE_HOME",
			`${scratch}/cache`,
			"--setenv",
			"PATH",
			"/usr/bin:/bin",
			"--setenv",
			"LANG",
			"C.UTF-8",
			"--setenv",
			"TZ",
			"UTC",
			"--setenv",
			"NO_COLOR",
			"1",
			"--setenv",
			"QORPERA_NATIVE_RESULT_FENCE_SOCKET",
			base.fenceSocket,
			"--chdir",
			`${scratch}/workspace`,
			"--remount-ro",
			"/",
			"--",
			"/usr/bin/node",
			"/qorpera/native-entry.mjs",
			base.relayPath,
			base.command,
			...base.args,
		],
		environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
	});
	expect(nativeIsolationEgressHosts(undefined)).toBe(NATIVE_CODEX_EGRESS_HOSTS);
});

it("binds a plan run's token directory read-only at its own path, and reaches OpenAI's API alone", () => {
	const directory = "/run/qorpera/identity/chatgpt-plan";
	const plan = nativeIsolationInvocation({ ...base, chatGptPlan: { directory } });
	const codex = nativeIsolationInvocation(base);
	// The one difference: the directory, bound read-only as a directory so a renamed-in token shows.
	const bind = plan.args.indexOf(directory);
	expect(plan.args.slice(bind - 1, bind + 2)).toEqual(["--ro-bind", directory, directory]);
	expect([...plan.args.slice(0, bind - 1), ...plan.args.slice(bind + 2)]).toEqual(codex.args);
	expect(plan.environment).toEqual(codex.environment);
	expect(nativeIsolationEgressHosts({ directory })).toBe(NATIVE_CHATGPT_PLAN_EGRESS_HOSTS);
});

it("gives the fallback's token to bwrap's environment, never to an argument, and keeps it out of a cleared one", () => {
	const accessToken = "plan.access-token_1";
	const fallback = nativeIsolationInvocation({ ...base, chatGptPlan: { accessToken } });
	const codex = nativeIsolationInvocation(base);
	expect(fallback.args.some((argument) => argument.includes(accessToken))).toBe(false);
	// No --clearenv, so the namespace inherits bwrap's environment: exactly PATH, LANG and the token.
	expect(fallback.args).toEqual(codex.args.filter((argument) => argument !== "--clearenv"));
	expect(fallback.environment).toEqual({
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		[CHATGPT_PLAN_TOKEN_ENVIRONMENT]: accessToken,
	});
	expect(nativeIsolationEgressHosts({ accessToken })).toBe(NATIVE_CHATGPT_PLAN_EGRESS_HOSTS);
	for (const bad of ["", "two words", "line\nbreak", "x".repeat(16_385)])
		expect(() => nativeIsolationInvocation({ ...base, chatGptPlan: { accessToken: bad } })).toThrow(
			"Invalid ChatGPT plan access token",
		);
});
