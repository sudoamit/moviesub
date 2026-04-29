from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from ...main import get_db
from ...core.llm_gateway import LLMGateway

router = APIRouter()

@router.post("/search")
async def semantic_search(
    payload: dict,
    db: AsyncSession = Depends(get_db)
):
    query = payload["query"]
    
    llm = LLMGateway()
    embedding = llm.route_call("embed", query)
    
    # pgvector cosine similarity
    result = await db.execute(
        text("""
        SELECT file_path, content, metadata, 
               1 - (embedding <=> :emb) AS similarity
        FROM code_embeddings 
        WHERE repo_id = :repo_id
        ORDER BY embedding <=> :emb
        LIMIT 20
        """),
        {"emb": embedding.tolist(), "repo_id": payload["repo_id"]}
    )
    
    return {"results": [dict(r) for r in result.fetchall()]}

