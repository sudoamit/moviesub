from typing import Dict, Any, AsyncGenerator
from vllm import AsyncLLMEngine, SamplingParams
from ollama import AsyncClient as OllamaClient
import openai
from sentence_transformers import SentenceTransformer
from ..settings import settings

class LLMGateway:
    def __init__(self):
        # Fast autocomplete model (ultra-low latency)
        self.fast_engine = AsyncLLMEngine.from_engine_args(
            model="deepseek-ai/deepseek-coder-1.3b-instruct",
            engine_args={"max_model_len": 2048, "gpu_memory_utilization": 0.8}
        )
        self.ollama = OllamaClient()
        self.openai_client = openai.AsyncOpenAI()
        self.embedder = SentenceTransformer('all-MiniLM-L6-v2')
    
    async def route_call(self, task_type: str, prompt: str, **kwargs) -> str:
        \"\"\"Hybrid routing based on task + latency/cost needs
        
        autocomplete (FIM, <150ms): vLLM 1.3B
        chat/debug: GPT-4o-mini or Ollama
        search/embed: local
        \"\"\"
        if task_type == "autocomplete":
            return await self._fast_autocomplete(prompt, **kwargs)
        elif task_type == "chat":
            return await self._chat(prompt)
        elif task_type == "embed":
            return self.embedder.encode(prompt)
        raise ValueError(f"Unknown task: {task_type}")
    
    async def _fast_autocomplete(self, fim_prompt: str, max_tokens: int = 64) -> str:
        sampling_params = SamplingParams(
            temperature=0.2,
            max_tokens=max_tokens,
            stop=[\"\\n\", \"```\"]
        )
        result = await self.fast_engine.generate(fim_prompt, sampling_params)
        return result[0].outputs[0].text.strip()
    
    async def _chat(self, prompt: str) -> str:
        # Route to fastest available strong model
        try:
            response = await self.openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{\"role\": \"user\", \"content\": prompt}],
                stream=False
            )
            return response.choices[0].message.content
        except:
            # Fallback local
            return await self.ollama.chat(model='codellama', messages=[{'role': 'user', 'content': prompt}])
    
    async def stream_chat(self, prompt: str) -> AsyncGenerator[str, None]:
        # Streaming for chat UI
        stream = await self.openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{\"role\": \"user\", \"content\": prompt}],
            stream=True
        )
        async for chunk in stream:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
