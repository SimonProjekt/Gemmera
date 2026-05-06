import { join } from "path";
import { FileSystemAdapter, Notice, type App } from "obsidian";
import type {
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
import type { ClassifierEventWriter } from "../contracts/classifier";
import type { PromptLoader } from "../contracts/prompts";
import type { GemmeraSettings } from "../settings";
import { MockLLMService } from "./mock-llm";
import { OllamaLLMService } from "./ollama-llm";
import { FilePromptLoader } from "./file-prompt-loader";
import { InMemoryClassifierEventWriter } from "./classifier-events";
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
import { RunnerStatus } from "./runner-status";
import { RunnerControls } from "./runner-controls";
import { ScheduledReconciler } from "./scheduled-reconciler";
import { IngestWriter } from "./ingest-writer";
import { InMemoryEventLog } from "./event-log";
import type { EventLog, Retriever } from "../contracts";

/**
 * Cold-vault stand-in retriever. Returns no hits — used until the hybrid
 * retriever (#8) is wired into the dev branch. The strategy step tolerates
 * an empty result and falls through to a `create` decision.
 *
 * TODO(#8): replace with HybridRetriever once the wiring branch lands.
 */
class EmptyRetriever implements Retriever {
  private warned = false;
  async retrieve(): Promise<[]> {
    if (!this.warned) {
      this.warned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[gemmera] retriever stub — similarity-based dedup is disabled until #8 lands",
      );
    }
    return [];
  }
}

export interface Services {
  llm: LLMService;
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
  embeddingService: EmbeddingService;
  promptLoader: PromptLoader;
  classifierEventWriter: ClassifierEventWriter;
  runnerStatus: RunnerStatus;
  runnerControls: RunnerControls;
  scheduledReconciler: ScheduledReconciler;
  ingestWriter: IngestWriter;
  retriever: Retriever;
  eventLog: EventLog;
}

const STATE_PATH = ".coworkmd/state.json";
const VECTORS_BIN_PATH = ".coworkmd/vectors.bin";
const VECTORS_JSON_PATH = ".coworkmd/vectors.json";
const DEFAULT_EMBED_MODEL = "bge-m3";
const DEFAULT_EMBED_DIM = 1024;

export async function createLLMService(
  backend: GemmeraSettings["llmBackend"],
): Promise<LLMService> {
  if (backend === "mock") {
    return new MockLLMService();
  }
  const ollama = new OllamaLLMService();
  if ((await ollama.isReachable()) === "missing") {
    new Notice("Gemmera: Ollama not reachable — falling back to mock LLM.");
    return new MockLLMService();
  }
  return ollama;
}

export async function createServices(app: App, settings: GemmeraSettings, pluginDir: string): Promise<Services> {
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
  // Closure capture: RunnerControls bumps `meta.rebuildEpoch`; the pipeline
  // reads it on every ingest. We can't `await` here, so we stash the latest
  // value in a process-local cell and refresh on every meta write below.
  const epochCell = { value: 0 };
  const ingestionPipeline = new HashGatedIngestionPipeline(
    vault,
    new MarkdownChunker(),
    ingestionStore,
    () => epochCell.value,
  );
  const ingestionRunner = new IngestionRunner(jobQueue, ingestionPipeline, ingestionStore);
  const reconciler = new VaultReconciler(vault, ingestionStore, jobQueue, pathFilter);
  const runnerStatus = new RunnerStatus(jobQueue, ingestionRunner);
  const runnerControls = new RunnerControls(
    ingestionRunner,
    runnerStatus,
    ingestionStore,
    reconciler,
    jobQueue,
  );
  const scheduledReconciler = new ScheduledReconciler({
    vault,
    store: ingestionStore,
    reconciler,
  });
  // Seed the epoch cell from persisted meta so rebuilds survive reload.
  epochCell.value = (await ingestionStore.getMeta("rebuildEpoch")) ?? 0;
  // Re-read after rebuild so the pipeline's hash gate sees the new epoch.
  const origRebuild = runnerControls.rebuild.bind(runnerControls);
  runnerControls.rebuild = async () => {
    const result = await origRebuild();
    epochCell.value = (await ingestionStore.getMeta("rebuildEpoch")) ?? epochCell.value;
    return result;
  };
  const vectorStore = new BinaryVectorStore(
    adapter.getFullPath(VECTORS_BIN_PATH),
    adapter.getFullPath(VECTORS_JSON_PATH),
    DEFAULT_EMBED_MODEL,
    DEFAULT_EMBED_DIM,
  );
  const embedder = new OllamaEmbedder({
    model: DEFAULT_EMBED_MODEL,
    dim: DEFAULT_EMBED_DIM,
  });
  const embeddingService = new EmbeddingService(
    ingestionRunner,
    embedder,
    vectorStore,
    ingestionStore,
  );

  return {
    llm: await createLLMService(settings.llmBackend),
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
    embeddingService,
    promptLoader: new FilePromptLoader(join(pluginDir, "prompts")),
    classifierEventWriter: new InMemoryClassifierEventWriter(),
    runnerStatus,
    runnerControls,
    scheduledReconciler,
    ingestWriter: new IngestWriter(vault),
    retriever: new EmptyRetriever(),
    eventLog: new InMemoryEventLog(),
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
export { IngestionRunner } from "./ingestion-runner";
export { VaultReconciler } from "./vault-reconciler";
export { BinaryVectorStore } from "./binary-vector-store";
export { OllamaEmbedder } from "./ollama-embedder";
export { EmbeddingService } from "./embedding-service";
export { RunnerStatus } from "./runner-status";
export { RunnerControls } from "./runner-controls";
export { ScheduledReconciler } from "./scheduled-reconciler";
export { IngestWriter } from "./ingest-writer";
export { runIngest } from "./ingest-orchestrator";
export type {
  IngestPreview,
  PreviewDecision,
  PreviewHandler,
} from "./ingest-orchestrator";
