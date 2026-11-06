//! Bounded search over Statewright's public documentation index.

use std::{
    collections::HashSet,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const INDEX_URL: &str = "https://docs.statewright.ai/search-index.json";
const MAX_INDEX_BYTES: usize = 1_000_000;
const CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_RESULTS: usize = 5;

#[derive(Clone, Deserialize)]
struct DocChunk {
    url: String,
    title: String,
    section: String,
    content: String,
}

#[derive(Serialize)]
struct SearchHit {
    url: String,
    title: String,
    section: String,
    snippet: String,
}

struct CachedIndex {
    fetched_at: Instant,
    chunks: Arc<Vec<DocChunk>>,
}

static INDEX_CACHE: OnceLock<Mutex<Option<CachedIndex>>> = OnceLock::new();

fn canonical_url(path: &str) -> Option<String> {
    if path == "/workflow-schema.json" {
        return Some("https://statewright.ai/workflow-schema.json".into());
    }
    let slug = path.strip_prefix("/docs/")?;
    if slug.is_empty()
        || slug
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || !slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_'))
    {
        return None;
    }
    Some(format!("https://docs.statewright.ai/{slug}/"))
}

fn search_chunks(chunks: &[DocChunk], query: &str) -> Vec<SearchHit> {
    let terms: Vec<String> = query
        .split_whitespace()
        .take(8)
        .map(str::to_ascii_lowercase)
        .collect();
    let mut ranked: Vec<(usize, &DocChunk, String)> = chunks
        .iter()
        .filter_map(|chunk| {
            let url = canonical_url(&chunk.url)?;
            let title = chunk.title.to_ascii_lowercase();
            let section = chunk.section.to_ascii_lowercase();
            let content = chunk.content.to_ascii_lowercase();
            let score = terms
                .iter()
                .map(|term| {
                    usize::from(title.contains(term)) * 3
                        + usize::from(section.contains(term)) * 3
                        + usize::from(content.contains(term))
                })
                .sum();
            (score > 0).then_some((score, chunk, url))
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.title.cmp(&b.1.title)));

    let mut seen = HashSet::new();
    ranked
        .into_iter()
        .filter(|(_, chunk, url)| seen.insert((url.clone(), chunk.section.clone())))
        .take(MAX_RESULTS)
        .map(|(_, chunk, url)| SearchHit {
            url,
            title: chunk.title.clone(),
            section: chunk.section.clone(),
            snippet: chunk.content.chars().take(500).collect(),
        })
        .collect()
}

async fn fetch_index() -> Result<Vec<DocChunk>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Documentation search client unavailable".to_string())?;
    let mut response = client
        .get(INDEX_URL)
        .send()
        .await
        .map_err(|_| "Documentation search index unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("Documentation search index unavailable".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Documentation search index unavailable".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > MAX_INDEX_BYTES {
            return Err("Documentation search index exceeded size limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "Documentation search index invalid".into())
}

pub async fn search(query: &str) -> Result<serde_json::Value, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 200 {
        return Err("query must contain 1 to 200 characters".into());
    }
    let cache = INDEX_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().await;
    let chunks = if let Some(current) = guard
        .as_ref()
        .filter(|index| index.fetched_at.elapsed() < CACHE_TTL)
    {
        current.chunks.clone()
    } else {
        let chunks = Arc::new(fetch_index().await?);
        *guard = Some(CachedIndex {
            fetched_at: Instant::now(),
            chunks: chunks.clone(),
        });
        chunks
    };
    drop(guard);
    Ok(serde_json::json!({ "results": search_chunks(&chunks, query) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docs_urls_resolve_to_the_docs_host_and_reject_untrusted_paths() {
        assert_eq!(
            canonical_url("/docs/workflows/create-your-own"),
            Some("https://docs.statewright.ai/workflows/create-your-own/".into())
        );
        assert_eq!(
            canonical_url("/workflow-schema.json"),
            Some("https://statewright.ai/workflow-schema.json".into())
        );
        assert_eq!(canonical_url("/docs/../admin"), None);
        assert_eq!(canonical_url("https://example.com/"), None);
    }

    #[test]
    fn authoring_query_returns_a_bounded_canonical_result() {
        let chunks = vec![
            DocChunk {
                url: "/docs/workflows/create-your-own".into(),
                title: "Create Your Own Workflow".into(),
                section: "Create Your Own Workflow".into(),
                content: "Build a workflow from phases and transitions.".into(),
            },
            DocChunk {
                url: "/docs/plugins/codex".into(),
                title: "Codex".into(),
                section: "Install".into(),
                content: "Install the plugin.".into(),
            },
        ];
        let hits = search_chunks(&chunks, "create workflow");
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].url,
            "https://docs.statewright.ai/workflows/create-your-own/"
        );
    }

    #[tokio::test]
    #[ignore = "requires the public Statewright documentation index"]
    async fn live_index_search_returns_a_working_authoring_url() {
        let result = search("create workflow").await.unwrap();
        let hits = result["results"].as_array().unwrap();
        let url = hits
            .iter()
            .find_map(|hit| {
                (hit["url"] == "https://docs.statewright.ai/workflows/create-your-own/")
                    .then(|| hit["url"].as_str().unwrap())
            })
            .expect("authoring guide result");
        let response = reqwest::get(url).await.unwrap();
        assert!(response.status().is_success());
        assert!(
            response
                .text()
                .await
                .unwrap()
                .contains("Create Your Own Workflow")
        );
    }
}
