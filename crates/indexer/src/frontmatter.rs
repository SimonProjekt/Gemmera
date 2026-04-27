//! Frontmatter contract validator.
//!
//! Compiles the embedded JSON Schema (`schemas/frontmatter.schema.json`) once
//! and validates the structured object Gemma fills before the writer composes
//! a final note. See `planning/rag.md` §"Frontmatter contract" for the
//! source-of-truth shape and validation rules.
//!
//! Beyond the schema, two rules are enforced in code because JSON Schema
//! cannot express them cleanly:
//!
//! 1. `body_markdown` must not contain its own leading frontmatter block.
//! 2. `title` must be non-empty after `trim()` (the schema only checks raw
//!    length).
//!
//! Validation errors do not flow through [`crate::error::IndexerError`]; they
//! are returned as `Result<(), Vec<ValidationError>>` so the caller can react
//! per-field (e.g. surface them in the preview UI).

use jsonschema::JSONSchema;
use serde_json::Value;

use crate::error::{IndexerError, Result};

/// The embedded JSON Schema (draft 2020-12) describing the frontmatter
/// contract. Embedded at compile time so the validator has zero runtime file
/// dependency.
const SCHEMA_SRC: &str = include_str!("../../../schemas/frontmatter.schema.json");

/// One field-scoped validation failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    /// JSON pointer to the offending instance node, e.g. `/title`,
    /// `/cowork/confidence`, or `""` for the root object.
    pub instance_path: String,
    /// Human-readable description of what failed.
    pub message: String,
}

/// Compiled validator for the frontmatter contract.
///
/// Construct once via [`FrontmatterValidator::new`] and reuse for every
/// candidate note. Compilation is the expensive step; per-call validation is
/// cheap.
pub struct FrontmatterValidator {
    schema: JSONSchema,
}

impl FrontmatterValidator {
    /// Compile the embedded schema. Returns
    /// [`IndexerError::SchemaCompile`] if the schema source is malformed
    /// (which would be a build-time bug, not a runtime input problem).
    pub fn new() -> Result<Self> {
        let schema_value: Value = serde_json::from_str(SCHEMA_SRC)
            .map_err(|e| IndexerError::SchemaCompile(format!("schema is not valid JSON: {e}")))?;
        let schema = JSONSchema::compile(&schema_value)
            .map_err(|e| IndexerError::SchemaCompile(e.to_string()))?;
        Ok(Self { schema })
    }

    /// Validate `value` against the schema and the extra in-code rules.
    ///
    /// Returns `Ok(())` only when both passes succeed. Errors from both
    /// passes are aggregated.
    pub fn validate(&self, value: &Value) -> std::result::Result<(), Vec<ValidationError>> {
        let mut errors: Vec<ValidationError> = Vec::new();

        if let Err(iter) = self.schema.validate(value) {
            for err in iter {
                errors.push(ValidationError {
                    instance_path: err.instance_path.to_string(),
                    message: err.to_string(),
                });
            }
        }

        check_body_markdown(value, &mut errors);
        check_title_trim(value, &mut errors);

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

/// Reject a `body_markdown` whose first non-whitespace content is a `---`
/// fence followed by a closing `---` line within the first 200 lines.
fn check_body_markdown(value: &Value, errors: &mut Vec<ValidationError>) {
    let Some(body) = value.get("body_markdown").and_then(Value::as_str) else {
        // Schema layer already caught missing/wrong-type body_markdown.
        return;
    };
    if has_leading_frontmatter_block(body) {
        errors.push(ValidationError {
            instance_path: "/body_markdown".to_string(),
            message: "body_markdown must not contain its own frontmatter block".to_string(),
        });
    }
}

/// True if `body`, after trimming leading whitespace, opens with `---\n` and
/// has a closing `---` line within the first 200 lines.
fn has_leading_frontmatter_block(body: &str) -> bool {
    let trimmed = body.trim_start();
    // Must open with a `---` fence on its own line.
    let after_fence = match trimmed.strip_prefix("---\n") {
        Some(rest) => rest,
        None => match trimmed.strip_prefix("---\r\n") {
            Some(rest) => rest,
            None => return false,
        },
    };
    for (idx, line) in after_fence.lines().enumerate() {
        if idx >= 200 {
            return false;
        }
        if line == "---" {
            return true;
        }
    }
    false
}

/// Reject a `title` that is non-empty per the schema but whitespace-only.
fn check_title_trim(value: &Value, errors: &mut Vec<ValidationError>) {
    let Some(title) = value.get("title").and_then(Value::as_str) else {
        return;
    };
    if title.trim().is_empty() {
        errors.push(ValidationError {
            instance_path: "/title".to_string(),
            message: "title must be non-empty after trim".to_string(),
        });
    }
}
