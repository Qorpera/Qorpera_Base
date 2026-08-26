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

The baseline is the published Qorpera Base 0.20.33 arm64 macOS application, release asset SHA-256 `fb5091a81431b6132a79f6b9445f7e2b2ba548fc303f85bbd7e2985a5241d689`, measured in five isolated runs on 2026-08-26.

The slowest interactive path was a visible 2,000-message history render: 5,459.2 ms p95. The 10× target is 545.92 ms. Other p95 results were 251.2 ms for 500 messages, 997.6 ms for 1,000 messages, 260.3 ms for appending 1,000 messages, 0.5 ms for the composer handler, and 1.1 ms idle event-loop lag. Renderer-ready startup was 2,400.8 ms p95.

## Run the loop

```sh
npm run profile:shell -- --app "/path/to/Qorpera Base" --runs 5 --output .artifacts/responsiveness/baseline.json
npm run profile:shell -- --app "/path/to/candidate/Qorpera Base" --runs 5 --baseline .artifacts/responsiveness/baseline.json --output .artifacts/responsiveness/candidate.json
```

The comparison exits nonzero until all acceptance conditions pass. Failed Electron launches are retried up to twice and are not counted as samples. Use the report's baseline target to profile the current bottleneck, make one capability-preserving change, rebuild the staged candidate, and rerun until acceptance passes.

## Current finding

Historical rendering appended each message to the visible transcript and immediately read `scrollHeight`, forcing layout after every insertion. The optimized renderer constructs the identical transcript in a detached `DocumentFragment`, attaches it once, runs live-DOM synchronization, and scrolls once.

In the final five-run comparison, the visible 2,000-message p95 fell from 5,459.2 ms to 79.2 ms: a 68.9× speedup. Both capability fingerprints passed unchanged. Median renderer-ready startup changed from 2,298.0 ms to 1,865.6 ms, so the startup guard also passed.

## Agent surfaces

The second five-run release baseline measured full agent-thread presentation at 4,187.0 ms p95, sidepanel open-handler response at 176.0 ms p95, and sidepanel first-frame response at 201.2 ms p95. Their 10× targets were 418.7 ms, 17.6 ms, and 20.12 ms respectively.

The optimized five-run candidate measured 65.0 ms, 6.7 ms, and 15.3 ms p95: 64.4×, 26.3×, and 13.2× faster. Exact thread and sidepanel capability fingerprints passed. Large sidepanels now present their shell before constructing routine rows in detached, cancellable batches; ordinary panels with at most 100 routines remain synchronous. Full 5,000-row completion stayed within the material-regression guard, while work is split so the first frame is no longer blocked by the complete list.
