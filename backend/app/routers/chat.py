from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi.responses import StreamingResponse
from ...core.context_engine import ContextEngine
from ...core.llm_gateway import LLMGateway
from ...main import get_db
from typing import AsyncGenerator

router = APIRouter()

@router.post("/chat")
async def chat_stream(
    payload: dict,
    db: AsyncSession = Depends(get_db)
):
    async def generate():
        context_eng = ContextEngine(db)
        context = await context_eng.build_context(
            payload["repo_id"], 
            payload["open_files"], 
            payload["file_path"], 
            payload["recent_edits"]
        )
        
        prompt = f"""# Full Repo Context:
{context['context']}

# User Query (code-aware):
{payload['message']}

Respond with code suggestions, debugging, refactoring, architecture advice."""
        
        llm = LLMGateway()
        async for token in llm.stream_chat(prompt):
            yield token
    
    return StreamingResponse(generate(), media_type="text/plain")
