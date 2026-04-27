//! Integration tests for `indexer::reranker`.
//!
//! Every assertion runs against a recording mock HTTP client; no real Ollama
//! is required. One `#[ignore]` smoke test at the bottom hits a local server
//! if you want to exercise the wire format end-to-end.

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use indexer::error::IndexerError;
use indexer::reranker::test_support::{reranker_with_mock, MockHttp};
use indexer::reranker::{query_hash, Candidate, InMemoryCache, RerankCache, Reranker};
use serde_json::{json, Value};

fn cand(id: u64, hash: &str, text: &str) -> Candidate {
    Candidate {
        chunk_id: id,
        chunk_hash: hash.to_string(),
        text: text.to_string(),
    }
}

#[test]
fn cache_hit_path_short_circuits_http() {
    let cache = Arc::new(InMemoryCache::new(100, Duration::from_secs(60)));
    let qh = query_hash("what is foo?");
    cache.put(&qh, "h1", 0.9);
    cache.put(&qh, "h2", 0.4);

    // Move ownership of cache into reranker by re-wrapping. Use a fresh box.
    let cache_for_reranker: Box<dyn RerankCache> = {
        struct Shared(Arc<InMemoryCache>);
        impl RerankCache for Shared {
            fn get(&self, q: &str, c: &str) -> Option<f32> {
                self.0.get(q, c)
            }
            fn put(&self, q: &str, c: &str, s: f32) {
                self.0.put(q, c, s);
            }
        }
        Box::new(Shared(cache.clone()))
    };

    let mock = Arc::new(MockHttp::new(|_url, _body| {
        panic!("HTTP must not be called when every candidate is cached");
    }));
    let reranker = reranker_with_mock(
        "http://localhost:11434",
        "bge-reranker-v2-m3",
        cache_for_reranker,
        mock.clone(),
    );

    let candidates = vec![cand(1, "h1", "alpha"), cand(2, "h2", "beta")];
    let out = reranker
        .rerank("what is foo?", &candidates, 5)
        .expect("rerank ok");

    assert_eq!(out.len(), 2);
    assert!(out.iter().all(|r| r.from_cache));
    assert_eq!(mock.call_count(), 0);
    // Top-k ordering by descending score.
    assert_eq!(out[0].chunk_id, 1);
    assert_eq!(out[1].chunk_id, 2);
}

#[test]
fn mixed_hit_and_miss_only_sends_uncached_documents() {
    let cache = Box::new(InMemoryCache::new(100, Duration::from_secs(60)));
    let qh = query_hash("q");
    cache.put(&qh, "h1", 0.10);
    cache.put(&qh, "h3", 0.30);

    // Mock returns increasing scores per index in the documents array.
    let mock = Arc::new(MockHttp::new(|url, body| {
        assert!(url.ends_with("/api/rerank"), "unexpected url: {url}");
        let docs = body
            .get("documents")
            .and_then(Value::as_array)
            .expect("documents array");
        // Should be exactly the three uncached chunks, in input order.
        let texts: Vec<&str> = docs.iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(texts, vec!["t2", "t4", "t5"]);
        Ok(json!({
            "results": [
                {"index": 0, "relevance_score": 0.5},
                {"index": 1, "relevance_score": 0.7},
                {"index": 2, "relevance_score": 0.2}
            ]
        }))
    }));

    let reranker = reranker_with_mock("http://x", "bge-reranker-v2-m3", cache, mock.clone());
    let candidates = vec![
        cand(1, "h1", "t1"),
        cand(2, "h2", "t2"),
        cand(3, "h3", "t3"),
        cand(4, "h4", "t4"),
        cand(5, "h5", "t5"),
    ];
    let out = reranker.rerank("q", &candidates, 5).expect("rerank ok");
    assert_eq!(mock.call_count(), 1);
    assert_eq!(out.len(), 5);

    // Stitch by chunk_id; check that chunk 4 -> 0.7, chunk 2 -> 0.5, chunk 5 -> 0.2,
    // and the cached ones kept their values.
    let by_id: std::collections::HashMap<u64, &indexer::reranker::RankedCandidate> =
        out.iter().map(|r| (r.chunk_id, r)).collect();
    assert!((by_id[&1].score - 0.10).abs() < 1e-6);
    assert!(by_id[&1].from_cache);
    assert!((by_id[&2].score - 0.5).abs() < 1e-6);
    assert!(!by_id[&2].from_cache);
    assert!((by_id[&3].score - 0.30).abs() < 1e-6);
    assert!(by_id[&3].from_cache);
    assert!((by_id[&4].score - 0.7).abs() < 1e-6);
    assert!(!by_id[&4].from_cache);
    assert!((by_id[&5].score - 0.2).abs() < 1e-6);
    assert!(!by_id[&5].from_cache);

    // Sorted descending: 4 (0.7), 2 (0.5), 3 (0.30), 1 (0.10), 5 (0.2)... wait, 5 is 0.2 < 0.30 < 0.5.
    // Order: 0.7, 0.5, 0.30, 0.2, 0.10 -> ids 4, 2, 3, 5, 1
    let ids: Vec<u64> = out.iter().map(|r| r.chunk_id).collect();
    assert_eq!(ids, vec![4, 2, 3, 5, 1]);
}

#[test]
fn top_k_truncates_and_sorts_descending() {
    let cache = Box::new(InMemoryCache::new(100, Duration::from_secs(60)));
    let mock = Arc::new(MockHttp::new(|_url, body| {
        let docs = body
            .get("documents")
            .and_then(Value::as_array)
            .expect("documents");
        // Score = index (so higher index => higher score) but shuffled in response.
        let mut results: Vec<Value> = (0..docs.len())
            .map(|i| json!({"index": i, "relevance_score": i as f64 * 0.1}))
            .collect();
        results.reverse();
        Ok(json!({"results": results}))
    }));
    let reranker = reranker_with_mock("http://x", "m", cache, mock);
    let candidates: Vec<Candidate> = (0..10)
        .map(|i| cand(i as u64, &format!("h{i}"), &format!("t{i}")))
        .collect();
    let out = reranker.rerank("q", &candidates, 3).expect("rerank ok");
    assert_eq!(out.len(), 3);
    assert!(out[0].score >= out[1].score);
    assert!(out[1].score >= out[2].score);
    assert_eq!(out[0].chunk_id, 9);
    assert_eq!(out[1].chunk_id, 8);
    assert_eq!(out[2].chunk_id, 7);
}

#[test]
fn cache_ttl_expiry_drops_stale_entries() {
    let cache = InMemoryCache::new(100, Duration::from_millis(50));
    cache.put("q", "c", 0.42);
    assert_eq!(cache.get("q", "c"), Some(0.42));
    thread::sleep(Duration::from_millis(80));
    assert_eq!(cache.get("q", "c"), None);
}

#[test]
fn cache_lru_eviction_removes_oldest() {
    let cache = InMemoryCache::new(2, Duration::from_secs(60));
    cache.put("q", "a", 1.0);
    cache.put("q", "b", 2.0);
    cache.put("q", "c", 3.0); // should evict "a"
    assert_eq!(cache.get("q", "a"), None);
    assert_eq!(cache.get("q", "b"), Some(2.0));
    assert_eq!(cache.get("q", "c"), Some(3.0));
}

#[test]
fn ollama_api_error_surfaces_status_and_body() {
    let cache = Box::new(InMemoryCache::new(100, Duration::from_secs(60)));
    let mock = Arc::new(MockHttp::new(|_url, _body| {
        Err(IndexerError::OllamaApi {
            status: 404,
            body: r#"{"error":"model not found"}"#.to_string(),
        })
    }));
    let reranker = reranker_with_mock("http://x", "bge-reranker-v2-m3", cache, mock);
    let candidates = vec![cand(1, "h1", "t1")];
    let err = reranker.rerank("q", &candidates, 5).expect_err("must err");
    match err {
        IndexerError::OllamaApi { status, body } => {
            assert_eq!(status, 404);
            assert!(body.contains("model not found"), "body was: {body}");
            assert!(body.contains("bge-reranker-v2-m3"), "body was: {body}");
            assert!(body.contains("/api/rerank"), "body was: {body}");
        }
        other => panic!("expected OllamaApi, got {other:?}"),
    }
}

#[test]
fn empty_inputs_short_circuit() {
    let cache = Box::new(InMemoryCache::new(100, Duration::from_secs(60)));
    let mock = Arc::new(MockHttp::new(|_, _| panic!("must not call HTTP")));
    let reranker = reranker_with_mock("http://x", "m", cache, mock.clone());

    let out = reranker.rerank("q", &[], 5).expect("ok");
    assert!(out.is_empty());

    let cs = vec![cand(1, "h", "t")];
    let out = reranker.rerank("q", &cs, 0).expect("ok");
    assert!(out.is_empty());
    assert_eq!(mock.call_count(), 0);
}

/// Smoke test against a locally running Ollama. Ignored by default so CI
/// doesn't depend on an external service.
#[test]
#[ignore]
fn smoke_local_ollama() {
    let cache = Box::new(InMemoryCache::new(100, Duration::from_secs(60)));
    let r = Reranker::new("http://localhost:11434", "bge-reranker-v2-m3", cache);
    let candidates = vec![
        cand(1, "h1", "Rust is a systems programming language."),
        cand(2, "h2", "Bananas grow on trees in tropical climates."),
    ];
    let out = r
        .rerank("What is Rust?", &candidates, 2)
        .expect("local Ollama smoke");
    assert_eq!(out.len(), 2);
    assert!(out[0].score >= out[1].score);
}
