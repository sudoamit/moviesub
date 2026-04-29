from fastapi import APIRouter
import time

router = APIRouter()

@router.post("/v1/autocomplete")
async def get_autocomplete(payload: dict):
    start_time = time.time()
    
    prefix = payload["prefix"]
    suffix = payload["suffix"]
    
    # 1. Immediate Context: Last 50 lines + recent edits
    # 2. Routing: Use a fast FIM model (e.g., DeepSeek-Coder-1.3B)
    
    prompt = f"<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>"
    
    # Hit high-performance inference server (vLLM)
    suggestion = await inference_service.generate(
        prompt, 
        max_new_tokens=64, 
        stop=["\n", "```"],
        temperature=0.2
    )
    
    latency = (time.time() - start_time) * 1000
    return {
        "suggestion": suggestion,
        "latency_ms": latency,
        "model": "deepseek-1.3b-fim"
    }