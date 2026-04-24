<div align="center">

# image-gen

**Image generation for AI agents, with a real file path at the end.**

[![npm version](https://img.shields.io/npm/v/%40skybluejacket%2Fimage-gen?color=369eff&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@skybluejacket/image-gen)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

Powered by [OpenRouter](https://openrouter.ai)

</div>

One JSON object in, one compact JSON object out.
`image-gen` calls OpenRouter image models, saves the generated files locally, and returns absolute paths agents can use immediately.

---

## Install in 30 seconds

```bash
npm install -g @skybluejacket/image-gen
export OPENROUTER_API_KEY=your-key-here
image-gen '{"prompt":"a quiet courtyard at dusk","model":"nano-banana-2"}'
```

Get an API key at https://openrouter.ai/keys.

---

## Model aliases

| Alias | OpenRouter model | Best for |
|:------|:-----------------|:---------|
| `nano-banana-2` | `google/gemini-3.1-flash-image-preview` | Fast, cheap, iterative work |
| `nano-banana-pro` | `google/gemini-3-pro-image-preview` | Text-heavy scenes, multiple subjects, polished finals |
| `gpt-image` | `openai/gpt-5.4-image-2` | Reasoning-heavy prompts, UI mockups, precise compositions |

Any `vendor/slug` model ID also passes through unchanged.

---

## Usage

```bash
# Simple generation
image-gen '{"prompt":"a quiet courtyard at dusk","model":"nano-banana-2"}'

# Ask for multiple images and a wider frame
image-gen '{"prompt":"brutalist museum poster","aspect_ratio":"16:9","n":2}'

# Edit or remix with references
image-gen '{
  "prompt": "turn this napkin sketch into a clean product render",
  "reference_images": ["./sketch.png"],
  "model": "nano-banana-pro"
}'

# Pipe JSON through stdin
printf '%s' '{"prompt":"editorial portrait lighting study"}' | image-gen
```

---

## JSON input reference

| Field | Type | Default | What it does |
|:------|:-----|:--------|:-------------|
| `prompt` | string | **required** | Natural-language prompt |
| `model` | string | `"nano-banana-2"` | Alias or full OpenRouter `vendor/slug` model ID |
| `output` | string | auto | Explicit file path, or a directory only if it already exists or ends with `/`. File extensions are normalized to the decoded image MIME type. |
| `output_dir` | string | `./generated/` | Used when `output` is not set |
| `aspect_ratio` | string | model default | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `4:1`, `1:4`, `8:1`, `1:8` |
| `size` | string | model default | Size hint such as `512`, `1024`, `2K`, `4K` |
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
  "model": "google/gemini-3.1-flash-image-preview",
  "alias": "nano-banana-2",
  "provider": "openrouter",
  "bytes": 412034,
  "elapsed_ms": 2840,
  "cost_usd": 0.0032,
  "prompt": "a quiet courtyard at dusk"
}
```

Errors write a human-readable line to stderr and a structured JSON object to stdout:

```json
{"ok":false,"error":"Missing OPENROUTER_API_KEY. Set it in the environment or packages/image-gen/.env. Get a key at https://openrouter.ai/keys.","code":"auth_error"}
```

---

## Environment

- `OPENROUTER_API_KEY` - required
- `OPENROUTER_BASE_URL` - optional override for the OpenRouter API base URL
- `IMAGE_GEN_DEFAULT_MODEL` - optional default model alias or full model ID
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
