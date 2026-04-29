from tree_sitter import Language, Parser
from tree_sitter_python import TREE_SITTER_LANGUAGE as PYTHON_LANG  # pip install tree-sitter-python etc.
from tree_sitter_typescript import TREE_SITTER_LANGUAGE as TS_LANG
import networkx as nx
from sqlalchemy.ext.asyncio import AsyncSession
from ..models import Symbol

class CodeIntelligence:
    def __init__(self):
        self.parsers = {
            'python': Parser(),
            'typescript': Parser(),
        }
        self.parsers['python'].set_language(PYTHON_LANG)
        self.parsers['typescript'].set_language(TS_LANG)
        self.dep_graph = nx.DiGraph()
    
    async def parse_and_index(self, repo_id: str, file_path: str, content: str, db: AsyncSession):
        \"\"\"Parse AST, extract symbols, build dep graph, detect errors\"\"\"
        ext = file_path.split('.')[-1]
        parser = self.parsers.get(ext, self.parsers['python'])
        
        tree = parser.parse(bytes(content, 'utf8'))
        symbols = self._extract_symbols(tree, file_path)
        
        # Upsert to DB
        for sym in symbols:
            # await db.merge(Symbol(**sym, repo_id=repo_id))
            pass  # Async upsert logic
        
        self._build_dep_graph(symbols)
    
    def _extract_symbols(self, tree, file_path) -> list:
        # Tree-sitter query for functions/classes/vars
        query = self.LANGUAGE.query("""
        (function_definition name: (identifier) @func.name)
        (class_definition name: (identifier) @class.name)
        (assignment left: (identifier) @var.name)
        """)
        captures = query.captures(tree.root_node)
        return [{'name': cap[0].text.decode(), 'kind': cap[1], 'file_path': file_path} for cap, label in captures]
    
    def _build_dep_graph(self, symbols):
        # NetworkX: func calls → deps
        for sym in symbols:
            self.dep_graph.add_node(sym['name'], **sym)
            # Add edges from callgraph
        
    async def find_usages(self, symbol_name: str, repo_id: str) -> list:
        # Query DB + graph
        return []  # Impl
    
    def static_analysis(self, content: str) -> list:
        # Linting simulation: unused vars, etc.
        return []
