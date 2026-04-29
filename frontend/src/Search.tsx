import React, { useState } from 'react'
import axios from 'axios'

const Search: React.FC = () => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])

  const handleSearch = async () => {
    try {
      const res = await axios.post('/v1/search', {
        query,
        repo_id: 'demo'
      }, {
        headers: { 'X-API-Key': 'test_key' }
      })
      setResults(res.data.results)
    } catch (error) {
      console.error('Search error:', error)
    }
  }

  return (
    <div style={{ padding: '20px' }}>
      <h2>🔍 Semantic Code Search</h2>
      <div style={{ display: 'flex', gap: '10px' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search functions, classes, patterns..."
          style={{ flex: 1, padding: '10px' }}
        />
        <button onClick={handleSearch} style={{ padding: '10px 20px' }}>
          Search
        </button>
      </div>
      <div style={{ marginTop: '20px' }}>
        {results.map((result, i) => (
          <div key={i} style={{ 
            border: '1px solid #ddd', 
            marginBottom: '10px', 
            padding: '15px',
            borderRadius: '8px'
          }}>
            <h4>{result.file_path} (sim: {Math.round(result.similarity * 100)}%)</h4>
            <pre style={{ background: '#f5f5f5', padding: '10px', overflow: 'auto' }}>
              {result.content?.substring(0, 200)}...
            </pre>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Search
