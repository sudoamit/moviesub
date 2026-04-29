import React, { useState } from 'react'
import { Link } from 'react-router-dom'

const App = () => {
  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui' }}>
      <h1>🚀 Quant_2 - AI Coding Assistant</h1>
      <p>Better than Blackbox: Repo-aware, ultra-fast</p>
      <nav>
        <Link to="/chat">💬 Chat</Link> | 
        <Link to="/search">🔍 Code Search</Link>
      </nav>
    </div>
  )
}

export default App
