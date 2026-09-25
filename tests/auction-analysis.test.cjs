const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const domain = require('../app/src/main/assets/auction/auction_domain.js');

test('normalizes a supported Korean court case number', () => {
  assert.equal(domain.normalizeCaseNumber(' 2025 타경 12345 '), '2025타경12345');
});

test('rejects unsupported or incomplete case numbers', () => {
  for (const value of ['', '2025-12345', '타경12345', '2025타경']) {
    assert.throws(() => domain.normalizeCaseNumber(value), /2025타경12345/);
  }
});

test('auction model keeps the Phase 1 fields', () => {
  const item = new domain.AuctionCase({
    courtName: '서울중앙지방법원', caseNumber: '2025타경12345', address: '서울시 중구',
    propertyType: '상가', appraisalPrice: 100000000, minimumBidPrice: 80000000,
    areaM2: 42.5, auctionDate: '2026-10-15', latitude: 37.5, longitude: 127.0
  });
  assert.deepEqual(Object.keys(item), [
    'courtName', 'caseNumber', 'address', 'propertyType', 'appraisalPrice',
    'minimumBidPrice', 'areaM2', 'auctionDate', 'latitude', 'longitude'
  ]);
  assert.equal(item.caseNumber, '2025타경12345');
  assert.equal(Object.isFrozen(item), true);
});

test('fake repository returns deterministic data without external access', async () => {
  const repository = new domain.FakeAuctionRepository();
  const found = await repository.findByCaseNumber('2025타경12345');
  assert.ok(found instanceof domain.AuctionCase);
  assert.equal(found.propertyType, '상가');
  assert.equal(await repository.findByCaseNumber('2025타경99999'), null);
});

test('coordinator depends on replaceable auction repository', async () => {
  const calls = [];
  const expected = {caseNumber: '2025타경777'};
  const coordinator = new domain.AuctionAnalysisCoordinator({
    auctionRepository: {async findByCaseNumber(value) { calls.push(value); return expected; }}
  });
  assert.equal(await coordinator.lookup('2025 타경 777'), expected);
  assert.deepEqual(calls, ['2025타경777']);
});

test('future transaction and map sources remain optional and isolated', async () => {
  const coordinator = new domain.AuctionAnalysisCoordinator({
    auctionRepository: new domain.FakeAuctionRepository()
  });
  const item = await coordinator.lookup('2025타경12345');
  await assert.rejects(() => coordinator.loadComparables(item), /연결되지 않았습니다/);
  await assert.rejects(() => coordinator.openComparisonRegion(item), /준비되지 않았습니다/);
});

test('auction screen contains input, lookup action, and result region', () => {
  const html = fs.readFileSync(path.join(__dirname,
    '../app/src/main/assets/auction/auction.html'), 'utf8');
  assert.match(html, /id="case-number"/);
  assert.match(html, /type="submit">조회</);
  assert.match(html, /id="lookup-result"/);
});

test('Android entry point stays isolated from the existing Naver bridge', () => {
  const root = path.join(__dirname, '..');
  const manifest = fs.readFileSync(path.join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  const mainActivity = fs.readFileSync(path.join(root,
    'app/src/main/java/com/yblocus/app/MainActivity.java'), 'utf8');
  const auctionActivity = fs.readFileSync(path.join(root,
    'app/src/main/java/com/yblocus/app/AuctionAnalysisActivity.java'), 'utf8');
  assert.match(manifest, /android:name="\.AuctionAnalysisActivity"/);
  assert.match(mainActivity, /new Intent\(MainActivity\.this, AuctionAnalysisActivity\.class\)/);
  assert.match(auctionActivity, /setBlockNetworkLoads\(true\)/);
  assert.doesNotMatch(auctionActivity, /addJavascriptInterface/);
});
