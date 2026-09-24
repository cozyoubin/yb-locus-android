# YB LOCUS v2.8 현재 구조 분석

작성일: 2026-09-25. 제공된 프로젝트의 전체 텍스트 소스를 정적으로 검토했다. 외부 네이버 서비스의 현재 동작이나 실기기 동작을 검증한 문서는 아니다. 아래 줄 번호는 이번 분석 시점의 원본 기준이다.

## 프로젝트 구성

단일 `app` 모듈, Java `Activity` 하나와 WebView에 주입하는 JavaScript로 구성된 하이브리드 앱이다. 네이티브 지도/별도 분석 Activity/MVVM 계층은 없다.

| 파일 | 책임 |
| --- | --- |
| `settings.gradle` | 저장소와 `:app` 모듈 선언 |
| `build.gradle` | Android Gradle Plugin 9.4.0 선언 |
| `app/build.gradle` | SDK 36, minSdk 26, Java 17, versionCode 28/versionName 2.8.0; debug/release 난독화 비활성 |
| `gradle.properties` | Gradle JVM 메모리·인코딩, AndroidX 비사용 |
| `build_apk.sh` | 시스템 `gradle :app:assembleDebug` 실행; 안내문에 Gradle 9.6 기재 |
| `app/src/main/AndroidManifest.xml` | 인터넷·위치 권한, 공유/네이버 URL 진입, Android 뒤로가기 콜백 활성화 |
| `app/src/main/java/com/yblocus/app/MainActivity.java` | 앱 상단 바, 시작 커버, WebView, 자산 주입, 브리지, HTTP, 저장, 뒤로가기 모두 담당 |
| `app/src/main/assets/bridge.js` | `chrome.runtime`/`chrome.storage` 호환 계층 → `SangaNative` 호출 |
| `app/src/main/assets/investment_mobile.js` | 초기 필터, 지도 추정, 매물 수집, 계산, 분석 UI, TOP3, 요청 조율을 단일 IIFE에 구현 |
| `app/src/main/assets/investment_mobile.css` | 분석 시트·스크롤·단위 주석 스타일; 여러 버전 override 누적 |
| `app/src/main/assets/config.json` | 공개 설정값; 브리지가 제공할 수 있으나 현재 분석 JS에 직접 사용 경로 없음 |
| `app/src/main/res/xml/network_security_config.xml` | 평문 HTTP 차단 |
| `app/src/main/res/values/{strings,colors}.xml` | 앱 이름, 색상 |
| `app/src/main/res/drawable/app_icon.png` | 런처 이미지 자산 |
| `README.md` | v2.8 변경 의도 요약 |

Gradle Wrapper, 테스트 디렉터리, CI 설정, dependency lock은 제공되지 않았다. 현재 폴더는 `.git`이 없는 소스 폴더로 `git status`가 실패한다. PATH에서 Java/Gradle을 찾지 못했다. 버전 호환성은 선언만 기록했으며 빌드로 확인하지 않았다.

## 기능별 파일·함수 지도

아래 JS는 `app/src/main/assets/investment_mobile.js`, Java는 `app/src/main/java/com/yblocus/app/MainActivity.java`를 뜻한다.

| 기능 | 파일·위치 | 실제 흐름 |
| --- | --- | --- |
| WebView 및 네이버부동산 로딩 | Java `onCreate` L71, `configureWebView` L213, `resolveStartUrl` L352, `onPageFinished` L266, `injectAnalyzer` L314 | HOME URL 또는 공유/딥링크 로딩 → 페이지 완료 후 token/viewport/bridge/CSS/분석 JS 주입. 404 문구 감지 시 HOME_FALLBACK 한 번 로딩 |
| 초기 필터 | Java HOME L53, 커버 L140 부근, `revealStartup` L200; JS `enforceFilterSelection` L308, `forceInitialFilterDefaults` L418, `scheduleInitialFilterDefaults` L462, `ensureNaverPyeongDefault` L114 | DOM 요약칩으로 유형·거래 판정, 필터 시트 토글, origin별 sessionStorage에 실행 token 저장, 단위 버튼 클릭 후 native 준비 신호 |
| 지도 상태 | JS `installCenterProbe` L1154, `rememberCenterFromUrl` L1117, `getCenter` L1244, `observedCortar` L1226, `MutationObserver` L2101 | fetch/XHR·Performance·URL·DOM에서 좌표/지역코드 추정; `lastObservedCenter`, `lastCenterSignature`에 저장. 명시적인 MapState 없음 |
| 매물 수집 | JS `scanListings` L809, `legacyListingRows` L718, `genericListingRows` L741, `articleRow` L831, `captureNaverPayload` L1137, `fetchListingsFromApi` L953 | DOM 파싱 또는 관찰한 API 템플릿/지역코드 기반 페이지 조회. SG:SMS 및 A1:B2 강제, 필요시 A1/B2 보완. 거래별 최대 300페이지 |
| 시세·숫자 계산 | JS `statPack` L537, `summarizeRows` L682, `deriveScore` L1543, `inferredGrossYield` L1563, `investmentCalc` L1810 | 만원·평 기준 평균/중앙값/양끝 10% 절사평균/분위수; 수급 점수와 수익률 계산. AI 호출 없음 |
| 배후세대 조회 | JS `getHouseholds` L1480 → `getCortarsAround` L1426 → `getComplexMarkers` L1407 / `getComplexesByRegion` L1419 → `enrichComplex` L1463 | 관찰 코드+중심 및 주변 9점+화면 지역명 후보 수집. APT/선택 OPST 단지 중 거리 반경 내 세대수 합산; 부족한 상세는 최대 90개, 8개씩 병렬 보강 |
| 분석 화면 | JS `mount` L1573, `bindPanel` L1727, `openSheet` L1676, `render` L1876, `refreshAll` L1964; Java 상단 분석 버튼 | WebView DOM 패널. 열기마다 80ms 뒤 전체 분석. 지역 분석 버튼도 전체 분석. 닫기는 표시만 변경 |
| 저가매물 TOP3 | JS `summarizeRows` L682, `activeTradeKind` L1859, `render` L1905 부근, `bindPanel`의 `focusListing` L1739 부근 | 매매/월세별 평당단가 오름차순 3개; 할인율은 중앙값 대비 참고값. 화면 거래유형 감지 후 표시. articleNo면 상세 이동, DOM 매물이면 스크롤·강조 |
| Android 뒤로가기 | Java API 33+ 등록 L193, `onBackPressed` L408, `handleBackNavigation` L417, `collapseNaverBottomSheet` L465; JS `YBLOCUS_HANDLE_BACK` L1703 | JS 패널 닫기/복귀 → native 분석 복귀 flag → 매물 시트 접기 → WebView history → finish |

투자 계산 함수는 존재하지만 현재 `mount()` HTML에는 `[data-calc]` 계산기 입력 UI가 없다. 함수 존재를 화면 기능 활성화로 해석하지 않는다. `ensureObservedArticleTemplate()`도 정의되어 있으나 현재 수집 경로는 호출하지 않는다. 분석 때문에 매물 목록을 자동으로 여는 오래된 함수의 설명과 실제 v2.7+ 경로를 구별해야 한다.

## 현재 데이터·이벤트 흐름

```text
Intent → MainActivity/WebView → 네이버 페이지
                           └→ bridge.js → investment_mobile.js
네이버 fetch/XHR → 좌표·인증헤더·매물 관찰 → 공유 전역 변수
네이버 DOM 변화 → 700ms debounce → scanListings → latest.listings → render
분석 버튼/복귀 → openSheet → refreshAll
지역 분석 버튼 ────────────→ refreshAll
refreshAll → 초기 필터 재확인 → DOM 목록 → 매물 API + 배후세대 조회
                                         → 영업점 조회 → latest → render
JS externalFetch → chrome.runtime.sendMessage → SangaNative.httpGet
                 → HttpURLConnection (쿠키, 필요시 인증 재시도)
설정 저장 → chrome.storage.local → SharedPreferences(yb_locus/js_storage)
```

`settings`는 편집 중 설정과 계산 입력을 겸하고, `latest`는 목록·배후세대·영업점 결과를 함께 보유한다. `capturedArticleMap`은 페이지 수명 동안 누적되고 지역별 key/TTL이 없다. `lastGoodDomListings`에도 지역 식별자가 없다. `regionListCache`는 지역 목록 캐시일 뿐 분석결과 캐시는 아니다. DOM node를 매물 행에 보유하므로 그대로 영속 캐시하기 어렵다.

v2.8 observer는 지도 이동만으로 `refreshAll`을 호출하지 않는다. 이 개선은 보존해야 한다. 그러나 지도 변화로 목록을 바꾸면서 이전 배후세대와 점수를 재조합할 수 있어 상태 분리는 아직 완료되지 않았다.

## 가장 위험한 결합 5개

### 1. 초기 랜딩: URL·DOM 토글·커버·분석이 서로 의존

Java HOME/FALLBACK/딥링크와 JS session token·반복 타이머가 초기화를 공동 소유한다. JS 11.5초, Java 12초 타임아웃은 성공 검증 없이 커버를 해제한다. 평 단위는 클릭 후 실제 상태 확인 없이 성공 신호로 이어진다. `refreshAll()`도 초기 필터를 호출한다. 필터 수정이 분석 시점의 지도/목록이나 사용자 선택을 흔들 수 있다.

목표: 시작 상태의 단일 소유자와 ready 계약. 실패 시 안전한 오류·재시도 화면을 보여주고 미검증 네이버 화면을 공개하지 않는다. 공유/딥링크 목적지는 초기 지도 진입과 명시적으로 구별한다.

### 2. 지도 관찰: 앱 분석 요청이 지도 좌표를 다시 기록

`installCenterProbe()`는 네이버 UI 요청뿐 아니라 `naverJson()`의 자체 fetch도 관찰한다. 배후세대 주변 9점 요청은 `rememberCenterFromUrl()`을 통해 `lastObservedCenter`를 변경할 수 있다. `getCenter()`는 이 값을 최우선으로 쓴다. 수집 템플릿/관찰 지역코드 역시 과거 지역일 수 있다.

목표: 사용자 지도 관찰과 앱 소유 API 요청을 구분하고 지도 revision을 둔다. 분석은 실행 시 확정한 좌표·반경 스냅샷만 읽는다.

### 3. 매물 목록: DOM·누적 API·분석결과가 같은 상태를 덮어씀

`scanListings()`는 주석 DOM을 제거·재삽입하며 observer가 이 childList 변경을 다시 관찰할 수 있다. 패널 닫힌 동안 observer가 `latest.listings`를 DOM 일부 목록으로 교체한다. `fetchListingsFromApi()`는 누적 captured 매물을 현재 지역 검증 없이 먼저 넣는다. fallback도 이전 지역 데이터를 사용할 수 있다. `refreshListingsOnly()`에는 세대/요청 버전 검사가 없다.

영향: 시세/TOP3/CSV가 다른 표본으로 바뀌고 이전 지역 배후세대와 섞인다. 목표는 지역·필터·출처·완전성별 ListingState와 DOM 표시 책임 분리다.

### 4. 분석 lifecycle: 화면 열기·가변 설정·네트워크·렌더가 결합

`openSheet()`는 상세 복귀를 포함해 항상 새 분석을 시작한다. `analysisRunSeq`는 일부 완료 결과를 버리지만 이전 HTTP나 배후세대 작업을 중단하지 않는다. closeSheet에도 취소가 없다. `getHouseholds`는 await 뒤 `settings.includeOfficetel`을 읽고, `render`는 현재 `settings.radius`를 사용해 과거 결과를 재해석한다. 매물 조회 진행 메시지도 run 검사 없이 UI를 갱신한다.

추가로 `latest.stores = await getStoreCount(...)`는 run 검사를 하기 전에 결과를 공유 상태에 쓰므로 오래된 요청의 쓰기를 원천 차단하지 못한다. 네이티브 HTTP는 동기 브리지 호출로 취소 API가 없고, 연결/읽기 timeout 12/18초는 전체 분석 timeout이 아니다.

목표: 불변 AnalysisInput, requestId, 단일 활성 배후세대 작업, 취소/완료 정리, 상태 변경 전 유효성 검사, 캐시. 매물과 배후세대 결과는 동일 스냅샷 안에서만 조합한다.

### 5. 뒤로가기: JS flag·native flag·history·합성 터치가 중복 소유

JS `returnToAnalyzerOnBack`과 Java `analyzerReturnArmed`가 독립적이다. JS가 복귀를 처리해도 native flag가 해제되지 않아 다음 뒤로가기에서 재소비될 수 있다. 상세 URL은 현재 origin에 `/offices`를 붙여 fin 호스트에서 유효하지 않을 가능성도 있다. native history 복귀는 정확한 YB 상태 스냅샷을 보장하지 않고 650ms 후 분석을 다시 연다.

목록 접기는 DOM 위치 추정+합성 스와이프이며 완료 확인이 없다. `onSaveInstanceState`는 있으나 `restoreState`와 앱 상태 복원은 없다. 목표는 한번 소비하는 NavigationState와 복귀 스냅샷, 표시 복원과 재분석의 분리다.

## Git 및 비밀정보 점검

- 기존 `.gitignore`가 없어 이번 작업에서 추가했다. 빌드 산출물, local.properties, 환경 파일, 서명키, 로컬 자격증명, 로그/세션 덤프를 제외한다. 공개 예제 환경 파일은 허용한다.
- 현재 읽은 소스에서 하드코딩된 실제 API 키/서명 비밀번호는 발견하지 않았다. `DEFAULTS.serviceKey`는 빈 값이고 bridge token은 실행 중 UUID로 생성된다. 이 점검은 비밀정보 전용 스캐너나 Git 이력 검사에 해당하지 않는다.
- 입력한 공공 API 키는 설정 JSON에 함께 저장되어 SharedPreferences로 전달된다. `assets/config.json`은 APK에 포함되므로 비밀 저장소로 사용하면 안 된다.
- 네이버 인증헤더/쿠키/공공 키 포함 URL은 로그·fixture에 저장하지 않는다. HTTP 오류 문구 등도 후속 관측 도구 추가 시 마스킹 대상이다.
- `.gitignore`로 임의 파일에 넣은 비밀이나 이미 추적된 비밀을 차단할 수 없다. 현재 Git 이력이 없으므로 과거 노출 여부를 확인할 수 없다. Git 초기화나 커밋은 이번 범위에서 수행하지 않았다.

## 검증 범위와 다음 단계

이번에는 문서와 `.gitignore`만 추가했다. Java/JS/CSS/빌드 설정의 런타임 동작은 변경하지 않았다. 기존 `investment_mobile.js`와 `bridge.js`의 `node --check` 구문 검사는 통과했다. 실제 네이버 API 호출, Android 빌드·설치·회귀 테스트는 수행하지 않았다. 후속 구현 순서, 파일 목록, 자동 검증 도입 기준은 [PHASE1_PLAN.md](PHASE1_PLAN.md)에 기록한다.
