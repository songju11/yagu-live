// =====================================================================
// 다음 스포츠 프록시 — 3순위 소스 (확인 단계)
//
//  GET /api/daum?type=games&date=YYYYMMDD
//      → 그날 KBO 경기 목록 (ARMS SPORTS_GAME_LIST)
//  GET /api/daum?type=game&gameId=80109251
//      → 경기 1개 상세 (ARMS SPORTS_GAME). 다음 gameId는 숫자.
//  GET /api/daum?type=relayProbe&gameId=80109251
//      → 문자중계 주소 후보들을 차례로 찔러보고 결과만 보고
//
// [확인 상태]
//  - ARMS SPORTS_GAME_LIST / SPORTS_GAME 은 공개 코드(hamos-2/DJ-KBL-bot, 농구 leagueCode=kbl)에서 쓰는 주소.
//    야구는 leagueCode=kbo 로 같은 구조일 것으로 보고 시도한다. (미확인)
//  - 응답 모양: { document: { list: [...] } } / { document: {...} }
//  - 문자중계 주소는 공개 코드에서 못 찾았다. 아래 RELAY_CANDIDATES는 전부 "추측"이다.
//    전부 실패하면 PC 크롬에서 다음 스포츠 문자중계 화면 → 개발자도구 Network 탭에서 실제 주소를 봐야 한다.
// =====================================================================

const { requestJson, jsonResponse, upstreamFailBody, todayInKorea } = require("../lib/request-json.js");

const DAUM_ARMS = "https://sports.daum.net/api/arms";
const DAUM_HERMES = "https://sports.daum.net/api/hermes";

exports.handler = async function (event) {
  const query = event.queryStringParameters || {};
  const type = query.type || "games";

  switch (type) {
    case "games":
      return await handleGames(query);
    case "game":
      return await handleGame(query);
    case "relayProbe":
      return await handleRelayProbe(query);
    default:
      return jsonResponse(400, { ok: false, provider: "daum", error: "type은 games / game / relayProbe", got: type });
  }
};

// ---------------------------------------------------------------------
// 경기 목록
// ---------------------------------------------------------------------
async function handleGames(query) {
  const date = query.date || todayInKorea();
  if (!/^\d{8}$/.test(date)) {
    return jsonResponse(400, { ok: false, provider: "daum", error: "date는 YYYYMMDD", got: date });
  }

  const url =
    DAUM_ARMS + "/SPORTS_GAME_LIST" +
    "?leagueCode=kbo" +
    "&fromDate=" + date +
    "&toDate=" + date +
    "&pageSize=50";

  const res = await requestJson(url, "daum");
  if (!res.ok) {
    const failBody = upstreamFailBody(res);
    failBody.provider = "daum";
    return jsonResponse(502, failBody);
  }

  let list = [];
  if (res.json && res.json.document && Array.isArray(res.json.document.list)) {
    list = res.json.document.list;
  }

  return jsonResponse(200, {
    ok: true,
    provider: "daum",
    date: date,
    source: url,
    count: list.length,
    games: list, // 다음 원본 그대로
    raw: res.json,
    ms: res.ms,
  });
}

// ---------------------------------------------------------------------
// 경기 상세
// ---------------------------------------------------------------------
async function handleGame(query) {
  const gameId = query.gameId;
  if (!gameId || !/^\d{4,12}$/.test(gameId)) {
    return jsonResponse(400, { ok: false, provider: "daum", error: "gameId(다음 숫자 ID)가 필요함", got: gameId });
  }

  const url = DAUM_ARMS + "/SPORTS_GAME?gameId=" + gameId;
  const res = await requestJson(url, "daum");
  if (!res.ok) {
    const failBody = upstreamFailBody(res);
    failBody.provider = "daum";
    return jsonResponse(502, failBody);
  }

  return jsonResponse(200, {
    ok: true,
    provider: "daum",
    gameId: gameId,
    source: url,
    raw: res.json,
    ms: res.ms,
  });
}

// ---------------------------------------------------------------------
// 문자중계 주소 후보 찔러보기 (전부 추측 — 어느 게 되는지 보는 용도)
// ---------------------------------------------------------------------
async function handleRelayProbe(query) {
  const gameId = query.gameId;
  if (!gameId || !/^\d{4,12}$/.test(gameId)) {
    return jsonResponse(400, { ok: false, provider: "daum", error: "gameId(다음 숫자 ID)가 필요함", got: gameId });
  }

  const candidates = [
    DAUM_ARMS + "/SPORTS_GAME_RELAY?gameId=" + gameId,
    DAUM_ARMS + "/SPORTS_GAME_TEXT_RELAY?gameId=" + gameId,
    DAUM_ARMS + "/SPORTS_GAME_LIVE?gameId=" + gameId,
    DAUM_HERMES + "/game/relay.json?gameId=" + gameId,
    DAUM_HERMES + "/game/" + gameId + "/relay.json",
  ];

  const results = [];
  for (const url of candidates) {
    const res = await requestJson(url, "daum", 5000);
    let topKeys = null;
    if (res.ok && res.json && typeof res.json === "object") {
      topKeys = Object.keys(res.json);
    }
    results.push({
      url: url,
      ok: res.ok,
      status: res.status,
      error: res.error || null,
      topKeys: topKeys,
      bodyHead: res.ok ? JSON.stringify(res.json).slice(0, 300) : res.bodyHead,
      ms: res.ms,
    });
  }

  let anyOk = false;
  for (const r of results) {
    if (r.ok) anyOk = true;
  }

  return jsonResponse(200, {
    ok: true,
    provider: "daum",
    gameId: gameId,
    found: anyOk,
    note: "후보 주소는 전부 추측. found=false면 다음 스포츠 페이지 Network 탭에서 실제 주소 확인 필요",
    results: results,
  });
}
