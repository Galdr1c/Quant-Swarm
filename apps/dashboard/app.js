const state={report:null,filter:"ALL",selectedIndex:0};
const $=(id)=>document.getElementById(id);

document.addEventListener("DOMContentLoaded",()=>{
  $("refresh-button").addEventListener("click",loadReport);
  $("run-button").addEventListener("click",copyRunCommand);
  $("filters").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-filter]");
    if(!button)return;
    state.filter=button.dataset.filter;
    document.querySelectorAll(".filter").forEach((node)=>node.classList.toggle("active",node===button));
    renderTable();
  });
  loadReport();
});

async function loadReport(){
  try{
    const response=await fetch("/api/report",{cache:"no-store"});
    if(!response.ok)throw new Error("Report request failed: "+response.status);
    state.report=await response.json();
    state.selectedIndex=0;
    render();
    toast(state.report.demo?"Loaded demo dashboard data":"Research report refreshed");
  }catch(error){toast(error instanceof Error?error.message:String(error))}
}

function render(){
  const report=state.report;if(!report)return;
  const summary=report.summary||{};
  $("generated-at").textContent=formatDate(report.generatedAt);
  $("demo-badge").hidden=!report.demo;
  $("kpi-assets").textContent=formatInteger(summary.completed||0);
  $("kpi-assets-note").textContent=(summary.assets||0)+" configured · "+(summary.noSignal||0)+" no signal";
  $("kpi-positive").textContent=formatPercent(summary.positiveHoldoutRate||0,1);
  $("kpi-pass").textContent=String(summary.pass||0);
  $("kpi-pass-note").textContent=(summary.review||0)+" review · "+(summary.fail||0)+" fail";
  $("kpi-return").textContent=formatSignedPercent(summary.averageHoldoutReturn||0,1);
  $("median-sharpe").textContent=formatNumber(summary.medianHoldoutSharpe||0,2);
  const completed=(report.results||[]).filter((row)=>row.status==="COMPLETED");
  renderHero(completed[0]);renderValidation(completed[0]);renderTable();
  if(completed[0])renderDetail(completed[0],0);
}

function renderHero(row){
  if(!row){
    $("hero-symbol").textContent="No completed research";
    ["hero-return","hero-sharpe","hero-drawdown","hero-winrate"].forEach((id)=>$(id).textContent="—");
    setVerdict($("hero-verdict"),null);drawEquity([]);return;
  }
  $("hero-symbol").textContent=shortSymbol(row.symbol)+" · "+row.timeframe;
  $("hero-return").textContent=formatSignedPercent(row.finalHoldout?.netReturn,2);
  $("hero-sharpe").textContent=formatNumber(row.finalHoldout?.sharpe,2);
  $("hero-drawdown").textContent=formatSignedPercent(row.finalHoldout?.maxDrawdown,2);
  $("hero-winrate").textContent=formatPercent(row.finalHoldout?.winRate,1);
  setVerdict($("hero-verdict"),row.verdict);drawEquity(row.equityCurve||[]);
}

function renderValidation(row){
  const root=$("validation-list");root.innerHTML="";
  const checks=row?.checks?.slice(0,6)||[];
  if(!checks.length){
    root.innerHTML='<div class="validation-row"><div><strong>No validation evidence</strong><small>Run universe research first</small></div><em class="verdict neutral">—</em></div>';return;
  }
  checks.forEach((check)=>{
    const element=document.createElement("div");element.className="validation-row";
    element.innerHTML='<div><strong>'+escapeHtml(prettyCheck(check.name))+'</strong><small>'+escapeHtml(check.detail||metricDetail(check))+'</small></div><em class="verdict '+verdictClass(check.verdict)+'">'+escapeHtml(check.verdict)+'</em>';
    root.appendChild(element);
  });
}

function renderTable(){
  const root=$("opportunity-rows");root.innerHTML="";if(!state.report)return;
  const all=state.report.results||[];
  const rows=all.filter((row)=>state.filter==="ALL"||row.verdict===state.filter);
  rows.forEach((row)=>{
    const rank=all.indexOf(row)+1;const tr=document.createElement("tr");
    if(rank-1===state.selectedIndex)tr.classList.add("selected");
    const done=row.status==="COMPLETED";
    tr.innerHTML=
      '<td class="rank">'+String(rank).padStart(2,"0")+'</td>'+
      '<td class="market-cell"><strong>'+escapeHtml(shortSymbol(row.symbol))+'</strong><small>'+escapeHtml(exchangeName(row.symbol))+' · '+escapeHtml(row.timeframe)+'</small></td>'+
      '<td class="strategy-cell"><strong>'+escapeHtml(row.selectedStrategy?.name||statusLabel(row.status))+'</strong><small>'+escapeHtml(row.candidate?.type||row.error||"—")+'</small></td>'+
      '<td class="number '+numberClass(row.finalHoldout?.netReturn)+'">'+(done?formatSignedPercent(row.finalHoldout?.netReturn,2):"—")+'</td>'+
      '<td>'+(done?formatNumber(row.finalHoldout?.sharpe,2):"—")+'</td>'+
      '<td class="number '+numberClass(row.finalHoldout?.maxDrawdown)+'">'+(done?formatSignedPercent(row.finalHoldout?.maxDrawdown,2):"—")+'</td>'+
      '<td>'+(done?formatPercent(row.finalHoldout?.winRate,1):"—")+'</td>'+
      '<td><em class="verdict '+verdictClass(row.verdict)+'">'+escapeHtml(row.verdict||statusLabel(row.status))+'</em></td>';
    tr.addEventListener("click",()=>{
      state.selectedIndex=rank-1;renderDetail(row,rank-1);
      document.querySelectorAll("#opportunity-rows tr").forEach((node)=>node.classList.remove("selected"));tr.classList.add("selected");
    });
    root.appendChild(tr);
  });
  if(!rows.length)root.innerHTML='<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">No results in this filter.</td></tr>';
}

function renderDetail(row,index){
  $("detail-title").textContent=shortSymbol(row.symbol)+" · "+row.timeframe;
  const final=row.finalHoldout,validation=row.validation;
  $("detail-content").innerHTML=
    '<div class="detail-grid">'+
    detail("Rank","#"+(index+1))+detail("Candidate",row.candidate?.type||"—")+detail("Signal score",formatNumber(row.candidate?.score,2))+
    detail("Validation return",formatSignedPercent(validation?.netReturn,2))+detail("Holdout PF",formatNumber(final?.profitFactor,2))+detail("Trades",formatInteger(final?.totalTrades||0))+
    '</div><div class="detail-note"><strong>'+escapeHtml(row.selectedStrategy?.name||statusLabel(row.status))+'</strong><br>'+
    (row.runId?"Run: "+escapeHtml(row.runId)+"<br>":"")+
    'Ordering uses research verdict first, then final-holdout Sharpe and return. It is evidence ranking, not a promise of future profitability.</div>';
  if(row.status==="COMPLETED"){renderHero(row);renderValidation(row)}
}

function detail(label,value){return '<div class="detail-stat"><span>'+escapeHtml(label)+'</span><strong>'+escapeHtml(value)+'</strong></div>'}

function drawEquity(values){
  const line=$("line-path"),area=$("area-path");
  if(!Array.isArray(values)||values.length<2){line.setAttribute("d","");area.setAttribute("d","");return}
  const finite=values.map(Number).filter(Number.isFinite);if(finite.length<2)return;
  const width=760,top=22,bottom=228,min=Math.min(...finite),max=Math.max(...finite),range=Math.max(max-min,Math.abs(max)*.005,1);
  const points=finite.map((value,index)=>[(index/(finite.length-1))*width,bottom-((value-min)/range)*(bottom-top)]);
  const d=points.map(([x,y],index)=>(index===0?"M ":"L ")+x.toFixed(2)+" "+y.toFixed(2)).join(" ");
  line.setAttribute("d",d);area.setAttribute("d",d+" L "+width+" "+bottom+" L 0 "+bottom+" Z");
}

async function copyRunCommand(){
  const command="pnpm run dev:engine\n# separate terminal\npnpm run research:universe\n# separate terminal\npnpm run dashboard";
  try{await navigator.clipboard.writeText(command);toast("Run commands copied")}catch{toast("Run: pnpm run research:universe")}
}
function setVerdict(node,verdict){node.className="verdict "+verdictClass(verdict);node.textContent=verdict||"—"}
function verdictClass(v){return v==="PASS"?"pass":v==="REVIEW"?"review":v==="FAIL"?"fail":"neutral"}
function statusLabel(v){return v==="NO_SIGNAL"?"NO SIGNAL":v==="ERROR"?"ERROR":v||"—"}
function prettyCheck(v){return String(v||"check").replace(/[_-]+/g," ").replace(/\b\w/g,(c)=>c.toUpperCase())}
function metricDetail(c){const p=[];if(Number.isFinite(c.value))p.push("value "+formatNumber(c.value,3));if(Number.isFinite(c.threshold))p.push("threshold "+formatNumber(c.threshold,3));return p.join(" · ")||"Deterministic validation check"}
function exchangeName(v){return String(v||"").split(":")[0]||"TradingView"}
function shortSymbol(v){const s=String(v||"");return s.includes(":")?s.split(":").slice(1).join(":"):s}
function numberClass(v){const n=Number(v);return !Number.isFinite(n)?"":n>0?"positive":n<0?"negative":""}
function formatDate(v){const d=new Date(v);return Number.isNaN(d.valueOf())?"—":new Intl.DateTimeFormat(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d)}
function formatInteger(v){return new Intl.NumberFormat(undefined,{maximumFractionDigits:0}).format(Number(v)||0)}
function formatNumber(v,d=2){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):"—"}
function formatPercent(v,d=1){const n=Number(v);return Number.isFinite(n)?n.toFixed(d)+"%":"—"}
function formatSignedPercent(v,d=1){const n=Number(v);return Number.isFinite(n)?(n>0?"+":"")+n.toFixed(d)+"%":"—"}
function escapeHtml(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
let toastTimer;function toast(message){const node=$("toast");node.textContent=message;node.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove("show"),2200)}
