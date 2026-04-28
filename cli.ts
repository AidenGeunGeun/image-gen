#!/usr/bin/env node

import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
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
export const SESSION_FILE_VERSION = 1;
export const XAI_MAX_INPUT_IMAGES = 5;
export const XAI_USD_TICKS_PER_DOLLAR = 10_000_000_000;
export const MODEL_PRESETS = {
  grok: {
    model: "grok-imagine-image",
    provider: "xai",
    costTier: "daily",
    description: "cheap daily-driver Grok Imagine generation, edits, and multi-image edits",
    supportsGeneration: true,
    supportsImageInputs: true,
    maxImageInputs: XAI_MAX_INPUT_IMAGES,
    supportsMask: true,
    supportsSessionContinuation: true,
  },
  "grok-pro": {
    model: "grok-imagine-image-pro",
    provider: "xai",
    costTier: "pro",
    description: "higher-quality Grok Imagine Pro generation, edits, and multi-image edits",
    supportsGeneration: true,
    supportsImageInputs: true,
    maxImageInputs: XAI_MAX_INPUT_IMAGES,
    supportsMask: true,
    supportsSessionContinuation: true,
  },
  "flux-pro": {
    model: "black-forest-labs/flux-2-pro",
    provider: "openrouter",
    costTier: "openrouter-pro",
    description: "OpenRouter FLUX.2 Pro generation route; image-input support not provider-documented",
    supportsGeneration: true,
    supportsImageInputs: false,
    maxImageInputs: 0,
    supportsMask: false,
    supportsSessionContinuation: false,
  },
  "nano-banana-2": {
    model: "google/gemini-3.1-flash-image-preview",
    provider: "openrouter",
    costTier: "compat",
    description: "OpenRouter Gemini compatibility alias with image-input support via chat completions",
    supportsGeneration: true,
    supportsImageInputs: true,
    maxImageInputs: 4,
    supportsMask: false,
    supportsSessionContinuation: true,
  },
  "nano-banana-pro": {
    model: "google/gemini-3-pro-image-preview",
    provider: "openrouter",
    costTier: "compat-pro",
    description: "OpenRouter Gemini Pro compatibility alias with image-input support via chat completions",
    supportsGeneration: true,
    supportsImageInputs: true,
    maxImageInputs: 4,
    supportsMask: false,
    supportsSessionContinuation: true,
  },
  "gpt-image": {
    model: "openai/gpt-5.4-image-2",
    provider: "openrouter",
    costTier: "compat-pro",
    description: "OpenRouter GPT image compatibility alias with image-input support via chat completions",
    supportsGeneration: true,
    supportsImageInputs: true,
    maxImageInputs: 4,
    supportsMask: false,
    supportsSessionContinuation: true,
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
export const XAI_ALLOWED_ASPECT_RATIOS = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "2:3",
  "3:2",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "1:2",
  "2:1",
  "auto",
]);
export const ALLOWED_OPERATIONS = ["generate", "edit", "compose", "mask_edit"] as const;

export type ImageGenAlias = keyof typeof MODEL_PRESETS;
export type AllowedAspectRatio = (typeof ALLOWED_ASPECT_RATIOS)[number];
export type OperationKind = (typeof ALLOWED_OPERATIONS)[number];
export type ImageGenErrorCode =
  | "validation_error"
  | "capability_error"
  | "session_error"
  | "auth_error"
  | "api_error"
  | "network_error";
export type ModelFamilyKind = "text-image" | "image-only";
export type ImageProvider = "xai" | "openrouter";

export interface SessionInput {
  path: string;
  start_fresh?: boolean;
}

export interface ImageGenInput {
  prompt: string;
  model?: string;
  output?: string;
  output_dir?: string;
  aspect_ratio?: AllowedAspectRatio;
  size?: string;
  n?: number;
  image_inputs?: string[];
  reference_images?: string[];
  mask?: string;
  operation?: OperationKind;
  session?: SessionInput;
  system?: string;
  seed?: number;
}

export interface ValidatedSessionInput {
  path: string;
  startFresh: boolean;
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
  /** New canonical name. Always populated; aliased from `reference_images` when only the legacy field is supplied. */
  imageInputs: string[];
  /** @deprecated Use `imageInputs`. Kept for read-only compatibility. */
  referenceImages: string[];
  mask?: string;
  operationHint?: OperationKind;
  session?: ValidatedSessionInput;
  system?: string;
  seed?: number;
}

export interface SessionTurnRecord {
  turn: number;
  prompt: string;
  model: string;
  alias: string | null;
  provider: ImageProvider;
  operation: OperationKind;
  image_inputs: string[];
  mask: string | null;
  output_paths: string[];
  primary_output: string;
  timestamp: string;
}

export interface SessionFile {
  version: number;
  session_id: string;
  created_at: string;
  updated_at: string;
  primary_output: string | null;
  turn_count: number;
  turns: SessionTurnRecord[];
}

export interface SessionEnvelope {
  path: string;
  turn: number;
  primary_output: string;
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

export interface ImageGenInputsSummary {
  /** Image inputs as supplied by the caller (absolute local paths or HTTPS URLs). Never base64. */
  images: string[];
  /** Mask source as supplied by the caller, or null when no mask was used. Never base64. */
  mask: string | null;
}

export interface ImageGenSuccessEnvelope {
  ok: true;
  operation: OperationKind;
  path: string;
  paths: string[];
  model: string;
  alias: string | null;
  provider: ImageProvider;
  bytes: number;
  elapsed_ms: number;
  cost_usd: number | null;
  prompt: string;
  inputs: ImageGenInputsSummary;
  session: SessionEnvelope | null;
}

export interface ImageGenPresetStatus {
  alias: string;
  model: string;
  provider: ImageProvider;
  cost_tier: string;
  generation: boolean;
  /** @deprecated Use `image_inputs`. Kept for backward compatibility. */
  reference_images: boolean;
  image_inputs: boolean;
  max_image_inputs: number;
  multi_image: boolean;
  mask: boolean;
  session_continuation: boolean;
  usable: boolean;
  description: string;
}

export interface ImageGenPassthroughStatus {
  provider: "openrouter";
  usable: boolean;
  pattern: string;
  image_inputs: "unknown";
  multi_image: "unknown";
  mask: "unsupported";
  session_continuation: "unknown";
}

export interface ImageGenStatusReport {
  ok: true;
  default_model: ModelResolution & { usable: boolean };
  providers: Record<ImageProvider, { configured: boolean }>;
  presets: ImageGenPresetStatus[];
  passthrough: ImageGenPassthroughStatus;
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
  "image_inputs",
  "reference_images",
  "mask",
  "operation",
  "session",
  "system",
  "seed",
]);

const ALLOWED_SESSION_FIELDS = new Set(["path", "start_fresh"]);

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

export function parseImagePathArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ImageGenCliError(
      "validation_error",
      `Invalid "${fieldName}". Expected an array of non-empty strings.`,
    );
  }

  return value.map((item) => item.trim());
}

/** @deprecated Use `parseImagePathArray("reference_images" | "image_inputs", value)`. */
export function parseReferenceImages(value: unknown): string[] {
  return parseImagePathArray(value, "reference_images");
}

export function parseOperation(value: unknown): OperationKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !ALLOWED_OPERATIONS.includes(value as OperationKind)) {
    throw new ImageGenCliError(
      "validation_error",
      `Invalid "operation". Expected one of: ${formatAllowedValues(ALLOWED_OPERATIONS)}`,
    );
  }
  return value as OperationKind;
}

export function parseMaskInput(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new ImageGenCliError(
      "validation_error",
      'Invalid "mask". Expected a non-empty string (local path or HTTPS URL).',
    );
  }
  return value.trim();
}

export function parseSessionInput(value: unknown): ValidatedSessionInput | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ImageGenCliError(
      "validation_error",
      'Invalid "session". Expected an object with a "path" field.',
    );
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_SESSION_FIELDS.has(key)) {
      throw new ImageGenCliError("validation_error", `Unknown session field: ${key}`);
    }
  }

  const sessionPath = parseOptionalNonEmptyString(value.path, "session.path");
  if (!sessionPath) {
    throw new ImageGenCliError("validation_error", 'Missing "session.path".');
  }

  let startFresh = false;
  if (value.start_fresh !== undefined) {
    if (typeof value.start_fresh !== "boolean") {
      throw new ImageGenCliError(
        "validation_error",
        'Invalid "session.start_fresh". Expected a boolean.',
      );
    }
    startFresh = value.start_fresh;
  }

  return { path: sessionPath, startFresh };
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

  const hasImageInputs = raw.image_inputs !== undefined;
  const hasReferenceImages = raw.reference_images !== undefined;
  if (hasImageInputs && hasReferenceImages) {
    throw new ImageGenCliError(
      "validation_error",
      'Use either "image_inputs" or the legacy "reference_images" field, not both.',
    );
  }
  const imageInputs = hasImageInputs
    ? parseImagePathArray(raw.image_inputs, "image_inputs")
    : parseImagePathArray(raw.reference_images, "reference_images");

  const mask = parseMaskInput(raw.mask);
  const operationHint = parseOperation(raw.operation);
  const session = parseSessionInput(raw.session);
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
    imageInputs,
    referenceImages: imageInputs,
    ...(mask ? { mask } : {}),
    ...(operationHint ? { operationHint } : {}),
    ...(session ? { session } : {}),
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

export function prepareImageReference(
  source: string,
  cwd: string,
  fieldLabel: string,
): string {
  if (source.startsWith("https://")) {
    return source;
  }

  if (/^https?:\/\//.test(source)) {
    throw new ImageGenCliError(
      "validation_error",
      `Invalid ${fieldLabel} URL: ${source}. Only HTTPS URLs are supported.`,
    );
  }

  const absolutePath = resolveReferenceImagePath(source, cwd);
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
      `Could not read ${fieldLabel}: ${source}`,
    );
  }
}

export function prepareReferenceImages(referenceImages: string[], cwd = process.cwd()): string[] {
  return referenceImages.map((source) => prepareImageReference(source, cwd, "image input"));
}

export function prepareMask(mask: string, cwd: string): string {
  return prepareImageReference(mask, cwd, "mask");
}

/** Resolve image-input sources to absolute local paths or HTTPS URLs (for the output envelope). */
export function summarizeImageSources(sources: string[], cwd: string): string[] {
  return sources.map((source) => {
    if (/^https?:\/\//.test(source)) {
      return source;
    }
    return resolve(cwd, source);
  });
}

export function summarizeMaskSource(mask: string | undefined, cwd: string): string | null {
  if (!mask) {
    return null;
  }
  return /^https?:\/\//.test(mask) ? mask : resolve(cwd, mask);
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
  imageInputs: string[],
  requestCount = input.n,
  mask?: string,
): Record<string, unknown> {
  if (imageInputs.length > XAI_MAX_INPUT_IMAGES) {
    throw new ImageGenCliError(
      "capability_error",
      `xAI image edits accept at most ${XAI_MAX_INPUT_IMAGES} input images, received ${imageInputs.length}.`,
    );
  }
  if (input.aspectRatio && !XAI_ALLOWED_ASPECT_RATIOS.has(input.aspectRatio)) {
    throw new ImageGenCliError(
      "capability_error",
      `xAI does not support aspect_ratio "${input.aspectRatio}". Supported: ${formatAllowedValues(Array.from(XAI_ALLOWED_ASPECT_RATIOS))}.`,
    );
  }
  if (mask && imageInputs.length !== 1) {
    throw new ImageGenCliError(
      "validation_error",
      "Masked edits require exactly one image input. Provide a single image_inputs entry alongside mask.",
    );
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
  // xAI image API does not document `seed`; omit it intentionally.

  if (imageInputs.length === 1) {
    body.image = { url: imageInputs[0] };
  } else if (imageInputs.length > 1) {
    body.images = imageInputs.map((url) => ({ url }));
  }
  if (mask) {
    body.mask = { url: mask };
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

  const usage = isRecord(payload.usage) ? payload.usage : undefined;

  // xAI publishes cost_in_usd_ticks where 1 USD = 10_000_000_000 ticks.
  const ticks = usage?.cost_in_usd_ticks;
  if (typeof ticks === "number" && Number.isFinite(ticks)) {
    return ticks / XAI_USD_TICKS_PER_DOLLAR;
  }

  const candidates = [
    usage?.cost,
    usage?.total_cost,
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

// 3a. operation derivation, capability checks, and session helpers

export function deriveOperation(imageInputCount: number, hasMask: boolean): OperationKind {
  if (hasMask) {
    return "mask_edit";
  }
  if (imageInputCount === 0) {
    return "generate";
  }
  if (imageInputCount === 1) {
    return "edit";
  }
  return "compose";
}

export interface ResolvedCapability {
  supportsImageInputs: boolean;
  maxImageInputs: number;
  supportsMask: boolean;
  supportsSessionContinuation: boolean;
  capabilityKnown: boolean;
}

export function resolveModelCapability(input: ValidatedImageGenInput): ResolvedCapability {
  if (input.alias) {
    const preset = MODEL_PRESETS[input.alias as ImageGenAlias];
    if (preset) {
      return {
        supportsImageInputs: preset.supportsImageInputs,
        maxImageInputs: preset.maxImageInputs,
        supportsMask: preset.supportsMask,
        supportsSessionContinuation: preset.supportsSessionContinuation,
        capabilityKnown: true,
      };
    }
  }

  if (input.provider === "xai") {
    // Known xAI image model IDs share the same documented capabilities.
    return {
      supportsImageInputs: true,
      maxImageInputs: XAI_MAX_INPUT_IMAGES,
      supportsMask: true,
      supportsSessionContinuation: true,
      capabilityKnown: true,
    };
  }

  // Pass-through OpenRouter vendor/slug — capability is unknown by definition.
  return {
    supportsImageInputs: true,
    maxImageInputs: 0, // 0 means "unknown / unbounded"; not used to enforce a cap.
    supportsMask: false,
    supportsSessionContinuation: true,
    capabilityKnown: false,
  };
}

/**
 * Shape-level rules that depend on the *effective* input count.
 * When a session is present, these run AFTER session resolution because
 * session continuation can change the effective image_inputs count.
 */
export function enforceShapeRules(
  input: ValidatedImageGenInput,
  effectiveInputCount: number,
  hasMask: boolean,
  operation: OperationKind,
): void {
  if (hasMask && effectiveInputCount !== 1) {
    throw new ImageGenCliError(
      "validation_error",
      "Masked edits require exactly one image input.",
    );
  }
  if (input.operationHint && input.operationHint !== operation) {
    throw new ImageGenCliError(
      "validation_error",
      `Declared operation "${input.operationHint}" does not match the request shape (image_inputs=${effectiveInputCount}, mask=${hasMask ? "yes" : "no"} → "${operation}").`,
    );
  }
}

export function applyCapabilityChecks(input: ValidatedImageGenInput): {
  capability: ResolvedCapability;
  operation: OperationKind;
} {
  const capability = resolveModelCapability(input);
  const hasMask = Boolean(input.mask);
  const inputCount = input.imageInputs.length;
  const operation = deriveOperation(inputCount, hasMask);

  if (inputCount > 0 && !capability.supportsImageInputs) {
    throw new ImageGenCliError(
      "capability_error",
      `Model "${input.model}" does not support image inputs. Use a generation-only request (no image_inputs) or pick a model that supports edits.`,
    );
  }

  if (capability.maxImageInputs > 0 && inputCount > capability.maxImageInputs) {
    throw new ImageGenCliError(
      "capability_error",
      `Model "${input.model}" accepts at most ${capability.maxImageInputs} image inputs, received ${inputCount}.`,
    );
  }

  if (hasMask && !capability.supportsMask) {
    throw new ImageGenCliError(
      "capability_error",
      `Model "${input.model}" does not support mask-based edits. Provider-native masking is currently available on xAI Grok image models.`,
    );
  }

  if (input.session && !capability.supportsSessionContinuation) {
    throw new ImageGenCliError(
      "capability_error",
      `Model "${input.model}" does not support session continuation because it cannot accept image inputs.`,
    );
  }

  // Shape rules run early ONLY when no session is present. With a session,
  // the effective input count may change after continuation; the rules will
  // be re-applied after session resolution in generateImages.
  if (!input.session) {
    enforceShapeRules(input, inputCount, hasMask, operation);
  }

  return { capability, operation };
}

// Session file helpers

export function resolveSessionPath(sessionPath: string, cwd: string): string {
  return resolve(cwd, sessionPath);
}

function isValidSessionTurn(value: unknown): value is SessionTurnRecord {
  if (!isRecord(value)) return false;
  if (typeof value.turn !== "number" || !Number.isInteger(value.turn) || value.turn < 1) return false;
  if (typeof value.prompt !== "string") return false;
  if (typeof value.model !== "string") return false;
  if (value.alias !== null && typeof value.alias !== "string") return false;
  if (value.provider !== "xai" && value.provider !== "openrouter") return false;
  if (typeof value.operation !== "string" || !ALLOWED_OPERATIONS.includes(value.operation as OperationKind)) return false;
  if (!Array.isArray(value.image_inputs) || value.image_inputs.some((item) => typeof item !== "string")) return false;
  if (value.mask !== null && typeof value.mask !== "string") return false;
  if (!Array.isArray(value.output_paths) || value.output_paths.some((item) => typeof item !== "string")) return false;
  if (typeof value.primary_output !== "string") return false;
  if (typeof value.timestamp !== "string") return false;
  return true;
}

export function isValidSessionFile(value: unknown): value is SessionFile {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.version !== "number" || value.version !== SESSION_FILE_VERSION) {
    return false;
  }
  if (typeof value.session_id !== "string" || !value.session_id) {
    return false;
  }
  if (typeof value.created_at !== "string" || !value.created_at) {
    return false;
  }
  if (typeof value.updated_at !== "string" || !value.updated_at) {
    return false;
  }
  if (value.primary_output !== null && typeof value.primary_output !== "string") {
    return false;
  }
  if (typeof value.turn_count !== "number" || !Number.isInteger(value.turn_count) || value.turn_count < 0) {
    return false;
  }
  if (!Array.isArray(value.turns)) {
    return false;
  }
  if (!value.turns.every(isValidSessionTurn)) {
    return false;
  }
  if (value.turn_count !== value.turns.length) {
    return false;
  }
  return true;
}

export function readSessionFile(absolutePath: string): SessionFile | null {
  if (!existsSync(absolutePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageGenCliError("session_error", `Could not read session file ${absolutePath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageGenCliError("session_error", `Session file ${absolutePath} is not valid JSON: ${message}`);
  }

  if (!isValidSessionFile(parsed)) {
    throw new ImageGenCliError(
      "session_error",
      `Session file ${absolutePath} is malformed. Expected an image-gen session object (version ${SESSION_FILE_VERSION}).`,
    );
  }

  return parsed;
}

export function createSessionFile(now: Date): SessionFile {
  const timestamp = now.toISOString();
  return {
    version: SESSION_FILE_VERSION,
    session_id: randomUUID(),
    created_at: timestamp,
    updated_at: timestamp,
    primary_output: null,
    turn_count: 0,
    turns: [],
  };
}

export function appendSessionTurn(session: SessionFile, turn: SessionTurnRecord, now: Date): SessionFile {
  return {
    ...session,
    updated_at: now.toISOString(),
    primary_output: turn.primary_output,
    turn_count: turn.turn,
    turns: [...session.turns, turn],
  };
}

export function writeSessionFileAtomic(absolutePath: string, session: SessionFile): void {
  const tempPath = `${absolutePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(session, null, 2)}\n`);
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best effort
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageGenCliError("session_error", `Could not write session file ${absolutePath}: ${message}`);
  }
}

export interface ResolvedSessionState {
  session: SessionFile;
  appendedInputs: string[];
  envelopeBase: { path: string };
}

export function resolveSessionState(
  validated: ValidatedSessionInput,
  cwd: string,
  capability: ResolvedCapability,
  now: Date,
): ResolvedSessionState {
  const absolutePath = resolveSessionPath(validated.path, cwd);
  const existing = readSessionFile(absolutePath);
  const session = existing ?? createSessionFile(now);

  const appendedInputs: string[] = [];
  if (existing && existing.turn_count > 0) {
    // Corrupt-state guard: a session that records turns must point at a primary output.
    if (!existing.primary_output) {
      throw new ImageGenCliError(
        "session_error",
        `Session at ${absolutePath} reports turn_count=${existing.turn_count} but has no primary_output. Fix the file or pass session.start_fresh=true.`,
      );
    }
    if (!validated.startFresh) {
      if (!capability.supportsImageInputs) {
        throw new ImageGenCliError(
          "capability_error",
          `Session continuation requires image-input support; model does not support it.`,
        );
      }
      if (!existsSync(existing.primary_output)) {
        throw new ImageGenCliError(
          "session_error",
          `Previous session output is missing on disk: ${existing.primary_output}. Pass session.start_fresh=true to skip continuation.`,
        );
      }
      appendedInputs.push(existing.primary_output);
    }
  }

  return { session, appendedInputs, envelopeBase: { path: absolutePath } };
}

export async function generateImages(
  input: ValidatedImageGenInput,
  options: GenerateImagesOptions = {},
): Promise<ImageGenSuccessEnvelope> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();

  // Capability gate runs before any session resolution or network call.
  // When a session is present, applyCapabilityChecks defers shape rules
  // (mask + exactly-one-input, operation hint matching) until after session
  // resolution because continuation can change the effective input count.
  const { capability } = applyCapabilityChecks(input);

  // Session pre-resolution: prepend previous primary output unless start_fresh.
  let sessionState: ResolvedSessionState | null = null;
  let effectiveImageInputs = input.imageInputs;
  if (input.session) {
    sessionState = resolveSessionState(input.session, cwd, capability, now);
    if (sessionState.appendedInputs.length > 0) {
      effectiveImageInputs = [...sessionState.appendedInputs, ...input.imageInputs];
    }
  }

  // Re-check capability bounds after session may have added an input.
  if (capability.maxImageInputs > 0 && effectiveImageInputs.length > capability.maxImageInputs) {
    throw new ImageGenCliError(
      "capability_error",
      `Model "${input.model}" accepts at most ${capability.maxImageInputs} image inputs after session continuation, would have ${effectiveImageInputs.length}. Pass session.start_fresh=true or fewer image_inputs.`,
    );
  }

  const hasMask = Boolean(input.mask);
  const operation = deriveOperation(effectiveImageInputs.length, hasMask);

  // Re-run shape rules now that effective inputs are known. This catches
  // mask + zero/many inputs and operation-hint mismatches even after session
  // continuation has prepended a previous output.
  if (input.session) {
    enforceShapeRules(input, effectiveImageInputs.length, hasMask, operation);
  }

  const preparedImageInputs = prepareReferenceImages(effectiveImageInputs, cwd);
  const preparedMask = input.mask ? prepareMask(input.mask, cwd) : undefined;
  const family = input.provider === "openrouter" ? resolveModelFamily(input.model) : { kind: "text-image" as const, supportsBatchN: true };

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
      ? await requestXai(
          preparedImageInputs.length === 0 ? "generations" : "edits",
          buildXaiRequestBody(input, preparedImageInputs, requestCount, preparedMask),
          { env, fetchImpl: options.fetchImpl },
        )
      : await requestOpenRouter(buildRequestBody(input, preparedImageInputs, requestCount), {
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
    now,
  );

  for (const [index, image] of finalImages.entries()) {
    writeFileSync(paths[index] as string, image.buffer);
  }

  // Update session file atomically AFTER successful image writes.
  let sessionEnvelope: SessionEnvelope | null = null;
  if (input.session && sessionState) {
    const turn: SessionTurnRecord = {
      turn: sessionState.session.turn_count + 1,
      prompt: input.prompt,
      model: input.model,
      alias: input.alias,
      provider: input.provider,
      operation,
      image_inputs: summarizeImageSources(effectiveImageInputs, cwd),
      mask: summarizeMaskSource(input.mask, cwd),
      output_paths: paths,
      primary_output: paths[0] as string,
      timestamp: new Date().toISOString(),
    };
    const updated = appendSessionTurn(sessionState.session, turn, now);
    writeSessionFileAtomic(sessionState.envelopeBase.path, updated);
    sessionEnvelope = {
      path: sessionState.envelopeBase.path,
      turn: turn.turn,
      primary_output: turn.primary_output,
    };
  }

  return {
    ok: true,
    operation,
    path: paths[0] as string,
    paths,
    model: input.model,
    alias: input.alias,
    provider: input.provider,
    bytes: finalImages[0]?.buffer.length ?? 0,
    elapsed_ms: Date.now() - startedAt,
    cost_usd: sawCost && !missingCost ? totalCost : null,
    prompt: input.prompt,
    inputs: {
      images: summarizeImageSources(effectiveImageInputs, cwd),
      mask: summarizeMaskSource(input.mask, cwd),
    },
    session: sessionEnvelope,
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

export function formatPresetCapabilities(preset: (typeof MODEL_PRESETS)[ImageGenAlias]): string {
  const ops = ["generate"];
  if (preset.supportsImageInputs) {
    ops.push("edit");
    if (preset.maxImageInputs > 1) {
      ops.push("compose");
    }
  }
  if (preset.supportsMask) {
    ops.push("mask_edit");
  }
  return ops.join("/");
}

export function getListModelsText(): string {
  const rows: string[] = [];
  for (const [alias, preset] of Object.entries(MODEL_PRESETS)) {
    const ops = formatPresetCapabilities(preset as (typeof MODEL_PRESETS)[ImageGenAlias]);
    const max = (preset as (typeof MODEL_PRESETS)[ImageGenAlias]).maxImageInputs;
    const maxText = max > 0 ? `, up to ${max} image inputs` : "";
    rows.push(`  ${alias.padEnd(15)} -> ${preset.model}\n    ${preset.provider}, ops: ${ops}${maxText}`);
  }

  return `image-gen model aliases (operations: generate / edit / compose / mask_edit)

${rows.join("\n")}

Pass-through:
  Any vendor/slug OpenRouter model ID is sent unchanged.
  Capability for pass-through models is unknown; mask edits are rejected and
  multi-image edits are best-effort. Known xAI image model IDs
  grok-imagine-image and grok-imagine-image-pro route through xAI.

Family handling:
  xAI Grok Imagine uses the xAI images API with base64 output.
  Gemini and GPT image models use OpenRouter chat completions with modalities ["image", "text"].
  Flux-like image-only models use modalities ["image"] and do not accept image inputs.`;
}

export function getHelpText(moduleUrl: string = import.meta.url): string {
  return `image-gen v${getVersion(moduleUrl)} - JSON-first image generation and editing for agents

Usage:
  image-gen '{"prompt":"a quiet courtyard at dusk"}'
  image-gen '{"prompt":"clean product render","model":"grok-pro","image_inputs":["./sketch.png"]}'
  image-gen '{"prompt":"compose hero image","image_inputs":["./a.png","./b.png"]}'
  image-gen '{"prompt":"continue the edit","session":{"path":"./session.json"}}'
  printf '%s' '{"prompt":"editorial portrait lighting study"}' | image-gen
  image-gen --help | --version | --list-models | --status

One JSON object in, one JSON object out. The CLI handles generation, edits,
multi-image composition, masked edits, and optional multi-turn sessions
through a single interface.

Operations are derived from the request shape:
  no image_inputs        -> generate
  one image_input        -> edit
  multiple image_inputs  -> compose
  one image_input + mask -> mask_edit (xAI Grok models only)

Grok-first presets:
  grok       -> ${MODEL_ALIASES.grok} (default, xAI; generate/edit/compose/mask_edit)
  grok-pro   -> ${MODEL_ALIASES["grok-pro"]} (xAI; generate/edit/compose/mask_edit)
  flux-pro   -> ${MODEL_ALIASES["flux-pro"]} (OpenRouter FLUX.2 Pro; generation only)

Compatibility aliases (OpenRouter chat completions):
  nano-banana-2, nano-banana-pro, gpt-image -> generate/edit/compose; no mask
  vendor/slug -> pass-through; capability unknown, no mask, image inputs allowed

JSON input fields:
  prompt            string, required
  model             string, default ${IMAGE_GEN_DEFAULT_MODEL}
  output            string path or directory
  output_dir        string, default ./generated/
  aspect_ratio      ${formatAllowedValues(ALLOWED_ASPECT_RATIOS)}
                    (xAI does not accept 4:1, 1:4, 8:1, 1:8)
  size              string hint such as 512, 1024, 1K, 2K, 4K (xAI maps to 1k or 2k)
  n                 integer 1-4
  image_inputs      string[] local paths or HTTPS URLs (preferred name)
  reference_images  string[] legacy alias for image_inputs
  mask              string local path or HTTPS URL (xAI Grok only; one image_input required)
  operation         "generate" | "edit" | "compose" | "mask_edit" (optional, validated against shape)
  session           {"path": string, "start_fresh"?: boolean}
  system            string preamble
  seed              integer (passed to OpenRouter only; not sent to xAI)

Output shape:
  {"ok":true,"operation":"edit","path":"/abs/primary.png","paths":["/abs/primary.png"],
   "model":"...","alias":"grok","provider":"xai","bytes":1234,"elapsed_ms":900,
   "cost_usd":null,"prompt":"...","inputs":{"images":["/abs/in.png"],"mask":null},
   "session":null}
  {"ok":false,"error":"...","code":"auth_error"}

Error codes:
  validation_error  malformed JSON input or unsupported field
  capability_error  model/provider cannot perform the requested operation
  session_error     session file missing fields, malformed, or points to a deleted output
  auth_error        provider API key missing or rejected
  api_error         provider returned an error or empty response
  network_error     transport failure or timeout

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
      reference_images: preset.supportsImageInputs,
      image_inputs: preset.supportsImageInputs,
      max_image_inputs: preset.maxImageInputs,
      multi_image: preset.supportsImageInputs && preset.maxImageInputs > 1,
      mask: preset.supportsMask,
      session_continuation: preset.supportsSessionContinuation,
      usable: providers[preset.provider].configured,
      description: preset.description,
    })),
    passthrough: {
      provider: "openrouter",
      usable: providers.openrouter.configured,
      pattern: "vendor/slug",
      image_inputs: "unknown",
      multi_image: "unknown",
      mask: "unsupported",
      session_continuation: "unknown",
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
