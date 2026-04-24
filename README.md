<div align="center">

<img src=".github/assets/hero.png" alt="image-gen hero" width="100%">

# image-gen

**Image generation for AI agents, with a real file path at the end.**

[![npm version](https://img.shields.io/npm/v/%40skybluejacket%2Fimage-gen?color=369eff&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@skybluejacket/image-gen)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

Powered by [xAI Grok Imagine](https://docs.x.ai/) with [OpenRouter](https://openrouter.ai) fallbacks

</div>

One JSON object in, one compact JSON object out.
`image-gen` defaults to cheap Grok Imagine generation through xAI, can use Grok Imagine Pro for higher-quality work, and keeps OpenRouter routes available for FLUX.2 Pro and existing aliases. It saves generated files locally and returns absolute paths agents can use immediately.

---

## Install in 30 seconds

```bash
npm install -g @skybluejacket/image-gen
export XAI_API_KEY=your-key-here
image-gen '{"prompt":"a quiet courtyard at dusk"}'
```

Get an xAI API key at https://console.x.ai/. Add `OPENROUTER_API_KEY` when you want `flux-pro`, legacy aliases, or OpenRouter pass-through models.

---

## Model presets

| Alias | Provider | Model | Best for |
|:------|:---------|:------|:---------|
| `grok` | xAI | `grok-imagine-image` | Default daily-driver generation, cheap iteration |
| `grok-pro` | xAI | `grok-imagine-image-pro` | Higher-quality drafts and polished finals |
| `flux-pro` | OpenRouter | `black-forest-labs/flux-2-pro` | OpenRouter FLUX.2 Pro fallback/polish route |
| `nano-banana-2` | OpenRouter | `google/gemini-3.1-flash-image-preview` | Compatibility with the previous default |
| `nano-banana-pro` | OpenRouter | `google/gemini-3-pro-image-preview` | Compatibility with the previous pro alias |
| `gpt-image` | OpenRouter | `openai/gpt-5.4-image-2` | Compatibility with the previous GPT image alias |

Any `vendor/slug` model ID passes through to OpenRouter unchanged. Known xAI model IDs `grok-imagine-image` and `grok-imagine-image-pro` also route through xAI.

Check local readiness without exposing secrets:

```bash
image-gen --status
```

---

## Usage

```bash
# Simple generation
image-gen '{"prompt":"a quiet courtyard at dusk"}'

# Ask for multiple images and a wider frame
image-gen '{"prompt":"brutalist museum poster","aspect_ratio":"16:9","n":2}'

# Edit or remix with references
image-gen '{
  "prompt": "turn this napkin sketch into a clean product render",
  "reference_images": ["./sketch.png"],
  "model": "grok-pro"
}'

# Pipe JSON through stdin
printf '%s' '{"prompt":"editorial portrait lighting study"}' | image-gen
```

---

## JSON input reference

| Field | Type | Default | What it does |
|:------|:-----|:--------|:-------------|
| `prompt` | string | **required** | Natural-language prompt |
| `model` | string | `"grok"` | Preset alias, known xAI model ID, or full OpenRouter `vendor/slug` model ID |
| `output` | string | auto | Explicit file path, or a directory only if it already exists or ends with `/`. File extensions are normalized to the decoded image MIME type. |
| `output_dir` | string | `./generated/` | Used when `output` is not set |
| `aspect_ratio` | string | model default | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `4:1`, `1:4`, `8:1`, `1:8`, `2:3`, `3:2`, `9:19.5`, `19.5:9`, `9:20`, `20:9`, `1:2`, `2:1`, `auto` |
| `size` | string | model default | Size hint such as `512`, `1024`, `1K`, `2K`, `4K`; xAI maps supported hints to `1k` or `2k` |
| `n` | number | `1` | Number of images to generate (1-4) |
| `reference_images` | string[] | `[]` | Local image paths or HTTPS URLs used as references |
| `system` | string | - | Optional system-style preamble |
| `seed` | number | - | Passed through when the model supports it |

---

## Output shape

```json
{
  "ok": true,
  "path": "/abs/path/to/primary.png",
  "paths": ["/abs/path/to/primary.png"],
  "model": "grok-imagine-image",
  "alias": "grok",
  "provider": "xai",
  "bytes": 412034,
  "elapsed_ms": 2840,
  "cost_usd": null,
  "prompt": "a quiet courtyard at dusk"
}
```

Errors write a human-readable line to stderr and a structured JSON object to stdout:

```json
{"ok":false,"error":"Missing XAI_API_KEY. Set it in the environment or packages/image-gen/.env. Get a key at https://console.x.ai/.","code":"auth_error"}
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
