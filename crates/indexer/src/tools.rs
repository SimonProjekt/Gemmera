//! JSON Schemas for every tool Gemma can call during ingest and query.
//!
//! Schemas live at compile time via `include_str!` and are parsed lazily on
//! first access. The registry exposes:
//!
//! * [`all_tools`] — slice of every registered tool.
//! * [`by_name`] — lookup by tool name.
//! * [`ollama_tools_payload`] — the payload shape Ollama expects under
//!   `"tools"` in a chat completion request.

use once_cell::sync::Lazy;
use serde_json::{json, Value};

/// A single tool definition: stable name, LLM-facing description, and the
/// parsed JSON Schema for its argument object.
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
}

const INGEST_CONTENT: &str = include_str!("../../../schemas/gemma-tools/ingest_content.json");
const RETRIEVE_SIMILAR_NOTES: &str =
    include_str!("../../../schemas/gemma-tools/retrieve_similar_notes.json");
const SAVE_NOTE: &str = include_str!("../../../schemas/gemma-tools/save_note.json");
const UPDATE_INDEX: &str = include_str!("../../../schemas/gemma-tools/update_index.json");
const SEARCH_NOTES: &str = include_str!("../../../schemas/gemma-tools/search_notes.json");
const RERANK_RESULTS: &str = include_str!("../../../schemas/gemma-tools/rerank_results.json");
const GET_NOTE_CONTEXT: &str = include_str!("../../../schemas/gemma-tools/get_note_context.json");
const CREATE_SYNTHESIS_NOTE: &str =
    include_str!("../../../schemas/gemma-tools/create_synthesis_note.json");

fn parse(raw: &str) -> Value {
    serde_json::from_str(raw).expect("embedded tool schema must be valid JSON")
}

fn description_of(schema: &Value) -> &'static str {
    // The descriptions are static text in the embedded schemas. We extract
    // them once and leak the resulting String to obtain a `&'static str`,
    // which is fine because the registry itself is `'static`.
    let desc = schema
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Box::leak(desc.to_owned().into_boxed_str())
}

static TOOLS: Lazy<Vec<ToolDef>> = Lazy::new(|| {
    let entries: [(&'static str, &'static str); 8] = [
        ("ingest_content", INGEST_CONTENT),
        ("retrieve_similar_notes", RETRIEVE_SIMILAR_NOTES),
        ("save_note", SAVE_NOTE),
        ("update_index", UPDATE_INDEX),
        ("search_notes", SEARCH_NOTES),
        ("rerank_results", RERANK_RESULTS),
        ("get_note_context", GET_NOTE_CONTEXT),
        ("create_synthesis_note", CREATE_SYNTHESIS_NOTE),
    ];

    entries
        .into_iter()
        .map(|(name, raw)| {
            let schema = parse(raw);
            let description = description_of(&schema);
            ToolDef {
                name,
                description,
                schema,
            }
        })
        .collect()
});

/// All tool definitions, in registration order.
pub fn all_tools() -> &'static [ToolDef] {
    TOOLS.as_slice()
}

/// Look up a tool by its registered name.
pub fn by_name(name: &str) -> Option<&'static ToolDef> {
    TOOLS.iter().find(|t| t.name == name)
}

/// Render the registry as the JSON Ollama expects under `"tools"` in a chat
/// completion request: `[{ "type": "function", "function": { name, description, parameters } }, ...]`.
pub fn ollama_tools_payload() -> Value {
    let arr: Vec<Value> = all_tools()
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.schema,
                }
            })
        })
        .collect();
    Value::Array(arr)
}
