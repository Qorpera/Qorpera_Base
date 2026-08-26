# Responsiveness research loop

The benchmark starts a packaged Qorpera Base app with an isolated profile, drives the renderer through Chrome DevTools Protocol, and writes a machine-readable report. It never uses or changes the installed app's profile.

## Measures

- Startup: debugger-ready, renderer-ready, DOM-content-loaded, load event, and first-contentful-paint when Chromium exposes it.
- Immediate interaction: feedback-modal and composer handler latency, plus the next painted frame.
- Conversation scale: visible rendering of 500, 1,000, and 2,000 alternating user/assistant messages.
- Agent thread load: conversation chrome plus complete transcript presentation at the same 500, 1,000, and 2,000-message scales.
- Agent sidepanel: open-handler, first-frame, complete-content, and close-handler latency with a 5,000-routine stress fixture.
- Sustained updates: appending 1,000 messages and idle event-loop lag.
- Resources: process-tree RSS, CPU, and process count.
- Capability guardrails: bridge/control/form/script counts; the rendered 2,000-message transcript's message, rewind-control, Markdown-list, and boundary-text fingerprint; and the sidepanel's title, routine counts, action handlers, state labels, and boundary titles.

Every latency is reported as min, p50, p95, p99, and max. Acceptance requires at least a 10× p95 speedup for agent-thread load, sidepanel handler return, and sidepanel first-frame response; exact capability fingerprints; no material median startup regression; and no material median full-sidepanel completion regression.

## Latest-release baseline

The baseline is the published Qorpera Base 0.20.40 arm64 macOS application, release asset SHA-256 `4c2ad4e2f8a4d0673cf9e48e3d21b83c4e5259db646ae987f24a86f27b12c241`, measured in five isolated runs on 2026-08-26.

The slowest interactive path was a visible 2,000-message history render: 10,784.5 ms p95. The 10× target is 1,078.45 ms. Other p95 results were 347.2 ms for 500 messages, 1,568.1 ms for 1,000 messages, 1,067.7 ms for appending 1,000 messages, 1.3 ms for the composer handler, and 1.1 ms idle event-loop lag. Renderer-ready startup was 3,759.0 ms p95.

## Run the loop

```sh
npm run profile:shell -- --app "/path/to/Qorpera Base" --runs 5 --output .artifacts/responsiveness/baseline.json
npm run profile:shell -- --app "/path/to/candidate/Qorpera Base" --runs 5 --baseline .artifacts/responsiveness/baseline.json --output .artifacts/responsiveness/candidate.json
```

The comparison exits nonzero until all acceptance conditions pass. Failed Electron launches are retried up to twice and are not counted as samples. Use the report's baseline target to profile the current bottleneck, make one capability-preserving change, rebuild the staged candidate, and rerun until acceptance passes.

## Current finding

Historical rendering appended each message to the visible transcript and immediately read `scrollHeight`, forcing layout after every insertion. The optimized renderer constructs the identical transcript in a detached `DocumentFragment`, attaches it once, runs live-DOM synchronization, and scrolls once.

In the final five-run comparison, the visible 2,000-message p95 fell from 10,784.5 ms to 85.0 ms: a 126.9× speedup. Exact capability fingerprints passed unchanged. Median renderer-ready startup changed from 2,827.7 ms to 2,596.8 ms, so the startup guard also passed.

## Agent surfaces

The v0.20.40 release baseline measured full agent-thread presentation at 10,784.5 ms p95, sidepanel open-handler response at 272.6 ms p95, and sidepanel first-painted-frame response at 334.0 ms p95. Their 10× targets were 1,078.45 ms, 27.26 ms, and 33.4 ms respectively.

The optimized five-run candidate measured 85.0 ms, 12.2 ms, and 29.2 ms p95: 126.9×, 22.3×, and 11.4× faster. Exact thread and sidepanel capability fingerprints passed. Large sidepanels now present their shell before constructing routine rows in a deferred detached pass; ordinary panels with at most 100 routines remain synchronous. Browser-native content visibility preserves all 5,000 routine rows while avoiding work for offscreen rows. Median complete sidepanel presentation improved from 261.3 ms to 222.4 ms, so the material-regression guard also passed.
