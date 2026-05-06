import { join } from "path";
import { FileSystemAdapter, Notice, type App } from "obsidian";
import type {
  BM25Index,
  IndexService,
  IngestionPipeline,
  IngestionStore,
  JobQueue,
  LLMService,
  MutableLinksIndex,
  PathFilter,
  PayloadAssembler,
  Reconciler,
  Retriever,
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
import { InMemoryBM25Index } from "./in-memory-bm25-index";
import { BM25IndexService } from "./bm25-index-service";
import { InMemoryLinksIndex } from "./in-memory-links-index";
import { LinksIndexService } from "./links-index-service";
import { HybridRetriever } from "./hybrid-retriever";
import { DefaultPayloadAssembler } from "./payload-assembler";

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
  bm25Index: BM25Index;
  bm25IndexService: BM25IndexService;
  linksIndex: MutableLinksIndex;
  linksIndexService: LinksIndexService;
  retriever: Retriever;
  payloadAssembler: PayloadAssembler;
  promptLoader: PromptLoader;
  classifierEventWriter: ClassifierEventWriter;
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

  const bm25Index = new InMemoryBM25Index();
  const bm25IndexService = new BM25IndexService(ingestionRunner, bm25Index, ingestionStore);
  const linksIndex = new InMemoryLinksIndex();
  const linksIndexService = new LinksIndexService(ingestionRunner, vault, linksIndex);
  const retriever = new HybridRetriever(
    embedder,
    vectorStore,
    bm25Index,
    linksIndex,
    ingestionStore,
  );
  const payloadAssembler = new DefaultPayloadAssembler(linksIndex);

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
    bm25Index,
    bm25IndexService,
    linksIndex,
    linksIndexService,
    retriever,
    payloadAssembler,
    promptLoader: new FilePromptLoader(join(pluginDir, "prompts")),
    classifierEventWriter: new InMemoryClassifierEventWriter(),
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
export { InMemoryBM25Index } from "./in-memory-bm25-index";
export { BM25IndexService } from "./bm25-index-service";
export { InMemoryLinksIndex } from "./in-memory-links-index";
export { LinksIndexService } from "./links-index-service";
export { HybridRetriever } from "./hybrid-retriever";
export { DefaultPayloadAssembler } from "./payload-assembler";
