<div align="center">

<img src=".github/assets/hero.png" alt="image-gen hero" width="100%">

# image-gen

**JSON-first image generation and editing for AI agents, with a real file path at the end.**

[![npm version](https://img.shields.io/npm/v/%40skybluejacket%2Fimage-gen?color=369eff&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@skybluejacket/image-gen)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

Powered by [xAI Grok Imagine](https://docs.x.ai/) with [OpenRouter](https://openrouter.ai) fallbacks

</div>

One JSON object in, one compact JSON object out. `image-gen` is a single CLI for model-backed image operations: generate from a prompt, edit one image, compose multiple images, run masked edits where the provider supports them, and continue iterative work across turns through a small local session file. It defaults to cheap Grok Imagine generation through xAI, can use Grok Imagine Pro for higher-quality work, and keeps OpenRouter routes available for FLUX.2 Pro and existing aliases. Generated files are saved to local disk and the CLI returns absolute paths agents can use immediately.

---

## Install in 30 seconds

```bash
npm install -g @skybluejacket/image-gen
export XAI_API_KEY=your-key-here
image-gen '{"prompt":"a quiet courtyard at dusk"}'
```

Get an xAI API key at https://console.x.ai/. Add `OPENROUTER_API_KEY` when you want `flux-pro`, legacy aliases, or OpenRouter pass-through models.

---

## Operations

`image-gen` thinks in image operations, not separate commands. The operation is derived from the request shape:

| Request shape | Operation | What it does |
|:---|:---|:---|
| `prompt` only | `generate` | Text-to-image |
| `prompt` + one `image_inputs` entry | `edit` | Edit / remix / transform a single image |
| `prompt` + multiple `image_inputs` | `compose` | Blend, combine, or transfer style across images |
| `prompt` + one `image_inputs` + `mask` | `mask_edit` | Constrain the edit to the masked area (xAI Grok models) |
| `prompt` + `session` | continuation | Use the previous turn's primary output as the source image |

You can pass `operation` explicitly for clarity; the CLI validates it against the actual request shape.

---

## Model presets

| Alias | Provider | Model | Operations | Best for |
|:---|:---|:---|:---|:---|
| `grok` | xAI | `grok-imagine-image` | generate, edit, compose (up to 5 inputs), mask_edit | Default daily-driver, cheap iteration |
| `grok-pro` | xAI | `grok-imagine-image-pro` | generate, edit, compose (up to 5 inputs), mask_edit | Higher-quality drafts and polished finals |
| `flux-pro` | OpenRouter | `black-forest-labs/flux-2-pro` | generate | OpenRouter FLUX.2 Pro |
| `nano-banana-2` | OpenRouter | `google/gemini-3.1-flash-image-preview` | generate, edit, compose | Compatibility with the previous default |
| `nano-banana-pro` | OpenRouter | `google/gemini-3-pro-image-preview` | generate, edit, compose | Compatibility with the previous pro alias |
| `gpt-image` | OpenRouter | `openai/gpt-5.4-image-2` | generate, edit, compose | Compatibility with the previous GPT image alias |

Any `vendor/slug` model ID passes through to OpenRouter unchanged. Capability for pass-through models is unknown by definition: image inputs are forwarded, masked edits are rejected, and multi-image is best-effort.

Check local readiness without exposing secrets:

```bash
image-gen --status
```

---

## Usage

### Generate from a prompt

```bash
image-gen '{"prompt":"a quiet courtyard at dusk"}'
```

### Edit one image

```bash
image-gen '{
  "prompt": "turn this napkin sketch into a clean product render",
  "image_inputs": ["./sketch.png"],
  "model": "grok-pro"
}'
```

### Compose multiple images

```bash
image-gen '{
  "prompt": "<IMAGE_0> as the silhouette, <IMAGE_1> as the surface texture, soft studio light",
  "image_inputs": ["./silhouette.png", "./texture.png"],
  "model": "grok-pro"
}'
```

xAI multi-image prompts can refer to inputs by index using `<IMAGE_0>`, `<IMAGE_1>`, etc.

### Masked edit (xAI Grok models)

```bash
image-gen '{
  "prompt": "replace only the masked area with a navy textile",
  "image_inputs": ["./photo.png"],
  "mask": "./mask.png",
  "model": "grok-pro"
}'
```

### Continue a multi-turn edit through a session file

```bash
# Turn 1: generate, save state in ./session.json
image-gen '{
  "prompt": "studio render of a brutalist espresso cup",
  "session": { "path": "./session.json" },
  "model": "grok-pro"
}'

# Turn 2: continue from the previous output as the source image
image-gen '{
  "prompt": "now place it on a pale travertine surface, soft morning light",
  "session": { "path": "./session.json" }
}'

# Branch: ignore the previous output for this turn
image-gen '{
  "prompt": "different direction: a chrome-finished cup",
  "session": { "path": "./session.json", "start_fresh": true }
}'
```

The session file stores prompts, model, provider, output paths, and a `primary_output` pointer. It does not store API keys or base64 image payloads.

### Pipe JSON through stdin

```bash
printf '%s' '{"prompt":"editorial portrait lighting study"}' | image-gen
```

---

## JSON input reference

| Field | Type | Default | What it does |
|:---|:---|:---|:---|
| `prompt` | string | **required** | Natural-language prompt |
| `model` | string | `"grok"` | Preset alias, known xAI model ID, or full OpenRouter `vendor/slug` |
| `output` | string | auto | Explicit file path, or a directory only if it already exists or ends with `/`. Extensions are normalized to the decoded image MIME type. |
| `output_dir` | string | `./generated/` | Used when `output` is not set |
| `aspect_ratio` | string | model default | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `4:1`, `1:4`, `8:1`, `1:8`, `2:3`, `3:2`, `9:19.5`, `19.5:9`, `9:20`, `20:9`, `1:2`, `2:1`, `auto`. xAI does not accept `4:1`, `1:4`, `8:1`, `1:8`. |
| `size` | string | model default | `512`, `1024`, `1K`, `2K`, `4K`; xAI maps to `1k` or `2k` |
| `n` | number | `1` | Number of images, 1-4 |
| `image_inputs` | string[] | `[]` | Source images for edits, composition, or masked edits. Local paths or HTTPS URLs. Preferred name. |
| `reference_images` | string[] | `[]` | Legacy alias for `image_inputs`. Cannot be combined with `image_inputs`. |
| `mask` | string | - | Mask image for masked edits. xAI Grok models only. Requires exactly one image input. |
| `operation` | string | derived | `"generate"`, `"edit"`, `"compose"`, `"mask_edit"`. Optional. Validated against the actual request shape. |
| `session` | object | - | `{ "path": string, "start_fresh"?: boolean }` enables multi-turn continuation. |
| `system` | string | - | Optional system-style preamble |
| `seed` | number | - | Passed to OpenRouter when supported. xAI does not document seed; not sent to xAI. |

---

## Output shape

```json
{
  "ok": true,
  "operation": "edit",
  "path": "/abs/path/to/primary.png",
  "paths": ["/abs/path/to/primary.png"],
  "model": "grok-imagine-image-pro",
  "alias": "grok-pro",
  "provider": "xai",
  "bytes": 412034,
  "elapsed_ms": 2840,
  "cost_usd": 0.07,
  "prompt": "turn this napkin sketch into a clean product render",
  "inputs": {
    "images": ["/abs/path/to/sketch.png"],
    "mask": null
  },
  "session": {
    "path": "/abs/path/to/session.json",
    "turn": 2,
    "primary_output": "/abs/path/to/primary.png"
  }
}
```

`session` is `null` when no session was used. `inputs.images` contains absolute local paths or HTTPS URLs as supplied; never base64 payloads.

Errors write a human-readable line to stderr and a structured JSON object to stdout:

```json
{"ok":false,"error":"Model \"nano-banana-2\" does not support mask-based edits.","code":"capability_error"}
```

Error codes:

| Code | Meaning |
|:---|:---|
| `validation_error` | Malformed JSON input or unsupported field |
| `capability_error` | Model/provider cannot perform the requested operation |
| `session_error` | Session file missing fields, malformed, or points to a deleted output |
| `auth_error` | Provider API key missing or rejected |
| `api_error` | Provider returned an error or empty response |
| `network_error` | Transport failure or timeout |

---

## Capability mismatches

`image-gen` rejects impossible requests **before** making any network call.

```bash
image-gen '{"prompt":"x","model":"flux-pro","image_inputs":["./ref.png"]}'
# {"ok":false,"error":"Model \"black-forest-labs/flux-2-pro\" does not support image inputs...","code":"capability_error"}

image-gen '{"prompt":"x","model":"nano-banana-2","image_inputs":["./a.png"],"mask":"./m.png"}'
# {"ok":false,"error":"Model ... does not support mask-based edits...","code":"capability_error"}

image-gen '{"prompt":"x","model":"grok","aspect_ratio":"4:1"}'
# {"ok":false,"error":"xAI does not support aspect_ratio \"4:1\"...","code":"capability_error"}
```

---

## Environment

- `XAI_API_KEY` - required for `grok`, `grok-pro`, and direct xAI image model IDs
- `OPENROUTER_API_KEY` - required for `flux-pro`, legacy OpenRouter aliases, and OpenRouter pass-through IDs
- `XAI_BASE_URL` - optional override for the xAI API base URL
- `OPENROUTER_BASE_URL` - optional override for the OpenRouter API base URL
- `IMAGE_GEN_DEFAULT_MODEL` - optional default model alias, xAI model ID, or OpenRouter model ID
- `IMAGE_GEN_OUTPUT_DIR` - optional default output directory
- `OPENROUTER_HTTP_REFERER` - optional attribution header override
- `OPENROUTER_TITLE` - optional attribution title override

`.env` is loaded from the package root, not the caller's working directory.

---

## Agent integration

An OCO/OpenCode skill is included at `skill/SKILL.md`.

```bash
mkdir -p ~/.config/oco/skills/image-gen
cp skill/SKILL.md ~/.config/oco/skills/image-gen/SKILL.md
```

If you want the local binary and skill wired through the shared agent-tools anchor, create these symlinks after building:

```bash
ln -s ~/.local/share/agent-tools/image-gen/dist/cli.js ~/.local/bin/image-gen
ln -s ~/.local/share/agent-tools/image-gen/skill/SKILL.md ~/.config/oco/skills/image-gen/SKILL.md
```

---

## Build from source

```bash
git clone https://github.com/AidenGeunGeun/image-gen.git
cd image-gen
npm install
npm run build
```

## License

MIT
