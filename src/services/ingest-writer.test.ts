import { describe, expect, it } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { IngestWriter } from "./ingest-writer";
import type { NoteSpec } from "../contracts";

function makeSpec(overrides: Partial<NoteSpec> = {}): NoteSpec {
  return {
    title: "Q2 standup",
    type: "meeting",
    tags: ["q2", "team"],
    aliases: [],
    source: "chat-paste",
    entities: ["Alice"],
    related: [],
    status: "inbox",
    summary: "Decisions about billing-v2.",
    key_points: ["Switch to v2 by July"],
    body_markdown: "# Decisions\n\nWe agreed to roll out billing-v2 next quarter.",
    cowork: {
      source: "ingest",
      run_id: "01HW000",
      model: "gemma3:latest",
      version: "0.0.1",
      confidence: "high",
    },
    ...overrides,
  };
}

describe("IngestWriter", () => {
  it("writes a new note in the default Inbox/ folder with a dated filename", async () => {
    const vault = new MockVaultService({});
    const writer = new IngestWriter(vault);
    const fixedNow = () => Date.UTC(2026, 4, 6); // 2026-05-06

    const result = await writer.writeNew(makeSpec(), { now: fixedNow });

    expect(result.path).toBe("Inbox/2026-05-06 Q2 standup.md");
    const written = await vault.read(result.path);
    expect(written).toContain("---\n");
    expect(written).toContain("cowork_managed: true");
    expect(written).toContain("type: meeting");
    expect(written).toContain("# Decisions");
    expect(written).toContain("cowork:");
    expect(written).toContain("source: ingest");
  });

  it("disambiguates filename collisions with (2), (3), ...", async () => {
    const vault = new MockVaultService({
      "Inbox/2026-05-06 Q2 standup.md": "existing",
    });
    const writer = new IngestWriter(vault);
    const fixedNow = () => Date.UTC(2026, 4, 6);

    const result = await writer.writeNew(makeSpec(), { now: fixedNow });
    expect(result.path).toBe("Inbox/2026-05-06 Q2 standup (2).md");
  });

  it("appends under a new dated heading when target lacks today's heading", async () => {
    const target = "Projects/billing-v2.md";
    const vault = new MockVaultService({
      [target]: "---\ntitle: Billing v2\ncowork_managed: true\n---\n\n# Billing v2\n\nNotes go here.\n",
    });
    const writer = new IngestWriter(vault);
    const fixedNow = () => Date.UTC(2026, 4, 6);

    await writer.appendUnderDatedHeading(target, "New paragraph from chat.", { now: fixedNow });
    const result = await vault.read(target);

    expect(result).toContain("## 2026-05-06");
    expect(result).toContain("New paragraph from chat.");
  });

  it("appends under existing dated heading without creating a duplicate", async () => {
    const target = "daily.md";
    const vault = new MockVaultService({
      [target]: "# Daily\n\n## 2026-05-06\n\nFirst entry.\n",
    });
    const writer = new IngestWriter(vault);
    const fixedNow = () => Date.UTC(2026, 4, 6);

    await writer.appendUnderDatedHeading(target, "Second entry.", { now: fixedNow });
    const result = await vault.read(target);

    const headingMatches = result.match(/## 2026-05-06/g) ?? [];
    expect(headingMatches.length).toBe(1);
    expect(result).toContain("Second entry.");
  });

  it("rejects bodies that contain their own frontmatter block", async () => {
    const vault = new MockVaultService({});
    const writer = new IngestWriter(vault);
    const spec = makeSpec({
      body_markdown: "---\ntitle: hijack\n---\n\nbad",
    });
    await expect(writer.writeNew(spec)).rejects.toThrow(/frontmatter/);
  });

  it("throws when append target is missing", async () => {
    const vault = new MockVaultService({});
    const writer = new IngestWriter(vault);
    await expect(
      writer.appendUnderDatedHeading("does/not/exist.md", "x"),
    ).rejects.toThrow(/missing/);
  });
});
