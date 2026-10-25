import { outputCategory, type OutputCategory } from '../shared/output-folders';
import { autoSettings, destinationActivated, initializeAutoSave, retryAutoSave, setAutoSave } from './auto-save';
import { favoriteApi } from './favorites';
import { configureLocalDestination, localSettings, startLocalSave, localOutputWorkBusy } from './local-storage';
import { withAccountConnection, resolveBearer, providerFetch, assertConnectionCurrent, connectionCurrent, connectionStatus, ConnectionError, type BearerLease } from './connection';
import { oauthAvailability, OAUTH_CALLBACK, disconnectOAuth, beginOAuth, consumeOAuth, exchangeOAuth, installOAuth, revokeToken, ensureOAuthBrowser, oauthBrowserCurrent, invalidateOAuthBrowser, oauthCallbackMatches } from './oauth';
import { trainingApi, prepareTraining, validateTrainingQuote } from './training';
import { boundedPreviewJson, discardQuote, getQuote, normalizeWorkflowOptions, normalizePolicy, normalizeReview, publicQuote, saveQuote, type PreparedGeneration, type SavedQuote } from './quotes';
import type { CostReview } from '../shared/quotes';
import { listArtworks, positiveId } from './artworks';
import { getBrowsingPreference, setBrowsingPreference } from './browsing';
import { listImageSources, registerGallerySource, uploadImageSource, resolveImageSources, sourcesCurrent, sourceRecord, publicSource } from './image-sources';
import { prepareSourceWorkflow, validateSourceWorkflowBody, SourceWorkflowError } from './source-workflows';
import { sourceRequirements } from '../shared/workflows';
import { sourceFreeVideoProblem } from './video-input';
import { publicMediaMetadata } from './public-media-metadata';
import { checkDraftResources, prepareDraft, validateDraft } from './draft-workflow';
import { requireImageGraphQualification } from './image-graphs';
import { graphOperations } from '../shared/image-workflows';
import { musicProviderInput, musicProviderProblem } from '../shared/music';
import { collectionApi, collectionWorkBusy } from './collections';
import { configError, promptLimit, parseAir, type ComposerConfig } from '../shared/composer';
import { publicModel, resolveModelVersion, siteJson, SiteError, validateGenerationResources, withDiscoveryLimit } from './models';
import { listGenerationServices, GenerationDiscoveryError } from './generation-services';
import { createHash, randomBytes } from "node:crypto";
import { desktopRuntime } from './desktop-runtime';
import { desktopUpdater, browserUpdateSnapshot } from './desktop-updates';
import { createUpdateActivity, holdResponse } from './update-activity';
import type { DesktopUpdateAction } from '../shared/desktop-updates';
import { createDesktopAppearance, DesktopAppearanceError } from './desktop-appearance';
import { createPromptLibrary, PromptLibraryError } from './prompt-library';
import { createMediaLibrary, MediaLibraryError } from './library';
import { resolve, sep } from "node:path";
import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';
import { isDocumentedEngine, type MediaType } from "../shared/generation-catalog";
import {
  createSession, credentialStorage, db, findGeneration, findIdempotentGeneration, getSessionUser,
  listGenerations, removeSession,
  saveGeneration, storeCredential, upsertUser, lastConnectionChange, listPresets, writePreset, deletePreset,
} from "./storage";

const port = Number(process.env.PORT ?? 6969);
const promptLibrary = createPromptLibrary(db);
const mediaLibrary = createMediaLibrary(db);
const production = process.env.NODE_ENV === "production";
const desktop = desktopRuntime();
const desktopAppearance = desktop ? createDesktopAppearance(db) : null;
const updateActivity = createUpdateActivity(() => collectionWorkBusy() || localOutputWorkBusy());
desktopUpdater()?.configure(updateActivity, () => {
  const result = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | null;
  return result?.busy === 0;
});
let publicBase = new URL(process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`);
if (production && !desktop && publicBase.protocol !== "https:") throw new Error("Production requires HTTPS PUBLIC_BASE_URL");
const secureCookies = production && !desktop;
const sessionCookie = secureCookies ? "__Host-studio" : "studio_session";
const csrfCookie = secureCookies ? "__Host-studio-csrf" : "studio_csrf";
const oauthBrowserCookie = secureCookies ? "__Host-studio-oauth-browser" : "studio_oauth_browser";
const oauthNonceCookie = secureCookies ? "__Host-studio-oauth-nonce" : "studio_oauth_nonce";
const cookieSecure = publicBase.protocol === "https:" ? "; Secure" : "";
const cookieCommon = `; Path=/; SameSite=Lax${cookieSecure}`;
const trustProxy = process.env.STUDIO_TRUST_PROXY === "true";
const loopbackHost = (host: string) => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host.toLowerCase());
const localStorageEnabled = process.env.STUDIO_LOCAL_OUTPUTS === 'true' && !production && !trustProxy
  && ['127.0.0.1', '::1'].includes(process.env.HOST ?? '127.0.0.1') && loopbackHost(publicBase.hostname);
const webRoot = resolve(import.meta.dir, "../web/dist");
const csrfMaxAge = 60 * 60 * 8;
const keyAttempts = new Map<string, number[]>();
const historySyncAt = new Map<string, number>();
const statusPollAt = new Map<string, number>();
const buzzCache = new Map<string, { fetchedAt: number; revision: string; balance: { blue: number; green: number; yellow: number; total: number; updatedAt: string } }>();
const activeSubmissions = new Set<string>();
const activeWorkflowUpdates = new Set<string>();
const activeArchiveUsers = new Set<string>();
let activeArchiveBuilds = 0;
let clientIpFor: (request: Request) => string = () => "local";
type DownloadItem = { category: OutputCategory; maxBytes?: number; outputId: string; status: string; filename: string | null; dateFolder: string | null; error: string | null; contentUrl?: string; metadata?: Record<string, unknown> };
const downloads = new Map<string, { ownerId: string; status: string; items: DownloadItem[]; archiveUrl: string | null; archive?: Uint8Array; createdAt: number }>();

type ApiErrorCode = "unauthenticated" | "invalid_input" | "civitai_not_connected" | "insufficient_scope" | "unsupported_action" | "provider_unavailable" | "provider_rejected" | "provider_rate_limited" | "download_busy" | "idempotency_conflict" | "not_found" | "preview_required" | "preview_changed" | "recovery_required";

function cookieValue(request: Request, name: string): string | undefined {
  const all = request.headers.get("cookie") ?? "";
  for (const part of all.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(data, { status, headers: responseHeaders });
}

function errorResponse(code: ApiErrorCode, message: string, status: number) {
  return json({ error: { code, message, requestId: crypto.randomUUID() } }, status);
}

function connectionError(request: Request, code: string, message: string, status: number) {
  if (request.headers.get("accept")?.includes("text/html")) {
    return new Response(null, { status: 303, headers: { Location: `/?connectionError=${encodeURIComponent(code)}`, "Cache-Control": "no-store" } });
  }
  return errorResponse("invalid_input", message, status);
}

function withCookie(response: Response, cookie: string) {
  response.headers.append("Set-Cookie", cookie);
  return response;
}

function expireCookie(response: Response, name: string, httpOnly = true) {
  return withCookie(response, `${name}=; Max-Age=0${cookieCommon}${httpOnly ? "; HttpOnly" : ""}`);
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !!origin && origin === publicBase.origin;
}

function validCsrf(request: Request, bodyToken?: string): boolean {
  if (!validOrigin(request)) return false;
  const cookieToken = cookieValue(request, csrfCookie);
  const headerToken = request.headers.get("x-csrf-token");
  const submitted = headerToken ?? bodyToken;
  return !!cookieToken && !!submitted && cookieToken.length >= 32 && cookieToken === submitted;
}

function sessionCookieValue(token: string, maxAge: number) {
  return `${sessionCookie}=${encodeURIComponent(token)}; Max-Age=${Math.floor((maxAge - Date.now()) / 1000)}${cookieCommon}; HttpOnly`;
}

function getCurrentUser(request: Request) {
  return getSessionUser(cookieValue(request, sessionCookie));
}

async function readBody(request: Request, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json") && !contentType.includes("application/x-www-form-urlencoded")) return null;
    const reader = request.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(concatBytes(chunks));
    if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text).entries());
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch { return null; }
}

function rateLimited(request: Request): boolean {
  // Only honor forwarded client addresses when the deployment explicitly trusts its proxy.
  const key = trustProxy ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || clientIpFor(request) : clientIpFor(request);
  const now = Date.now();
  const recent = (keyAttempts.get(key) ?? []).filter((time) => now - time < 15 * 60_000);
  if (recent.length >= 12) { keyAttempts.set(key, recent); return true; }
  recent.push(now);
  keyAttempts.set(key, recent);
  if (keyAttempts.size > 2000) {
    for (const [candidate, times] of keyAttempts) {
      if (!times.some((time) => now - time < 15 * 60_000)) keyAttempts.delete(candidate);
      if (keyAttempts.size <= 1500) break;
    }
  }
  return false;
}

type CivitaiProfile = { id: string; displayName: string; tokenScope?: number; buzzLimit?: unknown };
async function validateCivitaiKey(apiKey: string): Promise<CivitaiProfile | null> {
  const response = await fetch("https://civitai.com/api/v1/me", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
    redirect: "error",
  });
  if (!response.ok) return null;
  const profile = await response.json() as { id?: number | string; username?: string; name?: string; tokenScope?: number; buzzLimit?: unknown };
  if ((typeof profile.id !== "number" && typeof profile.id !== "string") || !String(profile.id).trim()) return null;
  return {
    id: String(profile.id), displayName: String(profile.username ?? profile.name ?? "Civitai user").slice(0, 120),
    tokenScope: Number.isInteger(profile.tokenScope) ? profile.tokenScope : undefined,
    buzzLimit: profile.buzzLimit,
  };
}

const AI_SERVICES_WRITE = 32768;
const BUZZ_READ = 65536;
const ORCHESTRATION = "https://orchestration.civitai.com";

async function accountBuzzBalance(userId: string): Promise<Response> {
  const key = await resolveBearer(userId);
  if (!key) return errorResponse("civitai_not_connected", "Reconnect your Civitai API key to view Buzz.", 403);
  const tokenScope = key.scopes;
  if (tokenScope !== null && tokenScope !== undefined && (tokenScope & BUZZ_READ) === 0) {
    return errorResponse("insufficient_scope", "This Civitai key needs BuzzRead permission to show the balance.", 403);
  }
  const cached = buzzCache.get(userId);
  if (cached && cached.revision === key.revision && Date.now() - cached.fetchedAt < 15_000) return json({ balance: cached.balance });
  try {
    // Civitai's per-pool read is distinct from the older getUserAccount helper,
    // whose untyped response combines yellow and blue and omits green.
    const response = await providerFetch(key, "https://civitai.com/api/trpc/buzz.getBuzzAccount", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    }, BUZZ_READ);
    if (response.status === 401 || response.status === 403) return errorResponse("insufficient_scope", "Civitai denied Buzz balance access. Reconnect with a key that includes BuzzRead.", 403);
    if (response.status === 429) return errorResponse("provider_rate_limited", "Civitai is rate limiting balance reads. Try again shortly.", 429);
    if (!response.ok) return errorResponse("provider_unavailable", "Civitai could not load your Buzz balance right now.", 502);
    const payload = await response.json() as { result?: { data?: { json?: unknown } | unknown } };
    const data = payload.result?.data;
    const raw = data && typeof data === "object" && "json" in data ? data.json : data;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Unexpected balance response");
    const pools = raw as Record<string, unknown>;
    const blue = pools.blue, green = pools.green, yellow = pools.yellow;
    if (![blue, green, yellow].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) throw new Error("Incomplete balance response");
    const balance = { blue: blue as number, green: green as number, yellow: yellow as number, total: (blue as number) + (green as number) + (yellow as number), updatedAt: new Date().toISOString() };
    assertConnectionCurrent(key);
    buzzCache.set(userId, { fetchedAt: Date.now(), revision:key.revision, balance });
    return json({ balance });
  } catch {
    return errorResponse("provider_unavailable", "Civitai could not load your Buzz balance right now.", 502);
  }
}
type ProviderWorkflow = {
  id?: string; status?: string; createdAt?: string; updatedAt?: string; completedAt?: string | null;
  cost?: { total?: number };
  transactions?: { insufficientBuzz?: boolean };
  steps?: Array<{ name?: string; "$type"?: string; status?: string; completedAt?: string | null; input?: Record<string, unknown>; output?: Record<string, unknown>; error?: unknown }>;
};

function workflowMediaType(workflow: ProviderWorkflow): MediaType | "training" {
  if (workflow.steps?.some(step => step["$type"] === "training")) return "training";
  if (workflow.steps?.some(step => step["$type"] === "polyGen")) return "model3d";
  if (workflow.steps?.some(step => ["videoGen","videoUpscaler","videoInterpolation","preprocessVideo","transcode"].includes(step["$type"] ?? ""))) return "video";
  const music=workflow.steps?.find(step=>['aceStepAudio','miniMaxMusic3'].includes(step['$type']??''));
  if(music)return (music.output?.blob as any)?.type==='video'?'video':'audio';
  return "image";
}

function providerStatus(status: string | undefined): string {
  switch (status?.toLowerCase()) {
    case "pending": case "queued": return "queued";
    case "processing": case "running": return "running";
    case "succeeded": case "success": return "succeeded";
    case "canceled": case "cancelled": return "canceled";
    case "expired": return "expired";
    case "failed": case "error": return "failed";
    default: return "queued";
  }
}

function mimeFromUrl(value: string): string | null {
  try {
    const path = new URL(value).pathname.toLowerCase();
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".avif")) return "image/avif";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".mp4")) return "video/mp4";
    if (path.endsWith(".webm")) return "video/webm";
    if (path.endsWith(".mov")) return "video/quicktime";
    if (path.endsWith('.mp3')) return 'audio/mpeg';
    if (path.endsWith('.wav')) return 'audio/wav';
    if (path.endsWith('.ogg')||path.endsWith('.oga')) return 'audio/ogg';
    if (path.endsWith('.flac')) return 'audio/flac';
    if (path.endsWith('.aac')) return 'audio/aac';
    if (path.endsWith('.m4a')) return 'audio/mp4';
    if (path.endsWith(".glb")) return "model/gltf-binary";
    if (path.endsWith(".gltf")) return "model/gltf+json";
    if (path.endsWith(".fbx")) return "application/octet-stream";
    if (path.endsWith(".obj")) return "model/obj";
    if (path.endsWith(".usdz")) return "model/vnd.usdz+zip";
  } catch { /* unknown provider URL */ }
  return null;
}

function normalizeOutputs(workflow: ProviderWorkflow) {
  const outputs = new Map<string, { id: string; kind: MediaType | "checkpoint"; role: string; url: string | null; previewUrl: string | null; mimeType: string | null; createdAt: string | null; metadata: Record<string, unknown> }>();
  for (const step of workflow.steps ?? []) {
    const output = step.output ?? {};
    const thumbnail = output.thumbnail && typeof output.thumbnail === "object" ? output.thumbnail as Record<string, unknown> : null;
    const thumbnailUrl = typeof thumbnail?.previewUrl === "string" && safeProviderMediaUrl(thumbnail.previewUrl) ? thumbnail.previewUrl
      : typeof thumbnail?.url === "string" && safeProviderMediaUrl(thumbnail.url) ? thumbnail.url : null;
    const add = (candidate: unknown, kind: MediaType | "checkpoint", role: string) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
      const item = candidate as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : "";
      if (!id) return;
      const url = typeof item.url === "string" && safeProviderMediaUrl(item.url) ? item.url : null;
      const ownPreview = typeof item.previewUrl === "string" && safeProviderMediaUrl(item.previewUrl) ? item.previewUrl : null;
      outputs.set(id, {
        id, kind, role, url,
        previewUrl: ownPreview ?? (kind === "model3d" ? thumbnailUrl : url),
        mimeType: typeof item.mimeType === "string" ? item.mimeType : url ? mimeFromUrl(url) : null,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : step.completedAt ?? null,
        metadata: Object.fromEntries(Object.entries(item).filter(([key]) => !["url", "previewUrl", "id"].includes(key))),
      });
    };
    for (const item of Array.isArray(output.images) ? output.images : []) add(item, "image", "image");
    for (const item of Array.isArray(output.blobs) ? output.blobs as any[] : []) {
      if(['image','video','audio','model3d'].includes(item?.type))add(item,item.type,item.type);
    }
    if(['aceStepAudio','miniMaxMusic3'].includes(step['$type']??'')){
      const blob=output.blob as any;
      if(blob&&['audio','video'].includes(blob.type)){
        add(blob,blob.type,blob.type);
        const item=outputs.get(blob.id);if(item){item.mimeType??=mimeFromUrl(`https://media.invalid/${encodeURIComponent(blob.id)}`);item.metadata={...item.metadata,operation:step['$type']}}
      }
    }
    if (step["$type"] === "imageUpscaler") add(output.blob, "image", "image");
    if (step['$type'] === 'preprocessImage' && (output.blob as any)?.type === 'image') {
      add(output.blob,'image','image');
      const item=outputs.get((output.blob as any).id);
      if(item)item.metadata={...item.metadata,operation:'preprocessImage',kind:step.input?.kind,resolution:step.input?.resolution};
    }
    if (step['$type'] === 'preprocessVideo' && (output.blob as any)?.type === 'video') {
      add(output.blob,'video','video');
      const item=outputs.get((output.blob as any).id);
      if(item)item.metadata={...item.metadata,operation:'preprocessVideo',kind:step.input?.kind,resolution:step.input?.resolution};
    }
    if (step["$type"] === "imageBackgroundRemoval") {
      add(output.image, "image", "image");
      const image = output.image as any;
      const normalized = image && outputs.get(image.id);
      if (normalized) {
        const format = normalized.mimeType === 'image/webp' ? 'webp' : normalized.mimeType === 'image/png' ? 'png' : step.input?.format === 'webp' ? 'webp' : 'png';
        normalized.mimeType ??= `image/${format}`;
        normalized.metadata = { ...normalized.metadata, format, operation:'imageBackgroundRemoval' };
      }
    }
    if (step['$type'] === 'training') {
      for (const epoch of Array.isArray(output.epochs) ? output.epochs as any[] : []) {
        if (epoch.model?.available === true) { add(epoch.model,'checkpoint','checkpoint'); const item=outputs.get(epoch.model.id); if(item){item.mimeType='application/octet-stream';item.metadata={...item.metadata,format:'safetensors',epoch:epoch.epochNumber}} }
        for (const sample of Array.isArray(epoch.samples)?epoch.samples:[]) if(sample.available===true && ['image','video'].includes(sample.type)) { add(sample,sample.type,'training-sample'); const saved=outputs.get(sample.id); if(saved)saved.metadata={...saved.metadata,epoch:epoch.epochNumber}; }
      }
    }
    if (step['$type'] === 'transcode' && output.available === true) {
      add(output,'video','video');
      const item = outputs.get(String(output.id));
      if (item) {
        const format = step.input?.containerFormat;
        if (format === 'mp4' || format === 'webM') { item.mimeType ??= format === 'mp4' ? 'video/mp4' : 'video/webm'; item.metadata.format = format.toLowerCase(); }
        if (positiveDimension(step.input?.width)) item.metadata.requestedWidth = step.input!.width;
      }
    }
    add(output.video, "video", "video");
    for (const item of Array.isArray(output.additionalVideos) ? output.additionalVideos : []) add(item, "video", "video");
    for (const role of ["model", "fbxModel", "riggedModel", "riggedFbxModel", "animatedModel", "animatedFbxModel"]) add(output[role], "model3d", role);
    if (output.basicAnimations && typeof output.basicAnimations === "object") {
      for (const [role, item] of Object.entries(output.basicAnimations as Record<string, unknown>)) add(item, "model3d", role);
    }
    add(thumbnail, "image", "thumbnail");
  }
  return [...outputs.values()];
}

function safeProviderMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "image.civitai.com" || url.hostname.endsWith(".civitai.com"));
  } catch { return false; }
}

function extractCost(workflow: ProviderWorkflow, estimated: boolean) {
  const amount = workflow.cost?.total;
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0
    ? { amount, unit: "buzz" as const, estimated }
    : null;
}

async function orchestrationRequest(apiKey: BearerLease, path: string, body?: unknown, beforeDispatch?: () => void) {
  return providerFetch(apiKey, `${ORCHESTRATION}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(body === undefined ? 15_000 : 45_000),
    redirect: "error",
  }, body === undefined ? 16384 : 32768, beforeDispatch);
}

function trainingResult(workflow: ProviderWorkflow) {
  const step=workflow.steps?.find(step=>step['$type']==='training');if(!step)return undefined;
  const output=step.output as any;
  return {moderationStatus:typeof output?.moderationStatus==='string'?output.moderationStatus:'Not supplied',epochs:(Array.isArray(output?.epochs)?output.epochs:[]).slice(0,200).map((epoch:any)=>({epochNumber:epoch.epochNumber,modelId:typeof epoch.model?.id==='string'?epoch.model.id:null,available:epoch.model?.available===true,sampleIds:(Array.isArray(epoch.samples)?epoch.samples:[]).filter((x:any)=>x.available===true&&x.type==='image'&&typeof x.id==='string').map((x:any)=>x.id)}))};
}
function workflowHasUnavailableOutputs(workflow: ProviderWorkflow) {
  const unavailable = (value: unknown): boolean => !!value && typeof value === 'object' && (Array.isArray(value) ? value.some(unavailable) : (value as any).available === false || Object.values(value).some(unavailable));
  return (workflow.steps ?? []).some(step => unavailable(step.output));
}
function mapWorkflow(provider: ProviderWorkflow, current: Record<string, unknown>) {
  const now = new Date().toISOString();
  const status = providerStatus(provider.status);
  const outputs = normalizeOutputs(provider);
  const record = {
    ...current,
    ...(trainingResult(provider) ? {trainingResult:trainingResult(provider)} : {}),
    mediaType: current.mediaType ?? workflowMediaType(provider),
    status,
    updatedAt: now,
    completedAt: status === "succeeded" ? (provider.completedAt ?? current.completedAt ?? now) : current.completedAt ?? null,
    providerStatus: provider.status ?? null,
    autoOutputsPending: workflowHasUnavailableOutputs(provider),
    outputs: [...new Map([...(Array.isArray(current.outputs) ? current.outputs : []), ...outputs].map((output: any) => [output.id, output])).values()],
    cost: extractCost(provider, false) ?? (current.cost ?? null),
    error: status === "failed" ? "Civitai could not complete this generation." : null,
  };
  if((current as any).submissionState==='blocked_recovery')Object.assign(record,{submissionState:'accepted',legacyRecovery:{...(current as any).legacyRecovery,state:'reconciled',message:'Existing workflow identity and status confirmed with a read-only GET. No workflow was submitted.'}});
  if ((current as any).cancellation) {
    (record as any).cancellation = { ...(current as any).cancellation, state: status === "canceled" ? "confirmed" : "reconciled", updatedAt: now, message: status === "canceled" ? "Civitai confirms this workflow is canceled. Any returned outputs remain available; no refund is promised." : ["succeeded", "failed", "expired"].includes(status) ? `Civitai reports ${status}. Completion may have raced cancellation; returned outputs and cost are preserved.` : "Civitai still reports an in-progress workflow. Status was reconciled; you may explicitly request cancellation again." };
  }
  return record;
}

function generationErrorResponse(error: "insufficient_scope" | "provider_rejected" | "provider_rate_limited" | "provider_unavailable", message: string, status: number) {
  return errorResponse(error, message, status);
}

function prepareGeneration(body: Record<string, unknown>): PreparedGeneration | Response {
  const requestRecord = body as Record<string, any>;
  const input = requestRecord.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return errorResponse("invalid_input", "Generation input is required.", 400);
  }
  const recipe = requestRecord.recipe === "image" ? "sdxl" : requestRecord.recipe;
  let mediaType: MediaType;
  let providerInput: Record<string, unknown>;
  let storedInput: Record<string, unknown>;
  let fingerprint: string;
  if (recipe === "workflow") {
    if (!isDocumentedEngine(requestRecord.mediaType, input.engine)) {
      return errorResponse("invalid_input", "Choose a documented image, video, audio, or 3D generation engine.", 400);
    }
    mediaType = requestRecord.mediaType;
    if(['comfyWorkflow','graph','nodes','manifest'].some(field=>field in input))return errorResponse('invalid_input','Custom graph fields are not accepted by image generation.',400);
    const inputJson = JSON.stringify(input);
    if (inputJson.length > 12_000 || (input.prompt !== undefined && (typeof input.prompt !== "string" || input.prompt.length > 10_000))) {
      return errorResponse("invalid_input", "The engine input is too large or contains an invalid prompt.", 400);
    }
    if(mediaType==='video'){const problem=sourceFreeVideoProblem(input);if(problem)return errorResponse('invalid_input',problem,400)}
    if(mediaType==='audio') {
      try {providerInput=musicProviderInput(input)}
      catch(error){return errorResponse('invalid_input',error instanceof Error?error.message:'Invalid music input.',400)}
    } else providerInput = input;
    storedInput = {
      prompt: mediaType==='audio'?providerInput.musicDescription:typeof input.prompt === "string" ? input.prompt : "",
      negativePrompt: typeof input.negativePrompt === "string" ? input.negativePrompt : "",
      model: typeof input.model === "string" ? input.model : null,
      engine: input.engine,
      parameters: mediaType==='audio'?{...providerInput,instrumental:input.instrumental}:input,
    };
    fingerprint = JSON.stringify({ recipe: "workflow", mediaType, input });
  } else if (recipe === "sdxl") {
    const { prompt, model, width, height, quantity, seed } = input;
    const negativePrompt = input.negativePrompt ?? "";
    const params = input.parameters && typeof input.parameters === "object" ? input.parameters as Record<string, unknown> : {};
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 10_000 || typeof negativePrompt !== "string" || negativePrompt.length > 10_000 || typeof model !== "string" || !/^urn:air:sdxl:checkpoint:civitai:\d+@\d+$/.test(model) || !Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 64 || Number(width) > 2048 || Number(height) < 64 || Number(height) > 2048 || Number(width) % 16 !== 0 || Number(height) % 16 !== 0 || !Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 12 || (seed !== null && seed !== undefined && (!Number.isSafeInteger(seed) || Number(seed) < 0))) {
      return errorResponse("invalid_input", "This SDXL recipe needs a checkpoint AIR, prompt, valid dimensions, and quantity 1-12.", 400);
    }
    const cfgScale = params.cfgScale ?? 7;
    const steps = params.steps ?? 25;
    if (typeof cfgScale !== "number" || cfgScale < 0 || cfgScale > 30 || !Number.isInteger(steps) || Number(steps) < 1 || Number(steps) > 150) {
      return errorResponse("invalid_input", "SDXL cfgScale must be 0-30 and steps must be 1-150.", 400);
    }
    mediaType = "image";
    providerInput = { engine: "sdcpp", ecosystem: "sdxl", operation: "createImage", model, prompt, width, height, quantity, cfgScale, steps };
    if (negativePrompt) providerInput.negativePrompt = negativePrompt;
    if (seed !== null && seed !== undefined) providerInput.seed = seed;
    if (typeof params.sampleMethod === "string") providerInput.sampleMethod = params.sampleMethod;
    if (typeof params.schedule === "string") providerInput.schedule = params.schedule;
    if (params.loras && typeof params.loras === "object" && !Array.isArray(params.loras)) providerInput.loras = params.loras;
    storedInput = { prompt, negativePrompt, model, engine: "sdcpp", parameters: { width, height, quantity, seed: seed ?? null, cfgScale, steps } };
    fingerprint = JSON.stringify({ prompt, negativePrompt, model, width, height, quantity, seed: seed ?? null, parameters: params });
  } else {
    return errorResponse("invalid_input", "Choose a supported generation recipe.", 400);
  }
  if (providerInput.prompt !== undefined && (typeof providerInput.prompt !== "string" || providerInput.prompt.length > promptLimit(mediaType, providerInput).max)) return errorResponse("invalid_input", "The prompt exceeds this engine's limit.", 400);
  let policy;
  try { policy = normalizePolicy(body.policy); } catch { return errorResponse("invalid_input", "Invalid generation payment policy.", 400); }
  const stepType = mediaType === 'audio' ? 'aceStepAudio' : mediaType === "video" ? "videoGen" : mediaType === "model3d" ? "polyGen" : "imageGen";
  let options;
  try { options = normalizeWorkflowOptions(body.options); } catch { return errorResponse("invalid_input", "Choose valid generation priority and tip rates from 0% to 200%.", 400); }
  if (providerInput.outputFormat !== undefined && (mediaType !== 'image' || typeof providerInput.outputFormat !== 'string' || !['jpeg', 'png', 'webP'].includes(providerInput.outputFormat))) return errorResponse('invalid_input', 'Image output format must be jpeg, png or webP; omit it for other media.', 400);
  const workflowRequest = { ...policy, tips: options.tips, steps: [{ "$type": stepType, priority: options.priority, input: providerInput }] };
  fingerprint = JSON.stringify({ recipe: "workflow", mediaType, input: providerInput, policy, options });
  return { mediaType, providerInput, storedInput, fingerprint, policy, workflowRequest };
}

const activePreviews = new Set<string>();
async function generationAccess(userId: string): Promise<BearerLease | Response> {
  const key = await resolveBearer(userId);
  if (!key) return errorResponse("civitai_not_connected", "Reconnect your Civitai key before previewing or generating.", 403);
  const scope = key.scopes;
  if (scope != null && (scope & AI_SERVICES_WRITE) === 0) return errorResponse("insufficient_scope", "This key needs AIServicesWrite to preview or generate.", 403);
  return key;
}
async function fetchCostReview(key: BearerLease, workflowRequest: Record<string, unknown>): Promise<CostReview | Response> {
  try {
    // Never attach externalId to whatif: provider idempotency can return an
    // existing paid workflow instead of a new preview when an ID is reused.
    const response = await orchestrationRequest(key, "/v2/consumer/workflows?whatif=true&wait=0", workflowRequest);
    if (!response.ok) {
      await response.body?.cancel();
      return errorResponse(response.status === 429 ? "provider_rate_limited" : response.status === 403 || response.status === 401 ? "insufficient_scope" : response.status >= 500 ? "provider_unavailable" : "provider_rejected", "Civitai could not preview this workflow. Check your balance, permissions and engine input, then try again. No generation was submitted.", response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 403 : response.status >= 500 ? 503 : 422);
    }
    return normalizeReview(await boundedPreviewJson(response), key.bearer);
  } catch (error) { if(error instanceof ConnectionError)return errorResponse("civitai_not_connected",error.message,403); return errorResponse("provider_unavailable", "Civitai returned an unavailable or unreadable cost preview. No generation was submitted.", 503); }
}
function unresolvedSubmission(userId: string) {
  const rows = db.query<{ record_json: string }, [string]>("SELECT record_json FROM generations WHERE user_id=? AND json_extract(record_json, '$.submissionState') IN ('uncertain','reserved') ORDER BY created_at").all(userId);
  let unresolved:Record<string,any>|null=null;
  for(const row of rows){const record=blockUnsafeLegacyVideo(userId,JSON.parse(row.record_json));if(['uncertain','reserved'].includes(record.submissionState)&&!unresolved)unresolved=record}
  return unresolved;
}
function blockUnsafeLegacyVideo(userId:string,record:Record<string,any>) {
  if(record.mediaType!=='video'||!['uncertain','reserved'].includes(record.submissionState))return record;
  const approved=record.approvedWorkflow;
  let legacyInput=approved?.providerInput??record.input?.parameters??{};
  if(!approved)try {const fingerprint=JSON.parse(record.inputFingerprint);if(fingerprint?.recipe==='workflow'&&fingerprint?.mediaType==='video')legacyInput=fingerprint.input??legacyInput}catch{/* Fall back to saved input; never invent a replacement request. */}
  if(approved?.sourceWorkflow||approved?.source||!sourceFreeVideoProblem(legacyInput))return record;
  const idempotencyKey=dbIdempotency(userId,record.id);if(!idempotencyKey)return record;
  const externalId=createHash('sha256').update(userId).update('\0').update(idempotencyKey).digest('hex');
  const hasWorkflow=typeof record.providerWorkflowId==='string'&&!!record.providerWorkflowId;
  const message=`Legacy request requires reconciliation: Studio will not resend its unsafe media settings. ${hasWorkflow?'Refreshing this gallery item checks its existing workflow with a read-only request.':'No workflow ID was confirmed, and the provider has no documented external-ID-only lookup. Inspect Civitai history or contact support with the preserved external ID.'} Other previews are available. Do not recreate this same job until its outcome is known. External ID: ${externalId}`;
  const blocked={...record,submissionState:'blocked_recovery',updatedAt:new Date().toISOString(),error:message,legacyRecovery:{state:'blocked',externalId,message}};
  saveGeneration(userId,idempotencyKey,blocked as any);return blocked;
}
function recoveryRequired(userId: string, idempotencyKey?: string) {
  const original = (idempotencyKey ? findIdempotentGeneration(userId, idempotencyKey) : null) ?? unresolvedSubmission(userId);
  return json({ error: { code: "recovery_required", generationId: original?.id ?? null, message: "A previously authorized generation still has an unresolved outcome. Retry its original confirmation or use Recover in the gallery. Restore key permissions or wait for rate limits if needed. New previews and new paid requests are blocked until that original request is reconciled." } }, 409);
}
function ownedMediaSourceRecord(userId: string, generationId: unknown, outputId: unknown, kind: MediaType = "image", downloadOnly = false) {
  if (typeof generationId !== "string" || generationId.length > 100 || typeof outputId !== "string" || !outputId || outputId.length > 300) throw new Error("Choose a saved source output.");
  const generation = findGeneration(userId,generationId) as any;
  const output = generation?.outputs?.find((item: any) => item.id === outputId);
  if (!generation || !output || (!downloadOnly && generation.mediaType !== kind) || output.kind !== kind || output.role === "thumbnail" || !generation.providerWorkflowId || ["reserved", "uncertain"].includes(generation.submissionState)) throw new Error("Choose an account-owned original of the requested media type from a known workflow. Thumbnails are not supported.");
  return { generation, output };
}
function safeMediaSourceUrl(value: unknown, key: BearerLease): value is string {
  if (typeof value !== "string" || value.length > 8192 || value.includes(key.bearer)) return false;
  try { const url = new URL(value); return safeProviderMediaUrl(value) && !url.username && !url.password && !url.port && !url.hash && ![...url.searchParams.keys()].some(name => /^(token|api[_-]?key|authorization)$/i.test(name)); } catch { return false; }
}
const assetIdentity = (value: string) => {
  const url = new URL(value);
  // Civitai's signed blob route rotates exp together with sig on refresh.
  // Scope this expiry exception to the observed provider route, not media transforms.
  if (url.protocol === 'https:' && url.hostname === 'orchestration-new.civitai.com'
    && !url.port && /^\/v2\/consumer\/blobs\/[^/]+$/.test(url.pathname)
    && url.searchParams.has('sig')) url.searchParams.delete('exp');
  // Only authentication expiry/signature changes are invisible to the review.
  // Keep transformation and other source-affecting parameters in its identity.
  for (const name of [...url.searchParams.keys()]) if (/^(sig|se|sp|sv|sr|st|skoid|sktid|skt|ske|sks|skv|spr|x-amz-algorithm|x-amz-credential|x-amz-date|x-amz-expires|x-amz-signedheaders|x-amz-signature|x-amz-security-token)$/i.test(name)) url.searchParams.delete(name);
  url.searchParams.sort();
  return `${url.origin}${url.pathname}${url.search}`;
};
class SourceRefreshError extends Error {}
async function freshMediaSource(userId: string, key: BearerLease, generationId: string, outputId: string, kind: MediaType = "image", downloadOnly = false) {
  const found = ownedMediaSourceRecord(userId,generationId,outputId,kind,downloadOnly);
  // GetBlob may redirect to media content. Resolve the owned workflow directly
  // so redirect:'error' remains intact and no bearer reaches a media host.
  let response: Response;
  try {
    response = await orchestrationRequest(key, `/v2/consumer/workflows/${encodeURIComponent(found.generation.providerWorkflowId)}`);
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    assertConnectionCurrent(key);
    throw new SourceRefreshError('Source refresh failed: workflow network/redirect error. No generation was submitted.');
  }
  assertConnectionCurrent(key);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new ConnectionError('reconnect_required');
    if (response.status === 403) throw new ConnectionError('insufficient_scope');
    const category = response.status === 429 ? 'workflow rate limited' : response.status === 404 ? 'workflow unavailable' : 'workflow HTTP error';
    throw new SourceRefreshError(`Source refresh failed: ${category}. No generation was submitted.`);
  }
  let workflow: ProviderWorkflow;
  try { workflow = await readWorkflowResponse(response,found.generation.providerWorkflowId); }
  catch (error) {
    if (error instanceof ConnectionError) throw error;
    assertConnectionCurrent(key);
    throw new SourceRefreshError('Source refresh failed: invalid workflow JSON, identity or status. No generation was submitted.');
  }
  assertConnectionCurrent(key);
  const fresh = normalizeOutputs(workflow).find(item => item.id === outputId && item.kind === kind && item.role !== 'thumbnail');
  if (!fresh || fresh.metadata.available === false) throw new SourceRefreshError('Source refresh failed: owned workflow output missing or unavailable. No generation was submitted.');
  if (!safeMediaSourceUrl(fresh.url,key)) throw new SourceRefreshError('Source refresh failed: source URL unavailable or failed safety validation. No generation was submitted.');
  return { ...found, output: fresh, url: fresh.url };
}

function positiveDimension(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function videoSizeProblem(output: any, operation: string, factor: number) {
  const limit=operation==='videoUpscaler'?2560:2048, multiplier=operation==='videoUpscaler'?factor:1;
  return [output.metadata?.width,output.metadata?.height].some(value=>positiveDimension(value)&&value*multiplier>limit) ? (operation==='videoUpscaler'?'The scaled video would exceed 2560 pixels on a side. Choose a smaller factor or source.':'Smoothing accepts source videos up to 2048 pixels per side.') : null;
}
async function prepareVideoFinishing(userId: string, key: BearerLease, body: Record<string, unknown>): Promise<PreparedGeneration | Response> {
  const operation=body.recipe as 'videoUpscaler'|'videoInterpolation';
  const field=operation==='videoUpscaler'?'scaleFactor':'interpolationFactor', factor=body[field]??2;
  if(Object.keys(body).some(name=>!['recipe','sourceGenerationId','sourceOutputId',field,'policy'].includes(name)) || !Number.isInteger(factor) || Number(factor)<2 || Number(factor)>(operation==='videoUpscaler'?4:3))return errorResponse('invalid_input','Choose a valid video finishing factor and owned video. Source URLs are not accepted.',400);
  let policy;
  try {policy=normalizePolicy(body.policy);ownedMediaSourceRecord(userId,body.sourceGenerationId,body.sourceOutputId,'video')}catch{return errorResponse('invalid_input','Choose an account-owned original video and valid payment policy.',400)}
  const fresh=await freshMediaSource(userId,key,String(body.sourceGenerationId),String(body.sourceOutputId),'video');
  const problem=videoSizeProblem(fresh.output,operation,Number(factor));if(problem)return errorResponse('invalid_input',problem,400);
  const source={operation,generationId:String(body.sourceGenerationId),outputId:String(body.sourceOutputId),[field]:Number(factor),width:positiveDimension(fresh.output.metadata?.width)?fresh.output.metadata.width:null,height:positiveDimension(fresh.output.metadata?.height)?fresh.output.metadata.height:null,assetIdentity:assetIdentity(fresh.url)};
  const providerInput={video:fresh.url,[field]:Number(factor)},parameters={engine:operation,sourceGenerationId:source.generationId,sourceOutputId:source.outputId,[field]:Number(factor)};
  return {mediaType:'video',source,providerInput,policy,storedInput:{prompt:operation==='videoUpscaler'?'Upscaled video':'Smoothed video',engine:operation,parameters},fingerprint:JSON.stringify({recipe:operation,...parameters,policy}),workflowRequest:{...policy,metadata:{studioMediaSource:{generationId:source.generationId,outputId:source.outputId}},steps:[{'$type':operation,input:providerInput}]}};
}
async function prepareUpscale(userId: string, key: BearerLease, body: Record<string, unknown>): Promise<PreparedGeneration | Response> {
  if (Object.keys(body).some(name => !["recipe", "sourceGenerationId", "sourceOutputId", "numberOfRepeats", "model", "policy"].includes(name)) || !Number.isInteger(body.numberOfRepeats) || Number(body.numberOfRepeats) < 1 || Number(body.numberOfRepeats) > 3 || (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 250))) return errorResponse("invalid_input", "Choose an owned source, 1-3 passes and an optional upscaler AIR. Source URLs are not accepted.", 400);
  let policy;
  try { policy = normalizePolicy(body.policy); ownedMediaSourceRecord(userId,body.sourceGenerationId,body.sourceOutputId); } catch { return errorResponse("invalid_input", "Choose an account-owned original image and valid payment policy.",400); }
  const fresh = await freshMediaSource(userId,key,String(body.sourceGenerationId),String(body.sourceOutputId));
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  const source = { operation: "imageUpscaler" as const, generationId: String(body.sourceGenerationId), outputId: String(body.sourceOutputId), numberOfRepeats: Number(body.numberOfRepeats), model, assetIdentity: assetIdentity(fresh.url) };
  const providerInput = { image: fresh.url, numberOfRepeats: source.numberOfRepeats, ...(model ? { model } : {}) };
  const parameters = { engine: "imageUpscaler", sourceGenerationId: source.generationId, sourceOutputId: source.outputId, numberOfRepeats: source.numberOfRepeats, ...(model ? { model } : {}) };
  return { mediaType: "image", providerInput, source, policy, storedInput: { prompt: "Upscaled image", engine: "imageUpscaler", model: model ?? "4x-Remacri (provider default)", parameters }, fingerprint: JSON.stringify({ recipe:"imageUpscaler", sourceGenerationId:source.generationId, sourceOutputId:source.outputId, numberOfRepeats:source.numberOfRepeats, model, policy }), workflowRequest: { ...policy, metadata: { studioUpscaleSource: { generationId: source.generationId, outputId: source.outputId } }, steps: [{ "$type":"imageUpscaler",input:providerInput }] } };
}
function transcodeSizeProblem(output: any, width: number): string | null {
  const sourceWidth = output.metadata?.width;
  if (!positiveDimension(sourceWidth)) return 'Civitai did not supply a source width. Studio cannot safely resize this video without risking enlargement.';
  return width > sourceWidth ? 'Choose a width no larger than the original video.' : null;
}
async function prepareTranscode(userId: string, key: BearerLease, body: Record<string, unknown>): Promise<PreparedGeneration | Response> {
  if (Object.keys(body).some(name => !['recipe','sourceGenerationId','sourceOutputId','width','containerFormat'].includes(name)) || !Number.isInteger(body.width) || Number(body.width)<2 || Number(body.width)>2048 || Number(body.width)%2!==0 || (body.containerFormat!=='mp4' && body.containerFormat!=='webM')) return errorResponse('invalid_input','Choose an owned video, an even width from 2 to 2048 pixels and MP4 or WebM. Source URLs and destinations are not accepted.',400);
  try { ownedMediaSourceRecord(userId,body.sourceGenerationId,body.sourceOutputId,'video'); } catch { return errorResponse('invalid_input','Choose an account-owned original video.',400); }
  const fresh = await freshMediaSource(userId,key,String(body.sourceGenerationId),String(body.sourceOutputId),'video');
  const problem = transcodeSizeProblem(fresh.output,Number(body.width)); if(problem)return errorResponse('invalid_input',problem,400);
  const source = {operation:'transcode' as const,generationId:String(body.sourceGenerationId),outputId:String(body.sourceOutputId),targetWidth:Number(body.width),containerFormat:body.containerFormat as 'mp4'|'webM',width:fresh.output.metadata.width,height:positiveDimension(fresh.output.metadata.height)?fresh.output.metadata.height:null,assetIdentity:assetIdentity(fresh.url)};
  const providerInput = {sourceUrl:fresh.url,width:source.targetWidth,containerFormat:source.containerFormat};
  const parameters = {engine:'transcode',sourceGenerationId:source.generationId,sourceOutputId:source.outputId,width:source.targetWidth,containerFormat:source.containerFormat};
  return {mediaType:'video',providerInput,source,policy:{},storedInput:{prompt:'Resized / converted video',engine:'transcode',parameters},fingerprint:JSON.stringify({recipe:'transcode',...parameters}),workflowRequest:{metadata:{studioMediaSource:{generationId:source.generationId,outputId:source.outputId}},steps:[{'$type':'transcode',input:providerInput}]}};
}
async function prepareImageTo3D(userId: string, key: BearerLease, body: Record<string, unknown>): Promise<PreparedGeneration | Response> {
  if (Object.keys(body).some(name => !['recipe','sourceGenerationId','sourceOutputId','shouldTexture'].includes(name)) || typeof body.shouldTexture !== 'boolean') return errorResponse('invalid_input','Choose an owned original image and whether to generate textures. Source URLs and custom settings are not accepted.',400);
  try { ownedMediaSourceRecord(userId,body.sourceGenerationId,body.sourceOutputId); } catch { return errorResponse('invalid_input','Choose an account-owned original image.',400); }
  const fresh = await freshMediaSource(userId,key,String(body.sourceGenerationId),String(body.sourceOutputId));
  const source = { operation:'imageTo3D' as const,generationId:String(body.sourceGenerationId),outputId:String(body.sourceOutputId),model:'meshy',shouldTexture:body.shouldTexture,assetIdentity:assetIdentity(fresh.url) };
  const settings = { engine:'fal',model:'meshy',version:'v6',operation:'imageTo3D',shouldTexture:source.shouldTexture,targetPolycount:30000,topology:'triangle',symmetryMode:'auto',shouldRemesh:true,enablePbr:false,enableRigging:false,enableAnimation:false };
  const providerInput = { ...settings,imageUrl:fresh.url };
  const parameters = { ...settings,sourceGenerationId:source.generationId,sourceOutputId:source.outputId };
  return {mediaType:'model3d',providerInput,source,policy:{},storedInput:{prompt:'3D model from image',engine:settings.engine,model:settings.model,parameters},fingerprint:JSON.stringify({recipe:'imageTo3D',...parameters}),workflowRequest:{metadata:{studioImageSource:{generationId:source.generationId,outputId:source.outputId}},steps:[{'$type':'polyGen',input:providerInput}]}};
}
async function prepareImageAnimation(userId: string, key: BearerLease, body: Record<string, unknown>): Promise<PreparedGeneration | Response> {
  if (Object.keys(body).some(name => !['recipe','sourceGenerationId','sourceOutputId','prompt','duration','aspectRatio'].includes(name)) || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 1000 || !['5','10'].includes(String(body.duration)) || typeof body.duration !== 'string' || typeof body.aspectRatio !== 'string' || !['16:9','9:16','1:1'].includes(String(body.aspectRatio))) return errorResponse('invalid_input','Choose an owned original image, a prompt of 1–1000 characters, 5 or 10 seconds, and a supported aspect ratio. Source URLs are not accepted.',400);
  try { ownedMediaSourceRecord(userId,body.sourceGenerationId,body.sourceOutputId); } catch { return errorResponse('invalid_input','Choose an account-owned original image.',400); }
  const fresh = await freshMediaSource(userId,key,String(body.sourceGenerationId),String(body.sourceOutputId));
  const source = { operation:'imageAnimation' as const,generationId:String(body.sourceGenerationId),outputId:String(body.sourceOutputId),prompt:body.prompt.trim(),model:'v1.6',duration:body.duration as '5'|'10',aspectRatio:body.aspectRatio as '16:9'|'9:16'|'1:1',assetIdentity:assetIdentity(fresh.url) };
  const settings = { engine:'kling',model:'v1.6',prompt:source.prompt,duration:source.duration,aspectRatio:source.aspectRatio,mode:'standard',cfgScale:0.5 };
  const providerInput = { ...settings,sourceImage:fresh.url };
  const parameters = { ...settings,sourceGenerationId:source.generationId,sourceOutputId:source.outputId };
  return {mediaType:'video',providerInput,source,policy:{},storedInput:{prompt:source.prompt,engine:settings.engine,model:settings.model,parameters},fingerprint:JSON.stringify({recipe:'imageAnimation',...parameters}),workflowRequest:{metadata:{studioImageSource:{generationId:source.generationId,outputId:source.outputId}},steps:[{'$type':'videoGen',input:providerInput}]}};
}
async function prepareImageEdit(userId: string, key: BearerLease, body: Record<string, unknown>): Promise<PreparedGeneration | Response> {
  if (Object.keys(body).some(name => !['recipe','sourceGenerationId','sourceOutputId','prompt'].includes(name)) || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 1000) return errorResponse('invalid_input','Choose an owned original image and an edit prompt of 1–1000 characters. Source URLs and custom settings are not accepted.',400);
  try { ownedMediaSourceRecord(userId,body.sourceGenerationId,body.sourceOutputId); } catch { return errorResponse('invalid_input','Choose an account-owned original image.',400); }
  const fresh = await freshMediaSource(userId,key,String(body.sourceGenerationId),String(body.sourceOutputId));
  const source = { operation:'imageEdit' as const,generationId:String(body.sourceGenerationId),outputId:String(body.sourceOutputId),prompt:body.prompt.trim(),model:'pro',assetIdentity:assetIdentity(fresh.url) };
  const settings = { engine:'flux1-kontext',model:'pro',prompt:source.prompt,quantity:1,aspectRatio:'1:1',guidanceScale:3.5 };
  const providerInput = { ...settings,images:[fresh.url] };
  const parameters = { ...settings,sourceGenerationId:source.generationId,sourceOutputId:source.outputId };
  return { mediaType:'image',providerInput,source,policy:{},storedInput:{prompt:source.prompt,engine:settings.engine,model:settings.model,parameters},fingerprint:JSON.stringify({recipe:'imageEdit',...parameters}),workflowRequest:{metadata:{studioImageSource:{generationId:source.generationId,outputId:source.outputId}},steps:[{'$type':'imageGen',input:providerInput}]}};
}
async function prepareBackgroundRemoval(userId: string, key: BearerLease, body: Record<string, unknown>): Promise<PreparedGeneration | Response> {
  if (Object.keys(body).some(name => !['recipe','sourceGenerationId','sourceOutputId','format','policy'].includes(name)) || (body.format !== undefined && (typeof body.format !== 'string' || !['png','webp'].includes(body.format)))) return errorResponse('invalid_input','Choose an owned source image and PNG or WebP. Source URLs are not accepted.',400);
  let policy;
  try { policy = normalizePolicy(body.policy); ownedMediaSourceRecord(userId,body.sourceGenerationId,body.sourceOutputId); } catch { return errorResponse('invalid_input','Choose an account-owned original image and valid payment policy.',400); }
  const fresh = await freshMediaSource(userId,key,String(body.sourceGenerationId),String(body.sourceOutputId));
  const format = (body.format ?? 'png') as 'png' | 'webp';
  const source = { operation:'imageBackgroundRemoval' as const,generationId:String(body.sourceGenerationId),outputId:String(body.sourceOutputId),format,assetIdentity:assetIdentity(fresh.url) };
  const providerInput = { image:fresh.url,format };
  const parameters = { engine:'imageBackgroundRemoval',sourceGenerationId:source.generationId,sourceOutputId:source.outputId,format };
  return { mediaType:'image',providerInput,source,policy,storedInput:{ prompt:'Background removed',engine:'imageBackgroundRemoval',parameters },fingerprint:JSON.stringify({ recipe:'imageBackgroundRemoval',...parameters,policy }),workflowRequest:{ ...policy,metadata:{ studioImageSource:{generationId:source.generationId,outputId:source.outputId} },steps:[{ '$type':'imageBackgroundRemoval',input:providerInput }] } };
}
async function validatePreparedResources(key: BearerLease, prepared: PreparedGeneration) {
  if ((prepared.workflowRequest.steps as any[])?.some(step=>step['$type']==='comfy')) return 'Image fix graphs are not qualified for submission.';
  if(prepared.draft)return validateDraft(key,prepared);
  if(prepared.mediaType==='audio')return musicProviderProblem(prepared.providerInput);
  if(prepared.mediaType==='video'&&!prepared.sourceWorkflow&&!prepared.source){const problem=sourceFreeVideoProblem(prepared.providerInput);if(problem)return problem}
  if (prepared.sourceWorkflow) {
    if (prepared.sourceWorkflow.operation === 'imageVariations') return validateGenerationResources(key,'image',prepared.providerInput);
    if (prepared.sourceWorkflow.operation !== 'imageUpscaler' || !prepared.providerInput.model) return null;
    const air = parseAir(String(prepared.providerInput.model));
    if (!air || air.type !== 'upscaler') return 'Choose a canonical upscaler AIR.';
    const version = await resolveModelVersion(key,air.versionId);
    return version.air === prepared.providerInput.model && version.canGenerate && version.type.toLowerCase() === 'upscaler' ? null : 'This upscaler is unavailable or incompatible.';
  }
  if (prepared.source?.operation === 'imageEdit' || prepared.source?.operation === 'imageAnimation' || prepared.source?.operation === 'imageTo3D') return null; // Managed model availability is validated by whatif.
  if (prepared.training) return null; // Frozen, server-owned dataset; whatif validates training availability.
  if (!prepared.source) return validateGenerationResources(key,prepared.mediaType,prepared.providerInput);
  if (["videoUpscaler","videoInterpolation"].includes(prepared.source.operation ?? "") || prepared.source.operation === "imageBackgroundRemoval" || !prepared.source.model) return null; // Provider resolves its documented default during whatif.
  const air = parseAir(prepared.source.model);
  if (!air || air.type !== "upscaler") return "Use a canonical, version-pinned Civitai upscaler AIR.";
  const version = await resolveModelVersion(key,air.versionId);
  return version.air !== prepared.source.model || version.modelId !== air.modelId || version.type.toLowerCase() !== "upscaler" || !version.canGenerate ? "This upscaler AIR is not canonical or is unavailable for this account." : null;
}
async function previewGeneration(userId: string, body: Record<string, unknown>) {
  if(body.recipe==='imageGraph'||graphOperations.includes(body.operation as any)) {try{requireImageGraphQualification()}catch(error){return errorResponse('workflow_unavailable',error instanceof Error?error.message:'Image graph unavailable.',409)}}
  if (unresolvedSubmission(userId)) return recoveryRequired(userId);
  if (activePreviews.has(userId)) return errorResponse("provider_rate_limited", "A cost preview is already being prepared. Please wait.", 429);
  activePreviews.add(userId);
  try {
    const key = await generationAccess(userId);
    if (key instanceof Response) return key;
    const legacyImageSource = ['imageTo3D','imageEdit','imageUpscaler','imageBackgroundRemoval'].includes(String(body.recipe));
    if (body.recipe==='sourceWorkflow') try { const validated=validateSourceWorkflowBody(body);const requirement=sourceRequirements(validated.operation);for(const id of body.sourceIds as string[]){const source=sourceRecord(userId,id);if(source.type!==requirement.type||source.status!=='ready')throw new Error(`Choose available owned ${requirement.type} sources.`)} } catch(error) { return errorResponse('invalid_input',error instanceof Error?error.message:'Invalid source workflow settings.',400); }
    let sourceOptions;
    if (legacyImageSource) {
      try { sourceOptions = normalizeWorkflowOptions(body.options); } catch { return errorResponse('invalid_input','Choose valid source workflow tips and priority.',400); }
      const {options,...rest} = body; body=rest;
    }
    const prepared = body.recipe === "draft" ? await prepareDraft(key,body).catch(error=>errorResponse("invalid_input",error instanceof SiteError?"Draft resource availability could not be confirmed. Retry or choose Create Image.":error instanceof Error?error.message:"Draft unavailable.",400)) : body.recipe === "sourceWorkflow" ? prepareSourceWorkflow(body,await resolveImageSources(userId,key,body.sourceIds as string[],(generationId,outputId,type)=>freshMediaSource(userId,key,generationId,outputId,type),value=>safeMediaSourceUrl(value,key),assetIdentity)) : body.recipe === "transcode" ? await prepareTranscode(userId,key,body) : body.recipe === "imageTo3D" ? await prepareImageTo3D(userId,key,body) : body.recipe === "imageAnimation" ? await prepareImageAnimation(userId,key,body) : body.recipe === "imageEdit" ? await prepareImageEdit(userId,key,body) : ["videoUpscaler","videoInterpolation"].includes(String(body.recipe)) ? await prepareVideoFinishing(userId,key,body) : body.recipe === "training" ? (() => { try { return prepareTraining(userId,body); } catch(error) { return errorResponse("invalid_input",error instanceof Error ? error.message : "Invalid training dataset or settings.",400); } })() : body.recipe === "imageUpscaler" ? await prepareUpscale(userId,key,body) : body.recipe === "imageBackgroundRemoval" ? await prepareBackgroundRemoval(userId,key,body) : prepareGeneration(body);
    if (prepared instanceof Response) return prepared;
    if (sourceOptions) {
      prepared.workflowRequest={...prepared.workflowRequest,tips:sourceOptions.tips,steps:(prepared.workflowRequest.steps as any[]).map(step=>({...step,priority:sourceOptions.priority}))};
      prepared.fingerprint=JSON.stringify({input:prepared.fingerprint,options:sourceOptions});
      prepared.storedInput={...prepared.storedInput,parameters:{...(prepared.storedInput.parameters as Record<string,unknown>),options:sourceOptions}};
    }
    const problem = await validatePreparedResources(key, prepared);
    if (problem) return errorResponse("invalid_input", problem, 400);
    const review = await fetchCostReview(key, prepared.workflowRequest);
    if (review instanceof Response) return review;
    if (!connectionCurrent(key)) return errorResponse("preview_required", "Your connection changed. Request a fresh preview.", 409);
    if (unresolvedSubmission(userId)) return recoveryRequired(userId);
    return json({ preview: publicQuote(saveQuote(userId, key, prepared, review)) });
  } catch (error) { if(error instanceof SourceWorkflowError)return errorResponse('invalid_input',error.message,400); if(error instanceof SourceRefreshError)return errorResponse("provider_unavailable",error.message,503); if(error instanceof ConnectionError)return errorResponse("civitai_not_connected",error.message,403); return errorResponse("provider_unavailable", "Studio could not prepare a cost preview. No generation was submitted. Try again shortly.", 503); }
  finally { activePreviews.delete(userId); }
}
async function confirmGeneration(userId: string, previewId: string) {
  if (!/^quote_[a-f0-9-]{36}$/.test(previewId)) return errorResponse("preview_required", "Preview this generation before confirming it.", 409);
  const previous = findIdempotentGeneration(userId, previewId) as any;
  // A durable authorized reservation can be recovered after quote expiry or a
  // server restart; recovery never allocates a different provider externalId.
  if (previous) return submitApprovedGeneration(userId, previewId, null);
  if (unresolvedSubmission(userId)) return recoveryRequired(userId);
  const quote = getQuote(userId, previewId);
  if (!quote || quote.expiresAt <= Date.now()) { discardQuote(previewId); return errorResponse("preview_required", "This cost preview expired. Request a fresh preview and review it before generating.", 409); }
  return submitApprovedGeneration(userId, previewId, quote);
}
async function submitApprovedGeneration(userId: string, idempotencyKey: string, quote: SavedQuote | null) {
  const existing = findIdempotentGeneration(userId, idempotencyKey) as any;
  if(existing){const legacy=blockUnsafeLegacyVideo(userId,existing);if(legacy.submissionState==='blocked_recovery')return legacy.providerWorkflowId?refreshGeneration(userId,legacy):json({generation:publicGeneration(legacy)},202)}
  const recovering = existing && ["uncertain", "reserved"].includes(existing.submissionState);
  const submissionKey = `${userId}:${idempotencyKey}`;
  if (activeSubmissions.has(submissionKey)) return errorResponse("idempotency_conflict", "This generation is already being confirmed. Wait, then retry the same confirmation.", 409);
  activeSubmissions.add(submissionKey);
  try {
    const key = await generationAccess(userId);
    if (key instanceof Response) return recovering ? recoveryRequired(userId,idempotencyKey) : key;
    const previous = findIdempotentGeneration(userId, idempotencyKey) as any;
    if (previous && !["reserved", "uncertain"].includes(previous.submissionState)) return json({ generation: publicGeneration(previous) }, 202);
    let prepared: PreparedGeneration;
    let review: CostReview | null;
    if (previous && ["uncertain", "reserved"].includes(previous.submissionState)) {
      if (previous.approvedWorkflow) {
        prepared = previous.approvedWorkflow;
        review = previous.approvedReview ?? null;
      } else {
        // Preserve recovery of paid submissions made before the review feature.
        let recovered;
        try { recovered = JSON.parse(previous.inputFingerprint); } catch { return recoveryRequired(userId, recovering ? idempotencyKey : undefined); }
        const normalized = prepareGeneration(recovered.recipe === "workflow" ? recovered : { recipe: "sdxl", input: recovered });
        if (normalized instanceof Response) return recoveryRequired(userId, recovering ? idempotencyKey : undefined);
        prepared = { ...normalized, fingerprint: previous.inputFingerprint };
        review = null;
      }
    } else {
      if (unresolvedSubmission(userId)) return recoveryRequired(userId, recovering ? idempotencyKey : undefined);
      if (!quote || quote.expiresAt <= Date.now() || quote.connectionRevision !== key.revision) return errorResponse("preview_required", "Request a fresh preview before generating.", 409);
      if (quote.training && !validateTrainingQuote(userId,quote)) { discardQuote(quote.id); return errorResponse('preview_required','The training dataset changed or its blobs expired. Review a new preview.',409); }
      let reviewedRequest: PreparedGeneration = quote;
      if (quote.sourceWorkflow) {
        try {
          const freshSources = await resolveImageSources(userId,key,quote.sourceWorkflow.sources.map(source=>source.id),(generationId,outputId,type)=>freshMediaSource(userId,key,generationId,outputId,type),value=>safeMediaSourceUrl(value,key),assetIdentity);
          if (freshSources.some((item,index)=>item.source.identity!==quote.sourceWorkflow!.sources[index]!.identity || item.source.revision!==quote.sourceWorkflow!.sources[index]!.revision)) throw new Error('Source changed.');
          const refreshed = prepareSourceWorkflow({recipe:'sourceWorkflow',operation:quote.sourceWorkflow.operation,settings:quote.sourceWorkflow.settings,sourceIds:freshSources.map(item=>item.source.id),options:{tips:quote.workflowRequest.tips,priority:(quote.workflowRequest.steps as any[])[0].priority}},freshSources);
          reviewedRequest = {...quote,providerInput:refreshed.providerInput,sourceWorkflow:refreshed.sourceWorkflow,workflowRequest:refreshed.workflowRequest};
        } catch { discardQuote(quote.id); return errorResponse('preview_required','A media source changed, expired or could not be refreshed. Review a new preview; no paid request was sent.',409); }
      }
      if (quote.source) {
        let freshSource;
        try { freshSource = await freshMediaSource(userId,key,quote.source.generationId,quote.source.outputId,["videoUpscaler","videoInterpolation","transcode"].includes(quote.source.operation ?? "") ? "video" : "image"); } catch { return errorResponse("preview_required", "The source image could not be refreshed. Request a fresh preview; no paid workflow was sent.",409); }
        if (assetIdentity(freshSource.url) !== quote.source.assetIdentity) { discardQuote(quote.id); return errorResponse("preview_required", "Civitai changed the source asset URL. Review a fresh preview before processing the image.",409); }
        if(quote.source.operation === 'videoUpscaler' || quote.source.operation === 'videoInterpolation'){const problem=videoSizeProblem(freshSource.output,quote.source.operation!,Number(quote.source.scaleFactor??quote.source.interpolationFactor));if(problem)return errorResponse('invalid_input',problem,400);}
        if(quote.source.operation === 'transcode'){const problem=transcodeSizeProblem(freshSource.output,quote.source.targetWidth!);if(problem)return errorResponse('invalid_input',problem,400);}
        const providerInput = { ...quote.providerInput, ...(quote.source.operation === 'transcode' ? {sourceUrl:freshSource.url} : quote.source.operation === 'imageTo3D' ? {imageUrl:freshSource.url} : quote.source.operation === 'imageAnimation' ? {sourceImage:freshSource.url} : quote.source.operation === 'imageEdit' ? {images:[freshSource.url]} : {[quote.mediaType==='video'?'video':'image']:freshSource.url}) };
        reviewedRequest = { ...quote, providerInput, workflowRequest: { ...quote.workflowRequest, steps:[{ ...(quote.workflowRequest.steps as any[])[0], "$type":quote.source.operation === "imageTo3D" ? "polyGen" : quote.source.operation === "imageAnimation" ? "videoGen" : quote.source.operation === "imageEdit" ? "imageGen" : quote.source.operation ?? "imageUpscaler",input:providerInput }] } };
      }
      const problem = await validatePreparedResources(key, reviewedRequest);
      if (problem) return errorResponse("invalid_input", problem, 400);
      const fresh = await fetchCostReview(key, reviewedRequest.workflowRequest);
      if (fresh instanceof Response) return fresh;
      if (getQuote(userId, quote.id) !== quote || quote.expiresAt <= Date.now() || !connectionCurrent(key)) { discardQuote(quote.id); return errorResponse("preview_required", "The preview expired or your connection changed. Request a fresh preview.", 409); }
      if (JSON.stringify(fresh) !== JSON.stringify(quote.review)) { discardQuote(quote.id); return errorResponse("preview_changed", "Civitai's cost, payment breakdown or warnings changed. Nothing was submitted. Request a fresh preview and review it.", 409); }
      if (fresh.insufficientBuzz === true) return errorResponse("provider_rejected", "Civitai reports insufficient Buzz. Nothing was submitted. Refresh your preview after adding Buzz.", 422);
      if (fresh.total === null) return errorResponse("provider_rejected", "Civitai did not provide a total estimate. Nothing was submitted. Request a fresh preview.", 422);
      if (unresolvedSubmission(userId)) return recoveryRequired(userId, recovering ? idempotencyKey : undefined);
      if (reviewedRequest.training && !validateTrainingQuote(userId,reviewedRequest)) { discardQuote(quote.id); return errorResponse('preview_required','The training dataset changed while reviewing cost. Review a new preview.',409); }
      prepared = { ...(reviewedRequest.draft ? { draft: reviewedRequest.draft } : {}), mediaType: reviewedRequest.mediaType, providerInput: reviewedRequest.providerInput, storedInput: reviewedRequest.storedInput, fingerprint: reviewedRequest.fingerprint, policy: reviewedRequest.policy, workflowRequest: reviewedRequest.workflowRequest, ...(reviewedRequest.source ? { source: reviewedRequest.source } : {}), ...(reviewedRequest.training ? { training: reviewedRequest.training } : {}), ...(reviewedRequest.sourceWorkflow ? { sourceWorkflow: reviewedRequest.sourceWorkflow } : {}) }; review = fresh;
    }
    if(prepared.mediaType==='video'&&!prepared.sourceWorkflow&&!prepared.source){const problem=sourceFreeVideoProblem(prepared.providerInput);if(problem){if(previous){const legacy=blockUnsafeLegacyVideo(userId,previous);return legacy.providerWorkflowId?refreshGeneration(userId,legacy):json({generation:publicGeneration(legacy)},202)}return errorResponse('invalid_input',problem,400)}}
    if ((prepared.workflowRequest.steps as any[])?.some(step=>step['$type']==='comfy')) return errorResponse('workflow_unavailable','Image fix graphs require provider qualification.',409);
    const { mediaType, storedInput, fingerprint, workflowRequest } = prepared;
    if(mediaType==='audio'){const problem=musicProviderProblem(prepared.providerInput);if(problem)return errorResponse('invalid_input',problem,400)}
    const reservationTime = new Date().toISOString();
    const estimatedCost = review?.total != null ? { amount: review.total, unit: "buzz", estimated: true } : previous?.cost ?? null;
    // Persist uncertainty before dispatch so process interruption cannot turn a
    // possibly paid request into a new request on retry.
    const reservation = { ...(previous ?? { id: `gen_${crypto.randomUUID()}`, provider: "civitai", providerWorkflowId: null, createdAt: reservationTime, mediaType, input: storedInput, inputFingerprint: fingerprint, outputs: [] }), status: "running", updatedAt: reservationTime, cost: estimatedCost, error: "Submission is awaiting provider confirmation.", submissionState: "uncertain", connectionRevision: key.revision, approvedWorkflow: prepared, approvedReview: review };
    if (!previous) (reservation as any).autoSaveEligibleAt = reservationTime;
    saveGeneration(userId, idempotencyKey, reservation);
    const failReservation = (message: string) => saveGeneration(userId, idempotencyKey, { ...reservation, status: previous ? "running" : "failed", submissionState: previous ? "uncertain" : "rejected", updatedAt: new Date().toISOString(), error: message });
    const externalId = createHash("sha256").update(userId).update("\0").update(idempotencyKey).digest("hex");
    let provider: ProviderWorkflow;
    let paidDispatched = false;
    try {
      const response = await orchestrationRequest(key, "/v2/consumer/workflows?whatif=false&wait=0", { ...workflowRequest, externalId }, () => {
        assertConnectionCurrent(key);
        const saved = findIdempotentGeneration(userId,idempotencyKey) as any;
        if (saved?.id !== reservation.id || saved?.connectionRevision !== key.revision || saved?.submissionState !== 'uncertain') throw new ConnectionError('connection_changed');
        if (!previous) {
          if (!quote || getQuote(userId,quote.id) !== quote || quote.expiresAt <= Date.now() || quote.connectionRevision !== key.revision) throw new ConnectionError('connection_changed');
          if (prepared.sourceWorkflow && !sourcesCurrent(userId,prepared.sourceWorkflow.sources)) throw new ConnectionError('connection_changed');
          if (prepared.training && !validateTrainingQuote(userId,prepared)) throw new ConnectionError('connection_changed');
          const unresolved = unresolvedSubmission(userId);
          if (unresolved && unresolved.id !== reservation.id) throw new ConnectionError('connection_changed');
        }
        paidDispatched = true;
      });
      if (!response.ok && recovering) { await response.body?.cancel(); return recoveryRequired(userId, recovering ? idempotencyKey : undefined); }
      if (response.status === 401 || response.status === 403) { failReservation("Civitai denied the workflow due to key permissions."); return errorResponse("insufficient_scope", "Civitai denied this generation. Check key permissions.", 403); }
      if (response.status === 429) { failReservation("Civitai rate limited the workflow submission."); return errorResponse("provider_rate_limited", "Civitai is rate limiting this key. Try again later with a fresh preview.", 429); }
      if (response.status >= 500) throw new Error('Uncertain provider response');
      if (!response.ok) { failReservation("Civitai rejected the workflow."); return errorResponse("provider_rejected", "Civitai rejected the generation workflow. Request a fresh preview before trying again.", 422); }
      provider = await boundedPreviewJson(response) as ProviderWorkflow;
      if (typeof provider.id !== "string" || !provider.id) throw new Error('Incomplete response');
    } catch (error) {
      if (!paidDispatched && !previous) { failReservation('Connection or approval changed before dispatch. Review a new preview.'); return errorResponse('preview_required','No paid request was sent. Review a fresh preview.',409); }
      return recoveryRequired(userId, idempotencyKey);
    }
    const generation = { ...mapWorkflow(provider,reservation), providerWorkflowId: provider.id, submissionState: "accepted" };
    saveGeneration(userId, idempotencyKey, generation);
    buzzCache.delete(userId);
    return json({ generation: publicGeneration(generation) }, 202);
  } catch (error) { if(error instanceof ConnectionError && !unresolvedSubmission(userId))return errorResponse("civitai_not_connected",error.message,403); if (unresolvedSubmission(userId)) return recoveryRequired(userId, recovering ? idempotencyKey : undefined); return errorResponse("provider_unavailable", "Studio could not complete confirmation. Retry the same confirmation to recover safely.", 503); }
  finally { activeSubmissions.delete(submissionKey); }
}

function publicStoredGenerationInput(record:Record<string,any>) {
  return publicMediaMetadata(record.input)??{prompt:'',parameters:{}};
}
function publicGeneration(record: Record<string, any>) {
  const { connectionRevision: _connectionRevision, approvedWorkflow: _approvedWorkflow, approvedReview: _approvedReview, inputFingerprint: _fingerprint, providerStatus: _providerStatus, submissionState: _submissionState, ...visible } = record;
  const blockedRecovery=_submissionState==='blocked_recovery'||record.legacyRecovery?.state==='blocked';
  const unknownSubmission = _submissionState === "uncertain" || _submissionState === "reserved" || blockedRecovery;
  const known = typeof record.providerWorkflowId === "string" && !!record.providerWorkflowId && !unknownSubmission;
  const needsReconciliation = ["requesting", "uncertain"].includes(record.cancellation?.state);
  return { ...visible,input:publicStoredGenerationInput(record),outputs:(record.outputs??[]).map((output:any)=>({...output,metadata:publicMediaMetadata(output.metadata)??{}})), canRetry: unknownSubmission&&!blockedRecovery, canCancel: known && ["queued", "running"].includes(record.status) && !needsReconciliation, canReconcileCancel: known && needsReconciliation };
}

function ownedOutput(userId: string, outputId: string) {
  const rows = db.query<{ record_json: string }, [string]>("SELECT record_json FROM generations WHERE user_id=?").all(userId);
  for (const row of rows) {
    const generation = JSON.parse(row.record_json) as Record<string, any>;
    const output = Array.isArray(generation.outputs) ? generation.outputs.find((item: any) => item.id === outputId) : null;
    if (output) return { generation, output };
  }
  return null;
}

function safeFilename(outputId: string, mimeType: string | null, format?: unknown) {
  if(mimeType?.startsWith('audio/')){const ext=({'audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/wave':'wav','audio/ogg':'ogg','audio/flac':'flac','audio/x-flac':'flac','audio/aac':'aac','audio/mp4':'m4a','audio/webm':'webm'} as Record<string,string>)[mimeType]??'bin';return `civitai-${outputId.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,55)}-${createHash('sha256').update(outputId).digest('hex').slice(0,12)}.${ext}`;}
  const knownFormat = typeof format === "string" && /^(glb|gltf|fbx|obj|usdz|safetensors)$/i.test(format) ? format.toLowerCase() : null;
  const ext = knownFormat ?? (mimeType?.includes("png") ? "png" : mimeType?.includes("webp") ? "webp" : mimeType?.includes("gif") ? "gif" : mimeType?.includes("avif") ? "avif" : mimeType?.includes("jpeg") ? "jpg" : mimeType?.includes("mp4") ? "mp4" : mimeType?.includes("webm") ? "webm" : mimeType?.includes("quicktime") ? "mov" : mimeType?.includes("gltf-binary") ? "glb" : mimeType?.includes("gltf+json") ? "gltf" : mimeType?.includes("fbx") ? "fbx" : mimeType?.includes("usdz") ? "usdz" : "bin");
  const readable = outputId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 55);
  const suffix = createHash("sha256").update(outputId).digest("hex").slice(0, 12);
  return `civitai-${readable}-${suffix}.${ext}`;
}

function utcDateFolder(output: Record<string, any>, generation: Record<string, any>) {
  const value = typeof output.createdAt === "string" ? output.createdAt : (generation.completedAt ?? generation.updatedAt ?? generation.createdAt);
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: Array<{ name: string; bytes: Uint8Array }>) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const sum = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length);
    const lh = new DataView(local.buffer);
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint32(14, sum, true); lh.setUint32(18, entry.bytes.length, true); lh.setUint32(22, entry.bytes.length, true);
    lh.setUint16(26, name.length, true); local.set(name, 30);
    localParts.push(local, entry.bytes);

    const central = new Uint8Array(46 + name.length);
    const ch = new DataView(central.buffer);
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint32(16, sum, true);
    ch.setUint32(20, entry.bytes.length, true); ch.setUint32(24, entry.bytes.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true); central.set(name, 46);
    centralParts.push(central);
    offset += local.length + entry.bytes.length;
  }
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return concatBytes([...localParts, ...centralParts, end]);
}

function concatBytes(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function pruneDownloads() {
  const now = Date.now();
  for (const [id, download] of downloads) if (now - download.createdAt > 30 * 60_000) downloads.delete(id);
  const archiveBytes = () => [...downloads.values()].reduce((size, item) => size + (item.archive?.byteLength ?? 0), 0);
  while (downloads.size > 20 || archiveBytes() > 300 * 1024 * 1024) {
    const oldest = downloads.keys().next().value as string | undefined;
    if (!oldest) break;
    downloads.delete(oldest);
  }
}

// Strip credential fields and URL signatures before writing portable sidecars.
function exportMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(exportMetadata);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|authorization|cookie|api.?key|signature/i.test(key)).map(([key, item]) => [key, exportMetadata(item)]));
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; } catch { return null; }
  }
  return value;
}

function downloadManifestItem(generation: Record<string, any>, output: Record<string, any>): DownloadItem {
  const outputId = output.id, category = outputCategory(generation, output), dateFolder = utcDateFolder(output, generation);
  const timestamp = output.createdAt ?? generation.completedAt ?? generation.updatedAt ?? generation.createdAt;
  return { outputId, category, maxBytes: output.kind === 'audio'?100*1024*1024:output.kind === 'checkpoint' ? 1024 * 1024 * 1024 : 500 * 1024 * 1024,
    status: 'ready', filename: safeFilename(outputId, output.mimeType, output.metadata?.format), dateFolder, error: null,
    contentUrl: `/api/studio/v1/generations/${encodeURIComponent(generation.id)}/outputs/${encodeURIComponent(outputId)}/content`,
    metadata: { schemaVersion: 2, provider: 'civitai', generationId: generation.id, providerWorkflowId: generation.providerWorkflowId,
      outputId, category, dateBasis: 'utc', timezone: 'UTC', dateFolder, dateTimestamp: timestamp,
      dateFallback: Number.isNaN(new Date(timestamp).valueOf()) ? 'export-date' : null,
      timestamps: { outputCreatedAt: output.createdAt, generationCreatedAt: generation.createdAt, completedAt: generation.completedAt, updatedAt: generation.updatedAt },
      input: exportMetadata(publicStoredGenerationInput(generation)), sourceMetadata: exportMetadata(publicMediaMetadata(output.metadata)), mimeType: output.mimeType, sourceUrl: exportMetadata(output.url) } };
}

async function createDownload(userId: string, body: Record<string, unknown>) {
  const outputIds = body.outputIds;
  const mode = body.mode;
  if (!Array.isArray(outputIds) || outputIds.length < 1 || outputIds.length > 50 || outputIds.some((id) => typeof id !== "string" || id.length > 160) || (mode !== "files" && mode !== "zip") || body.dateBasis !== "utc") {
    return errorResponse("invalid_input", "Choose 1-50 output IDs, a files or zip mode, and UTC date folders.", 400);
  }
  if (mode === "zip" && (activeArchiveBuilds >= 2 || activeArchiveUsers.has(userId))) {
    return errorResponse("download_busy", "An archive is already being prepared. Try again shortly.", 429);
  }
  if (mode === "zip") { activeArchiveBuilds++; activeArchiveUsers.add(userId); }
  try {
  const items: DownloadItem[] = [];
  const entries: Array<{ name: string; bytes: Uint8Array }> = [];
  const manifest: Array<Record<string, unknown>> = [];
  let totalSize = 0;
  for (const outputId of [...new Set(outputIds as string[])]) {
    const found = ownedOutput(userId, outputId);
    if (!found) return errorResponse("not_found", "One or more selected outputs do not belong to this account.", 404);
    const { generation, output } = found;
    const dateFolder = utcDateFolder(output, generation), category = outputCategory(generation, output);
    let filename = safeFilename(outputId, output.mimeType, output.metadata?.format);
    if (mode === "files") {
      items.push(downloadManifestItem(generation, output));
      continue;
    }
    const mediaResponse = await outputContent(userId, generation, outputId, 150 * 1024 * 1024 - totalSize);
    if (!mediaResponse.ok) {
      items.push({ outputId, category, status: "failed", filename: null, dateFolder, error: "Output could not be downloaded from Civitai." });
      continue;
    }
    filename = safeFilename(outputId, mediaResponse.headers.get("content-type")?.split(";")[0] ?? output.mimeType, output.metadata?.format);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await mediaResponse.arrayBuffer()); }
    catch { items.push({ outputId, category, status: "failed", filename: null, dateFolder, error: "Output exceeded the archive limit or its transfer failed." }); continue; }
    totalSize += bytes.length;
    if (totalSize > 150 * 1024 * 1024) return errorResponse("invalid_input", "A bulk archive cannot exceed 150 MB.", 413);
    items.push({ outputId, category, status: "completed", filename, dateFolder, error: null });
    entries.push({ name: `${category}/${dateFolder}/${filename}`, bytes });
    const sidecarBytes = new TextEncoder().encode(JSON.stringify(downloadManifestItem(generation,output).metadata,null,2));
    totalSize += sidecarBytes.length;
    if (sidecarBytes.length > 4 * 1024 * 1024 || totalSize > 150 * 1024 * 1024) return errorResponse('invalid_input','Archive metadata exceeds the size limit.',413);
    entries.push({ name: `${category}/${dateFolder}/${filename}.studio.json`, bytes: sidecarBytes });
    manifest.push({ ...downloadManifestItem(generation, output).metadata, filename });
  }
  const id = `dl_${crypto.randomUUID()}`;
  let archive: Uint8Array | undefined;
  let archiveUrl: string | null = null;
  const status = mode === "zip" && entries.length === 0 ? "failed" : items.some((item) => item.status === "failed") ? "partial" : "completed";
  if (mode === "zip" && entries.length) {
    const manifestBytes = new TextEncoder().encode(JSON.stringify({ dateBasis: 'utc', items: manifest }, null, 2));
    if (totalSize + manifestBytes.length > 150 * 1024 * 1024) return errorResponse('invalid_input','Archive manifest exceeds the size limit.',413);
    entries.push({ name: 'manifest.json', bytes: manifestBytes });
    archive = makeZip(entries);
    archiveUrl = `/api/studio/v1/downloads/${encodeURIComponent(id)}/archive`;
  }
  // File manifests are immediate responses, not retained archive jobs.
  if (mode === "zip") {
    pruneDownloads();
    downloads.set(id, { ownerId: userId, status, items, archiveUrl, archive, createdAt: Date.now() });
  }
  return json({ download: { id, status, items, archiveUrl } }, 202);
  } finally {
    if (mode === "zip") { activeArchiveBuilds--; activeArchiveUsers.delete(userId); }
  }
}

const workflowStates = new Set(["unassigned", "preparing", "scheduled", "processing", "succeeded", "failed", "expired", "canceled"]);
async function readWorkflowResponse(response: Response, id: string): Promise<ProviderWorkflow> {
  const workflow = await boundedPreviewJson(response) as ProviderWorkflow;
  if (workflow?.id !== id || typeof workflow.status !== "string" || !workflowStates.has(workflow.status)) throw new Error("Incomplete workflow response");
  return workflow;
}
async function cancelGeneration(userId: string, generationId: string, reconcileOnly: boolean): Promise<Response> {
  let current = findGeneration(userId, generationId) as any;
  if (!current) return errorResponse("not_found", "Generation not found.", 404);
  if (!current.providerWorkflowId || ["reserved", "uncertain"].includes(current.submissionState)) return errorResponse("invalid_input", "Cancellation requires a known accepted workflow. An unknown submission will never be submitted again merely to cancel it.", 409);
  const id = String(current.providerWorkflowId);
  const lock = `${userId}:${id}`;
  if (activeWorkflowUpdates.has(lock)) return errorResponse("idempotency_conflict", "This workflow is being updated. Wait, then refresh its status.", 409);
  const pending = ["requesting", "uncertain"].includes(current.cancellation?.state);
  const idem = dbIdempotency(userId, generationId);
  if (!idem) return errorResponse("not_found", "The saved workflow record was not found.", 404);
  activeWorkflowUpdates.add(lock);
  let dispatched = false;
  const persist = () => { saveGeneration(userId, idem, current); buzzCache.delete(userId); };
  try {
    const key = await resolveBearer(userId,{requiredScopes:!reconcileOnly && !pending ? AI_SERVICES_WRITE : 16384});
    // Always reconcile before any possible retry. A pending/uncertain request
    // consumes this action as GET-only, even if the caller asked to cancel.
    const response = await orchestrationRequest(key, `/v2/consumer/workflows/${encodeURIComponent(id)}`);
    if (!response.ok) {
      await response.body?.cancel();
      current.cancellation = { ...current.cancellation, state: pending ? "uncertain" : "rejected", updatedAt: new Date().toISOString(), message: response.status === 404 ? "Civitai no longer exposes this workflow. Cancellation is not confirmed; no new cancellation was sent." : response.status === 401 || response.status === 403 ? "Civitai denied the status read. Restore workflow-read permission, then reconcile; no new cancellation was sent." : response.status === 429 ? "Civitai rate limited the status read. Wait and reconcile; no new cancellation was sent." : "Workflow status is unavailable. No new cancellation was sent." };
      persist(); return json({ generation: publicGeneration(current) });
    }
    current = mapWorkflow(await readWorkflowResponse(response, id), current);
    persist();
    if (pending || reconcileOnly || !["queued", "running"].includes(current.status)) return json({ generation: publicGeneration(current) });
    if (!connectionCurrent(key)) return errorResponse("unauthenticated", "Your connection changed. No cancellation was sent.", 401);
    current.cancellation = { state: "requesting", requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: "Cancellation requested; awaiting Civitai confirmation. Outputs and costs will follow provider status." };
    persist();
    const canceled = await providerFetch(key, `${ORCHESTRATION}/v2/consumer/workflows/${encodeURIComponent(id)}`, { method: "PUT", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ status: "canceled" }), redirect: "error", signal: AbortSignal.timeout(45000) }, AI_SERVICES_WRITE, () => { assertConnectionCurrent(key); dispatched = true; });
    if (!canceled.ok) {
      await canceled.body?.cancel();
      current.cancellation = { ...current.cancellation, state: "uncertain", updatedAt: new Date().toISOString(), message: canceled.status === 401 || canceled.status === 403 ? "Civitai denied the cancellation request. Reconcile workflow status before another attempt; check key permissions." : canceled.status === 429 ? "Civitai rate limited cancellation. Wait, then reconcile workflow status before another attempt." : "Civitai did not confirm cancellation. Reconcile workflow status before another attempt." };
    } else {
      current = mapWorkflow(await readWorkflowResponse(canceled, id), current);
      if (["queued", "running"].includes(current.status)) current.cancellation = { ...current.cancellation, state: "uncertain", message: "Civitai returned an in-progress workflow after cancellation. Reconcile status before another attempt." };
    }
    persist(); return json({ generation: publicGeneration(current) });
  } catch {
    current.cancellation = { ...current.cancellation, state: dispatched || pending ? "uncertain" : "rejected", updatedAt: new Date().toISOString(), message: dispatched || pending ? "Cancellation outcome is uncertain. Reconcile the existing workflow; Studio will not immediately repeat cancellation." : "Workflow status could not be read. No cancellation was sent. Try again later." };
    persist(); return json({ generation: publicGeneration(current) });
  } finally { activeWorkflowUpdates.delete(lock); }
}
async function refreshGeneration(userId: string, current: Record<string, any>): Promise<Response> {
  current=blockUnsafeLegacyVideo(userId,current);
  if (typeof current.providerWorkflowId !== "string") return json({ generation: publicGeneration(current) });
  const pollKey = `${userId}:${current.providerWorkflowId}`;
  // The same lock serializes polling and cancellation so an older GET cannot
  // overwrite a just-confirmed cancellation or its durable uncertainty state.
  if (activeWorkflowUpdates.has(pollKey) || Date.now() - (statusPollAt.get(pollKey) ?? 0) < 10_000) return json({ generation: publicGeneration(findGeneration(userId, current.id) as any ?? current) });
  activeWorkflowUpdates.add(pollKey); statusPollAt.set(pollKey, Date.now());
  try {
    const key = await resolveBearer(userId);
    current = findGeneration(userId, current.id) as any ?? current;
    const response = await orchestrationRequest(key, `/v2/consumer/workflows/${encodeURIComponent(current.providerWorkflowId)}`);
    if (response.status === 404) {
      await response.body?.cancel();
      if(current.submissionState==='blocked_recovery'){
        const message=`Civitai could not find the saved workflow. This does not prove the legacy request failed or was never charged. Inspect Civitai history or contact support with external ID ${current.legacyRecovery?.externalId}. Studio will not resend it; other previews remain available.`;
        const blocked={...current,error:message,updatedAt:new Date().toISOString(),legacyRecovery:{...current.legacyRecovery,message}};
        const idem=dbIdempotency(userId,current.id);if(idem)saveGeneration(userId,idem,blocked as any);
        return json({generation:publicGeneration(blocked)});
      }
      if (["requesting", "uncertain"].includes(current.cancellation?.state)) return json({ generation: publicGeneration(current) });
      const updated = ["queued", "running"].includes(current.status) ? { ...current, status: "expired", updatedAt: new Date().toISOString(), error: "Civitai no longer has this workflow in its retained history." } : current;
      const idem = dbIdempotency(userId,current.id); if (idem && updated !== current) saveGeneration(userId,idem,updated as any);
      return json({ generation: publicGeneration(updated) });
    }
    if (!response.ok) { await response.body?.cancel(); return generationErrorResponse(response.status === 403 ? "insufficient_scope" : "provider_unavailable", "Civitai could not refresh this workflow. Cancellation is not confirmed by a failed status read.", response.status === 403 ? 403 : 502); }
    const mapped = mapWorkflow(await readWorkflowResponse(response, current.providerWorkflowId), current);
    const updated = current.submissionState==='blocked_recovery'?{...mapped,submissionState:'accepted',legacyRecovery:{...current.legacyRecovery,state:'reconciled',message:'Existing workflow identity and status confirmed with a read-only GET. No workflow was submitted.'}}:mapped;
    const idem = dbIdempotency(userId,current.id); if (idem) saveGeneration(userId,idem,updated as any);
    if (current.cancellation) buzzCache.delete(userId);
    return json({ generation: publicGeneration(updated) });
  } catch { return generationErrorResponse("provider_unavailable", "Civitai could not refresh the workflow right now.", 502); }
  finally { activeWorkflowUpdates.delete(pollKey); }
}

async function syncRecentWorkflowHistory(userId: string, autoCutoff?: string) {
  const tokenScope = connectionStatus(userId)?.grantedScopes;
  if (tokenScope !== null && tokenScope !== undefined && (tokenScope & 16384) === 0) { if (autoCutoff) throw new Error('History scope unavailable'); return; }
  if (Date.now() - (historySyncAt.get(userId) ?? 0) < 60_000) return;
  historySyncAt.set(userId, Date.now());
  const key = await resolveBearer(userId);
  if (!key) return;
  try {
    const existingWorkflowIds = new Set(
      db.query<{ record_json: string }, [string]>("SELECT record_json FROM generations WHERE user_id=?").all(userId)
        .map((row) => (JSON.parse(row.record_json) as { providerWorkflowId?: unknown }).providerWorkflowId)
        .filter((id): id is string => typeof id === "string"),
    );
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    // Civitai only retains recent workflows. Import up to five pages per sync
    // so a user with more than 100 workflows can still reach older results.
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ take: "100", hideMatureContent: "false" });
      if (cursor) params.set("cursor", cursor);
      const response = await orchestrationRequest(key, `/v2/consumer/workflows?${params}`);
      if (!response.ok) { await response.body?.cancel(); throw new Error('History unavailable'); }
      const payload = await boundedPreviewJson(response) as { items?: ProviderWorkflow[]; next?: string | null };
      if (!Array.isArray(payload?.items)) throw new Error('History response invalid');
      assertConnectionCurrent(key);
      for (const workflow of payload.items) {
      if (typeof workflow.id !== "string" || existingWorkflowIds.has(workflow.id)) continue;
      const generationStep = workflow.steps?.find((step) => ["imageGen", "videoGen", "polyGen", "imageUpscaler", "imageBackgroundRemoval", "preprocessImage", "preprocessVideo", "aceStepAudio", "miniMaxMusic3", "videoUpscaler", "videoInterpolation", "transcode", "training"].includes(step["$type"] ?? ""));
      if (!generationStep) continue;
      const providerCreatedAt = typeof (workflow as any).createdAt === 'string' ? (workflow as any).createdAt : null;
      if (autoCutoff && (!providerCreatedAt || !Number.isFinite(Date.parse(providerCreatedAt)) || Date.parse(providerCreatedAt) < Date.parse(autoCutoff))) continue;
      const rawInput = publicMediaMetadata(generationStep.input ?? {}) as Record<string,unknown>;
      // Imported upscales must not expose their source signed URL as parameters.
      const sourceHint = (workflow as any).metadata?.studioMediaSource ?? (workflow as any).metadata?.studioImageSource ?? (workflow as any).metadata?.studioUpscaleSource;
      let sourceParameters = {};
      if ((["imageUpscaler","imageBackgroundRemoval","videoUpscaler","videoInterpolation","transcode"].includes(generationStep["$type"] ?? "") || (generationStep["$type"] === "imageGen" && rawInput.engine === "flux1-kontext") || (generationStep["$type"] === "videoGen" && rawInput.engine === "kling") || (generationStep["$type"] === "polyGen" && rawInput.engine === "fal" && rawInput.model === "meshy" && rawInput.operation === "imageTo3D")) && sourceHint) try { ownedMediaSourceRecord(userId,sourceHint.generationId,sourceHint.outputId,["videoUpscaler","videoInterpolation","transcode"].includes(generationStep["$type"] ?? "") ? "video" : "image"); sourceParameters = { sourceGenerationId:sourceHint.generationId,sourceOutputId:sourceHint.outputId }; } catch { /* Do not invent or trust an unowned source link. */ }
      const providerInput = ["aceStepAudio","miniMaxMusic3"].includes(generationStep["$type"]??"") ? {...rawInput,engine:generationStep["$type"],prompt:rawInput.musicDescription??rawInput.caption??"Generated music"} : generationStep["$type"] === "videoGen" && ["ltx2.3","minimax-h3-comfy","wan"].includes(String(rawInput.engine)) ? Object.fromEntries(Object.entries(rawInput).filter(([name])=>["engine","model","provider","version","operation","prompt","negativePrompt","width","height","duration","steps","guidanceScale","cfgScale","fps","quantity","seed","generateAudio","frameGuideStrength","resolution","audioSetting","aspectRatio"].includes(name))) : ["preprocessImage","preprocessVideo"].includes(generationStep["$type"] ?? "") ? {engine:generationStep["$type"],kind:rawInput.kind,resolution:rawInput.resolution,lowThreshold:rawInput.lowThreshold,highThreshold:rawInput.highThreshold} : generationStep["$type"] === "imageGen" && rawInput.engine === "sdcpp" && rawInput.operation === "createVariant" ? Object.fromEntries(Object.entries(rawInput).filter(([name])=>["engine","ecosystem","operation","model","prompt","negativePrompt","width","height","steps","cfgScale","quantity","seed","strength","loras","vaeModel","outputFormat"].includes(name))) : generationStep["$type"] === "transcode" ? {engine:"transcode",prompt:"Resized / converted video",width:rawInput.width,containerFormat:rawInput.containerFormat,...sourceParameters} : generationStep["$type"] === "polyGen" && rawInput.engine === "fal" && rawInput.model === "meshy" ? {engine:"fal",model:"meshy",version:rawInput.version,operation:rawInput.operation,prompt:rawInput.operation === "imageTo3D" ? "3D model from image" : rawInput.prompt,shouldTexture:rawInput.shouldTexture,targetPolycount:rawInput.targetPolycount,topology:rawInput.topology,symmetryMode:rawInput.symmetryMode,shouldRemesh:rawInput.shouldRemesh,enablePbr:rawInput.enablePbr,enableRigging:rawInput.enableRigging,enableAnimation:rawInput.enableAnimation,seed:rawInput.seed,mode:rawInput.mode,...sourceParameters} : generationStep["$type"] === "videoGen" && rawInput.engine === "kling" ? {engine:"kling",model:rawInput.model,prompt:rawInput.prompt,negativePrompt:rawInput.negativePrompt,duration:rawInput.duration,aspectRatio:rawInput.aspectRatio,mode:rawInput.mode,cfgScale:rawInput.cfgScale,...sourceParameters} : generationStep["$type"] === "imageGen" && rawInput.engine === "flux1-kontext" ? {engine:"flux1-kontext",model:rawInput.model,prompt:rawInput.prompt,quantity:rawInput.quantity,aspectRatio:rawInput.aspectRatio,guidanceScale:rawInput.guidanceScale,seed:rawInput.seed,...sourceParameters} : generationStep["$type"] === "imageUpscaler" ? { engine:"imageUpscaler",numberOfRepeats:rawInput.numberOfRepeats,model:rawInput.model,...sourceParameters } : generationStep["$type"] === "imageBackgroundRemoval" ? { engine:"imageBackgroundRemoval",format:rawInput.format === "webp" ? "webp" : "png",...sourceParameters } : ["videoUpscaler","videoInterpolation","transcode"].includes(generationStep["$type"] ?? "") ? { engine:generationStep["$type"],...(generationStep["$type"] === "videoUpscaler" ? {scaleFactor:rawInput.scaleFactor} : {interpolationFactor:rawInput.interpolationFactor}),...sourceParameters } : rawInput;
      const registeredSources=(workflow as any).metadata?.studioSourceWorkflow?.sources;
      if(Array.isArray(registeredSources)) {
        const sources=registeredSources.slice(0,9).flatMap((item:any)=>{try{return typeof item?.id==='string'?[publicSource(sourceRecord(userId,item.id))]:[]}catch{return []}});
        if(sources.length)(providerInput as Record<string,unknown>).sources=sources;
      }
      const mediaType = workflowMediaType(workflow);
      const createdAt = typeof (workflow as any).createdAt === "string" ? (workflow as any).createdAt : new Date().toISOString();
      const id = `gen_${crypto.randomUUID()}`;
      const record = {
        id, status: providerStatus(workflow.status), provider: "civitai", providerWorkflowId: workflow.id, mediaType,
        createdAt, updatedAt: typeof (workflow as any).updatedAt === "string" ? (workflow as any).updatedAt : createdAt,
        completedAt: providerStatus(workflow.status) === "succeeded" ? ((workflow as any).completedAt ?? (workflow as any).updatedAt ?? createdAt) : null,
        input: {
          prompt: typeof providerInput.prompt === "string" ? providerInput.prompt : "",
          negativePrompt: typeof providerInput.negativePrompt === "string" ? providerInput.negativePrompt : "",
          model: typeof providerInput.model === "string" ? providerInput.model : undefined,
          engine: typeof providerInput.engine === "string" ? providerInput.engine : undefined,
          parameters: providerInput,
        },
        autoSaveEligibleAt: providerCreatedAt, autoOutputsPending: workflowHasUnavailableOutputs(workflow),
        ...(trainingResult(workflow) ? { trainingResult: trainingResult(workflow) } : {}),
        inputFingerprint: `history:${workflow.id}`, outputs: normalizeOutputs(workflow),
        cost: extractCost(workflow, false), error: providerStatus(workflow.status) === "failed" ? "Civitai could not complete this generation." : null,
      };
      try { saveGeneration(userId, `history:${workflow.id}`, record as any); existingWorkflowIds.add(workflow.id); } catch { /* parallel history sync already inserted it */ }
      }
      if (!payload.next || seenCursors.has(payload.next)) break;
      seenCursors.add(payload.next);
      cursor = payload.next;
    }
  } catch { if (autoCutoff) throw new Error('History discovery unavailable'); /* app-owned gallery remains available */ }
}

function dbIdempotency(userId: string, id: string): string | null {
  return db.query<{ idempotency_key: string }, [string, string]>("SELECT idempotency_key FROM generations WHERE user_id=? AND id=?").get(userId, id)?.idempotency_key ?? null;
}

class OriginalMediaFetchError extends Error {
  constructor(readonly category: 'unsafe_target' | 'redirect_limit' | 'invalid_redirect' | 'media_unavailable') { super(category); }
}
const originalMediaHosts = new Set(['orchestration.civitai.com', 'orchestration-new.civitai.com', 'image.civitai.com']);
const nonPublicMediaAddresses = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)
  nonPublicMediaAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)
  nonPublicMediaAddresses.addSubnet(address, prefix, 'ipv6');
const globalMediaIPv6 = new BlockList();
globalMediaIPv6.addSubnet('2000::', 3, 'ipv6');
async function assertPublicMediaHost(host: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let onAbort = () => {};
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); }),
    ]);
    if (!addresses.length || addresses.some(({ address, family }) => family === 4
      ? nonPublicMediaAddresses.check(address, 'ipv4')
      : family !== 6 || !globalMediaIPv6.check(address, 'ipv6') || nonPublicMediaAddresses.check(address, 'ipv6')))
      throw new OriginalMediaFetchError('unsafe_target');
  } finally { signal.removeEventListener('abort', onAbort); }
}
async function fetchOriginalMedia(url: string, key: BearerLease, maxBytes: number): Promise<Response> {
  const signal = AbortSignal.timeout(45_000);
  let target = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (!safeMediaSourceUrl(target, key) || !originalMediaHosts.has(new URL(target).hostname))
      throw new OriginalMediaFetchError('unsafe_target');
    await assertPublicMediaHost(new URL(target).hostname, signal);
    assertConnectionCurrent(key);
    // Never forward provider headers, browser cookies, or a referring signed URL.
    const response = await fetch(target, { method: 'GET', headers: {}, credentials: 'omit', referrer: '', referrerPolicy: 'no-referrer', redirect: 'manual', signal });
    try { assertConnectionCurrent(key); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      assertConnectionCurrent(key);
      if (hop === 3) throw new OriginalMediaFetchError('redirect_limit');
      if (!location) throw new OriginalMediaFetchError('invalid_redirect');
      try { target = new URL(location, target).href; } catch { throw new OriginalMediaFetchError('invalid_redirect'); }
      continue;
    }
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new OriginalMediaFetchError('media_unavailable');
    }
    return response; // The shared signal and proxyMedia bound body time and bytes.
  }
  throw new OriginalMediaFetchError('redirect_limit');
}

async function outputContent(userId: string, generation: Record<string, any>, outputId: string, maxBytes = 500 * 1024 * 1024): Promise<Response> {
  const ownedOutput = Array.isArray(generation.outputs) ? generation.outputs.find((output: any) => output.id === outputId) : null;
  if (!ownedOutput) return errorResponse("not_found", "Output not found.", 404);
  if(ownedOutput.kind==='audio')maxBytes=Math.min(maxBytes,100*1024*1024);
  const key = await resolveBearer(userId);
  if (!key) return errorResponse("civitai_not_connected", "Reconnect your Civitai API key to download this output.", 403);
  const workflowId = generation.providerWorkflowId;
  if (typeof workflowId !== "string") return errorResponse("not_found", "Output is no longer available from Civitai.", 404);

  try {
    if (generation.mediaType === 'training') {
      const stored = findGeneration(userId, generation.id) as any;
      if (!stored || stored.providerWorkflowId !== workflowId || !stored.outputs?.some((o: any) => o.id === outputId)) return errorResponse('not_found','Training output not found.',404);
      const response = await orchestrationRequest(key, `/v2/consumer/workflows/${encodeURIComponent(workflowId)}`);
      if (!response.ok) { await response.body?.cancel(); return errorResponse('provider_unavailable','Training result is unavailable.',502); }
      const workflow = await readWorkflowResponse(response,workflowId);
      assertConnectionCurrent(key);
      const available = normalizeOutputs(workflow).find(item => item.id === outputId && item.kind === ownedOutput.kind && ['checkpoint','training-sample'].includes(item.role) && item.metadata.available === true);
      if (!available || !safeMediaSourceUrl(available.url,key)) return errorResponse('not_found','This training artifact is not currently available.',404);
      const artifactLimit = available.kind === 'checkpoint' ? 1024 * 1024 * 1024 : 500 * 1024 * 1024;
      // Default standalone downloads allow 1 GiB checkpoints; explicit ZIP budgets remain smaller.
      const effectiveLimit = available.kind === 'checkpoint' && maxBytes === 500 * 1024 * 1024 ? artifactLimit : Math.min(maxBytes,artifactLimit);
      return proxyMedia(await fetchOriginalMedia(available.url,key,effectiveLimit), available, effectiveLimit);
    }
    // Resolve the owned blob by ID; never accept a browser-supplied media URL.
    let fresh: string | null = null;
    let mediaOutput = ownedOutput;
    const kind = ownedOutput.kind;
    const originalMedia = (kind === 'image' || kind === 'video' || kind === 'model3d' || kind === 'audio')
      && ownedOutput.role !== 'thumbnail';
    if (originalMedia) {
      // GetBlob is documented as a 308. Authenticate only GetWorkflow, resolve
      // this account's exact output ID/kind, then fetch its signed URL without a bearer.
      const resolved = await freshMediaSource(userId, key, generation.id, outputId, kind, true);
      fresh = resolved.url;
      mediaOutput = resolved.output;
    }
    if (!fresh) {
      const blobResponse = await orchestrationRequest(key, `/v2/consumer/blobs/${encodeURIComponent(outputId)}`);
      if (blobResponse.ok) {
        const type = blobResponse.headers.get("content-type") ?? "";
        if (!type.includes("application/json")) return proxyMedia(blobResponse, ownedOutput, maxBytes);
        const blob = await blobResponse.json() as { url?: unknown; blob?: { url?: unknown } };
        const candidate = blob.url ?? blob.blob?.url;
        if (typeof candidate === "string" && safeProviderMediaUrl(candidate)) fresh = candidate;
      }
      if (!fresh) {
        const workflowResponse = await orchestrationRequest(key, `/v2/consumer/workflows/${encodeURIComponent(workflowId)}`);
        if (!workflowResponse.ok) return errorResponse("provider_unavailable", "Civitai could not refresh this output URL.", 502);
        const workflow = await workflowResponse.json() as ProviderWorkflow;
        fresh = normalizeOutputs(workflow).find((output) => output.id === outputId)?.url ?? null;
      }
    }
    if (!fresh || !safeProviderMediaUrl(fresh)) return errorResponse("provider_unavailable", "Civitai did not return a safe, fresh URL for this output.", 502);
    assertConnectionCurrent(key);
    const media = originalMedia ? await fetchOriginalMedia(fresh, key, maxBytes)
      : await fetch(fresh, { signal: AbortSignal.timeout(45_000), redirect: "error" });
    assertConnectionCurrent(key);
    if (!media.ok) return errorResponse("provider_unavailable", "The generated output could not be downloaded from Civitai.", 502);
    return proxyMedia(media, mediaOutput, maxBytes);
  } catch (error) {
    if (error instanceof ConnectionError) return errorResponse("civitai_not_connected", error.message, 403);
    if (error instanceof OriginalMediaFetchError) {
      const response = errorResponse("provider_unavailable", "Original media fetch failed safety or availability checks.", 502);
      response.headers.set('X-Studio-Media-Failure', error.category);
      return response;
    }
    return errorResponse("provider_unavailable", "The generated output could not be downloaded from Civitai.", 502);
  }
}

async function proxyMedia(upstream: Response, output: Record<string, any>, maxBytes: number): Promise<Response> {
  const received = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "application/octet-stream";
  const mime = received === "application/octet-stream" && typeof output.mimeType === "string" ? output.mimeType : received;
  const kind = output.kind ?? "image";
  const safeType = kind === "image" ? (/^image\/(png|jpeg|webp|gif|avif)$/.test(mime) || mime === "application/octet-stream")
    : kind === 'audio' ? /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|flac|x-flac|aac|mp4|webm)$/.test(mime)
    : kind === "video" ? (mime.startsWith("video/") || mime === "application/octet-stream")
      : kind === "checkpoint" ? ["application/octet-stream","application/x-safetensors"].includes(mime) : kind === "model3d" && (mime.startsWith("model/") || ["application/octet-stream", "application/x-fbx", "application/zip"].includes(mime));
  if (!safeType) return errorResponse("provider_unavailable", "Civitai returned an unexpected media format.", 502);
  const declaredSize = Number(upstream.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes) return errorResponse("provider_unavailable", "This output exceeds the download size limit.", 413);
  const reader = upstream.body?.getReader();
  if (!reader) return errorResponse("provider_unavailable", "Civitai returned an empty output.", 502);
  const headers = new Headers({
    "Content-Type": mime,
    "Content-Disposition": `${kind==='audio'?'inline':'attachment'}; filename="${safeFilename(output.id, mime, output.metadata?.format)}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (declaredSize > 0) headers.set("Content-Length", String(declaredSize));
  if (maxBytes > 150 * 1024 * 1024) {
    let size = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          size += value.byteLength;
          if (size > maxBytes) { await reader.cancel(); controller.error(new Error("Download size limit exceeded")); return; }
          controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      cancel() { void reader.cancel(); },
    });
    return new Response(stream, { headers });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); return errorResponse("provider_unavailable", "This output exceeds the download size limit.", 413); }
    chunks.push(value);
  }
  const bytes = concatBytes(chunks);
  headers.set("Content-Length", String(size));
  return new Response(bytes, { headers });
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (url.pathname === '/api/studio/v1/desktop-appearance') {
    if (request.method === 'GET') return json(desktopAppearance?.read() ?? { desktop: false, accentColor: null, revision: null });
    if (!desktopAppearance) return errorResponse('unsupported_action', 'Desktop appearance belongs to the installed app.', 409);
    if (request.method !== 'PATCH') return errorResponse('unsupported_action', 'Unsupported appearance action.', 405);
    if (!validCsrf(request)) return errorResponse('invalid_input', 'Refresh Studio before saving an accent color.', 403);
    const body = await readBody(request, 512);
    if (!body || Object.keys(body).length !== 2 || !Object.keys(body).every(key => ['accentColor', 'revision'].includes(key))) return errorResponse('invalid_input', 'Choose a valid accent color.', 400);
    try { return json(desktopAppearance.write(body.accentColor, body.revision)); }
    catch (error) { if (error instanceof DesktopAppearanceError) return errorResponse('invalid_input', error.message, error.status); throw error; }
  }
  if (url.pathname === '/api/studio/v1/desktop-updates') {
    const updater = desktop ? desktopUpdater() : null;
    if (request.method === 'GET') return json(updater?.snapshot() ?? browserUpdateSnapshot());
    if (request.method !== 'POST') return errorResponse('unsupported_action', 'Unsupported update action.', 405);
    if (!updater) return errorResponse('unsupported_action', 'App updates are managed by the installed desktop app.', 409);
    if (!validCsrf(request)) return errorResponse('invalid_input', 'Refresh Studio before changing an update.', 403);
    const body = await readBody(request, 512);
    if (!body || Object.keys(body).length !== 1 || typeof body.action !== 'string' || !['check', 'download', 'cancel', 'apply'].includes(body.action)) return errorResponse('invalid_input', 'Choose a supported update action.', 400);
    try { await updater.action(body.action as DesktopUpdateAction); return json(updater.snapshot()); }
    catch (error) { return errorResponse('unsupported_action', error instanceof Error ? error.message : 'The update action could not be completed.', 409); }
  }
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/studio/v1/local-storage' || path === '/api/studio/v1/local-storage/saves' || path === '/api/studio/v1/local-storage/auto-save' || path === '/api/studio/v1/local-storage/retry') {
    // Host/origin/peer checks apply to reads too: never disclose server paths to
    // rebinding origins, proxies, public deployments or unauthenticated callers.
    const localRequest = localStorageEnabled && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIpFor(request))
      && url.origin === publicBase.origin && request.headers.get('host') === publicBase.host
      && (!request.headers.get('origin') || validOrigin(request))
      && !['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site') ?? '');
    if (!localRequest) return method === 'GET' ? json({ enabled: false }) : errorResponse('unsupported_action', 'Local folder saving is unavailable on this server.', 403);
    const user = getCurrentUser(request);
    if (!user || request.headers.get('X-Studio-Account') !== user.id) return errorResponse('unauthenticated', 'Connect the active account first.', 401);
    if (method === 'GET') return json({ ...localSettings(user.id), ...autoSettings(user.id) });
    if (!validCsrf(request)) return errorResponse('invalid_input', 'Refresh before changing local storage.', 403);
    const body = await readBody(request);
    if (!body) return errorResponse('invalid_input', 'Request body must be a JSON object.', 400);
    if (path.endsWith('/auto-save') && method === 'PUT') {
      if (typeof body.enabled !== 'boolean') return errorResponse('invalid_input','Choose whether auto-save is enabled.',400);
      setAutoSave(user.id, body.enabled);
      return json({ ...localSettings(user.id), ...autoSettings(user.id) });
    }
    if (path.endsWith('/retry') && method === 'POST') {
      try { retryAutoSave(user.id, body.generationId); return json({ ...localSettings(user.id), ...autoSettings(user.id) }); }
      catch (error) { return errorResponse('invalid_input',error instanceof Error ? error.message : 'Could not retry.',409); }
    }
    const lease = await resolveBearer(user.id);
    if (path.endsWith('/saves') && method === 'POST') {
      // Build the same account-owned manifest used by browser folder exports.
      const manifest = await createDownload(user.id, { outputIds: body.outputIds, mode: 'files', dateBasis: 'utc' });
      if (!manifest.ok) return manifest;
      const result = await manifest.json() as { download: { items: DownloadItem[] } };
      for (const item of result.download.items) {
        const found = ownedOutput(user.id, item.outputId);
        if (!found || found.output.role === 'thumbnail' || (found.generation.mediaType === 'training' && found.output.metadata?.available !== true)) return errorResponse('invalid_input', 'Select originals or available LoRA artifacts.', 400);
      }
      assertConnectionCurrent(lease);
      try {
        const job = startLocalSave(user.id, result.download.items, async item => {
          assertConnectionCurrent(lease);
          const found = ownedOutput(user.id, item.outputId);
          if (!found) return errorResponse('not_found', 'Output not found.', 404);
          return outputContent(user.id, found.generation, item.outputId);
        }, () => assertConnectionCurrent(lease));
        return json({ job }, 202);
      } catch (error) { return errorResponse('invalid_input', error instanceof Error ? error.message : 'Folder save could not start.', 409); }
    }
    if (path === '/api/studio/v1/local-storage' && method === 'PUT') {
      assertConnectionCurrent(lease);
      try {
        const configured = configureLocalDestination(user.id, body.path);
        destinationActivated(user.id);
        return json({ ...configured, ...autoSettings(user.id) });
      }
      catch (error) { return errorResponse('invalid_input', error instanceof Error ? error.message : 'The destination could not be saved.', 400); }
    }
    return errorResponse('unsupported_action', 'Unsupported storage action.', 405);
  }

  if ((path === "/healthz" || path === "/api/health") && method === "GET") return json({ ok: true });

  if (path === "/api/studio/v1/session" && method === "GET") {
    const csrf = cookieValue(request, csrfCookie) ?? randomBytes(32).toString("base64url");
    const user = getCurrentUser(request);
    const connection = user ? connectionStatus(user.id) : null;
    const connected = !!connection;
    const response = json({ connected, user: user ? { id: user.id, displayName: user.displayName } : null, csrfToken: csrf, oauth: oauthAvailability(), credentialStorage, credential: connection ? {kind:connection.kind,grantedScopes:connection.grantedScopes,status:connection.status} : null });
    if (!cookieValue(request, csrfCookie)) response.headers.append("Set-Cookie", `${csrfCookie}=${csrf}${cookieCommon}; Max-Age=${csrfMaxAge}`);
    return response;
  }

  const oauthRedirect = (code?: string) => {
    const response=new Response(null,{status:303,headers:{Location:code ? `/?connectionError=${code}` : '/', 'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    expireCookie(response,oauthNonceCookie);
    return response;
  };
  if (path === '/api/studio/v1/civitai/oauth/start' && method === 'POST') {
    try {
      const body = await readBody(request);
      if (!validCsrf(request,typeof body?.csrfToken === 'string' ? body.csrfToken : undefined)) return oauthRedirect('invalid_csrf');
      if (!oauthAvailability().enabled) return oauthRedirect('oauth_unavailable');
      if (rateLimited(request)) return oauthRedirect('rate_limited');
      const browserBinding=ensureOAuthBrowser(cookieValue(request,oauthBrowserCookie));
      const browser=browserBinding.token;
      const user=getCurrentUser(request);
      const binding=`${browser}:${user ? cookieValue(request,sessionCookie) : 'anonymous'}`;
      const flow=beginOAuth(binding,user?.id ?? null,browser,user ? connectionStatus(user.id)?.revision ?? null : null);
      const response=withCookie(new Response(null,{status:303,headers:{Location:flow.authorizeUrl,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}}),
        `${oauthNonceCookie}=${flow.cookieNonce}${cookieCommon}; HttpOnly; Max-Age=300`);
      if(browserBinding.created)withCookie(response,`${oauthBrowserCookie}=${browser}${cookieCommon}; HttpOnly; Max-Age=${csrfMaxAge}`);
      return response;
    } catch(error) { return oauthRedirect(error instanceof ConnectionError && error.code==='rate_limited' ? 'rate_limited' : 'oauth_failed'); }
  }
  if (path === OAUTH_CALLBACK) {
    let exchanged: Awaited<ReturnType<typeof exchangeOAuth>> | undefined;
    let installed=false;
    try {
      const callbackUrl=new URL(url);
      // A configured trusted TLS proxy may preserve Host and supply the protocol.
      if(trustProxy && callbackUrl.host===publicBase.host && request.headers.get('x-forwarded-proto')===publicBase.protocol.slice(0,-1))callbackUrl.protocol=publicBase.protocol;
      if(method!=='GET' || !oauthCallbackMatches(callbackUrl))throw new ConnectionError('flow_invalid');
      const browser=cookieValue(request,oauthBrowserCookie),nonce=cookieValue(request,oauthNonceCookie);
      const user=getCurrentUser(request),account=user?.id ?? null,sessionToken=user ? cookieValue(request,sessionCookie) : undefined;
      if(!browser || !nonce || !oauthBrowserCurrent(browser) || url.searchParams.getAll('state').length!==1)throw new ConnectionError('flow_invalid');
      const flow=consumeOAuth(url.searchParams.get('state')!,nonce,`${browser}:${sessionToken ?? 'anonymous'}`,account);
      const stillCurrent=()=>oauthBrowserCurrent(browser,flow.browserEpoch) && flow.expiresAt>Date.now() &&
        (getCurrentUser(request)?.id ?? null)===account && (!account || connectionStatus(account)?.revision===flow.expectedRevision);
      if(!stillCurrent())throw new ConnectionError('connection_changed');
      if(url.searchParams.has('error'))return oauthRedirect('oauth_denied');
      if(url.searchParams.getAll('code').length!==1)throw new ConnectionError('flow_invalid');
      exchanged=await exchangeOAuth(url.searchParams.get('code')!,flow.verifier,account);
      const identity=exchanged;
      const session=db.transaction(()=>{
        if(!stillCurrent() || lastConnectionChange(identity.accountId)>flow.startClock)throw new ConnectionError('connection_changed');
        const expectedRevision=account ? flow.expectedRevision : connectionStatus(identity.accountId)?.revision ?? null;
        upsertUser(identity.accountId,identity.displayName);
        installOAuth(identity.accountId,identity.tokens,expectedRevision);
        db.query('DELETE FROM sessions WHERE user_id=?').run(identity.accountId);
        removeSession(cookieValue(request,sessionCookie));
        invalidateOAuthBrowser(browser);
        db.query('DELETE FROM oauth_pending WHERE account_id=?').run(identity.accountId);
        return createSession(identity.accountId);
      }).immediate();
      installed=true;
      buzzCache.delete(identity.accountId);
      const response=oauthRedirect();
      withCookie(response,sessionCookieValue(session.token,session.expiresAt));
      withCookie(response,`${csrfCookie}=${randomBytes(32).toString('base64url')}${cookieCommon}; Max-Age=${csrfMaxAge}`);
      expireCookie(response,oauthBrowserCookie);
      return response;
    } catch(error) {
      if(exchanged && !installed)await revokeToken(exchanged.tokens.refreshToken);
      return oauthRedirect(error instanceof ConnectionError && error.code==='rate_limited' ? 'rate_limited' : error instanceof ConnectionError && ['flow_invalid','connection_changed'].includes(error.code) ? 'oauth_expired' : 'oauth_failed');
    }
  }

  if ((path === "/api/studio/v1/civitai/connect" || path === "/api/studio/v1/civitai/key") && method === "POST") {
    const body = await readBody(request);
    if (!validCsrf(request, typeof body?.csrfToken === "string" ? body.csrfToken : undefined)) {
      return connectionError(request, "invalid_csrf", "The request could not be verified. Refresh the page and try again.", 403);
    }
    if (rateLimited(request)) return connectionError(request, "rate_limited", "Too many connection attempts. Try again later.", 429);
    const apiKey = body?.apiKey;
    if (typeof apiKey !== "string" || apiKey.length < 8 || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
      return connectionError(request, "invalid_key", "Enter a valid Civitai API key.", 400);
    }
    invalidateOAuthBrowser(cookieValue(request,oauthBrowserCookie));
    let profile: Awaited<ReturnType<typeof validateCivitaiKey>>;
    try { profile = await validateCivitaiKey(apiKey); }
    catch { return connectionError(request, "provider_unavailable", "Civitai could not be reached to validate this key. Try again shortly.", 502); }
    if (!profile) return connectionError(request, "invalid_key", "Civitai did not accept that API key.", 401);

    const user = upsertUser(profile.id, profile.displayName);
    const oldToken = cookieValue(request, sessionCookie);
    removeSession(oldToken);
    const revocation = disconnectOAuth(user.id); // Local deletion is synchronous before its first await.
    storeCredential(user.id, apiKey, profile.tokenScope, profile.buzzLimit);
    void revocation.catch(() => {});
    buzzCache.delete(user.id);
    const session = createSession(user.id);
    const csrf = randomBytes(32).toString("base64url");
    const response = request.headers.get("accept")?.includes("text/html")
      ? new Response(null, { status: 303, headers: { Location: "/" } })
      : json({ connected: true, user: { id: user.id, displayName: user.displayName }, csrfToken: csrf, credentialStorage });
    response.headers.set("Cache-Control", "no-store");
    expireCookie(response,oauthNonceCookie);
    expireCookie(response,oauthBrowserCookie);
    response.headers.append("Set-Cookie", sessionCookieValue(session.token, session.expiresAt));
    // Rotate the CSRF value after establishing the authenticated session.
    response.headers.append("Set-Cookie", `${csrfCookie}=${csrf}${cookieCommon}; Max-Age=${csrfMaxAge}`);
    return response;
  }

  if ((path === "/api/studio/v1/civitai/connection" || path === "/api/studio/v1/civitai/key") && method === "DELETE") {
    if (!validCsrf(request)) return errorResponse("invalid_input", "The request could not be verified. Refresh the page and try again.", 403);
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    invalidateOAuthBrowser(cookieValue(request,oauthBrowserCookie));
    await disconnectOAuth(user.id);
    buzzCache.delete(user.id);
    removeSession(cookieValue(request, sessionCookie));
    const response = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    expireCookie(response,oauthNonceCookie);
    expireCookie(response,oauthBrowserCookie);
    expireCookie(response, sessionCookie);
    expireCookie(response, csrfCookie, false);
    return response;
  }

  if (path === "/api/studio/v1/buzz" && method === "GET") {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    return accountBuzzBalance(user.id);
  }

  if (path === '/api/studio/v1/library' || path.startsWith('/api/studio/v1/library/')) {
    const user = getCurrentUser(request);
    if (!user || request.headers.get('X-Studio-Account') !== user.id) return errorResponse('unauthenticated','Reload the library for the active account.',401);
    const localPath = path.slice('/api/studio/v1/library'.length);
    if (method === 'GET' && !localPath) return json(mediaLibrary.read(user.id));
    if (!['POST','PATCH','PUT','DELETE'].includes(method)) return errorResponse('unsupported_action','Unsupported library action.',405);
    if (!validCsrf(request)) return errorResponse('invalid_input','Refresh before changing library folders.',403);
    const body = await readBody(request,98_304);
    if (getCurrentUser(request)?.id !== user.id || request.headers.get('X-Studio-Account') !== user.id || !validCsrf(request)) return errorResponse('unauthenticated','The active session changed. Reload your library.',401);
    try { return json(mediaLibrary.mutate(user.id,method,localPath,body)); }
    catch(error) { if (error instanceof MediaLibraryError) return errorResponse(error.status === 404 ? 'not_found' : 'invalid_input',error.message,error.status); throw error; }
  }

  if (path.startsWith('/api/studio/v1/prompt-library/')) {
    const user = getCurrentUser(request);
    if (!user || request.headers.get('X-Studio-Account') !== user.id) return errorResponse('unauthenticated','Reload the composer for the active account.',401);
    const match = /^\/api\/studio\/v1\/prompt-library\/(snippets|history)(?:\/((?:snippet|prompt)_[a-f0-9-]{36}))?$/.exec(path);
    if (!match) return errorResponse('not_found','Prompt library route not found.',404);
    const kind = match[1], id = match[2] ?? null;
    if (id && !id.startsWith(kind === 'snippets' ? 'snippet_' : 'prompt_')) return errorResponse('not_found','Prompt item not found.',404);
    if (method === 'GET') {
      if (kind === 'snippets' && !id) return json({items:promptLibrary.snippets(user.id)});
      if (kind === 'history' && !id) return json({items:promptLibrary.history(user.id)});
      if (kind === 'history' && id) { const item=promptLibrary.snapshot(user.id,id); return item?json({item}):errorResponse('not_found','Prompt snapshot not found.',404); }
    }
    if (!validCsrf(request)) return errorResponse('invalid_input','Refresh before changing your prompt library.',403);
    if (method === 'DELETE') {
      if (kind === 'history' && !id) { promptLibrary.clearHistory(user.id); return new Response(null,{status:204}); }
      if (id) { const removed=kind==='snippets'?promptLibrary.deleteSnippet(user.id,id):promptLibrary.deleteHistory(user.id,id); return removed?new Response(null,{status:204}):errorResponse('not_found','Prompt item not found.',404); }
    }
    if ((method === 'POST' && !id) || (method === 'PUT' && id && kind === 'snippets')) {
      const body=await readBody(request,98_304);
      if (getCurrentUser(request)?.id !== user.id) return errorResponse('unauthenticated','The active account changed. Reload the composer.',401);
      try {
        const item=kind==='snippets'?promptLibrary.saveSnippet(user.id,id,body):promptLibrary.checkpoint(user.id,body);
        return item?json({item},id?200:201):errorResponse('not_found','Prompt preset not found.',404);
      } catch(error) { if(error instanceof PromptLibraryError)return errorResponse('invalid_input',error.message,400); throw error; }
    }
    return new Response(null,{status:405,headers:{Allow:'GET, POST, PUT, DELETE'}});
  }

  if ((path === "/api/studio/v1/presets" || /^\/api\/studio\/v1\/presets\/preset_[a-f0-9-]{36}$/.test(path))) {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your account first.", 401);
    // Bind UI requests to the account that opened the composer, even after a cross-tab switch.
    if (request.headers.get("X-Studio-Account") !== user.id) return errorResponse("unauthenticated", "The active account changed. Reload the composer.", 401);
    const id = path === "/api/studio/v1/presets" ? null : path.split("/").at(-1)!;
    if (method === "GET" && !id) return json({ items: listPresets(user.id) });
    if (!validCsrf(request)) return errorResponse("invalid_input", "Refresh the page before changing presets.", 403);
    if (method === "DELETE" && id) return deletePreset(user.id, id) ? new Response(null, { status: 204 }) : errorResponse("not_found", "Preset not found.", 404);
    if ((method === "POST" && !id) || (method === "PUT" && id)) {
      const body = await readBody(request, 65536);
      const problem = configError(body?.config);
      if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80 || problem) return errorResponse("invalid_input", problem ?? "Use a preset name of 1-80 characters.", 400);
      if (!id && listPresets(user.id).length >= 100) return errorResponse("invalid_input", "You can keep up to 100 user presets.", 400);
      const preset = writePreset(user.id, id, body.name.trim(), body.config as ComposerConfig);
      return preset ? json({ preset }, id ? 200 : 201) : errorResponse("not_found", "Preset not found.", 404);
    }
    return errorResponse("unsupported_action", "Unsupported preset action.", 405);
  }

  if (path === '/api/studio/v1/image-sources' || path === '/api/studio/v1/image-sources/uploads') {
    const user = getCurrentUser(request);
    const sessionCurrent = () => !!user && getCurrentUser(request)?.id === user.id && request.headers.get('X-Studio-Account') === user.id && validCsrf(request);
    if (!user || request.headers.get('X-Studio-Account') !== user.id) return errorResponse('unauthenticated','The active account changed.',401);
    if (method === 'GET' && path.endsWith('/image-sources')) return json(listImageSources(user.id));
    if (method !== 'POST' || !sessionCurrent()) return errorResponse('invalid_input','Refresh before selecting or uploading a source.',403);
    try {
      if (path.endsWith('/uploads')) {
        const key = await resolveBearer(user.id,{requiredScopes:32768,service:'orchestration'});
        const source = await uploadImageSource(request,key,sessionCurrent);
        if (!sessionCurrent()) return errorResponse('unauthenticated','The active session changed during upload.',401);
        return json({source});
      }
      const body = await readBody(request,2048);
      if (!body || Object.keys(body).some(name=>!['generationId','outputId'].includes(name)) || typeof body.generationId!=='string' || typeof body.outputId!=='string') return errorResponse('invalid_input','Choose an owned gallery image.',400);
      if (!sessionCurrent()) return errorResponse('unauthenticated','The active session changed.',401);
      return json({source:registerGallerySource(user.id,body.generationId,body.outputId)});
    } catch(error) { return errorResponse('invalid_input',error instanceof Error ? error.message : 'Image source is unavailable.',400); }
  }

  if (path === '/api/studio/v1/browsing-preference') {
    const user = getCurrentUser(request);
    if (!user || request.headers.get('X-Studio-Account') !== user.id) return errorResponse('unauthenticated','The active account changed. Reload Settings.',401);
    if (method === 'GET') return json(getBrowsingPreference(user.id));
    if (method !== 'PUT') return errorResponse('unsupported_action','Unsupported browsing preference action.',405);
    if (!validCsrf(request)) return errorResponse('invalid_input','Refresh before changing browsing preferences.',403);
    const body = await readBody(request,1024);
    if (!body || Object.keys(body).some(name => name !== 'mode') || typeof body.mode !== 'string' || !['safe','pg13','mature'].includes(body.mode)) return errorResponse('invalid_input','Choose Safe, Include PG-13 or Include mature.',400);
    const currentUser = getCurrentUser(request);
    if (!currentUser || currentUser.id !== user.id || request.headers.get('X-Studio-Account') !== currentUser.id) return errorResponse('unauthenticated','The active account changed. Reload Settings.',401);
    if (!validCsrf(request)) return errorResponse('invalid_input','Refresh before changing browsing preferences.',403);
    return json(setBrowsingPreference(user.id,body.mode));
  }

  if (path === '/api/studio/v1/generation-services' && method === 'GET') {
    const user = getCurrentUser(request);
    if (!user || request.headers.get('X-Studio-Account') !== user.id) return errorResponse('unauthenticated','Connect your account to refresh generation models.',401);
    const preference = getBrowsingPreference(user.id);
    if (request.headers.get('X-Studio-Browsing') !== preference.revision) return errorResponse('browsing_changed','Browsing preferences changed. Refresh Settings first.',409);
    if ([...url.searchParams.keys()].some(key=>key!=='refresh') || url.searchParams.has('refresh') && url.searchParams.get('refresh')!=='true') return errorResponse('invalid_input','Invalid model refresh option.',400);
    try {
      const connection = connectionStatus(user.id);
      if(!connection || connection.status==='reconnect_required')return errorResponse('civitai_not_connected','Connect Civitai to refresh generation models.',403);
      const result = await withDiscoveryLimit(user.id,()=>listGenerationServices(JSON.stringify([user.id,connection.revision,preference.revision]),url.searchParams.get('refresh')==='true',request.signal));
      if (getCurrentUser(request)?.id !== user.id || connectionStatus(user.id)?.revision !== connection.revision || getBrowsingPreference(user.id).revision !== preference.revision) return errorResponse('browsing_changed','Your account or browsing preference changed. Refresh models again.',409);
      return json(result);
    } catch(error) { return errorResponse('provider_unavailable',error instanceof SiteError || error instanceof GenerationDiscoveryError ? error.message : 'Generation models could not be loaded. Check your connection.',error instanceof SiteError || error instanceof GenerationDiscoveryError ? error.status : 503); }
  }

  const favoriteMatch=/^\/api\/studio\/v1\/models\/(\d+)\/favorite$/.exec(path);
  if(favoriteMatch) {
    const user=getCurrentUser(request),modelId=Number(favoriteMatch[1]);
    if(!user || request.headers.get('X-Studio-Account')!==user.id)return errorResponse('unauthenticated','The active account changed. Reopen the model browser.',401);
    if(!positiveId(modelId))return errorResponse('invalid_input','Choose a valid model ID.',400);
    if(method!=='GET'&&!validCsrf(request))return errorResponse('invalid_input','Refresh before changing favorites.',403);
    return favoriteApi(request,user.id,modelId,readBody);
  }

  if ((path === "/api/studio/v1/artworks" || path === "/api/studio/v1/models" || /^\/api\/studio\/v1\/(models|model-versions)\/\d+$/.test(path)) && method === "GET") {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your account first.", 401);
    if (request.headers.get("X-Studio-Account") !== user.id) return errorResponse("unauthenticated", "The active account changed. Reload the composer.", 401);
    const preference = getBrowsingPreference(user.id);
    if (request.headers.get('X-Studio-Browsing') !== preference.revision) return errorResponse('browsing_changed','Browsing preferences changed. Reopen the browser after Settings refreshes.',409);
    if (url.searchParams.has('browsingLevel') || url.searchParams.has('nsfw')) return errorResponse('invalid_input','Use Settings to choose a supported browsing preference.',400);
    const key = await resolveBearer(user.id);
    if (!key) return errorResponse("civitai_not_connected", "Connect a Civitai key to browse models.", 403);
    try {
      const result = await withDiscoveryLimit(user.id, async () => {
      if (path === "/api/studio/v1/artworks") return json(await listArtworks(key, url.searchParams, preference));
      if (path !== "/api/studio/v1/models" && !positiveId(Number(path.split("/").at(-1)))) return errorResponse("invalid_input", "Invalid model or version ID.", 400);
      if (path.startsWith("/api/studio/v1/model-versions/")) return json(await resolveModelVersion(key, Number(path.split("/").at(-1)), preference.mode));
      if (path !== "/api/studio/v1/models") {
        const model = publicModel(await siteJson(key, `models/${path.split("/").at(-1)}`),preference.mode);
        if (!model) throw new SiteError('This model is unavailable under your browsing preference. Review Settings → Browsing.',404);
        return json({ model });
      }
      const query = url.searchParams.get("query")?.trim() ?? "";
      const cursor = url.searchParams.get("cursor") ?? "";
      const type = url.searchParams.get("type") ?? "";
      const baseModel = url.searchParams.get("baseModel") ?? "";
      const sort = url.searchParams.get("sort") ?? "Highest Rated";
      const supportsGeneration=url.searchParams.get('supportsGeneration');
      if(supportsGeneration!==null&&!['true','false'].includes(supportsGeneration))return errorResponse('invalid_input','Invalid generation coverage filter.',400);
      const favorites=url.searchParams.get("favorites");
      if(favorites!==null && !["true","false"].includes(favorites))return errorResponse("invalid_input","Invalid favorites filter.",400);
      if (query.length > 100 || cursor.length > 1000 || baseModel.length > 100 || !["Highest Rated", "Most Downloaded", "Newest"].includes(sort) || (type && !["Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion", "VAE", "Controlnet", "Upscaler", "Other"].includes(type))) return errorResponse("invalid_input", "Invalid model browsing filters.", 400);
      const params = new URLSearchParams({ limit: "20", sort, nsfw: preference.mode === 'safe' ? 'false' : 'true', primaryFileOnly: "true" });
      if(supportsGeneration==='true')params.set('supportsGeneration','true');
      if(favorites==="true")params.set("favorites","true");
      if (query) params.set("query", query);
      if (cursor) params.set("cursor", cursor);
      if (type) params.set("types", type);
      if (baseModel) params.set("baseModels", baseModel);
      const payload = await siteJson(key, `models?${params}`);
      return json({ items: (Array.isArray(payload.items) ? payload.items : []).slice(0, 20).map((item: any) => publicModel(item,preference.mode)).filter(Boolean), nextCursor: typeof payload.metadata?.nextCursor === "string" && payload.metadata.nextCursor.length <= 1000 ? payload.metadata.nextCursor : null });
      });
      if (getBrowsingPreference(user.id).revision !== preference.revision) return errorResponse('browsing_changed','Browsing preferences changed during this request. Reopen the browser.',409);
      assertConnectionCurrent(key);
      return result;
    } catch (error) {
      return errorResponse(error instanceof SiteError && error.status === 400 ? "invalid_input" : error instanceof SiteError && error.status === 404 ? "not_found" : error instanceof SiteError && error.status === 429 ? "provider_rate_limited" : "provider_unavailable", error instanceof SiteError ? error.message : "Civitai model information is unavailable.", error instanceof SiteError ? error.status : 502);
    }
  }

  if (/^\/api\/studio\/v1\/generation-previews\/quote_[a-f0-9-]{36}$/.test(path) && method === "DELETE") {
    const user = getCurrentUser(request);
    if (!user || request.headers.get("X-Studio-Account") !== user.id) return errorResponse("unauthenticated", "The active account changed.", 401);
    if (!validCsrf(request)) return errorResponse("invalid_input", "Refresh before changing a preview.", 403);
    const id = path.split("/").at(-1)!;
    if (getQuote(user.id, id)) discardQuote(id);
    return new Response(null, { status: 204 });
  }

  if(path==='/api/studio/v1/draft-availability' && method==='POST') {
    const user=getCurrentUser(request);
    if(!user||request.headers.get('X-Studio-Account')!==user.id)return errorResponse('unauthenticated','The active account changed.',401);
    if(!validCsrf(request))return errorResponse('invalid_input','Refresh before checking Draft availability.',403);
    const body=await readBody(request);
    if(!body||Object.keys(body).some(k=>k!=='input')||!body.input||typeof body.input!=='object'||Array.isArray(body.input))return errorResponse('invalid_input','A Draft image input is required.',400);
    const key=await generationAccess(user.id);if(key instanceof Response)return key;
    try {const profile=await withDiscoveryLimit(user.id,()=>checkDraftResources(key,body.input as Record<string,unknown>));assertConnectionCurrent(key);return json({available:true,acceleratorAir:profile.acceleratorAir})}
    catch(error){return json({available:false,reason:error instanceof SiteError?'Draft resource availability could not be confirmed. Retry or use Create Image.':error instanceof Error?error.message:'Draft unavailable.'})}
  }
  if (["/api/studio/v1/generation-previews", "/api/studio/v1/generations"].includes(path) && method === "POST") {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    if (!validCsrf(request)) return errorResponse("invalid_input", "Refresh the page before previewing or generating.", 403);
    if (request.headers.get("X-Studio-Account") !== user.id) return errorResponse("unauthenticated", "The active account changed. Refresh the composer.", 401);
    const body = await readBody(request);
    if (!body) return errorResponse("invalid_input", "Request body must be a JSON object.", 400);
    if (path.endsWith("generation-previews")) return previewGeneration(user.id, body);
    if (Object.keys(body).some(field => field !== "previewId") || typeof body.previewId !== "string") return errorResponse("preview_required", "Generate accepts only a reviewed preview ID. Request a preview first.", 409);
    return confirmGeneration(user.id, body.previewId);
  }

  if (path === "/api/studio/v1/generations" && method === "GET") {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    await syncRecentWorkflowHistory(user.id);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50) || 50));
    const cursor = url.searchParams.get("cursor");
    let before: { createdAt: string; id: string } | undefined;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
        if (typeof parsed.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(parsed.createdAt) || typeof parsed.id !== "string" || !/^gen_[a-f0-9-]{36}$/.test(parsed.id)) throw new Error();
        before = { createdAt: parsed.createdAt, id: parsed.id };
      }
      catch { return errorResponse("invalid_input", "Invalid generation cursor.", 400); }
    }
    unresolvedSubmission(user.id); // Quarantine unsafe legacy approvals without submitting provider work.
    const page = listGenerations(user.id, limit, before);
    const pollable = page.items.filter((item: any) => ["queued", "running"].includes(item.status) && typeof item.providerWorkflowId === "string").slice(0, 8);
    const refreshed = await Promise.all(pollable.map(async (item: any) => {
      const response = await refreshGeneration(user.id, item);
      if (!response.ok) return item;
      try { return (await response.json() as { generation: any }).generation; } catch { return item; }
    }));
    const refreshedById = new Map(refreshed.map((item: any) => [item.id, item]));
    const visibleItems = page.items.map((item: any) => publicGeneration(refreshedById.get(item.id) ?? item));
    const last = page.items.at(-1) as { createdAt?: string; id?: string } | undefined;
    const nextCursor = page.hasMore && last?.createdAt && last.id ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null;
    return json({ items: visibleItems, nextCursor });
  }

  if (/^\/api\/studio\/v1\/generations\/[^/]+\/cancel$/.test(path) && method === "POST") {
    const user = getCurrentUser(request);
    if (!user || request.headers.get("X-Studio-Account") !== user.id) return errorResponse("unauthenticated", "The active account changed. Reload before canceling.", 401);
    if (!validCsrf(request)) return errorResponse("invalid_input", "Refresh before canceling a workflow.", 403);
    const body = await readBody(request);
    if (!body || !["cancel", "reconcile"].includes(String(body.action)) || Object.keys(body).some(key => key !== "action")) return errorResponse("invalid_input", "Choose cancel or reconcile; workflow IDs come only from saved records.", 400);
    return cancelGeneration(user.id, decodeURIComponent(path.split("/")[5] ?? ""), body.action === "reconcile");
  }

  if (/^\/api\/studio\/v1\/generations\/[^/]+\/retry$/.test(path) && method === "POST") {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    if (!validCsrf(request)) return errorResponse("invalid_input", "The request could not be verified. Refresh the page and try again.", 403);
    if (request.headers.get("X-Studio-Account") !== user.id) return errorResponse("unauthenticated", "The active account changed. Reload before recovering this generation.", 401);
    const id = decodeURIComponent(path.split("/")[5] ?? "");
    const found = findGeneration(user.id, id) as any;
    const generation = found?blockUnsafeLegacyVideo(user.id,found):null;
    if (!generation) return errorResponse("not_found", "Generation not found.", 404);
    if(generation.submissionState==='blocked_recovery')return generation.providerWorkflowId?refreshGeneration(user.id,generation):json({generation:publicGeneration(generation)},202);
    if (generation.submissionState !== "uncertain" && generation.submissionState !== "reserved") return json({ generation: publicGeneration(generation) }, 202);
    const idempotencyKey = dbIdempotency(user.id, id);
    if (!idempotencyKey) return errorResponse("not_found", "The original request could not be recovered.", 404);
    return submitApprovedGeneration(user.id, idempotencyKey, null);
  }

  if (path.startsWith("/api/studio/v1/generations/") && method === "GET") {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    const parts = path.split("/");
    const id = decodeURIComponent(parts[5] ?? "");
    const generation = findGeneration(user.id, id) as any;
    if (!generation) return errorResponse("not_found", "Generation not found.", 404);
    if (parts[6] === "outputs" && parts[8] === "content" && method === "GET") {
      return outputContent(user.id, generation, decodeURIComponent(parts[7] ?? ""));
    }
    return refreshGeneration(user.id, generation);
  }

  if (path.startsWith("/api/studio/v1/downloads") && method === "POST") {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    const body = await readBody(request);
    if (!validCsrf(request, typeof body?.csrfToken === "string" ? body.csrfToken : undefined)) return errorResponse("invalid_input", "The request could not be verified. Refresh the page and try again.", 403);
    if (!body) return errorResponse("invalid_input", "Request body must be a JSON object.", 400);
    return createDownload(user.id, body);
  }

  if (path.startsWith("/api/studio/v1/downloads/") && method === "GET") {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    pruneDownloads();
    const parts = path.split("/");
    const download = downloads.get(decodeURIComponent(parts[5] ?? ""));
    if (!download || download.ownerId !== user.id) return errorResponse("not_found", "Download not found.", 404);
    if (parts[6] === "archive") {
      if (!download.archive) return errorResponse("not_found", "Download archive not found.", 404);
      return new Response(download.archive, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="civitai-studio-${download.id}.zip"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return json({ download: { id: decodeURIComponent(parts[5] ?? ""), status: download.status, items: download.items, archiveUrl: download.archiveUrl } });
  }

  if (path.startsWith('/api/studio/v1/training/')) {
    const user=getCurrentUser(request);
    if(!user || request.headers.get('X-Studio-Account')!==user.id)return errorResponse('unauthenticated','Reconnect the active account.',401);
    if(!connectionStatus(user.id))return errorResponse('civitai_not_connected','Connect your Civitai key.',403);
    if(method!=='GET'&&!validCsrf(request))return errorResponse('invalid_input','Refresh before changing training data.',403);
    return trainingApi(request,url,user.id,readBody,await resolveBearer(user.id));
  }
  if (path.startsWith("/api/studio/v1/collections")) {
    const user = getCurrentUser(request);
    if (!user) return errorResponse("unauthenticated", "Connect your Civitai account first.", 401);
    if (request.headers.get("X-Studio-Account") !== user.id) return errorResponse("unauthenticated", "The active account changed. Refresh before using collections.", 401);
    if (!connectionStatus(user.id)) return errorResponse("civitai_not_connected", "Connect your Civitai key before using collections.", 403);
    if (method !== "GET" && !validCsrf(request)) return errorResponse("invalid_input", "Refresh the page before changing collections.", 403);
    return collectionApi(request, url, user.id, { connection: await resolveBearer(user.id), readBody, ownedOutput, outputContent });
  }

  if (path.startsWith("/api/studio/v1/")) {
    return errorResponse("unsupported_action", "This action is not available in the first version.", 501);
  }
  return errorResponse("not_found", "API route not found.", 404);
}

function securityHeaders(response: Response) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (!response.headers.has("Referrer-Policy")) response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("X-Frame-Options", "DENY");
  if (production && !desktop) response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (desktop) response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://image.civitai.com https://images.civitai.com data: blob:; media-src 'self' https://image.civitai.com https://images.civitai.com blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'");
  return response;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (desktop) {
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if (request.headers.get('host') !== publicBase.host || url.origin !== publicBase.origin
      || (origin !== null && origin !== publicBase.origin) || (site && !['same-origin', 'none'].includes(site))
      || cookieValue(request, desktop.gateName) !== desktop.gate) {
      return securityHeaders(new Response('Desktop session required', { status: 403 }));
    }
  }
  let response: Response;
  let releaseUpdateWork: (() => void) | null = null;
  if (desktop && url.pathname.startsWith('/api/') && url.pathname !== '/api/studio/v1/desktop-updates') {
    releaseUpdateWork = updateActivity.begin();
    if (!releaseUpdateWork) return securityHeaders(errorResponse('unsupported_action', 'Studio is restarting to apply an update. Try again after it reopens.', 503));
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
    try {
      if (['/api/studio/v1/desktop-updates', '/api/studio/v1/desktop-appearance'].includes(url.pathname)) response = await handleApi(request, url);
      else {
        const initialUser = getCurrentUser(request), initialConnection = initialUser ? connectionStatus(initialUser.id) : null;
        response = initialUser && initialConnection ? await withAccountConnection(initialUser.id,initialConnection.revision,()=>handleApi(request,url),()=>getCurrentUser(request)?.id === initialUser.id) : await handleApi(request,url);
      }
    }
    catch (error) { if (!(error instanceof ConnectionError)) { releaseUpdateWork?.(); throw error; } response = errorResponse(error.code === 'insufficient_scope' ? 'insufficient_scope' : 'civitai_not_connected',error.message,403); }
  } else if (request.method === "GET" || request.method === "HEAD") {
    let decoded: string;
    try { decoded = decodeURIComponent(url.pathname); }
    catch { return securityHeaders(new Response("Not found", { status: 404 })); }
    const requested = decoded === "/" ? resolve(webRoot, "index.html") : resolve(webRoot, `.${decoded}`);
    if (desktop) {
      const asset = desktop.assets[decoded === '/' ? '/index.html' : decoded] ?? (!decoded.startsWith('/assets/') ? desktop.assets['/index.html'] : undefined);
      const file = asset ? Bun.file(asset) : null;
      response = file ? new Response(request.method === 'HEAD' ? null : file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'Cache-Control': 'no-cache' } }) : new Response('Not found', { status: 404 });
    } else if (requested !== webRoot && !requested.startsWith(`${webRoot}${sep}`)) {
      response = new Response("Not found", { status: 404 });
    } else {
      const candidate = Bun.file(requested);
      const file = await candidate.exists() ? candidate : Bun.file(resolve(webRoot, "index.html"));
      response = await file.exists() ? new Response(request.method === "HEAD" ? null : file, {
        headers: { "Content-Type": file.type || "application/octet-stream", "Cache-Control": "no-cache" },
      }) : new Response("Build the web app first (web/dist/index.html is missing).", { status: 503 });
    }
  } else {
    response = new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  return securityHeaders(holdResponse(response, releaseUpdateWork));
}

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port,
  maxRequestBodySize: 9*1024*1024,
  fetch: handle,
  error(error) {
    // Do not log request data or provider errors; they can include authorization material.
    console.error(`Request failed (${error.name})`);
    return securityHeaders(errorResponse("provider_unavailable", "The server could not complete this request.", 500));
  },
});
clientIpFor = (request) => server.requestIP(request)?.address ?? "local";

if (desktop) {
  publicBase = new URL(`http://127.0.0.1:${server.port}`);
  process.env.PUBLIC_BASE_URL = publicBase.origin;
  console.log(JSON.stringify({ desktopReady: 1, port: server.port }));
} else console.log(`Civitai Studio server listening at ${publicBase.origin}`);

initializeAutoSave({
  enabled: localStorageEnabled,
  manifest: downloadManifestItem,
  content: outputContent,
  history: (userId, cutoff) => syncRecentWorkflowHistory(userId, cutoff),
  async refresh(userId, generation, lease) {
    if (activeWorkflowUpdates.has(`${userId}:${generation.providerWorkflowId}`)) return findGeneration(userId,generation.id);
    const lock = `${userId}:${generation.providerWorkflowId}`;
    activeWorkflowUpdates.add(lock);
    try {
      const response = await orchestrationRequest(lease, `/v2/consumer/workflows/${encodeURIComponent(generation.providerWorkflowId)}`);
      if (!response.ok) { await response.body?.cancel(); throw new Error('Workflow unavailable'); }
      const fresh = await readWorkflowResponse(response,generation.providerWorkflowId);
      assertConnectionCurrent(lease);
      const current = findGeneration(userId,generation.id) as any;
      if (!current || current.providerWorkflowId !== generation.providerWorkflowId) throw new Error('Workflow changed');
      const updated = mapWorkflow(fresh,current), idempotency = dbIdempotency(userId,generation.id);
      if (!idempotency) throw new Error('Workflow not found');
      saveGeneration(userId,idempotency,updated);
      return updated;
    } finally { activeWorkflowUpdates.delete(lock); }
  },
});
