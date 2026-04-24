import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRequestBody,
  createFailureEnvelope,
  decodeGeneratedImages,
  extractCostUsd,
  generateImages,
  getHelpText,
  getListModelsText,
  getVersion,
  IMAGE_GEN_DEFAULT_MODEL,
  ImageGenCliError,
  isDirectExecution,
  loadPackageEnv,
  parseJsonInput,
  prepareReferenceImages,
  resolveEnvPath,
  resolveModelSpecifier,
  resolveOutputPaths,
  runCli,
  validateInput,
} from "../cli.js";

function createResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

function createWritableCapture(): { stream: { write: (chunk: string) => boolean }; chunks: string[] } {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    },
    chunks,
  };
}

function createImageDataUrl(mimeType = "image/png", content = "sample-image"): string {
  return `data:${mimeType};base64,${Buffer.from(content).toString("base64")}`;
}

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("env loading", () => {
  it("resolves the package-local env path for src and dist modules", () => {
    expect(resolveEnvPath("file:///tmp/image-gen/cli.js")).toBe("/tmp/image-gen/.env");
    expect(resolveEnvPath("file:///tmp/image-gen/dist/cli.js")).toBe("/tmp/image-gen/.env");
  });

  it("loads only the package-local env file and does not override existing values", () => {
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "from-process",
    };
    const envFiles = new Map<string, string>([["/tmp/pkg/.env", "OPENROUTER_API_KEY=from-package\nEXTRA=hello\n"]]);

    const loadedPath = loadPackageEnv(
      "file:///tmp/pkg/dist/cli.js",
      env,
      (path) => envFiles.has(path),
      (path) => envFiles.get(path) ?? "",
    );

    expect(loadedPath).toBe("/tmp/pkg/.env");
    expect(env.OPENROUTER_API_KEY).toBe("from-process");
    expect(env.EXTRA).toBe("hello");
  });
});

describe("parsing and validation", () => {
  it("parses JSON object input", () => {
    expect(parseJsonInput('{"prompt":"hello"}')).toEqual({ prompt: "hello" });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseJsonInput("{" )).toThrowError(/Invalid JSON input/);
  });

  it("requires prompt", () => {
    expect(() => validateInput({ model: IMAGE_GEN_DEFAULT_MODEL }, {})).toThrowError("Missing required field: prompt");
  });

  it("rejects invalid n", () => {
    expect(() => validateInput({ prompt: "hi", n: 0 }, {})).toThrowError('Invalid "n". Expected an integer in range 1-4.');
  });

  it("rejects invalid aspect ratio", () => {
    expect(() => validateInput({ prompt: "hi", aspect_ratio: "5:5" }, {})).toThrowError(/Invalid "aspect_ratio"/);
  });

  it("resolves model aliases and passthrough IDs", () => {
    expect(resolveModelSpecifier("nano-banana-2")).toEqual({
      alias: "nano-banana-2",
      model: "google/gemini-3.1-flash-image-preview",
    });
    expect(resolveModelSpecifier("vendor/slug-1")).toEqual({ alias: null, model: "vendor/slug-1" });
  });

  it("rejects unknown aliases cleanly", () => {
    expect(() => resolveModelSpecifier("banana-max")).toThrowError(/Unknown model "banana-max"/);
  });

  it("rejects unreadable reference images", () => {
    const cwd = makeTempDir("image-gen-cwd-");
    expect(() => prepareReferenceImages(["missing.png"], cwd)).toThrowError(/Could not read reference image/);
  });
});

describe("request construction", () => {
  it("builds text-plus-image requests with image_config and inlined local references", () => {
    const cwd = makeTempDir("image-gen-refs-");
    const localImage = join(cwd, "ref.png");
    writeFileSync(localImage, Buffer.from("local-ref"));

    const input = validateInput(
      {
        prompt: "Turn this sketch into a clean rendering",
        model: "nano-banana-2",
        system: "Be precise.",
        aspect_ratio: "16:9",
        size: "4K",
        n: 2,
        seed: 7,
        reference_images: ["https://example.com/ref.png", "ref.png"],
      },
      {},
    );

    const referenceImages = prepareReferenceImages(input.referenceImages, cwd);
    const body = buildRequestBody(input, referenceImages, 2);
    const messages = body.messages as Array<Record<string, unknown>>;
    const userMessage = messages[1] as Record<string, unknown>;
    const content = userMessage.content as Array<Record<string, unknown>>;

    expect(body.model).toBe("google/gemini-3.1-flash-image-preview");
    expect(body.modalities).toEqual(["image", "text"]);
    expect(body.image_config).toEqual({ aspect_ratio: "16:9", image_size: "4K" });
    expect(body.n).toBe(2);
    expect(body.seed).toBe(7);
    expect(messages[0]).toEqual({ role: "system", content: "Be precise." });
    expect(content[0]).toEqual({ type: "text", text: "Turn this sketch into a clean rendering" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "https://example.com/ref.png" } });
    expect((content[2]?.image_url as { url: string }).url).toMatch(/^data:image\/png;base64,/);
  });

  it("builds image-only requests with image-only modalities", () => {
    const input = validateInput({ prompt: "poster concept", model: "black-forest-labs/flux-1-schnell", n: 2, aspect_ratio: "16:9", size: "4K" }, {});
    const body = buildRequestBody(input, [], 1);

    expect(body.modalities).toEqual(["image"]);
    expect(body.n).toBeUndefined();
    expect(body.image_config).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "poster concept" }]);
  });

  it("omits image_config for non-Gemini text-plus-image models", () => {
    const input = validateInput({ prompt: "ui mockup", model: "gpt-image", aspect_ratio: "16:9", size: "4K" }, {});
    const body = buildRequestBody(input, [], 1);

    expect(body.modalities).toEqual(["image", "text"]);
    expect(body.image_config).toBeUndefined();
  });
});

describe("response decoding and filenames", () => {
  it("decodes base64 image responses and writes absolute output paths", async () => {
    const cwd = makeTempDir("image-gen-write-");
    const fetchImpl = vi.fn().mockResolvedValue(
      createResponse(200, {
        choices: [
          {
            message: {
              images: [
                {
                  image_url: {
                    url: createImageDataUrl("image/webp", "rendered-image"),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          cost: 0.0032,
        },
      }),
    );

    const result = await generateImages(validateInput({ prompt: "quiet courtyard" }, {}), {
      cwd,
      env: { OPENROUTER_API_KEY: "test-key" },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.path).toBe(resolve(cwd, "generated", basename(result.path)));
    expect(result.path.endsWith(".webp")).toBe(true);
    expect(result.paths[0]).toBe(result.path);
    expect(readFileSync(result.path).toString("utf-8")).toBe("rendered-image");
    expect(result.bytes).toBe(Buffer.byteLength("rendered-image"));
    expect(result.cost_usd).toBe(0.0032);

    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = request.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["HTTP-Referer"]).toBe("https://github.com/AidenGeunGeun/image-gen");
    expect(headers["X-Title"]).toBe("image-gen");
    expect(headers["X-OpenRouter-Title"]).toBe("image-gen");
  });

  it("uses directory output targets and explicit file targets correctly", () => {
    const cwd = makeTempDir("image-gen-paths-");
    const imageBuffers = decodeGeneratedImages({
      choices: [
        {
          message: {
            images: [
              { image_url: { url: createImageDataUrl("image/png", "one") } },
              { image_url: { url: createImageDataUrl("image/png", "two") } },
            ],
          },
        },
      ],
    });

    const generatedDirPaths = resolveOutputPaths(
      {
        output: "renders/",
        outputDir: "generated",
        cwd,
        prompt: "poster",
        model: "nano-banana-2",
      },
      imageBuffers,
      new Date("2026-04-24T12:34:56.000Z"),
    );
    expect(generatedDirPaths[0]).toMatch(/renders\/image-2026-04-24T12-34-56.000Z-/);

    const explicitPaths = resolveOutputPaths(
      {
        output: "exports/final.png",
        outputDir: "generated",
        cwd,
        prompt: "poster",
        model: "nano-banana-2",
      },
      imageBuffers,
      new Date("2026-04-24T12:34:56.000Z"),
    );
    expect(explicitPaths[0]).toBe(resolve(cwd, "exports", "final.png"));
    expect(explicitPaths[1]).toBe(resolve(cwd, "exports", "final-2.png"));
  });

  it("rewrites explicit output extensions to match decoded mime types", () => {
    const cwd = makeTempDir("image-gen-explicit-ext-");
    const imageBuffers = decodeGeneratedImages({
      choices: [
        {
          message: {
            images: [
              { image_url: { url: createImageDataUrl("image/webp", "one") } },
              { image_url: { url: createImageDataUrl("image/jpeg", "two") } },
            ],
          },
        },
      ],
    });

    const explicitPaths = resolveOutputPaths(
      {
        output: "exports/final.png",
        outputDir: "generated",
        cwd,
        prompt: "poster",
        model: "nano-banana-2",
      },
      imageBuffers,
      new Date("2026-04-24T12:34:56.000Z"),
    );

    expect(explicitPaths[0]).toBe(resolve(cwd, "exports", "final.webp"));
    expect(explicitPaths[1]).toBe(resolve(cwd, "exports", "final-2.jpg"));
  });

  it("loops for image-only models when n is greater than one", async () => {
    const cwd = makeTempDir("image-gen-loop-");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createResponse(200, {
          choices: [{ message: { images: [{ image_url: { url: createImageDataUrl("image/png", "one") } }] } }],
          usage: { cost: 0.001 },
        }),
      )
      .mockResolvedValueOnce(
        createResponse(200, {
          choices: [{ message: { images: [{ image_url: { url: createImageDataUrl("image/png", "two") } }] } }],
          usage: { cost: 0.0015 },
        }),
      );

    const result = await generateImages(
      validateInput({ prompt: "flux poster", model: "black-forest-labs/flux-1-schnell", n: 2 }, {}),
      {
        cwd,
        env: { OPENROUTER_API_KEY: "test-key" },
        fetchImpl,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.paths).toHaveLength(2);
    expect(result.cost_usd).toBe(0.0025);
  });
});

describe("error handling", () => {
  it("surfaces HTTP error bodies", async () => {
    const cwd = makeTempDir("image-gen-error-");
    await expect(
      generateImages(validateInput({ prompt: "hello" }, {}), {
        cwd,
        env: { OPENROUTER_API_KEY: "test-key" },
        fetchImpl: vi.fn().mockResolvedValue(createResponse(429, { error: { message: "model unavailable" } })),
      }),
    ).rejects.toMatchObject({ code: "api_error", message: "model unavailable", status: 429 });
  });

  it("rejects empty image responses", async () => {
    const cwd = makeTempDir("image-gen-empty-");
    await expect(
      generateImages(validateInput({ prompt: "hello" }, {}), {
        cwd,
        env: { OPENROUTER_API_KEY: "test-key" },
        fetchImpl: vi.fn().mockResolvedValue(createResponse(200, { choices: [{ message: { content: "no image" } }] })),
      }),
    ).rejects.toThrowError("OpenRouter returned no generated images.");
  });

  it("creates structured stdout errors and human stderr lines when auth is missing", async () => {
    const cwd = makeTempDir("image-gen-no-env-");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runCli(['{"prompt":"test","model":"nano-banana-2"}'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      env: {},
      moduleUrl: `file://${join(cwd, "cli.js")}`,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.chunks.join(""))).toEqual({
      ok: false,
      error: "Missing OPENROUTER_API_KEY. Set it in the environment or packages/image-gen/.env. Get a key at https://openrouter.ai/keys.",
      code: "auth_error",
    });
    expect(stderr.chunks.join("")).toContain("auth_error");
  });
});

describe("cli helpers", () => {
  it("returns help, version, and model listing text", async () => {
    expect(getVersion()).toBe("0.1.1");
    expect(getHelpText()).toContain("Usage:");
    expect(getHelpText()).toContain("OPENROUTER_API_KEY");
    expect(getHelpText()).toContain("Output shape");
    expect(getListModelsText()).toContain("nano-banana-pro");

    const helpStdout = createWritableCapture();
    expect(await runCli(["--help"], { stdout: helpStdout.stream, stderr: createWritableCapture().stream })).toBe(0);
    expect(helpStdout.chunks.join("")).toContain("Aliases:");

    const versionStdout = createWritableCapture();
    expect(await runCli(["--version"], { stdout: versionStdout.stream, stderr: createWritableCapture().stream })).toBe(0);
    expect(versionStdout.chunks.join("")).toBe("0.1.1\n");
  });

  it("supports direct execution detection", () => {
    expect(isDirectExecution("file:///tmp/image-gen/dist/cli.js", "/tmp/image-gen/dist/cli.js")).toBe(true);
    expect(isDirectExecution("file:///tmp/image-gen/dist/cli.js", "/tmp/other.js")).toBe(false);
  });

  it("extracts cost when present and returns null otherwise", () => {
    expect(extractCostUsd({ usage: { cost: 1.25 } })).toBe(1.25);
    expect(extractCostUsd({ usage: {} })).toBeNull();
  });

  it("creates failure envelopes from typed errors", () => {
    expect(createFailureEnvelope(new ImageGenCliError("validation_error", "bad input"))).toEqual({
      ok: false,
      error: "bad input",
      code: "validation_error",
    });
  });
});
