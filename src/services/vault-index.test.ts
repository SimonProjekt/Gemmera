import { describe, expect, it } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { VaultLinearIndexService } from "./vault-index";

describe("VaultLinearIndexService", () => {
  const sampleVault = (): MockVaultService => {
    const v = new MockVaultService({
      "Notes/Jonas-dagbok.md": "Jonas skrev om vandring i Sundsvall under sommaren.",
      "Notes/Boklista.md": "Lista över böcker. Inga personliga reflektioner.",
      "Notes/Brev.md": "Brev till Erik om planer för migrering.",
    });
    v.setHeadings("Notes/Jonas-dagbok.md", ["Vandring", "Sundsvall"]);
    return v;
  };

  it("returns nothing when query has only short terms", async () => {
    const idx = new VaultLinearIndexService(sampleVault());
    expect(await idx.search("a b")).toEqual([]);
  });

  it("ranks filename hits highest", async () => {
    const idx = new VaultLinearIndexService(sampleVault());
    const results = await idx.search("jonas");
    expect(results[0].path).toBe("Notes/Jonas-dagbok.md");
  });

  it("respects topK", async () => {
    const idx = new VaultLinearIndexService(sampleVault());
    const results = await idx.search("brev planer migrering", { topK: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].basename).toBe("Brev");
  });

  it("returns an empty array on no match", async () => {
    const idx = new VaultLinearIndexService(sampleVault());
    expect(await idx.search("kvantkromodynamik")).toEqual([]);
  });
});
