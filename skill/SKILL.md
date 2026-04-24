---
name: image-gen
description: Generates images with the `image-gen` CLI via OpenRouter and returns local files agents can use. Use when the user asks for an image, illustration, concept art, product render, UI mockup, visual reference, style exploration, image edit/remix, or a task that clearly requires a rendered visual artifact.
license: MIT
compatibility: Requires the `image-gen` binary on PATH and an OpenRouter API key available as `OPENROUTER_API_KEY` or in the package-local `.env`.
allowed-tools: Bash
---

# image-gen

Use `image-gen` to create or edit images from any agent that can run shell commands. The tool is deliberately boring: one JSON object in, one JSON object out, with generated images saved to disk.

## When to use it

Invoke this skill when the user asks for, implies, or would clearly benefit from:

- an illustration, concept image, scene, poster, mood board, or visual reference
- a product render, packaging concept, character/environment study, or photoreal composition
- a UI mockup, app screen concept, labeled interface draft, or visual design direction
- an edit/remix of existing images using local files or HTTPS image URLs as references
- several visual variants where comparing images beats describing options in text

Do not force image generation into tasks that are really diagrams, charts, code, or written design specs unless the user asks for a rendered visual. If the user has already indicated they want an image and the remaining details are ambiguous, generate one strong first pass instead of asking setup questions.

## Model selection

Default to `nano-banana-2` unless there is a clear reason not to.

| Model alias | Use for | Avoid when |
| --- | --- | --- |
| `nano-banana-2` | Fast drafts, normal illustrations, first passes, visual exploration, cheap iteration | The image must contain accurate text or many tightly constrained elements |
| `nano-banana-pro` | Polished finals, image edits, text-heavy scenes, multiple subjects, 2K/4K requests, higher coherence | The user only needs a quick draft |
| `gpt-image` | Reasoning-heavy composition, dense UI mockups, pixel-conscious layout, strict constraints | OpenRouter has not enabled the model yet; if it errors as unavailable, retry with `nano-banana-pro` and say you used the fallback |

Cost discipline matters. `nano-banana-pro` is usually meaningfully more expensive than `nano-banana-2`; use it deliberately. Keep `n` at `1` unless the user asks for variants or comparison is useful.

## Prompting guidance

Write image prompts as production briefs, not chatty requests. Include the subject, composition, medium, lighting, camera/viewpoint, mood, palette, and constraints that matter. Omit filler like "please" or "make me".

For UI mockups, specify the screen type, layout hierarchy, visual style, typography mood, color system, device/frame, and which text must appear. Prefer `gpt-image` for strict UI/layout prompts; fall back to `nano-banana-pro` if unavailable.

For edits, name the source image role and describe only the intended transformation. Example: "Use the reference as the product silhouette; preserve its proportions; replace the material with brushed aluminum; render on a warm studio background."

For text inside images, keep requested text short and exact. If text accuracy is critical, choose `nano-banana-pro` and warn that image models can still misspell small text.

## Calling pattern

Run the CLI with a single JSON object by argv or stdin. Always inspect the JSON result before replying. Prefer stdin when the prompt comes from user text or contains quotes, apostrophes, or newlines; it avoids shell escaping mistakes.

Simple generation:

```bash
image-gen '{"prompt":"retrofuturist lunar workshop, warm task lighting, medium-format editorial photo, 16:9","model":"nano-banana-2","aspect_ratio":"16:9"}'
```

Polished render with an explicit destination:

```bash
image-gen '{"prompt":"minimal ceramic desk lamp product render, softbox lighting, matte ivory finish, pale limestone surface","model":"nano-banana-pro","output_dir":"./generated"}'
```

Edit/remix from references:

```bash
image-gen '{"prompt":"turn the reference sketch into a clean product render; preserve the silhouette and proportions; use satin black metal and soft studio lighting","model":"nano-banana-pro","reference_images":["./sketch.png"]}'
```

Safer stdin pattern for quote-heavy or multi-line prompts:

```bash
image-gen <<'JSON'
{"prompt":"a bookstore called The Navigator's Desk, hand-painted sign, rainy evening street photo","model":"nano-banana-2","aspect_ratio":"16:9"}
JSON
```

Useful input fields:

- `prompt` - required natural-language prompt
- `model` - alias or full OpenRouter `vendor/slug`; defaults to `nano-banana-2`
- `aspect_ratio` - `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `4:1`, `1:4`, `8:1`, or `1:8`
- `size` - model-specific hint such as `1024`, `2K`, or `4K`
- `n` - number of images, 1-4
- `reference_images` - local image paths or HTTPS image URLs
- `output` - explicit file path, or a directory only if it already exists or ends with `/`
- `output_dir` - directory for generated filenames when `output` is not set
- `system` - optional preamble for global style or policy constraints
- `seed` - passed through when supported

Local reference paths are read and sent as base64 data URLs. HTTPS references pass through. Plain HTTP references are rejected.

## Result handling

Successful output looks like:

```json
{"ok":true,"path":"/abs/path/image.jpg","paths":["/abs/path/image.jpg"],"model":"google/gemini-3.1-flash-image-preview","alias":"nano-banana-2","provider":"openrouter","bytes":893000,"elapsed_ms":2840,"cost_usd":0.068795,"prompt":"..."}
```

Use `path` for a single image and `paths` when `n > 1`. Never paste base64 into the chat. Do not claim visual details you have not inspected; generation succeeded means the file exists, not that the composition is perfect.

In the final reply:

- state that the image was generated and where it was saved
- include cost and model only when useful or when the user cares about spend/model choice
- include Markdown image syntax if the current UI can render local paths
- still provide the absolute path, because some desktop/webview environments block arbitrary filesystem image loading

Portable presentation pattern:

```markdown
Generated image saved here: `/absolute/path/from/tool/output.jpg`

![generated image](/absolute/path/from/tool/output.jpg)
```

If the Markdown image appears broken in the UI, the saved file path is still the source of truth.

## Errors and recovery

Failures return JSON with `ok:false`, `error`, and `code`.

- `auth_error` - tell the user `OPENROUTER_API_KEY` is missing/invalid; do not ask for the key in chat unless they volunteer to set it
- `validation_error` - fix the JSON, model alias, aspect ratio, output path, or reference path and retry once
- `api_error` - if the chosen model is unavailable, retry once with this fallback ladder: `gpt-image` -> `nano-banana-pro`, `nano-banana-pro` -> `nano-banana-2`, unknown `vendor/slug` -> `nano-banana-2`; otherwise summarize the provider error
- `network_error` - retry once if the task is important; mention timeout/connectivity if it fails again

Do not loop repeatedly on paid generations. One corrective retry is usually enough.

## Quality checklist before replying

Ask yourself:

1. Did I choose the cheapest model that can satisfy the request?
2. Did the prompt include enough visual direction to avoid a generic result?
3. Did I use reference images when the user asked for an edit/remix?
4. Did I avoid pasting base64 or assuming Markdown rendering works everywhere?
5. Did I give the user the exact saved path and any important caveat?

If the generated result is obviously a draft and the user wanted polish, offer the next concrete iteration rather than apologizing vaguely.
