import { join } from "path";
import { describe, expect, it } from "vitest";
import { ClassifierInput } from "../contracts/classifier";
import { FilePromptLoader } from "./file-prompt-loader";
import { assembleClassifierPrompt } from "./classifier-prompt";

const promptsDir = join(process.cwd(), "prompts");

const fixedInput: ClassifierInput = {
  messageText: "Save this as meeting notes and what did we discuss last week about API design?",
  truncated: false,
  attachments: [
    { kind: "pdf", filename: "roadmap.pdf" },
    { kind: "image", filename: "whiteboard.jpg" },
  ],
  activeFile: { filename: "projects/gemmera.md", title: "Gemmera" },
  recentTurns: [
    { text: "start a new note about the API", intent: "capture" },
    { text: "what endpoints do we have?", intent: "ask" },
    { text: "save that", intent: "capture" },
  ],
};

describe("assembleClassifierPrompt", () => {
  it("renders all sections when the input is fully populated", () => {
    const body = [
      "System preamble",
      "",
      "## Current input",
      "",
      "Message: {{messageText}}",
      "{{attachmentList}}",
      "{{activeFileLine}}",
      "{{recentTurnList}}",
    ].join("\n");

    const result = assembleClassifierPrompt(fixedInput, body);

    expect(result).toContain("Message: Save this as meeting notes");
    expect(result).toContain("- pdf: roadmap.pdf");
    expect(result).toContain("- image: whiteboard.jpg");
    expect(result).toContain("Active file: Gemmera (projects/gemmera.md)");
    expect(result).toContain('User: "start a new note about the API" → capture');
    expect(result).toContain('User: "what endpoints do we have?" → ask');
    expect(result).toContain('User: "save that" → capture');
    expect(result).not.toContain("{{messageText}}");
    expect(result).not.toContain("{{attachmentList}}");
    expect(result).not.toContain("{{activeFileLine}}");
    expect(result).not.toContain("{{recentTurnList}}");
  });

  it("omits attachment section when there are no attachments", () => {
    const result = assembleClassifierPrompt(
      { ...fixedInput, attachments: [] },
      "{{attachmentList}}",
    );
    expect(result).toBe("");
  });

  it("omits active-file line when there is no active file", () => {
    const result = assembleClassifierPrompt(
      { ...fixedInput, activeFile: null },
      "{{activeFileLine}}",
    );
    expect(result).toBe("");
  });

  it("omits recent-turns section when there are no recent turns", () => {
    const result = assembleClassifierPrompt(
      { ...fixedInput, recentTurns: [] },
      "{{recentTurnList}}",
    );
    expect(result).toBe("");
  });

  it("renders exactly 3 recent turns even when more are provided", () => {
    // prepareClassifierInput already slices to 3; this test verifies the
    // assembler renders whatever is given (caller owns the slice).
    const many = [
      { text: "t1", intent: "ask" as const },
      { text: "t2", intent: "capture" as const },
      { text: "t3", intent: "meta" as const },
      { text: "t4", intent: "ask" as const },
    ];
    const result = assembleClassifierPrompt(
      { ...fixedInput, recentTurns: many },
      "{{recentTurnList}}",
    );
    expect(result).toContain("t1");
    expect(result).toContain("t4");
    expect(result.match(/→/g)).toHaveLength(4);
  });

  it("does not interpret regex replacement patterns in user input", () => {
    // String.prototype.replace with a string second argument expands $&, $1
    // etc. into match references. The function-form replace must guard
    // against this so user input is rendered verbatim.
    const adversarial = '$& and $1 and $`';
    const result = assembleClassifierPrompt(
      { ...fixedInput, messageText: adversarial },
      "Message: {{messageText}}",
    );
    expect(result).toBe(`Message: ${adversarial}`);
  });

  it("snapshot: full prompt rendered from FilePromptLoader against a fixed input", async () => {
    const loader = new FilePromptLoader(promptsDir);
    const loaded = await loader.load("intent-classifier");
    const result = assembleClassifierPrompt(fixedInput, loaded.body);
    expect(result).toMatchSnapshot();
  });

  it("the loaded prompt's version is the source of truth for stamping", async () => {
    const loader = new FilePromptLoader(promptsDir);
    const loaded = await loader.load("intent-classifier");
    expect(loaded.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
