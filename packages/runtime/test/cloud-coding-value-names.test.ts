import { describe, expect, it } from "vitest";
import { codingValueNameAllowed } from "../src/cloud-coding-value-names.ts";

describe("codingValueNameAllowed", () => {
	it("allows company-owned AI provider and application environment secret names", () => {
		for (const name of [
			"openai_api_key",
			"openai_base_url",
			"openai_org_id",
			"anthropic_api_key",
			"anthropic_base_url",
			"npm_token",
			"database_url",
			"stripe_secret_key",
			"a",
			`x${"1".repeat(63)}`,
		]) {
			expect(codingValueNameAllowed(name), name).toBe(true);
		}
	});

	it("refuses host-internal, harness-internal, reserved, and malformed names", () => {
		for (const name of [
			"qorpera_token",
			"ld_preload",
			"dyld_insert_libraries",
			"git_dir",
			"git_token",
			"ssh_auth_sock",
			"lc_all",
			"xdg_config_home",
			"docker_host",
			"claude_code_oauth_token",
			"codex_home",
			"home",
			"path",
			"tmpdir",
			"https_proxy",
			"node_extra_ca_certs",
			"OPENAI_API_KEY",
			"npm-token",
			"1abc",
			"_x",
			"",
			`x${"1".repeat(64)}`,
		]) {
			expect(codingValueNameAllowed(name), name).toBe(false);
		}
	});
});
