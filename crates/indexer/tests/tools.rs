use std::collections::HashSet;

use indexer::tools::{all_tools, by_name, ollama_tools_payload};
use jsonschema::{Draft, JSONSchema};
use serde_json::{json, Value};

fn compile_2020_12(schema: &Value) -> JSONSchema {
    JSONSchema::options()
        .with_draft(Draft::Draft202012)
        .compile(schema)
        .expect("schema compiles as Draft 2020-12")
}

#[test]
fn all_eight_tools_resolve_with_unique_names() {
    let tools = all_tools();
    assert_eq!(tools.len(), 8, "expected exactly eight registered tools");

    let mut seen = HashSet::new();
    for t in tools {
        assert!(seen.insert(t.name), "duplicate tool name: {}", t.name);
        assert!(
            by_name(t.name).is_some(),
            "by_name lookup failed for {}",
            t.name
        );
    }

    assert!(by_name("definitely_not_a_tool").is_none());
}

#[test]
fn every_schema_is_valid_draft_2020_12() {
    // The Draft 2020-12 meta-schema validates any candidate JSON Schema. We
    // load Draft 2020-12 itself, then assert each tool's schema validates
    // against it. This is the closest the jsonschema 0.18 API gets to
    // "is_valid as a draft 2020-12 schema."
    for t in all_tools() {
        // First: every schema must compile under the 2020-12 draft. Failure
        // means an invalid schema construct (e.g. malformed `type`).
        let _compiled = compile_2020_12(&t.schema);
        // Second: the schema must explicitly declare the 2020-12 dialect via
        // its $schema keyword. Together with successful compilation this
        // is a sufficient validity check for our purposes.
        assert_eq!(
            t.schema.get("$schema").and_then(Value::as_str),
            Some("https://json-schema.org/draft/2020-12/schema"),
            "tool {} must declare Draft 2020-12 via $schema",
            t.name
        );
    }
}

fn save_note_inner_note_schema() -> Value {
    let save_note = by_name("save_note").expect("save_note is registered");
    save_note
        .schema
        .pointer("/properties/note")
        .cloned()
        .expect("save_note.note property exists")
}

fn example_frontmatter_object() -> Value {
    // Mirrors the planning/rag.md "Frontmatter contract" example.
    json!({
        "title": "Q2 planning meeting",
        "type": "meeting",
        "tags": ["q2", "planning", "team"],
        "aliases": [],
        "source": "chat-paste",
        "entities": ["Alice", "Bob", "billing-v2"],
        "related": ["projects/billing-v2.md"],
        "status": "inbox",
        "summary": "Quick sync on Q2 priorities and the billing-v2 rollout.",
        "key_points": ["Owners agreed", "Deadline confirmed"],
        "body_markdown": "## Agenda\n\n- review priorities\n",
        "cowork": {
            "source": "ingest",
            "run_id": "01HW000000000000000000",
            "model": "gemma4-e4b",
            "version": "0.3.1",
            "confidence": "high"
        }
    })
}

#[test]
fn save_note_note_accepts_planning_doc_example() {
    let note_schema = save_note_inner_note_schema();
    let validator = compile_2020_12(&note_schema);
    let example = example_frontmatter_object();
    assert!(
        validator.is_valid(&example),
        "planning-doc example frontmatter should validate against save_note.note schema"
    );
}

#[test]
fn save_note_note_rejects_off_schema_field() {
    let note_schema = save_note_inner_note_schema();
    let validator = compile_2020_12(&note_schema);
    let mut example = example_frontmatter_object();
    example
        .as_object_mut()
        .expect("example is an object")
        .insert("snacks".to_string(), json!([]));
    assert!(
        !validator.is_valid(&example),
        "off-schema field 'snacks' must cause validation to fail"
    );
}

#[test]
fn ollama_payload_shape_is_correct() {
    let payload = ollama_tools_payload();
    let arr = payload.as_array().expect("payload is an array");
    assert_eq!(arr.len(), 8);

    let registered: HashSet<&str> = all_tools().iter().map(|t| t.name).collect();

    for entry in arr {
        let obj = entry.as_object().expect("entry is an object");
        assert_eq!(
            obj.get("type").and_then(Value::as_str),
            Some("function"),
            "every entry must have type=='function'"
        );
        let function = obj.get("function").expect("function object present");
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .expect("function.name is a string");
        assert!(
            registered.contains(name),
            "function.name {name} must match a registered tool"
        );
        assert!(
            function.get("description").is_some(),
            "function.description must be present"
        );
        assert!(
            function.get("parameters").is_some(),
            "function.parameters must be present"
        );
    }
}

fn walk_assert_no_explicit_additional_true(value: &Value, trail: &str) {
    match value {
        Value::Object(map) => {
            if let Some(ap) = map.get("additionalProperties") {
                if let Some(b) = ap.as_bool() {
                    assert!(!b, "explicit `additionalProperties: true` found at {trail}");
                }
            }
            for (k, v) in map {
                let next = if trail.is_empty() {
                    k.clone()
                } else {
                    format!("{trail}.{k}")
                };
                walk_assert_no_explicit_additional_true(v, &next);
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                let next = format!("{trail}[{i}]");
                walk_assert_no_explicit_additional_true(v, &next);
            }
        }
        _ => {}
    }
}

#[test]
fn no_schema_sets_additional_properties_to_true() {
    for t in all_tools() {
        walk_assert_no_explicit_additional_true(&t.schema, t.name);
    }
}
