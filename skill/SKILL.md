---
name: image-gen
description: Runs image operations through the `image-gen` CLI: text-to-image generation, single-image edits, multi-image composition, masked edits where supported, and multi-turn iterative editing through a small local session file. Default route is xAI Grok Imagine; OpenRouter routes are available as fallbacks. Use when the user asks for an image, illustration, concept art, product render, UI mockup, visual reference, style exploration, image edit/remix, multi-image blend, masked inpaint, or iterative refinement of a previous image.
license: MIT
compatibility: Requires the `image-gen` binary on PATH. Default Grok presets need `XAI_API_KEY`; OpenRouter presets and pass-through IDs need `OPENROUTER_API_KEY`. Keys may also live in the package-local `.env`.
allowed-tools: Bash
---

# image-gen

Use `image-gen` whenever a task needs a generated or edited image. It is one CLI for image operations: a single JSON object in, a single JSON object out, with the resulting file saved to disk.

## When to use it

Invoke this skill when the user asks for, implies, or would clearly benefit from:

- an illustration, concept image, scene, poster, mood board, or visual reference
- a product render, packaging concept, character/environment study, or photoreal composition
- a UI mockup, app screen concept, labeled interface draft, or visual design direction
- an edit, remix, or transform of an existing image
- a composition that blends multiple input images, transfers style, or combines references
- a masked edit that constrains changes to a specific region (xAI Grok models)
- iterative refinement across multiple turns, where each turn builds on the previous output

Do not force image generation into tasks that are really diagrams, charts, code, or written design specs unless the user asks for a rendered visual. If the user has already indicated they want an image and the remaining details are ambiguous, generate one strong first pass instead of asking setup questions.

## Operations

The CLI derives the operation from the request shape:

| Request shape | Operation |
| --- | --- |
| `prompt` only | `generate` |
| `prompt` + one `image_inputs` entry | `edit` |
| `prompt` + multiple `image_inputs` entries | `compose` |
| `prompt` + one `image_inputs` + `mask` | `mask_edit` (xAI Grok models only) |
| `prompt` + `session` | continuation; previous primary output becomes the source image unless `start_fresh` is true |

You can pass `operation` explicitly for clarity; the CLI validates it against the actual shape and returns a `validation_error` on mismatch.

## Model selection

Default to `grok` unless there is a clear reason not to. It is the cheap daily-driver route through xAI Grok Imagine.

| Model alias | Operations | Use for | Avoid when |
| --- | --- | --- | --- |
| `grok` | generate, edit, compose, mask_edit | Fast drafts, normal illustrations, first passes, visual exploration, cheap iteration | The image must contain accurate text or many tightly constrained elements |
| `grok-pro` | generate, edit, compose, mask_edit | Polished finals, image edits, text-heavy scenes, multi-image composition, masked inpainting, 2K requests | The user only needs a quick draft |
| `flux-pro` | generate | OpenRouter FLUX.2 Pro fallback when xAI is not configured | The task needs an image-input edit; flux-pro will reject it as a capability error |
| `nano-banana-2` | generate, edit, compose | Legacy OpenRouter compatibility with the previous default | Grok is configured and sufficient |
| `nano-banana-pro` | generate, edit, compose | Legacy OpenRouter pro compatibility | Grok Pro is configured and sufficient |
| `gpt-image` | generate, edit, compose | Reasoning-heavy composition, dense UI mockups, pixel-conscious layout | OpenRouter has not enabled the model yet; if it errors as unavailable, retry with `grok-pro` and say you used the fallback |

Use `grok` first for day-to-day work, then `grok-pro` for quality-sensitive work or any masked edit. Use OpenRouter routes deliberately. Keep `n` at `1` unless the user asks for variants or comparison is useful.

Before choosing a paid route in an unfamiliar environment, run `image-gen --status`. It reports configured providers, usable presets, and per-preset capability flags (image_inputs, multi_image, mask, session_continuation) without revealing secrets.

## Prompting guidance

Write image prompts as production briefs, not chatty requests. Include the subject, composition, medium, lighting, camera/viewpoint, mood, palette, and constraints that matter. Omit filler like "please" or "make me".

For UI mockups, specify the screen type, layout hierarchy, visual style, typography mood, color system, device/frame, and which text must appear. Prefer `grok-pro` for strict UI/layout prompts.

For edits, name the source image role and describe only the intended transformation. Example: "Use the reference as the product silhouette; preserve its proportions; replace the material with brushed aluminum; render on a warm studio background."

For multi-image composition with xAI Grok, refer to inputs by index: `<IMAGE_0>`, `<IMAGE_1>`, etc. Example: "Use `<IMAGE_0>` as the silhouette and `<IMAGE_1>` as the surface texture."

For masked edits, the mask should be a same-size PNG where white areas are editable and black areas are preserved. Describe only the change inside the masked region.

For text inside images, keep requested text short and exact. If text accuracy is critical, choose `grok-pro` and warn that image models can still misspell small text.

## Calling pattern

Run the CLI with a single JSON object by argv or stdin. Always inspect the JSON result before replying. Prefer stdin when the prompt comes from user text or contains quotes, apostrophes, or newlines; it avoids shell escaping mistakes.

Simple generation:

```bash
image-gen '{"prompt":"retrofuturist lunar workshop, warm task lighting, medium-format editorial photo, 16:9","model":"grok","aspect_ratio":"16:9"}'
```

Single-image edit:

```bash
image-gen '{"prompt":"turn the reference sketch into a clean product render; preserve the silhouette and proportions; use satin black metal and soft studio lighting","model":"grok-pro","image_inputs":["./sketch.png"]}'
```

Multi-image composition:

```bash
image-gen '{"prompt":"Use <IMAGE_0> as the silhouette and <IMAGE_1> as the surface; soft studio light","model":"grok-pro","image_inputs":["./silhouette.png","./material.jpg"]}'
```

Masked edit:

```bash
image-gen '{"prompt":"replace only the masked area with a navy textile","model":"grok-pro","image_inputs":["./photo.png"],"mask":"./mask.png"}'
```

Multi-turn session:

```bash
image-gen '{"prompt":"studio render of a brutalist espresso cup","session":{"path":"./session.json"},"model":"grok-pro"}'
image-gen '{"prompt":"now place it on a pale travertine surface, soft morning light","session":{"path":"./session.json"}}'
image-gen '{"prompt":"different direction: a chrome-finished cup","session":{"path":"./session.json","start_fresh":true}}'
```

Safer stdin pattern for quote-heavy or multi-line prompts:

```bash
image-gen <<'JSON'
{"prompt":"a bookstore called The Navigator's Desk, hand-painted sign, rainy evening street photo","model":"grok","aspect_ratio":"16:9"}
JSON
```

Useful input fields:

- `prompt` - required natural-language prompt
- `model` - preset alias, known xAI model ID, or full OpenRouter `vendor/slug`; defaults to `grok`
- `aspect_ratio` - `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `4:1`, `1:4`, `8:1`, `1:8`, `2:3`, `3:2`, `9:19.5`, `19.5:9`, `9:20`, `20:9`, `1:2`, `2:1`, or `auto`. xAI does not accept `4:1`, `1:4`, `8:1`, or `1:8`.
- `size` - model-specific hint such as `1024`, `1K`, `2K`, or `4K`; xAI maps supported hints to `1k` or `2k`
- `n` - number of images, 1-4
- `image_inputs` - local image paths or HTTPS URLs for edit/compose/mask_edit operations (preferred name)
- `reference_images` - legacy alias for `image_inputs`; do not combine with `image_inputs`
- `mask` - mask image for masked edits (xAI Grok only; one image_input required)
- `operation` - optional, validated against the request shape
- `session` - `{ "path": string, "start_fresh"?: boolean }` for multi-turn continuation
- `output` - explicit file path, or a directory only if it already exists or ends with `/`
- `output_dir` - directory for generated filenames when `output` is not set
- `system` - optional preamble for global style or policy constraints
- `seed` - passed through to OpenRouter when supported; not sent to xAI

Local image paths are read and sent as base64 data URIs. HTTPS URLs pass through. Plain HTTP URLs are rejected.

## Result handling

Successful output looks like:

```json
{"ok":true,"operation":"edit","path":"/abs/path/image.png","paths":["/abs/path/image.png"],"model":"grok-imagine-image-pro","alias":"grok-pro","provider":"xai","bytes":893000,"elapsed_ms":2840,"cost_usd":0.07,"prompt":"...","inputs":{"images":["/abs/in.png"],"mask":null},"session":null}
```

Use `path` for the primary image and `paths` when `n > 1`. Inspect `operation` to confirm what the call did, and `inputs` to confirm which sources the model saw. The `session` field returns the absolute session path, the new `turn` number, and the new `primary_output` after a continuation turn; treat it as the source of truth for follow-up calls.

Never paste base64 into the chat. Do not claim visual details you have not inspected; generation succeeded means the file exists, not that the composition is perfect.

In the final reply:

- state what operation ran and where the image was saved
- include cost and model only when useful or when the user cares about spend/model choice
- include Markdown image syntax if the current UI can render local paths
- still provide the absolute path, because some desktop/webview environments block arbitrary filesystem image loading

Portable presentation pattern:

```markdown
Generated image saved here: `/absolute/path/from/tool/output.png`

![generated image](/absolute/path/from/tool/output.png)
```

If the Markdown image appears broken in the UI, the saved file path is still the source of truth.

## Sessions

Sessions are local JSON files. They store prompts, model/provider info, output paths, and a `primary_output` pointer. They never store API keys or base64 image payloads.

- Pass `session.path` to enable continuation. The first call creates the file; later calls read it and continue.
- By default, the previous turn's `primary_output` is prepended to `image_inputs` for the next call. Empty `image_inputs` becomes a single-image edit; non-empty `image_inputs` becomes a multi-image compose.
- Pass `session.start_fresh: true` to skip pre-loading the previous output for that turn (useful for branching).
- If the session file is malformed or its previous primary output has been deleted, the CLI returns a `session_error` and does not call the provider.

## Errors and recovery

Failures return JSON with `ok:false`, `error`, and `code`.

- `auth_error` - tell the user the selected provider key is missing/invalid (`XAI_API_KEY` for Grok presets, `OPENROUTER_API_KEY` for OpenRouter presets); do not ask for the key in chat unless they volunteer to set it
- `validation_error` - fix the JSON, model alias, aspect ratio, output path, image input, mask, session shape, or operation hint and retry once
- `capability_error` - the chosen model cannot perform the requested operation. Switch to a model that can, or drop the unsupported field. The most common pattern is `mask` outside Grok or `image_inputs` on `flux-pro`.
- `session_error` - the session file is malformed or the previous primary output has been deleted. Either start a new session path, fix the file, or pass `start_fresh: true`.
- `api_error` - if the chosen model is unavailable, retry once with this fallback ladder: `grok-pro` -> `grok`, `flux-pro` -> `grok`, `gpt-image` -> `grok-pro`, legacy OpenRouter alias -> `grok`; otherwise summarize the provider error
- `network_error` - retry once if the task is important; mention timeout/connectivity if it fails again

Do not loop repeatedly on paid generations. One corrective retry is usually enough.

## Quality checklist before replying

Ask yourself:

1. Did I choose the cheapest model that can perform the requested operation?
2. Did the prompt include enough visual direction to avoid a generic result?
3. For edits/compose/mask_edit, did I pass the source images through `image_inputs`?
4. For masked edits, did I confirm the model supports masking before sending?
5. For multi-turn work, am I reusing the same session path across turns?
6. Did I avoid pasting base64 or assuming Markdown rendering works everywhere?
7. Did I give the user the exact saved path and any important caveat?

If the generated result is obviously a draft and the user wanted polish, offer the next concrete iteration rather than apologizing vaguely.
