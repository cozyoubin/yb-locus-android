# 경매분석 Phase 1 기반

## 범위

경매분석은 기존 네이버 부동산 WebView와 분리된 `AuctionAnalysisActivity`에서 로컬 자산으로 실행한다. 현재 단계는 사건번호 입력, Fake Repository 조회, 결과 표시까지만 제공한다. 법원 사이트 크롤링, 외부 API 호출, 네이버 매물 저장은 포함하지 않는다.

## 계층과 교체 지점

- `AuctionCase`: 법원명, 사건번호, 주소, 물건종류, 감정가, 최저매각가, 면적, 매각기일, 좌표를 담는 불변 모델
- `AuctionRepository`: 허가된 법원·경매 데이터 공급자 교체 지점
- `FakeAuctionRepository`: 네트워크 없이 UI와 흐름을 검증하는 현재 구현
- `CommercialTransactionRepository`: 국토교통부 상업·업무용 실거래 비교 공급자 교체 지점
- `PropertyComparisonGateway`: 좌표를 기존 네이버 지도 비교 화면으로 전달하는 연결 지점
- `AuctionAnalysisCoordinator`: 각 공급자를 주입받아 사건 조회, 실거래 조회, 지도 이동을 순서대로 조율할 경계

## 다음 연결 순서

1. 허가된 경매 데이터 공급자를 `AuctionRepository` 구현으로 추가한다.
2. 주소에 좌표가 없을 때 사용할 지오코딩 공급자를 별도 인터페이스로 추가한다.
3. `CommercialTransactionRepository`에 국토교통부 상업·업무용 실거래 API 구현을 연결한다.
4. `PropertyComparisonGateway`를 통해 기존 네이버 화면에 좌표와 비교 범위만 전달한다.
5. 동일 사건번호와 입력 조건을 key로 분석 결과를 캐시하고 기존 결정론적 계산 계층에 연결한다.

인증정보는 소스나 asset에 두지 않는다. 실제 공급자 연결 시 GitHub Secrets와 빌드 시 주입 또는 서버 측 중계 방식을 사용한다.
