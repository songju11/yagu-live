// =====================================================================
// 외부 API 호출 공통 함수 (네이버 / KBO 공식 / 다음)
//
// 왜 fetch 대신 https.request를 쓰나:
//   네이버 API 게이트웨이(WAF)는 Node 기본 TLS 지문을 봇으로 보고 해외 서버 요청을 막는다.
//   (GitHub Actions 같은 해외 서버에서 api-gw.sports.naver.com이 안 읽힌다는 사례가 있음)
//   크롬과 비슷한 암호 스위트/곡선 순서로 TLS를 맺고 브라우저 헤더를 붙이면
//   해외 서버(Render 등)에서도 응답이 온다는 공개 코드(Civa030203/KBO-Info)를 참고했다.
//   fetch(undici)는 암호 스위트를 바꿀 수 없어서 https.request + Agent를 직접 쓴다.
// =====================================================================

const https = require("https");
const zlib = require("zlib");

// 크롬 기본 TLS 암호 스위트 순서 (Node 기본 OpenSSL 순서와 다르게)
const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const chromeAgent = new https.Agent({
  ciphers: CHROME_CIPHERS,
  ecdhCurve: "X25519:P-256:P-384",
  keepAlive: true,
});

const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------
// 소스별 헤더 (케이스별로 따로 적음)
// ---------------------------------------------------------------------
function headersFor(source) {
  switch (source) {
    case "naver":
      // 네이버 모바일 스포츠 페이지가 보내는 것과 같은 모양
      return {
        Accept: "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        Origin: "https://m.sports.naver.com",
        Referer: "https://m.sports.naver.com/",
        "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "User-Agent": DESKTOP_CHROME_UA,
      };

    case "kbo":
      // KBO 공식 모바일 웹 (m.koreabaseball.com)
      return {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "ko-KR,ko;q=0.9",
        Referer: "https://m.koreabaseball.com/",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": DESKTOP_CHROME_UA,
      };

    case "daum":
      // 다음 스포츠
      return {
        Accept: "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "ko-KR,ko;q=0.9",
        Referer: "https://sports.daum.net/schedule/kbo",
        "User-Agent": DESKTOP_CHROME_UA,
      };

    default:
      return { "User-Agent": DESKTOP_CHROME_UA };
  }
}

// ---------------------------------------------------------------------
// GET 요청 → JSON
// 실패해도 예외를 던지지 않고 { ok:false, status, error, bodyHead } 를 돌려준다.
// ---------------------------------------------------------------------
function requestJson(url, source, timeoutMs) {
  const timeout = timeoutMs || 8000;
  const startedAt = Date.now();

  return new Promise(function (resolve) {
    let finished = false;
    function done(result) {
      if (finished) return;
      finished = true;
      result.ms = Date.now() - startedAt;
      result.url = url;
      resolve(result);
    }

    let req;
    try {
      req = https.request(url, { method: "GET", agent: chromeAgent, headers: headersFor(source) }, function (res) {
        const chunks = [];
        res.on("data", function (chunk) {
          chunks.push(chunk);
        });
        res.on("end", function () {
          let buffer = Buffer.concat(chunks);

          // 압축 풀기 (서버가 고른 방식대로)
          const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
          try {
            if (encoding === "gzip") {
              buffer = zlib.gunzipSync(buffer);
            } else if (encoding === "deflate") {
              buffer = zlib.inflateSync(buffer);
            } else if (encoding === "br") {
              buffer = zlib.brotliDecompressSync(buffer);
            }
          } catch (e) {
            done({ ok: false, status: res.statusCode, error: "압축 해제 실패(" + encoding + ")", bodyHead: "" });
            return;
          }

          const text = buffer.toString("utf8");
          const json = parseJsonLoose(text);

          if (res.statusCode < 200 || res.statusCode >= 300) {
            done({ ok: false, status: res.statusCode, error: "HTTP " + res.statusCode, bodyHead: text.slice(0, 300) });
            return;
          }
          if (json === null) {
            done({ ok: false, status: res.statusCode, error: "JSON 아님", bodyHead: text.slice(0, 300) });
            return;
          }
          // 네이버 공통 응답은 success 필드가 있다
          if (json.success === false) {
            done({ ok: false, status: res.statusCode, error: "success=false (code " + json.code + ")", bodyHead: text.slice(0, 300) });
            return;
          }
          done({ ok: true, status: res.statusCode, json: json });
        });
        res.on("error", function (e) {
          done({ ok: false, status: res.statusCode || 0, error: "응답 읽기 실패: " + e.message, bodyHead: "" });
        });
      });
    } catch (e) {
      done({ ok: false, status: 0, error: "요청 생성 실패: " + e.message, bodyHead: "" });
      return;
    }

    req.setTimeout(timeout, function () {
      req.destroy(new Error(timeout + "ms 타임아웃"));
    });
    req.on("error", function (e) {
      done({ ok: false, status: 0, error: e.message, bodyHead: "" });
    });
    req.end();
  });
}

// JSON 파싱. KBO ASMX는 가끔 <string>{...}</string> XML로 감싸서 주므로 그 경우도 처리.
function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // 아래에서 XML 감싸기 확인
  }
  const match = text.match(/<string[^>]*>([\s\S]*)<\/string>/);
  if (match) {
    const inner = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    try {
      return JSON.parse(inner);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function jsonResponse(statusCode, data) {
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(data),
  };
}

// 실패한 외부 요청 → 우리 API 에러 응답 모양
function upstreamFailBody(upstream) {
  return {
    ok: false,
    error: "외부 응답 실패",
    upstreamStatus: upstream.status,
    upstreamError: upstream.error,
    upstreamBodyHead: upstream.bodyHead,
    source: upstream.url,
    ms: upstream.ms,
  };
}

function todayInKorea() {
  const koreaNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return koreaNow.toISOString().slice(0, 10).replace(/-/g, "");
}

module.exports = {
  requestJson: requestJson,
  jsonResponse: jsonResponse,
  upstreamFailBody: upstreamFailBody,
  todayInKorea: todayInKorea,
};
