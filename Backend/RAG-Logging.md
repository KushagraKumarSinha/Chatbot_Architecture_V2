# RAG Chat Application — Logging Schema

This document describes the structured log events emitted across the RAG pipeline, from request intake through final answer generation.

---

## A. Request Entry and Validation

| Field | Description |
|---|---|
| `request_id` | Unique identifier for the request |
| `trace_id` | Identifier for correlating logs across the full trace |
| `user_id` | Identifier of the requesting user |
| `conversation_id` | Identifier of the conversation/session |
| `message_length` | Length of the incoming user message |
| `history_count` | Number of prior messages in conversation history |
| `suspicious_content_flagged` | Whether the input was flagged as suspicious |
| `input_moderation_checked` | Whether input moderation was run |
| `input_moderation_flagged` | Whether input moderation flagged the content |
| `status` | Outcome status of the request |
| `duration_ms` | Total request duration in milliseconds |

---

## B. Classify and Rewrite

**`operation`**: `classify_and_rewrite`

| Field | Description |
|---|---|
| `model` | Model used — `gpt-4o-mini` |
| `is_ml_related` | Whether the query was classified as ML-related |
| `rewritten_query_length` | Character length of the rewritten query |
| `rewritten_query_hash` | Hash of the rewritten query (for cache correlation) |
| `history_message_count` | Number of history messages considered |
| `duration_ms` | Duration of this step |
| `input_tokens` | Prompt tokens consumed |
| `output_tokens` | Completion tokens produced |
| `total_tokens` | Total tokens consumed |
| `retry_count` | Number of retries performed |
| `parse_success` | Whether the model output parsed successfully |
| `fallback_used` | Whether a fallback path was triggered |
| `error_type` | Type of error, if any |
| `error_status` | Status code associated with the error, if any |

---

## C. Embedding Creation

**`operation`**: `embedding`

| Field | Description |
|---|---|
| `model` | Model used — `text-embedding-3-small` |
| `input_length` | Length of the text embedded |
| `embedding_dimensions` | Dimensionality of the resulting embedding |
| `duration_ms` | Duration of this step |
| `retry_count` | Number of retries performed |
| `status` | Outcome status |
| `error_type` | Type of error, if any |

---

## D. Semantic Cache

| Field | Description |
|---|---|
| `operation` | Operation name for this step |
| `cache_enabled` | Whether semantic caching is enabled |
| `cache_hit` | Whether a cache hit occurred |
| `cache_miss_reason` | Reason for a miss (e.g. `below_threshold`) |
| `similarity_score` | Similarity score of the closest match |
| `similarity_threshold` | Threshold required for a hit |
| `cache_entry_id` | Identifier of the matched cache entry |
| `cache_age_ms` | Age of the matched cache entry in milliseconds |
| `duration_ms` | Duration of this step |

---

## E. Hybrid Search

**`operation`**: `hybrid_search`

| Field | Description |
|---|---|
| `query_hash` | Hash of the query used for search |
| `match_count_requested` | Number of matches requested — `20` |
| `candidate_count_returned` | Number of candidates actually returned |
| `duration_ms` | Duration of this step |
| `top_candidate_ids` | IDs of the top-ranked candidates |
| `top_candidate_scores` | Scores of the top-ranked candidates |
| `document_version` / `knowledge_base_version` | Version of the document or knowledge base searched |
| `rpc_error` | RPC error, if any |
| `status` | Outcome status |

---

## F. Reranking

| Field | Description |
|---|---|
| `candidate_count` | Number of candidates passed in for reranking |
| `rerank_top_n` | Number of top results requested from reranking |
| `reranked_ids` | IDs of the reranked results |
| `reranked_count` | Number of results returned after reranking |
| `fallback_used` | Whether a fallback path was triggered |
| `fallback_reason` | Reason fallback was triggered, if applicable |
| `duration_ms` | Duration of this step |
| `model` | Reranking model used |
| `input_tokens` | Prompt tokens consumed |
| `output_tokens` | Completion tokens produced |
| `retry_count` | Number of retries performed |
| `parse_success` | Whether the reranker output parsed successfully |

---

## G. Final Answer Generation

**`operation`**: `generate_grounded_answer`

| Field | Description |
|---|---|
| `model` | Model used for generation |
| `context_chunk_count` | Number of context chunks used |
| `context_length` | Total length of the assembled context |
| `context_document_ids` | IDs of source documents included in context |
| `rewritten_query_hash` | Hash of the rewritten query used for generation |
| `input_tokens` | Prompt tokens consumed |
| `output_tokens` | Completion tokens produced |
| `total_tokens` | Total tokens consumed |
| `duration_ms` | Duration of this step |
| `retry_count` | Number of retries performed |
| `answer_length` | Length of the generated answer |
| `cache_write_eligible` | Whether the answer is eligible to be written to cache |
| `moderation_checked` | Whether output moderation was run |
| `moderation_flagged` | Whether output moderation flagged the content |

---

## Example Log Trace

```json
{"event":"request_started","request_id":"req_abc123","trace_id":"trace_xyz789","conversation_id":"conv_456","message_length":48,"history_count":4}
{"event":"classify_rewrite_completed","request_id":"req_abc123","model":"gpt-4o-mini","is_ml_related":true,"rewritten_query_length":48,"duration_ms":320,"input_tokens":450,"output_tokens":32,"total_tokens":482}
{"event":"embedding_completed","request_id":"req_abc123","model":"text-embedding-3-small","embedding_dimensions":1536,"duration_ms":180}
{"event":"cache_lookup_completed","request_id":"req_abc123","cache_hit":false,"cache_miss_reason":"below_threshold","similarity_score":0.87,"duration_ms":42}
{"event":"hybrid_search_completed","request_id":"req_abc123","candidate_count":20,"duration_ms":95,"top_candidate_ids":[12,45,78]}
{"event":"rerank_completed","request_id":"req_abc123","candidate_count":20,"reranked_count":5,"fallback_used":false,"duration_ms":410}
{"event":"answer_generation_completed","request_id":"req_abc123","context_chunk_count":5,"duration_ms":850,"input_tokens":1200,"output_tokens":180,"total_tokens":1380}
{"event":"request_completed","request_id":"req_abc123","status":200,"duration_ms":1920,"path":"ml_rag","cache_hit":false}
```
