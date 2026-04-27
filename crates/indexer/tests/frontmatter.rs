//! Tests for the frontmatter contract validator.
//!
//! The happy-path fixture mirrors the JSON example in
//! `planning/rag.md` §"Frontmatter contract" verbatim (modulo non-significant
//! whitespace and stripped comments — JSON Schema is not JSONC).

use indexer::frontmatter::{FrontmatterValidator, ValidationError};
use serde_json::{json, Value};

fn validator() -> FrontmatterValidator {
    FrontmatterValidator::new().expect("schema compiles")
}

/// The literal example from the planning doc (`type: meeting`), with comments
/// stripped to make it valid JSON.
fn planning_example() -> Value {
    json!({
        "title": "Q2 planning meeting",
        "type": "meeting",
        "tags": ["q2", "planning", "team"],
        "aliases": [],
        "source": "chat-paste",
        "entities": ["Alice", "Bob", "billing-v2"],
        "related": ["projects/billing-v2.md"],
        "status": "inbox",
        "summary": "Short three-sentence summary of the meeting.",
        "key_points": ["covered roadmap", "scoped billing-v2"],
        "body_markdown": "## Notes\n\nBody copy here.",
        "cowork": {
            "source": "ingest",
            "run_id": "01HW00000000000000000000",
            "model": "gemma4-e4b",
            "version": "0.3.1",
            "confidence": "high"
        }
    })
}

fn paths(errors: &[ValidationError]) -> Vec<&str> {
    errors.iter().map(|e| e.instance_path.as_str()).collect()
}

#[test]
fn happy_path_planning_example_validates() {
    let v = validator();
    let value = planning_example();
    v.validate(&value)
        .expect("planning example must validate clean");
}

#[test]
fn missing_required_title_fails_at_root() {
    let v = validator();
    let mut value = planning_example();
    value.as_object_mut().unwrap().remove("title");
    let errs = v.validate(&value).expect_err("missing title must fail");
    assert!(
        errs.iter()
            .any(|e| e.instance_path.is_empty() || e.instance_path == "/"),
        "expected an error at root, got {:?}",
        paths(&errs)
    );
}

#[test]
fn bad_type_enum_fails_at_type() {
    let v = validator();
    let mut value = planning_example();
    value["type"] = json!("blogpost");
    let errs = v.validate(&value).expect_err("bad enum must fail");
    assert!(
        errs.iter().any(|e| e.instance_path == "/type"),
        "expected /type, got {:?}",
        paths(&errs)
    );
}

#[test]
fn additional_properties_are_rejected() {
    let v = validator();
    let mut value = planning_example();
    value["snacks"] = json!([]);
    let errs = v
        .validate(&value)
        .expect_err("additionalProperties must fail");
    assert!(
        !errs.is_empty(),
        "expected at least one error for additional property"
    );
}

#[test]
fn body_markdown_with_nested_frontmatter_is_rejected() {
    let v = validator();
    let mut value = planning_example();
    value["body_markdown"] = json!("---\ntitle: Inner\n---\nbody here");
    let errs = v
        .validate(&value)
        .expect_err("nested frontmatter must fail");
    assert!(
        errs.iter().any(|e| e.instance_path == "/body_markdown"),
        "expected /body_markdown, got {:?}",
        paths(&errs)
    );
}

#[test]
fn whitespace_only_title_is_rejected_via_trim_rule() {
    let v = validator();
    let mut value = planning_example();
    value["title"] = json!("   ");
    let errs = v
        .validate(&value)
        .expect_err("whitespace-only title must fail");
    assert!(
        errs.iter().any(|e| e.instance_path == "/title"),
        "expected /title, got {:?}",
        paths(&errs)
    );
}

#[test]
fn tags_with_non_string_items_fails_at_tags_zero() {
    let v = validator();
    let mut value = planning_example();
    value["tags"] = json!([1, 2]);
    let errs = v.validate(&value).expect_err("non-string tag must fail");
    assert!(
        errs.iter().any(|e| e.instance_path == "/tags/0"),
        "expected /tags/0, got {:?}",
        paths(&errs)
    );
}

#[test]
fn cowork_confidence_out_of_range_fails() {
    let v = validator();
    let mut value = planning_example();
    value["cowork"]["confidence"] = json!("perfect");
    let errs = v.validate(&value).expect_err("bad confidence must fail");
    assert!(
        errs.iter().any(|e| e.instance_path == "/cowork/confidence"),
        "expected /cowork/confidence, got {:?}",
        paths(&errs)
    );
}
