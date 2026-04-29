-- Enhanced Schema for AI Coding Assistant
-- Includes original + new tables for full features: chat, embeddings, memory, usage
-- Postgres + pgvector extension for vectors

-- Enable extensions (run once)
-- CREATE EXTENSION IF NOT EXISTS vector;
-- CREATE EXTENSION IF NOT EXISTS uuid-ossp;

-- Users & Repos (original enhanced)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    api_key_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    remote_url TEXT,
    last_indexed TIMESTAMP WITH TIME ZONE,
    UNIQUE(owner_id, name)
);

-- Symbol Tracking (original enhanced w/ index)
CREATE TABLE symbols (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL, -- 'function', 'class', 'variable', 'import'
    file_path TEXT NOT NULL,
    location_range JSONB NOT NULL, -- {"start":{"line":1,"character":0},"end":{"line":1,"character":5}}
    signature TEXT, -- func sig for matching
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_symbols_repo_name ON symbols(repo_id, name);
CREATE INDEX idx_symbols_file ON symbols(file_path);

-- Chat Sessions & History (new: for chat engine)
CREATE TABLE chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    repo_id UUID REFERENCES repositories(id),
    title TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL, -- 'user', 'assistant'
    content TEXT NOT NULL,
    context_tokens INTEGER,
    model_used TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_chat_session ON chat_messages(session_id);

-- Embeddings for Semantic Search/Context (new: pgvector)
CREATE TABLE code_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    content TEXT, -- snippet
    embedding VECTOR(384), -- sentence-transformers all-MiniLM-L6-v2 dim
    metadata JSONB, -- {'symbols':[...], 'loc':...}
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX ON code_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- User Learning/Memory (new: patterns, snippets)
CREATE TABLE user_snippets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    code TEXT NOT NULL,
    language TEXT,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE user_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    pattern_type TEXT, -- 'framework', 'error_fix', 'style'
    data JSONB, -- {'frameworks':['react','fastapi'], 'common_errors':[...]}
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Usage Tracking (new: cost/scale)
CREATE TABLE usage_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    endpoint TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms DOUBLE PRECISION,
    cost_usd DOUBLE PRECISION,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_usage_user_time ON usage_logs(user_id, created_at);

-- Sessions: Open files/recent edits (new: context engine)
CREATE TABLE editor_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    repo_id UUID REFERENCES repositories(id),
    open_files JSONB NOT NULL, -- ["/file1.py", ...]
    recent_edits JSONB, -- [{"file":, "changes": [...]}]
    cursor_positions JSONB,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
