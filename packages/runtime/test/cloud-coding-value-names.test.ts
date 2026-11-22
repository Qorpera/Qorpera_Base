import { describe, expect, it } from "vitest";
import { CODING_VALUE_REPOSITORY, codingValueNameAllowed } from "../src/cloud-coding-value-names.ts";

describe("cloud-coding-value-names", () => {
	it("allows company-owned OPENAI_* and ANTHROPIC_* variable names alongside standard secrets", () => {
		for (const name of [
			"openai_api_key",
			"openai_base_url",
			"openai_org_id",
			"anthropic_api_key",
			"anthropic_version",
			"npm_token",
			"stripe_secret_key",
			"database_url",
		]) {
			expect(codingValueNameAllowed(name), name).toBe(true);
		}
	});

	it("refuses host-internal and harness-internal prefixes and reserved variables", () => {
		for (const name of [
			"qorpera_token",
			"ld_preload",
			"dyld_insert_libraries",
			"git_dir",
			"ssh_auth_sock",
			"lc_all",
			"xdg_config_home",
			"docker_host",
			"claude_code_oauth_token",
			"codex_home",
			"home",
			"path",
			"https_proxy",
			"node_extra_ca_certs",
			"OPENAI_API_KEY",
			"bad-name",
			"",
		]) {
			expect(codingValueNameAllowed(name), name).toBe(false);
		}
	});

	it("matches lowercase owner/name repositories", () => {
		expect(CODING_VALUE_REPOSITORY.test("acme/web-app")).toBe(true);
		expect(CODING_VALUE_REPOSITORY.test("Acme/web-app")).toBe(false);
		expect(CODING_VALUE_REPOSITORY.test("acme")).toBe(false);
	});
});
