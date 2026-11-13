# Machine Learning expert chatbot application 2.0

Improved version of **[V1](https://github.com/KushagraKumarSinha/Chatbot_Architecture_V1)**:
1) Implemented Router and Registry pattern
2) Added structured logging
3) Added better error handling and retry logic
4) Created evaluation set
5) Accounted for prompt injection
6) Implemented response streaming

Improvements to this:
1) Adding proxy before request hits backend
2) Improving security in the frontend

<img width="959" height="350" alt="image" src="https://github.com/user-attachments/assets/a367c093-c76b-46b3-a29d-4a14fdb8e1e1" />

## Flowchart

```mermaid
flowchart TD
    A(["Incoming Request"]) --> B{"OPTIONS?"}
    B -->|Yes| B1(["Return CORS ok"])
    B -->|No| C["Rate limit by IP<br/>sliding window"]
    C -->|Failed open| C0["Fire alert webhook<br/>fire-and-forget"]
    C0 --> D
    C -->|Blocked| C1(["429 Too Many Requests"])
    C -->|Allowed| D["Parse JSON body"]
    D -->|Invalid JSON| D1(["400 Invalid JSON body"])
    D -->|Valid| E["Validate envelope<br/>method / function_name / payload"]
    E -->|Invalid| E1(["400 Invalid request body"])
    E -->|Valid| F["Verify JWT via JWKS"]
    F -->|No userId| F1(["401 Unauthorized"])
    F -->|OK| G["Rate limit by userId"]
    G -->|Blocked| G1(["429 Too Many Requests"])
    G -->|Allowed| H["Look up handler by<br/>method + function_name"]
    H -->|Not found| H1(["400 / 404"])
    H -->|Found| I["Validate payload<br/>against zod schema"]
    I -->|Invalid| I1(["400 Invalid payload"])
    I -->|Valid| J{"Dispatch by<br/>function_name"}
 
    %% ---------- createConversation branch ----------
    J -->|"createConversation"| CC1["Check ctx.userId"]
    CC1 -->|Missing| CC1a(["401 Unauthorized"])
    CC1 -->|OK| CC2["Validate title<br/>string, non-empty, ≤200 chars"]
    CC2 -->|Invalid| CC2a(["400 Invalid title"])
    CC2 -->|OK| CC3["Insert conversation<br/>retry deadlock/serialization<br/>exp backoff + jitter, max 3x"]
    CC3 -->|Retries exhausted| CC3a(["500 Failed to create conversation"])
    CC3 -->|OK| CC4(["201 + conversation"])
 
    %% ---------- readConversation branch ----------
    J -->|"readConversation"| RC1["Check ctx.userId"]
    RC1 -->|Missing| RC1a(["401 Unauthorized"])
    RC1 -->|OK| RC2["Validate + clamp limit<br/>positive int, default 20, max 100"]
    RC2 -->|Invalid| RC2a(["400 Invalid limit"])
    RC2 -->|OK| RC3["Select conversations<br/>by user_id, ordered, limited<br/>shared retry helper"]
    RC3 -->|Retries exhausted| RC3a(["500 Failed to fetch conversations"])
    RC3 -->|OK| RC4(["200 + conversations"])
 
    %% ---------- getPastConversations branch ----------
    J -->|"getPastConversations"| GP1["Check ctx.userId"]
    GP1 -->|Missing| GP1a(["401 Unauthorized"])
    GP1 -->|OK| GP2["Validate conversation_id<br/>string, present"]
    GP2 -->|Invalid| GP2a(["400 Invalid conversation_id"])
    GP2 -->|OK| GP3["Validate + clamp limit<br/>positive int, default 20, max 100"]
    GP3 -->|Invalid| GP3a(["400 Invalid limit"])
    GP3 -->|OK| GP4["Look up conversation<br/>by id + user_id<br/>shared retry helper"]
    GP4 -->|Retries exhausted| GP4a(["500 Failed to fetch messages"])
    GP4 -->|Not found| GP4b(["404 Conversation not found"])
    GP4 -->|Found| GP5["Fetch messages<br/>by conversation_id, ordered, limited<br/>shared retry helper"]
    GP5 -->|Retries exhausted| GP5a(["500 Failed to fetch messages"])
    GP5 -->|OK| GP6["Reverse to<br/>chronological order"]
    GP6 --> GP7(["200 + conversation + messages"])
 
    %% ---------- deleteConversation branch ----------
    J -->|"deleteConversation"| DC1["Check ctx.userId"]
    DC1 -->|Missing| DC1a(["401 Unauthorized"])
    DC1 -->|OK| DC2["Validate conversation_id<br/>and non-empty title"]
    DC2 -->|Invalid| DC2a(["400 Invalid input"])
    DC2 -->|OK| DC3["Look up conversation<br/>by id + user_id<br/>shared retry helper"]
    DC3 -->|Retries exhausted| DC3a(["500 Failed to delete conversation"])
    DC3 -->|Not found| DC3b(["404 Conversation not found"])
    DC3 -->|Found| DC4{"title matches<br/>confirmation?"}
    DC4 -->|No| DC4a(["409 Title mismatch"])
    DC4 -->|Yes| DC5["Delete messages + conversation<br/>in one transaction<br/>retry whole tx, max 3x"]
    DC5 -->|Retries exhausted| DC5a(["500 Failed to delete conversation"])
    DC5 -->|OK| DC6(["200 Conversation deleted"])
 
    %% ---------- chatConversation branch ----------
    J -->|"chatConversation"| K["Check ctx.userId"]
    K -->|Missing| K1(["401 Unauthorized"])
    K -->|OK| L["Validate conversation_id UUID<br/>and non-empty message"]
    L -->|Invalid| L1(["400 Invalid input"])
    L -->|Valid| M["Sanitize message,<br/>check MAX_MESSAGE_LENGTH"]
    M -->|Too long| M1(["400 Message too long"])
    M -->|OK| N["Check conversation ownership<br/>id + user_id"]
    N -->|Not found| N1(["404 Conversation not found"])
    N -->|OK| O["Flag suspicious content<br/>regex heuristic, log only"]
    O --> P["Check OPENAI_API_KEY set"]
    P -->|Missing| P1(["500 Server misconfiguration"])
    P -->|OK| Q["Moderate input<br/>soft-fail on outage"]
    Q -->|Flagged| Q1(["400 Violates content policy"])
    Q -->|OK or unchecked| R["Fetch prior history<br/>before insert, avoids replica race"]
    R -->|DB error| R1(["500 Failed to fetch history"])
    R -->|OK| S["Persist user message"]
    S -->|DB error| S1(["500 Failed to store message"])
    S -->|OK| T["Classify + Rewrite<br/>single LLM call"]
    T -->|LLM error| T1(["502 Failed to classify"])
    T -->|Not ML-related| U["General chat completion"]
    U -->|LLM error| U1(["502 Failed to get response"])
    U --> AA
    T -->|ML-related| V["Log query rewrite async<br/>fire-and-forget"]
    V --> W["Create embedding of<br/>rewritten query"]
    W -->|LLM error| W1(["502 Failed to process question"])
    W -->|OK| X{"Semantic Cache Hit?<br/>score above threshold and fresh"}
    X -->|Yes| X1["Reuse cached answer"]
    X1 --> AA
    X -->|No, stale, or miss| Y["Hybrid Search<br/>vector + keyword via Supabase RPC"]
    Y -->|RPC error| Y1(["500 Failed to search KB"])
    Y -->|OK| Z["LLM Reranker<br/>fallback: keep RRF order on failure"]
    Z --> AB["Generate grounded answer<br/>context + history"]
    AB -->|LLM error| AB1(["502 Failed to get response"])
    AB -->|OK| AC["Moderate generated answer"]
    AC -->|Flagged| AC1["Substitute safe<br/>fallback message"]
    AC -->|Clean| AD{"Cache-write eligible?<br/>no injection flag and<br/>moderation passed"}
    AC1 --> AA
    AD -->|Yes| AD1["storeCacheAsync<br/>fire-and-forget"]
    AD -->|No| AD2["Skip cache write"]
    AD1 --> AA
    AD2 --> AA
    AA["Persist bot reply"] -->|DB error| AA1(["500 Failed to store reply"])
    AA -->|OK| AE(["Return 200 + reply"])
 
    classDef entry fill:#e0e7ff,stroke:#4338ca,stroke-width:1.5px,color:#1e1b4b
    classDef security fill:#fef3c7,stroke:#b45309,stroke-width:1.5px,color:#451a03
    classDef cache fill:#fce7f3,stroke:#be185d,stroke-width:1.5px,color:#500724
    classDef retrieval fill:#d1fae5,stroke:#047857,stroke-width:1.5px,color:#022c22
    classDef generation fill:#dbeafe,stroke:#1d4ed8,stroke-width:1.5px,color:#172554
    classDef errorpath fill:#fee2e2,stroke:#b91c1c,stroke-width:1.5px,color:#450a0a
 
    class A,AE,B1 entry
    class B,C,C0,D,E,F,G,H,I,J,K,L,M,N,O,P,Q security
    class C1,D1,E1,F1,G1,H1,I1,K1,L1,M1,N1,P1,Q1,R1,S1,T1,U1,W1,Y1,AB1,AA1 errorpath
    class X,X1,AD,AD1,AD2 cache
    class Y,Z retrieval
    class J,R,S,T,U,V,W,AB,AC,AC1,AA generation
    class CC1,CC2,CC3,RC1,RC2,RC3,GP1,GP2,GP3,GP4,GP5,GP6,DC1,DC2,DC3,DC4,DC5 security
    class CC1a,CC2a,CC3a,RC1a,RC2a,RC3a,GP1a,GP2a,GP3a,GP4a,GP4b,GP5a,DC1a,DC2a,DC3a,DC3b,DC4a,DC5a errorpath
    class CC4,RC4,GP7,DC6 entry
```

## Learn More

For info about the concepts used in this project, refer to:

- **[API notes](https://github.com/KushagraKumarSinha/API_notes_and_examples)**
- **[Backend concept notes](https://github.com/KushagraKumarSinha/Backend_Concept_Notes)**
- **[AI agent notes](https://github.com/KushagraKumarSinha/AI_Agent_Notes)**

