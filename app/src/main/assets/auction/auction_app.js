(() => {
  'use strict';

  const {
    FakeAuctionRepository,
    AuctionAnalysisCoordinator,
    normalizeCaseNumber
  } = window.YBAuction;
  const coordinator = new AuctionAnalysisCoordinator({
    auctionRepository: new FakeAuctionRepository()
  });

  const form = document.getElementById('auction-form');
  const input = document.getElementById('case-number');
  const status = document.getElementById('lookup-status');
  const result = document.getElementById('lookup-result');

  function formatWon(value) {
    return `${Number(value).toLocaleString('ko-KR')}원`;
  }

  function resultRow(label, value) {
    const row = document.createElement('div');
    row.className = 'result-row';
    const key = document.createElement('dt');
    key.textContent = label;
    const content = document.createElement('dd');
    content.textContent = value;
    row.append(key, content);
    return row;
  }

  function renderAuctionCase(item) {
    const list = document.createElement('dl');
    list.className = 'result-list';
    list.append(
      resultRow('법원', item.courtName),
      resultRow('사건번호', item.caseNumber),
      resultRow('주소', item.address),
      resultRow('물건종류', item.propertyType),
      resultRow('감정가', formatWon(item.appraisalPrice)),
      resultRow('최저매각가', formatWon(item.minimumBidPrice)),
      resultRow('면적', `${item.areaM2.toLocaleString('ko-KR')}㎡`),
      resultRow('매각기일', item.auctionDate),
      resultRow('좌표', `${item.latitude}, ${item.longitude}`)
    );
    result.replaceChildren(list);
    result.hidden = false;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    result.hidden = true;
    result.replaceChildren();
    try {
      const caseNumber = normalizeCaseNumber(input.value);
      input.value = caseNumber;
      status.textContent = '샘플 저장소에서 조회 중입니다.';
      const item = await coordinator.lookup(caseNumber);
      if (!item) {
        status.textContent = '현재 샘플 데이터에는 해당 사건이 없습니다.';
        return;
      }
      renderAuctionCase(item);
      status.textContent = 'Fake Repository 결과입니다. 외부 API는 연결되지 않았습니다.';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '사건번호를 확인해 주세요.';
    }
  });
})();
