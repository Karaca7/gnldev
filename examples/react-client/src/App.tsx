import { GnlClient } from '@gnl/client';
import { useChat } from '@gnl/client/react';

// baseUrl '' → same-origin; the Vite proxy routes /agents,/runs to the :3000 backend.
const client = new GnlClient({ baseUrl: '' });

export function App() {
  const chat = useChat(client, 'assistant', { stream: true });

  return (
    <div style={{ maxWidth: 640, margin: '40px auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 18 }}>gnl · @gnl/client/react</h1>
      <p style={{ color: '#666', fontSize: 13 }}>useChat + streaming + interrupt approve (no API key needed).</p>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, minHeight: 200 }}>
        {chat.messages.length === 0 && <div style={{ color: '#999' }}>Type a message.</div>}
        {chat.messages.map((m, i) => (
          <div key={i} style={{ margin: '6px 0' }}>
            <b style={{ color: m.role === 'user' ? '#1f6feb' : '#2ea043' }}>{m.role}:</b> {m.content}
          </div>
        ))}
        {chat.loading && <div style={{ color: '#999' }}>…</div>}
      </div>

      {chat.interrupts.map((it) => (
        <div key={it.toolCallId} style={{ margin: '8px 0', padding: 8, border: '1px solid #d29922', borderRadius: 8 }}>
          ⏸ <b>{it.toolName}</b> awaiting approval{it.reason ? ` — ${it.reason}` : ''}
          <button onClick={() => chat.approve(it.toolCallId, true)} style={{ marginLeft: 8 }}>Approve</button>
          <button onClick={() => chat.approve(it.toolCallId, false)} style={{ marginLeft: 4 }}>Deny</button>
        </div>
      ))}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void chat.send();
        }}
        style={{ display: 'flex', gap: 8, marginTop: 10 }}
      >
        <input
          value={chat.input}
          onChange={(e) => chat.setInput(e.target.value)}
          placeholder="message…"
          style={{ flex: 1, padding: '6px 10px' }}
        />
        <button type="submit" disabled={chat.loading}>Send</button>
      </form>

      {chat.error && <div style={{ color: '#f85149', marginTop: 8 }}>{chat.error.message}</div>}
    </div>
  );
}
