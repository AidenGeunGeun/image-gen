# AGENTS.md - image-gen

## Overview

`image-gen` is a standalone JSON-first image-operation CLI for agents. It accepts one JSON object by argv or stdin, derives the operation (generate, edit, compose, mask_edit), enforces capability rules before any network call, routes Grok presets through xAI and OpenRouter presets/pass-through IDs through OpenRouter, writes generated images to local disk, optionally maintains a small local session file for multi-turn edits, and emits one JSON success or failure object.

## Setup

```bash
npm install
npm run build --workspace=packages/image-gen
```

## Commands

```bash
npm run build --workspace=packages/image-gen
npm run typecheck --workspace=packages/image-gen
npm run clean --workspace=packages/image-gen
npm run test --workspace=packages/image-gen
```

## Testing approach

- Use `vitest` with mocked `fetch`; never hit xAI or OpenRouter in automated tests.
- Verify success and failure envelopes through `runCli(...)`.
- Cover alias resolution, input validation, request construction, per-model timeout wiring, data-URL decoding, filename planning, and output writing.

## Architecture

```text
cli.ts           # env loading, validation, model/provider resolution, capability checks, session helpers, provider clients, decoder, output envelopes, CLI entry
test/cli.test.ts # focused Vitest coverage with mocked fetch and temp directories
skill/SKILL.md   # packaged OpenCode skill copy
```

- Keep `cli.ts` single-file unless complexity clearly justifies a split.
- Organize it in this order: env loading, types, parsing and validation, capability checks, session helpers, provider clients, decoder and file writing, output envelopes, CLI entry.

## Portability rule

- Resolve the package root from `import.meta.url`.
- If running from `dist/`, use `dist/..` as the package root.
- Load `.env` only from the package root.
- Never depend on the caller's working directory for config discovery.

## Key gotchas

- Grok presets route through xAI images endpoints and should request `response_format: "b64_json"` so output is local-file friendly.
- xAI image edit body uses `image: { url }` for one input and `images: [{ url }]` for multi-image, with optional `mask: { url }`. Do not add a `type` field — it is not part of the documented schema.
- xAI does not document `seed`; the CLI must not send it.
- xAI cost is reported as `usage.cost_in_usd_ticks` where 1 USD = 10,000,000,000 ticks.
- xAI accepts a narrower aspect-ratio set than OpenRouter (no `4:1`, `1:4`, `8:1`, `1:8`); validate per-provider.
- `modalities` must be `["image", "text"]` for Gemini, Seedream, and GPT-style OpenRouter models, but `["image"]` for image-only families such as Flux and Recraft.
- `image_config` belongs at the top level of the OpenRouter request body, not inside `messages`.
- Generated images come back as base64 data URLs and must be decoded before writing to disk.
- Explicit output filenames keep the caller's basename, but the extension must still match the decoded image MIME type.
- Default filenames must be `image-<iso-no-colons>-<8char-hash>.<ext>` inside the chosen output directory.
- Alias resolution order matters: removed aliases first (`gpt-image` must return a clean 0.3.0 removal error), then known aliases, then known xAI model IDs, then full `vendor/slug` passthrough, then error.
- Built-in aliases for 0.3.0 are `grok`, `grok-pro`, `flux-pro`, `nano-banana-2`, `nano-banana-pro`, `seedream`, `flux-klein`, and `recraft`. `nano-banana-2` remains the recommended balanced OpenRouter default for most workloads.
- Capability checks run before session resolution and before any network call. Mask is only supported on xAI Grok models. Recraft supports only one image input. Pass-through models report `unknown` capability and reject `mask`.
- Provider requests use per-model timeouts instead of one flat value. xAI and fast/economy OpenRouter routes stay around 60-90 seconds, `flux-pro` uses 120 seconds, `nano-banana-pro` uses 180 seconds, and pass-through `vendor/slug` models default to 210 seconds. Surface timeout values in `--list-models` and `--status` when changing presets.
- Session writes must be atomic: write to `.tmp` then rename. Sessions never store API keys or base64 image payloads.

## Manual post-build symlinks

Do not run these automatically in this package. Documented here for the user to run once after build:

```bash
ln -s ~/.local/share/agent-tools/image-gen/dist/cli.js ~/.local/bin/image-gen
ln -s ~/.local/share/agent-tools/image-gen/skill/SKILL.md ~/.config/oco/skills/image-gen/SKILL.md
```
