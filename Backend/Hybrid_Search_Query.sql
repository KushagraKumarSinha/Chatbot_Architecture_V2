-- ============================================================================
-- hybrid_search v2
--
-- Changes vs. the original:
--  1. Vector + keyword candidate lists use ORDER BY ... LIMIT *inside* a
--     subquery, and only then assign row_number(). That lets the HNSW and GIN
--     indexes do the work instead of ranking every row first.
--  2. RRF fusion uses a FULL OUTER JOIN of the two small candidate lists, then
--     joins `documents` only for the final ~match_count rows (no table scan).
--  3. Returns a new `similarity` column (cosine similarity, 1 - cosine distance)
--     computed in SQL for the final rows, so the app can rerank arithmetically
--     WITHOUT shipping 1536-dim vectors over the wire.
--
-- NOTE: the return type changed, so the old function must be dropped first.
-- Run this whole script in the Supabase SQL editor.
-- ============================================================================

drop function if exists hybrid_search(text, vector, int, double precision, double precision, int);

create or replace function hybrid_search(
  query_text text,
  query_embedding vector(1536),
  match_count int default 20,
  full_text_weight float default 1.0,
  semantic_weight float default 1.0,
  rrf_k int default 50
)
returns table (
  id bigint,
  content text,
  metadata jsonb,
  score float,
  similarity float
)
language sql
stable
as $$
  with
  semantic as (
    select ranked.id, row_number() over (order by ranked.dist) as rank
    from (
      select d.id, d.embedding <=> query_embedding as dist
      from documents d
      where d.embedding is not null
      order by d.embedding <=> query_embedding
      limit least(match_count * 2, 100)
    ) ranked
  ),
  keyword as (
    select ranked.id, row_number() over (order by ranked.r desc) as rank
    from (
      select d.id, ts_rank_cd(d.fts, q.tsq) as r
      from documents d,
           websearch_to_tsquery('english', query_text) as q(tsq)
      where d.fts @@ q.tsq
      order by ts_rank_cd(d.fts, q.tsq) desc
      limit least(match_count * 2, 100)
    ) ranked
  ),
  fused as (
    select
      coalesce(s.id, k.id) as id,
      coalesce(semantic_weight / (rrf_k + s.rank), 0.0)
        + coalesce(full_text_weight / (rrf_k + k.rank), 0.0) as score
    from semantic s
    full outer join keyword k on k.id = s.id
    order by score desc
    limit match_count
  )
  select
    d.id,
    d.content,
    d.metadata,
    f.score::float,
    (1 - (d.embedding <=> query_embedding))::float as similarity
  from fused f
  join documents d on d.id = f.id
  order by f.score desc;
$$;

-- ============================================================================
-- BENCHMARK (run before/after; compare "Execution Time").
-- Uses an existing row's embedding as the query vector, so no manual vector needed.
-- Run each twice: the first run can be a cold cache.
-- ============================================================================
-- explain analyze
-- select id, score, similarity
-- from hybrid_search(
--   'fine tuning large language models',
--   (select embedding from documents where embedding is not null limit 1),
--   10
-- );
