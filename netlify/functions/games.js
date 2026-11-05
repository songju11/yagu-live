// =====================================================================
// GET /api/games?date=YYYYMMDD[&debug=1]
//
// 네이버 스포츠(비공식) 경기 일정 API를 대신 호출해서 그날 KBO 경기 목록을 돌려준다.
// 브라우저에서 바로 부르면 CORS에 막히기 때문에 이 함수가 중간 다리 역할을 한다.
//
// [필드명 확인 상태]
//  - 엔드포인트 /schedule/games?upperCategoryId=kbaseball&fromDate=&toDate= : 공개 코드 여러 곳에서 쓰는 주소
//  - 포스트시즌 gameId는 형식이 다르다: 앞 4자리가 연도 대신 시리즈 번호 반복 (한국시리즈 7 → 7777MMDD...)
//  - gameId, gameDate, stadium, awayTeamName, homeTeamName, awayTeamScore, homeTeamScore
//      : 단일 경기 조회(/schedule/games/{gameId})에서 외부 실측(2026-09)으로 확인된 이름.
//        목록 API도 같은 이름을 쓸 것으로 보지만 아직 확정 아님.
//  - awayTeamCode, homeTeamCode, gameDateTime, statusCode, statusInfo, cancel, categoryId
//      : 추정. 응답에 없으면 _missing 배열에 이름이 들어가니 디버그 화면에서 확인할 것.
//
// debug=1 이면 네이버 원본 응답(raw)도 같이 돌려준다.
// =====================================================================

const { requestJson, jsonResponse, todayInKorea } = require("../lib/request-json.js");

const NAVER_API = "https://api-gw.sports.naver.com";

exports.handler = async function (event) {
  const query = event.queryStringParameters || {};

  // 날짜: 안 주면 한국 시간 기준 오늘
  let date = query.date;
  if (!date) {
    date = todayInKorea();
  }
  if (!/^\d{8}$/.test(date)) {
    return jsonResponse(400, { ok: false, error: "date는 YYYYMMDD 형식이어야 함", got: date });
  }

  // 네이버는 YYYY-MM-DD 형식을 받는다
  const ymd = date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8);

  const url =
    NAVER_API +
    "/schedule/games" +
    "?fields=basic,baseball" +
    "&upperCategoryId=kbaseball" +
    "&categoryId=kbo" +
    "&fromDate=" + ymd +
    "&toDate=" + ymd +
    "&size=500";

  const upstream = await requestJson(url, "naver");

  if (!upstream.ok) {
    return jsonResponse(502, {
      ok: false,
      provider: "naver",
      error: "네이버 응답 실패",
      upstreamStatus: upstream.status,
      upstreamError: upstream.error,
      upstreamBodyHead: upstream.bodyHead,
      source: url,
      ms: upstream.ms,
    });
  }

  const body = upstream.json;

  // 네이버 공통 응답 모양: { code, success, result: { ... } }
  let rawGames = [];
  if (body && body.result && Array.isArray(body.result.games)) {
    rawGames = body.result.games;
  }

  const games = [];
  for (const g of rawGames) {
    games.push(normalizeGame(g));
  }

  // 시작 시간 순 정렬 (시간 필드가 없으면 원래 순서 유지)
  games.sort(function (a, b) {
    if (!a.dateTime || !b.dateTime) return 0;
    return String(a.dateTime).localeCompare(String(b.dateTime));
  });

  const result = {
    ok: true,
    provider: "naver",
    date: date,
    source: url,
    count: games.length,
    games: games,
  };

  if (query.debug === "1") {
    result.raw = body;
  }

  return jsonResponse(200, result);
};

// ---------------------------------------------------------------------
// 네이버 경기 1개 → 우리 앱에서 쓰는 모양으로 변환
// 필드가 없으면 _missing 에 이름을 기록해서 디버그 화면에서 보이게 한다.
// ---------------------------------------------------------------------
function normalizeGame(g) {
  const missing = [];

  function pick(fieldName) {
    if (g[fieldName] === undefined) {
      missing.push(fieldName);
      return null;
    }
    return g[fieldName];
  }

  const gameId = pick("gameId");

  // 팀 코드: 필드가 없으면 gameId에서 뽑는다.
  // gameId 예: 20260920HHLG02026 → 날짜(8) + 원정코드(2) + 홈코드(2) + 더블헤더번호(1) + 시즌(4)
  let awayCode = pick("awayTeamCode");
  let homeCode = pick("homeTeamCode");
  if (!awayCode && gameId && gameId.length >= 12) {
    awayCode = gameId.slice(8, 10);
  }
  if (!homeCode && gameId && gameId.length >= 12) {
    homeCode = gameId.slice(10, 12);
  }

  const statusCode = pick("statusCode");
  const cancel = pick("cancel");

  return {
    gameId: gameId,
    date: pick("gameDate"),
    dateTime: pick("gameDateTime"),
    stadium: pick("stadium"),
    categoryId: pick("categoryId"),

    awayCode: awayCode,
    awayName: pick("awayTeamName"),
    awayScore: pick("awayTeamScore"),

    homeCode: homeCode,
    homeName: pick("homeTeamName"),
    homeScore: pick("homeTeamScore"),

    statusCode: statusCode, // 네이버 원래 값 그대로
    statusInfo: pick("statusInfo"), // 예: "7회말" (추정)
    cancel: cancel,
    state: toState(statusCode, cancel), // 앱에서 쓰는 상태: scheduled / live / final / cancelled / unknown

    _missing: missing,
  };
}

// 네이버 statusCode → 앱 상태. 값 목록은 추정이므로 모르는 값은 unknown으로 둔다.
function toState(statusCode, cancel) {
  if (cancel === true) {
    return "cancelled";
  }
  switch (statusCode) {
    case "BEFORE": // 경기 전
      return "scheduled";
    case "STARTED": // 진행 중
      return "live";
    case "RESULT": // 종료
      return "final";
    case "CANCEL": // 취소
      return "cancelled";
    default:
      return "unknown";
  }
}
