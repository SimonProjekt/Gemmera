//! Cross-encoder reranker service.
//!
//! Wraps a locally-hosted Ollama model (default: `bge-reranker-v2-m3`) behind
//! a small synchronous trait surface so issue #10 (payload assembler) and
//! issue #14 (query loop) can call it without knowing about HTTP. Scores are
//! cached by `(query_hash, chunk_hash)` for 15 minutes so repeated rerank
//! requests on the same conversation turn don't re-hit the GPU.
//!
//! See `planning/rag.md` §"Reranking" for the broader design.

use std::num::NonZeroUsize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lru::LruCache;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{IndexerError, Result};

/// One candidate going into the reranker. `text` is the chunk body (already
/// has heading/title context prepended by the chunker — we treat it as opaque).
#[derive(Clone, Debug)]
pub struct Candidate {
    pub chunk_id: u64,
    /// sha256 hex of the chunk body, used as the cache key.
    pub chunk_hash: String,
    pub text: String,
}

/// One result coming out of the reranker.
#[derive(Clone, Debug)]
pub struct RankedCandidate {
    pub chunk_id: u64,
    /// Higher is better.
    pub score: f32,
    /// Diagnostic; tag in retrieval payload later.
    pub from_cache: bool,
}

/// Cache trait. Implementors must be `Send + Sync` so the reranker can be
/// shared across threads.
pub trait RerankCache: Send + Sync {
    fn get(&self, query_hash: &str, chunk_hash: &str) -> Option<f32>;
    fn put(&self, query_hash: &str, chunk_hash: &str, score: f32);
}

/// Default in-memory implementation: bounded LRU with a TTL per entry. Lazy
/// expiry on read keeps the implementation small; v1 doesn't need a sweeper.
pub struct InMemoryCache {
    inner: Mutex<LruCache<String, (f32, Instant)>>,
    ttl: Duration,
}

impl InMemoryCache {
    /// Build a new cache. `capacity` must be > 0; we clamp to 1 if a caller
    /// passes 0 to avoid panicking deep inside the LRU crate.
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        let cap = NonZeroUsize::new(capacity.max(1)).expect("capacity clamped to >= 1");
        Self {
            inner: Mutex::new(LruCache::new(cap)),
            ttl,
        }
    }

    fn key(query_hash: &str, chunk_hash: &str) -> String {
        format!("{query_hash}:{chunk_hash}")
    }
}

impl RerankCache for InMemoryCache {
    fn get(&self, query_hash: &str, chunk_hash: &str) -> Option<f32> {
        let key = Self::key(query_hash, chunk_hash);
        let mut guard = self.inner.lock().ok()?;
        if let Some((score, inserted_at)) = guard.get(&key).copied() {
            if inserted_at.elapsed() <= self.ttl {
                return Some(score);
            }
            // Expired: drop it so the LRU doesn't keep a stale slot pinned.
            guard.pop(&key);
        }
        None
    }

    fn put(&self, query_hash: &str, chunk_hash: &str, score: f32) {
        let key = Self::key(query_hash, chunk_hash);
        if let Ok(mut guard) = self.inner.lock() {
            guard.put(key, (score, Instant::now()));
        }
    }
}

/// Hash a query for cache keying. We trim because trailing whitespace from
/// upstream UI shouldn't bust the cache.
pub fn query_hash(query: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(query.trim().as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// HTTP layer behind a trait so tests can inject a recording mock without
/// running a real Ollama server.
pub(crate) trait HttpClient: Send + Sync {
    fn post_json(&self, url: &str, body: Value) -> Result<Value>;
}

/// Default `ureq`-backed client.
struct UreqClient {
    agent: ureq::Agent,
}

impl UreqClient {
    fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(60))
                .build(),
        }
    }
}

impl HttpClient for UreqClient {
    fn post_json(&self, url: &str, body: Value) -> Result<Value> {
        match self.agent.post(url).send_json(body) {
            Ok(resp) => {
                let value: Value = resp.into_json().map_err(|e| IndexerError::OllamaApi {
                    status: 0,
                    body: format!("invalid JSON from {url}: {e}"),
                })?;
                Ok(value)
            }
            Err(ureq::Error::Status(status, resp)) => {
                let body = resp
                    .into_string()
                    .unwrap_or_else(|e| format!("<failed to read body: {e}>"));
                Err(IndexerError::OllamaApi { status, body })
            }
            Err(other) => Err(IndexerError::Http(Box::new(other))),
        }
    }
}

/// The reranker. Holds an Ollama base URL, the model name, and a cache.
pub struct Reranker {
    base_url: String,
    model: String,
    cache: Box<dyn RerankCache>,
    http: Box<dyn HttpClient>,
}

impl Reranker {
    pub fn new(
        base_url: impl Into<String>,
        model: impl Into<String>,
        cache: Box<dyn RerankCache>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            model: model.into(),
            cache,
            http: Box::new(UreqClient::new()),
        }
    }

    /// Test/integration constructor that lets callers swap the HTTP layer.
    #[doc(hidden)]
    pub(crate) fn new_with_http(
        base_url: impl Into<String>,
        model: impl Into<String>,
        cache: Box<dyn RerankCache>,
        http: Box<dyn HttpClient>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            model: model.into(),
            cache,
            http,
        }
    }

    /// Rerank `candidates` for `query`. Returns the top `top_k` by descending
    /// score. Cache hits are filled first; misses are sent to Ollama in one
    /// batched call.
    ///
    /// We don't retry on failure: callers (the query loop) get to decide
    /// whether to retry, and tests stay deterministic.
    pub fn rerank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
    ) -> Result<Vec<RankedCandidate>> {
        if candidates.is_empty() || top_k == 0 {
            return Ok(Vec::new());
        }

        let qhash = query_hash(query);

        // Partition into cache hits and misses, preserving input order for
        // misses so the response array maps cleanly back to chunk_ids.
        let mut results: Vec<RankedCandidate> = Vec::with_capacity(candidates.len());
        let mut miss_indices: Vec<usize> = Vec::new();
        for (i, c) in candidates.iter().enumerate() {
            if let Some(score) = self.cache.get(&qhash, &c.chunk_hash) {
                results.push(RankedCandidate {
                    chunk_id: c.chunk_id,
                    score,
                    from_cache: true,
                });
            } else {
                miss_indices.push(i);
            }
        }

        if !miss_indices.is_empty() {
            let documents: Vec<&str> = miss_indices
                .iter()
                .map(|&i| candidates[i].text.as_str())
                .collect();

            let url = format!("{}/api/rerank", self.base_url.trim_end_matches('/'));
            let body = json!({
                "model": self.model,
                "query": query,
                "documents": documents,
            });

            let response = self.http.post_json(&url, body).map_err(|e| match e {
                IndexerError::OllamaApi { status, body } => IndexerError::OllamaApi {
                    status,
                    body: format!("model={} endpoint=/api/rerank: {}", self.model, body),
                },
                other => other,
            })?;

            let scored = parse_rerank_response(&response, miss_indices.len(), &self.model)?;

            for (slot, score) in scored.into_iter().enumerate() {
                let original_idx = miss_indices[slot];
                let candidate = &candidates[original_idx];
                self.cache.put(&qhash, &candidate.chunk_hash, score);
                results.push(RankedCandidate {
                    chunk_id: candidate.chunk_id,
                    score,
                    from_cache: false,
                });
            }
        }

        // Sort descending by score; total_cmp keeps NaNs ordered deterministically.
        results.sort_by(|a, b| b.score.total_cmp(&a.score));
        results.truncate(top_k);
        Ok(results)
    }
}

/// Parse `{"results": [{"index": N, "relevance_score": F}, ...]}` into a
/// score-per-input-document vector, indexed by the request's `documents` order.
fn parse_rerank_response(value: &Value, expected: usize, model: &str) -> Result<Vec<f32>> {
    let arr = value
        .get("results")
        .and_then(|v| v.as_array())
        .ok_or_else(|| IndexerError::OllamaApi {
            status: 200,
            body: format!(
                "model={model} endpoint=/api/rerank: response missing `results` array; got {value}"
            ),
        })?;

    if arr.len() != expected {
        return Err(IndexerError::OllamaApi {
            status: 200,
            body: format!(
                "model={model} endpoint=/api/rerank: expected {expected} results, got {}",
                arr.len()
            ),
        });
    }

    let mut scores = vec![f32::NAN; expected];
    for entry in arr {
        let idx =
            entry
                .get("index")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| IndexerError::OllamaApi {
                    status: 200,
                    body: format!(
                        "model={model} endpoint=/api/rerank: result entry missing `index`: {entry}"
                    ),
                })? as usize;
        let score = entry
            .get("relevance_score")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| IndexerError::OllamaApi {
                status: 200,
                body: format!(
                    "model={model} endpoint=/api/rerank: result entry missing `relevance_score`: {entry}"
                ),
            })? as f32;
        if idx >= expected {
            return Err(IndexerError::OllamaApi {
                status: 200,
                body: format!(
                    "model={model} endpoint=/api/rerank: result index {idx} out of range (expected < {expected})"
                ),
            });
        }
        scores[idx] = score;
    }

    if scores.iter().any(|s| s.is_nan()) {
        return Err(IndexerError::OllamaApi {
            status: 200,
            body: format!(
                "model={model} endpoint=/api/rerank: response did not cover every input index"
            ),
        });
    }

    Ok(scores)
}

// ---- Test helpers ----------------------------------------------------------
//
// The HttpClient trait is private to the module; tests in `tests/reranker.rs`
// need a way to construct a Reranker with a mock. We expose a thin builder
// behind `#[doc(hidden)]` items in a public submodule gated on `cfg(test)`-ish
// integration use. Keeping it gated on a feature would force callers to
// enable it; instead we just expose a public `MockHttp` struct + helpers
// behind `pub mod test_support`. This stays out of the documented API surface
// (#[doc(hidden)]) and is what `tests/reranker.rs` consumes.

#[doc(hidden)]
pub mod test_support {
    //! Test-only helpers. Not part of the stable API.

    use std::sync::Mutex;

    use serde_json::Value;

    use super::{HttpClient, RerankCache, Reranker};
    use crate::error::Result;

    pub type ResponseFn = Box<dyn FnMut(&str, &Value) -> Result<Value> + Send>;

    /// Recording mock HTTP client.
    pub struct MockHttp {
        pub calls: Mutex<Vec<(String, Value)>>,
        pub response: Mutex<ResponseFn>,
    }

    impl MockHttp {
        pub fn new<F>(handler: F) -> Self
        where
            F: FnMut(&str, &Value) -> Result<Value> + Send + 'static,
        {
            Self {
                calls: Mutex::new(Vec::new()),
                response: Mutex::new(Box::new(handler)),
            }
        }

        pub fn call_count(&self) -> usize {
            self.calls.lock().map(|c| c.len()).unwrap_or(0)
        }

        pub fn last_call(&self) -> Option<(String, Value)> {
            self.calls.lock().ok().and_then(|c| c.last().cloned())
        }
    }

    impl HttpClient for MockHttp {
        fn post_json(&self, url: &str, body: Value) -> Result<Value> {
            if let Ok(mut calls) = self.calls.lock() {
                calls.push((url.to_string(), body.clone()));
            }
            let mut handler = self
                .response
                .lock()
                .expect("mock handler mutex poisoned in test");
            (handler)(url, &body)
        }
    }

    /// Build a `Reranker` wired to a `MockHttp` client.
    pub fn reranker_with_mock(
        base_url: &str,
        model: &str,
        cache: Box<dyn RerankCache>,
        mock: std::sync::Arc<MockHttp>,
    ) -> Reranker {
        // We can't move out of the Arc, so wrap it in an adapter.
        struct ArcAdapter(std::sync::Arc<MockHttp>);
        impl HttpClient for ArcAdapter {
            fn post_json(&self, url: &str, body: Value) -> Result<Value> {
                self.0.post_json(url, body)
            }
        }
        Reranker::new_with_http(base_url, model, cache, Box::new(ArcAdapter(mock)))
    }
}
