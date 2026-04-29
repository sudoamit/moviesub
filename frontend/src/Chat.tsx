import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'

const Chat: React.FC = () => {
  const [messages, setMessages] = useState<{role: string, content: string}[]>([])
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim()) return
    
    const userMsg = { role: 'user', content: input }
    setMessages(prev => [...prev, userMsg])
    setInput('')

    try {
      // Proxy via backend
      const res = await axios.post('/v1/chat', {
        message: input,
        repo_id: 'demo',
        open_files: [] // From extension
      }, { 
        headers: { 'X-API-Key': 'test_key' },
        responseType: 'stream'
      })

      // Streaming parser (simplified)
      let assistantMsg = { role: 'assistant', content: '' }
      setMessages(prev => [...prev, assistantMsg])
      
      // Parse stream
      const reader = res.data.getReader()
      const decoder = new TextDecoder()
      
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        
        const chunk = decoder.decode(value)
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') break
            const parsed = JSON.parse(data)
            if (parsed.choices[0].delta.content) {
              assistantMsg.content += parsed.choices[0].delta.content
              setMessages(prev => prev.map(m => 
                m === assistantMsg ? {...m, content: assistantMsg.content} : m
              ))
            }
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error)
    }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: '20px', textAlign: msg.role === 'user' ? 'right' : 'left' }}>
            <div style={{
              display: 'inline-block', 
              padding: '10px 15px', 
              borderRadius: '20px',
              background: msg.role === 'user' ? '#007acc' : '#f1f1f1',
              color: msg.role === 'user' ? 'white' : 'black',
              maxWidth: '70%'
            }}>
              {msg.content}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div style={{ padding: '20px', borderTop: '1px solid #ddd' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Ask anything about your code..."
          style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: '5px' }}
        />
        <button onClick={sendMessage} style={{ marginLeft: '10px', padding: '10px 20px' }}>Send</button>
      </div>
    </div>
  )
}

export default Chat
