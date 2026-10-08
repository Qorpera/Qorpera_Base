# Provider capability and compliance matrix

**Checked:** 2026-08-20. Technical support is not commercial authorization.
The OpenAI and Anthropic native-subscription implementations are enabled for
this deployment under the deployment operator's confirmed provider terms.
Deployment owners remain responsible for retaining the applicable approval or
commercial record and may disable either policy without removing its contract.

| Provider mode | Native technical path | Hosted multi-tenant status | Qorpera launch status |
| --- | --- | --- | --- |
| OpenAI API-funded | Responses/API SDK or Codex with API-key authentication | Standard server-side API use is documented; customer API organization policies and billing apply | Supported after ordinary API security, billing, and data controls |
| OpenAI ChatGPT Enterprise service account | Native Codex CLI/App Server/SDK with a scoped, expiring service-account access token on a trusted private runner | OpenAI documents service accounts and access tokens for noninteractive trusted runners; a Qorpera-managed multi-tenant deployment still requires the customer's Enterprise controls and confirmation that the proposed custody/isolation model is covered | Eligible for a controlled enterprise integration after contractual/security approval; not a silent fallback |
| OpenAI ChatGPT Free/Go/Plus/Pro/Business member login | Native Codex clients support ChatGPT sign-in and device auth; App Server is the native embedding surface | The deployment must operate within the provider terms or approval applicable to its hosted isolation and credential-custody model | Enabled for this deployment; member consent, exact sponsor pinning, native-harness isolation, and one-connection concurrency remain mandatory |
| Anthropic API / Bedrock / Vertex AI | Native Claude Code with API key or supported enterprise cloud authentication | Anthropic's commercial agreement applies to API and supported cloud-provider traffic | Supported after ordinary commercial, vault, and tenant controls |
| Anthropic Free/Pro/Max subscription OAuth | Native Claude Code technically supports subscription OAuth through the provider-native harness and the durable personal-subscription contract remains implemented | The deployment must operate within the provider terms or approval applicable to its hosted isolation and credential-custody model | Enabled for this deployment; member consent, exact sponsor pinning, native-harness isolation, and one-connection concurrency remain mandatory |
| Anthropic Team/Enterprise native OAuth | Native Claude Code supports subscription OAuth and managed settings | The deployment must operate within its approved commercial path and managed-account controls | Enabled when the exact deployment approval and account controls cover the connection; never a silent fallback |
| Google Gemini API / Vertex AI | Gemini CLI supports API keys, ADC, and service accounts; service accounts are documented for noninteractive environments | Standard Google Cloud/API deployment with customer project and IAM | Supported after ordinary commercial, vault, IAM, and data controls |
| Google consumer/individual CLI OAuth | Native Gemini CLI supports Google sign-in | Official product documentation does not establish third-party hosted credential custody; current Code Assist documentation also says individual/AI Pro/AI Ultra CLI serving ended on 2026-06-18 | Unsupported; do not offer as hosted subscription execution |
| xAI API / enterprise | xAI API and management APIs | xAI Enterprise terms permit business API integrations subject to the agreement | Supported after ordinary commercial, vault, and tenant controls |
| xAI consumer Grok account | No approved Qorpera native coding harness | xAI's consumer acceptable-use policy prohibits automated/non-human access; API billing is separate from Grok subscription billing | Prohibited; remove the product claim that a Grok account funds hosted agents |

## Primary sources

- OpenAI: [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex App Server](https://learn.chatgpt.com/docs/app-server), and [Enterprise service accounts](https://learn.chatgpt.com/docs/enterprise/service-accounts).
- Anthropic: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started), and [Claude Code settings](https://code.claude.com/docs/en/settings).
- Google: [Gemini CLI authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx) and [Gemini Code Assist product availability](https://developers.google.com/gemini-code-assist/docs/write-code-gemini).
- xAI: [Consumer acceptable-use policy](https://x.ai/legal/acceptable-use-policy), [Enterprise terms](https://x.ai/legal/terms-of-service-enterprise), and [API account FAQ](https://docs.x.ai/developers/faq/accounts).

## Required connection record

Every provider connection must record its member/company/scoped compute-identity
ownership, provider account identifier, authentication mode,
subscription/seat or API billing source, consent version, native harness,
allowed attended/autonomous modes, opaque encrypted-capsule reference,
created/revoked timestamps, and current quota or reauthentication state.

The trusted computer-side bridge receives a short-lived capsule lease and may
unwrap it only for the unmodified provider-native harness. Application and
control-plane code never receives the plaintext credential. This is not a
claim that the infrastructure operator is cryptographically blind to an
unattested VM; such a claim requires deployed and verified confidential
compute. Revocation, sponsor handoff, user removal, quota exhaustion, or
provider-policy change invalidates future leases. Existing run history retains
the original sponsor, provider, credential ownership, and compute identity.

Technical exception authorized on 2026-08-28: the pinned Codex callback (the
result fence; since 2026-10-06 also context composition and the prompt cache
key, each with its own marker) and cloud-fenced direct-tool selection
documented in
[`../deploy/first-node/native-codex/README.md`](../deploy/first-node/native-codex/README.md)
may be used after its runtime gates pass. Native login and provider traffic
remain inside the same credential boundary; no subscription proxy is added.
This technical approval does not itself establish new commercial rights or
complete the real-provider acceptance gate. Claude remains unmodified.
