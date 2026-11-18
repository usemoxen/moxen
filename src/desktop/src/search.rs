//! Full-text thread search: what the server's `threads.search` query found,
//! in the order it sends it (active threads first, then settled ones). The
//! query and the decoding follow `src/core/threads/search.ts`; the sections
//! and the row words follow the TUI's search picker (`src/tui/app/app.tsx`).

use serde_json::Value;

/// One matching item: the title, a message, a tool row or another activity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub kind: String,
    pub snippet: String,
    /// Who said it (`user`, `assistant`) for a message; the tool name for a
    /// tool row; empty otherwise.
    pub source: String,
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// The `where` of a row: the title for a title hit, the tool name or role
/// otherwise, as the TUI's search picker says it.
pub fn hit_where(hit: &SearchHit) -> String {
    match hit.kind.as_str() {
        "title" => "title".to_string(),
        "tool" => {
            if hit.source.is_empty() {
                "tool".to_string()
            } else {
                hit.source.clone()
            }
        }
        "message" => {
            if hit.source.is_empty() {
                "message".to_string()
            } else {
                hit.source.clone()
            }
        }
        _ => hit.kind.clone(),
    }
}

fn decode_hit(hit: &Value) -> Option<SearchHit> {
    Some(SearchHit {
        kind: text(&hit["kind"]).to_string(),
        snippet: text(&hit["snippet"]).to_string(),
        source: text(&hit["source"]).to_string(),
    })
}

/// One thread of the answer, with its project, title and match count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchResult {
    /// The thread's id on the wire.
    pub uuid: String,
    pub project_id: String,
    pub title: String,
    /// True for a settled thread: it goes under "Settled", the rest under
    /// "Active".
    pub settled: bool,
    /// How many items matched, which can exceed `hits.len()`.
    pub hit_count: usize,
    pub hits: Vec<SearchHit>,
}

/// The row's second line: `where: snippet`, with ` (+N)` when more items
/// matched than the row lists.
pub fn hit_meta(hit: &SearchHit, hit_count: usize) -> String {
    let more = if hit_count > 1 {
        format!(" (+{})", hit_count - 1)
    } else {
        String::new()
    };
    format!("{}: {}{}", hit_where(hit), hit.snippet, more)
}

fn decode_result(thread: &Value) -> Option<SearchResult> {
    let hits: Vec<SearchHit> = thread["hits"]
        .as_array()?
        .iter()
        .filter_map(decode_hit)
        .collect();
    Some(SearchResult {
        uuid: text(&thread["threadId"]).to_string(),
        project_id: text(&thread["projectId"]).to_string(),
        title: text(&thread["title"]).to_string(),
        settled: text(&thread["status"]) == "settled",
        hit_count: thread["hitCount"].as_u64().unwrap_or(hits.len() as u64) as usize,
        hits,
    })
}

fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

/// What a search for `query` answered.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchResults {
    pub query: String,
    pub total: usize,
    pub threads: Vec<SearchResult>,
}

impl SearchResults {
    pub fn decode(query: &str, value: &Value) -> Option<Self> {
        let threads: Vec<SearchResult> = value["threads"]
            .as_array()?
            .iter()
            .filter_map(decode_result)
            .filter(|result| nonempty(&result.uuid).is_some() && !result.title.is_empty())
            .collect();
        Some(Self {
            query: query.to_string(),
            total: value["total"].as_u64().unwrap_or(threads.len() as u64) as usize,
            threads,
        })
    }

    pub fn active(&self) -> Vec<&SearchResult> {
        self.threads.iter().filter(|row| !row.settled).collect()
    }

    pub fn settled(&self) -> Vec<&SearchResult> {
        self.threads.iter().filter(|row| row.settled).collect()
    }
}

/// Whether a search is in flight, failed, or has an answer for the palette.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SearchState {
    #[default]
    Idle,
    Loading(String),
    Error(String),
    Done(SearchResults),
}

#[cfg(test)]
mod tests {
    use super::{SearchResults, hit_meta};
    use serde_json::json;

    fn answered() -> SearchResults {
        SearchResults::decode(
            "encoder",
            &json!({
                "query": "encoder",
                "threads": [{
                    "threadId": "t1", "projectId": "p", "title": "Fix the encoder",
                    "status": "active", "updatedAt": "2026-11-16T10:00:00Z",
                    "hitCount": 2,
                    "hits": [{"kind": "message", "snippet": "…the encoder stalls…", "source": "user", "turnId": null, "at": null}],
                }, {
                    "threadId": "t2", "projectId": "p", "title": "Old attempt",
                    "status": "settled", "updatedAt": null,
                    "hitCount": 1,
                    "hits": [{"kind": "title", "snippet": "Old attempt", "source": null, "turnId": null, "at": null}],
                }],
                "total": 2,
            }),
        )
        .expect("answer")
    }

    #[test]
    fn decodes_threads_active_first_with_their_counts() {
        let found = answered();
        assert_eq!(found.query, "encoder");
        assert_eq!(found.total, 2);
        assert_eq!(found.active().len(), 1);
        assert_eq!(found.settled().len(), 1);
        assert_eq!(found.threads[0].uuid, "t1");
        assert_eq!(found.threads[0].hit_count, 2);
    }

    #[test]
    fn a_row_says_where_it_matched_and_how_many_more() {
        let found = answered();
        assert_eq!(
            hit_meta(&found.threads[0].hits[0], found.threads[0].hit_count),
            "user: …the encoder stalls… (+1)"
        );
        assert_eq!(hit_meta(&found.threads[1].hits[0], 1), "title: Old attempt");
    }

    #[test]
    fn a_tool_hit_names_its_tool() {
        let found = SearchResults::decode(
            "q",
            &serde_json::json!({
                "threads": [{
                    "threadId": "t", "projectId": "p", "title": "T", "status": "active",
                    "hitCount": 1,
                    "hits": [{"kind": "tool", "snippet": "cargo test", "source": "Bash", "turnId": null, "at": null}],
                }],
                "total": 1,
            }),
        )
        .expect("answer");
        assert_eq!(hit_meta(&found.threads[0].hits[0], 1), "Bash: cargo test");
    }

    #[test]
    fn rows_without_a_title_are_left_out() {
        let found = SearchResults::decode(
            "q",
            &json!({
                "threads": [{
                    "threadId": "t", "projectId": "p", "title": "", "status": "active",
                    "hitCount": 1,
                    "hits": [{"kind": "title", "snippet": "q", "source": null, "turnId": null, "at": null}],
                }],
                "total": 1,
            }),
        )
        .expect("answer");
        assert!(found.threads.is_empty());
    }
}
