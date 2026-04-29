# Quant_2: AI Coding Assistant (Better than Blackbox/Copilot)

## 🎯 Features
- 🚀 <150ms autocomplete (vLLM DeepSeek 1.3B)
- 🧠 Repo-aware context (tree-sitter + pgvector)
- 💬 Streaming chat/debug/refactor
- 🔍 Semantic code search
- Hybrid LLMs (OpenAI + Ollama fallback)

## 🏃 Quick Start (Dev)

1. **DB**: Docker run Postgres w/ pgvector
```bash
docker run -p 5432:5432 -e POSTGRES_DB=quantdb -e POSTGRES_PASSWORD=password ankane/pgvector
```

2. **Deps**: Backend venv done (see TODO)

3. **Migrate**:
```bash
cd backend
venv/bin/pip install alembic
alembic init migrations  # Configure
alembic revision --autogenerate -m "initial"
alembic upgrade head
```

4. **Run Backend**:
```bash
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

5. **VS Code Extension**: F5 to debug

6. **Test Autocomplete**: POST /v1/autocomplete w/ test_ API key

## 🚀 Production Deploy
- Docker Compose (infra/docker-compose.yml coming)
- Railway/Fly.io (FastAPI friendly)
- Scale: vLLM GPU workers + Celery

## 📊 Perf
Target: Autocomplete <150ms, Chat streaming, 1000s RPS w/ caching

Progress: Backend core complete!
