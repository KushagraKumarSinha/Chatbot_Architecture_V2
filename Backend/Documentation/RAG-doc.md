# Hybrid RAG Chat Pipeline — Technical Documentation

This document covers two files that together implement a support-chat backend with retrieval-augmented generation (RAG):

- **`chatConversation` handler** (Deno/TypeScript) — the request pipeline: validation, classification, retrieval, reranking, generation, caching, logging.
- **Postgres schema** (SQL) — storage for documents, hybrid search (`hybrid_search()` RPC), query-rewrite audit log, and retrieval-quality eval tables.

---

## 1. High-Level Flow

Two branches exist after classification:
- **General branch** — no retrieval, no cache, plain conversational reply.
- **ML/RAG branch** — embed → cache check → (on miss) hybrid search → rerank → grounded answer → moderation → conditional cache write.

Every stage emits a structured JSON log line via `logEvent()`, tied together by `request_id`/`trace_id`.

---

## 2. Configuration Constants

| Constant | Purpose |
|---|---|
| `MAX_MESSAGE_LENGTH` (4000) | Hard cap on incoming user message size. |
| `MAX_HISTORY_MESSAGES` (10) | Total turns (prior + current) fed to the LLM. |
| `MAX_REWRITTEN_QUERY_LENGTH` (2000) | Defensive truncation of the LLM-produced rewrite before it's embedded/cached/logged. |
| `HYBRID_MATCH_COUNT` (20) | Candidates requested from `hybrid_search()`. |
| `RERANK_TOP_N` (5) | Max chunks kept after reranking. |
| `RERANK_SNIPPET_LENGTH` (800) | Chars of each candidate shown to the reranker. |
| `CHAT_MODEL` / `EMBEDDING_MODEL` | `gpt-4o-mini` / `text-embedding-3-small`. |
| `UUID_RE` | Validates `conversation_id` format. |
| `KNOWLEDGE_BASE_VERSION` | Env-driven tag stamped on search logs, for correlating quality regressions with reindex runs. |
| `SERVICE_NAME`, `DEPLOY_ENV`, `SERVICE_VERSION`, `REGION` | Stamped onto every log line for aggregator filtering. |
| `MAX_TRACE_ID_LENGTH` / `TRACE_ID_RE` | Bounds + charset-restricts a client-supplied trace id before trusting it in logs. |
| `MAX_LOGGED_ERROR_LENGTH` (300) | Truncates upstream error text before logging. |
| `VERBOSE_LOG_SAMPLE_RATE` | Fraction of high-volume "stage completed" logs kept; failures and summary lines are always logged regardless. |
| `OPENAI_TIMEOUT_MS` / `OPENAI_MAX_RETRIES` / `OPENAI_RETRY_BASE_DELAY_MS` | Fetch timeout + exponential-backoff retry tuning for OpenAI calls. |
| `RETRYABLE_STATUS_CODES` | `{408,409,429,500,502,503,504}` — only these are retried. |
| `CACHE_SIMILARITY_THRESHOLD` (0.92) | Minimum cosine similarity for a cache hit. |
| `CACHE_TTL_MS` (24h) | App-enforced cache expiry (Upstash has no native TTL here). |
| `UPSTASH_TIMEOUT_MS` / `UPSTASH_MAX_RETRIES` / `UPSTASH_RETRYABLE_STATUS_CODES` | Same resilience pattern, separate allowlist for the cache backend. |

---

## 3. System Prompts

| Prompt | Role |
|---|---|
| `GENERAL_SYSTEM_PROMPT` | Non-ML conversational replies. Instructs the model to treat user content as untrusted, ignore embedded instructions, refuse to claim real-world actions. |
| `CLASSIFY_AND_REWRITE_SYSTEM_PROMPT` | Single call that both classifies ("is this ML-related?") and rewrites the message into a standalone search query. Merging these two used-to-be-sequential calls removes one network round trip per turn. Always returns a `rewritten_query`, even for non-ML messages — cheap to generate, simply unused on that path. |
| `RERANK_SYSTEM_PROMPT` | Given a query + numbered candidate snippets, returns `{"ranked_ids":[...]}`, best match first, capped at `RERANK_TOP_N`. |
| `ANSWER_SYSTEM_PROMPT` | Grounded-answer generation: answer from the `CONTEXT` block when relevant, admit gaps rather than guess, same anti-injection/anti-role-play rules as the general prompt. |
| `SUSPICIOUS_PATTERNS` | Regex heuristics (e.g. "ignore previous instructions", "developer mode", "system prompt") used only as an observability/cache-gating signal — real defense-in-depth lives in the system prompts themselves. |

---

## 4. Function Reference — TypeScript Handler

### 4.1 Pure helpers
- **`flagSuspiciousContent(message)`** — tests the message against `SUSPICIOUS_PATTERNS`; returns a boolean used later to gate cache writes.
- **`sanitizeMessage(raw)`** — strips control characters and zero-width/BOM Unicode, trims whitespace.
- **`toPgVectorLiteral(embedding)`** — formats a number array as the `[1,2,3]` literal Postgres/pgvector expects.

### 4.2 Network resilience
- **`fetchWithTimeout(url, init, timeoutMs)`** — wraps `fetch` with `AbortController` so a hung upstream call can't stall past a hard timeout.
- **`UpstreamHttpError` / `OpenAiHttpError` / `UpstashHttpError`** — error classes carrying an HTTP `status`, so retry logic is provider-agnostic while logs can still show which service failed.
- **`isOpenAiRetryable(err)` / `isUpstashRetryable(err)`** — predicate functions: retryable HTTP status (per-service allowlist) or an abort/timeout counts as transient; everything else (4xx auth/validation, parse errors) fails fast.
- **`withRetry(fn, retries, baseDelayMs, isRetryable)`** — generic exponential-backoff wrapper. Returns `{ result, retryCount }` so every call site can log retry counts without duplicating counting logic.

### 4.3 Observability
- **`logEvent(event, fields)`** — emits one structured JSON line stamped with service/env/version/region; never throws (catches its own serialization errors).
- **`sanitizeTraceId(raw)`** — accepts a client-supplied trace id only if it's a short plain identifier matching `TRACE_ID_RE`; otherwise mints a fresh `trace_<uuid>`. Prevents log-injection via an attacker-controlled header/field.
- **`redactSensitive(text)`** — regex-redacts email-shaped and long-digit-run substrings from free text before logging.
- **`safeErrorMessage(err)`** — converts any thrown error to a redacted, length-capped string; the one place raw upstream error text is allowed into logs, since a Postgres/Supabase/OpenAI error can echo back query content.
- **`sha256Hex(text)`** — SHA-256 hex digest, used to log a stable, de-duplicable fingerprint of query text without writing the raw (possibly sensitive) text itself.
- **`classifyError(err)`** — normalizes any thrown error into `{errorType, errorStatus?}` for consistent failure logging.

### 4.4 OpenAI wrappers
- **`chatCompletion(apiKey, messages, opts)`** — calls `/v1/chat/completions` through `withRetry`; throws `OpenAiHttpError` on non-2xx; throws if the response has no content; returns `{content, usage, retryCount}` with `usage` normalized into `TokenUsage` regardless of the raw field names OpenAI returns.
- **`createEmbedding(apiKey, text)`** — calls `/v1/embeddings`; returns `{embedding, retryCount}`; throws if no vector is returned.
- **`moderateText(apiKey, text)`** — calls `/v1/moderations`. **Fails soft**: any network/API error returns `{flagged:false, checked:false}` so callers can tell "checked and clean" apart from "couldn't check." Used twice: on input (soft-fail — an outage shouldn't block chat) and on the generated answer before it's shown to the user or cached.

### 4.5 Semantic cache (Upstash Vector)
Sits in front of the RAG pipeline on the ML path only, reusing the same query embedding already computed for hybrid search (one extra round trip, not an extra OpenAI call).

- **`getUpstashConfig()`** — reads `UPSTASH_VECTOR_REST_URL`/`UPSTASH_VECTOR_REST_TOKEN`; returns `null` if either is unset (cache silently disabled).
- **`queryCache(embedding)`** — nearest-neighbor lookup (`topK:1`). A hit requires: similarity ≥ `CACHE_SIMILARITY_THRESHOLD`, a non-empty cached `answer` string, and `cached_at` within `CACHE_TTL_MS`. Returns a `CacheLookupOutcome` that always explains *why* it missed (`cache_not_configured`, `no_match`, `below_threshold`, `malformed_entry`, `stale`, `lookup_error`) for observability. Any infra failure is treated as a miss, never a request failure. A stale hit triggers a fire-and-forget delete of that entry.
- **`storeCacheAsync(embedding, rewrittenQuery, answer)`** — fire-and-forget upsert. **Not gated internally** — by design, the safety decision (injection heuristic + moderation) is made by the caller before this is ever invoked, because this cache is shared across *all* future users: an unvetted write here would let a compromised answer bypass the answer system prompt and moderation entirely on future cache hits (no LLM call happens on a hit).
- **`deleteCacheEntryAsync(id)`** — fire-and-forget delete; errors logged only.

### 4.6 Pipeline steps
- **`classifyAndRewrite(apiKey, history)`** — the merged classify+rewrite call. Parses the model's JSON; truncates the rewrite to `MAX_REWRITTEN_QUERY_LENGTH`. **Fails safe**: if JSON parsing fails, or the message is classified ML-related but the rewrite comes back empty, it returns `isMlRelated:false` (routes to the plain-chat path) with `fallbackUsed:true` so it's visible in logs, rather than crashing or running retrieval on a broken query.
- **`performHybridSearch(supabase, queryText, queryEmbedding)`** — calls the `hybrid_search` RPC (see §5); throws on any Supabase error.
- **`rerankResults(apiKey, rewrittenQuery, candidates)`** — builds a numbered candidate list (snippets truncated to `RERANK_SNIPPET_LENGTH`), asks the model to return `ranked_ids`, maps ids back to full candidates, caps at `RERANK_TOP_N`. Three fallback paths, all reported via `fallbackReason`: `no_candidates` (nothing to rerank), `empty_ranked_ids` (model returned nothing usable → keep original RRF order), `rerank_call_failed` (LLM/parse error → same fallback).
- **`buildContextBlock(chunks)`** — joins `[n] content` chunks into the `CONTEXT` block, or a placeholder string if there are none.
- **`generateGroundedAnswer(apiKey, historyWithoutLastTurn, rewrittenQuery, contextChunks)`** — builds the augmented user turn (`CONTEXT:` + `QUESTION:`) and calls `chatCompletion` with `ANSWER_SYSTEM_PROMPT` plus prior history.
- **`logQueryRewriteAsync(supabase, originalQuery, rewrittenQuery)`** — fire-and-forget insert into `query_rewrites` for later audit/eval; never awaited, never fails the request.

### 4.7 Main handler — `chatConversation`
Executed roughly in this order:

1. **Setup** — mint `request_id`, sanitize/derive `trace_id`, decide `shouldLogVerbose` once per request (not per line, so a request's verbose logs are all-or-nothing), initialize the `requestLog` accumulator and a `finish(status, body)` helper that always emits one `request_completed` summary before returning.
2. **Auth + input validation** — requires `ctx.userId`; validates `conversation_id` against `UUID_RE`; validates a non-empty `message` under `MAX_MESSAGE_LENGTH` (after `sanitizeMessage`). Emits `request_started`.
3. **Ownership check** — confirms the conversation row exists and belongs to `ctx.userId`; 404 otherwise.
4. **Injection heuristic** — `flagSuspiciousContent`; logged, remembered for the later cache-write gate.
5. **Input moderation** — soft-fail; a flagged message returns 400.
6. **History load, then persist** — fetches up to `MAX_HISTORY_MESSAGES - 1` prior messages ordered by `created_at DESC, id DESC` (secondary key guards against same-millisecond ties), reverses to chronological order, appends the current message **locally** rather than re-querying — this deliberately avoids a read-after-write race where a lagging replica could omit the just-inserted row. The user's message is persisted *after* this read but *before* any generation call.
7. **Step 1 — classify + rewrite** (`classifyAndRewrite`). Logs `classify_rewrite_completed` (sampled, but always logged on fallback) or `classify_rewrite_failed` (always logged; 502 on failure).
8. **Branch on `isMlRelated`:**
   - **General:** one `chatCompletion` call with `GENERAL_SYSTEM_PROMPT` + full history; 502 on failure.
   - **ML/RAG:**
     - Audit-logs the rewrite (fire-and-forget).
     - **Step 2** — embed the rewritten query (`embedding_completed`/`embedding_failed`; 502 on failure).
     - **Step 2b** — `queryCache`; logs `cache_lookup_completed` (sampled). On hit, reuse the cached answer and skip straight to persistence.
     - **Step 3** (on miss) — `performHybridSearch`; `hybrid_search_completed` (sampled) or `hybrid_search_failed` (**always logged**, error text redacted; 500 on failure).
     - **Step 4** — `rerankResults`; `rerank_completed` (sampled, but always on fallback).
     - **Step 5** — `generateGroundedAnswer`; `answer_generation_failed` (always logged; 502) or success.
     - **Step 6** — moderate the generated answer (soft-fail; `checked:false` treated as not-flagged). If flagged, the reply is replaced with a fixed safe fallback message — this happens regardless of caching. Cache write is gated on **both** no injection flag on input **and** a clean, checked moderation result on the output; otherwise skipped with a logged reason. `answer_generation_completed` is logged (sampled, but always logged if the answer was flagged).
9. **Persist bot reply** — insert into `messages`; 500 on failure.
10. **Return 200** with the stored bot message; `finish()` always logs `request_completed` with `status`, `duration_ms`, `user_id`, `conversation_id`, `message_length`, `history_count`, `cache_hit`, and `path` (`ml_rag` vs `general`).

**Failure-mode summary:** 401 (no user), 400 (bad `conversation_id`/`message`, or input moderation flagged), 404 (conversation not found/not owned), 500 (history/hybrid-search/message-persistence failure), 502 (any LLM call failure).

---

## 5. Postgres Schema

### 5.1 Extensions
- **`vector`** (pgvector) — adds the `vector` type, distance operators (`<=>`, `<#>`, `<->`), and ANN index types (HNSW, IVFFlat).
- **`pg_trgm`** — trigram similarity functions; enabled for optional fuzzy/typo-tolerant matching, not directly used by `hybrid_search()`.

### 5.2 `documents`
| Column | Notes |
|---|---|
| `id` | `bigserial` PK. |
| `content` | Raw chunk text. |
| `metadata` | `jsonb`, default `{}` — source, tags, permissions, etc. |
| `embedding` | `vector(1536)` — dims must match the embedding model (1536 for `text-embedding-3-small`/ada-2; adjust for BGE/E5/etc.). |
| `fts` | `tsvector generated always as (to_tsvector('english', content)) stored` — auto-maintained keyword-search column, never manually synced. |
| `created_at` | Default `now()`. |
| `document_id`, `chunk_index` | Added via `ALTER TABLE` — trace each chunk back to its source document and position, enabling grouping/dedup and fetching neighboring chunks for extra context. |

Indexes:
- **`documents_embedding_idx`** — HNSW on `embedding` with `vector_cosine_ops` (must match the `<=>` operator used in queries).
- **`documents_fts_idx`** — GIN on `fts`, for fast `@@` matches.

### 5.3 `query_rewrites`
Audit log of original vs. rewritten queries (`original_query`, `rewritten_query`, `created_at`) — written by `logQueryRewriteAsync` for later debugging/eval, decoupled from retrieval quality.

### 5.4 `hybrid_search(query_text, query_embedding, match_count=20, full_text_weight=1.0, semantic_weight=1.0, rrf_k=50)`
Returns `(id, content, metadata, score)`. Fuses two ranked candidate lists via **Reciprocal Rank Fusion (RRF)**, avoiding the need to normalize cosine similarity and `ts_rank` onto a shared scale:

- **`semantic` CTE** — ranks by `embedding <=> query_embedding` (cosine distance, smaller = closer), pulls `least(match_count*2, 100)` candidates for fusion headroom.
- **`keyword` CTE** — ranks by `ts_rank_cd(fts, websearch_to_tsquery('english', query_text))`, restricted to rows where `fts @@ websearch_to_tsquery(...)`; `websearch_to_tsquery` accepts familiar web-search syntax (quoted phrases, `-exclusions`).
- **Fusion** — `LEFT JOIN documents` against both CTEs so a document need only appear in one list; score = `semantic_weight/(rrf_k + semantic_rank) + full_text_weight/(rrf_k + keyword_rank)` (`coalesce(...,0.0)` for whichever list a doc is missing from); final `WHERE` excludes rows present in neither list; ordered by `score DESC`, capped at `match_count`.
- Re-ranking itself (the LLM cross-encoder-style pass) happens in the application layer (`rerankResults`) — this function only does first-stage retrieval.

### 5.5 Eval tables
- **`eval_queries`** — `(query, relevant_doc_ids bigint[])`: a labeled ground-truth set.
- **`eval_runs`** — one row per (eval query × pipeline configuration): `pipeline_stage` (e.g. `vector_only`, `keyword_only`, `hybrid`, `hybrid_reranked`), `retrieved_doc_ids`, and computed `recall_at_5`, `precision_at_5`, `mrr`, `ndcg_at_5` — lets different pipeline variants be compared over time against the same labeled set.

---

## 6. Cross-Cutting Concerns

- **Fail-soft vs. fail-closed:** moderation and the semantic cache read path fail *soft* (an outage degrades to "let it through" / "treat as a miss") because they're infra dependencies that shouldn't take down support chat. The cache *write* path fails *closed* (skip the write on any doubt) because a bad write is persistent and cross-user.
- **Sampling discipline:** `VERBOSE_LOG_SAMPLE_RATE` only throttles high-volume "stage succeeded" lines. `request_started`, `input_validation_completed`, every `*_failed` event, every fallback-triggered log, and `request_completed` are always emitted regardless of the sample rate.
- **PII/log hygiene:** trace ids are charset/length-validated before trusting them; upstream error text is redacted and truncated; query text is logged only as a SHA-256 hash, never raw.
- **Cache poisoning defense:** a cache write requires *both* no injection-heuristic hit on the input *and* a moderation-clean, moderation-checked output — because a cache hit skips the LLM (and thus the answer system prompt's guardrails) entirely.
