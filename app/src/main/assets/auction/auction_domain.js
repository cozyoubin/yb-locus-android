(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YBAuction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function normalizeCaseNumber(value) {
    const compact = String(value ?? '').normalize('NFKC').replace(/\s+/g, '');
    const match = /^(\d{4})타경(\d+)$/.exec(compact);
    if (!match) throw new TypeError('사건번호를 2025타경12345 형식으로 입력해 주세요.');
    return `${match[1]}타경${match[2]}`;
  }

  class AuctionCase {
    constructor(values) {
      const source = values || {};
      this.courtName = String(source.courtName || '');
      this.caseNumber = normalizeCaseNumber(source.caseNumber);
      this.address = String(source.address || '');
      this.propertyType = String(source.propertyType || '');
      this.appraisalPrice = Number(source.appraisalPrice);
      this.minimumBidPrice = Number(source.minimumBidPrice);
      this.areaM2 = Number(source.areaM2);
      this.auctionDate = String(source.auctionDate || '');
      this.latitude = source.latitude == null ? null : Number(source.latitude);
      this.longitude = source.longitude == null ? null : Number(source.longitude);
      Object.freeze(this);
    }
  }

  class AuctionRepository {
    async findByCaseNumber(_caseNumber) {
      throw new Error('AuctionRepository implementation is required.');
    }
  }

  class CommercialTransactionRepository {
    async findComparables(_auctionCase) {
      throw new Error('CommercialTransactionRepository implementation is required.');
    }
  }

  class PropertyComparisonGateway {
    async openComparisonRegion(_auctionCase) {
      throw new Error('PropertyComparisonGateway implementation is required.');
    }
  }

  class FakeAuctionRepository extends AuctionRepository {
    constructor(fixtures) {
      super();
      const defaults = [new AuctionCase({
        courtName: 'YB LOCUS 샘플 법원',
        caseNumber: '2025타경12345',
        address: '서울특별시 중구 세종대로 110',
        propertyType: '상가',
        appraisalPrice: 850000000,
        minimumBidPrice: 680000000,
        areaM2: 84.62,
        auctionDate: '2026-10-15',
        latitude: 37.5663,
        longitude: 126.9779
      })];
      this.cases = new Map((fixtures || defaults).map(item => {
        const auctionCase = item instanceof AuctionCase ? item : new AuctionCase(item);
        return [auctionCase.caseNumber, auctionCase];
      }));
    }

    async findByCaseNumber(caseNumber) {
      return this.cases.get(normalizeCaseNumber(caseNumber)) || null;
    }
  }

  class AuctionAnalysisCoordinator {
    constructor({auctionRepository, transactionRepository = null, comparisonGateway = null}) {
      if (!auctionRepository || typeof auctionRepository.findByCaseNumber !== 'function') {
        throw new TypeError('auctionRepository is required.');
      }
      this.auctionRepository = auctionRepository;
      this.transactionRepository = transactionRepository;
      this.comparisonGateway = comparisonGateway;
    }

    async lookup(caseNumber) {
      return this.auctionRepository.findByCaseNumber(normalizeCaseNumber(caseNumber));
    }

    async loadComparables(auctionCase) {
      if (!this.transactionRepository) throw new Error('실거래 데이터 소스가 연결되지 않았습니다.');
      return this.transactionRepository.findComparables(auctionCase);
    }

    async openComparisonRegion(auctionCase) {
      if (!this.comparisonGateway) throw new Error('지도 비교 연결이 준비되지 않았습니다.');
      return this.comparisonGateway.openComparisonRegion(auctionCase);
    }
  }

  return {
    normalizeCaseNumber,
    AuctionCase,
    AuctionRepository,
    CommercialTransactionRepository,
    PropertyComparisonGateway,
    FakeAuctionRepository,
    AuctionAnalysisCoordinator
  };
});
