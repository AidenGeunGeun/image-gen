#!/usr/bin/env node

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, extname, join, parse, resolve } from "path";
import { fileURLToPath } from "url";

export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_REFERER = "https://github.com/AidenGeunGeun/image-gen";
export const OPENROUTER_DEFAULT_TITLE = "image-gen";
export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
export const IMAGE_GEN_DEFAULT_MODEL = "grok";
export const IMAGE_GEN_DEFAULT_OUTPUT_DIR = "./generated";
export const REQUEST_TIMEOUT_MS = 120_000;
export const MODEL_PRESETS = {
  grok: {
    model: "grok-imagine-image",
    provider: "xai",
    costTier: "daily",
    description: "cheap daily-driver Grok Imagine generation",
    supportsGeneration: true,
    supportsReferenceImages: true,
  },
  "grok-pro": {
    model: "grok-imagine-image-pro",
    provider: "xai",
    costTier: "pro",
    description: "higher-quality Grok Imagine Pro generation",
    supportsGeneration: true,
    supportsReferenceImages: true,
  },
  "flux-pro": {
    model: "black-forest-labs/flux-2-pro",
    provider: "openrouter",
    costTier: "openrouter-pro",
    description: "OpenRouter FLUX.2 Pro fallback/polish route",
    supportsGeneration: true,
    supportsReferenceImages: true,
  },
  "nano-banana-2": {
    model: "google/gemini-3.1-flash-image-preview",
    provider: "openrouter",
    costTier: "compat",
    description: "existing OpenRouter Gemini compatibility alias",
    supportsGeneration: true,
    supportsReferenceImages: true,
  },
  "nano-banana-pro": {
    model: "google/gemini-3-pro-image-preview",
    provider: "openrouter",
    costTier: "compat-pro",
    description: "existing OpenRouter Gemini Pro compatibility alias",
    supportsGeneration: true,
    supportsReferenceImages: true,
  },
  "gpt-image": {
    model: "openai/gpt-5.4-image-2",
    provider: "openrouter",
    costTier: "compat-pro",
    description: "existing OpenRouter GPT image compatibility alias",
    supportsGeneration: true,
    supportsReferenceImages: true,
  },
} as const;
export const MODEL_ALIASES = Object.fromEntries(
  Object.entries(MODEL_PRESETS).map(([alias, preset]) => [alias, preset.model]),
) as { [K in keyof typeof MODEL_PRESETS]: (typeof MODEL_PRESETS)[K]["model"] };
export const XAI_MODEL_IDS = new Set(["grok-imagine-image", "grok-imagine-image-pro"]);
export const ALLOWED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
  "2:3",
  "3:2",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "1:2",
  "2:1",
  "auto",
] as const;

export type ImageGenAlias = keyof typeof MODEL_PRESETS;
export type AllowedAspectRatio = (typeof ALLOWED_ASPECT_RATIOS)[number];
export type ImageGenErrorCode = "validation_error" | "auth_error" | "api_error" | "network_error";
export type ModelFamilyKind = "text-image" | "image-only";
export type ImageProvider = "xai" | "openrouter";

export interface ImageGenInput {
  prompt: string;
  model?: string;
  output?: string;
  output_dir?: string;
  aspect_ratio?: AllowedAspectRatio;
  size?: string;
  n?: number;
  reference_images?: string[];
  system?: string;
  seed?: number;
}

export interface ValidatedImageGenInput {
  prompt: string;
  model: string;
  alias: string | null;
  provider: ImageProvider;
  output?: string;
  outputDir: string;
  aspectRatio?: AllowedAspectRatio;
  size?: string;
  n: number;
  referenceImages: string[];
  system?: string;
  seed?: number;
}

export interface ModelResolution {
  alias: string | null;
  model: string;
  provider: ImageProvider;
}

export interface ModelFamily {
  kind: ModelFamilyKind;
  supportsBatchN: boolean;
}

export interface GeneratedImage {
  buffer: Buffer;
  extension: string;
  mimeType: string;
}

export interface ImageGenSuccessEnvelope {
  ok: true;
  path: string;
  paths: string[];
  model: string;
  alias: string | null;
  provider: ImageProvider;
  bytes: number;
  elapsed_ms: number;
  cost_usd: number | null;
  prompt: string;
}

export interface ImageGenPresetStatus {
  alias: string;
  model: string;
  provider: ImageProvider;
  cost_tier: string;
  generation: boolean;
  reference_images: boolean;
  usable: boolean;
  description: string;
}

export interface ImageGenStatusReport {
  ok: true;
  default_model: ModelResolution & { usable: boolean };
  providers: Record<ImageProvider, { configured: boolean }>;
  presets: ImageGenPresetStatus[];
  passthrough: { provider: "openrouter"; usable: boolean; pattern: string };
}

export interface ImageGenFailureEnvelope {
  ok: false;
  error: string;
  code: string;
}

export interface GenerateImagesOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface RunCliOptions {
  stdin?: NodeJS.ReadableStream;
  stdinIsTTY?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  moduleUrl?: string;
  cwd?: string;
  now?: Date;
}

export class ImageGenCliError extends Error {
  code: ImageGenErrorCode;
  status?: number;

  constructor(code: ImageGenErrorCode, message: string, options: { status?: number } = {}) {
    super(message);
    this.name = "ImageGenCliError";
    this.code = code;
    this.status = options.status;
  }
}

// 1. env loading

export function resolvePackageRoot(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  return basename(moduleDir) === "dist" ? join(moduleDir, "..") : moduleDir;
}

export function resolveEnvPath(moduleUrl: string): string {
  return join(resolvePackageRoot(moduleUrl), ".env");
}

export function parseEnvLines(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    values[key] = value;
  }

  return values;
}

export function loadPackageEnv(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
  readFile: (path: string, encoding: BufferEncoding) => string = readFileSync,
): string | null {
  const envPath = resolveEnvPath(moduleUrl);
  if (!fileExists(envPath)) {
    return null;
  }

  const values = parseEnvLines(readFile(envPath, "utf-8"));
  for (const [key, value] of Object.entries(values)) {
    if (!(key in env)) {
      env[key] = value;
    }
  }

  return envPath;
}

// 2. types and validation

const ALLOWED_INPUT_FIELDS = new Set([
  "prompt",
  "model",
  "output",
  "output_dir",
  "aspect_ratio",
  "size",
  "n",
  "reference_images",
  "system",
  "seed",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonInput(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageGenCliError("validation_error", `Invalid JSON input: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new ImageGenCliError("validation_error", "Input must be a JSON object.");
  }

  return parsed;
}

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

export function formatAllowedValues(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

export function isVendorModelId(value: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value);
}

export function resolveModelSpecifier(specifier: string): ModelResolution {
  const trimmed = specifier.trim();
  if (!trimmed) {
    throw new ImageGenCliError("validation_error", "Model cannot be empty.");
  }

  const preset = MODEL_PRESETS[trimmed as ImageGenAlias];
  if (preset) {
    return { alias: trimmed, model: preset.model, provider: preset.provider };
  }

  if (XAI_MODEL_IDS.has(trimmed)) {
    return { alias: null, model: trimmed, provider: "xai" };
  }

  if (isVendorModelId(trimmed)) {
    return { alias: null, model: trimmed, provider: "openrouter" };
  }

  throw new ImageGenCliError(
    "validation_error",
    `Unknown model "${trimmed}". Use --list-models to see built-in aliases, xAI model IDs, or pass a full vendor/slug OpenRouter model ID.`,
  );
}

export function resolveModelFamily(model: string): ModelFamily {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("black-forest-labs/") || normalized.startsWith("sourceful/") || normalized.includes("/flux")) {
    return { kind: "image-only", supportsBatchN: false };
  }

  return { kind: "text-image", supportsBatchN: true };
}

export function supportsImageConfig(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.startsWith("google/gemini-");
}

export function parseInteger(value: unknown, fieldName: string, min: number, max?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ImageGenCliError("validation_error", `Invalid "${fieldName}". Expected an integer.`);
  }

  if (value < min || (max !== undefined && value > max)) {
    const range = max === undefined ? `>= ${min}` : `${min}-${max}`;
    throw new ImageGenCliError("validation_error", `Invalid "${fieldName}". Expected an integer in range ${range}.`);
  }

  return value;
}

export function parseNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ImageGenCliError("validation_error", `Invalid "${fieldName}". Expected a non-empty string.`);
  }
  return value.trim();
}

export function parseOptionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseNonEmptyString(value, fieldName);
}

export function parseReferenceImages(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ImageGenCliError("validation_error", 'Invalid "reference_images". Expected an array of non-empty strings.');
  }

  return value.map((item) => item.trim());
}

export function validateInput(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): ValidatedImageGenInput {
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      throw new ImageGenCliError("validation_error", `Unknown field: ${key}`);
    }
  }

  const prompt = parseOptionalNonEmptyString(raw.prompt, "prompt");
  if (!prompt) {
    throw new ImageGenCliError("validation_error", "Missing required field: prompt");
  }

  const modelSpecifier = parseOptionalNonEmptyString(raw.model, "model")
    ?? parseOptionalNonEmptyString(env.IMAGE_GEN_DEFAULT_MODEL, "IMAGE_GEN_DEFAULT_MODEL")
    ?? IMAGE_GEN_DEFAULT_MODEL;
  const { alias, model, provider } = resolveModelSpecifier(modelSpecifier);

  const output = parseOptionalNonEmptyString(raw.output, "output");
  const outputDir = parseOptionalNonEmptyString(raw.output_dir, "output_dir")
    ?? parseOptionalNonEmptyString(env.IMAGE_GEN_OUTPUT_DIR, "IMAGE_GEN_OUTPUT_DIR")
    ?? IMAGE_GEN_DEFAULT_OUTPUT_DIR;

  let aspectRatio: AllowedAspectRatio | undefined;
  if (raw.aspect_ratio !== undefined) {
    if (typeof raw.aspect_ratio !== "string" || !ALLOWED_ASPECT_RATIOS.includes(raw.aspect_ratio as AllowedAspectRatio)) {
      throw new ImageGenCliError(
        "validation_error",
        `Invalid "aspect_ratio". Expected one of: ${formatAllowedValues(ALLOWED_ASPECT_RATIOS)}`,
      );
    }
    aspectRatio = raw.aspect_ratio as AllowedAspectRatio;
  }

  const size = parseOptionalNonEmptyString(raw.size, "size");
  const n = raw.n === undefined ? 1 : parseInteger(raw.n, "n", 1, 4);
  const referenceImages = parseReferenceImages(raw.reference_images);
  const system = parseOptionalNonEmptyString(raw.system, "system");
  const seed = raw.seed === undefined ? undefined : parseInteger(raw.seed, "seed", 0);

  return {
    prompt,
    model,
    alias,
    provider,
    ...(output ? { output } : {}),
    outputDir,
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(size ? { size } : {}),
    n,
    referenceImages,
    ...(system ? { system } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };
}

export function resolveReferenceImagePath(referenceImage: string, cwd = process.cwd()): string {
  return resolve(cwd, referenceImage);
}

export function guessMimeTypeFromPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      return "image/png";
  }
}

export function prepareReferenceImages(referenceImages: string[], cwd = process.cwd()): string[] {
  return referenceImages.map((referenceImage) => {
    if (referenceImage.startsWith("https://")) {
      return referenceImage;
    }

    if (/^https?:\/\//.test(referenceImage)) {
      throw new ImageGenCliError(
        "validation_error",
        `Invalid reference image URL: ${referenceImage}. Only HTTPS URLs are supported.`,
      );
    }

    const absolutePath = resolveReferenceImagePath(referenceImage, cwd);
    try {
      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        throw new Error("not a file");
      }
      const buffer = readFileSync(absolutePath);
      const mimeType = guessMimeTypeFromPath(absolutePath);
      return `data:${mimeType};base64,${buffer.toString("base64")}`;
    } catch {
      throw new ImageGenCliError(
        "validation_error",
        `Could not read reference image: ${referenceImage}`,
      );
    }
  });
}

export function buildRequestBody(
  input: ValidatedImageGenInput,
  referenceImages: string[],
  requestCount = input.n,
): Record<string, unknown> {
  const family = resolveModelFamily(input.model);
  const messages: Array<Record<string, unknown>> = [];

  if (input.system) {
    messages.push({ role: "system", content: input.system });
  }

  const userContent = referenceImages.length === 0
    ? input.prompt
    : [
        { type: "text", text: input.prompt },
        ...referenceImages.map((url) => ({
          type: "image_url",
          image_url: { url },
        })),
      ];

  messages.push({ role: "user", content: userContent });

  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    modalities: family.kind === "image-only" ? ["image"] : ["image", "text"],
  };

  const imageConfig: Record<string, unknown> = {};
  if (input.aspectRatio) {
    imageConfig.aspect_ratio = input.aspectRatio;
  }
  if (input.size) {
    imageConfig.image_size = input.size;
  }
  if (supportsImageConfig(input.model) && Object.keys(imageConfig).length > 0) {
    body.image_config = imageConfig;
  }

  if (family.supportsBatchN && requestCount > 0) {
    body.n = requestCount;
  }
  if (input.seed !== undefined) {
    body.seed = input.seed;
  }

  return body;
}

export function normalizeXaiResolution(size: string | undefined): "1k" | "2k" | undefined {
  if (!size) {
    return undefined;
  }

  const normalized = size.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "1k" || normalized === "1024") {
    return "1k";
  }
  if (normalized === "2k" || normalized === "2048") {
    return "2k";
  }
  return undefined;
}

export function buildXaiRequestBody(
  input: ValidatedImageGenInput,
  referenceImages: string[],
  requestCount = input.n,
): Record<string, unknown> {
  if (referenceImages.length > 5) {
    throw new ImageGenCliError("validation_error", "xAI image edits support at most 5 reference images.");
  }

  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.system ? `${input.system}\n\n${input.prompt}` : input.prompt,
    response_format: "b64_json",
  };

  if (requestCount > 1) {
    body.n = requestCount;
  }
  if (input.aspectRatio) {
    body.aspect_ratio = input.aspectRatio;
  }
  const resolution = normalizeXaiResolution(input.size);
  if (resolution) {
    body.resolution = resolution;
  }
  if (input.seed !== undefined) {
    body.seed = input.seed;
  }

  if (referenceImages.length === 1) {
    body.image = { url: referenceImages[0], type: "image_url" };
  } else if (referenceImages.length > 1) {
    body.images = referenceImages.map((url) => ({ url, type: "image_url" }));
  }

  return body;
}

// 3. provider clients and decoding

export function getOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new ImageGenCliError(
      "auth_error",
      "Missing OPENROUTER_API_KEY. Set it in the environment or packages/image-gen/.env. Get a key at https://openrouter.ai/keys.",
    );
  }
  return apiKey;
}

export function getXaiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.XAI_API_KEY?.trim();
  if (!apiKey) {
    throw new ImageGenCliError(
      "auth_error",
      "Missing XAI_API_KEY. Set it in the environment or packages/image-gen/.env. Get a key at https://console.x.ai/.",
    );
  }
  return apiKey;
}

export function getXaiEndpoint(kind: "generations" | "edits", env: NodeJS.ProcessEnv = process.env): string {
  const baseUrl = (env.XAI_BASE_URL?.trim() || XAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${baseUrl}/images/${kind}`;
}

export function getXaiHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export function getOpenRouterEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const baseUrl = (env.OPENROUTER_BASE_URL?.trim() || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
}

export function getOpenRouterHeaders(apiKey: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const referer = env.OPENROUTER_HTTP_REFERER?.trim() || env.OPENROUTER_REFERER?.trim() || OPENROUTER_DEFAULT_REFERER;
  const title = env.OPENROUTER_TITLE?.trim() || env.OPENROUTER_X_TITLE?.trim() || OPENROUTER_DEFAULT_TITLE;
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": referer,
    "X-Title": title,
    "X-OpenRouter-Title": title,
  };
}

export function extractApiErrorMessage(parsedBody: unknown, rawText: string, status: number, providerName = "OpenRouter"): string {
  if (isRecord(parsedBody)) {
    if (typeof parsedBody.message === "string" && parsedBody.message.trim()) {
      return parsedBody.message.trim();
    }
    if (typeof parsedBody.error === "string" && parsedBody.error.trim()) {
      return parsedBody.error.trim();
    }
    if (isRecord(parsedBody.error) && typeof parsedBody.error.message === "string" && parsedBody.error.message.trim()) {
      return parsedBody.error.message.trim();
    }
  }

  const trimmed = rawText.trim();
  return trimmed || `${providerName} request failed with status ${status}.`;
}

export async function requestOpenRouter(
  body: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(getOpenRouterEndpoint(env), {
      method: "POST",
      headers: getOpenRouterHeaders(getOpenRouterApiKey(env), env),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    const parsedBody = rawText ? safeJsonParse(rawText) : null;

    if (!response.ok) {
      const message = extractApiErrorMessage(parsedBody, rawText, response.status, "OpenRouter");
      throw new ImageGenCliError(response.status === 401 || response.status === 403 ? "auth_error" : "api_error", message, {
        status: response.status,
      });
    }

    if (!isRecord(parsedBody)) {
      throw new ImageGenCliError("api_error", "OpenRouter returned an empty or non-JSON response.", {
        status: response.status,
      });
    }

    return parsedBody;
  } catch (error) {
    if (error instanceof ImageGenCliError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ImageGenCliError("network_error", "OpenRouter request timed out.");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageGenCliError("network_error", `OpenRouter request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestXai(
  kind: "generations" | "edits",
  body: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(getXaiEndpoint(kind, env), {
      method: "POST",
      headers: getXaiHeaders(getXaiApiKey(env)),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    const parsedBody = rawText ? safeJsonParse(rawText) : null;

    if (!response.ok) {
      const message = extractApiErrorMessage(parsedBody, rawText, response.status, "xAI");
      throw new ImageGenCliError(response.status === 401 || response.status === 403 ? "auth_error" : "api_error", message, {
        status: response.status,
      });
    }

    if (!isRecord(parsedBody)) {
      throw new ImageGenCliError("api_error", "xAI returned an empty or non-JSON response.", {
        status: response.status,
      });
    }

    return parsedBody;
  } catch (error) {
    if (error instanceof ImageGenCliError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ImageGenCliError("network_error", "xAI request timed out.");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageGenCliError("network_error", `xAI request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function mimeTypeToExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "png";
  }
}

export function decodeImageDataUrl(dataUrl: string): GeneratedImage {
  const match = dataUrl.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/s);
  if (!match) {
    throw new ImageGenCliError("api_error", "OpenRouter returned an unsupported image payload.");
  }

  return decodeBase64Image(match[2] || "", match[1] || "image/png");
}

export function decodeBase64Image(base64: string, mimeType = "image/png"): GeneratedImage {
  return {
    buffer: Buffer.from(base64, "base64"),
    extension: mimeTypeToExtension(mimeType),
    mimeType,
  };
}

export function decodeGeneratedImages(payload: unknown): GeneratedImage[] {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return [];
  }

  const images: GeneratedImage[] = [];
  for (const choice of payload.choices) {
    if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.images)) {
      continue;
    }

    for (const image of choice.message.images) {
      if (!isRecord(image) || !isRecord(image.image_url) || typeof image.image_url.url !== "string") {
        continue;
      }
      images.push(decodeImageDataUrl(image.image_url.url));
    }
  }

  return images;
}

export function decodeXaiGeneratedImages(payload: unknown): GeneratedImage[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  const images: GeneratedImage[] = [];
  for (const image of payload.data) {
    if (!isRecord(image) || typeof image.b64_json !== "string") {
      continue;
    }
    const mimeType = typeof image.mime_type === "string" && image.mime_type.trim() ? image.mime_type.trim() : "image/png";
    if (image.b64_json.startsWith("data:")) {
      images.push(decodeImageDataUrl(image.b64_json));
    } else {
      images.push(decodeBase64Image(image.b64_json, mimeType));
    }
  }

  return images;
}

export function createTimestampFragment(now = new Date()): string {
  return now.toISOString().replace(/:/g, "-");
}

export function createImageFileName(
  prompt: string,
  model: string,
  index: number,
  image: GeneratedImage,
  timestamp: string,
): string {
  const hash = createHash("sha256")
    .update(prompt)
    .update("\0")
    .update(model)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(image.buffer)
    .digest("hex")
    .slice(0, 8);
  return `image-${timestamp}-${hash}.${image.extension}`;
}

export function resolveOutputPaths(
  settings: {
    output?: string;
    outputDir: string;
    cwd: string;
    prompt: string;
    model: string;
  },
  images: GeneratedImage[],
  now = new Date(),
): string[] {
  const timestamp = createTimestampFragment(now);
  if (!settings.output) {
    const outputDirectory = resolve(settings.cwd, settings.outputDir);
    mkdirSync(outputDirectory, { recursive: true });
    return images.map((image, index) => resolve(outputDirectory, createImageFileName(settings.prompt, settings.model, index, image, timestamp)));
  }

  const outputPath = resolve(settings.cwd, settings.output);
  const treatAsDirectory = settings.output.endsWith("/") || settings.output.endsWith("\\") || (existsSync(outputPath) && statSync(outputPath).isDirectory());
  if (treatAsDirectory) {
    mkdirSync(outputPath, { recursive: true });
    return images.map((image, index) => resolve(outputPath, createImageFileName(settings.prompt, settings.model, index, image, timestamp)));
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const parsed = parse(outputPath);
  const primaryImage = images[0];
  const primaryExtension = primaryImage ? `.${primaryImage.extension}` : parsed.ext || ".png";
  const primaryPath = resolve(parsed.dir, `${parsed.name}${primaryExtension}`);
  return images.map((image, index) => {
    if (index === 0) {
      return primaryPath;
    }
    return resolve(parsed.dir, `${parsed.name}-${index + 1}.${image.extension}`);
  });
}

export function extractCostUsd(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }

  const candidates = [
    isRecord(payload.usage) ? payload.usage.cost : undefined,
    isRecord(payload.usage) ? payload.usage.total_cost : undefined,
    payload.total_cost,
    payload.cost,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function generateImages(
  input: ValidatedImageGenInput,
  options: GenerateImagesOptions = {},
): Promise<ImageGenSuccessEnvelope> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const referenceImages = prepareReferenceImages(input.referenceImages, cwd);
  const family = input.provider === "openrouter" ? resolveModelFamily(input.model) : { kind: "text-image", supportsBatchN: true };
  const startedAt = Date.now();
  const generatedImages: GeneratedImage[] = [];
  let totalCost = 0;
  let sawCost = false;
  let missingCost = false;
  let attempts = 0;

  while (generatedImages.length < input.n && attempts < input.n) {
    const remaining = input.n - generatedImages.length;
    const requestCount = family.supportsBatchN ? remaining : 1;
    const response = input.provider === "xai"
      ? await requestXai(referenceImages.length === 0 ? "generations" : "edits", buildXaiRequestBody(input, referenceImages, requestCount), {
          env,
          fetchImpl: options.fetchImpl,
        })
      : await requestOpenRouter(buildRequestBody(input, referenceImages, requestCount), {
          env,
          fetchImpl: options.fetchImpl,
        });
    const batch = input.provider === "xai" ? decodeXaiGeneratedImages(response) : decodeGeneratedImages(response);
    if (batch.length === 0) {
      throw new ImageGenCliError("api_error", `${input.provider === "xai" ? "xAI" : "OpenRouter"} returned no generated images.`);
    }

    generatedImages.push(...batch.slice(0, remaining));
    const cost = extractCostUsd(response);
    if (cost === null) {
      missingCost = true;
    } else {
      sawCost = true;
      totalCost += cost;
    }
    attempts += 1;

    if (family.supportsBatchN && batch.length >= remaining) {
      break;
    }
  }

  if (generatedImages.length === 0) {
    throw new ImageGenCliError("api_error", `${input.provider === "xai" ? "xAI" : "OpenRouter"} returned no generated images.`);
  }

  const finalImages = generatedImages.slice(0, input.n);
  const paths = resolveOutputPaths(
    {
      output: input.output,
      outputDir: input.outputDir,
      cwd,
      prompt: input.prompt,
      model: input.model,
    },
    finalImages,
    options.now,
  );

  for (const [index, image] of finalImages.entries()) {
    writeFileSync(paths[index] as string, image.buffer);
  }

  return {
    ok: true,
    path: paths[0] as string,
    paths,
    model: input.model,
    alias: input.alias,
    provider: input.provider,
    bytes: finalImages[0]?.buffer.length ?? 0,
    elapsed_ms: Date.now() - startedAt,
    cost_usd: sawCost && !missingCost ? totalCost : null,
    prompt: input.prompt,
  };
}

// 4. output envelopes and CLI

export function createFailureEnvelope(error: ImageGenCliError): ImageGenFailureEnvelope {
  return {
    ok: false,
    error: error.message,
    code: error.code,
  };
}

export function writeJson(stream: Pick<NodeJS.WriteStream, "write">, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export function getVersion(moduleUrl: string = import.meta.url): string {
  const packageJsonPath = join(resolvePackageRoot(moduleUrl), "package.json");
  if (!existsSync(packageJsonPath)) {
    return "unknown";
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function getListModelsText(): string {
  return `image-gen model aliases

Grok-first presets:
  grok       -> ${MODEL_ALIASES.grok}   xAI, default, cheap daily driver
  grok-pro   -> ${MODEL_ALIASES["grok-pro"]}   xAI, higher quality

OpenRouter presets:
  flux-pro        -> ${MODEL_ALIASES["flux-pro"]}   FLUX.2 Pro via OpenRouter
  nano-banana-2   -> ${MODEL_ALIASES["nano-banana-2"]}   compatibility alias
  nano-banana-pro -> ${MODEL_ALIASES["nano-banana-pro"]}   compatibility alias
  gpt-image       -> ${MODEL_ALIASES["gpt-image"]}   compatibility alias

Pass-through:
  Any vendor/slug OpenRouter model ID is sent unchanged.
  Known xAI image model IDs grok-imagine-image and grok-imagine-image-pro route through xAI.

Family handling:
  xAI Grok Imagine uses the xAI images API with base64 output.
  Gemini and GPT image models use modalities ["image", "text"].
  Flux-like image-only models use modalities ["image"].`;
}

export function getHelpText(moduleUrl: string = import.meta.url): string {
  return `image-gen v${getVersion(moduleUrl)} - JSON-in, JSON-out image generation CLI for agents

Usage:
  image-gen '{"prompt":"a quiet courtyard at dusk"}'
  image-gen '{"prompt":"a polished hero image","model":"grok-pro"}'
  printf '%s' '{"prompt":"editorial portrait lighting study"}' | image-gen
  image-gen --help | --version | --list-models | --status

Grok-first presets:
  grok       -> ${MODEL_ALIASES.grok} (default, xAI)
  grok-pro   -> ${MODEL_ALIASES["grok-pro"]} (xAI)
  flux-pro   -> ${MODEL_ALIASES["flux-pro"]} (OpenRouter FLUX.2 Pro)

Compatibility aliases:
  nano-banana-2, nano-banana-pro, gpt-image -> OpenRouter
  vendor/slug -> passthrough for newer OpenRouter models

JSON input fields:
  prompt            string, required
  model             string, default ${IMAGE_GEN_DEFAULT_MODEL}
  output            string path or directory
  output_dir        string, default ./generated/
  aspect_ratio      ${formatAllowedValues(ALLOWED_ASPECT_RATIOS)}
  size              string hint such as 512, 1024, 1K, 2K, 4K
  n                 integer 1-4
  reference_images  string[] local paths or HTTPS URLs
  system            string preamble
  seed              integer

Output shape:
  {"ok":true,"path":"/abs/primary.png","paths":["/abs/primary.png"],"model":"...","alias":"grok","provider":"xai","bytes":1234,"elapsed_ms":900,"cost_usd":null,"prompt":"..."}
  {"ok":false,"error":"...","code":"auth_error"}

Environment:
  XAI_API_KEY             required for grok and grok-pro; also loaded from the package-local .env
  OPENROUTER_API_KEY      required for flux-pro, compatibility aliases, and vendor/slug models
  XAI_BASE_URL            optional xAI API base override
  OPENROUTER_BASE_URL     optional API base override
  IMAGE_GEN_DEFAULT_MODEL optional alias, xAI model ID, or OpenRouter vendor/slug default
  IMAGE_GEN_OUTPUT_DIR    optional default output directory
  OPENROUTER_HTTP_REFERER optional attribution header override
  OPENROUTER_TITLE        optional attribution title override`;
}

export function isProviderConfigured(provider: ImageProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  return provider === "xai" ? Boolean(env.XAI_API_KEY?.trim()) : Boolean(env.OPENROUTER_API_KEY?.trim());
}

export function getStatusReport(env: NodeJS.ProcessEnv = process.env): ImageGenStatusReport {
  const defaultSpecifier = parseOptionalNonEmptyString(env.IMAGE_GEN_DEFAULT_MODEL, "IMAGE_GEN_DEFAULT_MODEL") ?? IMAGE_GEN_DEFAULT_MODEL;
  const defaultModel = resolveModelSpecifier(defaultSpecifier);
  const providers = {
    xai: { configured: isProviderConfigured("xai", env) },
    openrouter: { configured: isProviderConfigured("openrouter", env) },
  } satisfies Record<ImageProvider, { configured: boolean }>;

  return {
    ok: true,
    default_model: {
      ...defaultModel,
      usable: providers[defaultModel.provider].configured,
    },
    providers,
    presets: Object.entries(MODEL_PRESETS).map(([alias, preset]) => ({
      alias,
      model: preset.model,
      provider: preset.provider,
      cost_tier: preset.costTier,
      generation: preset.supportsGeneration,
      reference_images: preset.supportsReferenceImages,
      usable: providers[preset.provider].configured,
      description: preset.description,
    })),
    passthrough: {
      provider: "openrouter",
      usable: providers.openrouter.configured,
      pattern: "vendor/slug",
    },
  };
}

export function normalizeError(error: unknown): ImageGenCliError {
  if (error instanceof ImageGenCliError) {
    return error;
  }
  if (error instanceof Error) {
    return new ImageGenCliError("api_error", error.message);
  }
  return new ImageGenCliError("api_error", String(error));
}

export function createMissingInputError(): ImageGenCliError {
  return new ImageGenCliError(
    "validation_error",
    "Missing JSON input. Pass a single JSON object via argv or stdin.",
  );
}

export async function resolveRawInput(
  args: string[],
  stdin: NodeJS.ReadableStream,
  stdinIsTTY: boolean,
): Promise<string> {
  if (args.length === 0) {
    return stdinIsTTY ? "" : readStdin(stdin);
  }

  if (args.length > 1) {
    throw new ImageGenCliError("validation_error", "Pass a single JSON object via argv or stdin, not multiple arguments.");
  }

  return args[0] ?? "";
}

export async function runCli(args: string[], options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const stdin = options.stdin ?? process.stdin;
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY ?? false;
  const env = options.env ?? process.env;
  const moduleUrl = options.moduleUrl ?? import.meta.url;

  try {
    if (args.includes("--help") || args.includes("-h")) {
      stdout.write(`${getHelpText(moduleUrl)}\n`);
      return 0;
    }

    if (args.includes("--version") || args.includes("-v")) {
      stdout.write(`${getVersion(moduleUrl)}\n`);
      return 0;
    }

    if (args.includes("--list-models")) {
      stdout.write(`${getListModelsText()}\n`);
      return 0;
    }

    if (args.includes("--status")) {
      loadPackageEnv(moduleUrl, env);
      writeJson(stdout, getStatusReport(env));
      return 0;
    }

    const rawInput = await resolveRawInput(args, stdin, stdinIsTTY);
    if (!rawInput) {
      throw createMissingInputError();
    }

    const parsed = parseJsonInput(rawInput);
    loadPackageEnv(moduleUrl, env);
    const input = validateInput(parsed, env);
    const result = await generateImages(input, {
      cwd: options.cwd,
      env,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
    writeJson(stdout, result);
    return 0;
  } catch (error) {
    const normalized = normalizeError(error);
    writeJson(stdout, createFailureEnvelope(normalized));
    stderr.write(`${normalized.code}: ${normalized.message}\n`);
    return 1;
  }
}

export function resolveExecutablePath(path: string): string {
  try {
    return resolve(realpathSync(path));
  } catch {
    return resolve(path);
  }
}

export function isDirectExecution(moduleUrl: string, entryPath = process.argv[1]): boolean {
  if (!entryPath) {
    return false;
  }
  return resolveExecutablePath(fileURLToPath(moduleUrl)) === resolveExecutablePath(entryPath);
}

export async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (isDirectExecution(import.meta.url)) {
  void main();
}
