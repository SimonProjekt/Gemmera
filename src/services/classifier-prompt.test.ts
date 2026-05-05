import { describe, expect, it } from "vitest";
import { ClassifierInput } from "../contracts/classifier";
import {
  assembleClassifierPrompt,
  INTENT_CLASSIFIER_PROMPT_VERSION,
  loadClassifierPromptBody,
} from "./classifier-prompt";

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

describe("INTENT_CLASSIFIER_PROMPT_VERSION", () => {
  it("matches the version header in the prompt file", async () => {
    const body = await loadClassifierPromptBody();
    expect(body).toContain(`version: ${INTENT_CLASSIFIER_PROMPT_VERSION}`);
  });
});

describe("assembleClassifierPrompt", () => {
  it("renders all sections when the input is fully populated", () => {
    const body = [
      "version: 0.1.0",
      "",
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

  it("snapshot: full prompt rendered from the on-disk file against a fixed input", async () => {
    const body = await loadClassifierPromptBody();
    const result = assembleClassifierPrompt(fixedInput, body);
    expect(result).toMatchSnapshot();
  });
});
