const $=s=>document.querySelector(s); const projects=$('#projects');
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function statusClass(s){return s==='READY_FOR_OWNER_REVIEW'?'ready':s==='FAILED'?'failed':'progress'}
function verificationLine(p){
  const level=p.delivery?.verificationLevel||p.verificationLevel;
  if(level==='MOCK'||p.demo) return 'Verification: MOCK — demo simulation, not a real application build.';
  if(level==='SELF_REPORTED') return 'Verification: SELF_REPORTED — Cursor-reported evidence, not platform-verified.';
  if(level==='PLATFORM_VERIFIED') return 'Verification: PLATFORM_VERIFIED';
  return '';
}
function progressLabel(p){
  if(p.state==='COUNCIL_DISCOVERY') return 'Planning architecture';
  if(p.state==='PROJECT_PROVISIONING') return 'Provisioning project';
  if(p.state==='PLATFORM_VERIFICATION' && p.iteration===0) return 'Verifying starter';
  if(p.state==='RUNTIME_VERIFICATION') return 'Runtime testing';
  if(p.state==='VISUAL_VERIFICATION') return 'Visual verification';
  if(p.state==='CURSOR_EXECUTING' && /visual|runtime|UI issue|clipp/i.test(p.activePrompt||'')) return 'Correcting UI issue';
  return null;
}
function detail(p){
  const lines=[`Iterations: ${p.iteration}`];
  const progress=progressLabel(p);
  if(progress && !p.delivery) lines.push(progress);
  if(p.repository?.workingBranch) lines.push(`Working branch: ${p.repository.workingBranch}`);
  if(p.repository?.cursorBackend) lines.push(`Cursor backend: ${p.repository.cursorBackend}`);
  if(p.repository?.workspacePath) lines.push('Repository isolated');
  const verify=verificationLine(p);
  if(verify) lines.push(verify);
  const sandbox=p.sandboxProvenance?.sandboxMode||p.evidence?.source?.sandboxMode;
  if(sandbox) lines.push(`Sandbox verification: ${sandbox=== 'CONTAINER_HARDENED'?'hardened container':'recorded ('+sandbox+')'}`);
  if(p.evidence?.security?.status) lines.push(`Security verification: ${p.evidence.security.status}`);
  if(p.delivery) lines.push(`✓ ${p.delivery.summary||'Ready for final owner review.'}`);
  else if(p.error) lines.push(`Error: ${p.error.code?`${p.error.code}: `:''}${p.error.message}`);
  else lines.push('Autonomous work in progress. No owner action required.');
  return lines.join('\n');
}
function token(){ const input=$('#token'); const stored=localStorage.getItem('adpOwnerToken')||''; if(input && !input.value) input.value=stored; return (input?.value||stored||'').trim(); }
function headers(extra={}){ const t=token(); if(t) localStorage.setItem('adpOwnerToken', t); return { ...extra, ...(t?{authorization:'Bearer '+t}:{}) }; }
async function load(){ const list=await fetch('/api/projects',{headers:headers()}).then(r=>r.json()); if(!Array.isArray(list)) { projects.innerHTML='<p>Authentication required.</p>'; return; } projects.innerHTML=list.length?'':'<p>No projects yet.</p>'; for(const p of list){const div=document.createElement('article');div.className='card';div.innerHTML=`<div><h3>${esc(p.delivery?.productName||p.council?.discovery?.spec?.productName||'New project')}</h3><div class="meta">${esc(p.idea)}</div></div><div class="status ${statusClass(p.state)}">${esc(p.state.replaceAll('_',' '))}</div><div class="detail">${esc(detail(p))}</div>`;projects.appendChild(div)}}
$('#submit').onclick=async()=>{ $('#error').textContent=''; const idea=$('#idea').value.trim(); if(!idea)return $('#error').textContent='Describe the application or change first.'; if(!token()) return $('#error').textContent='Owner API token is required.'; const r=await fetch('/api/projects',{method:'POST',headers:headers({'content-type':'application/json'}),body:JSON.stringify({idea,projectPath:$('#path').value.trim()||null})});const data=await r.json();if(!r.ok)return $('#error').textContent=data.error||'Unable to start.';$('#idea').value='';await load()};$('#refresh').onclick=load;load();setInterval(load,5000);
