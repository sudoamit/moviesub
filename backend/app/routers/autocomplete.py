from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from ...core.context_engine import ContextEngine
from ...core.llm_gateway import LLMGateway
from ...main import get_db  # Import get_db
import time
from prometheus_client import Histogram

REQUEST_LATENCY = Histogram('autocomplete_latency_seconds', 'Autocomplete latency')

router = APIRouter()

@router.post("/autocomplete")
async def get_autocomplete(
    payload: dict,
    db: AsyncSession = Depends(get_db)
):
    start_time = time.time()
    
    prefix = payload["prefix"]
    suffix = payload["suffix"]
    repo_id = payload.get("repo_id")
    open_files = payload.get("open_files", [])
    file_path = payload["file_path"]
    
    # Smart Context Engine (KEY DIFFERENTIATOR)
    context_eng = ContextEngine(db)
    context = await context_eng.build_context(repo_id, open_files, file_path, {})
    
    # FIM prompt with repo awareness
    prompt = f"""# Relevant Repo Context (ranked):
{context['context']}

# Generate completion:
<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>"""
    
    # Hybrid LLM routing
    llm = LLMGateway()
    suggestion = await llm.route_call("autocomplete", prompt)
    
    latency = (time.time() - start_time) * 1000
    REQUEST_LATENCY.observe(latency / 1000)
    
    return {
        "suggestion": suggestion,
        "latency_ms": round(latency, 2),
        "context_tokens": context.get("token_count", 0),
        "model": "deepseek-coder-1.3b-fim"
    }
