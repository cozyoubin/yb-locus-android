(() => {
  'use strict';
  if (!location.hostname.endsWith('land.naver.com')) return;
  if (window.__SANGA_INVEST_MOBILE__) return;
  window.__SANGA_INVEST_MOBILE__ = true;
  const APP_VERSION = '2.8.0';

  const ID = 'sanga-invest-panel';
  const LAUNCHER_ID = 'sanga-invest-launcher';
  const BACKDROP_ID = 'sanga-invest-backdrop';
  const DEFAULTS = {
    radius: 500,
    targetYield: 6.0,
    serviceKey: '',
    manualUnits: '',
    includeOfficetel: true,
    panelCollapsed: false,
    purchasePrice: '',
    loanRatio: 80,
    interestRate: 5.1,
    acquisitionCostRate: 5.0,
    tenantDeposit: '',
    tenantRent: '',
    vacancyRate: 5,
    ownerMonthlyCost: 0,
    unitMode: 'py'
  };
  let settings = {...DEFAULTS};
  let latest = null;
  let lastHref = location.href;
  let refreshTimer = null;
  let regionRefreshTimer = null;
  let lastCenterSignature = '';
  let typeSheetTimer = null;
  let lastObservedCenter = null;
  let lastGoodDomListings = null;
  let lastObservedArticleUrl = '';
  let lastNaverAuthHeader = '';
  const capturedArticleMap = new Map();
  let typeSheetArmedUntil = 0;
  let userTypeOverride = false;
  let returnToAnalyzerOnBack = false;
  let analysisRunSeq = 0;
  // Activity가 상태와 retry 예산을 소유하고, 문서 ID로 오래된 작업을 무효화한다.
  const landingPageId = Number(window.__YBLOCUS_LANDING_PAGE__);
  const LANDING_MAX_ATTEMPTS = 3;
  const LANDING_RETRY_MS = 1000;
  const LANDING_SETTLE_MS = 350;
  let landingStarted = false;
  const TYPE_OVERRIDE_KEY = 'ybLocusTypeOverride';

  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const fmt = (n, d=0) => Number.isFinite(n) ? n.toLocaleString('ko-KR', {maximumFractionDigits:d, minimumFractionDigits:d}) : '-';
  const clamp = (n,a,b) => Math.min(b,Math.max(a,n));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const TYPE_HIDE_LABELS = new Set([
    '아파트','재건축','오피스텔','빌라','아파트 분양권','오피스텔 분양권',
    '재개발','원룸','단독/다가구','전원주택','상가주택','토지','건물',
    '공장/창고','지식산업센터'
  ]);
  const TYPE_KEEP_LABELS = new Set(['상가','사무실']);

  function exactText(el){ return (el?.textContent || '').replace(/\s+/g,' ').trim(); }
  function findPropertyTypeSheet(){
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,strong,b,span,div,p')]
      .filter(el => exactText(el) === '매물유형');
    for(const h of headings){
      let root=h;
      for(let i=0;i<7 && root;i++,root=root.parentElement){
        const t=exactText(root);
        if(t.includes('상가·업무·토지') && (t.includes('아파트') || t.includes('재건축')) && t.includes('상가')) return root;
      }
    }
    return null;
  }
  function clickableFor(el, root){
    let n=el;
    for(let i=0;i<9 && n && n!==root;i++,n=n.parentElement){
      if(n.matches?.('button,a,[role="button"],label,li,[tabindex]')) return n;
      try{ if(getComputedStyle(n).cursor==='pointer') return n; }catch(_e){}
    }
    return el;
  }
  function fireClick(el){
    if(!el || !landingActive()) return false;
    try{
      const r=el.getBoundingClientRect();
      const x=Math.max(1,Math.min(innerWidth-2,r.left+r.width/2));
      const y=Math.max(1,Math.min(innerHeight-2,r.top+r.height/2));
      const hit=document.elementFromPoint(x,y) || el;
      for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){
        const C=type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        hit.dispatchEvent(new C(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window,pointerId:1,pointerType:'touch',isPrimary:true}));
      }
      return true;
    }catch(_e){ try{el.click();return true;}catch(__e){return false;} }
  }
  function simplifyPropertyTypeSheet(){
    // 상가/사무실은 기본 선택값일 뿐, 사용자가 다른 유형을 고르는 기능은 그대로 둔다.
    document.documentElement.classList.remove('sanga-type-sheet-open');
    const launcher=document.getElementById(LAUNCHER_ID);
    if(launcher) launcher.removeAttribute('aria-hidden');
    $$('.sanga-hide-property-type,.sanga-keep-property-type').forEach(el=>{
      el.classList.remove('sanga-hide-property-type','sanga-keep-property-type');
    });
  }
  function visible(el){
    if(!el) return false;
    const r=el.getBoundingClientRect();
    const cs=getComputedStyle(el);
    return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && cs.display!=='none' && cs.visibility!=='hidden';
  }
  function naverUnitControl(){
    // 버튼은 전환할 단위를 표시한다: '평'이면 현재 ㎡, '㎡'이면 현재 평.
    // 지도 우측의 실제 버튼을 유일하게 찾지 못하면 READY로 처리하지 않는다.
    const candidates=[...document.querySelectorAll('button,a,[role="button"]')]
      .filter(el=>!el.closest?.('#'+ID+',#'+LAUNCHER_ID+',#'+BACKDROP_ID))
      .filter(el=>['평','㎡'].includes(exactText(el)) && visible(el))
      .filter(el=>{
        const r=el.getBoundingClientRect();
        return r.width<=100 && r.height<=100 && r.left>innerWidth*0.55 && r.top>150;
      });
    return candidates.length===1 ? candidates[0] : null;
  }
  function ensureNaverPyeongDefault(){
    if(!landingActive()) return false;
    const control=naverUnitControl();
    if(!control) return false;
    if(exactText(control)==='평') control.click();
    return true; // 성공은 클릭 반환값이 아닌 verifyLandingDefaults에서 판정한다.
  }

  function setUserTypeOverride(v){
    userTypeOverride=!!v;
    try{ sessionStorage.setItem(TYPE_OVERRIDE_KEY,userTypeOverride?'1':'0'); }catch(_e){}
  }
  // v1.8: 기존 URL 강제전환은 사용하지 않고, 최초 기본값은 필터 시트를 통해 적용한다.
  // Naver가 new.land.naver.com -> fin.land.naver.com 으로 리다이렉트한 뒤
  // 현재 origin에 /offices를 강제로 붙이면 존재하지 않는 주소가 되어 404가 발생할 수 있다.
  // 따라서 페이지 이동/지역 이동 중에는 URL을 재작성하지 않고 사용자의 선택을 그대로 존중한다.
  function installPropertyTypeIntentGuard(){
    if(window.__YBLOCUS_TYPE_INTENT__) return;
    window.__YBLOCUS_TYPE_INTENT__=true;
    document.addEventListener('click',e=>{
      const target=e.target?.closest?.('button,a,[role="button"],label,li,span,div');
      if(!target || target.closest?.(`#${ID},#${LAUNCHER_ID},#${BACKDROP_ID}`)) return;
      const t=exactText(target);
      if(!t) return;
      const sheet=findPropertyTypeSheet();
      const topTypeChip=/상가\s*,?\s*사무실|아파트.*재건축|매물유형/.test(t) && target.getBoundingClientRect().top<420;
      if(topTypeChip) typeSheetArmedUntil=Date.now()+8000;
      const inSheet=!!(sheet && sheet.contains(target));
      if(!inSheet && Date.now()>typeSheetArmedUntil) return;
      const compact=t.replace(/\s+/g,'');
      const known=['아파트','재건축','오피스텔','빌라','아파트분양권','오피스텔분양권','재개발','원룸','단독/다가구','전원주택','상가주택','토지','건물','공장/창고','지식산업센터','상가','사무실'];
      const hit=known.find(x=>compact===x.replace(/\s+/g,''));
      if(!hit) return;
      if(hit==='상가' || hit==='사무실') setUserTypeOverride(false);
      else setUserTypeOverride(true);
      typeSheetArmedUntil=0;
    },true);
  }

  // v2.0: offices URL을 사용하되 실제 상단 필터칩을 정확히 찾아 초기값을 확정한다.
  // 앱 시작 직후 실제 필터 시트를 한 번만 조작해 '상가+사무실 / 매매+월세'를 확실한 초기값으로 만든다.
  // 초기 설정 완료 뒤에는 같은 앱 실행 동안 사용자의 필터 변경을 절대 덮어쓰지 않는다.
  const PROPERTY_LABELS = [
    '아파트 분양권','오피스텔 분양권','단독/다가구','공장/창고','지식산업센터',
    '아파트','재건축','오피스텔','빌라','재개발','원룸','전원주택','상가주택',
    '상가','토지','사무실','건물'
  ];
  const TRADE_LABELS = ['매매','전세','월세','단기임대'];

  function topChipByLabels(labels){
    // v2.7: 네이버 상단 필터칩이 button이 아닌 div/span 구조여도 찾는다.
    // 화면 상단의 짧은 텍스트 요소를 먼저 찾고 실제 클릭 가능한 조상으로 올린다.
    const isTrade=labels===TRADE_LABELS;
    const allowed=new Set(labels.map(x=>x.replace(/\s+/g,'')));
    const raw=[...document.querySelectorAll('button,[role="button"],a,div,span,p,strong')]
      .filter(el=>!el.closest?.(`#${ID},#${LAUNCHER_ID},#${BACKDROP_ID}`))
      .filter(visible)
      .map(el=>({el,t:exactText(el),r:el.getBoundingClientRect()}))
      .filter(x=>{
        const {r,t}=x;
        if(!t || t.length>45) return false;
        if(r.top<55 || r.top>205 || r.width<55 || r.width>innerWidth*0.82 || r.height<20 || r.height>90) return false;
        const parts=t.split(',').map(v=>v.replace(/\s+/g,'').trim()).filter(Boolean);
        if(!parts.length || parts.length>5 || !parts.every(v=>allowed.has(v))) return false;
        if(isTrade && r.left>innerWidth*0.52) return false;
        if(!isTrade && r.right<innerWidth*0.30) return false;
        return true;
      })
      .map(x=>({...x,hits:selectedLabelsFromSummary(x.t,labels).length}))
      .filter(x=>x.hits>0);
    if(!raw.length) return null;
    // 같은 문구가 부모/자식에 반복되면 가장 작은 실제 표시 요소를 우선한다.
    raw.sort((a,b)=>(b.hits-a.hits)||((a.r.width*a.r.height)-(b.r.width*b.r.height))||(a.r.top-b.r.top));
    return clickableFor(raw[0].el,null);
  }

  function selectedLabelsFromSummary(text, labels){
    const compact=String(text||'').replace(/\s+/g,'');
    const out=[];
    // 먼저 쉼표 구분값을 정확히 읽는다.
    const parts=String(text||'').split(',').map(x=>x.replace(/\s+/g,'').trim()).filter(Boolean);
    for(const label of labels){
      const c=label.replace(/\s+/g,'');
      if(parts.includes(c)) out.push(label);
    }
    if(out.length) return out;
    // 사이트 문구가 바뀌어 쉼표가 없어도 긴 라벨부터 중복 없이 복원한다.
    let rest=compact;
    for(const label of [...labels].sort((a,b)=>b.length-a.length)){
      const c=label.replace(/\s+/g,'');
      if(rest.includes(c)){
        out.push(label);
        rest=rest.replace(c,'');
      }
    }
    return out;
  }

  function findSheetByHeading(heading){
    const hs=[...document.querySelectorAll('h1,h2,h3,h4,strong,b,span,div,p')]
      .filter(el=>exactText(el)===heading && visible(el));
    for(const h of hs){
      let root=h;
      for(let i=0;i<8 && root;i++,root=root.parentElement){
        const t=exactText(root);
        if(heading==='매물유형'){
          if(t.includes('상가·업무·토지') && t.includes('상가') && t.includes('사무실')) return root;
        }else if(heading==='거래유형'){
          if(t.includes('매매') && t.includes('전세') && t.includes('월세')) return root;
        }
      }
    }
    return null;
  }

  function findExactOption(root,label){
    if(!root) return null;
    const exact=String(label||'').replace(/\s+/g,'');
    // 옵션 버튼 자체를 먼저 찾는다. wrapper div/span을 고르면 클릭이 무시되는 경우가 있다.
    const direct=[...root.querySelectorAll('button,[role="button"],label,a,div,span,li')]
      .filter(visible)
      .filter(el=>exactText(el).replace(/\s+/g,'')===exact);
    if(direct.length){
      direct.sort((a,b)=>{
        const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
        return (ra.width*ra.height)-(rb.width*rb.height);
      });
      return direct[0];
    }
    const els=[...root.querySelectorAll('span,div,li')]
      .filter(visible)
      .filter(el=>exactText(el).replace(/\s+/g,'')===exact);
    let best=null, bestArea=Infinity;
    for(const el of els){
      const c=clickableFor(el,root);
      const r=c?.getBoundingClientRect?.();
      if(!r || r.width<20 || r.height<20) continue;
      const area=r.width*r.height;
      if(area<bestArea){ best=c; bestArea=area; }
    }
    return best;
  }

  function optionSelected(el){
    if(!el) return null;
    const node=el.matches?.('button,[role="button"],label,a')?el:clickableFor(el,null);
    if(!node) return null;
    const ariaPressed=node.getAttribute?.('aria-pressed');
    if(ariaPressed==='true') return true;
    if(ariaPressed==='false') return false;
    const ariaSelected=node.getAttribute?.('aria-selected');
    if(ariaSelected==='true') return true;
    if(ariaSelected==='false') return false;
    const input=node.matches?.('input')?node:node.querySelector?.('input[type="checkbox"],input[type="radio"]');
    if(input) return !!input.checked;
    const cls=String(node.className||'').toLowerCase();
    if(/(^|\s|_|-)(active|selected|checked|on)(\s|_|-|$)/.test(cls)) return true;
    try{
      const cs=getComputedStyle(node);
      const bw=Math.max(parseFloat(cs.borderTopWidth)||0,parseFloat(cs.borderRightWidth)||0,parseFloat(cs.borderBottomWidth)||0,parseFloat(cs.borderLeftWidth)||0);
      const bc=String(cs.borderTopColor||'');
      const m=bc.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      const dark=m && (+m[1]+ +m[2]+ +m[3] < 300);
      // 현재 네이버 필터 시트는 선택된 항목을 진한 테두리로 표시한다.
      if(bw>=1 && dark) return true;
      const bg=String(cs.backgroundColor||'');
      const b=bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if(b && +b[1]>235 && +b[2]>235 && +b[3]>235 && bw<1) return false;
    }catch(_e){}
    return null;
  }

  async function enforceFilterSelection(kind,desired){
    // v2.6: 선택 여부를 CSS 색/테두리로 추측하지 않는다.
    // 상단 요약칩에 실제로 적힌 선택값만 기준으로, 필요한 항목만 정확히 한 번 토글한다.
    const labels=kind==='property'?PROPERTY_LABELS:TRADE_LABELS;
    const desiredSet=new Set(desired);
    // 재시도는 runInitialLanding 한 곳에서만 관리한다.
    if(landingActive()){
      const chip=topChipByLabels(labels);
      if(!chip) return false;
      const selected=new Set(selectedLabelsFromSummary(exactText(chip),labels));
      const exact=selected.size===desiredSet.size && [...desiredSet].every(x=>selected.has(x));
      if(exact){ await closeFilterSheet(kind); return true; }

      let sheet=await openFilterSheet(kind);
      if(!sheet || !landingActive()) return false;
      const toToggle=[];
      for(const label of labels) if(selected.has(label) && !desiredSet.has(label)) toToggle.push(label);
      for(const label of desired) if(!selected.has(label)) toToggle.push(label);
      for(const label of toToggle){
        if(!landingActive()) return false;
        const option=findExactOption(sheet,label);
        if(option){
          fireClick(option);
          await sleep(300);
          sheet=findSheetByHeading(kind==='property'?'매물유형':'거래유형')||sheet;
        }
      }
      await closeFilterSheet(kind);
      await sleep(620);
      const afterChip=topChipByLabels(labels);
      const after=new Set(selectedLabelsFromSummary(exactText(afterChip),labels));
      if(after.size===desiredSet.size && [...desiredSet].every(x=>after.has(x))) return true;
    }
    return false;
  }

  async function enforceTradePairDeterministic(){
    return enforceFilterSelection('trade',['매매','월세']);
  }

  async function openFilterSheet(kind){
    if(!landingActive()) return null;
    const labels=kind==='property'?PROPERTY_LABELS:TRADE_LABELS;
    const heading=kind==='property'?'매물유형':'거래유형';
    let sheet=findSheetByHeading(heading);
    if(sheet) return sheet;
    const chip=topChipByLabels(labels);
    if(!chip) return null;
    fireClick(chip);
    for(let i=0;i<12;i++){
      await sleep(100);
      if(!landingActive()) return null;
      sheet=findSheetByHeading(heading);
      if(sheet) return sheet;
    }
    return null;
  }

  async function clickOptionIfNeeded(kind,label){
    const heading=kind==='property'?'매물유형':'거래유형';
    let sheet=findSheetByHeading(heading);
    if(!sheet) return false;
    const option=findExactOption(sheet,label);
    if(!option) return false;
    fireClick(option);
    await sleep(220);
    return true;
  }

  async function closeFilterSheet(kind){
    if(!landingActive()) return;
    const labels=kind==='property'?PROPERTY_LABELS:TRADE_LABELS;
    const heading=kind==='property'?'매물유형':'거래유형';
    if(!findSheetByHeading(heading)) return;
    const chip=topChipByLabels(labels);
    if(chip){
      fireClick(chip);
      await sleep(240);
      return;
    }
    // v2.3: 시트를 닫기 위해 지도영역을 강제로 클릭하지 않는다.
    // 이전 버전은 이 보조 클릭이 지도 마커를 눌러 '매물 1' 패널을 자동으로 열 수 있었다.
    // 상단칩을 찾지 못하면 아무 곳도 누르지 않고 다음 재시도에 맡긴다.
    return;
  }

  function autoCollapseAccidentalSingleListing(){
    // 초기 필터 설정 과정에서 네이버가 단일 매물 시트를 열었더라도 첫 화면은 지도로 복구한다.
    try{
      const lower=[...document.querySelectorAll('div,section,aside')]
        .filter(visible)
        .map(el=>({el,t:exactText(el),r:el.getBoundingClientRect()}))
        .filter(x=>/^매물\s*1(?:\s|$)/.test(x.t) && x.r.top>innerHeight*0.38 && x.r.bottom>innerHeight*0.90 && x.r.width>innerWidth*0.82)
        .sort((a,b)=>a.r.top-b.r.top)[0];
      if(!lower) return false;
      const ratio=clamp(lower.r.top/Math.max(1,innerHeight),0.05,0.88);
      if(typeof SangaNative!=='undefined' && SangaNative.collapseNaverSheet){
        SangaNative.collapseNaverSheet(window.__SANGA_BRIDGE_TOKEN__||'',ratio);
        return true;
      }
    }catch(_e){}
    return false;
  }

  function summaryMatches(kind){
    const labels=kind==='property'?PROPERTY_LABELS:TRADE_LABELS;
    const chip=topChipByLabels(labels);
    if(!chip) return false;
    const selected=selectedLabelsFromSummary(exactText(chip),labels);
    if(kind==='property'){
      return selected.length===2 && selected.includes('상가') && selected.includes('사무실');
    }
    return selected.length===2 && selected.includes('매매') && selected.includes('월세');
  }

  function landingActive(){
    try{
      return Number.isInteger(landingPageId) && SangaNative.isLandingActive(
        window.__SANGA_BRIDGE_TOKEN__||'',landingPageId);
    }catch(_e){ return false; }
  }
  function reportLandingState(state){
    try{
      return SangaNative.updateLandingState(window.__SANGA_BRIDGE_TOKEN__||'',landingPageId,state);
    }catch(_e){ return false; }
  }
  function verifyLandingDefaults(){
    return landingActive()
      && !findSheetByHeading('매물유형') && !findSheetByHeading('거래유형')
      && summaryMatches('property') && summaryMatches('trade')
      && exactText(naverUnitControl())==='㎡';
  }
  async function runInitialLanding(){
    if(landingStarted || !landingActive()) return;
    landingStarted=true;
    // onPageFinished 후 한 번만 진입한다. observer/분석/지도 이동에서는 호출하지 않는다.
    await sleep(250);
    for(let attempt=0;attempt<LANDING_MAX_ATTEMPTS && landingActive();attempt++){
      try{
        if(!SangaNative.beginLandingAttempt(window.__SANGA_BRIDGE_TOKEN__||'',landingPageId)) return;
        const propertyOk=await enforceFilterSelection('property',['상가','사무실']);
        const tradeOk=propertyOk && await enforceTradePairDeterministic();
        if(tradeOk && landingActive()){
          ensureNaverPyeongDefault();
          // 기존 단일매물 시트 접기는 커버 뒤에서, 검증 전에만 수행한다.
          autoCollapseAccidentalSingleListing();
        }
        if(!reportLandingState('VERIFYING_DEFAULTS')) return;
        await sleep(LANDING_SETTLE_MS);
        if(verifyLandingDefaults()){
          // 클릭 직후 일시적인 요약값을 성공 처리하지 않도록 안정 상태를 재확인한다.
          await sleep(LANDING_SETTLE_MS);
          if(verifyLandingDefaults()){
            setUserTypeOverride(false);
            reportLandingState('READY');
            return;
          }
        }
      }catch(_e){
        // 예외도 같은 retry 예산을 소비한다. 전체 deadline은 native가 FAILED로 처리한다.
      }
      if(attempt<LANDING_MAX_ATTEMPTS-1 && landingActive()) await sleep(LANDING_RETRY_MS);
    }
    reportLandingState('FAILED');
  }

  function setNativeListSheetOpen(open){
    try{
      if(typeof SangaNative!=='undefined' && SangaNative.setNaverListSheetOpen){
        SangaNative.setNaverListSheetOpen(window.__SANGA_BRIDGE_TOKEN__||'',!!open);
      }
    }catch(_e){}
  }
  function installNaverListSheetTracker(){
    if(window.__YBLOCUS_LIST_SHEET_TRACKER__) return;
    window.__YBLOCUS_LIST_SHEET_TRACKER__=true;
    document.addEventListener('click',e=>{
      let n=e.target;
      for(let i=0;i<6 && n;i++,n=n.parentElement){
        if(!n.getBoundingClientRect) continue;
        const t=exactText(n);
        if(!/^매물\s*[\d,]+(?:\s+단지\s*[\d,]+)?$/.test(t)) continue;
        const r=n.getBoundingClientRect();
        if(r.top>innerHeight*0.58 && r.width>90){ setNativeListSheetOpen(true); break; }
      }
    },true);
  }

  function cleanNums(nums){ return nums.filter(Number.isFinite).sort((x,y)=>x-y); }
  function mean(nums){
    const a=nums.filter(Number.isFinite);
    return a.length ? a.reduce((s,v)=>s+v,0)/a.length : NaN;
  }
  function median(nums){
    const a = cleanNums(nums);
    if(!a.length) return NaN;
    const m = Math.floor(a.length/2);
    return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
  }
  function percentile(nums,p){
    const a=cleanNums(nums);
    if(!a.length) return NaN;
    if(a.length===1) return a[0];
    const pos=(a.length-1)*p, lo=Math.floor(pos), hi=Math.ceil(pos), w=pos-lo;
    return a[lo]*(1-w)+a[hi]*w;
  }
  function trimmedMean(nums, trim=.1){
    const a = cleanNums(nums);
    if(!a.length) return NaN;
    const k = Math.floor(a.length*trim);
    const b = a.slice(k, a.length-k || a.length);
    return b.reduce((s,v)=>s+v,0)/b.length;
  }
  function statPack(nums){
    const a=cleanNums(nums);
    return {
      count:a.length,
      mean:mean(a), median:median(a), trimmed:trimmedMean(a),
      p10:percentile(a,.10), p25:percentile(a,.25), p90:percentile(a,.90),
      min:a.length?a[0]:NaN, max:a.length?a[a.length-1]:NaN
    };
  }
  function haversine(lat1, lon1, lat2, lon2){
    const R=6371000, toRad=x=>x*Math.PI/180;
    const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
    const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  }
  function bbox(lat, lon, radius){
    const dLat = radius/111320;
    const dLon = radius/(111320*Math.cos(lat*Math.PI/180));
    return {topLat:lat+dLat,bottomLat:lat-dLat,leftLon:lon-dLon,rightLon:lon+dLon};
  }
  function parseMoneyToManwon(text){
    if(!text) return NaN;
    const t=String(text).replace(/,/g,'').replace(/\(.*$/,'').trim();
    const e=t.match(/(\d+(?:\.\d+)?)억/);
    let n=e?parseFloat(e[1])*10000:0;
    const after=e?t.slice(e.index+e[0].length):t;
    const rest=after.match(/(\d+(?:\.\d+)?)/);
    if(rest) n+=parseFloat(rest[1]);
    if(!e && rest) n=parseFloat(rest[1]);
    return n;
  }
  function parseAreaPy(item){
    const spec = $('.spec', item)?.textContent || '';
    // 네이버 모바일은 '계약137.42m² (전용113.7)'처럼 전용 뒤에 ㎡를 생략하기도 한다.
    const exclusive=spec.match(/전용\s*([\d,.]+)/i);
    if(exclusive){
      const sqm=parseFloat(exclusive[1].replace(/,/g,''));
      if(Number.isFinite(sqm)&&sqm>0) return sqm*0.3025;
    }
    const nums = [...spec.matchAll(/([\d.]+)m²/g)].map(m=>parseFloat(m[1])).filter(Number.isFinite);
    if(!nums.length) return NaN;
    let sqm = nums[0];
    if(nums.length>=2 && nums[1] < nums[0]) sqm = nums[1];
    return sqm*0.3025;
  }
  function parseFloor(item){
    const spec = $('.spec', item)?.textContent || '';
    const m=spec.match(/(?:^|,\s*)(B?\d+|지하\s*\d+)\s*\/\s*(\d+)층/);
    if(!m) return null;
    const s=m[1];
    if(/^B/i.test(s)) return -parseInt(s.slice(1),10);
    if(/^지하/.test(s)) return -parseInt(s.replace(/\D/g,''),10);
    return parseInt(s,10);
  }
  function annotateListings(){
    $$('.item_inner:not(.is-loading)').forEach((item)=>{
      const type=$('.type',item)?.textContent?.trim();
      const priceEl=$('.price',item);
      const priceText=priceEl?.childNodes?.[0]?.textContent?.trim() || priceEl?.textContent?.trim() || '';
      const areaPy=parseAreaPy(item);
      if(!priceEl || !type || !Number.isFinite(areaPy) || areaPy<=0) return;
      const clean=priceText.replace(/\(.*$/,'').replace(/~.*$/,'').trim();
      const areaSqm=areaPy/0.3025;
      const useSqm=settings.unitMode==='sqm';
      let label='';
      if(type==='매매'){
        const sale=parseMoneyToManwon(clean);
        if(Number.isFinite(sale)&&sale>0){
          const unit=useSqm?sale/areaSqm:sale/areaPy;
          label=`전용 ${fmt(areaPy,1)}평 (${fmt(areaSqm,1)}㎡) · @${fmt(unit,0)}만/${useSqm?'㎡':'평'}`;
        }
      }else if(type==='월세'){
        const parts=clean.split('/');
        if(parts.length>=2){
          const rent=parseMoneyToManwon(parts[1]);
          if(Number.isFinite(rent)&&rent>0){
            const unit=useSqm?rent/areaSqm:rent/areaPy;
            label=`전용 ${fmt(areaPy,1)}평 (${fmt(areaSqm,1)}㎡) · @${fmt(unit,2)}만/${useSqm?'㎡':'평'}`;
          }
        }
      }
      if(!label) return;
      let tag=item.querySelector('.sanga-inline-unit');
      if(!tag){
        tag=document.createElement('div');
        tag.className='sanga-inline-unit';
        priceEl.insertAdjacentElement('afterend',tag);
      }
      if(tag.textContent!==label) tag.textContent=label;
    });
  }
  function parseAreaPyFromText(text){
    const t=String(text||'');
    const exclusivePy=t.match(/전용\s*([\d,.]+)\s*평/i);
    if(exclusivePy){
      const py=parseFloat(exclusivePy[1].replace(/,/g,''));
      if(Number.isFinite(py)&&py>0.1&&py<5000) return py;
    }
    const exclusiveSqm=t.match(/전용\s*([\d,.]+)\s*(?:m²|m2|㎡)/i);
    if(exclusiveSqm){
      const sqm=parseFloat(exclusiveSqm[1].replace(/,/g,''));
      if(Number.isFinite(sqm)&&sqm>1&&sqm<10000) return sqm*0.3025;
    }
    // 네이버 평 모드의 '계약40평 (전용40)'처럼 전용 단위가 생략되면 계약 단위를 상속한다.
    const unitless=t.match(/전용\s*([\d,.]+)(?=\s*(?:\)|\||,|\/|$))/i);
    if(unitless){
      const n=parseFloat(unitless[1].replace(/,/g,''));
      if(Number.isFinite(n)&&n>0.1&&n<10000){
        if(/계약\s*[\d,.]+\s*평/i.test(t)) return n;
        return n*0.3025;
      }
    }
    const pyNums=[...t.matchAll(/([\d,.]+)\s*평/gi)]
      .map(m=>parseFloat(m[1].replace(/,/g,''))).filter(n=>Number.isFinite(n)&&n>0.1&&n<5000);
    if(pyNums.length) return Math.min(...pyNums);
    const nums=[...t.matchAll(/([\d,.]+)\s*(?:m²|m2|㎡)/gi)]
      .map(m=>parseFloat(m[1].replace(/,/g,''))).filter(n=>Number.isFinite(n)&&n>1&&n<10000);
    if(!nums.length) return NaN;
    return Math.min(...nums)*0.3025;
  }
  function parseFloorText(text){
    const t=String(text||'');
    let m=t.match(/(?:지하\s*(\d+)|B\s*(\d+)|(\d+))\s*층(?:\s*\/\s*\d+\s*층)?/i);
    if(!m) m=t.match(/(?:지하\s*(\d+)|B\s*(\d+)|(\d+))\s*\/\s*\d+\s*층/i);
    if(!m) return null;
    if(m[1]) return -parseInt(m[1],10);
    if(m[2]) return -parseInt(m[2],10);
    return parseInt(m[3],10);
  }
  function moneyTokenPattern(){
    return '([0-9.,]+\\s*억(?:\\s*[0-9,]+)?|[0-9][0-9,]*(?:\\.[0-9]+)?)';
  }
  function parseSaleFromText(text){
    const t=String(text||'').replace(/\s+/g,' ').trim();
    const re=new RegExp('매매\\s*'+moneyTokenPattern());
    const m=t.match(re);
    return m?parseMoneyToManwon(m[1]):NaN;
  }
  function parseRentFromText(text){
    const t=String(text||'').replace(/\s+/g,' ').trim();
    const re=new RegExp('월세\\s*'+moneyTokenPattern()+'\\s*\\/\\s*'+moneyTokenPattern());
    const m=t.match(re);
    if(!m) return null;
    return {deposit:parseMoneyToManwon(m[1]), rent:parseMoneyToManwon(m[2])};
  }
  function summarizeRows(rows, source='dom'){
    const sales=rows.filter(x=>x.kind==='sale'), rents=rows.filter(x=>x.kind==='rent');
    const saleStats=statPack(sales.map(x=>x.unit)), rentStats=statPack(rents.map(x=>x.unit));
    const saleMedian=saleStats.median, rentMedian=rentStats.median;
    // v1.4: 사용자가 원하는 '지역 내 평당가 최저 3개'를 조건 없이 보여준다.
    // 평당/㎡당은 단위변환일 뿐 순위는 동일하다.
    const cheapSales=sales
      .map(x=>({...x, discount:Number.isFinite(saleMedian)&&saleMedian>0?(x.unit/saleMedian-1)*100:NaN}))
      .sort((a,b)=>a.unit-b.unit)
      .slice(0,3);
    const cheapRents=rents
      .map(x=>({...x, discount:Number.isFinite(rentMedian)&&rentMedian>0?(x.unit/rentMedian-1)*100:NaN}))
      .sort((a,b)=>a.unit-b.unit)
      .slice(0,3);
    return {
      rows,sales,rents,saleStats,rentStats,cheapSales,cheapRents,source,
      saleMedian,
      saleMean:saleStats.mean,
      saleTrimmed:saleStats.trimmed,
      saleP10:saleStats.p10,
      saleP25:saleStats.p25,
      saleP90:saleStats.p90,
      saleMin:saleStats.min,
      saleMax:saleStats.max,
      rentMedian,
      rentMean:rentStats.mean,
      rentTrimmed:rentStats.trimmed,
      rentP10:rentStats.p10,
      rentP25:rentStats.p25,
      rentP90:rentStats.p90,
      rentMin:rentStats.min,
      rentMax:rentStats.max,
      depositMedian:median(rents.map(x=>x.deposit)),
      rentAmountMedian:median(rents.map(x=>x.rent))
    };
  }
  function legacyListingRows(){
    const rows=[];
    $$('.item_inner:not(.is-loading)').forEach((item, idx)=>{
      const type=$('.type',item)?.textContent?.trim();
      const priceText=$('.price',item)?.childNodes?.[0]?.textContent?.trim() || $('.price',item)?.textContent?.trim() || '';
      const areaPy=parseAreaPy(item);
      if(!type || !Number.isFinite(areaPy) || areaPy<=0) return;
      const clean=priceText.replace(/\(.*$/,'').replace(/~.*$/,'').trim();
      const floor=parseFloor(item);
      if(type==='매매'){
        const sale=parseMoneyToManwon(clean);
        if(Number.isFinite(sale)&&sale>0) rows.push({kind:'sale',price:sale,areaPy,unit:sale/areaPy,floor,raw:clean,idx,scanId:'',node:item});
      } else if(type==='월세'){
        const parts=clean.split('/');
        if(parts.length>=2){
          const deposit=parseMoneyToManwon(parts[0]);
          const rent=parseMoneyToManwon(parts[1]);
          if(Number.isFinite(rent)&&rent>0) rows.push({kind:'rent',deposit:Number.isFinite(deposit)?deposit:0,rent,areaPy,unit:rent/areaPy,floor,raw:clean,idx,scanId:'',node:item});
        }
      }
    });
    return rows;
  }
  function genericListingRows(){
    const rows=[]; const seen=new Set(); let seq=0;
    const typeRe=/(매매|월세)/;
    const areaRe=/[\d,.]+\s*(?:평|m²|m2|㎡)/i;
    const nodes=[...document.querySelectorAll('li,article,a,button,[role="listitem"],section,div')]
      .filter(el=>!el.closest?.(`#${ID},#${LAUNCHER_ID},#${BACKDROP_ID},.sanga-inline-unit`));
    const looks=el=>{
      const t=(el?.innerText||el?.textContent||'').replace(/\s+/g,' ').trim();
      return t.length>=8 && t.length<=800 && typeRe.test(t) && areaRe.test(t);
    };
    for(const el of nodes){
      if(!looks(el)) continue;
      // 동일 카드의 바깥 래퍼를 제외하고 가장 안쪽의 매물 카드만 선택한다.
      const childLooks=[...el.children].some(ch=>looks(ch));
      if(childLooks) continue;
      const t=(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
      const areaPy=parseAreaPyFromText(t);
      if(!Number.isFinite(areaPy)||areaPy<=0) continue;
      const floor=parseFloorText(t);
      let row=null;
      if(/매매/.test(t)){
        const sale=parseSaleFromText(t);
        if(Number.isFinite(sale)&&sale>0) row={kind:'sale',price:sale,areaPy,unit:sale/areaPy,floor,raw:t.slice(0,220)};
      } else if(/월세/.test(t)){
        const rr=parseRentFromText(t);
        if(rr&&Number.isFinite(rr.rent)&&rr.rent>0) row={kind:'rent',deposit:Number.isFinite(rr.deposit)?rr.deposit:0,rent:rr.rent,areaPy,unit:rr.rent/areaPy,floor,raw:t.slice(0,220)};
      }
      if(!row) continue;
      const key=[row.kind,Math.round(areaPy*100),row.price??row.deposit??0,row.rent??0,floor??''].join('|');
      if(seen.has(key)) continue; seen.add(key);
      const scanId=`sanga-scan-${++seq}`;
      try{el.dataset.sangaScanId=scanId;}catch(_e){}
      row.scanId=scanId; row.idx=rows.length; row.node=el;
      rows.push(row);
    }
    return rows;
  }
  function listingAnnotationText(row){
    if(!row || !Number.isFinite(row.areaPy) || row.areaPy<=0) return '';
    const areaSqm=row.areaPy/0.3025;
    const useSqm=settings.unitMode==='sqm';
    const unitName=useSqm?'㎡':'평';
    const factor=useSqm?0.3025:1;
    if(row.kind==='sale' && Number.isFinite(row.unit)){
      return `전용 ${fmt(row.areaPy,1)}평 (${fmt(areaSqm,1)}㎡) · 매매 ${fmt(row.unit*factor,0)}만/${unitName}`;
    }
    if(row.kind==='rent' && Number.isFinite(row.unit)){
      return `전용 ${fmt(row.areaPy,1)}평 (${fmt(areaSqm,1)}㎡) · 월세 ${fmt(row.unit*factor,2)}만/${unitName}`;
    }
    return '';
  }
  function annotateListingPack(pack){
    if(!pack?.rows?.length) return;
    pack.rows.forEach((row,order)=>{
      let item=(row.node && row.node.isConnected) ? row.node : null;
      if(!item && row.scanId) item=document.querySelector(`[data-sanga-scan-id="${row.scanId}"]`);
      if(!item && pack.source==='legacy') item=$$('.item_inner:not(.is-loading)')[row.idx ?? order];
      if(!item) return;
      const label=listingAnnotationText(row); if(!label) return;
      let tag=item.querySelector(':scope > .sanga-inline-unit');
      if(!tag){
        tag=document.createElement('div');
        tag.className='sanga-inline-unit';
        item.appendChild(tag);
      }
      if(tag.textContent!==label) tag.textContent=label;
    });
  }
  function scanListings(){
    // 이전 분석에서 삽입한 보조문구를 먼저 제거해 다음 스캔의 원문 파싱을 오염시키지 않는다.
    $$('.sanga-inline-unit').forEach(el=>el.remove());
    let rows=legacyListingRows();
    let source='legacy';
    if(!rows.length){ rows=genericListingRows(); source='generic'; }
    const pack=summarizeRows(rows,source);
    if(pack.rows.length) lastGoodDomListings=pack;
    annotateListingPack(pack);
    return pack;
  }
  function parseApiFloor(info){
    const s=String(info||'').split('/')[0].trim();
    if(!s) return null;
    if(/^B\s*\d+$/i.test(s)) return -parseInt(s.replace(/\D/g,''),10);
    if(/^지하\s*\d+/.test(s)) return -parseInt(s.replace(/\D/g,''),10);
    const n=parseInt(s,10); return Number.isFinite(n)?n:null;
  }
  function articleAreaPy(a){
    const sqm=Number(a?.area2)||Number(a?.exclusiveArea)||Number(a?.area1)||0;
    return Number.isFinite(sqm)&&sqm>0?sqm*0.3025:NaN;
  }
  function articleRow(a){
    const areaPy=articleAreaPy(a); if(!Number.isFinite(areaPy)||areaPy<=0) return null;
    const tradeCode=String(a?.tradeTypeCode||'').toUpperCase();
    const tradeName=String(a?.tradeTypeName||'');
    const floor=parseApiFloor(a?.floorInfo);
    const base={
      areaPy,floor,articleNo:String(a?.articleNo||''),articleName:String(a?.articleName||''),
      realEstateTypeName:String(a?.realEstateTypeName||''),lat:Number(a?.latitude),lon:Number(a?.longitude),
      raw:`${a?.articleName||''} ${a?.tradeTypeName||''} ${a?.dealOrWarrantPrc||''} ${a?.rentPrc||''} ${a?.floorInfo||''}`.trim(),
      scanId:'',node:null
    };
    if(tradeCode==='A1' || tradeName==='매매'){
      const price=parseMoneyToManwon(a?.dealOrWarrantPrc ?? a?.hanPrc ?? a?.prc);
      if(!Number.isFinite(price)||price<=0) return null;
      return {...base,kind:'sale',price,unit:price/areaPy};
    }
    if(tradeCode==='B2' || tradeName==='월세'){
      const deposit=parseMoneyToManwon(a?.dealOrWarrantPrc ?? a?.warrantPrc ?? 0);
      const rent=parseMoneyToManwon(a?.rentPrc ?? a?.rentPrice ?? 0);
      if(!Number.isFinite(rent)||rent<=0) return null;
      return {...base,kind:'rent',deposit:Number.isFinite(deposit)?deposit:0,rent,unit:rent/areaPy};
    }
    return null;
  }
  async function resolvePrimaryCortar(center){
    const observed=observedCortar();
    if(observed) return {no:observed,name:pageRegionNames()?.raw||'',source:'observed'};
    try{
      const d=await naverJson(`/api/cortars?zoom=${center.zoom||16}&centerLat=${center.lat}&centerLon=${center.lon}`);
      const no=extractCortar(d);
      if(no) return {no:String(no),name:extractRegionName(d)||'',source:'cortars'};
    }catch(_e){}
    const fallback=await resolveCortarFromPage();
    if(fallback?.no) return fallback;
    throw new Error('현재 지역 코드를 확인하지 못했습니다.');
  }
  function capturedListingPack(center){
    const rows=[];
    for(const a of capturedArticleMap.values()){
      const row=articleRow(a); if(row) rows.push(row);
    }
    if(!rows.length) return summarizeRows([],'captured');
    const zoom=Number(center?.zoom)||16;
    const radius=zoom>=18?500:zoom>=17?750:zoom>=16?1100:zoom>=15?1600:2600;
    const local=center?rows.filter(x=>!Number.isFinite(x.lat)||!Number.isFinite(x.lon)||haversine(center.lat,center.lon,x.lat,x.lon)<=radius):rows;
    return summarizeRows(local.length?local:rows,'captured');
  }
  function observedArticleTemplate(){
    const urls=[];
    if(lastObservedArticleUrl) urls.push(lastObservedArticleUrl);
    try{
      const entries=performance.getEntriesByType('resource');
      for(let i=entries.length-1;i>=0 && i>entries.length-700;i--){
        const u=String(entries[i]?.name||'');
        if(/\/api\/articles\?/i.test(u) && !/\/clusters/i.test(u)) urls.push(u);
      }
    }catch(_e){}
    for(const raw of urls){
      try{
        const u=new URL(raw,location.href);
        if(!u.searchParams.has('cortarNo')) continue;
        return u;
      }catch(_e){}
    }
    return null;
  }
  function bottomListingTrigger(){
    const candidates=[...document.querySelectorAll('button,a,[role="button"],div,span')]
      .filter(el=>!el.closest?.(`#${ID},#${LAUNCHER_ID},#${BACKDROP_ID}`))
      .filter(visible)
      .map(el=>({el,t:exactText(el),r:el.getBoundingClientRect()}))
      .filter(x=>/^매물\s*[\d,]+(?:\s+단지\s*[\d,]+)?$/.test(x.t))
      .filter(x=>x.r.top>innerHeight*0.58 && x.r.width>90 && x.r.height<100);
    if(!candidates.length) return null;
    candidates.sort((a,b)=>(b.r.top-a.r.top)||((a.r.width*a.r.height)-(b.r.width*b.r.height)));
    return clickableFor(candidates[0].el,null);
  }
  function detectNaverSheetTopRatio(){
    try{
      const nodes=[...document.querySelectorAll('div,section,aside')]
        .filter(visible)
        .filter(el=>/^매물\s*[\d,]+(?:\s|$)/.test(exactText(el)));
      let best=null;
      for(const n of nodes){
        let root=n;
        for(let i=0;i<8 && root && root!==document.body && root!==document.documentElement;i++,root=root.parentElement){
          const r=root.getBoundingClientRect();
          if(r.width<innerWidth*0.82 || r.bottom<innerHeight*0.88) continue;
          if(r.height<innerHeight*0.18 || r.height>innerHeight*0.96) continue;
          if(r.top<innerHeight*0.05 || r.top>innerHeight*0.88) continue;
          if(!best || r.top<best.top) best={top:r.top};
        }
      }
      return best?clamp(best.top/Math.max(1,innerHeight),0.05,0.88):-1;
    }catch(_e){ return -1; }
  }
  async function ensureObservedArticleTemplate(){
    let tpl=observedArticleTemplate();
    if(tpl) return tpl;
    const trigger=bottomListingTrigger();
    if(!trigger) return null;
    try{
      setNativeListSheetOpen(true);
      trigger.click();
      for(let i=0;i<35;i++){
        await sleep(120);
        tpl=observedArticleTemplate();
        if(tpl) break;
      }
    }catch(_e){}
    // 분석을 위해 잠깐 연 매물목록은 다시 접어 첫 화면을 보존한다.
    try{
      const ratio=detectNaverSheetTopRatio();
      if(typeof SangaNative!=='undefined' && SangaNative.collapseNaverSheet){
        SangaNative.collapseNaverSheet(window.__SANGA_BRIDGE_TOKEN__||'',ratio>0?ratio:0.50);
      }
      setNativeListSheetOpen(false);
      await sleep(360);
    }catch(_e){}
    return tpl;
  }

  async function fetchListingsFromApi(center){
    // v2.6: 사용자가 스크롤한 DOM을 기준으로 하지 않는다.
    // 네이버의 실제 '매물 N' 목록을 잠깐 열어 동일 세션의 API URL/인증헤더를 확보한 다음
    // 그 요청을 page=1..끝까지 복제해서 현재 지역 전체 매물을 자동 수집한다.
    const capturedBefore=capturedListingPack(center);
    // v2.7: 분석 때문에 네이버 매물 바텀시트를 자동으로 열지 않는다.
    // 이미 관찰한 API 템플릿이 있으면 재사용하고, 없으면 현재 지도 좌표→행정동코드로 직접 조회한다.
    const tpl=observedArticleTemplate();
    let region=null;
    if(tpl){
      const no=cortarFromAnyUrl(tpl.href);
      if(no) region={no,name:pageRegionNames()?.raw||'',source:'observed-template'};
    }
    if(!region){
      try{ region=await resolvePrimaryCortar(center); }catch(_e){}
    }
    if(!tpl && !region){
      if(capturedBefore.rows.length) return {...capturedBefore,region:null,complete:false,source:'captured-fallback'};
      throw new Error('네이버 매물 API 기준정보를 확인하지 못했습니다.');
    }

    const all=[];
    const seen=new Set();
    const addArticle=(a)=>{
      const row=articleRow(a);
      if(!row) return false;
      const key=row.articleNo||`${row.kind}|${row.price??row.deposit??0}|${row.rent??0}|${Math.round(row.areaPy*100)}|${row.floor??''}`;
      if(seen.has(key)) return false;
      seen.add(key); all.push(row); return true;
    };
    for(const a of capturedArticleMap.values()) addArticle(a);

    function baseUrlFor(tradeType,pageNo){
      let u;
      if(tpl) u=new URL(tpl.href,location.href);
      else {
        u=new URL('/api/articles',location.origin);
        u.searchParams.set('cortarNo',String(region.no));
        u.searchParams.set('order','rank');
        u.searchParams.set('tag','::::::::');
        u.searchParams.set('rentPriceMin','0'); u.searchParams.set('rentPriceMax','900000000');
        u.searchParams.set('priceMin','0'); u.searchParams.set('priceMax','900000000');
        u.searchParams.set('areaMin','0'); u.searchParams.set('areaMax','900000000');
        u.searchParams.set('showArticle','false'); u.searchParams.set('priceType','RETAIL');
      }
      if(region?.no) u.searchParams.set('cortarNo',String(region.no));
      u.searchParams.set('realEstateType','SG:SMS');
      u.searchParams.set('tradeType',tradeType);
      u.searchParams.set('sameAddressGroup','false');
      u.searchParams.set('page',String(pageNo));
      return u.href;
    }

    async function collect(tradeType,label){
      let page=1,complete=false,lastErr=null,added=0,prevSignature='';
      const MAX=300;
      for(;page<=MAX;page++){
        const url=baseUrlFor(tradeType,page);
        let d=null;
        try{ d=await naverJson(url); }
        catch(e){
          lastErr=e;
          for(let retry=0;retry<2 && !d;retry++){
            await sleep(220*(retry+1));
            try{ d=await naverJson(url); lastErr=null; }catch(re){ lastErr=re; }
          }
          if(!d) break;
        }
        captureNaverPayload(url,d);
        const list=d?.articleList || d?.result?.articleList || d?.body?.articleList || d?.data?.articleList || [];
        if(!Array.isArray(list) || !list.length){ complete=true; break; }
        const sig=list.slice(0,5).map(a=>String(a?.articleNo||'')).join('|');
        if(sig && sig===prevSignature){ complete=true; break; }
        prevSignature=sig;
        for(const a of list) if(addArticle(a)) added++;
        if(page===1 || page%5===0) setv('warning',`전체 호가 자동수집 중 · ${label} ${added.toLocaleString('ko-KR')}건 · 총 ${all.length.toLocaleString('ko-KR')}건`);
        const more=!!(d?.isMoreData ?? d?.moreData ?? d?.result?.isMoreData ?? d?.data?.isMoreData);
        if(!more){ complete=true; break; }
        await sleep(55);
      }
      return {complete,lastErr,pages:page,added};
    }

    // 결합 요청을 먼저 시도한다. 현재 필터가 매매+월세라면 네이버가 쓰는 요청과 가장 가깝다.
    let combo=await collect('A1:B2','매매+월세');
    let saleCount=all.filter(x=>x.kind==='sale').length;
    let rentCount=all.filter(x=>x.kind==='rent').length;

    // 결합 요청이 한 거래유형만 반환하거나 실패한 경우에만 개별 요청으로 보완한다.
    let saleResult=null,rentResult=null;
    if(combo.lastErr || saleCount===0 || rentCount===0){
      [saleResult,rentResult]=await Promise.all([collect('A1','매매'),collect('B2','월세')]);
    }

    if(!all.length){
      const captured=capturedListingPack(center);
      if(captured.rows.length) return {...captured,region,complete:false,source:'captured-fallback'};
      const errs=[combo.lastErr,saleResult?.lastErr,rentResult?.lastErr].filter(Boolean).map(e=>e.message||String(e));
      throw new Error((errs.join(' / ') || '네이버 전체 매물 조회 결과가 0건입니다.') + ` · 지역코드 ${region?.no||'없음'} · API템플릿 ${tpl?'확보':'없음'}`);
    }
    const rows=all.map((x,i)=>({...x,idx:i}));
    const pack=summarizeRows(rows,'api-full');
    const complete=combo.complete || (!!saleResult?.complete && !!rentResult?.complete);
    return {...pack,region,complete};
  }

  async function refreshListingsOnly(showMessage=false){
    latest=latest||{households:null,stores:null};
    let dom=scanListings();
    if(!dom.rows.length && lastGoodDomListings?.rows?.length) dom=lastGoodDomListings;
    latest.listings=dom; render();
    const center=getCenter();
    if(!center){
      if(showMessage) setv('warning',dom.rows.length?`화면에서 매물 ${dom.rows.length}건을 읽었습니다. 지도 위치를 확인하면 지역 전체 호가도 자동 조회합니다.`:'지도 중심을 아직 읽지 못했습니다. 지도를 조금 움직인 뒤 다시 시도해 주세요.');
      return dom;
    }
    if(showMessage) setv('warning','현재 지역의 상가·사무실 매매·월세 전체 매물을 자동으로 불러오는 중입니다. 스크롤할 필요가 없습니다…');
    try{
      const api=await fetchListingsFromApi(center);
      if(api.rows.length){
        latest.listings=api; render();
        if(showMessage) setv('warning',`지역 전체 호가 ${api.rows.length.toLocaleString('ko-KR')}건 반영 완료 (매매 ${api.sales.length.toLocaleString('ko-KR')} / 월세 ${api.rents.length.toLocaleString('ko-KR')})${api.complete?'':' · 일부 페이지 조회 제한'}.`);
        return api;
      }
      if(showMessage) setv('warning',dom.rows.length?`지역 API 매물은 없어서 현재 화면의 ${dom.rows.length}건을 반영했습니다.`:'현재 지역에서 분석 가능한 상가·사무실 매물을 찾지 못했습니다.');
      return dom;
    }catch(e){
      if(showMessage) setv('warning',dom.rows.length?`지역 자동조회 실패로 현재 화면의 ${dom.rows.length}건을 반영했습니다. (${e.message})`:`매물 자동조회 실패: ${e.message}`);
      return dom;
    }
  }

  function validCenter(lat,lon,zoom=16){
    lat=Number(lat); lon=Number(lon); zoom=Number(zoom)||16;
    if(!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
    if(lat<30||lat>45||lon<120||lon>135) return null;
    return {lat,lon,zoom};
  }
  function centerFromAnyUrl(raw){
    if(!raw) return null;
    let href=String(raw);
    try{ href=decodeURIComponent(href); }catch(_e){}
    let m=href.match(/\/map\/([\d.]+):([\d.]+):(\d+):/i);
    if(m) return validCenter(m[1],m[2],m[3]);
    m=href.match(/[?&#]ms=([\d.]+),([\d.]+),(\d+)/i);
    if(m) return validCenter(m[1],m[2],m[3]);
    m=href.match(/ms%3D([\d.]+)%2C([\d.]+)%2C(\d+)/i);
    if(m) return validCenter(m[1],m[2],m[3]);
    try{
      const u=new URL(href,location.href);
      const q=u.searchParams;
      const lat=q.get('centerLat')||q.get('lat')||q.get('latitude');
      const lon=q.get('centerLon')||q.get('lon')||q.get('lng')||q.get('longitude');
      const zoom=q.get('zoom')||q.get('z')||16;
      const direct=validCenter(lat,lon,zoom);
      if(direct) return direct;
      const left=Number(q.get('leftLon')||q.get('lft'));
      const right=Number(q.get('rightLon')||q.get('rgt'));
      const top=Number(q.get('topLat')||q.get('top'));
      const bottom=Number(q.get('bottomLat')||q.get('btm'));
      if([left,right,top,bottom].every(Number.isFinite)) return validCenter((top+bottom)/2,(left+right)/2,zoom);
    }catch(_e){}
    return null;
  }
  function rememberCenterFromUrl(raw){
    const c=centerFromAnyUrl(raw);
    if(c) lastObservedCenter=c;
    return c;
  }
  function articleArraysFromPayload(data,out=[]){
    if(!data || out.length>20) return out;
    if(Array.isArray(data)){
      if(data.length && data.some(x=>x && typeof x==='object' && (x.articleNo||x.tradeTypeCode||x.realEstateTypeCode))) out.push(data);
      else for(const x of data.slice(0,40)) articleArraysFromPayload(x,out);
      return out;
    }
    if(typeof data!=='object') return out;
    for(const k of ['articleList','articles','list']){
      const v=data[k];
      if(Array.isArray(v) && v.length && v.some(x=>x && typeof x==='object' && (x.articleNo||x.tradeTypeCode||x.realEstateTypeCode))) out.push(v);
    }
    for(const k of ['result','body','data','response']) if(data[k] && typeof data[k]==='object') articleArraysFromPayload(data[k],out);
    return out;
  }
  function captureNaverPayload(url,data){
    try{
      const raw=String(url||'');
      rememberCenterFromUrl(raw);
      if(/\/api\/articles(?:\?|\/|$)/i.test(raw) && !/\/clusters(?:\?|$)/i.test(raw)) lastObservedArticleUrl=raw;
      for(const arr of articleArraysFromPayload(data)){
        for(const a of arr){
          if(!a || typeof a!=='object') continue;
          const type=String(a.realEstateTypeCode||a.articleRealEstateTypeCode||'').toUpperCase();
          const name=String(a.realEstateTypeName||a.articleRealEstateTypeName||'');
          if(type && !['SG','SMS'].includes(type) && !/상가|사무실/.test(name)) continue;
          const key=String(a.articleNo||`${a.tradeTypeCode||a.tradeTypeName}|${a.dealOrWarrantPrc||''}|${a.rentPrc||''}|${a.area2||a.area1||''}|${a.floorInfo||''}`);
          capturedArticleMap.set(key,a);
        }
      }
    }catch(_e){}
  }
  function installCenterProbe(){
    if(window.__YBLOCUS_CENTER_PROBE__) return;
    window.__YBLOCUS_CENTER_PROBE__=true;
    try{
      const origFetch=window.fetch;
      if(typeof origFetch==='function'){
        window.fetch=function(input,init){
          const raw=typeof input==='string'?input:input?.url;
          try{
            rememberCenterFromUrl(raw);
            if(/\/api\/articles(?:\?|\/|$)/i.test(String(raw||''))&&!/\/clusters/i.test(String(raw||''))) lastObservedArticleUrl=String(raw);
            const h=new Headers(init?.headers || (typeof input==='object' ? input?.headers : undefined) || {});
            const auth=h.get('authorization');
            if(auth) lastNaverAuthHeader=auth;
          }catch(_e){}
          const promise=origFetch.apply(this,arguments);
          try{
            promise.then(resp=>{
              try{
                if(/\/api\/articles/i.test(String(raw||''))){
                  resp.clone().json().then(data=>captureNaverPayload(raw,data)).catch(()=>{});
                }
              }catch(_e){}
            }).catch(()=>{});
          }catch(_e){}
          return promise;
        };
      }
    }catch(_e){}
    try{
      const origOpen=XMLHttpRequest.prototype.open;
      const origSetHeader=XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader=function(name,value){
        try{ if(String(name||'').toLowerCase()==='authorization' && value) lastNaverAuthHeader=String(value); }catch(_e){}
        return origSetHeader.apply(this,arguments);
      };
      XMLHttpRequest.prototype.open=function(method,url){
        try{ this.__ybLocusUrl=String(url||''); rememberCenterFromUrl(url); if(/\/api\/articles(?:\?|\/|$)/i.test(this.__ybLocusUrl)&&!/\/clusters/i.test(this.__ybLocusUrl)) lastObservedArticleUrl=this.__ybLocusUrl; }catch(_e){}
        try{
          this.addEventListener('load',()=>{
            try{
              const u=this.__ybLocusUrl||'';
              if(!/\/api\/articles/i.test(u)) return;
              const text=typeof this.responseText==='string'?this.responseText:'';
              if(text && text[0]!=='<') captureNaverPayload(u,JSON.parse(text));
            }catch(_e){}
          },{once:true});
        }catch(_e){}
        return origOpen.apply(this,arguments);
      };
    }catch(_e){}
    // onPageFinished 이후 주입되어도 이미 수행된 요청 URL은 Performance API에서 회수할 수 있다.
    try{
      const entries=performance.getEntriesByType('resource');
      for(let i=entries.length-1;i>=0 && i>entries.length-600;i--){
        const u=String(entries[i]?.name||'');
        rememberCenterFromUrl(u);
        if(/\/api\/articles(?:\?|$)/i.test(u) && !/\/clusters/i.test(u)){ lastObservedArticleUrl=u; break; }
      }
    }catch(_e){}
  }

  function cortarFromAnyUrl(raw){
    if(!raw) return null;
    try{
      const u=new URL(String(raw),location.href);
      const c=String(u.searchParams.get('cortarNo')||'').trim();
      if(/^\d{8,12}$/.test(c)) return c;
    }catch(_e){}
    const m=String(raw).match(/[?&#]cortarNo=(\d{8,12})/i);
    return m?m[1]:null;
  }
  function observedCortar(){
    try{
      const entries=performance.getEntriesByType('resource');
      for(let i=entries.length-1;i>=0 && i>entries.length-500;i--){
        const c=cortarFromAnyUrl(entries[i]?.name);
        if(c) return c;
      }
    }catch(_e){}
    const direct=cortarFromAnyUrl(location.href);
    if(direct) return direct;
    try{
      for(const el of document.querySelectorAll('a[href*="cortarNo="]')){
        const c=cortarFromAnyUrl(el.href); if(c) return c;
      }
    }catch(_e){}
    return null;
  }

  function getCenter(){
    // 네이버 모바일은 지도를 움직여도 주소창의 ms= 값을 갱신하지 않는 경우가 있다.
    // 그래서 실제 지도 API 요청의 center/bounds를 가장 먼저 사용한다.
    if(lastObservedCenter) return {...lastObservedCenter};
    try{
      const entries=performance.getEntriesByType('resource');
      for(let i=entries.length-1;i>=0 && i>entries.length-350;i--){
        const c=centerFromAnyUrl(entries[i]?.name);
        if(c){ lastObservedCenter=c; return {...c}; }
      }
    }catch(_e){}
    const direct=centerFromAnyUrl(location.href);
    if(direct){ lastObservedCenter=direct; return {...direct}; }
    try{
      const links=[...document.querySelectorAll('a[href*="ms="],a[href*="centerLat"],a[href*="leftLon"]')];
      for(let i=links.length-1;i>=0;i--){
        const c=centerFromAnyUrl(links[i].href);
        if(c){ lastObservedCenter=c; return {...c}; }
      }
    }catch(_e){}
    // 마지막 보조 경로: React/지도 DOM에 남아 있는 좌표 속성이나 초기 상태 스크립트를 읽는다.
    try{
      const attrs=[...document.querySelectorAll('[data-lat][data-lng],[data-latitude][data-longitude],[data-lat][data-lon]')];
      for(let i=attrs.length-1;i>=0;i--){
        const el=attrs[i];
        const c=validCenter(el.dataset.lat??el.dataset.latitude,el.dataset.lng??el.dataset.lon??el.dataset.longitude,16);
        if(c){ lastObservedCenter=c; return {...c}; }
      }
    }catch(_e){}
    try{
      const scripts=[...document.scripts].slice(-40).map(x=>x.textContent||'').join(' ');
      let m=scripts.match(/["']centerLat["']\s*:\s*([\d.]+)[\s\S]{0,160}?["']centerLon["']\s*:\s*([\d.]+)/i);
      if(!m) m=scripts.match(/["']latitude["']\s*:\s*([\d.]+)[\s\S]{0,160}?["']longitude["']\s*:\s*([\d.]+)/i);
      if(m){
        const c=validCenter(m[1],m[2],16);
        if(c){ lastObservedCenter=c; return {...c}; }
      }
    }catch(_e){}
    return null;
  }
  async function naverJson(path){
    const errors=[];
    const candidates=[];
    if(/^https?:/i.test(path)) candidates.push(String(path));
    else {
      // 현재 Npay 부동산 호스트가 fin/new 중 어느 쪽이든 먼저 같은 origin API를 시도한다.
      try{ if(location.hostname.endsWith('land.naver.com')) candidates.push(`${location.origin}${path}`); }catch(_e){}
      candidates.push(`https://new.land.naver.com${path}`);
      candidates.push(`https://m.land.naver.com${path}`);
    }
    for(const url of [...new Set(candidates)]){
      try{
        const u=new URL(url,location.href);
        if(u.origin===location.origin){
          const headers={'Accept':'application/json, text/plain, */*'};
          if(lastNaverAuthHeader) headers['Authorization']=lastNaverAuthHeader;
          const r=await window.fetch(u.href,{method:'GET',credentials:'include',cache:'no-store',headers});
          const text=await r.text();
          if(!r.ok) throw new Error(`HTTP ${r.status}`);
          try{return JSON.parse(text);}catch(_e){throw new Error('JSON 해석 실패');}
        }
      }catch(e){ errors.push(`웹요청 ${new URL(url,location.href).host}: ${e.message}`); }
      try{
        const text=await externalFetch(url);
        try{return JSON.parse(text);}catch(_e){throw new Error('JSON 해석 실패');}
      }catch(e){
        try{ errors.push(`네이티브요청 ${new URL(url,location.href).host}: ${e.message}`); }
        catch(_e){ errors.push(`네이티브요청: ${e.message}`); }
      }
    }
    throw new Error(errors.slice(-4).join(' / ') || '네이버 API 요청 실패');
  }
  function extractCortar(data){
    if(!data) return null;
    if(Array.isArray(data)){
      for(const x of data){ const n=extractCortar(x); if(n) return n; }
      return null;
    }
    return data?.cortarNo || data?.region?.cortarNo || data?.cortar?.cortarNo || data?.result?.cortarNo || data?.regionList?.[0]?.cortarNo || null;
  }
  function extractRegionName(data){
    if(!data) return '';
    if(Array.isArray(data)) return data.map(extractRegionName).find(Boolean)||'';
    return data?.cortarName || data?.region?.cortarName || data?.cortar?.cortarName || data?.result?.cortarName || data?.cortarName3 || data?.regionList?.[0]?.cortarName || '';
  }
  const regionListCache=new Map();
  function regionItems(data){
    const a=data?.regionList || data?.regions || data?.result?.regionList || data?.result?.regions || [];
    return Array.isArray(a)?a:[];
  }
  async function getRegionList(cortarNo){
    const key=String(cortarNo||'0000000000');
    if(regionListCache.has(key)) return regionListCache.get(key);
    const d=await naverJson(`/api/regions/list?cortarNo=${encodeURIComponent(key)}`);
    const list=regionItems(d).map(x=>({no:String(x.cortarNo||''),name:String(x.cortarName||'').trim()})).filter(x=>x.no&&x.name);
    regionListCache.set(key,list);
    return list;
  }
  function normRegionName(x){return String(x||'').replace(/\s+/g,'').replace(/특별시$|광역시$|특별자치시$|특별자치도$|도$/,'');}
  function pageRegionNames(){
    const candidates=[];
    for(const el of document.querySelectorAll('button,a,[role="button"],header span,header div')){
      try{
        const r=el.getBoundingClientRect();
        if(r.bottom<0 || r.top>430 || r.width<20 || r.height<10) continue;
        const t=exactText(el);
        if(t.length<3 || t.length>40) continue;
        candidates.push(t);
      }catch(_e){}
    }
    const all=[...new Set(candidates)];
    for(const t of all){
      let m=t.match(/([가-힣0-9·]+(?:구|군|시))\s+([가-힣0-9·]+(?:동|읍|면|가))/);
      if(m) return {district:m[1],dong:m[2],raw:t};
    }
    const body=(document.body?.innerText||'').slice(0,2500);
    const m=body.match(/([가-힣0-9·]+(?:구|군|시))\s+([가-힣0-9·]+(?:동|읍|면|가))/);
    return m?{district:m[1],dong:m[2],raw:m[0]}:null;
  }
  function regionNameEq(a,b){return normRegionName(a)===normRegionName(b) || String(a||'').trim()===String(b||'').trim();}
  async function resolveCortarFromPage(){
    const n=pageRegionNames();
    if(!n) throw new Error('화면의 지역명도 찾지 못했습니다.');
    const roots=await getRegionList('0000000000');
    let district=null, parentName='';
    for(let i=0;i<roots.length && !district;i+=4){
      const batch=roots.slice(i,i+4);
      const sets=await Promise.all(batch.map(async r=>{try{return {r,list:await getRegionList(r.no)};}catch(_e){return {r,list:[]};}}));
      for(const x of sets){
        const hit=x.list.find(v=>regionNameEq(v.name,n.district));
        if(hit){ district=hit; parentName=x.r.name; break; }
      }
    }
    if(!district){
      const direct=roots.find(v=>regionNameEq(v.name,n.district));
      if(direct) district=direct;
    }
    if(!district) throw new Error(`화면 지역(${n.raw})의 시군구 코드를 찾지 못했습니다.`);
    const children=await getRegionList(district.no);
    const dong=children.find(v=>regionNameEq(v.name,n.dong));
    if(!dong) throw new Error(`화면 지역(${n.raw})의 동 코드를 찾지 못했습니다.`);
    return {no:dong.no,name:[parentName,district.name,dong.name].filter(Boolean).join(' '),source:'region-name'};
  }
  function normalizeComplex(x){
    const c=x?.complexDetail || x;
    const lat=+(c.latitude ?? c.lat ?? c.y ?? c.centerLat);
    const lon=+(c.longitude ?? c.lon ?? c.lng ?? c.x ?? c.centerLon);
    const hh=+(c.totalHouseholdCount ?? c.householdCount ?? c.totalHouseholdCnt ?? 0);
    return {no:String(c.complexNo ?? c.markerId ?? c.id ?? ''),name:c.complexName ?? c.name ?? '',lat,lon,hh,type:c.realEstateTypeCode ?? c.realEstateType ?? ''};
  }
  function collectComplexLikeObjects(root){
    const out=[]; const seen=new Set();
    function walk(v){
      if(!v || typeof v!=='object') return;
      if(Array.isArray(v)){v.forEach(walk);return;}
      const id=v.complexNo ?? v.markerId ?? v.id;
      if(id && (v.latitude!=null || v.lat!=null || v.longitude!=null || v.lon!=null || v.lng!=null || v.complexName || v.name)){
        const key=String(id); if(!seen.has(key)){seen.add(key);out.push(v);}
      }
      Object.values(v).forEach(walk);
    }
    walk(root); return out;
  }
  async function getComplexMarkers(cortarNo,type,center,radius){
    const b=bbox(center.lat,center.lon,radius);
    const q=new URLSearchParams({
      cortarNo:String(cortarNo), zoom:String(Math.max(15,center.zoom||16)), priceType:'RETAIL',
      realEstateType:type, tradeType:'', tag:'::::::::', rentPriceMin:'0', rentPriceMax:'900000000',
      priceMin:'0', priceMax:'900000000', areaMin:'0', areaMax:'900000000',
      showArticle:'false', sameAddressGroup:'false', isPresale:'true',
      leftLon:String(b.leftLon), rightLon:String(b.rightLon), topLat:String(b.topLat), bottomLat:String(b.bottomLat)
    });
    const data=await naverJson(`/api/complexes/single-markers/2.0?${q.toString()}`);
    return collectComplexLikeObjects(data).map(normalizeComplex).filter(x=>x.no);
  }
  async function getComplexesByRegion(cortarNo, type){
    const url=`/api/regions/complexes?cortarNo=${encodeURIComponent(cortarNo)}&realEstateType=${encodeURIComponent(type)}&order=`;
    const data=await naverJson(url);
    const direct=(data?.complexList || data?.complexes || data?.result?.complexList || data?.result?.complexes || []);
    const raw=Array.isArray(direct)&&direct.length?direct:collectComplexLikeObjects(data);
    return raw.map(normalizeComplex).filter(x=>x.no);
  }
  async function getCortarsAround(center,radius){
    // v2.8: 관찰된 cortarNo 하나만 믿고 즉시 반환하지 않는다.
    // 지도 요청에서 구 단위 코드가 잡히는 경우가 있어 중심좌표 API와 화면 지역명도 함께 대조한다.
    const result=[]; const errors=[];
    const add=(no,name='',source='')=>{
      no=String(no||'').trim();
      if(!/^\d{8,12}$/.test(no) || result.some(x=>x.no===no)) return;
      result.push({no,name,source});
    };
    const seenNo=observedCortar();
    if(seenNo) add(seenNo,pageRegionNames()?.raw||'','observed');
    const deltaLat=(radius*0.85)/111320;
    const deltaLon=(radius*0.85)/(111320*Math.cos(center.lat*Math.PI/180));
    const pts=[[0,0],[deltaLat,0],[-deltaLat,0],[0,deltaLon],[0,-deltaLon],[deltaLat,deltaLon],[deltaLat,-deltaLon],[-deltaLat,deltaLon],[-deltaLat,-deltaLon]];
    for(const [dy,dx] of pts){
      try{
        const d=await naverJson(`/api/cortars?zoom=${center.zoom||16}&centerLat=${center.lat+dy}&centerLon=${center.lon+dx}`);
        const no=extractCortar(d); if(no) add(no,extractRegionName(d),'cortars');
      }catch(e){ if(errors.length<2) errors.push(e.message); }
    }
    try{
      const fallback=await resolveCortarFromPage();
      if(fallback?.no) add(fallback.no,fallback.name||'','region-name');
    }catch(e){ if(errors.length<3) errors.push(e.message); }
    if(result.length) return result;
    throw new Error(`행정동 코드 조회 실패${errors.length?`: ${errors.join(' / ')}`:''}`);
  }
  function mergeComplex(base, extra){
    const a=base||{}; const b=normalizeComplex(extra||{});
    return {
      no:b.no||a.no||'', name:b.name||a.name||'',
      lat:Number.isFinite(b.lat)?b.lat:a.lat,
      lon:Number.isFinite(b.lon)?b.lon:a.lon,
      hh:(Number.isFinite(b.hh)&&b.hh>0)?b.hh:(a.hh||0),
      type:b.type||a.type||''
    };
  }
  async function enrichComplex(c){
    let out={...c};
    const attempts=[
      `/api/complexes/${encodeURIComponent(c.no)}?sameAddressGroup=false`,
      `/api/complexes/overview/${encodeURIComponent(c.no)}`,
      `/api/regions/locations?type=complex&id=${encodeURIComponent(c.no)}`
    ];
    for(const path of attempts){
      if(Number.isFinite(out.lat)&&Number.isFinite(out.lon)&&out.hh>0) break;
      try{
        const d=await naverJson(path);
        const raw=d?.complexDetail || d?.complexOverview || d?.result || d;
        out=mergeComplex(out,raw);
      }catch(_e){}
    }
    return out;
  }
  async function getHouseholds(center, radius){
    const cortars=await getCortarsAround(center,radius);
    if(!cortars.length) throw new Error('행정동 코드를 찾지 못했습니다.');
    const types=settings.includeOfficetel?['APT','OPST']:['APT'];
    let complexes=[];
    for(const c of cortars){
      for(const t of types){
        try{
          const markers=await getComplexMarkers(c.no,t,center,radius);
          if(markers.length) complexes.push(...markers);
          else complexes.push(...await getComplexesByRegion(c.no,t));
        }catch(e){
          try{complexes.push(...await getComplexesByRegion(c.no,t));}catch(_e){}
        }
      }
    }
    const map=new Map(); complexes.forEach(c=>{if(c.no)map.set(c.no,c);}); complexes=[...map.values()];
    if(!complexes.length) throw new Error('주거단지 목록을 받지 못했습니다.');
    // 좌표가 있는 단지만 먼저 반경 필터링하여 상세조회 수를 줄인다. 좌표 없는 항목은 상세/위치 API로 보강한다.
    const candidates=complexes.filter(c=>!Number.isFinite(c.lat)||!Number.isFinite(c.lon)||haversine(center.lat,center.lon,c.lat,c.lon)<=radius*1.20);
    const need=candidates.filter(c=>!(Number.isFinite(c.lat)&&Number.isFinite(c.lon)&&c.hh>0)).slice(0,90);
    for(let i=0;i<need.length;i+=8){
      const batch=need.slice(i,i+8);
      const enriched=await Promise.all(batch.map(enrichComplex));
      enriched.forEach(c=>{ if(c.no) map.set(c.no,c); });
      if(i+8<need.length) await sleep(50);
    }
    complexes=[...map.values()].filter(c=>Number.isFinite(c.lat)&&Number.isFinite(c.lon));
    complexes.forEach(c=>c.distance=haversine(center.lat,center.lon,c.lat,c.lon));
    const within=complexes.filter(c=>c.distance<=radius && Number.isFinite(c.hh) && c.hh>0);
    if(!within.length) throw new Error('500m 반경 주거단지 세대수 데이터를 확인하지 못했습니다.');
    const hh=within.reduce((s,c)=>s+c.hh,0);
    return {households:hh,complexes:within.sort((a,b)=>a.distance-b.distance),cortarNo:cortars[0].no,regionName:cortars.map(x=>x.name).filter(Boolean).join(' · '),cortars:cortars.map(x=>x.no)};
  }
  async function externalFetch(url){
    return new Promise((resolve,reject)=>{
      chrome.runtime.sendMessage({type:'SANGA_FETCH',url},res=>{
        if(chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if(!res?.ok) return reject(new Error(res?.error || `공공데이터 응답 ${res?.status||''}`));
        resolve(res.text);
      });
    });
  }
  function totalCountFromResponse(text){
    try{
      const j=JSON.parse(text);
      const body=j?.response?.body ?? j?.body ?? j;
      const n=+(body?.totalCount ?? body?.totalcount ?? body?.items?.totalCount);
      if(Number.isFinite(n)) return n;
    }catch(e){}
    const m=text.match(/<totalCount>(\d+)<\/totalCount>/i) || text.match(/<totalcount>(\d+)<\/totalcount>/i);
    return m?+m[1]:NaN;
  }
  async function getStoreCount(center,radius){
    const key=(settings.serviceKey||'').trim();
    if(!key) return {count:NaN,source:'no-key'};
    const q=new URLSearchParams({radius:String(Math.min(2000,radius)),cx:String(center.lon),cy:String(center.lat),pageNo:'1',numOfRows:'1',type:'json',ServiceKey:key});
    const url=`https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius?${q.toString()}`;
    const text=await externalFetch(url);
    const count=totalCountFromResponse(text);
    if(!Number.isFinite(count)) throw new Error('상가업소 API 응답을 해석하지 못했습니다. 인증키(일반/Decoding)를 확인하세요.');
    return {count,source:'semas'};
  }
  function deriveScore(data){
    const {households,stores,radius,listings}=data;
    const areaKm2=Math.PI*(radius/1000)**2;
    const density=households/areaKm2;
    const densityScore=clamp((density-1500)/(9000-1500)*100,0,100);
    let supplyScore=50;
    if(Number.isFinite(stores)&&stores>0){
      const hhPerStore=households/stores;
      supplyScore=clamp((hhPerStore-2.5)/(10-2.5)*100,0,100);
    }
    let listingScore=50;
    if(households>0){
      const rentPer1000=(listings?.rents?.length||0)/households*1000;
      listingScore=clamp(100-rentPer1000*7,0,100);
    }
    const score=Math.round(densityScore*.45+supplyScore*.40+listingScore*.15);
    let label=score>=75?'수급 여건 강함':score>=60?'수급 여건 양호':score>=45?'수급 여건 보통':score>=30?'수급 여건 약함':'수급 여건 매우 약함';
    if(!Number.isFinite(stores)) label+=' · 잠정';
    return {score,label,density,densityScore,supplyScore,listingScore};
  }
  function inferredGrossYield(listings){
    if(!Number.isFinite(listings.saleMedian)||!Number.isFinite(listings.rentMedian)||listings.saleMedian<=0) return NaN;
    // 평당 매매가(만원)와 평당 월세(만원/월)의 단순 교차 중앙값 기준. 보증금은 서로 매칭되지 않아 제외.
    return listings.rentMedian*12/listings.saleMedian*100;
  }
  function capValue(depositMan, rentMan, yieldPct){
    if(!Number.isFinite(rentMan)||!Number.isFinite(yieldPct)||yieldPct<=0) return NaN;
    return depositMan + rentMan*12/(yieldPct/100);
  }
  function panel(){return document.getElementById(ID);}
  function mount(){
    if(panel()) return;
    const el=document.createElement('div'); el.id=ID;
    el.innerHTML=`
      <div class="sip-head"><div><div class="sip-title">YB LOCUS Android v${APP_VERSION}</div><div class="sip-sub">시세 · 저가후보 · 배후세대 · 상권수급</div></div><button data-act="closeSheet">닫기</button></div>
      <div class="sip-body">
        <div class="sip-score"><div class="sip-score-num" data-v="score">-</div><div class="sip-score-text"><b data-v="scoreLabel">분석 전</b><span><strong>높을수록 유리</strong> · 배후세대 대비 상가공급의 수급형 참고지표</span></div></div>
        <div class="sip-bar"><i data-v="scoreBar" style="width:0%"></i></div>
        <div class="sip-factorbox" aria-label="수급지수 구성요소">
          <div class="sip-factor"><span>배후수요</span><b><i data-v="factorDensity"></i></b></div>
          <div class="sip-factor"><span>상가공급</span><b><i data-v="factorSupply"></i></b></div>
          <div class="sip-factor"><span>임대매물 부담</span><b><i data-v="factorListing"></i></b></div>
        </div>
        <div class="sip-grid" style="margin-top:9px">
          <div class="sip-card"><b>배후세대</b><div class="sip-value" data-v="households">-</div><div class="sip-note" data-v="hhNote">반경 내 공동주택 기준</div></div>
          <div class="sip-card"><b>영업점 수</b><div class="sip-value" data-v="stores">-</div><div class="sip-note">소상공인 상가업소 API</div></div>
          <div class="sip-card"><b>세대 / 영업점</b><div class="sip-value" data-v="hhPerStore">-</div><div class="sip-note">높을수록 점포 공급이 상대적으로 적음</div></div>
          <div class="sip-card"><b>영업점 / 1천세대</b><div class="sip-value" data-v="storePer1000">-</div><div class="sip-note">낮을수록 점포 밀도가 낮음</div></div>
        </div>
        <div class="sip-section">
          <div class="sip-section-title"><span>현재 네이버 상가 호가</span><div class="sip-unit-tools"><select data-in="unitMode"><option value="py">평당 (기본)</option><option value="sqm">㎡당</option></select><button data-act="rescan">매물 다시읽기</button></div></div>
          <table class="sip-table sip-stats"><thead><tr><th>구분</th><th>전체평균</th><th>중앙값</th><th>보정평균</th><th>건수</th></tr></thead><tbody>
            <tr><td data-v="saleUnitLabel">매매 평당</td><td data-v="saleMean">-</td><td data-v="saleMedian">-</td><td data-v="saleTrimmed">-</td><td data-v="saleCount">-</td></tr>
            <tr><td data-v="rentUnitLabel">월세 평당</td><td data-v="rentMean">-</td><td data-v="rentMedian">-</td><td data-v="rentTrimmed">-</td><td data-v="rentCount">-</td></tr>
          </tbody></table>
          <table class="sip-table sip-range" style="margin-top:6px"><thead><tr><th>구분</th><th>최저</th><th>하위10%</th><th>상위10%</th><th>최고</th></tr></thead><tbody>
            <tr><td data-v="saleRangeUnitLabel">매매 평당</td><td data-v="saleMin">-</td><td data-v="saleP10">-</td><td data-v="saleP90">-</td><td data-v="saleMax">-</td></tr>
            <tr><td data-v="rentRangeUnitLabel">월세 평당</td><td data-v="rentMin">-</td><td data-v="rentP10">-</td><td data-v="rentP90">-</td><td data-v="rentMax">-</td></tr>
          </tbody></table>
          <div class="sip-note"><b>저가 매물도 전부 통계에 포함합니다.</b> 전체평균은 실제 등록매물 전체를 반영하고, 중앙값·보정평균은 비교용으로 함께 제공합니다.</div>
          <div class="sip-lowbox"><div class="sip-lowtitle" data-v="cheapTitle">저가 매물 TOP 3 <span>현재 거래유형에서 평당단가가 낮은 순</span></div><div data-v="cheapSales" class="sip-lowlist">매물을 읽으면 표시됩니다.</div></div>
        </div>
        <div class="sip-section">
          <div class="sip-section-title"><span>자동 수익성 참고</span></div>
          <div class="sip-grid">
            <div class="sip-card"><b>시장 단순수익률</b><div class="sip-value" data-v="autoGrossYield">-</div><div class="sip-note">매매·월세 평당 중앙값 기준</div></div>
            <div class="sip-card"><b>보수적 월세수익률</b><div class="sip-value" data-v="autoConservativeYield">-</div><div class="sip-note">월세 하위 25% 기준</div></div>
            <div class="sip-card sip-wide"><b>6% 목표수익률 기준 수익가치</b><div class="sip-value" data-v="autoCapUnit">-</div><div class="sip-note">월세 평당 중앙값 × 12 ÷ 6%. 대출·보증금·세금은 반영하지 않은 자동 비교값입니다.</div></div>
          </div>
        </div>
        <div class="sip-section">
          <div class="sip-section-title"><span>배후세대 조사</span><button data-act="refresh">지역 분석</button></div>
          <div class="sip-row"><label>분석 반경</label><select data-in="radius"><option value="300">300m</option><option value="500">500m</option><option value="1000">1km</option><option value="1500">1.5km</option><option value="2000">2km</option></select></div>
          <div class="sip-row"><label>주거오피스텔</label><select data-in="officetel"><option value="1">포함</option><option value="0">제외</option></select></div>
          <div class="sip-row"><label>상가 호실수</label><input data-in="manualUnits" type="number" min="0" placeholder="선택 입력"></div>
          <div class="sip-note" data-v="manualUnitKpi"></div>
          <div class="sip-row"><label>공공 API 키</label><input data-in="key" type="password" placeholder="data.go.kr Decoding 키"></div>
          <div class="sip-actions"><button data-act="apiPage">API 발급페이지</button></div>
          <div class="sip-actions"><button data-act="save">설정 저장</button><button data-act="copy">분석 복사</button><button data-act="csv">CSV 저장</button></div>
          <div class="sip-warning" style="margin-top:8px" data-v="warning">배후세대는 네이버 단지정보의 공동주택 세대수 합산입니다. 단독·다가구 등은 포함되지 않을 수 있습니다. 영업점 수는 '상가 호실 수'가 아니라 실제 상가업소 데이터입니다.</div>
        </div>
        <div class="sip-section"><div class="sip-section-title"><span>가까운 주거단지</span><span class="sip-muted" data-v="region">-</span></div><div data-v="complexes" class="sip-note">지역 분석을 누르세요.</div></div>
      </div>`;
    const backdrop=document.createElement('div');
    backdrop.id=BACKDROP_ID;
    backdrop.className='sip-backdrop sip-hidden';
    document.body.appendChild(backdrop);
    document.body.appendChild(el);
    // Android 앱에서는 네이버 지도 위에 떠 있는 버튼을 만들지 않는다.
    // MainActivity의 전용 하단 버튼이 openSheet()를 호출한다.
    let launcher=null;
    if(typeof SangaNative==='undefined'){
      launcher=document.createElement('button');
      launcher.id=LAUNCHER_ID;
      launcher.type='button';
      launcher.innerHTML='<span>📊</span> 상가분석';
      document.body.appendChild(launcher);
      launcher.addEventListener('click',openSheet);
    }
    el.classList.add('sip-mobile-sheet','sip-sheet-closed');
    backdrop.addEventListener('click',closeSheet);
    bindPanel(el);
    bindStableTouchScroll(el.querySelector('.sip-body'));
    applyInputs();
  }
  function bindStableTouchScroll(body){
    if(!body || body.__ybStableScrollBound) return;
    body.__ybStableScrollBound=true;
    let active=false, startY=0, startX=0, startScroll=0;
    body.addEventListener('touchstart',e=>{
      if(e.touches.length!==1) return;
      active=true;
      startY=e.touches[0].clientY;
      startX=e.touches[0].clientX;
      startScroll=body.scrollTop;
    },{passive:true});
    body.addEventListener('touchmove',e=>{
      if(!active || e.touches.length!==1) return;
      const dy=startY-e.touches[0].clientY;
      const dx=startX-e.touches[0].clientX;
      // 세로 스와이프는 브라우저의 fling/overscroll 전환에 맡기지 않고 직접 반영한다.
      if(Math.abs(dy)>2 && Math.abs(dy)>=Math.abs(dx)){
        const max=Math.max(0,body.scrollHeight-body.clientHeight);
        body.scrollTop=clamp(startScroll+dy,0,max);
        e.preventDefault();
        e.stopPropagation();
      }
    },{passive:false});
    const end=()=>{active=false;};
    body.addEventListener('touchend',end,{passive:true});
    body.addEventListener('touchcancel',end,{passive:true});
  }

  function openSheet(){
    simplifyPropertyTypeSheet();
    const el=panel(), back=document.getElementById(BACKDROP_ID);
    if(el){
      el.classList.remove('sip-sheet-closed');
      const body=el.querySelector('.sip-body');
      if(body){
        body.style.overflowY='auto';
        // 열 때 항상 상단에서 시작해 이전 overscroll/fling 상태를 이어받지 않는다.
        body.scrollTop=0;
      }
    }
    if(back) back.classList.remove('sip-hidden');
    document.documentElement.classList.add('sanga-invest-sheet-open');
    // v2.1: 분석창을 열 때마다 현재 지도 위치 기준으로 시세와 배후세대를 새로 읽는다.
    setv('scoreLabel','분석 중…');
    setv('warning','현재 지역의 매매·월세 호가와 배후세대를 자동으로 불러오는 중입니다…');
    setTimeout(()=>refreshAll(false),80);
  }
  function closeSheet(){
    const el=panel(), back=document.getElementById(BACKDROP_ID);
    if(el) el.classList.add('sip-sheet-closed');
    if(back) back.classList.add('sip-hidden');
    document.documentElement.classList.remove('sanga-invest-sheet-open');
  }
  window.YBLOCUS_OPEN_ANALYZER=openSheet;
  window.YBLOCUS_CLOSE_ANALYZER=closeSheet;
  window.YBLOCUS_HANDLE_BACK=function(){
    const el=panel();
    if(el && !el.classList.contains('sip-sheet-closed')){ closeSheet(); return true; }
    if(returnToAnalyzerOnBack){ returnToAnalyzerOnBack=false; openSheet(); return true; }
    return false;
  };
  window.YBLOCUS_NAVER_SHEET_TOP_RATIO=function(){ return detectNaverSheetTopRatio(); };
  function setv(k,v){ const e=panel()?.querySelector(`[data-v="${k}"]`); if(e) e.textContent=v; }
  function setFactorBar(key,value,neutral=false){
    const e=panel()?.querySelector(`[data-v="${key}"]`);
    if(!e) return;
    const v=Number.isFinite(value)?clamp(value,0,100):0;
    e.style.width=`${v}%`;
    e.classList.remove('is-low','is-mid','is-high','is-neutral');
    if(neutral || !Number.isFinite(value)) e.classList.add('is-neutral');
    else if(v<35) e.classList.add('is-low');
    else if(v<65) e.classList.add('is-mid');
    else e.classList.add('is-high');
  }
  function resetFactorBars(){
    setFactorBar('factorDensity',NaN,true);
    setFactorBar('factorSupply',NaN,true);
    setFactorBar('factorListing',NaN,true);
  }
  function bindPanel(el){
    el.addEventListener('click',e=>{
      const actionEl=e.target?.closest?.('[data-act]');
      const act=actionEl?.dataset?.act; if(!act)return;
      if(act==='closeSheet') closeSheet();
      if(act==='rescan'){ refreshListingsOnly(true); }
      if(act==='refresh') refreshAll(true);
      if(act==='apiPage') { try{ SangaNative.openExternal(window.__SANGA_BRIDGE_TOKEN__||'', 'https://www.data.go.kr/data/15012005/openapi.do'); }catch(_e){ window.open('https://www.data.go.kr/data/15012005/openapi.do','_blank','noopener'); } }
      if(act==='save') saveSettingsFromUi(true);
      if(act==='copy') copyAnalysis();
      if(act==='csv') exportCsv();
      if(act==='marketRentToCalc') marketRentToCalculator();
      if(act==='focusListing'){
        const idx=+actionEl.dataset.idx;
        const row=latest?.listings?.rows?.find(x=>x.idx===idx) || latest?.listings?.rows?.[idx];
        if(row?.articleNo){
          try{
            if(typeof SangaNative!=='undefined' && SangaNative.armAnalyzerReturn){
              SangaNative.armAnalyzerReturn(window.__SANGA_BRIDGE_TOKEN__||'', location.href);
            }
          }catch(_e){}
          closeSheet();
          try{
            const u=new URL(location.href);
            u.pathname='/offices';
            u.searchParams.set('articleNo',String(row.articleNo));
            location.href=u.href;
          }catch(_e){
            location.href=`https://new.land.naver.com/offices?articleNo=${encodeURIComponent(String(row.articleNo))}`;
          }
          return;
        }
        const item=(row?.node && row.node.isConnected ? row.node : null) || (row?.scanId ? document.querySelector(`[data-sanga-scan-id="${row.scanId}"]`) : null) || $$('.item_inner:not(.is-loading)')[idx];
        if(item){
          returnToAnalyzerOnBack=true;
          try{ if(typeof SangaNative!=='undefined' && SangaNative.armAnalyzerReturn) SangaNative.armAnalyzerReturn(window.__SANGA_BRIDGE_TOKEN__||'', location.href); }catch(_e){}
          closeSheet();
          item.scrollIntoView({behavior:'smooth',block:'center'});
          item.classList.add('sanga-invest-focus');
          setTimeout(()=>item.classList.remove('sanga-invest-focus'),2600);
        }
      }
    });
    el.addEventListener('change',e=>{
      if(e.target.matches('[data-in="unitMode"]')){settings.unitMode=e.target.value==='sqm'?'sqm':'py'; render(); annotateListings(); annotateListingPack(latest?.listings);}
      if(e.target.matches('[data-in="radius"]')){settings.radius=+e.target.value||500;}
      if(e.target.matches('[data-in="officetel"]')) settings.includeOfficetel=e.target.value==='1';
      if(e.target.matches('[data-in="manualUnits"]')){settings.manualUnits=e.target.value;render();}
      if(e.target.matches('[data-calc]')){ readCalculatorUi(); renderCalculator(); }
    });
    el.addEventListener('input',e=>{
      if(e.target.matches('[data-calc]')){ readCalculatorUi(); renderCalculator(); }
    });
  }
  function applyInputs(){
    const el=panel(); if(!el)return;
    $('[data-in="radius"]',el).value=String(settings.radius);
    const unitSel=$('[data-in="unitMode"]',el); if(unitSel) unitSel.value=settings.unitMode==='sqm'?'sqm':'py';
    $('[data-in="key"]',el).value=settings.serviceKey||'';
    $('[data-in="manualUnits"]',el).value=settings.manualUnits||'';
    $('[data-in="officetel"]',el).value=settings.includeOfficetel?'1':'0';
    $$('[data-calc]',el).forEach(inp=>{ const k=inp.dataset.calc; if(k in settings) inp.value=settings[k] ?? ''; });
  }
  function readUi(){
    const el=panel(); if(!el)return;
    settings.radius=+$('[data-in="radius"]',el).value||500;
    const unitSel=$('[data-in="unitMode"]',el); settings.unitMode=unitSel?.value==='sqm'?'sqm':'py';
    settings.targetYield=6.0;
    settings.serviceKey=$('[data-in="key"]',el).value.trim();
    settings.manualUnits=$('[data-in="manualUnits"]',el).value.trim();
    settings.includeOfficetel=$('[data-in="officetel"]',el).value==='1';
    readCalculatorUi();
  }
  function calcNum(v, fallback=NaN){
    const n=Number(v); return Number.isFinite(n)?n:fallback;
  }
  function readCalculatorUi(){
    const el=panel(); if(!el)return;
    $$('[data-calc]',el).forEach(inp=>{
      const k=inp.dataset.calc;
      settings[k]=inp.value===''?'':calcNum(inp.value, settings[k]);
    });
  }
  function investmentCalc(){
    const purchase=calcNum(settings.purchasePrice);
    const loanRatio=clamp(calcNum(settings.loanRatio,0),0,100);
    const interest=Math.max(0,calcNum(settings.interestRate,0));
    const costRate=Math.max(0,calcNum(settings.acquisitionCostRate,0));
    const dep=Math.max(0,calcNum(settings.tenantDeposit,0));
    const rent=Math.max(0,calcNum(settings.tenantRent,0));
    const vacancy=clamp(calcNum(settings.vacancyRate,0),0,100);
    const ownerMonthly=Math.max(0,calcNum(settings.ownerMonthlyCost,0));
    if(!Number.isFinite(purchase)||purchase<=0) return null;
    const loan=purchase*loanRatio/100;
    const purchaseCosts=purchase*costRate/100;
    const cash=Math.max(0,purchase+purchaseCosts-loan-dep);
    const annualGrossRent=rent*12*(1-vacancy/100);
    const annualInterest=loan*interest/100;
    const annualOwnerCost=ownerMonthly*12;
    const annualCash=annualGrossRent-annualInterest-annualOwnerCost;
    const denominator=Math.max(0.0001,purchase-dep);
    const grossYield=annualGrossRent/denominator*100;
    const roe=cash>0?annualCash/cash*100:NaN;
    return {purchase,loan,purchaseCosts,cash,annualGrossRent,annualInterest,annualOwnerCost,annualCash,grossYield,roe,monthlyInterest:annualInterest/12};
  }
  function renderCalculator(){
    const c=investmentCalc();
    if(!c){
      ['calcLoan','calcMonthlyInterest','calcCash','calcAnnualCash','calcGrossYield','calcRoe'].forEach(k=>setv(k,'-'));
      return;
    }
    setv('calcLoan',`${fmt(c.loan)}만원`);
    setv('calcMonthlyInterest',`${fmt(c.monthlyInterest,1)}만원`);
    setv('calcCash',`${fmt(c.cash)}만원`);
    setv('calcAnnualCash',`${fmt(c.annualCash,1)}만원`);
    setv('calcGrossYield',`${fmt(c.grossYield,2)}%`);
    setv('calcRoe',Number.isFinite(c.roe)?`${fmt(c.roe,2)}%`:'-');
  }
  function marketRentToCalculator(){
    const l=latest?.listings||scanListings();
    if(!Number.isFinite(l.depositMedian)||!Number.isFinite(l.rentAmountMedian)){
      setv('warning','현재 읽힌 월세 매물이 부족해 대표 임대값을 가져올 수 없습니다.');
      return;
    }
    settings.tenantDeposit=Math.round(l.depositMedian);
    settings.tenantRent=Math.round(l.rentAmountMedian);
    applyInputs(); renderCalculator();
    setv('warning','현재 읽힌 월세 매물의 보증금·월세 중앙값을 투자 계산기에 입력했습니다. 서로 같은 매물의 한 쌍이 아닐 수 있으므로 참고값으로만 사용하세요.');
  }
  function saveSettingsFromUi(show){
    readUi(); chrome.storage.local.set({sangaInvestSettings:settings},()=>{if(show)setv('warning','설정을 저장했습니다. 지역 분석을 다시 누르면 새 설정으로 계산합니다.');});
  }
  function activeTradeKind(){
    // 화면 상단 거래유형 버튼(매매/월세)을 우선 확인한다.
    try{
      const els=[...document.querySelectorAll('button,a,[role="button"]')];
      for(const el of els){
        const r=el.getBoundingClientRect();
        if(r.bottom<0 || r.top>420) continue;
        const t=exactText(el).replace(/\s+/g,'');
        if(t==='월세') return 'rent';
        if(t==='매매') return 'sale';
      }
    }catch(_e){}
    const l=latest?.listings;
    if(l?.sales?.length && !l?.rents?.length) return 'sale';
    if(l?.rents?.length && !l?.sales?.length) return 'rent';
    return l?.sales?.length ? 'sale' : 'rent';
  }
  function render(){
    if(!latest) return;
    const l=latest.listings||scanListings(); latest.listings=l;
    const useSqm=settings.unitMode==='sqm';
    const factor=useSqm?0.3025:1;
    const unitName=useSqm?'㎡':'평';
    const saleFmt=v=>Number.isFinite(v)?`${fmt(v*factor,0)}만`:'-';
    const rentFmt=v=>Number.isFinite(v)?`${fmt(v*factor,2)}만`:'-';
    setv('saleUnitLabel',`매매 ${unitName}당`);
    setv('rentUnitLabel',`월세 ${unitName}당`);
    setv('saleRangeUnitLabel',`매매 ${unitName}당`);
    setv('rentRangeUnitLabel',`월세 ${unitName}당`);
    setv('saleMean',saleFmt(l.saleMean));
    setv('saleMedian',saleFmt(l.saleMedian));
    setv('saleTrimmed',saleFmt(l.saleTrimmed));
    setv('saleMin',saleFmt(l.saleMin));
    setv('saleP10',saleFmt(l.saleP10));
    setv('saleP90',saleFmt(l.saleP90));
    setv('saleMax',saleFmt(l.saleMax));
    setv('saleCount',`${l.sales.length}건`);
    setv('rentMean',rentFmt(l.rentMean));
    setv('rentMedian',rentFmt(l.rentMedian));
    setv('rentTrimmed',rentFmt(l.rentTrimmed));
    setv('rentMin',rentFmt(l.rentMin));
    setv('rentP10',rentFmt(l.rentP10));
    setv('rentP90',rentFmt(l.rentP90));
    setv('rentMax',rentFmt(l.rentMax));
    setv('rentCount',`${l.rents.length}건`);

    const cheap=panel()?.querySelector('[data-v="cheapSales"]');
    const cheapTitle=panel()?.querySelector('[data-v="cheapTitle"]');
    if(cheap){
      const kind=activeTradeKind();
      const arr=kind==='rent' ? l.cheapRents : l.cheapSales;
      if(cheapTitle) cheapTitle.innerHTML=`저가 매물 TOP 3 <span>${kind==='rent'?'현재 읽힌 월세':'현재 읽힌 매매'} 중 평당단가가 낮은 순</span>`;
      if(!arr.length){
        cheap.innerHTML=`<span class="sip-muted">현재 지역의 ${kind==='rent'?'월세':'매매'} 매물이 없습니다. 다시읽기를 눌러 전체 자동조회를 시도해 주세요.</span>`;
      } else {
        cheap.innerHTML=arr.map((x,i)=>{
          const floor=Number.isFinite(x.floor)?(x.floor<0?`B${Math.abs(x.floor)}`:`${x.floor}층`):'층 미상';
          const areaSqm=x.areaPy/0.3025;
          const shownUnit=x.unit*factor;
          if(kind==='rent'){
            const rentText=`보증금 ${fmt(x.deposit)} / 월세 ${fmt(x.rent)}`;
            return `<button class="sip-lowitem" data-act="focusListing" data-idx="${x.idx}"><b>${i+1}위 · ${fmt(shownUnit,2)}만/${unitName}</b><span>${rentText} · ${floor} · 전용 ${fmt(x.areaPy,1)}평 (${fmt(areaSqm,1)}㎡)</span></button>`;
          }
          const saleText=Number.isFinite(x.price)?`${fmt(x.price/10000,2)}억`:'가격 미상';
          const estYield=Number.isFinite(l.rentMedian)&&l.rentMedian>0?l.rentMedian*12/x.unit*100:NaN;
          const y=Number.isFinite(estYield)?` · 시장월세 환산 ${fmt(estYield,2)}%` : '';
          return `<button class="sip-lowitem" data-act="focusListing" data-idx="${x.idx}"><b>${i+1}위 · ${fmt(shownUnit,0)}만/${unitName}</b><span>${saleText} · ${floor} · 전용 ${fmt(x.areaPy,1)}평 (${fmt(areaSqm,1)}㎡)${y}</span></button>`;
        }).join('');
      }
    }

    const gross=inferredGrossYield(l);
    const conservative=Number.isFinite(l.saleMedian)&&l.saleMedian>0&&Number.isFinite(l.rentP25)?l.rentP25*12/l.saleMedian*100:NaN;
    const capUnit=Number.isFinite(l.rentMedian)?l.rentMedian*12/0.06:NaN;
    setv('autoGrossYield',Number.isFinite(gross)?`${fmt(gross,2)}%`:'-');
    setv('autoConservativeYield',Number.isFinite(conservative)?`${fmt(conservative,2)}%`:'-');
    setv('autoCapUnit',Number.isFinite(capUnit)?`${fmt(capUnit*factor,0)}만원/${unitName}`:'-');

    if(latest.households){
      const h=latest.households.households||0, s=latest.stores?.count;
      setv('households',`${fmt(h)}세대`);
      const density=h/(Math.PI*(settings.radius/1000)**2);
      setv('hhNote',`${settings.radius}m · ${latest.households.complexes.length}개 단지 · ${fmt(density)}세대/㎢`);
      setv('stores',Number.isFinite(s)?`${fmt(s)}개`:'API 키 필요');
      setv('hhPerStore',Number.isFinite(s)&&s>0?`${fmt(h/s,1)}세대`:'-');
      setv('storePer1000',Number.isFinite(s)&&h>0?`${fmt(s/h*1000,1)}개`:'-');
      const bar=panel()?.querySelector('[data-v="scoreBar"]');
      const score=deriveScore({households:h,stores:s,radius:settings.radius,listings:l});
      const noHouseholds=h<=0;
      const incomplete=noHouseholds || !Number.isFinite(s);
      setv('score',noHouseholds?'-':String(score.score));
      setv('scoreLabel',noHouseholds?'배후세대 데이터 부족':(incomplete ? `${score.label.replace(/\s*·\s*잠정$/,'')} · 잠정` : score.label));
      if(bar)bar.style.width=noHouseholds?'0%':`${score.score}%`;
      setFactorBar('factorDensity',score.densityScore,noHouseholds);
      setFactorBar('factorSupply',score.supplyScore,!Number.isFinite(s));
      setFactorBar('factorListing',score.listingScore,noHouseholds);
      setv('region',latest.households.regionName || latest.households.cortarNo || '');
      const list=latest.households.complexes.slice(0,8).map(c=>`${c.name||c.no} · ${fmt(c.hh)}세대 · ${fmt(c.distance)}m`).join('<br>');
      const ce=panel()?.querySelector('[data-v="complexes"]'); if(ce)ce.innerHTML=list||'반경 내 확인 가능한 주거단지가 없습니다.';
      const units=+settings.manualUnits;
      const rentPer1000=h>0?l.rents.length/h*1000:NaN;
      const salePer1000=h>0?l.sales.length/h*1000:NaN;
      setv('manualUnitKpi',Number.isFinite(units)&&units>0&&h>0?`상가 호실 기준: ${fmt(h/units,1)}세대/호실 · 1천세대당 ${fmt(units/h*1000,1)}호실 · 현재 임대매물 ${fmt(rentPer1000,1)}건/1천세대`:`상가 전체 호실 수를 알면 입력하세요. 현재 네이버 매물은 임대 ${Number.isFinite(rentPer1000)?fmt(rentPer1000,1):'-'}건/1천세대, 매매 ${Number.isFinite(salePer1000)?fmt(salePer1000,1):'-'}건/1천세대입니다.`);
    }
  }
  async function refreshAll(userTriggered=false){
    const runId=++analysisRunSeq;
    mount(); readUi();
    let domListings=scanListings();
    if(!domListings.rows.length && lastGoodDomListings?.rows?.length) domListings=lastGoodDomListings;
    latest={listings:domListings,households:null,stores:null};
    render();
    setv('score','-');
    setv('scoreLabel','분석 중…');
    resetFactorBars();
    setv('households','조회 중');
    setv('stores',settings.serviceKey?'조회 중':'API 키 필요');
    setv('hhPerStore','-');
    setv('storePer1000','-');
    const bar=panel()?.querySelector('[data-v="scoreBar"]'); if(bar) bar.style.width='0%';
    const center=getCenter();
    if(center) lastCenterSignature=`${center.lat.toFixed(5)},${center.lon.toFixed(5)},${center.zoom}`;
    if(!center){
      setv('scoreLabel','지도 위치 확인 필요');
      setv('households','-');
      setv('warning',domListings.rows.length?`현재 화면 매물 ${domListings.rows.length}건은 읽었습니다. 배후세대 분석을 위해 지도를 조금 움직인 뒤 다시 분석을 눌러주세요.`:'지도 중심좌표를 아직 읽지 못했습니다. 지도를 조금 움직인 뒤 다시 분석을 눌러주세요.');
      return;
    }
    setv('warning','현재 지역의 매매·월세 전체 호가와 배후세대를 자동 조회하고 있습니다. 매물목록을 스크롤할 필요가 없습니다…');

    const listingJob=fetchListingsFromApi(center);
    const householdJob=getHouseholds(center,settings.radius);
    const [listingResult,householdResult]=await Promise.allSettled([listingJob,householdJob]);
    if(runId!==analysisRunSeq) return;

    let listingError=''; let householdError='';
    if(listingResult.status==='fulfilled' && listingResult.value?.rows?.length){
      latest.listings=listingResult.value;
    }else if(listingResult.status==='rejected'){
      listingError=listingResult.reason?.message||String(listingResult.reason||'조회 실패');
    }

    if(householdResult.status==='fulfilled'){
      latest.households=householdResult.value;
    }else{
      householdError=householdResult.reason?.message||String(householdResult.reason||'조회 실패');
      setv('households','-');
    }
    render();

    if(latest.households){
      try{ latest.stores=await getStoreCount(center,settings.radius); }
      catch(e){ latest.stores={count:NaN,error:e.message}; }
      if(runId!==analysisRunSeq) return;
      render();
    }

    const l=latest.listings;
    const pieces=[];
    if(l?.rows?.length) pieces.push(`호가 ${l.rows.length}건 반영(매매 ${l.sales.length} / 월세 ${l.rents.length})`);
    else pieces.push('호가 매물 0건');
    if(latest.households) pieces.push(`배후세대 ${fmt(latest.households.households||0)}세대`);
    else pieces.push('배후세대 조회 실패');
    if(listingError) pieces.push(`호가조회 오류: ${listingError}`);
    if(householdError) pieces.push(`배후세대 오류: ${householdError}`);
    if(!settings.serviceKey) pieces.push('영업점 수는 API 키 입력 시 계산');
    setv('warning',pieces.join(' · '));
    if(!latest.households) setv('scoreLabel','배후세대 조회 실패');
  }
  function analysisText(){
    const l=latest?.listings||scanListings(); const h=latest?.households?.households; const s=latest?.stores?.count;
    const sc=Number.isFinite(h)?deriveScore({households:h,stores:s,radius:settings.radius,listings:l}):null;
    const units=+settings.manualUnits;
    const gross=inferredGrossYield(l);
    const conservative=Number.isFinite(l.saleMedian)&&l.saleMedian>0&&Number.isFinite(l.rentP25)?l.rentP25*12/l.saleMedian*100:NaN;
    const cheapKind=activeTradeKind();
    const cheapArr=cheapKind==='rent'?l.cheapRents:l.cheapSales;
    const top3=cheapArr.map((x,i)=>{
      const floor=Number.isFinite(x.floor)?(x.floor<0?`B${Math.abs(x.floor)}`:`${x.floor}층`):'층 미상';
      if(cheapKind==='rent') return `${i+1}위 ${fmt(x.unit,2)}만원/평 · 보증금 ${fmt(x.deposit)} / 월세 ${fmt(x.rent)} · ${floor} · 전용 ${fmt(x.areaPy,1)}평`;
      return `${i+1}위 ${fmt(x.unit)}만원/평 · 매매 ${Number.isFinite(x.price)?fmt(x.price/10000,2)+'억':'-'} · ${floor} · 전용 ${fmt(x.areaPy,1)}평`;
    }).join(' | ');
    return [
      `YB LOCUS Android v${APP_VERSION}`,
      `반경: ${settings.radius}m`,
      `배후세대: ${Number.isFinite(h)?fmt(h)+'세대':'-'}`,
      `영업점: ${Number.isFinite(s)?fmt(s)+'개':'-'}`,
      `세대/영업점: ${Number.isFinite(h)&&Number.isFinite(s)&&s>0?fmt(h/s,1):'-'}`,
      `1천세대당 영업점: ${Number.isFinite(h)&&Number.isFinite(s)&&h>0?fmt(s/h*1000,1):'-'}`,
      `상가호실수(수동): ${Number.isFinite(units)&&units>0?fmt(units):'-'}`,
      `세대/상가호실: ${Number.isFinite(h)&&units>0?fmt(h/units,1):'-'}`,
      `수급지수: ${sc?sc.score+'점 '+sc.label:'-'}`,
      `매매 평당 전체평균/중앙값/보정평균: ${Number.isFinite(l.saleMean)?fmt(l.saleMean):'-'} / ${Number.isFinite(l.saleMedian)?fmt(l.saleMedian):'-'} / ${Number.isFinite(l.saleTrimmed)?fmt(l.saleTrimmed):'-'}만원`,
      `월세 평당 전체평균/중앙값/보정평균: ${Number.isFinite(l.rentMean)?fmt(l.rentMean,2):'-'} / ${Number.isFinite(l.rentMedian)?fmt(l.rentMedian,2):'-'} / ${Number.isFinite(l.rentTrimmed)?fmt(l.rentTrimmed,2):'-'}만원`,
      `평당가 최저 ${cheapKind==='rent'?'월세':'매매'} TOP3: ${top3||'-'}`,
      `매매/월세 건수: ${l.sales.length}/${l.rents.length}`,
      `시장 단순수익률: ${Number.isFinite(gross)?fmt(gross,2)+'%':'-'}`,
      `보수적 월세수익률: ${Number.isFinite(conservative)?fmt(conservative,2)+'%':'-'}`
    ].join('\n');
  }
  async function copyAnalysis(){
    try{
      const t=analysisText();
      if(typeof SangaNative!=='undefined' && SangaNative.copyText){ SangaNative.copyText(window.__SANGA_BRIDGE_TOKEN__||'', t); }
      else await navigator.clipboard.writeText(t);
      setv('warning','분석 내용을 클립보드에 복사했습니다.');
    }catch(e){setv('warning','복사에 실패했습니다.');}
  }
  function csvEsc(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
  function exportCsv(){
    const l=latest?.listings||scanListings();
    const rows=[['구분','층','전용평','가격/조건','평당가(만원)','중앙값대비(%)','저가후보','보증금(만원)','월세(만원)']];
    l.rows.forEach(x=>{
      const med=x.kind==='sale'?l.saleMedian:l.rentMedian;
      const disc=Number.isFinite(med)&&med>0?(x.unit/med-1)*100:NaN;
      const low=(x.kind==='sale'?l.cheapSales:l.cheapRents).some(c=>c.idx===x.idx)?'Y':'';
      rows.push([x.kind==='sale'?'매매':'월세',x.floor??'',x.areaPy.toFixed(2),x.raw,x.unit.toFixed(2),Number.isFinite(disc)?disc.toFixed(1):'',low,x.deposit??'',x.rent??'']);
    });
    const csv='\uFEFF'+rows.map(r=>r.map(csvEsc).join(',')).join('\r\n');
    const name=`상가분석_${new Date().toISOString().slice(0,10)}.csv`;
    try{
      if(typeof SangaNative!=='undefined' && SangaNative.saveTextFile){
        const result=SangaNative.saveTextFile(window.__SANGA_BRIDGE_TOKEN__||'', name,csv);
        setv('warning', result || 'CSV를 저장했습니다.');
        return;
      }
    }catch(e){}
    try{
      const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}), url=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){ setv('warning','CSV 저장에 실패했습니다.'); }
  }
  function load(){
    chrome.storage.local.get(['sangaInvestSettings'],r=>{
      settings={...DEFAULTS,...(r.sangaInvestSettings||{})};
      // v1.6: 분석창과 네이버 지도 모두 평을 기본으로 맞춘다. 사용자는 ㎡당으로 언제든 전환 가능하다.
      settings.unitMode='py';
      mount();applyInputs();latest={listings:scanListings()};render();
    });
  }
  const obs=new MutationObserver((mutations)=>{
    // 분석 패널 자체의 숫자/문구 갱신은 관찰 대상에서 제외한다.
    // v0.6에서는 패널 렌더링이 다시 observer를 깨워 반복 스캔을 만들 수 있어 스크롤이 버벅였다.
    const relevant = mutations.some(m=>{
      const t=m.target?.nodeType===1 ? m.target : m.target?.parentElement;
      if(!t) return false;
      if(t.closest?.(`#${ID},#${LAUNCHER_ID},#${BACKDROP_ID}`)) return false;
      return true;
    });
    if(!relevant) return;

    const sheetOpen = panel() && !panel().classList.contains('sip-sheet-closed');
    if(!sheetOpen){
      clearTimeout(typeSheetTimer);
      typeSheetTimer=setTimeout(simplifyPropertyTypeSheet,220);
    }
    clearTimeout(refreshTimer); refreshTimer=setTimeout(()=>{
      const hrefChanged=location.href!==lastHref;
      if(hrefChanged){
        lastHref=location.href;
      }

      // 분석 시트가 열려 있을 때는 자동 매물 전체 재스캔을 잠시 멈춰 스크롤 우선.
      const sheetStillOpen = panel() && !panel().classList.contains('sip-sheet-closed');
      if(latest && !sheetStillOpen){ latest.listings=scanListings(); render(); }

      const c=getCenter();
      const sig=c?`${c.lat.toFixed(5)},${c.lon.toFixed(5)},${c.zoom}`:'';
      if(sig && sig!==lastCenterSignature){
        lastCenterSignature=sig;
        // v2.8: 지도/DOM 변화만으로 배후세대 분석을 자동 재실행하지 않는다.
        // 이전에는 여러 비동기 조회가 겹치면서 '조회 중 ↔ 조회 실패'가 번갈아 표시될 수 있었다.
        // 분석창을 다시 열거나 '지역 분석'을 눌렀을 때만 한 번의 최신 조회를 실행한다.
      }
    },700);
  });
  function boot(){
    installCenterProbe();
    installPropertyTypeIntentGuard();
    installNaverListSheetTracker();
    try{ userTypeOverride=sessionStorage.getItem(TYPE_OVERRIDE_KEY)==='1'; }catch(_e){ userTypeOverride=false; }
    load();
    simplifyPropertyTypeSheet();
    runInitialLanding();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
  obs.observe(document.documentElement,{subtree:true,childList:true});
})();
