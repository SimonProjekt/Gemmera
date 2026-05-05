import type { App } from "obsidian";
import type { IndexService, LLMService, VaultService } from "../contracts";
import { OllamaLLMService } from "./ollama-llm";
import { ObsidianVaultService } from "./real-vault";
import { VaultLinearIndexService } from "./vault-index";

export interface Services {
  llm: LLMService;
  vault: VaultService;
  index: IndexService;
}

export function createServices(app: App): Services {
  const vault = new ObsidianVaultService(app);
  return {
    llm: new OllamaLLMService(),
    vault,
    index: new VaultLinearIndexService(vault),
  };
}

export { OllamaLLMService } from "./ollama-llm";
export { ObsidianVaultService } from "./real-vault";
export { VaultLinearIndexService } from "./vault-index";
