# Company folders

A company is a small, portable home for agents. Operational data stays in
the services the company connects to. Credentials stay in the trusted local or
cloud secret store and are referenced by opaque names; they are never written
into the company folder.

## Genesis

`qorpera company init [dir]` creates an idempotent agents-only company:

```text
<company>/
  .qorpera/
    company.json       # stable company identity and optional fork parent
    staff.json         # agent registry
    settings.json      # runtime retention and transport settings
  agents/               # one private workspace per agent
    <agent-id>/
      instructions.md
      artifacts/        # measures and evidence this agent owns
  connectors/           # executable, provider-neutral connector recipes
  files/                # shared files agents may organize as needed
  inbox/messages/       # durable user-facing questions and notices
  trail/                # append-only conversations and autonomous runs
```

Suggested agents and their starter artifacts are product templates, not
company state. Creating a suggested agent copies the selected starter into its
workspace. A blank agent starts without responsibilities or artifacts and
discovers them during setup.

The old universal controller files (`AGENTS.md`, `CLAUDE.md`, `company.md`),
company-owned shell (`app/`), projection document, surfaces, substrates, and
global artifact folder are not part of genesis or the runtime contract.

## Agent lifecycle

Each agent has a silent lifecycle value:

- `setup`: proactively seeks a useful responsibility, checks existing files
  and connectors, identifies missing data for its artifacts, proposes the
  smallest useful connection, and asks about recurring work.
- `active`: ordinary worker behavior with no setup-specific prompting.
- `archived`: retained but not active. Permanent deletion remains available.

The agent completes its own setup once it has a concrete responsibility and
the data access needed to begin useful work. The lifecycle is behavioral state,
not a status badge in the UI.

## Connectors and credentials

Connector manifests live under `connectors/` and belong to the company. Agents
may create a manifest and its implementation when support does not already
exist. A manifest defines ownership, operations, access level, destinations,
authentication shape, and the executable entrypoint.

Execution is brokered by the desktop host:

1. The agent selects or creates a connector recipe.
2. The host resolves opaque secret references from the trusted secret store.
3. OAuth or browser setup is driven by the agent through controlled Chrome
   until the first real sign-in, MFA, identity, or consent boundary.
4. The user completes only that private boundary.
5. The agent verifies the first real read before the connection becomes ready.

Moving or copying a company locally preserves credential bindings for the same
company ID on that OS account. Creating a new company produces a new ID and
does not inherit credentials. An explicit passphrase-encrypted export/import
can rewrap the same company's credentials under another local OS protector;
the bundle is company-ID-bound and contains neither plaintext names nor values.
A configured cloud secret store may provide the equivalent rewrapping path.
Raw secrets remain outside company files in every case.

## Artifacts

Artifacts live inside the responsible agent's workspace. They are editable
scorecards, not generated mini-apps. An artifact defines measures, targets,
data needs, evidence references, observations, and optional scores.

A metric becomes measured only through an actual connector or file observation
with source evidence and an observation time. Updating a definition cannot
manufacture observed values. Observations remain chronological and retain
point-level provenance; an older backfill cannot replace the newer current
value.

## Routines

Agents create and manage their own recurring work through named routines.
Routines support schedules, GitHub events, and custom adapter triggers. Chat
defaults to low reasoning effort; scheduled work defaults to high effort, with
an explicit per-routine override.

Routine definitions and run history are host-managed read models. The company
folder retains the agent work and trail needed to explain the outcome without
storing provider credentials or service-owned datasets.

## Trusted host boundary

The Electron desktop host remains a security and persistence boundary. It owns
model requests, secret resolution, browser/computer capabilities, effect
review, process isolation, and append-only trail envelopes. This is not a
universal company agent and it contributes no company persona or goals.

The fixed shell is host-owned and exposes only fixed navigation plus native
agent, artifact, routine, connector, inbox, and activity views. Company files
cannot publish navigation or executable UI.

Product-development storage and company fork/export operations remain optional
capabilities. They are not materialized at company conception and should not be
treated as the company ontology.
