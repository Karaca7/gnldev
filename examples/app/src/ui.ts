// Single-file web UI (no build) — support desk: ticket list + chat + refund approval flow.
export const APP_HTML = /* html */ `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Durable Support Desk</title>
<style>
 :root{--bg:#0e1116;--panel:#161b22;--line:#272e38;--txt:#e6edf3;--mut:#8b949e;--acc:#3fb950;--warn:#d29922;--blue:#58a6ff}
 *{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--txt);height:100vh;display:flex;flex-direction:column}
 header{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
 header b{font-size:15px} header a{color:var(--blue);font-size:12px;text-decoration:none}
 main{flex:1;display:flex;min-height:0}
 #left{width:300px;border-right:1px solid var(--line);overflow:auto;padding:10px}
 #new{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
 input,button{font:inherit} input{background:var(--panel);border:1px solid var(--line);color:var(--txt);border-radius:6px;padding:6px 9px}
 .btn{cursor:pointer;border:1px solid var(--line);background:#1b222c;color:var(--txt);border-radius:6px;padding:6px 11px}
 .btn:hover{border-color:var(--acc)} .btn.deny:hover{border-color:#f85149}
 .tk{padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:6px 0;cursor:pointer} .tk:hover{background:#1b222c} .tk.sel{background:#1f2630}
 .tk .s{color:var(--mut);font-size:12px} .badge{font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid var(--warn);color:var(--warn)}
 #right{flex:1;display:flex;flex-direction:column;min-height:0}
 #msgs{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
 .m{max-width:75%;padding:8px 12px;border-radius:10px;white-space:pre-wrap}
 .m.user{align-self:flex-end;background:#1f3a5f} .m.assistant{align-self:flex-start;background:var(--panel)} .m.system{align-self:center;color:var(--warn);font-size:12px;background:none}
 #compose{border-top:1px solid var(--line);padding:10px;display:flex;gap:8px} #compose input{flex:1}
 #approve{padding:8px 16px;border-top:1px solid var(--warn);background:#241f12;display:none;gap:8px;align-items:center}
 #approve.show{display:flex} #ops{border-top:1px solid var(--line);padding:6px 16px;color:var(--mut);font-size:12px;display:flex;gap:16px}
 .empty{color:var(--mut);padding:40px;text-align:center}
</style></head><body>
<header><b>🎫 Durable Support Desk</b><span><a href="/studio" target="_blank">ops studio ↗</a> · exactly-once / durable</span></header>
<main>
 <div id="left">
  <div id="new"><input id="cust" placeholder="customer (cust-1)" value="cust-1"><input id="subj" placeholder="subject (refund request)" value="refund request"><button class="btn" onclick="newTicket()">+ Open ticket</button></div>
  <div id="tks"></div>
 </div>
 <div id="right">
  <div id="msgs"><div class="empty">Open or select a ticket.</div></div>
  <div id="approve"><span id="areason"></span><button class="btn" onclick="approve(true)">Approve</button><button class="btn deny" onclick="approve(false)">Reject</button></div>
  <div id="compose"><input id="ci" placeholder="write a message… (e.g. I want a refund for ORD-1042)" onkeydown="if(event.key==='Enter')send()"><button class="btn" onclick="send()">Send</button></div>
  <div id="ops"></div>
 </div>
</main>
<script>
const esc=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
let cur=null;
async function j(u,o){return (await fetch(u,o)).json()}
async function loadTickets(){const ts=await j('/api/tickets');document.getElementById('tks').innerHTML=ts.map(t=>\`<div class="tk \${t.id===cur?'sel':''}" onclick="open_('\${t.id}')"><b>\${esc(t.subject)}</b> \${t.status==='awaiting-approval'?'<span class="badge">approval</span>':''}<div class="s">\${esc(t.id)} · \${esc(t.customerId)}</div></div>\`).join('')||'<div class="empty">no tickets</div>';loadOps()}
async function loadOps(){const o=await j('/api/ops');document.getElementById('ops').innerHTML=\`💸 refunds: \${o.refunds.count} ($\${o.refunds.total}) · ✉️ emails: \${o.emailsSent} · 🔔 notifications: \${o.notifications} · 🎫 \${o.tickets}\`}
async function open_(id){cur=id;await render();loadTickets()}
async function render(){if(!cur)return;const t=await j('/api/tickets/'+cur);document.getElementById('msgs').innerHTML=t.messages.map(m=>\`<div class="m \${m.role}">\${esc(m.text)}</div>\`).join('')||'<div class="empty">no messages</div>';const ap=document.getElementById('approve');if(t.pending){ap.classList.add('show');document.getElementById('areason').textContent='⏸ '+t.pending.reason}else ap.classList.remove('show');const ms=document.getElementById('msgs');ms.scrollTop=ms.scrollHeight}
async function newTicket(){const customerId=document.getElementById('cust').value.trim(),subject=document.getElementById('subj').value.trim();const r=await j('/api/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerId,subject})});if(r.ticketId){cur=r.ticketId;await loadTickets();render()}}
async function send(){const i=document.getElementById('ci');const text=i.value.trim();if(!text||!cur)return;i.value='';await j('/api/tickets/'+cur+'/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});await render();loadTickets()}
async function approve(ok){if(!cur)return;await j('/api/tickets/'+cur+'/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({approve:ok})});await render();loadTickets()}
window.open_=open_;window.newTicket=newTicket;window.send=send;window.approve=approve;
loadTickets();setInterval(loadOps,2000);
</script></body></html>`;
