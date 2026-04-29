from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.security.api_key import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
from contextlib import asynccontextmanager
from typing import AsyncGenerator
import os
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import redis.asyncio as redis
from pydantic_settings import BaseSettings
from jose import JWTError, jwt
from passlib.context import CryptContext
import logging
from prometheus_client import Counter, Histogram, make_asgi_middleware
import time

# Metrics
REQUEST_COUNT = Counter('requests_total', 'Total requests', ['method', 'endpoint'])
REQUEST_LATENCY = Histogram('request_latency_seconds', 'Request latency')

# Config
class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://postgres:password@localhost/quantdb"
    REDIS_URL: str = "redis://localhost:6379"
    SECRET_KEY: str = "your-secret-key-change-in-prod"
    ALGORITHM: str = "HS256"
    API_KEY_HEADER: str = "X-API-Key"
    PGVECTOR_DIMS: int = 384

settings = Settings()

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# DB
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    engine = create_async_engine(settings.DATABASE_URL, echo=True)
    AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with AsyncSessionLocal() as session:
        try:
            # Test connection
            await session.execute(text("SELECT 1"))
            yield session
        finally:
            await session.close()

# Redis
redis_client = redis.from_url(settings.REDIS_URL)

# Auth
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
api_key_header = APIKeyHeader(name=settings.API_KEY_HEADER)

async def verify_api_key(api_key: str = Depends(api_key_header)) -> str:
    # In prod, hash and check DB
    # Stub: assume valid for now
    if not api_key or api_key.startswith("test_"):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key

# Rate Limit
limiter = Limiter(key_func=get_remote_address, default_limits=["200/minute"])

# App lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: migrate DB? check pgvector
    await redis_client.ping()
    logger.info("Startup complete")
    yield
    await redis_client.close()

app = FastAPI(
    title="Quant_2 AI Coding Assistant",
    description="Better than Blackbox/Copilot: Ultra-low latency + repo awareness",
    version="1.0.0",
    lifespan=lifespan
)

# Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(make_asgi_middleware())
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, lambda req, exc: HTTPException(status_code=429, detail="Rate limit exceeded"))

from .routers import autocomplete
app.include_router(autocomplete.router, prefix="/v1", tags=["autocomplete"], dependencies=[Depends(verify_api_key)])

@app.get("/health")
@limiter.limit("10/second")
async def health():
    return {"status": "healthy", "redis": await redis_client.ping()}

@app.post("/v1/chat")  # Stub for streaming
async def chat_stub(request: Request):
    return {"message": "Chat streaming ready - implement router"}

# Metrics endpoint
@app.get("/metrics")
async def metrics():
    return StreamingResponse(RESPONSE_ITERATOR, media_type=CONTENT_TYPE)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
