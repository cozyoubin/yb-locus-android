package com.yblocus.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.ProgressBar;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final String HOME = "https://new.land.naver.com/offices?a=SG:SMS&b=A1:B2&e=RETAIL&ad=true";
    private static final String HOME_FALLBACK = "https://new.land.naver.com/";
    private static final String APP_VERSION = "2.8.0";
    private static final int REQ_LOCATION = 701;
    private WebView webView;
    private ProgressBar progressBar;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;
    private final String bridgeToken = UUID.randomUUID().toString();
    private boolean startupRecoveryTried = false;
    private volatile boolean analyzerReturnArmed = false;
    private boolean openAnalyzerAfterNavigation = false;
    private volatile String analyzerReturnUrl = "";
    private volatile boolean naverListSheetOpen = false;
    private View startupCover;
    private TextView startupMessage;
    private ProgressBar startupProgress;
    private TextView analyzerButton;
    private enum LandingState { IDLE, PAGE_LOADING, APPLYING_DEFAULTS, VERIFYING_DEFAULTS, READY, FAILED }
    private final Object landingLock = new Object();
    private volatile LandingState landingState = LandingState.IDLE;
    private int landingPageId = 0;
    private int landingAttempts = 0;
    private boolean landingPageFinished = false;
    private long landingDeadlineAt;
    private static final int MAX_LANDING_ATTEMPTS = 3;
    private static final long LANDING_TIMEOUT_MS = 60000L;
    private final Runnable landingTimeout = () -> {
        synchronized (landingLock) {
            if (landingState == LandingState.READY || landingState == LandingState.FAILED) return;
            landingState = LandingState.FAILED;
        }
        renderLandingState();
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // v1.2: v1.1의 WindowInsets 콜백을 제거하고 더 보수적인 안전 여백 방식을 사용한다.
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        // 분석 버튼은 하단이 아니라 앱 전용 상단 바에 둔다.
        // 네이버의 지도/매물/하단 시스템 내비게이션과 겹치지 않고 WebView 높이만 줄인다.
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(Color.WHITE);

        LinearLayout actionBar = new LinearLayout(this);
        actionBar.setOrientation(LinearLayout.HORIZONTAL);
        actionBar.setGravity(Gravity.CENTER_VERTICAL);
        actionBar.setPadding(dp(14), dp(5), dp(10), dp(5));
        actionBar.setBackgroundColor(Color.WHITE);

        TextView brand = new TextView(this);
        brand.setText("YB LOCUS");
        brand.setTextColor(Color.rgb(17, 24, 39));
        brand.setTextSize(16);
        brand.setGravity(Gravity.CENTER_VERTICAL);
        brand.setTypeface(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams brandLp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        actionBar.addView(brand, brandLp);

        analyzerButton = new TextView(this);
        analyzerButton.setText("📊  분석");
        analyzerButton.setTextColor(Color.WHITE);
        analyzerButton.setTextSize(15);
        analyzerButton.setGravity(Gravity.CENTER);
        analyzerButton.setClickable(true);
        analyzerButton.setFocusable(true);
        analyzerButton.setEnabled(false);
        analyzerButton.setPadding(dp(18), 0, dp(18), 0);
        GradientDrawable analyzerBg = new GradientDrawable();
        analyzerBg.setColor(Color.rgb(17, 24, 39));
        analyzerBg.setCornerRadius(dp(20));
        analyzerButton.setBackground(analyzerBg);
        LinearLayout.LayoutParams analyzerLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(40));
        actionBar.addView(analyzerButton, analyzerLp);
        shell.addView(actionBar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(52)));

        FrameLayout webFrame = new FrameLayout(this);
        webView = new WebView(this);
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);

        webFrame.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        FrameLayout.LayoutParams pp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(3));
        pp.topMargin = 0;
        webFrame.addView(progressBar, pp);

        // v2.8: 네이버가 초기 필터를 내부적으로 여러 단계 갱신하더라도 그 과정을 사용자에게 노출하지 않는다.
        // 최종 상가+사무실 / 매매+월세 / 평 상태가 확인된 뒤 한 번에 지도를 보여준다.
        LinearLayout cover = new LinearLayout(this);
        cover.setOrientation(LinearLayout.VERTICAL);
        cover.setGravity(Gravity.CENTER);
        cover.setBackgroundColor(Color.rgb(15, 23, 42));
        // 불투명 커버 아래의 네이버 필터/지도에 터치가 전달되지 않게 한다.
        cover.setClickable(true);
        cover.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        TextView coverBrand = new TextView(this);
        coverBrand.setText("YB LOCUS");
        coverBrand.setTextColor(Color.rgb(248, 220, 145));
        coverBrand.setTextSize(25);
        coverBrand.setTypeface(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD);
        coverBrand.setGravity(Gravity.CENTER);
        cover.addView(coverBrand, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(54)));
        TextView coverText = new TextView(this);
        startupMessage = coverText;
        coverText.setText("상가 · 사무실  |  매매 · 월세  설정 중");
        coverText.setTextColor(Color.rgb(226, 232, 240));
        coverText.setTextSize(14);
        coverText.setGravity(Gravity.CENTER);
        cover.addView(coverText, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(42)));
        ProgressBar coverProgress = new ProgressBar(this);
        startupProgress = coverProgress;
        LinearLayout.LayoutParams cplp = new LinearLayout.LayoutParams(dp(42), dp(42));
        cplp.topMargin = dp(6);
        cover.addView(coverProgress, cplp);
        startupCover = cover;
        webFrame.addView(startupCover, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        shell.addView(webFrame, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        // Android 16 edge-to-edge에서도 중요한 UI가 상태바/3버튼 내비게이션에 가려지지 않도록
        // 시스템 bar 리소스 높이 + 추가 여유를 shell 자체에 확보한다.
        int topSafe = systemBarSize("status_bar_height", 24) + dp(8);
        int bottomSafe = systemBarSize("navigation_bar_height", 48) + dp(16);
        shell.setPadding(0, topSafe, 0, bottomSafe);

        setContentView(shell);

        analyzerButton.setOnClickListener(v -> webView.evaluateJavascript(
                "(function(){if(window.YBLOCUS_OPEN_ANALYZER){window.YBLOCUS_OPEN_ANALYZER();return true;}return false;})()",
                result -> {
                    if ("false".equals(result)) {
                        Toast.makeText(MainActivity.this, "분석기를 불러오는 중입니다. 잠시 후 다시 눌러주세요.", Toast.LENGTH_SHORT).show();
                    }
                }));

        WebView.setWebContentsDebuggingEnabled(false);
        configureWebView();
        webView.addJavascriptInterface(new NativeBridge(this, bridgeToken), "SangaNative");

        // v2.6: 네이버 저장공간을 강제로 삭제하지 않는다. 저장공간 삭제는 모바일 페이지가
        // 주거 기본필터(아파트/매매·전세)로 다시 초기화되는 원인이 될 수 있었다.
        // 시작 후 JS가 실제 상단 필터 시트의 선택값을 확인해 상가+사무실 / 매매+월세만 한 번 맞춘다.
        landingState = LandingState.PAGE_LOADING;
        landingDeadlineAt = SystemClock.elapsedRealtime() + LANDING_TIMEOUT_MS;
        webView.postDelayed(landingTimeout, LANDING_TIMEOUT_MS);
        webView.loadUrl(resolveStartUrl(getIntent()));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    this::handleBackNavigation);
        }
    }

    private void renderLandingState() {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (landingState == LandingState.READY) {
                webView.removeCallbacks(landingTimeout);
                // 렌더 완료까지 확인된 화면만 fade 없이 한 번에 공개한다.
                startupCover.setVisibility(View.GONE);
                webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
                analyzerButton.setEnabled(true);
            } else if (landingState == LandingState.FAILED) {
                webView.removeCallbacks(landingTimeout);
                startupProgress.setVisibility(View.GONE);
                startupMessage.setText("초기 설정을 확인하지 못했습니다.\n앱을 다시 실행해 주세요.");
            }
        });
    }

    private boolean landingActive(int pageId) {
        // 호출자는 landingLock을 보유한다. READY/FAILED는 현재 Activity의 종결 상태다.
        if (landingState != LandingState.READY && landingState != LandingState.FAILED
                && SystemClock.elapsedRealtime() >= landingDeadlineAt) {
            landingState = LandingState.FAILED;
            renderLandingState();
        }
        return pageId == landingPageId && landingPageFinished
                && landingState != LandingState.READY && landingState != LandingState.FAILED;
    }

    private void completeVerifiedLanding(int pageId) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            synchronized (landingLock) {
                if (!landingActive(pageId) || landingState != LandingState.VERIFYING_DEFAULTS) return;
            }
            // 렌더 콜백 대기도 전체 deadline에 포함한다. 이전 문서/timeout 뒤 응답은 무시한다.
            webView.postVisualStateCallback(pageId, new WebView.VisualStateCallback() {
                @Override
                public void onComplete(long requestId) {
                    if (isFinishing() || isDestroyed()) return;
                    synchronized (landingLock) {
                        if (!landingActive(pageId) || landingState != LandingState.VERIFYING_DEFAULTS) return;
                        landingState = LandingState.READY;
                    }
                    renderLandingState();
                }
            });
        });
    }

    @Override
    protected void onDestroy() {
        // 초기화 타이머/이전 문서의 JS가 종료된 Activity를 다시 갱신하지 않게 한다.
        synchronized (landingLock) {
            landingState = LandingState.FAILED;
            landingPageFinished = false;
        }
        if (webView != null) webView.removeCallbacks(landingTimeout);
        super.onDestroy();
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.setSafeBrowsingEnabled(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        // Android에서는 모바일 네이버 부동산 UI를 우선 사용한다.
        // 데스크톱 페이지 전체를 축소해 끼워 넣는 방식은 조작성과 가독성이 크게 떨어진다.
        s.setUserAgentString("Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36");
        s.setLoadWithOverviewMode(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cm.setAcceptThirdPartyCookies(webView, true);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                synchronized (landingLock) {
                    if (landingState == LandingState.READY || landingState == LandingState.FAILED) return;
                    landingPageId++;
                    landingPageFinished = false;
                    landingState = LandingState.PAGE_LOADING;
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme();
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    String host = u.getHost();
                    // JavaScript bridge가 일반 네이버 서비스에 노출되지 않도록 부동산 호스트만 앱 내부에서 연다.
                    if (host != null && isNaverLandHost(host)) return false;
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                    return true;
                }
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // 초기화 중에만 오래된 문서 완료를 거른다. READY 뒤 분석기 주입은 기존대로 둔다.
                if (landingState == LandingState.READY || (url != null && url.equals(view.getUrl()))) {
                    synchronized (landingLock) {
                        landingPageFinished = true;
                    }
                    injectAnalyzer();
                }

                if (openAnalyzerAfterNavigation && isNaverLand(url)) {
                    openAnalyzerAfterNavigation = false;
                    view.postDelayed(() -> view.evaluateJavascript(
                            "(function(){if(window.YBLOCUS_OPEN_ANALYZER){window.YBLOCUS_OPEN_ANALYZER();return true;}return false;})()",
                            null), 650);
                }

                // Naver가 딥링크를 리다이렉트하면서 존재하지 않는 경로로 보낼 경우
                // 404 화면에 사용자를 남겨두지 않고 정상 부동산 홈으로 한 번만 복구한다.
                if (!startupRecoveryTried && isNaverLand(url)) {
                    view.evaluateJavascript(
                            "(function(){var t=(document.body&&document.body.innerText)||'';return t.indexOf('요청하신 페이지를 찾을 수 없어요')>=0;})()",
                            result -> {
                                if ("true".equals(result) && !startupRecoveryTried) {
                                    startupRecoveryTried = true;
                                    view.loadUrl(HOME_FALLBACK);
                                }
                            });
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (Build.VERSION.SDK_INT < 23 ||
                        (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                         checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED)) {
                    callback.invoke(origin, true, false);
                    return;
                }
                geoOrigin = origin;
                geoCallback = callback;
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            }
        });
    }

    private void injectAnalyzer() {
        String url = webView.getUrl();
        if (url == null || !isNaverLand(url)) return;
        try {
            String bridge = readAssetText("bridge.js").replace("__SANGA_BRIDGE_TOKEN__", bridgeToken);
            injectJs("window.__SANGA_BRIDGE_TOKEN__=" + JSONObject.quote(bridgeToken) + ";");
            synchronized (landingLock) {
                injectJs("window.__YBLOCUS_LANDING_PAGE__=" + landingPageId + ";");
            }
            // 모바일 WebView에서 사이트가 PC 폭으로 축소되지 않도록 viewport를 명시한다.
            injectJs("(function(){var m=document.querySelector('meta[name=viewport]');if(!m){m=document.createElement('meta');m.name='viewport';document.head.appendChild(m);}m.content='width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes';})();");
            injectJs(bridge);
            injectCss(readAssetText("investment_mobile.css"));
            // PC용 contents.js는 중개사/등록일 등을 제거하는 로직이 있어 모바일에서는 사용하지 않는다.
            // 모바일 전용 분석기가 원본 DOM을 보존하면서 평수·평당가만 안전하게 덧붙인다.
            injectJs(readAssetText("investment_mobile.js"));
        } catch (Exception e) {
            Toast.makeText(this, "분석기 로드 실패: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void injectJs(String js) {
        webView.evaluateJavascript("(function(){\n" + js + "\n})();", null);
    }

    private void injectCss(String css) {
        String q = JSONObject.quote(css);
        String js = "(function(){var id='sanga-invest-mobile-css';var x=document.getElementById(id);if(!x){x=document.createElement('style');x.id=id;document.documentElement.appendChild(x);}x.textContent=" + q + ";})();";
        webView.evaluateJavascript(js, null);
    }

    private String readAssetText(String name) throws Exception {
        try (InputStream in = getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private String resolveStartUrl(Intent intent) {
        if (intent != null) {
            if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
                String u = intent.getData().toString();
                if (isNaverLand(u)) return u;
            }
            if (Intent.ACTION_SEND.equals(intent.getAction())) {
                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                if (text != null) {
                    String u = firstNaverLandUrl(text);
                    if (u != null) return u;
                }
            }
        }
        return HOME;
    }

    private static String firstNaverLandUrl(String text) {
        int p = text.indexOf("https://");
        while (p >= 0) {
            int end = text.indexOf(' ', p);
            String u = end < 0 ? text.substring(p) : text.substring(p, end);
            u = u.replaceAll("[\\)\\]>,.;]+$", "");
            if (isNaverLand(u)) return u;
            p = text.indexOf("https://", p + 8);
        }
        return null;
    }

    private static boolean isNaverLandHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        return h.equals("land.naver.com") || h.endsWith(".land.naver.com");
    }

    private static boolean isNaverLand(String url) {
        try {
            Uri u = Uri.parse(url);
            return isNaverLandHost(u.getHost());
        } catch (Exception e) { return false; }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        webView.loadUrl(resolveStartUrl(intent));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        // Android 12 이하 및 레거시 호출 경로. Android 13+는 OnBackInvokedDispatcher가 동일 로직을 호출한다.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            handleBackNavigation();
        } else {
            handleBackNavigation();
        }
    }

    private void handleBackNavigation() {
        if (webView == null) {
            finish();
            return;
        }
        // 우선순위: 분석패널 닫기 → TOP3 상세에서 분석으로 복귀 → 네이버 매물목록 접기
        // → 실제 WebView history → 앱 종료. 모바일 네이버의 바텀시트는 history를 만들지 않으므로
        // 명시 플래그와 DOM 감지를 함께 사용한다.
        webView.evaluateJavascript(
                "(function(){try{return !!(window.YBLOCUS_HANDLE_BACK&&window.YBLOCUS_HANDLE_BACK());}catch(e){return false;}})()",
                handled -> {
                    if ("true".equals(handled)) return;

                    if (analyzerReturnArmed) {
                        analyzerReturnArmed = false;
                        openAnalyzerAfterNavigation = true;
                        if (webView.canGoBack()) {
                            webView.goBack();
                        } else if (analyzerReturnUrl != null && !analyzerReturnUrl.isEmpty()) {
                            webView.loadUrl(analyzerReturnUrl);
                        } else {
                            webView.loadUrl(HOME);
                        }
                        return;
                    }

                    webView.evaluateJavascript(
                            "(function(){try{return window.YBLOCUS_NAVER_SHEET_TOP_RATIO?window.YBLOCUS_NAVER_SHEET_TOP_RATIO():-1;}catch(e){return -1;}})()",
                            hint -> {
                                float ratio = -1f;
                                try { ratio = Float.parseFloat(hint == null ? "-1" : hint.replace("\"", "")); }
                                catch (Exception ignored) {}

                                if (naverListSheetOpen) {
                                    naverListSheetOpen = false;
                                    collapseNaverBottomSheet((ratio > 0.03f && ratio < 0.90f) ? ratio : 0.50f);
                                    return;
                                }
                                if (ratio > 0.03f && ratio < 0.90f) {
                                    collapseNaverBottomSheet(ratio);
                                    return;
                                }
                                if (webView.canGoBack()) webView.goBack();
                                else finish();
                            });
                });
    }

    private void collapseNaverBottomSheet(float topRatio) {
        if (webView == null || webView.getWidth() <= 0 || webView.getHeight() <= 0) return;
        final float x = webView.getWidth() * 0.5f;
        final float minStart = dp(20);
        final float maxStart = Math.max(minStart, webView.getHeight() - dp(180));
        final float startY = Math.max(minStart, Math.min(maxStart, webView.getHeight() * topRatio + dp(18)));
        final float endY = Math.min(webView.getHeight() - dp(24),
                startY + Math.max(dp(260), webView.getHeight() * 0.42f));
        final long downTime = SystemClock.uptimeMillis();

        MotionEvent down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, startY, 0);
        webView.dispatchTouchEvent(down);
        down.recycle();

        final int steps = 7;
        for (int i = 1; i <= steps; i++) {
            final int step = i;
            webView.postDelayed(() -> {
                float y = startY + (endY - startY) * step / steps;
                int action = step == steps ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
                long now = SystemClock.uptimeMillis();
                MotionEvent ev = MotionEvent.obtain(downTime, now, action, x, y, 0);
                webView.dispatchTouchEvent(ev);
                ev.recycle();
            }, i * 28L);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_LOCATION && geoCallback != null) {
            boolean ok = false;
            for (int r : grantResults) if (r == PackageManager.PERMISSION_GRANTED) { ok = true; break; }
            geoCallback.invoke(geoOrigin, ok, false);
            geoCallback = null;
            geoOrigin = null;
        }
    }

    private int systemBarSize(String resourceName, int fallbackDp) {
        try {
            int id = getResources().getIdentifier(resourceName, "dimen", "android");
            if (id > 0) {
                int px = getResources().getDimensionPixelSize(id);
                if (px > 0) return px;
            }
        } catch (Exception ignored) {
        }
        return dp(fallbackDp);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    public static class NativeBridge {
        private final MainActivity activity;
        private final android.content.SharedPreferences prefs;
        private final String token;
        private String naverAccessToken = "";
        private long naverAccessTokenAt = 0L;

        NativeBridge(MainActivity activity, String token) {
            this.activity = activity;
            this.token = token;
            this.prefs = activity.getSharedPreferences("yb_locus", Context.MODE_PRIVATE);
        }

        private boolean authorized(String supplied) {
            return supplied != null && token.equals(supplied);
        }

        @JavascriptInterface
        public void collapseNaverSheet(String suppliedToken, float topRatio) {
            if (!authorized(suppliedToken)) return;
            final float ratio = Math.max(0.04f, Math.min(0.88f, topRatio));
            activity.runOnUiThread(() -> activity.collapseNaverBottomSheet(ratio));
        }

        @JavascriptInterface
        public void setNaverListSheetOpen(String suppliedToken, boolean open) {
            if (!authorized(suppliedToken)) return;
            activity.naverListSheetOpen = open;
        }

        @JavascriptInterface
        public boolean isLandingActive(String suppliedToken, int pageId) {
            if (!authorized(suppliedToken)) return false;
            synchronized (activity.landingLock) {
                return activity.landingActive(pageId);
            }
        }

        @JavascriptInterface
        public boolean beginLandingAttempt(String suppliedToken, int pageId) {
            if (!authorized(suppliedToken)) return false;
            synchronized (activity.landingLock) {
                if (!activity.landingActive(pageId)) return false;
                // origin/문서가 바뀌어도 실행 전체의 횟수와 deadline은 초기화하지 않는다.
                if (activity.landingAttempts >= MAX_LANDING_ATTEMPTS) {
                    activity.landingState = LandingState.FAILED;
                    activity.renderLandingState();
                    return false;
                }
                activity.landingAttempts++;
                activity.landingState = LandingState.APPLYING_DEFAULTS;
                return true;
            }
        }

        @JavascriptInterface
        public boolean updateLandingState(String suppliedToken, int pageId, String state) {
            if (!authorized(suppliedToken)) return false;
            synchronized (activity.landingLock) {
                if (!activity.landingActive(pageId)) return false;
                if ("VERIFYING_DEFAULTS".equals(state) && activity.landingState == LandingState.APPLYING_DEFAULTS) {
                    activity.landingState = LandingState.VERIFYING_DEFAULTS;
                } else if ("READY".equals(state) && activity.landingState == LandingState.VERIFYING_DEFAULTS) {
                    activity.completeVerifiedLanding(pageId);
                    return true;
                } else if ("FAILED".equals(state)) {
                    activity.landingState = LandingState.FAILED;
                } else {
                    return false;
                }
            }
            activity.renderLandingState();
            return true;
        }

        @JavascriptInterface
        public void armAnalyzerReturn(String suppliedToken, String returnUrl) {
            if (!authorized(suppliedToken)) return;
            String chosen = returnUrl == null ? "" : returnUrl.trim();
            activity.analyzerReturnUrl = isNaverLand(chosen) ? chosen : HOME;
            activity.analyzerReturnArmed = true;
        }

        @JavascriptInterface
        public String getStorageJson(String suppliedToken) {
            if (!authorized(suppliedToken)) return "{}";
            return prefs.getString("js_storage", "{}");
        }

        @JavascriptInterface
        public void setStorageJson(String suppliedToken, String json) {
            if (!authorized(suppliedToken)) return;
            if (json == null || json.length() > 2000000) return;
            prefs.edit().putString("js_storage", json).apply();
        }

        @JavascriptInterface
        public String assetDataUrl(String suppliedToken, String name) {
            if (!authorized(suppliedToken)) return "";
            if (name == null) return "";
            if (!name.equals("config.json")) return "";
            try (InputStream in = activity.getAssets().open(name);
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] b = new byte[4096]; int n;
                while ((n = in.read(b)) > 0) out.write(b, 0, n);
                String mime = "application/json";
                return "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(out.toByteArray());
            } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public String httpGet(String suppliedToken, String url) {
            JSONObject out = new JSONObject();
            if (!authorized(suppliedToken)) {
                try { out.put("ok", false); out.put("error", "unauthorized"); } catch (Exception ignored) {}
                return out.toString();
            }
            try {
                URL u = new URL(url);
                String h = u.getHost().toLowerCase(Locale.ROOT);
                boolean allowed = h.equals("new.land.naver.com") || h.equals("m.land.naver.com") || h.equals("fin.land.naver.com") || h.equals("apis.data.go.kr");
                if (!allowed || !"https".equalsIgnoreCase(u.getProtocol())) throw new SecurityException("허용되지 않은 주소");

                boolean naverApi = h.endsWith("land.naver.com") && u.getPath() != null && u.getPath().startsWith("/api/") && !u.getPath().equals("/api/auth");
                // v2.7: 공개/쿠키 세션으로 동작하는 네이버 API까지 인증 토큰 발급 실패 때문에
                // 함께 막히지 않도록 반드시 무인증 요청을 먼저 보낸다. 401/403일 때만 bearer를 붙여 재시도한다.
                JSONObject first = performGet(u, false, false);
                int code = first.optInt("status", 0);
                if (naverApi && (code == 401 || code == 403)) {
                    first = performGet(u, true, false);
                    int retryCode = first.optInt("status", 0);
                    if (retryCode == 401 || retryCode == 403) first = performGet(u, true, true);
                }
                return first.toString();
            } catch (Exception e) {
                try {
                    out.put("ok", false);
                    out.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
                return out.toString();
            }
        }

        private JSONObject performGet(URL u, boolean withNaverAuth, boolean forceAuthRefresh) throws Exception {
            HttpURLConnection c = null;
            JSONObject out = new JSONObject();
            try {
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(12000);
                c.setReadTimeout(18000);
                c.setInstanceFollowRedirects(true);
                c.setRequestMethod("GET");
                c.setRequestProperty("Accept", "application/json, text/plain, */*");
                c.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.6");
                String referer = activity.webView.getUrl();
                if (referer == null || referer.isEmpty() || !isNaverLand(referer)) referer = "https://new.land.naver.com/";
                c.setRequestProperty("Referer", referer);
                c.setRequestProperty("User-Agent", activity.webView.getSettings().getUserAgentString());
                c.setRequestProperty("Sec-Fetch-Dest", "empty");
                c.setRequestProperty("Sec-Fetch-Mode", "cors");
                c.setRequestProperty("Sec-Fetch-Site", "same-origin");
                c.setRequestProperty("X-Requested-With", "XMLHttpRequest");
                String cookie = CookieManager.getInstance().getCookie(u.toString());
                if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                if (withNaverAuth) {
                    String access = getNaverAccessToken(forceAuthRefresh);
                    if (access != null && !access.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + access);
                }

                int code = c.getResponseCode();
                InputStream stream = code >= 200 && code < 400 ? c.getInputStream() : c.getErrorStream();
                String text = readAll(stream);
                out.put("ok", code >= 200 && code < 300);
                out.put("status", code);
                out.put("text", text);
                if (!(code >= 200 && code < 300)) out.put("error", "HTTP " + code);
                return out;
            } finally {
                if (c != null) c.disconnect();
            }
        }

        private String getNaverAccessToken(boolean forceRefresh) throws Exception {
            long now = System.currentTimeMillis();
            if (!forceRefresh && naverAccessToken != null && !naverAccessToken.isEmpty() && now - naverAccessTokenAt < 8 * 60 * 1000L) {
                return naverAccessToken;
            }
            URL u = new URL("https://new.land.naver.com/api/auth?ctcvg=3&isMultiComplex=false");
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(12000);
                c.setReadTimeout(18000);
                c.setInstanceFollowRedirects(true);
                c.setRequestMethod("GET");
                c.setRequestProperty("Accept", "application/json, text/plain, */*");
                c.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.6");
                c.setRequestProperty("Referer", "https://new.land.naver.com/");
                c.setRequestProperty("User-Agent", activity.webView.getSettings().getUserAgentString());
                String cookie = CookieManager.getInstance().getCookie(u.toString());
                if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                int code = c.getResponseCode();
                String text = readAll(code >= 200 && code < 400 ? c.getInputStream() : c.getErrorStream());
                if (code < 200 || code >= 300) throw new Exception("네이버 인증 HTTP " + code);
                JSONObject j = new JSONObject(text);
                String access = j.optString("responseObj", "");
                if (access.isEmpty()) access = j.optString("accessToken", "");
                if (access.isEmpty()) access = j.optString("token", "");
                if (access.isEmpty()) throw new Exception("네이버 인증 토큰 없음");
                naverAccessToken = access;
                naverAccessTokenAt = now;
                return access;
            } finally {
                if (c != null) c.disconnect();
            }
        }

        private static String readAll(InputStream in) throws Exception {
            if (in == null) return "";
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                StringBuilder s = new StringBuilder();
                char[] b = new char[8192]; int n;
                while ((n = r.read(b)) >= 0) s.append(b, 0, n);
                return s.toString();
            }
        }

        @JavascriptInterface
        public void copyText(String suppliedToken, String text) {
            if (!authorized(suppliedToken)) return;
            activity.runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("YB LOCUS", text == null ? "" : text));
                Toast.makeText(activity, "분석 내용을 복사했습니다.", Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public String saveTextFile(String suppliedToken, String filename, String text) {
            if (!authorized(suppliedToken)) return "CSV 저장 권한 확인 실패";
            String safeName = (filename == null || filename.trim().isEmpty()) ? "상가분석.csv" : filename.replaceAll("[\\\\/:*?\"<>|]", "_");
            try {
                byte[] bytes = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, "text/csv");
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/YB LOCUS");
                    Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new Exception("저장 위치 생성 실패");
                    try (OutputStream os = activity.getContentResolver().openOutputStream(uri)) { os.write(bytes); }
                    return "다운로드/YB LOCUS/" + safeName + " 에 저장했습니다.";
                } else {
                    File dir = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "YB LOCUS");
                    if (!dir.exists() && !dir.mkdirs()) throw new Exception("폴더 생성 실패");
                    File f = new File(dir, safeName);
                    try (FileOutputStream os = new FileOutputStream(f)) { os.write(bytes); }
                    return "앱 다운로드 폴더에 " + safeName + " 을 저장했습니다.";
                }
            } catch (Exception e) {
                return "CSV 저장 실패: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public void openExternal(String suppliedToken, String url) {
            if (!authorized(suppliedToken)) return;
            activity.runOnUiThread(() -> {
                try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                catch (Exception e) { Toast.makeText(activity, "링크를 열 수 없습니다.", Toast.LENGTH_SHORT).show(); }
            });
        }
    }
}
