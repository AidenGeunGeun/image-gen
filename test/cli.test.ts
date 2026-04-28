import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendSessionTurn,
  applyCapabilityChecks,
  buildRequestBody,
  buildXaiRequestBody,
  createFailureEnvelope,
  createSessionFile,
  decodeGeneratedImages,
  decodeXaiGeneratedImages,
  deriveOperation,
  extractCostUsd,
  generateImages,
  getHelpText,
  getListModelsText,
  getStatusReport,
  getVersion,
  IMAGE_GEN_DEFAULT_MODEL,
  ImageGenCliError,
  isDirectExecution,
  isValidSessionFile,
  loadPackageEnv,
  parseJsonInput,
  prepareReferenceImages,
  readSessionFile,
  resolveEnvPath,
  resolveModelSpecifier,
  resolveOutputPaths,
  runCli,
  SESSION_FILE_VERSION,
  validateInput,
  writeSessionFileAtomic,
  XAI_USD_TICKS_PER_DOLLAR,
  type SessionFile,
  type SessionTurnRecord,
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

function xaiResponse(content: string, mimeType = "image/png", costInUsdTicks?: number): unknown {
  const body: Record<string, unknown> = {
    data: [{ b64_json: Buffer.from(content).toString("base64"), mime_type: mimeType }],
  };
  if (costInUsdTicks !== undefined) {
    body.usage = { cost_in_usd_ticks: costInUsdTicks };
  }
  return body;
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
    expect(() => parseJsonInput("{")).toThrowError(/Invalid JSON input/);
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
    expect(resolveModelSpecifier("grok")).toEqual({ alias: "grok", model: "grok-imagine-image", provider: "xai" });
    expect(resolveModelSpecifier("flux-pro")).toEqual({ alias: "flux-pro", model: "black-forest-labs/flux-2-pro", provider: "openrouter" });
    expect(resolveModelSpecifier("nano-banana-2")).toEqual({
      alias: "nano-banana-2",
      model: "google/gemini-3.1-flash-image-preview",
      provider: "openrouter",
    });
    expect(resolveModelSpecifier("grok-imagine-image-pro")).toEqual({ alias: null, model: "grok-imagine-image-pro", provider: "xai" });
    expect(resolveModelSpecifier("vendor/slug-1")).toEqual({ alias: null, model: "vendor/slug-1", provider: "openrouter" });
  });

  it("rejects unknown aliases cleanly", () => {
    expect(() => resolveModelSpecifier("banana-max")).toThrowError(/Unknown model "banana-max"/);
  });

  it("rejects unreadable image inputs", () => {
    const cwd = makeTempDir("image-gen-cwd-");
    expect(() => prepareReferenceImages(["missing.png"], cwd)).toThrowError(/Could not read image input/);
  });

  it("accepts image_inputs as the canonical field name", () => {
    const input = validateInput({ prompt: "hi", image_inputs: ["https://example.com/a.png"] }, {});
    expect(input.imageInputs).toEqual(["https://example.com/a.png"]);
    expect(input.referenceImages).toEqual(["https://example.com/a.png"]);
  });

  it("accepts reference_images as a backward-compatible alias", () => {
    const input = validateInput({ prompt: "hi", reference_images: ["https://example.com/a.png"] }, {});
    expect(input.imageInputs).toEqual(["https://example.com/a.png"]);
  });

  it("rejects supplying both image_inputs and reference_images", () => {
    expect(() =>
      validateInput(
        { prompt: "hi", image_inputs: ["https://a/b.png"], reference_images: ["https://a/c.png"] },
        {},
      ),
    ).toThrowError(/either "image_inputs" or the legacy "reference_images"/);
  });

  it("validates session input shape", () => {
    expect(() => validateInput({ prompt: "hi", session: "not-an-object" }, {})).toThrowError(/Invalid "session"/);
    expect(() => validateInput({ prompt: "hi", session: {} }, {})).toThrowError(/Missing "session.path"/);
    expect(() => validateInput({ prompt: "hi", session: { path: "x", start_fresh: "yes" } }, {})).toThrowError(
      /Invalid "session.start_fresh"/,
    );
    expect(() => validateInput({ prompt: "hi", session: { path: "x", weird: 1 } }, {})).toThrowError(
      /Unknown session field: weird/,
    );
  });

  it("validates mask input", () => {
    expect(() => validateInput({ prompt: "hi", mask: "" }, {})).toThrowError(/Invalid "mask"/);
    expect(validateInput({ prompt: "hi", mask: "./mask.png" }, {}).mask).toBe("./mask.png");
  });

  it("validates operation hint values", () => {
    expect(() => validateInput({ prompt: "hi", operation: "transmute" }, {})).toThrowError(/Invalid "operation"/);
    expect(validateInput({ prompt: "hi", operation: "generate" }, {}).operationHint).toBe("generate");
  });
});

describe("operation and capability checks", () => {
  it("derives operation from inputs", () => {
    expect(deriveOperation(0, false)).toBe("generate");
    expect(deriveOperation(1, false)).toBe("edit");
    expect(deriveOperation(3, false)).toBe("compose");
    expect(deriveOperation(1, true)).toBe("mask_edit");
  });

  it("rejects mask when image_inputs is empty", () => {
    const input = validateInput({ prompt: "hi", model: "grok", mask: "https://example.com/m.png" }, {});
    expect(() => applyCapabilityChecks(input)).toThrowError(/Masked edits require exactly one image input/);
  });

  it("rejects mask on multi-image requests", () => {
    const input = validateInput(
      {
        prompt: "hi",
        model: "grok",
        image_inputs: ["https://example.com/a.png", "https://example.com/b.png"],
        mask: "https://example.com/m.png",
      },
      {},
    );
    expect(() => applyCapabilityChecks(input)).toThrowError(/Masked edits require exactly one image input/);
  });

  it("rejects mask on non-Grok models with a capability_error", () => {
    const input = validateInput(
      {
        prompt: "hi",
        model: "nano-banana-2",
        image_inputs: ["https://example.com/a.png"],
        mask: "https://example.com/m.png",
      },
      {},
    );
    expect(() => applyCapabilityChecks(input)).toThrowError(/does not support mask-based edits/);
    try {
      applyCapabilityChecks(input);
    } catch (error) {
      expect((error as ImageGenCliError).code).toBe("capability_error");
    }
  });

  it("rejects mask on pass-through vendor/slug models", () => {
    const input = validateInput(
      {
        prompt: "hi",
        model: "openai/some-future-model",
        image_inputs: ["https://example.com/a.png"],
        mask: "https://example.com/m.png",
      },
      {},
    );
    expect(() => applyCapabilityChecks(input)).toThrowError(/does not support mask-based edits/);
  });

  it("rejects image_inputs on flux-pro (image-only) with a capability_error", () => {
    const input = validateInput({ prompt: "hi", model: "flux-pro", image_inputs: ["https://example.com/a.png"] }, {});
    expect(() => applyCapabilityChecks(input)).toThrowError(/does not support image inputs/);
  });

  it("rejects too many image_inputs against the preset cap", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((slug) => `https://example.com/${slug}.png`);
    const input = validateInput({ prompt: "hi", model: "grok", image_inputs: six }, {});
    expect(() => applyCapabilityChecks(input)).toThrowError(/accepts at most 5 image inputs/);
  });

  it("rejects operation hint that does not match the request shape", () => {
    const input = validateInput({ prompt: "hi", model: "grok", operation: "edit" }, {});
    expect(() => applyCapabilityChecks(input)).toThrowError(
      /Declared operation "edit" does not match the request shape/,
    );
  });

  it("accepts a matching operation hint", () => {
    const input = validateInput(
      { prompt: "hi", model: "grok", image_inputs: ["https://example.com/a.png"], operation: "edit" },
      {},
    );
    expect(applyCapabilityChecks(input).operation).toBe("edit");
  });

  it("rejects session continuation when the model cannot accept image inputs", () => {
    const input = validateInput(
      { prompt: "hi", model: "flux-pro", session: { path: "./s.json" } },
      {},
    );
    expect(() => applyCapabilityChecks(input)).toThrowError(/does not support session continuation/);
  });
});

describe("request construction", () => {
  it("builds text-plus-image requests with image_config and inlined local image inputs", () => {
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
        image_inputs: ["https://example.com/ref.png", "ref.png"],
      },
      {},
    );

    const referenceImages = prepareReferenceImages(input.imageInputs, cwd);
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

  it("builds xAI generation, edit, multi-image, and masked edit bodies without seed and with canonical field shapes", () => {
    const cwd = makeTempDir("image-gen-xai-refs-");
    const localImage = join(cwd, "ref.jpg");
    writeFileSync(localImage, Buffer.from("local-ref"));
    const maskFile = join(cwd, "mask.png");
    writeFileSync(maskFile, Buffer.from("mask-bytes"));

    // Generation: prompt only, b64_json requested.
    const generationBody = buildXaiRequestBody(validateInput({ prompt: "daily render", seed: 42 }, {}), [], 1);
    expect(generationBody).toEqual({ model: "grok-imagine-image", prompt: "daily render", response_format: "b64_json" });
    expect(generationBody.seed).toBeUndefined();

    // Edit + multi-image: should produce `images` array of `{url}` objects only.
    const multi = validateInput(
      {
        prompt: "make a clean product render",
        model: "grok-pro",
        system: "Use precise studio lighting.",
        aspect_ratio: "3:2",
        size: "2K",
        n: 2,
        image_inputs: ["https://example.com/source.png", "ref.jpg"],
      },
      {},
    );
    const multiPrepared = prepareReferenceImages(multi.imageInputs, cwd);
    const editBody = buildXaiRequestBody(multi, multiPrepared, 2);
    expect(editBody.model).toBe("grok-imagine-image-pro");
    expect(editBody.prompt).toBe("Use precise studio lighting.\n\nmake a clean product render");
    expect(editBody.response_format).toBe("b64_json");
    expect(editBody.n).toBe(2);
    expect(editBody.aspect_ratio).toBe("3:2");
    expect(editBody.resolution).toBe("2k");
    expect(editBody.images).toEqual([
      { url: "https://example.com/source.png" },
      { url: expect.stringMatching(/^data:image\/jpeg;base64,/) },
    ]);
    expect(editBody.image).toBeUndefined();
    expect(editBody.mask).toBeUndefined();

    // Single-image edit: should use `image: { url }`.
    const single = validateInput({ prompt: "polish", model: "grok-pro", image_inputs: ["https://example.com/one.png"] }, {});
    const singlePrepared = prepareReferenceImages(single.imageInputs, cwd);
    const singleBody = buildXaiRequestBody(single, singlePrepared, 1);
    expect(singleBody.image).toEqual({ url: "https://example.com/one.png" });
    expect(singleBody.images).toBeUndefined();

    // Masked edit: mask is a `{url}` object alongside `image`.
    const masked = validateInput(
      {
        prompt: "constrain to the highlighted region",
        model: "grok-pro",
        image_inputs: ["https://example.com/one.png"],
        mask: "mask.png",
      },
      {},
    );
    const maskedPrepared = prepareReferenceImages(masked.imageInputs, cwd);
    const maskedMask = masked.mask
      ? prepareReferenceImages([masked.mask], cwd)[0] as string
      : undefined;
    const maskedBody = buildXaiRequestBody(masked, maskedPrepared, 1, maskedMask);
    expect(maskedBody.mask).toEqual({ url: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(maskedBody.image).toEqual({ url: "https://example.com/one.png" });
  });

  it("rejects xAI-incompatible aspect ratios with a capability_error", () => {
    const input = validateInput({ prompt: "hi", model: "grok", aspect_ratio: "4:1" }, {});
    expect(() => buildXaiRequestBody(input, [], 1)).toThrowError(/xAI does not support aspect_ratio "4:1"/);
  });

  it("rejects more than five image inputs at the xAI body builder", () => {
    const input = validateInput(
      { prompt: "hi", model: "grok", image_inputs: ["https://example.com/a.png"] },
      {},
    );
    expect(() => buildXaiRequestBody(input, ["a", "b", "c", "d", "e", "f"], 1)).toThrowError(
      /at most 5 input images/,
    );
  });

  it("rejects mask with multiple image inputs at the xAI body builder", () => {
    const input = validateInput(
      { prompt: "hi", model: "grok", image_inputs: ["https://example.com/a.png"] },
      {},
    );
    expect(() => buildXaiRequestBody(input, ["a", "b"], 1, "https://example.com/m.png")).toThrowError(
      /Masked edits require exactly one image input/,
    );
  });
});

describe("response decoding and filenames", () => {
  it("decodes xAI base64 image responses, derives operation, and returns the new envelope shape", async () => {
    const cwd = makeTempDir("image-gen-write-");
    const fetchImpl = vi.fn().mockResolvedValue(createResponse(200, xaiResponse("rendered-image", "image/webp")));

    const result = await generateImages(validateInput({ prompt: "quiet courtyard" }, {}), {
      cwd,
      env: { XAI_API_KEY: "test-key" },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.operation).toBe("generate");
    expect(result.path).toBe(resolve(cwd, "generated", basename(result.path)));
    expect(result.path.endsWith(".webp")).toBe(true);
    expect(result.paths[0]).toBe(result.path);
    expect(readFileSync(result.path).toString("utf-8")).toBe("rendered-image");
    expect(result.bytes).toBe(Buffer.byteLength("rendered-image"));
    expect(result.cost_usd).toBeNull();
    expect(result.provider).toBe("xai");
    expect(result.alias).toBe("grok");
    expect(result.inputs).toEqual({ images: [], mask: null });
    expect(result.session).toBeNull();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.x.ai/v1/images/generations");
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = request.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(request.body as string)).toEqual({
      model: "grok-imagine-image",
      prompt: "quiet courtyard",
      response_format: "b64_json",
    });
  });

  it("converts xAI cost_in_usd_ticks into cost_usd dollars", async () => {
    const cwd = makeTempDir("image-gen-xai-cost-");
    const ticks = XAI_USD_TICKS_PER_DOLLAR / 50; // $0.02
    const fetchImpl = vi.fn().mockResolvedValue(createResponse(200, xaiResponse("a", "image/png", ticks)));

    const result = await generateImages(validateInput({ prompt: "p" }, {}), {
      cwd,
      env: { XAI_API_KEY: "k" },
      fetchImpl,
    });

    expect(result.cost_usd).toBeCloseTo(0.02, 6);
  });

  it("routes a single-image xAI edit through the edits endpoint with the right body and reports operation=edit", async () => {
    const cwd = makeTempDir("image-gen-xai-edit-");
    const ticks = XAI_USD_TICKS_PER_DOLLAR * 0.07; // $0.07 (one Grok Pro image)
    const fetchImpl = vi.fn().mockResolvedValue(createResponse(200, xaiResponse("edited", "image/png", ticks)));

    const result = await generateImages(
      validateInput(
        {
          prompt: "polish the product render",
          model: "grok-pro",
          image_inputs: ["https://example.com/source.png"],
        },
        {},
      ),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.x.ai/v1/images/edits");
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      model: "grok-imagine-image-pro",
      image: { url: "https://example.com/source.png" },
      response_format: "b64_json",
    });
    expect(result.operation).toBe("edit");
    expect(result.inputs.images).toEqual(["https://example.com/source.png"]);
    expect(result.cost_usd).toBeCloseTo(0.07, 6);
  });

  it("routes OpenRouter aliases through OpenRouter and preserves headers and cost", async () => {
    const cwd = makeTempDir("image-gen-openrouter-write-");
    const fetchImpl = vi.fn().mockResolvedValue(
      createResponse(200, {
        choices: [{ message: { images: [{ image_url: { url: createImageDataUrl("image/webp", "openrouter-image") } }] } }],
        usage: { cost: 0.0032 },
      }),
    );

    const result = await generateImages(validateInput({ prompt: "quiet courtyard", model: "nano-banana-2" }, {}), {
      cwd,
      env: { OPENROUTER_API_KEY: "test-key" },
      fetchImpl,
    });

    expect(result.provider).toBe("openrouter");
    expect(result.alias).toBe("nano-banana-2");
    expect(result.cost_usd).toBe(0.0032);
    expect(result.operation).toBe("generate");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = request.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["HTTP-Referer"]).toBe("https://github.com/AidenGeunGeun/image-gen");
    expect(headers["X-Title"]).toBe("image-gen");
    expect(headers["X-OpenRouter-Title"]).toBe("image-gen");
  });

  it("decodes xAI response helpers", () => {
    const images = decodeXaiGeneratedImages({ data: [{ b64_json: Buffer.from("xai-image").toString("base64"), mime_type: "image/jpeg" }] });
    expect(images[0]?.extension).toBe("jpg");
    expect(images[0]?.buffer.toString("utf-8")).toBe("xai-image");
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
      validateInput({ prompt: "flux poster", model: "flux-pro", n: 2 }, {}),
      {
        cwd,
        env: { OPENROUTER_API_KEY: "test-key" },
        fetchImpl,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.paths).toHaveLength(2);
    expect(result.cost_usd).toBe(0.0025);
    expect(result.provider).toBe("openrouter");
    expect(result.alias).toBe("flux-pro");
    expect(result.operation).toBe("generate");
  });
});

describe("session continuation", () => {
  it("creates a new session file on the first turn and records the primary output", async () => {
    const cwd = makeTempDir("image-gen-session-first-");
    const sessionPath = join(cwd, "session.json");
    const distinctiveKey = "xai-secret-token-DO-NOT-LEAK-7Z9q";
    const fetchImpl = vi.fn().mockResolvedValue(createResponse(200, xaiResponse("first", "image/png")));

    const result = await generateImages(
      validateInput({ prompt: "first turn", session: { path: "session.json" } }, {}),
      { cwd, env: { XAI_API_KEY: distinctiveKey }, fetchImpl, now: new Date("2026-04-28T00:00:00.000Z") },
    );

    expect(result.session).not.toBeNull();
    expect(result.session?.path).toBe(sessionPath);
    expect(result.session?.turn).toBe(1);
    expect(result.session?.primary_output).toBe(result.path);

    const stored = readSessionFile(sessionPath);
    expect(stored).not.toBeNull();
    expect(stored?.version).toBe(SESSION_FILE_VERSION);
    expect(stored?.turn_count).toBe(1);
    expect(stored?.turns[0]?.prompt).toBe("first turn");
    expect(stored?.turns[0]?.primary_output).toBe(result.path);
    expect(stored?.turns[0]?.image_inputs).toEqual([]);
    expect(stored?.turns[0]?.mask).toBeNull();

    // Atomic-write hygiene: no leftover .tmp file.
    const leftover = readdirSync(cwd).filter((name) => name.endsWith(".tmp"));
    expect(leftover).toEqual([]);

    // Session must not contain API keys or base64 image payloads.
    const json = JSON.stringify(stored);
    expect(json).not.toContain(distinctiveKey);
    expect(json).not.toContain("base64");
    expect(json).not.toContain("data:image");
    expect(json).toMatch(/"primary_output":"/);
  });

  it("on a continuation turn, prepends the previous primary output as the source image", async () => {
    const cwd = makeTempDir("image-gen-session-continue-");
    const sessionPath = join(cwd, "session.json");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse(200, xaiResponse("turn-one", "image/png")))
      .mockResolvedValueOnce(createResponse(200, xaiResponse("turn-two", "image/png")));

    await generateImages(
      validateInput({ prompt: "turn one", session: { path: "session.json" } }, {}),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    await generateImages(
      validateInput({ prompt: "continue", session: { path: "session.json" } }, {}),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://api.x.ai/v1/images/edits");
    const secondBody = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(secondBody.image).toBeDefined();
    // The data URI is the previous turn's saved image, base64-encoded.
    expect(secondBody.image.url).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(secondBody.image.url.split(",")[1], "base64").toString("utf-8")).toBe("turn-one");

    const stored = readSessionFile(sessionPath);
    expect(stored?.turn_count).toBe(2);
    expect(stored?.turns[1]?.image_inputs).toHaveLength(1);
    expect(stored?.turns[1]?.image_inputs[0]).toBe(stored?.turns[0]?.primary_output);
  });

  it("with start_fresh=true skips chaining the previous output as input", async () => {
    const cwd = makeTempDir("image-gen-session-fresh-");
    const sessionPath = join(cwd, "session.json");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse(200, xaiResponse("first", "image/png")))
      .mockResolvedValueOnce(createResponse(200, xaiResponse("fresh", "image/png")));

    await generateImages(
      validateInput({ prompt: "first", session: { path: "session.json" } }, {}),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );
    const result = await generateImages(
      validateInput({ prompt: "fresh branch", session: { path: "session.json", start_fresh: true } }, {}),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    // No previous-output image was prepended → operation stays "generate".
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://api.x.ai/v1/images/generations");
    expect(result.operation).toBe("generate");
    expect(result.inputs.images).toEqual([]);
    const stored = readSessionFile(sessionPath);
    expect(stored?.turn_count).toBe(2);
    expect(stored?.turns[1]?.image_inputs).toEqual([]);
  });

  it("appends user-supplied image_inputs on top of the previous output", async () => {
    const cwd = makeTempDir("image-gen-session-append-");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse(200, xaiResponse("first", "image/png")))
      .mockResolvedValueOnce(createResponse(200, xaiResponse("blend", "image/png")));

    await generateImages(
      validateInput({ prompt: "first", session: { path: "session.json" } }, {}),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );
    const result = await generateImages(
      validateInput(
        {
          prompt: "blend in this reference",
          session: { path: "session.json" },
          image_inputs: ["https://example.com/extra.png"],
        },
        {},
      ),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    expect(result.operation).toBe("compose");
    const secondBody = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(secondBody.images).toHaveLength(2);
    expect(secondBody.images[0].url).toMatch(/^data:image\/png;base64,/); // session output
    expect(secondBody.images[1].url).toBe("https://example.com/extra.png");
  });

  it("fails clearly when the session file is malformed", async () => {
    const cwd = makeTempDir("image-gen-session-malformed-");
    writeFileSync(join(cwd, "session.json"), "{not json");

    const fetchImpl = vi.fn();
    await expect(
      generateImages(validateInput({ prompt: "p", session: { path: "session.json" } }, {}), {
        cwd,
        env: { XAI_API_KEY: "k" },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "session_error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails clearly when the previous primary output is missing on disk", async () => {
    const cwd = makeTempDir("image-gen-session-missing-output-");
    const sessionPath = join(cwd, "session.json");
    const session: SessionFile = {
      version: SESSION_FILE_VERSION,
      session_id: "x",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      primary_output: join(cwd, "deleted.png"),
      turn_count: 1,
      turns: [
        {
          turn: 1,
          prompt: "earlier",
          model: "grok-imagine-image",
          alias: "grok",
          provider: "xai",
          operation: "generate",
          image_inputs: [],
          mask: null,
          output_paths: [join(cwd, "deleted.png")],
          primary_output: join(cwd, "deleted.png"),
          timestamp: new Date().toISOString(),
        } satisfies SessionTurnRecord,
      ],
    };
    writeFileSync(sessionPath, JSON.stringify(session));

    const fetchImpl = vi.fn();
    await expect(
      generateImages(validateInput({ prompt: "next", session: { path: "session.json" } }, {}), {
        cwd,
        env: { XAI_API_KEY: "k" },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "session_error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates session file shape via isValidSessionFile", () => {
    expect(isValidSessionFile(null)).toBe(false);
    expect(isValidSessionFile({ version: 999 })).toBe(false);
    const valid = createSessionFile(new Date());
    expect(isValidSessionFile(valid)).toBe(true);

    // Tightened deep validation:
    expect(isValidSessionFile({ ...valid, created_at: 0 })).toBe(false);
    expect(isValidSessionFile({ ...valid, updated_at: "" })).toBe(false);
    expect(isValidSessionFile({ ...valid, turn_count: -1 })).toBe(false);
    expect(isValidSessionFile({ ...valid, turn_count: 1, turns: [] })).toBe(false); // turn_count must equal turns.length
    const validTurn: SessionTurnRecord = {
      turn: 1,
      prompt: "p",
      model: "m",
      alias: null,
      provider: "xai",
      operation: "generate",
      image_inputs: [],
      mask: null,
      output_paths: ["/abs/out.png"],
      primary_output: "/abs/out.png",
      timestamp: "2026-04-28T00:00:00.000Z",
    };
    expect(
      isValidSessionFile({
        ...valid,
        turn_count: 1,
        primary_output: "/abs/out.png",
        turns: [validTurn],
      }),
    ).toBe(true);
    expect(
      isValidSessionFile({
        ...valid,
        turn_count: 1,
        primary_output: "/abs/out.png",
        turns: [{ ...validTurn, operation: "transmute" }],
      }),
    ).toBe(false);
    expect(
      isValidSessionFile({
        ...valid,
        turn_count: 1,
        primary_output: "/abs/out.png",
        turns: [{ ...validTurn, image_inputs: [123] }],
      }),
    ).toBe(false);
    expect(
      isValidSessionFile({
        ...valid,
        turn_count: 1,
        primary_output: "/abs/out.png",
        turns: [{ ...validTurn, provider: "imaginary" }],
      }),
    ).toBe(false);
  });

  it("rejects a session file whose turn records are malformed before any fetch", async () => {
    const cwd = makeTempDir("image-gen-session-malformed-turns-");
    const sessionPath = join(cwd, "session.json");
    // Looks like a session, but turns[0].image_inputs has a non-string entry.
    writeFileSync(
      sessionPath,
      JSON.stringify({
        version: SESSION_FILE_VERSION,
        session_id: "id",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        primary_output: "/abs/out.png",
        turn_count: 1,
        turns: [
          {
            turn: 1,
            prompt: "earlier",
            model: "grok-imagine-image",
            alias: "grok",
            provider: "xai",
            operation: "generate",
            image_inputs: [123],
            mask: null,
            output_paths: ["/abs/out.png"],
            primary_output: "/abs/out.png",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const fetchImpl = vi.fn();
    await expect(
      generateImages(validateInput({ prompt: "next", session: { path: "session.json" } }, {}), {
        cwd,
        env: { XAI_API_KEY: "k" },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "session_error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a session whose turn_count > 0 but primary_output is null", async () => {
    const cwd = makeTempDir("image-gen-session-no-primary-");
    const sessionPath = join(cwd, "session.json");
    const turn: SessionTurnRecord = {
      turn: 1,
      prompt: "earlier",
      model: "grok-imagine-image",
      alias: "grok",
      provider: "xai",
      operation: "generate",
      image_inputs: [],
      mask: null,
      output_paths: ["/abs/out.png"],
      primary_output: "/abs/out.png",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(
      sessionPath,
      JSON.stringify({
        version: SESSION_FILE_VERSION,
        session_id: "id",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        primary_output: null,
        turn_count: 1,
        turns: [turn],
      }),
    );

    const fetchImpl = vi.fn();
    await expect(
      generateImages(validateInput({ prompt: "next", session: { path: "session.json" } }, {}), {
        cwd,
        env: { XAI_API_KEY: "k" },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "session_error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("supports session + mask continuation by deferring the mask shape check", async () => {
    const cwd = makeTempDir("image-gen-session-mask-");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse(200, xaiResponse("turn-one", "image/png")))
      .mockResolvedValueOnce(createResponse(200, xaiResponse("masked-edit", "image/png")));

    await generateImages(
      validateInput({ prompt: "first", model: "grok-pro", session: { path: "session.json" } }, {}),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    // Continuation: no image_inputs, but mask is supplied. Session prepends the previous
    // primary_output, so the effective shape becomes one input plus a mask.
    const result = await generateImages(
      validateInput(
        {
          prompt: "constrain to mask",
          model: "grok-pro",
          mask: "https://example.com/mask.png",
          session: { path: "session.json" },
        },
        {},
      ),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    expect(result.operation).toBe("mask_edit");
    const secondBody = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(secondBody.image).toBeDefined();
    expect(secondBody.mask).toEqual({ url: "https://example.com/mask.png" });
  });

  it("rejects operation hint mismatches that only become visible after session continuation", async () => {
    const cwd = makeTempDir("image-gen-session-hint-mismatch-");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse(200, xaiResponse("first", "image/png")));

    await generateImages(
      validateInput({ prompt: "first", session: { path: "session.json" } }, {}),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    await expect(
      generateImages(
        validateInput(
          { prompt: "next", operation: "generate", session: { path: "session.json" } },
          {},
        ),
        { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringMatching(/Declared operation "generate" does not match/),
    });
    // Only the first call should have hit the network.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("appendSessionTurn updates primary_output and turn_count", () => {
    const session = createSessionFile(new Date("2026-01-01"));
    const turn: SessionTurnRecord = {
      turn: 1,
      prompt: "p",
      model: "m",
      alias: null,
      provider: "xai",
      operation: "generate",
      image_inputs: [],
      mask: null,
      output_paths: ["/abs/out.png"],
      primary_output: "/abs/out.png",
      timestamp: new Date().toISOString(),
    };
    const updated = appendSessionTurn(session, turn, new Date("2026-01-02"));
    expect(updated.turn_count).toBe(1);
    expect(updated.primary_output).toBe("/abs/out.png");
    expect(updated.turns).toHaveLength(1);
    expect(updated.updated_at).toBe(new Date("2026-01-02").toISOString());
  });

  it("writeSessionFileAtomic cleans up the temp file when rename fails after the temp was written", () => {
    const cwd = makeTempDir("image-gen-session-atomic-");
    const session = createSessionFile(new Date());
    // Force renameSync to fail by making the target path a non-empty directory.
    // The temp file gets written, and only the rename step fails.
    const targetPath = join(cwd, "session.json");
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, "child.txt"), "block");

    expect(() => writeSessionFileAtomic(targetPath, session)).toThrowError(
      /Could not write session file/,
    );
    // Verify no leftover .tmp file remains in the parent directory.
    const leftover = readdirSync(cwd).filter((name) => name.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("writeSessionFileAtomic surfaces a session_error when the parent path is unusable", () => {
    const cwd = makeTempDir("image-gen-session-atomic-parent-");
    const session = createSessionFile(new Date());
    // Parent is a regular file, so mkdirSync(dirname, recursive) will fail.
    const blocker = join(cwd, "blocker");
    writeFileSync(blocker, "blocker");
    const targetPath = join(blocker, "child.json");

    expect(() => writeSessionFileAtomic(targetPath, session)).toThrowError(
      /Could not write session file/,
    );
  });
});

describe("error handling", () => {
  it("surfaces HTTP error bodies", async () => {
    const cwd = makeTempDir("image-gen-error-");
    await expect(
      generateImages(validateInput({ prompt: "hello", model: "nano-banana-2" }, {}), {
        cwd,
        env: { OPENROUTER_API_KEY: "test-key" },
        fetchImpl: vi.fn().mockResolvedValue(createResponse(429, { error: { message: "model unavailable" } })),
      }),
    ).rejects.toMatchObject({ code: "api_error", message: "model unavailable", status: 429 });
  });

  it("rejects empty image responses", async () => {
    const cwd = makeTempDir("image-gen-empty-");
    await expect(
      generateImages(validateInput({ prompt: "hello", model: "nano-banana-2" }, {}), {
        cwd,
        env: { OPENROUTER_API_KEY: "test-key" },
        fetchImpl: vi.fn().mockResolvedValue(createResponse(200, { choices: [{ message: { content: "no image" } }] })),
      }),
    ).rejects.toThrowError("OpenRouter returned no generated images.");
  });

  it("creates structured stdout errors and human stderr lines when xAI auth is missing", async () => {
    const cwd = makeTempDir("image-gen-no-env-");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runCli(['{"prompt":"test"}'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      env: {},
      moduleUrl: `file://${join(cwd, "cli.js")}`,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.chunks.join(""))).toEqual({
      ok: false,
      error: "Missing XAI_API_KEY. Set it in the environment or packages/image-gen/.env. Get a key at https://console.x.ai/.",
      code: "auth_error",
    });
    expect(stderr.chunks.join("")).toContain("auth_error");
  });

  it("creates provider-specific auth errors for OpenRouter presets", async () => {
    const cwd = makeTempDir("image-gen-no-openrouter-env-");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runCli(['{"prompt":"test","model":"flux-pro"}'], {
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

  it("emits a structured capability_error envelope for unsupported combinations before the network", async () => {
    const cwd = makeTempDir("image-gen-cap-error-");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    const fetchImpl = vi.fn();

    const exitCode = await runCli(
      ['{"prompt":"x","model":"nano-banana-2","image_inputs":["https://example.com/a.png"],"mask":"https://example.com/m.png"}'],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        stdinIsTTY: true,
        env: { OPENROUTER_API_KEY: "k" },
        moduleUrl: `file://${join(cwd, "cli.js")}`,
        fetchImpl,
      },
    );

    expect(exitCode).toBe(1);
    const failure = JSON.parse(stdout.chunks.join(""));
    expect(failure.ok).toBe(false);
    expect(failure.code).toBe("capability_error");
    expect(failure.error).toMatch(/does not support mask-based edits/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("cli helpers", () => {
  it("returns help, version, and model listing text", async () => {
    expect(getVersion()).toBe("0.2.0");
    expect(getHelpText()).toContain("Usage:");
    expect(getHelpText()).toContain("XAI_API_KEY");
    expect(getHelpText()).toContain("Output shape");
    expect(getHelpText()).toContain("image_inputs");
    expect(getHelpText()).toContain("session");
    expect(getHelpText()).toContain("mask_edit");
    expect(getListModelsText()).toContain("grok-pro");
    expect(getListModelsText()).toContain("flux-pro");
    expect(getListModelsText()).toContain("ops:");

    const helpStdout = createWritableCapture();
    expect(await runCli(["--help"], { stdout: helpStdout.stream, stderr: createWritableCapture().stream })).toBe(0);
    expect(helpStdout.chunks.join("")).toContain("JSON-first image generation and editing");

    const versionStdout = createWritableCapture();
    expect(await runCli(["--version"], { stdout: versionStdout.stream, stderr: createWritableCapture().stream })).toBe(0);
    expect(versionStdout.chunks.join("")).toBe("0.2.0\n");

    const statusStdout = createWritableCapture();
    const statusPkg = makeTempDir("image-gen-status-pkg-");
    expect(
      await runCli(["--status"], {
        stdout: statusStdout.stream,
        stderr: createWritableCapture().stream,
        env: { XAI_API_KEY: "xai-secret" },
        moduleUrl: `file://${join(statusPkg, "cli.js")}`,
      }),
    ).toBe(0);
    const status = JSON.parse(statusStdout.chunks.join(""));
    expect(status.providers.xai.configured).toBe(true);
    expect(status.providers.openrouter.configured).toBe(false);
    expect(status.default_model).toMatchObject({ alias: "grok", provider: "xai", usable: true });
    expect(status.presets.find((preset: { alias: string }) => preset.alias === "flux-pro").usable).toBe(false);
    const grokStatus = status.presets.find((preset: { alias: string }) => preset.alias === "grok");
    expect(grokStatus.image_inputs).toBe(true);
    expect(grokStatus.multi_image).toBe(true);
    expect(grokStatus.mask).toBe(true);
    expect(grokStatus.session_continuation).toBe(true);
    expect(grokStatus.max_image_inputs).toBe(5);
    expect(status.passthrough.image_inputs).toBe("unknown");
    expect(status.passthrough.mask).toBe("unsupported");
    expect(statusStdout.chunks.join("")).not.toContain("xai-secret");
  });

  it("reports provider readiness without exposing secrets", () => {
    const report = getStatusReport({ OPENROUTER_API_KEY: "openrouter-secret" });
    expect(report.providers.xai.configured).toBe(false);
    expect(report.providers.openrouter.configured).toBe(true);
    expect(report.default_model).toMatchObject({ alias: "grok", provider: "xai", usable: false });
    expect(report.passthrough).toMatchObject({
      provider: "openrouter",
      image_inputs: "unknown",
      multi_image: "unknown",
      mask: "unsupported",
      session_continuation: "unknown",
    });
    expect(JSON.stringify(report)).not.toContain("openrouter-secret");
  });

  it("supports direct execution detection", () => {
    expect(isDirectExecution("file:///tmp/image-gen/dist/cli.js", "/tmp/image-gen/dist/cli.js")).toBe(true);
    expect(isDirectExecution("file:///tmp/image-gen/dist/cli.js", "/tmp/other.js")).toBe(false);
  });

  it("extracts cost when present and returns null otherwise", () => {
    expect(extractCostUsd({ usage: { cost: 1.25 } })).toBe(1.25);
    expect(extractCostUsd({ usage: {} })).toBeNull();
    expect(extractCostUsd({ usage: { cost_in_usd_ticks: XAI_USD_TICKS_PER_DOLLAR / 100 } })).toBeCloseTo(0.01, 6);
  });

  it("creates failure envelopes from typed errors", () => {
    expect(createFailureEnvelope(new ImageGenCliError("validation_error", "bad input"))).toEqual({
      ok: false,
      error: "bad input",
      code: "validation_error",
    });
  });

  it("preserves reference_images backward compatibility end-to-end", async () => {
    const cwd = makeTempDir("image-gen-refs-bc-");
    const fetchImpl = vi.fn().mockResolvedValue(createResponse(200, xaiResponse("edit", "image/png")));

    const result = await generateImages(
      validateInput(
        {
          prompt: "remix this reference",
          model: "grok",
          // legacy field name only
          reference_images: ["https://example.com/old.png"],
        },
        {},
      ),
      { cwd, env: { XAI_API_KEY: "k" }, fetchImpl },
    );

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.x.ai/v1/images/edits");
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.image).toEqual({ url: "https://example.com/old.png" });
    expect(result.operation).toBe("edit");
    expect(result.inputs.images).toEqual(["https://example.com/old.png"]);
  });

  it("end-to-end CLI emits the new envelope shape on success", async () => {
    const cwd = makeTempDir("image-gen-cli-success-");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    const fetchImpl = vi.fn().mockResolvedValue(createResponse(200, xaiResponse("ok")));
    const exitCode = await runCli(['{"prompt":"hi"}'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      env: { XAI_API_KEY: "k" },
      moduleUrl: `file://${join(cwd, "cli.js")}`,
      cwd,
      fetchImpl,
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.chunks.join(""));
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("generate");
    expect(payload.inputs).toEqual({ images: [], mask: null });
    expect(payload.session).toBeNull();
    expect(existsSync(payload.path)).toBe(true);
  });
});
