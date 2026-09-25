# Pinned model data for CI

`.github/workflows/root-typecheck.yml` typechecks against this copy of the
generated model data. The provider model types in `packages/ai` are derived
from these files.

The real folder, `packages/ai/src/providers/data/`, is gitignored and hydrated
live from public model catalogs. Those catalogs rename and drop models, so
hydrating in CI would turn pull requests red for reasons unrelated to them.
This copy changes only when someone refreshes it on purpose.

It was generated on 2026-08-26 (`generatedAt` in `.manifest.json`).

## Refreshing

Refresh it when the workflow's model data check fails (a provider was added to
or removed from `packages/ai/src/models.generated.ts`), or when a change needs
newer models:

```bash
npm run hydrate:model-data
find .github/model-data -name '*.json' -delete
cp packages/ai/src/providers/data/*.json packages/ai/src/providers/data/.manifest.json .github/model-data/
```

Then run `npx tsgo --noEmit`: tests that name a model the catalogs have
dropped stop compiling.
