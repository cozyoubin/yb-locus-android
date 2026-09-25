// No network or Android dependency. Exercise the production landing functions in a mocked WebView.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/investment_mobile.js'), 'utf8');
const mainActivitySource = fs.readFileSync(
  path.join(__dirname, '../app/src/main/java/com/yblocus/app/MainActivity.java'), 'utf8');

function harness(options = {}) {
  const state = {native: 'PAGE_LOADING', pageId: 1, attempts: 0, clicks: 0, applies: 0,
    property: '상가, 사무실', trade: '매매, 월세', unit: '㎡', sheet: false,
    transitions: [], delays: [], ...options.initial};
  const control = (unit = state.unit, rect = {left: 320, top: 250, bottom: 290, right: 360, width: 40, height: 40}) => ({
    textContent: unit, closest: () => null, contains: () => false,
    getBoundingClientRect: () => rect,
    click: () => {state.clicks++; if (!options.ignoreUnitClick) state.unit = '㎡';}});
  const summary = (text, rect) => ({textContent: text, closest: () => null,
    getBoundingClientRect: () => rect});
  const visibleSummaries = () => [
    summary(state.trade, {left: 20, top: 90, bottom: 130, right: 140, width: 120, height: 40}),
    summary(state.property, {left: 150, top: 90, bottom: 130, right: 300, width: 150, height: 40})
  ];
  const unitControls = () => {
    if (state.unit === null) return [];
    if (options.unitControls) return options.unitControls.map(c => control(c.unit, c.rect));
    if (options.ambiguousUnit) return [
      control(state.unit, {left: 250, top: 250, bottom: 290, right: 290, width: 40, height: 40}),
      control(state.unit, {left: 340, top: 250, bottom: 290, right: 380, width: 40, height: 40})
    ];
    return [control()];
  };
  const sheet = () => ({getBoundingClientRect: () => options.sheetRect ||
    {left: 0, top: 80, right: 400, bottom: 760, width: 400, height: 680}});
  const active = id => id === state.pageId && !['READY', 'FAILED'].includes(state.native);
  const context = vm.createContext({
    window: {__SANGA_BRIDGE_TOKEN__: 'test', __YBLOCUS_LANDING_PAGE__: 1},
    location: {hostname: 'new.land.naver.com', href: 'https://new.land.naver.com/offices'},
    document: {readyState: 'loading', documentElement: {}, addEventListener() {},
      querySelectorAll: selector => {
        if (selector === 'button,a,[role="button"]') return options.unitAsTextElement ? [] : unitControls();
        if (selector === 'div,span') return options.unitAsTextElement ? unitControls() : [];
        if (selector === 'button,[role="button"],a,div,span,p,strong') {
          return options.visibleSummaryFallback ? visibleSummaries() : [];
        }
        return [];
      }, elementFromPoint: () => null},
    innerWidth: 400, innerHeight: 800,
    getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    MutationObserver: class {observe() {}},
    sessionStorage: {setItem() {}},
    setTimeout: (fn, ms) => {
      state.delays.push(ms);
      options.onDelay?.(ms, state);
      queueMicrotask(fn);
      return 1;
    },
    SangaNative: {
      isLandingActive: (_, id) => active(id),
      beginLandingAttempt: (_, id) => {
        if (!active(id)) return false;
        if (state.attempts >= 3) {state.native = 'FAILED'; return false;}
        state.attempts++;
        state.native = 'APPLYING_DEFAULTS';
        state.transitions.push(state.native);
        return true;
      },
      updateLandingState: (_, id, next) => {
        if (!active(id)) return false;
        if (next === 'READY' && state.native !== 'VERIFYING_DEFAULTS') return false;
        state.native = next;
        state.transitions.push(next);
        return true;
      }
    }
  });
  // Keep production verification, unit detection, retry orchestration and guards;
  // replace only external filter DOM interactions with deterministic fixture adapters.
  const hooks = `
    window.testLanding = {runInitialLanding, verifyLandingDefaults, ensureNaverPyeongDefault,
      normalizeAreaUnitLabel, naverUnitControl, landingVerificationResult,
      configure(readChip, readSheet, applyFilter){
        topChipByLabels = labels => ({textContent: ${options.primarySummaryBroken ? "'필터 전체 문구'" : "readChip(labels === PROPERTY_LABELS ? 'property' : 'trade')"}});
        findSheetByHeading = () => readSheet();
        enforceFilterSelection = applyFilter;
        autoCollapseAccidentalSingleListing = () => false;
      }};
  `;
  const end = source.lastIndexOf('})();');
  vm.runInContext(source.slice(0, end) + hooks + source.slice(end), context);
  const api = context.window.testLanding;
  api.configure(kind => state[kind], () => state.sheet ? sheet() : null, async kind => {
    state.applies++;
    options.onApply?.(kind, state);
    return true;
  });
  return {state, api};
}

test('only confirmed property + trade + pyeong reaches READY after two observations', async () => {
  const {state, api} = harness({initial: {unit: '평'}});
  await api.runInitialLanding();
  assert.equal(state.native, 'READY');
  assert.equal(state.attempts, 1);
  assert.equal(state.clicks, 1);
  assert.deepEqual(state.transitions, ['APPLYING_DEFAULTS', 'VERIFYING_DEFAULTS', 'READY']);
  assert.deepEqual(state.delays, [250, 350, 350]);
});

for (const label of ['㎡', 'm²', 'm2', 'm ^ 2']) {
  test(`unit switch label ${JSON.stringify(label)} means the current screen is pyeong`, async () => {
    const {state, api} = harness({initial: {unit: label}});
    assert.equal(api.normalizeAreaUnitLabel(label), 'SQM');
    await api.runInitialLanding();
    assert.equal(state.native, 'READY');
    assert.equal(state.clicks, 0);
  });
}

test('pyeong switch label is clicked and an SQM-family label then verifies READY', async () => {
  const {state, api} = harness({
    initial: {unit: '평'},
    onDelay(ms, state) {
      if (ms === 350 && state.clicks === 1) state.unit = 'm²';
    }
  });
  await api.runInitialLanding();
  assert.equal(state.native, 'READY');
  assert.equal(state.clicks, 1);
});

test('visible top summaries and right-side m² text fallback reach READY without FAILED', async () => {
  const {state, api} = harness({
    initial: {property: '상가, 사무실', trade: '매매, 월세', unit: 'm²'},
    primarySummaryBroken: true,
    visibleSummaryFallback: true,
    unitAsTextElement: true
  });
  const result = api.landingVerificationResult();
  assert.deepEqual({...result}, {
    propertyOk: true, tradeOk: true, unitOk: true, sheetsClosed: true, ready: true
  });
  await api.runInitialLanding();
  assert.equal(state.native, 'READY');
  assert.ok(!state.transitions.includes('FAILED'));
});

for (const [field, value, failedKey] of [
  ['property', '아파트, 재건축', 'propertyOk'],
  ['trade', '매매, 전세', 'tradeOk'],
  ['unit', '평', 'unitOk']
]) {
  test(`visible verification rejects incorrect ${field}`, () => {
    const {api} = harness({
      initial: {property: '상가, 사무실', trade: '매매, 월세', unit: 'm²', [field]: value},
      primarySummaryBroken: true,
      visibleSummaryFallback: true,
      unitAsTextElement: true,
      ignoreUnitClick: true
    });
    const result = api.landingVerificationResult();
    assert.equal(result[failedKey], false);
    assert.equal(result.ready, false);
  });
}

test('sheet DOM fully outside the horizontal viewport is treated as closed for READY', () => {
  const {api} = harness({
    initial: {sheet: true},
    sheetRect: {left: 420, top: 80, right: 820, bottom: 760, width: 400, height: 680}
  });
  const result = api.landingVerificationResult();
  assert.equal(result.sheetsClosed, true);
  assert.equal(result.ready, true);
});

test('open filter sheet inside the viewport prevents READY', () => {
  const {api} = harness({initial: {sheet: true}});
  const result = api.landingVerificationResult();
  assert.equal(result.sheetsClosed, false);
  assert.equal(result.ready, false);
});

for (const initial of [
  {property: '아파트, 재건축'}, {trade: '매매, 전세'},
  {property: '상가, 사무실, 아파트'}, {trade: '매매, 월세, 전세'},
  {unit: null}, {sheet: true}
]) {
  test('unverified screen stays covered and exhausts exactly three attempts: ' + JSON.stringify(initial), async () => {
    const {state, api} = harness({initial});
    await api.runInitialLanding();
    assert.equal(state.native, 'FAILED');
    assert.equal(state.attempts, 3);
    assert.equal(state.delays.filter(ms => ms === 1000).length, 2);
    assert.ok(!state.transitions.includes('READY'));
    await api.runInitialLanding();
    assert.equal(state.attempts, 3);
  });
}

test('click that did not change the unit is not success', async () => {
  const {state, api} = harness({initial: {unit: '평'}, ignoreUnitClick: true});
  await api.runInitialLanding();
  assert.equal(state.native, 'FAILED');
  assert.equal(state.clicks, 3);
});

test('multiple constrained unit controls choose the strongest right-side candidate', async () => {
  const {state, api} = harness({ambiguousUnit: true});
  await api.runInitialLanding();
  assert.equal(state.native, 'READY');
  assert.equal(state.clicks, 0);
});

test('terminal FAILED reveals WebView and analyzer without pretending to be READY', () => {
  const failedBranch = mainActivitySource.match(
    /else if \(landingState == LandingState\.FAILED\) \{([\s\S]*?)\n\s*\}/)?.[1] || '';
  assert.match(failedBranch, /startupCover\.setVisibility\(View\.GONE\)/);
  assert.match(failedBranch, /webView\.setImportantForAccessibility\(View\.IMPORTANT_FOR_ACCESSIBILITY_AUTO\)/);
  assert.match(failedBranch, /analyzerButton\.setEnabled\(true\)/);
  assert.match(failedBranch, /기본 필터 자동설정을 완료하지 못했습니다\. 상단 필터를 확인해 주세요\./);
  assert.doesNotMatch(failedBranch, /landingState\s*=\s*LandingState\.READY/);
});

test('transient valid summary is rejected by the second verification', async () => {
  let observations = 0;
  const {state, api} = harness({onDelay(ms, state) {
    if (ms === 350 && ++observations === 2) state.trade = '매매, 전세';
  }});
  await api.runInitialLanding();
  assert.equal(state.native, 'FAILED');
});

test('READY preserves subsequent user choices and never initializes again', async () => {
  const {state, api} = harness();
  await api.runInitialLanding();
  state.property = '아파트'; state.trade = '전세'; state.unit = '평';
  await api.runInitialLanding();
  assert.equal(api.ensureNaverPyeongDefault(), false);
  assert.equal(state.native, 'READY');
  assert.equal(state.attempts, 1);
  assert.equal(state.clicks, 0);
});

test('new document injected after READY cannot restart landing', async () => {
  const {state, api} = harness({initial: {native: 'READY', unit: '평'}});
  await api.runInitialLanding();
  assert.equal(state.attempts, 0);
  assert.equal(state.clicks, 0);
});

test('native deadline failure prevents late success and further actions', async () => {
  const {state, api} = harness({onDelay(ms, state) {
    if (ms === 350) state.native = 'FAILED';
  }});
  await api.runInitialLanding();
  assert.equal(state.native, 'FAILED');
  assert.equal(state.attempts, 1);
  assert.ok(!state.transitions.includes('READY'));
});

test('navigation invalidates the old document before it can reveal the cover', async () => {
  const {state, api} = harness({onDelay(ms, state) {
    if (ms === 350) {state.pageId++; state.native = 'PAGE_LOADING';}
  }});
  await api.runInitialLanding();
  assert.equal(state.native, 'PAGE_LOADING');
  assert.equal(state.attempts, 1);
  assert.ok(!state.transitions.includes('READY'));
});

test('redirects share the native attempt budget', async () => {
  const {state, api} = harness({initial: {attempts: 2, unit: null}});
  await api.runInitialLanding();
  assert.equal(state.native, 'FAILED');
  assert.equal(state.attempts, 3);
});

test('adapter exceptions consume the same bounded retry budget', async () => {
  const {state, api} = harness({onApply() {throw new Error('DOM unavailable');}});
  await api.runInitialLanding();
  assert.equal(state.native, 'FAILED');
  assert.equal(state.attempts, 3);
});

test('concurrent entry calls share a single landing run', async () => {
  const {state, api} = harness();
  await Promise.all([api.runInitialLanding(), api.runInitialLanding(), api.runInitialLanding()]);
  assert.equal(state.native, 'READY');
  assert.equal(state.attempts, 1);
  assert.equal(state.applies, 2);
});

test('a newly injected document cannot retry a terminal FAILED landing', async () => {
  const {state, api} = harness({initial: {native: 'FAILED', unit: '평'}});
  await api.runInitialLanding();
  assert.equal(api.ensureNaverPyeongDefault(), false);
  assert.equal(state.attempts, 0);
  assert.equal(state.clicks, 0);
});

test('non-default filters must be changed before the verified unit can reveal the page', async () => {
  const {state, api} = harness({
    initial: {property: '아파트, 재건축', trade: '매매, 전세', unit: '평'},
    onApply(kind, state) {
      state[kind] = kind === 'property' ? '상가, 사무실' : '매매, 월세';
    }
  });
  await api.runInitialLanding();
  assert.equal(state.native, 'READY');
  assert.equal(state.applies, 2);
  assert.equal(state.clicks, 1);
});
