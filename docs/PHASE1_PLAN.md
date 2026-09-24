# PHASE 1 구조 안정화 계획

상태: 계획만 작성, 구현 전. 신규 기능·계산 공식 변경·UI 전면 개편은 범위 밖이다.

## 목표 상태와 소유권

| 상태 | 보유 정보 | 변경 주체 |
| --- | --- | --- |
| StartupState | launchId, loading/applying/verifying/ready/error, 검증된 유형·거래·단위 | StartupController; Java는 검증된 ready 또는 오류를 표현 |
| MapState | center, zoom, region, filters, revision, 관찰 출처 | 네이버 지도 어댑터; 앱 분석 요청으로 갱신하지 않음 |
| ListingState | queryKey, rows, source, complete, requestId, loading/error | ListingRepository; DOM reference는 별도 view 매핑 |
| AnalysisState | inputSnapshot, status, requestId, listings/households/stores, error, cacheKey | 사용자 액션으로 시작한 AnalysisController |
| NavigationState | map/list/analysis/detail, returnSnapshot, 전이 ID | 네이티브/JS 계약으로 합의한 단일 navigation 소유자 |

MapState 변경은 분석을 시작하지 않는다. 이전 분석은 입력 위치와 함께 보존하고 현재 지도와 다르면 오래된 결과임을 표시한다. 편집 중 설정은 완료된 분석 결과에 소급 적용하지 않는다. 단위 변경 같은 표시 작업은 네트워크를 호출하지 않는다.

## 권장 작업 순서

### 0. 재현 가능한 개발·회귀 기준 준비

- 기존 정상 동작을 기기에서 확인하고 비밀 없는 DOM/API fixture와 시나리오를 확보한다.
- 선언된 AGP/Gradle/JDK/SDK 호환성을 확인한 뒤 Gradle Wrapper와 Windows `gradlew.bat`을 추가한다. 지금 선언을 근거 없이 업그레이드하지 않는다.
- fixture 기반 JS 계산/상태 전이 검증과 Android assembleDebug/lint를 CI에 연결한다. 외부 네이버 API를 CI 필수 조건으로 두지 않는다.
- 기본 필터, 평 단위, 지도 조작, 수동 필터 변경, TOP3, 복사/CSV, 네트워크 실패, 뒤로가기 기준을 먼저 기록한다.

### 1. 초기 랜딩 상태 단일화 — 첫 번째 제품 코드 수정

- Java/JS가 공유할 launchId와 `startupStatus` 계약을 먼저 정의한다.
- 분산된 ready 타이머를 한 lifecycle로 통합한다. 유형·거래·평 확인을 모두 만족할 때만 ready로 전이한다.
- timeout은 ready가 아닌 error로 전이하고 커버에서 재시도할 수 있게 한다. 잘못된 기본 화면을 보여주지 않는다.
- 분석 함수에서 초기 필터 적용 책임을 제거하고 ready 상태를 입력 조건으로 받는다.
- 최초 지도 진입, origin 리다이렉트, 공유/딥링크 상세 진입, Activity 재생성 정책을 구분한다. 상세 URL을 초기 필터 보정을 위해 임의로 소실시키지 않는다.
- 완료 기준: 느린 로딩/필터 요소 누락/404에서 주거 기본 화면이 한 프레임도 노출되지 않음. ready 이후 사용자의 필터·단위 변경을 다시 강제하지 않음.

### 2. 지도 상태와 분석 입력 분리

- 앱 API 요청을 관찰에서 구분하고 사용자 지도 이벤트만 MapState를 갱신한다.
- 분석 시작 시 좌표·지역·반경·유형·오피스텔 포함·계산 버전을 복사하여 고정한다.
- `openSheet`는 표시만 담당하고 명시적 사용자 분석 액션이 실행을 요청한다. 상단 분석 버튼을 최초 실행 액션으로 사용할 수 있지만 상세 복귀는 실행 액션이 아니다.
- 완료 기준: 지도 이동 10회에서 배후세대/투자분석 추가 요청 0회. 주변 9점 조회가 현재 지도 좌표를 바꾸지 않음. 분석 도중 반경 변경 시 기존 결과 해석 불변.

### 3. 매물 목록 상태 분리

- DOM 파싱·API 수집·통계 계산·주석 렌더링을 분리한다. observer는 앱 주석 변경을 제외한다.
- queryKey에 지역/필터를 포함하고 지역 전환 시 과거 captured/DOM fallback을 현재 결과로 사용하지 않는다.
- 매물 행은 articleNo 중심의 데이터 모델로 만들고 DOM node/scanId는 별도 표시 계층에서 관리한다.
- `refreshListingsOnly`도 requestId/queryKey 검사 후 반영한다. 분석은 시작 시 또는 같은 분석 작업으로 수집한 목록 스냅샷만 사용한다.
- 완료 기준: 지역 A→B 이동 후 A 매물 0건 혼입; 패널 닫기로 API 전체 목록이 DOM 일부 목록으로 교체되지 않음; TOP3·CSV·통계가 같은 표본 사용.

### 4. 배후세대 요청 lifecycle 정리

- idle/loading/success/error/cancelled와 활성 작업 하나를 명시한다. 같은 key 반복 실행은 진행 중 Promise를 공유한다.
- 다른 key 요청은 기존 작업을 취소하고 종료를 확인하거나, 종료 후 최신 요청 하나만 실행한다. 초기에는 하위 단지 HTTP도 직렬화해 동시 요청 1개 규칙을 명확하게 만족시킨다.
- 웹 fetch는 AbortController와 timeout, native 브리지는 requestId 기반 비동기 응답·취소 계약을 설계한다. 현재 동기 httpGet에 취소된 척하는 UI만 추가하지 않는다.
- 모든 await 뒤 상태 쓰기 전에 requestId 검사. 작업 종료/페이지 이동/Activity 종료 시 타이머·연결·observer 정리 정책을 정의한다.
- 지역 분석 캐시 key: 좌표 정규화 정책+반경+주거유형+지역/필터+데이터/계산 버전. 물건 분석 캐시 key: articleNo+입력 fingerprint+계산 버전. 숫자 결과와 설명은 분리한다.
- TTL·최대 항목 수·명시적 새로고침 정책을 정한다. 0건·부분실패·취소는 정상 완전결과와 구별하고 API 키/쿠키를 캐시에 넣지 않는다.
- 완료 기준: 연타·재열기·뒤로가기 중 활성 배후세대 작업 및 HTTP 각각 최대 1개. 오래된 결과/오류/진행 문구가 새 작업 상태를 덮어쓰지 않음.

### 5. 뒤로가기 상태 관리

- TOP3/일반 목록/외부 딥링크 상세 진입을 구분하고 이동 전에 지도·목록·분석 key·스크롤 위치를 스냅샷으로 저장한다.
- JS/native 중복 flag 대신 전이 ID를 한번 소비하고 양쪽에 완료를 통지한다.
- 패널 닫기 → 상세에서 이전 YB 상태 복원 → 목록 접기 → 지도/history → 최상위 종료 순서를 상태 전이로 검증한다.
- 상세 복귀 시 캐시/기존 분석 상태를 보여주며 새 분석은 실행하지 않는다. native 시트 스와이프는 성공 여부를 확인한다.
- Activity 재생성에서 WebView save/restore와 YB 상태 복원을 함께 설계한다.
- 완료 기준: API 26~32 및 33+ 뒤로가기 경로, 연속 뒤로가기, history 없는 딥링크, TOP3 왕복에서 의도치 않은 종료·재분석·복귀 반복 없음.

## 수정할 기존 파일

| 파일 | PHASE 1 변경 내용 |
| --- | --- |
| `app/src/main/java/com/yblocus/app/MainActivity.java` | startup 계약, 자산 주입 순서, navigation/복원, 브리지 lifecycle |
| `app/src/main/assets/investment_mobile.js` | 상태 소유권 분리, open/execute 분리, observer 격리, 목록·분석 요청 조율 |
| `app/src/main/assets/bridge.js` | requestId/비동기 응답/취소, startup/navigation 계약 |
| `app/src/main/assets/investment_mobile.css` | 필요한 경우 초기 실패·오래된 결과·조회 상태 표현만 조정; 기존 스크롤 보존 |
| `build_apk.sh`, `README.md` | Wrapper 기반 빌드 및 자동 검증 사용법 |
| `docs/ARCHITECTURE.md`, `docs/PHASE1_PLAN.md` | 구현 후 실제 상태와 검증 결과 갱신 |

`app/build.gradle`, 루트 `build.gradle`, `gradle.properties`, Manifest는 테스트/빌드 호환성 또는 lifecycle 설정상 필요가 확인된 경우에만 변경한다. `config.json`을 새 상태 저장소로 사용하지 않는다.

## 단계적으로 추가할 파일 후보

아래는 제안이며 이번 작업에서 생성한 런타임 모듈이 아니다. 한 번에 모두 추출하지 않고 동작 보존 단위로 추가한다.

- `app/src/main/assets/locus/{state,startup,naver-adapter,listings,analysis,households,navigation,calculations}.js`
- `app/src/main/java/com/yblocus/app/{StartupController,NavigationController,NativeHttpClient}.java`
- `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.{jar,properties}`
- `tests/fixtures/`, `tests/`의 상태 전이·계산 회귀 테스트, `scripts/verify.ps1`, `.github/workflows/verify.yml` (GitHub 사용 시)

현재는 evaluateJavascript로 순서대로 주입한다. 새 JS 파일을 단순 ES module import로 바꾸지 말고 공유 namespace 또는 번들링을 선택하여 의존 순서·중복 주입 방지·navigation 재주입을 검증한다.

## 자동 검증과 실기기 회귀 기준

| 검증 | 핵심 시나리오 |
| --- | --- |
| 계산 fixture | 만원/억 파싱, 전용 평/㎡·생략 단위, 빈 표본/0/NaN, 중앙값·절사평균·TOP3·수익률의 기존 결과 |
| startup 상태 전이 | 성공, 지연, timeout, 중복 ready, origin 변경, 사용자 선택 보존 |
| 지도/목록 분리 | 지도 revision, 자체 API 관찰 제외, 지역별 목록 분리, observer 자가 반복 없음 |
| 요청 lifecycle | 빠른 연타, 취소 후 지연 응답, 실패·부분성공, 같은 key 중복 제거, key/TTL 무효화 |
| navigation | 분석→TOP3→뒤로가기, 일반 상세·딥링크→뒤로가기, JS/native 이벤트 중복, Activity 재생성 |
| 실제 기기 | 로딩 중 화면 녹화, 네이버 필터·목록·지도 조작, 스크롤/위치 권한, API 33 전후, 복사/CSV |
| 빌드/보안 | Wrapper assembleDebug/lint, JS 구문검사, 비밀 스캔·staged diff 점검 |

각 단계는 해당 회귀 기준 통과 후 다음 단계로 이동한다. 네이버 DOM/API가 변경되면 어댑터 fixture를 갱신하고 계산/상태 계층까지 함께 수정하지 않는다.
