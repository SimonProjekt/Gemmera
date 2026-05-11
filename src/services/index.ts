import { FileSystemAdapter, Notice, type App } from "obsidian";
import type {
  ClassifierService,
  Embedder,
  IndexService,
  IngestionPipeline,
  IngestionStore,
  JobQueue,
  LLMService,
  PathFilter,
  Reconciler,
  VaultService,
  VectorStore,
} from "../contracts";
import type { GemmeraSettings } from "../settings";
import { MockLLMService } from "./mock-llm";
import { MockClassifierService } from "./mock-classifier";
import { OllamaClassifierService } from "./ollama-classifier";
import { OllamaLLMService } from "./ollama-llm";
import { ObsidianVaultService } from "./real-vault";
import { VaultLinearIndexService } from "./vault-index";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { DefaultPathFilter } from "./path-filter";
import { ObsidianVaultEventSource } from "./obsidian-vault-events";
import { VaultEventBridge } from "./vault-event-bridge";
import { JsonIngestionStore } from "./json-ingestion-store";
import { HashGatedIngestionPipeline } from "./ingestion-pipeline";
import { MarkdownChunker } from "./markdown-chunker";
import { IngestionRunner } from "./ingestion-runner";
import { VaultReconciler } from "./vault-reconciler";
import { BinaryVectorStore } from "./binary-vector-store";
import { OllamaEmbedder } from "./ollama-embedder";
import { EmbeddingService } from "./embedding-service";

export interface Services {
  llm: LLMService;
  classifier: ClassifierService;
  vault: VaultService;
  index: IndexService;
  jobQueue: JobQueue;
  pathFilter: PathFilter;
  eventBridge: VaultEventBridge;
  ingestionStore: IngestionStore;
  ingestionPipeline: IngestionPipeline;
  ingestionRunner: IngestionRunner;
  reconciler: Reconciler;
  vectorStore: VectorStore;
  embedder: Embedder;
  embeddingService: EmbeddingService;
}

const STATE_PATH = ".coworkmd/state.json";
const VECTORS_BIN_PATH = ".coworkmd/vectors.bin";
const VECTORS_JSON_PATH = ".coworkmd/vectors.json";
const DEFAULT_EMBED_MODEL = "bge-m3";
const DEFAULT_EMBED_DIM = 1024;
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

function resolveOllamaUrl(settings: GemmeraSettings): string {
  return settings.ollamaUrlMode === "manual" && settings.ollamaUrl.trim()
    ? settings.ollamaUrl.trim()
    : DEFAULT_OLLAMA_URL;
}

export async function createLLMService(
  backend: GemmeraSettings["llmBackend"],
  baseUrl: string,
): Promise<LLMService> {
  if (backend === "mock") {
    return new MockLLMService();
  }
  const ollama = new OllamaLLMService(baseUrl);
  if ((await ollama.isReachable()) === "missing") {
    new Notice("Gemmera: Ollama not reachable — falling back to mock LLM.");
    return new MockLLMService();
  }
  return ollama;
}

export function createClassifierService(
  backend: GemmeraSettings["llmBackend"],
  llm: LLMService,
  baseUrl: string,
): ClassifierService {
  if (backend === "mock" || llm instanceof MockLLMService) {
    return new MockClassifierService();
  }
  return new OllamaClassifierService(undefined, baseUrl);
}

export async function createServices(app: App, settings: GemmeraSettings): Promise<Services> {
  const vault = new ObsidianVaultService(app);
  const jobQueue = new InMemoryJobQueue();
  const pathFilter = new DefaultPathFilter(createUserIgnore(settings.excludedFolders));
  const eventBridge = new VaultEventBridge(
    new ObsidianVaultEventSource(app),
    jobQueue,
    pathFilter,
  );

  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error(
      "Gemmera requires a filesystem-backed vault (desktop Obsidian).",
    );
  }
  const ingestionStore = new JsonIngestionStore(adapter.getFullPath(STATE_PATH));
  const ingestionPipeline = new HashGatedIngestionPipeline(
    vault,
    new MarkdownChunker(),
    ingestionStore,
  );
  const ingestionRunner = new IngestionRunner(jobQueue, ingestionPipeline, ingestionStore);
  const reconciler = new VaultReconciler(vault, ingestionStore, jobQueue, pathFilter);
  const vectorStore = new BinaryVectorStore(
    adapter.getFullPath(VECTORS_BIN_PATH),
    adapter.getFullPath(VECTORS_JSON_PATH),
    DEFAULT_EMBED_MODEL,
    DEFAULT_EMBED_DIM,
  );
  const ollamaUrl = resolveOllamaUrl(settings);
  const embedder = new OllamaEmbedder({
    model: DEFAULT_EMBED_MODEL,
    dim: DEFAULT_EMBED_DIM,
    baseUrl: ollamaUrl,
  });
  const embeddingService = new EmbeddingService(
    ingestionRunner,
    embedder,
    vectorStore,
    ingestionStore,
  );

  const llm = await createLLMService(settings.llmBackend, ollamaUrl);
  return {
    llm,
    classifier: createClassifierService(settings.llmBackend, llm, ollamaUrl),
    vault,
    index: new VaultLinearIndexService(vault),
    jobQueue,
    pathFilter,
    eventBridge,
    ingestionStore,
    ingestionPipeline,
    ingestionRunner,
    reconciler,
    vectorStore,
    embedder,
    embeddingService,
  };
}

function createUserIgnore(excludedFolders: string): { matches: (path: string) => boolean } {
  if (!excludedFolders.trim()) return { matches: () => false };
  const prefixes = excludedFolders
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (prefixes.length === 0) return { matches: () => false };
  return {
    matches: (path: string) => prefixes.some((p) => path.startsWith(p)),
  };
}

export { OllamaLLMService } from "./ollama-llm";
export { OllamaClassifierService } from "./ollama-classifier";
export { MockClassifierService } from "./mock-classifier";
export { ObsidianVaultService } from "./real-vault";
export { VaultLinearIndexService } from "./vault-index";
export { InMemoryJobQueue } from "./in-memory-job-queue";
export { DefaultPathFilter } from "./path-filter";
export { ObsidianVaultEventSource } from "./obsidian-vault-events";
export { VaultEventBridge } from "./vault-event-bridge";
export { JsonIngestionStore } from "./json-ingestion-store";
export { HashGatedIngestionPipeline } from "./ingestion-pipeline";
export { MarkdownChunker } from "./markdown-chunker";
export { IngestionRunner } from "./ingestion-runner";
export { VaultReconciler } from "./vault-reconciler";
export { BinaryVectorStore } from "./binary-vector-store";
export { OllamaEmbedder } from "./ollama-embedder";
export { EmbeddingService } from "./embedding-service";
