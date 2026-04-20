// ── AFFILIATE PRODUCTS ──
const ALL_PICKS = [
  {
    id:'cubee3d',
    img:'https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model%20%281%29.jpg',
    brand:'Cubee3D', name:'Commercial STL License',
    desc:'Sell 3D printed products from 1,000+ professional designs legally. One license, unlimited prints. No IP risk.',
    ic:'📜', badge:'Most Popular', badgeClass:'orange',
    discountCode:'MESHMINDS',
    url:'https://cubee3d.com/?ref=meshminds',
    tap:'Get licensed →'
  },
  {
    id:'meshy',
    img:'https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model.jpg',
    brand:'Meshy', name:'AI 3D Model Generator',
    desc:'Type a prompt, get a print-ready 3D model. Skip the design phase entirely and go straight to printing and selling. No CAD skills needed.',
    ic:'🤖',
    url:'https://www.meshy.ai?via=meshminds',
    tap:'Try free →'
  },
  {
    id:'makerworld',
    img:'https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model%20%285%29.jpg',
    brand:'MakerWorld', name:'My Free Bestseller Models',
    desc:'The exact models I sold 11,000+ times on Etsy, now free to download with a commercial license. Start printing proven bestsellers today.',
    ic:'🎁',
    url:'https://makerworld.com/de/collections/9383161-my-bestsellers',
    tap:'Download free →'
  },
  {
    id:'timeplast',
    img:'https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Untitled%20design%20%2811%29.jpg',
    brand:'Timeplast', name:'Soap Filament',
    desc:'Prints like PLA, dissolves like soap. Eco story = premium price without argument. A hidden gem for gift and novelty markets.',
    ic:'🧵', badge:'HIDDEN GEM', badgeClass:'orange',
    url:'https://timeplast.com/?ref=meshminds',
    tap:'Shop Timeplast →'
  },
  {
    id:'cryogrip',
    img:'https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model%20%282%29.jpg',
    brand:'Panda Touch', name:'CryoGrip BuildPlate',
    desc:'Grips hot, releases cold. No glue, no hairspray. Saves hours per week the first upgrade to make on any Bambu printer.',
    ic:'🔧', badge:'UPGRADE #1', badgeClass:'orange',
    url:'https://biqu.equipment/?ref=meshminds',
    tap:'Shop CryoGrip →'
  },
  {
    id:'farmloop',
    img:'https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Untitled%20design%20%2810%29.jpg',
    brand:'3D Farmers', name:'Automate Your Printer',
    desc:'Prints, auto-ejects, starts the next job. Run your printer all day without babysitting it. The system behind unattended batch printing.',
    ic:'🏭', badge:'AUTO PRINT', badgeClass:'orange',
    url:'https://3d-farmers.com/#farmloop-section',
    tap:'Automate now →'
  },
]

const DEFAULT_VISIBLE = 6;
let showingAll = false;

function buildPickHTML(p){
  const badge = p.badge ? '<span class="p-badge ' + (p.badgeClass||'orange') + '">' + p.badge + '</span>' : '';
  const hasCode = !!p.discountCode;
  const hrefAttr = hasCode ? 'javascript:void(0)' : p.url;
  const targetAttr = hasCode ? '' : ' target="_blank" rel="noopener"';
  return '<a class="pick rv" href="' + hrefAttr + '"' + targetAttr
    + ' data-id="' + p.id + '" data-url="' + p.url + '" data-code="' + (p.discountCode||'') + '" onclick="trackPick(this)">'
    + '<div class="pick-img">'
    + (p.img ? '<img src="' + p.img + '" alt="' + p.name + '" loading="lazy" onerror="hideImg(this)">' : '')
    + '<span class="ph-ic" style="' + (p.img ? 'display:none' : '') + '">' + p.ic + '</span>'
    + '<span class="ph-label">' + p.name + '</span>'
    + badge
    + '</div>'
    + '<div class="pick-body">'
    + '<div class="p-name">' + p.name + '</div>'
    + '<div class="p-desc">' + p.desc + '</div>'
    + '<div class="p-tap">' + p.tap + '</div>'
    + '</div></a>';
}

function hideImg(el){el.style.display='none';}
function trackPick(el){
  const code = el.dataset.code;
  if(code){
    openDiscountPopup(code, el.dataset.url, el.dataset.id);
    return false;
  }
  track('offer_click', {button: el.dataset.id, href: el.dataset.url});
}

function renderPicks(){
  const grid = document.getElementById('picks-grid');
  const btn  = document.getElementById('show-more-btn');
  // Initial render: only default visible, no animation triggered by btn
  const picks = ALL_PICKS.slice(0, DEFAULT_VISIBLE);
  grid.innerHTML = picks.map(buildPickHTML).join('');
  if(ALL_PICKS.length > DEFAULT_VISIBLE){
    btn.style.display = 'flex';
  }
  grid.querySelectorAll('.rv').forEach(el=>obs.observe(el));
}

function showMorePicks(){
  showingAll = true;
  track('button_click', {button:'show_more_picks'});
  const grid = document.getElementById('picks-grid');
  const btn  = document.getElementById('show-more-btn');
  // Append only the hidden picks no re-render of existing ones
  const extra = ALL_PICKS.slice(DEFAULT_VISIBLE);
  extra.forEach(p => {
    const div = document.createElement('div');
    div.innerHTML = buildPickHTML(p);
    const el = div.firstElementChild;
    // Skip reveal animation show immediately
    el.classList.remove('rv');
    el.style.opacity = '1';
    el.style.transform = 'none';
    grid.appendChild(el);
  });
  btn.style.display = 'none';
}

// ── QUIZ ENGINE ──
let answers = {}, path = null, qIndex = 0, activeFlow = {};
const history = [];

const STEPS = {
  intent:{key:'intent',question:"WHAT'S YOUR\nGOAL?",options:[
    {val:'commercial',ic:'💰',t:'I want to sell prints'},
    {val:'fun',       ic:'🎨',t:'I just print for fun'},
  ]},

  // COMMERCIAL PATH
  com_level:{key:'com_level',question:'WHERE ARE YOU\nRIGHT NOW?',options:[
    {val:'beginner',ic:'🔰',t:'Just getting started',  s:'I have a printer or am about to buy one'},
    {val:'seller',  ic:'💸',t:"I\'m already selling",  s:'On Etsy, locally, or working toward more'},
  ]},
  can_design:{key:'can_design',question:'CAN YOU DESIGN\nYOUR OWN MODELS?',options:[
    {val:'yes',      ic:'✏️',t:'Yes, I design my own files',  s:'Fusion 360, Blender, CAD or similar'},
    {val:'no',       ic:'📦',t:'No, I print existing files',   s:'I use files from MakerWorld, Thangs or similar'},
  ]},
  com_problem:{key:'com_problem',question:"WHAT\'S YOUR\nBIGGEST BLOCK?",options:[
    {val:'what', ic:'🎯',t:"I don\'t know what to sell",  s:'Picking a product people actually want to buy'},
    {val:'sell', ic:'📣',t:"I don\'t know how to sell",   s:'Getting seen, getting clicks, getting the checkout'},
  ]},

  // CONTENT PATH
  content_stage:{key:'content_stage',question:'WHERE ARE YOU\nWITH CONTENT?',options:[
    {val:'zero',    ic:'🌱',t:'Starting from zero',              s:"Haven\'t posted yet or just getting started"},
    {val:'growing', ic:'📈',t:'I post but growth is slow',      s:'Some followers but growth has stalled'},
    {val:'monetize',ic:'💶',t:'I have an audience, need money', s:"People follow me, I just don\'t know how to monetize"},
  ]},
  content_platform:{key:'content_platform',question:'WHERE DO YOU\nWANT TO GROW?',options:[
    {val:'instagram',ic:'📸',t:'Instagram and TikTok', s:'Short videos and carousels'},
    {val:'youtube',  ic:'▶️', t:'YouTube',              s:'Long form videos and tutorials'},
    {val:'multi',    ic:'🌐',t:'Multiple platforms',   s:'I want to grow everywhere'},
    {val:'notsure',  ic:'🤔',t:'Not sure yet',         s:"I\'ll go where the audience is"},
  ]},
  content_goal:{key:'content_goal',question:"WHAT\'S YOUR\nCONTENT GOAL?",options:[
    {val:'brand',   ic:'🤝',t:'Brand deals and affiliate income', s:'Sponsorships and commissions from gear brands'},
    {val:'products',ic:'📦',t:'Sell my own products',             s:'Drive traffic to my own digital or physical products'},
    {val:'all',     ic:'💰',t:'All of the above',                 s:'As many income streams as possible'},
  ]},

  // FUN PATH
  fun_type:{key:'fun_type',question:'WHAT DO YOU\nLOVE PRINTING?',options:[
    {val:'miniatures',ic:'🐉',t:'Miniatures and figurines',       s:'D&D, Warhammer, collectibles'},
    {val:'functional',ic:'🔩',t:'Functional and useful things',   s:'Organisers, mounts, tools, replacement parts'},
    {val:'art',       ic:'🌀',t:'Art, design and cool models',    s:'Vases, sculptures, generative art'},
    {val:'explore',   ic:'🔭',t:'Still exploring',                s:'I\'ll print anything, just looking for inspiration'},
  ]},
  fun_printer:{key:'fun_printer',question:'WHAT PRINTER\nDO YOU HAVE?',options:[
    {val:'bambu',      ic:'🖨️',t:'Bambu Lab',         s:'A1, P1S, X1 or any Bambu printer'},
    {val:'fdm',        ic:'🖨️',t:'Other FDM printer',  s:'Creality, Prusa or any filament printer'},
    {val:'resin',      ic:'💧',t:'Resin printer',       s:'Elegoo, Anycubic, Phrozen'},
    {val:'no-printer', ic:'🛒',t:"I don\'t have one yet", s:'Still deciding what to get'},
  ]},

};

function nextStep(stepKey, val){
  if(stepKey==='intent'){
    if(val==='fun')     return 'fun_type';
    if(val==='content') return 'content_stage';
    if(val==='help')    return null; // no printer yet → straight to recommendation
    return 'com_level'; // commercial
  }
  // Commercial
  if(stepKey==='com_level')   return 'com_problem';
  if(stepKey==='com_problem') return null;
  // Content
  if(stepKey==='content_stage')    return 'content_platform';
  if(stepKey==='content_platform') return 'content_goal';
  if(stepKey==='content_goal')     return null;
  // Fun
  if(stepKey==='fun_type')    return 'fun_printer';
  if(stepKey==='fun_printer') return null;
  return null;
}


function totalSteps(p){
  if(p==='commercial') return 3; // intent + level + problem
  if(p==='content')    return 4; // intent + stage + platform + goal
  if(p==='fun')        return 3; // intent + type + printer
  return 1; // help: just intent → printer recommendation
}

function renderStep(stepKey, stepNum, total){
  track('quiz_view', {button: stepKey});
  const step = STEPS[stepKey];
  const opts = typeof step.options==='function' ? step.options(answers) : step.options;

  const prog = document.getElementById('build-progress');
  const bpLabel = document.getElementById('bp-label');
  const bpDots = document.getElementById('bp-dots');
  if(stepNum > 1 && prog){
    prog.style.display = 'block';
    if(bpLabel) bpLabel.textContent = `Step ${stepNum} of ${total}`;
    if(bpDots){
      let d = '';
      for(let i=1;i<=total;i++){
        if(i>1) d+=`<div class="bp-connector${i<=stepNum?' done':''}"></div>`;
        d+=`<div class="bp-dot ${i<stepNum?'done':i===stepNum?'cur':''}"></div>`;
      }
      bpDots.innerHTML = d;
    }
  } else if(prog) prog.style.display='none';

  document.getElementById('dyn-eyebrow').textContent = stepNum===1 ? '60 seconds → your personalized print-for-profit plan' : '';
  document.getElementById('dyn-question').innerHTML = step.question.replace(/\n/g,'<br>');
  const isIntentStep = stepKey === 'intent';
  const optsEl = document.getElementById('dyn-options');
  optsEl.innerHTML = opts.map(o=>`
    <button class="qo" onclick="pick(this,'${o.val}','${stepKey}')">
      <span class="qo-ic">${o.ic}</span>
      <div class="qo-text"><div class="qo-t">${o.t}</div>${o.s && !isIntentStep ? `<div class="qo-s">${o.s}</div>` : ''}</div>
      ${!isIntentStep ? '<span class="qo-check">✓</span>' : ''}
    </button>`).join('');
  if(isIntentStep) optsEl.classList.add('two-up');
  else optsEl.classList.remove('two-up');

  const backRow = document.getElementById('quiz-back-row');
  if(backRow) backRow.style.display = stepNum>1 ? 'block' : 'none';

  const dynStep = document.getElementById('qs-dynamic');
  dynStep.classList.remove('active');
  void dynStep.offsetWidth;
  dynStep.classList.add('active');

  const hint = document.getElementById('q-tap-hint');
  if(hint) hint.classList.toggle('hidden', stepNum>1);
}

function pick(el, val, stepKey){
  el.closest('.qopts').querySelectorAll('.qo').forEach(o=>o.classList.remove('sel'));
  el.classList.add('sel');
  if(stepKey==='intent'){
    path = val==='commercial'?'commercial':val==='content'?'content':val==='fun'?'fun':'help';
  }
  answers[stepKey] = val;
  history.push({stepKey, stepNum:qIndex+1, total: activeFlow._total||2});
  track('quiz_step', {button: stepKey+'_'+val});

  const next = nextStep(stepKey, val);
  setTimeout(()=>{
    if(!next){ showResult(); return; }
    qIndex++;
    const tot = totalSteps(path);
    activeFlow._total = tot;
    renderStep(next, qIndex+1, tot);
  }, stepKey==='intent'?0:220);
}

function goBack(){
  if(!history.length) return;
  track('button_click',{button:'quiz_back'});
  const prev = history.pop();
  delete answers[prev.stepKey];
  qIndex = prev.stepNum - 1;
  if(qIndex===0) path=null;
  document.querySelectorAll('.qres').forEach(e=>{e.classList.remove('active');e.style.display='';});
  document.getElementById('res-newsletter').style.display='none';
  document.getElementById('qs-dynamic').classList.add('active');
  renderStep(prev.stepKey, prev.stepNum, prev.total||2);
}

function showResult(){
  track('quiz_complete', {button:'quiz_'+path, href: Object.values(answers).join('_')});
  const loader = document.getElementById('print-loader');
  document.getElementById('qs-dynamic').classList.remove('active');
  if(loader) loader.classList.add('active');
  setTimeout(()=>{
    if(loader) loader.classList.remove('active');
    if(path==='commercial') showCommercialResult();
    else if(path==='content'){ showContentResult(); }
    else if(path==='fun'){ document.getElementById('res-fun').classList.add('active'); }
    else { showHelpResult(); }
  }, 1400);
}

function showHelpResult(){
  const ht = answers['help_type']||'buying';

  const bambuCard = `
    <a class="res-offer-card" href="https://eu.store.bambulab.com/de/products/a1?srsltid=AfmBOopWBrouM3KT6vyvjQRc_DKbsV2vtiCzGwJLDhZvQQKzYKbV99sK&id=599117150694776840" target="_blank" rel="noopener" onclick="track('offer_click',{button:'bambu_a1_help_${ht}',href:'https://eu.store.bambulab.com/de/products/a1'})" style="margin:20px 0">
      <div class="res-offer-img"><img src="https://store.bblcdn.com/s7/default/866e470a983f4d989f81a495a5f5c71c/A1-compressed.jpg" alt="Bambu Lab A1 + AMS" loading="lazy"></div>
      <div class="res-offer-body">
        <div class="res-offer-badge">MY #1 PICK</div>
        <div class="res-offer-top">
          <div>

            <div class="res-offer-name">A1 + AMS Combo</div>
          </div>
        </div>
        <div class="res-offer-desc">Multi-color from day one, 256mm/s, zero calibration. The best beginner-to-pro machine on the market.</div>
        <div class="res-offer-cta">Shop Bambu Lab A1 →</div>
      </div>
    </a>`;

  const cryoGripCard = `
    <a class="res-offer-card" href="https://biqu.equipment/?ref=meshminds" target="_blank" rel="noopener" onclick="track('offer_click',{button:'cryogrip_help_quality',href:'https://biqu.equipment/?ref=meshminds'})" style="margin:20px 0">
      <div class="res-offer-img"><img src="https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model%20%282%29.jpg" alt="CryoGrip BuildPlate" loading="lazy"></div>
      <div class="res-offer-body">
        <div class="res-offer-top">
          <div>

            <div class="res-offer-name">CryoGrip BuildPlate</div>
          </div>
        </div>
        <div class="res-offer-desc">Grips hot, releases cold. No glue, no hairspray. First upgrade I put on every printer I own.</div>
        <div class="res-offer-cta">Shop CryoGrip →</div>
      </div>
    </a>`;

  const makerworldCard = `
    <a class="res-offer-card" href="https://makerworld.com/de/collections/9383161-my-bestsellers" target="_blank" rel="noopener" onclick="track('offer_click',{button:'makerworld_help_materials',href:'https://makerworld.com/de/collections/9383161-my-bestsellers'})" style="margin:20px 0">
      <div class="res-offer-img"><img src="https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model%20%285%29.jpg" alt="Meshminds free models on MakerWorld" loading="lazy"></div>
      <div class="res-offer-body">
        <div class="res-offer-top">
          <div>

            <div class="res-offer-name">Test Your Materials With Bestsellers</div>
          </div>
        </div>
        <div class="res-offer-desc">Free bestselling models to benchmark every filament you try. Same file, same print, any material fastest way to see which one wins.</div>
        <div class="res-offer-cta">Download free →</div>
      </div>
    </a>`;

  const copy = {
    buying:    { path:'Buying Guide',      title:'THE BEST PRINTER<br>TO START WITH.',  diag:'I run a Bambu Lab A1 with AMS. Fastest setup, best value, and the one I\'d buy again tomorrow.', card: bambuCard },
    quality:   { path:'Print Quality Fix', title:'BETTER PRINTS<br>START HERE.',        diag:'Most quality issues come down to one thing: bed adhesion. Fix that first and 80% of problems disappear.', card: cryoGripCard },
    materials: { path:'Materials Guide',   title:'RIGHT FILAMENT.<br>RIGHT JOB.',       diag:'PLA for most things, PETG for heat and flex, ABS/ASA for outdoors. Start with a good matte PLA and you\'re 90% covered.', card: makerworldCard },
    setup:     { path:'Setup Guide',       title:'LET\'S GET YOUR<br>SETUP RIGHT.',     diag:'A good setup starts with the right printer. The Bambu A1 auto-calibrates everything, no manual tuning, ever.', card: bambuCard },
  };
  const c = copy[ht]||copy.buying;
  document.querySelector('#res-help .qres-path').textContent = c.path;
  document.querySelector('#res-help .qres-title').innerHTML = c.title;
  document.querySelector('#res-help .qres-diag').innerHTML = c.diag;
  document.getElementById('help-offer-card').innerHTML = c.card;
  document.getElementById('res-help').classList.add('active');
}

function showContentResult(){
  const goal = answers['content_goal']||'all';
  const hooks = {
    brand:    { title:'WANT TO GROW?<br>LET ME<br><em style="color:var(--o)">PUSH YOU.</em>',
                diag:'I grew @meshminds3d to 93K+ on Instagram without a big budget. If you want to grow your 3D printing account, DM me on Instagram. I do occasional shoutouts for creators I genuinely rate.' },
    products: { title:'I\'LL SHOW YOUR<br>WORK TO MY<br><em style="color:var(--o)">AUDIENCE.</em>',
                diag:'The fastest way to get your first customers is to get in front of an existing audience. If your work is good, DM me I feature creators and products to my 93K+ Instagram followers when something stands out.' },
    all:      { title:'WANT A<br>3D PRINTING<br><em style="color:var(--o)">SHOUTOUT?</em>',
                diag:'A shoutout from the right account can shortcut months of work. DM me on Instagram and show me what you\'re building. I feature creators I genuinely believe in.' },
  };
  const h = hooks[goal]||hooks.all;
  document.getElementById('ct-title').innerHTML = h.title;
  document.querySelector('#res-content .qres-diag').innerHTML = h.diag;
  document.getElementById('res-content').classList.add('active');
}

function showCommercialResult(){
  const problem = answers['com_problem']||'what';
  const level   = answers['com_level']||'beginner';

  // Title + diagnosis adapt to problem
  const titles = {
    what: 'FIND WHAT<br>ACTUALLY SELLS.',
    sell: 'TURN PRINTS<br>INTO SALES.',
  };
  const diags = {
    what: "The fastest way to find a winning product is to print what already sells. Cubee gives you 1,000+ licensed commercial designs so you can skip the guesswork, pick a proven niche, and start shipping today.",
    sell: "Selling starts with having something people already want to buy. Skip the \"will this work?\" gamble by starting with a library of proven designs, then put your energy into listings, photos, and getting in front of buyers.",
  };

  const cubeeHero = `
    <div style="margin:20px 0 4px">
      <div style="font-size:11px;color:var(--o);font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px">Start here</div>
      <div style="font-family:var(--fd);font-size:clamp(20px,5.5vw,26px);letter-spacing:.5px;margin-bottom:12px;line-height:1.1">START WITH 1,000+<br>PROVEN DESIGNS.</div>
      <div class="res-offer-card" onclick="openDiscountPopup('MESHMINDS','https://cubee3d.com/?ref=meshminds','cubee3d_quiz')" style="cursor:pointer;border-color:rgba(255,92,0,.45);margin-bottom:0">
        <div class="res-offer-img"><img src="https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model%20%281%29.jpg" alt="Cubee3D Commercial STL License" loading="lazy"></div>
        <div class="res-offer-body">
          <div class="res-offer-badge">SOLVE THE "WHAT TO SELL" PROBLEM</div>
          <div class="res-offer-top">
            <div>

              <div class="res-offer-name">Commercial STL License</div>
            </div>
          </div>
          <div class="res-offer-desc">1,000+ professional designs you can legally sell. Browse proven niches, pick what fits your market, start printing. No IP risk.</div>
          <div class="res-offer-cta">Get licensed → <span style="font-size:12px;opacity:.6">(tap to reveal your discount code)</span></div>
        </div>
      </div>
    </div>`;

  const meshyCard = `
    <a class="res-offer-card" href="https://www.meshy.ai?via=meshminds" target="_blank" rel="noopener" onclick="track('offer_click',{button:'meshy_quiz',href:'https://www.meshy.ai?via=meshminds'})">
      <div class="res-offer-img"><img src="https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model.jpg" alt="Meshy AI 3D Model Generator" loading="lazy"></div>
      <div class="res-offer-body">
        <div class="res-offer-top">
          <div>

            <div class="res-offer-name">AI 3D Model Generator</div>
          </div>
        </div>
        <div class="res-offer-desc">Type a prompt, get a print-ready file. No CAD skills needed. Generate custom products in minutes and own them outright.</div>
        <div class="res-offer-cta">Try free →</div>
      </div>
    </a>`;

  const makerworldCard = `
    <a class="res-offer-card" href="https://makerworld.com/de/collections/9383161-my-bestsellers" target="_blank" rel="noopener" onclick="track('offer_click',{button:'makerworld_commercial',href:'https://makerworld.com/de/collections/9383161-my-bestsellers'})">
      <div class="res-offer-img"><img src="https://w9cedwr8emsi29qt.public.blob.vercel-storage.com/Text%20%E2%86%92%203D%20Model%20%285%29.jpg" alt="Meshminds free models on MakerWorld" loading="lazy"></div>
      <div class="res-offer-body">
        <div class="res-offer-top">
          <div>

            <div class="res-offer-name">My Bestseller Models, Free</div>
          </div>
        </div>
        <div class="res-offer-desc">Every model I sold 11,000+ times on Etsy, now free to download. Start selling proven products today. Commercial license available on MakerWorld.</div>
        <div class="res-offer-cta">Download free →</div>
      </div>
    </a>`;

  const emailCapture = `
    <div class="email-capture" style="margin-top:8px">
      <div id="ec-thumb-commercial" style="width:100%;aspect-ratio:16/9;background:var(--s2);border:2px dashed var(--b2);border-radius:var(--r);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;margin-bottom:16px;overflow:hidden">
        <div style="font-size:32px;opacity:.4">🖼️</div>
        <div style="font-size:10px;color:var(--t3);letter-spacing:1.5px;text-transform:uppercase;font-weight:600">Thumbnail coming soon</div>
      </div>
      <div class="ec-title">FREE: 10 PRODUCTS TO SELL THIS WEEK</div>
      <div class="ec-desc">Every week I share the exact niches making money right now: real margin, proven demand, what to print. Free to your inbox, no fluff.</div>
      <div class="ec-form">
        <input type="email" class="ec-input" placeholder="your@email.com" id="email-commercial" aria-label="Email address">
        <button class="ec-btn" onclick="submitEmail('commercial')">Send me ideas →</button>
      </div>
      <div class="ec-thanks" id="ec-thanks-commercial">You're in. First edition coming soon.</div>
      <div class="ec-consent">No spam. Unsubscribe anytime.</div>
    </div>`;

  document.getElementById('qr-path').textContent = (level.charAt(0).toUpperCase()+level.slice(1))+' Path';
  document.getElementById('qr-title').innerHTML = titles[problem]||titles.what;
  document.getElementById('qr-diag').innerHTML  = diags[problem]||diags.what;
  document.getElementById('dyn-offer-block').innerHTML =
    cubeeHero +
    '<div class="res-offer-grid" style="margin-top:12px">' +
    meshyCard + makerworldCard +
    '</div>' + emailCapture;

  document.getElementById('res-commercial').classList.add('active');
}

function restartQuiz(){
  track('button_click',{button:'quiz_restart'});
  answers={};path=null;qIndex=0;activeFlow={};history.length=0;
  document.querySelectorAll('.qres').forEach(e=>{e.classList.remove('active');e.style.display='';});
  document.getElementById('res-newsletter').style.display='none';
  document.getElementById('qs-dynamic').classList.add('active');
  ['com','content','fun','help','newsletter'].forEach(t=>{
    const inp = document.getElementById('email-'+t+'-input')||document.getElementById('email-nl-input');
    const thanks = document.getElementById('ec-thanks-'+t);
    const form = inp?inp.closest('.ec-form'):null;
    if(form)form.style.display='';if(thanks)thanks.style.display='none';if(inp)inp.value='';
    const btn2 = form ? form.querySelector('.ec-btn') : null;
    if(btn2){ btn2.disabled = false; if(btn2.dataset.origText) btn2.textContent = btn2.dataset.origText; }
  });
  renderStep('intent',1,4);
}

function showNewsletterFallback(btn){
  const parent = btn.closest('.email-capture');
  if(parent) parent.style.display='none';
  const nl = document.getElementById('res-newsletter');
  nl.style.display='flex'; nl.classList.add('active');
}

// ── EMAIL SUBMIT ──
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_QUEUE_KEY = 'mm_email_queue';

function _readEmailQueue(){
  try { return JSON.parse(localStorage.getItem(EMAIL_QUEUE_KEY) || '[]'); }
  catch(e){ return []; }
}
function _writeEmailQueue(q){
  try { localStorage.setItem(EMAIL_QUEUE_KEY, JSON.stringify(q)); } catch(e){}
}
function _sendEmailPayload(payload){
  return fetch(SCRIPT_URL, {
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body: JSON.stringify(payload),
    keepalive: true,
  }).then(r => { if(!r.ok) throw new Error('http_'+r.status); return r; });
}
function _flushEmailQueue(){
  const q = _readEmailQueue();
  if(!q.length) return;
  const remaining = [];
  let idx = 0;
  const next = () => {
    if(idx >= q.length){ _writeEmailQueue(remaining); return; }
    const item = q[idx++];
    _sendEmailPayload(item)
      .then(next)
      .catch(()=>{ remaining.push(item); next(); });
  };
  next();
}
// Retry any emails that failed on previous visits
try { _flushEmailQueue(); } catch(e){}

function submitEmail(type){
  const ids = {
    commercial:'email-commercial',
    content:'email-content-input',
    fun:'email-fun-input',
    help:'email-help-input',
    newsletter:'email-nl-input',
    above_fold:'email-above-fold-input',
  };
  const input = document.getElementById(ids[type]);
  if(!input) return;
  const val = input.value.trim();
  if(!val || !EMAIL_RE.test(val)){
    input.style.borderColor = '#ef4444';
    setTimeout(()=>input.style.borderColor='', 1500);
    return;
  }
  // Prevent double-submit
  const btn = input.closest('.ec-form') && input.closest('.ec-form').querySelector('.ec-btn');
  if(btn){
    if(btn.disabled) return;
    btn.disabled = true;
    btn.dataset.origText = btn.textContent;
    btn.textContent = 'Sending…';
  }

  const payload = {
    uid: window.MM_UID,
    variant: 'a',
    email: val,
    type: 'email_capture',
    button: type,
    referrer: document.referrer || '(direct)',
    userAgent: navigator.userAgent,
    screenWidth: screen.width,
    country: (window.MM_GEO && window.MM_GEO.country) || '',
    city:    (window.MM_GEO && window.MM_GEO.city)    || '',
    ts: new Date().toISOString(),
  };

  // Queue first, remove on success. Guarantees delivery across page navigations / offline.
  const queue = _readEmailQueue();
  queue.push(payload);
  _writeEmailQueue(queue);

  const showThanks = () => {
    const form = input.closest('.ec-form');
    const thanks = document.getElementById('ec-thanks-'+type);
    if(form) form.style.display = 'none';
    if(thanks) thanks.style.display = 'block';
  };

  _sendEmailPayload(payload)
    .then(() => {
      // Remove this payload from queue on success
      const q2 = _readEmailQueue().filter(p => !(p.email === payload.email && p.ts === payload.ts));
      _writeEmailQueue(q2);
      showThanks();
    })
    .catch(() => {
      // Leave queued for retry on next page load; still confirm to user
      showThanks();
    });
}

// ── MODALS ──
function openModal(id){ track('button_click',{button:'open_'+id}); document.getElementById('modal-'+id).classList.add('open'); document.body.style.overflow='hidden'; }
function closeModal(id){ track('button_click',{button:'close_'+id}); document.getElementById('modal-'+id).classList.remove('open'); document.body.style.overflow=''; }
document.querySelectorAll('.modal-overlay').forEach(el=>{el.addEventListener('click',e=>{if(e.target===el)closeModal(el.id.replace('modal-',''));});});

// ── COOKIES ──
function showCookieBanner(){ if(localStorage.getItem('cookie_consent')) return; setTimeout(()=>document.getElementById('cookie-banner').classList.add('visible'),800); }
function acceptCookies(){ document.getElementById('cookie-banner').classList.remove('visible'); localStorage.setItem('cookie_consent','accepted'); track('button_click',{button:'cookie_accept'}); }
function rejectCookies(){ document.getElementById('cookie-banner').classList.remove('visible'); localStorage.setItem('cookie_consent','rejected'); track('button_click',{button:'cookie_reject'}); }
showCookieBanner();

// ── SCROLL REVEAL ──
const obs = new IntersectionObserver(entries=>{
  entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('in'); obs.unobserve(e.target); } });
},{threshold:0.04,rootMargin:'0px 0px -10px 0px'});
document.querySelectorAll('.rv').forEach(el=>obs.observe(el));

// ── INIT ──
renderPicks();

// Lazy-init quiz: only render when quiz section scrolls into view
(function(){
  let quizInited = false;
  const quizEl = document.querySelector('.quiz-wrap');
  if(!quizEl){ renderStep('intent',1,4); return; }
  const quizObs = new IntersectionObserver(function(entries){
    if(entries[0].isIntersecting && !quizInited){
      quizInited = true;
      renderStep('intent',1,4);
      quizObs.disconnect();
    }
  },{rootMargin:'200px 0px'});
  quizObs.observe(quizEl);
})();

// ── DISCOUNT CODE POPUP (Cubee only) ──
function openDiscountPopup(code, url, productId){
  track('offer_click', {button: productId, href: url});
  document.getElementById('popup-code').textContent = code;
  document.getElementById('popup-link').href = url;
  const popup = document.getElementById('discount-popup');
  popup.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  document.getElementById('copy-btn').textContent = 'Copy';
}
function closeDiscountPopup(){
  track('button_click', {button:'discount_popup_close'});
  document.getElementById('discount-popup').style.display = 'none';
  document.body.style.overflow = '';
}
function copyCode(){
  const code = document.getElementById('popup-code').textContent;
  track('button_click', {button:'discount_code_copy', code});
  const done = () => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    btn.style.background = '#22c55e';
    setTimeout(()=>{ btn.textContent = 'Copy'; btn.style.background = 'var(--o)'; }, 2000);
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(code).then(done).catch(done);
  } else {
    const el = document.createElement('textarea');
    el.value = code;
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); } catch(e){}
    document.body.removeChild(el);
    done();
  }
}
document.addEventListener('DOMContentLoaded', function(){
  const dp = document.getElementById('discount-popup');
  if(dp) dp.addEventListener('click', function(e){ if(e.target===this) closeDiscountPopup(); });
});
