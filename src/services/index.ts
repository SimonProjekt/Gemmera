import { FileSystemAdapter, type App } from "obsidian";
import type {
  IndexService,
  IngestionPipeline,
  IngestionStore,
  JobQueue,
  JobRunner,
  LLMService,
  PathFilter,
  Reconciler,
  VaultService,
  VectorStore,
} from "../contracts";
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
import { IndexJobRunner } from "./job-runner";
import { VaultReconciler } from "./vault-reconciler";
import { BinaryVectorStore } from "./binary-vector-store";

export interface Services {
  llm: LLMService;
  vault: VaultService;
  index: IndexService;
  jobQueue: JobQueue;
  pathFilter: PathFilter;
  eventBridge: VaultEventBridge;
  ingestionStore: IngestionStore;
  ingestionPipeline: IngestionPipeline;
  jobRunner: JobRunner;
  reconciler: Reconciler;
  vectorStore: VectorStore;
}

const STATE_PATH = ".coworkmd/state.json";
const VECTORS_BIN_PATH = ".coworkmd/vectors.bin";
const VECTORS_JSON_PATH = ".coworkmd/vectors.json";
const DEFAULT_EMBED_MODEL = "bge-m3";
const DEFAULT_EMBED_DIM = 1024;

export function createServices(app: App): Services {
  const vault = new ObsidianVaultService(app);
  const jobQueue = new InMemoryJobQueue();
  const pathFilter = new DefaultPathFilter();
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
  const jobRunner = new IndexJobRunner(jobQueue, ingestionPipeline, ingestionStore);
  const reconciler = new VaultReconciler(vault, ingestionStore, jobQueue, pathFilter);
  const vectorStore = new BinaryVectorStore(
    adapter.getFullPath(VECTORS_BIN_PATH),
    adapter.getFullPath(VECTORS_JSON_PATH),
    DEFAULT_EMBED_MODEL,
    DEFAULT_EMBED_DIM,
  );

  return {
    llm: new OllamaLLMService(),
    vault,
    index: new VaultLinearIndexService(vault),
    jobQueue,
    pathFilter,
    eventBridge,
    ingestionStore,
    ingestionPipeline,
    jobRunner,
    reconciler,
    vectorStore,
  };
}

export { OllamaLLMService } from "./ollama-llm";
export { ObsidianVaultService } from "./real-vault";
export { VaultLinearIndexService } from "./vault-index";
export { InMemoryJobQueue } from "./in-memory-job-queue";
export { DefaultPathFilter } from "./path-filter";
export { ObsidianVaultEventSource } from "./obsidian-vault-events";
export { VaultEventBridge } from "./vault-event-bridge";
export { JsonIngestionStore } from "./json-ingestion-store";
export { HashGatedIngestionPipeline } from "./ingestion-pipeline";
export { MarkdownChunker } from "./markdown-chunker";
export { IndexJobRunner } from "./job-runner";
export { VaultReconciler } from "./vault-reconciler";
export { BinaryVectorStore } from "./binary-vector-store";
