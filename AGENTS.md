# AGENTS.md - image-gen

## Overview

`image-gen` is a standalone JSON-first image generation CLI for agents. It accepts one JSON object by argv or stdin, calls OpenRouter's image-capable chat-completions API, writes the generated images to local disk, and emits one JSON success or failure object.

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

- Use `vitest` with mocked `fetch`; never hit OpenRouter in automated tests.
- Verify success and failure envelopes through `runCli(...)`.
- Cover alias resolution, input validation, request construction, data-URL decoding, filename planning, and output writing.

## Architecture

```text
cli.ts           # env loading, validation, model resolution, OpenRouter client, decoder, output envelopes, CLI entry
test/cli.test.ts # focused Vitest coverage with mocked fetch and temp directories
skill/SKILL.md   # packaged OpenCode skill copy
```

- Keep `cli.ts` single-file unless complexity clearly justifies a split.
- Organize it in this order: env loading, types, parsing and validation, OpenRouter client, decoder and file writing, output envelopes, CLI entry.

## Portability rule

- Resolve the package root from `import.meta.url`.
- If running from `dist/`, use `dist/..` as the package root.
- Load `.env` only from the package root.
- Never depend on the caller's working directory for config discovery.

## Key gotchas

- `modalities` must be `["image", "text"]` for Gemini and GPT-style text+image models, but `["image"]` for image-only families such as Flux.
- `image_config` belongs at the top level of the OpenRouter request body, not inside `messages`.
- Generated images come back as base64 data URLs and must be decoded before writing to disk.
- Explicit output filenames keep the caller's basename, but the extension must still match the decoded image MIME type.
- Default filenames must be `image-<iso-no-colons>-<8char-hash>.<ext>` inside the chosen output directory.
- Alias resolution order matters: known aliases first, then full `vendor/slug` passthrough, then error.

## Manual post-build symlinks

Do not run these automatically in this package. Documented here for the user to run once after build:

```bash
ln -s ~/.local/share/agent-tools/image-gen/dist/cli.js ~/.local/bin/image-gen
ln -s ~/.local/share/agent-tools/image-gen/skill/SKILL.md ~/.config/oco/skills/image-gen/SKILL.md
```
