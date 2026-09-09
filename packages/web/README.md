# Qorpera web client

This is the product web application. It uses member authentication and the shared `@qorpera/cloud-client` SDK; execution, storage authority and computer lifetime belong to the headless cloud runtime.

From the repository root, install with `npm install --ignore-scripts`, then run `npm run build --workspace=@qorpera/web` or `npm run dev --workspace=@qorpera/web`. Both commands build the SDK dependencies first. `npm run check` checks the web app separately with DOM types and verifies its executable dependency graph contains no runtime, provider or desktop implementation.

The conversation Computer panel discovers the company's computer, reads its state, submits an explicit start intent and opens an explicitly requested screen viewer. Viewer connections are bound to the current company, member, staff screen and physical generation. Closing the panel, changing company or signing out releases the viewer; it does not stop cloud work. Private or transitioning computers do not offer shared viewing. The renderer and noVNC source reuse the checksummed browser assets in `packages/member-web/ui`; the build verifies those hashes and includes the noVNC license.

Cloud configuration contains only public endpoints and a publishable key. `officeViewerOrigin` is an optional, separately configured `wss://` origin. It must have no credentials, path, query or fragment. The app does not infer it from an object gateway or accept it from a server response. Until the deployed viewer origin and CSP are verified, the default configuration intentionally leaves viewing unavailable. A local configuration override can supply the complete `CloudConfig` under `qorpera-web-cloud-config/v1` for an isolated preview.

## Acceptance status

This is an integration candidate, not launch acceptance. Agent desktop/shell grants, private browser preparation and consent, message/attachment writes, governed File operations and presence still need product UI integration and proof. Production HTTPS/CSP, normal human sign-in, actual screen viewing, revocation, client-independent work, NAS durability and governed reset remain live acceptance gates. The `packages/member-web` proof interface does not substitute for acceptance of this app.

macOS/Windows release and installation proofs are deferred until after the web launch, alongside Azure.
