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
function detail(p){
  const lines=[`Iterations: ${p.iteration}`];
  const verify=verificationLine(p);
  if(verify) lines.push(verify);
  if(p.delivery) lines.push(`✓ ${p.delivery.summary||'Ready for final owner review.'}`);
  else if(p.error) lines.push(`Error: ${p.error.code?`${p.error.code}: `:''}${p.error.message}`);
  else lines.push('Autonomous work in progress. No owner action required.');
  return lines.join('\n');
}
async function load(){ const list=await fetch('/api/projects').then(r=>r.json()); projects.innerHTML=list.length?'':'<p>No projects yet.</p>'; for(const p of list){const div=document.createElement('article');div.className='card';div.innerHTML=`<div><h3>${esc(p.delivery?.productName||p.council?.discovery?.spec?.productName||'New project')}</h3><div class="meta">${esc(p.idea)}</div></div><div class="status ${statusClass(p.state)}">${esc(p.state.replaceAll('_',' '))}</div><div class="detail">${esc(detail(p))}</div>`;projects.appendChild(div)}}
$('#submit').onclick=async()=>{ $('#error').textContent=''; const idea=$('#idea').value.trim(); if(!idea)return $('#error').textContent='Describe the application or change first.'; const r=await fetch('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idea,projectPath:$('#path').value.trim()||null})});const data=await r.json();if(!r.ok)return $('#error').textContent=data.error||'Unable to start.';$('#idea').value='';await load()};$('#refresh').onclick=load;load();setInterval(load,5000);
