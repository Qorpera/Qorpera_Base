# Usage Page Architecture

The Usage page reproduces the visual structure and interaction model of T3
Code's Usage page as of upstream commit
[`1a003e383ac6b10258b8100c2617d938c4f06c69`](https://github.com/pingdotgg/t3code/commit/1a003e383ac6b10258b8100c2617d938c4f06c69).
The adapted UI remains covered by T3 Code's MIT license, copied to
`packages/shell/userland/T3_CODE_LICENSE.txt`.

## Boundary

The page intentionally does not import T3 Code's backend architecture. T3 Code
discovers provider-owned transcript stores, queries multiple environments, and
deduplicates their results. Qorpera already has the company boundary it needs:
each company's `trail/*.jsonl` files contain normalized usage returned by its
model adapters.

The integration therefore has four Qorpera-owned parts:

- `readCompanyUsage()` aggregates only the active company's trail. It never
  reads provider home directories. Trail directories and session files must
  retain their physical identity while they are read; links fail closed.
  Unchanged trail files reuse a bounded, in-memory normalized-record cache
  keyed by physical file identity, size, and modification time. Changed and
  deleted files invalidate that read model. The cache is not a second durable
  usage store.
- `readUsageRateCatalog()` downloads the public LiteLLM model-rate document
  used by T3 Code. The document is cached for 24 hours in
  `~/.qorpera/agent/usage-model-rates.json`; no trail or company data is sent
  with that request.
- `GET /api/usage` exposes that aggregate to the fixed desktop shell as a
  read-only endpoint.
- The fixed shell's Settings view hosts the DOM view. Company files cannot
  publish a second usage page or replace its navigation.

The DOM implementation keeps the page layout, time-window selector, headline,
provider shares, daily chart, metric strip, loading state, and model/day
breakdowns. It does not add React, TanStack Router, Effect RPC, T3 environment
contracts, or T3's provider-specific scanners to Qorpera.

## Semantics

- Scope is the active company, not every Codex or Claude session on the device.
- Product worktree sessions remain in the company's root `trail/`, so they are
  included without scanning product repositories or provider-owned stores.
- Providers and models are discovered from trail records instead of being a
  fixed Codex/Claude union.
- Raw token cost uses T3 Code's arithmetic and LiteLLM fields: uncached input,
  cached input, cache creation, and output are multiplied by their per-token
  rates. Reasoning is already a subset of output and is not charged twice.
- Qorpera's recorded `usage.cost` is not used for assistant messages because it
  is adapter-calculated and can be zero for subscription-backed models. An
  explicit `costUSD` value is treated as provider-reported; otherwise the model
  is priced from LiteLLM.
- Missing or ambiguous models remain in token totals but contribute zero cost.
  A stale cached rate table is used when refresh fails; with no usable table,
  pricing is marked unavailable rather than guessed.
- Cache savings is calculated exactly as T3 Code does: cached input multiplied
  by the difference between the full input rate and cache-read rate.
- Dates are grouped in the browser's requested IANA time zone. Requests are
  limited to a 366-day inclusive window.

## Endpoint

`GET /api/usage?sinceDay=YYYY-MM-DD&untilDay=YYYY-MM-DD&timeZone=Area/City`
returns totals, dynamic provider and model breakdowns, daily buckets, rate-table
provenance, pricing coverage, cache savings, and parse diagnostics. Invalid
dates, time zones, reversed ranges, or oversized ranges return HTTP 400.
