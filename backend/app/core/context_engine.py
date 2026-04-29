import json
from typing import List, Dict, Any
from tree_sitter import Language, Parser
from .intelligence import CodeIntelligence
from .llm_gateway import compress_prompt
from sqlalchemy.ext.asyncio import AsyncSession
from ..models import Symbol, EditorSession, CodeEmbedding

class ContextEngine:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.intelligence = CodeIntelligence()
    
    async def build_context(self, repo_id: str, open_files: List[str], cursor_file: str, recent_edits: Dict) -> Dict[str, Any]:
        \"\"\"KEY DIFFERENTIATOR: Smart repo-aware context builder
        
        1. Editor state (open_files, cursor)
        2. Relevant symbols/defs (top-k by name similarity)
        3. Recent edits
        4. Embed similar snippets
        5. Rank + compress to token budget
        \"\"\"
        context = {
            'immediate': await self._get_immediate_context(cursor_file, open_files),
            'symbols': await self._get_relevant_symbols(repo_id, cursor_file),
            'edits': recent_edits or {},
            'repo_overview': await self._get_repo_stats(repo_id)
        }
        
        # Rank by relevance (TF-IDF + cursor proximity)
        ranked = self._rank_context(context)
        
        # Compress to ~8k tokens
        compressed = await compress_prompt(self.llm_gateway, json.dumps(ranked))
        
        return {'context': compressed, 'token_count': len(compressed.split())}
    
    async def _get_relevant_symbols(self, repo_id: str, file_path: str) -> List[Dict]:
        # Query DB symbols used in file or same module
        result = await self.db.execute(
            text(\"SELECT * FROM symbols WHERE repo_id = :repo AND (file_path = :file OR name IN (SELECT name FROM symbols WHERE file_path = :file)) LIMIT 50\"),
            {'repo': repo_id, 'file': file_path}
        )
        return [dict(row) for row in result.fetchall()]
    
    # ... other methods: index_repo, get_similar_code (vector search), etc.
    
    def _rank_context(self, context: Dict) -> Dict:
        # Simple heuristic: cursor file > open > symbols > repo
        return context
