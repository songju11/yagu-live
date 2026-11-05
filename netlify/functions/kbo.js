// =====================================================================
// KBO 공식 홈페이지(모바일) 프록시 — 네이버가 막힐 때 쓰는 2순위 소스
//
//  GET /api/kbo?type=games&date=YYYYMMDD
//      → 그날 경기 목록. 시리즈(srId) 0~10을 전부 조회해서 합친다.
//        (0 정규시즌, 1 시범경기, 3 준플레이오프, 4 와일드카드, 5 플레이오프, 7 한국시리즈 … 공개 코드 기준)
//
//  GET /api/kbo?type=relay&gameId=20261104KTSS0&srId=7&inning=1
//      → 그 이닝 문자중계(GetLiveText) + 경기 후 결과(GetLiveTextResult)
//
// [참고한 공개 코드: Civa030203/KBO-Info, KBO 공식 m.koreabaseball.com 내부 호출]
//  - 경기 목록 응답: { game: [ { G_ID, G_DT_TXT, G_TM, S_NM, AWAY_ID, HOME_ID, AWAY_NM, HOME_NM,
//                               T_SCORE_CN, B_SCORE_CN, CANCEL_SC_ID, ... } ] }
//  - 문자중계 응답: listInnTb[] → listBatOrder[] → 텍스트(LIVETEXT_IF), 스타일(TEXTSTYLE_SC)
//    네이버와 달리 투구마다 구종/구속/아웃·주자 상태가 붙어 있지 않을 가능성이 큼 → 응답으로 확인 필요
//  - KBO gameId는 네이버와 다르다: 20261104KTSS0 (연도 4자리 꼬리 없음)
// =====================================================================

const { requestJson, jsonResponse, upstreamFailBody, todayInKorea } = require("../lib/request-json.js");

const KBO_MOBILE_WS = "https://m.koreabaseball.com/ws/Kbo.asmx";

exports.handler = async function (event) {
  const query = event.queryStringParameters || {};
  const type = query.type || "games";

  switch (type) {
    case "games":
      return await handleGames(query);
    case "relay":
      return await handleRelay(query);
    default:
      return jsonResponse(400, { ok: false, provider: "kbo", error: "type은 games 또는 relay", got: type });
  }
};

// ---------------------------------------------------------------------
// 경기 목록
// ---------------------------------------------------------------------
async function handleGames(query) {
  const date = query.date || todayInKorea();
  if (!/^\d{8}$/.test(date)) {
    return jsonResponse(400, { ok: false, provider: "kbo", error: "date는 YYYYMMDD", got: date });
  }

  // 시리즈 0~10 동시 조회
  const srIds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const promises = [];
  for (const srId of srIds) {
    const url = KBO_MOBILE_WS + "/GetKboGameList?leId=1&srId=" + srId + "&date=" + date;
    promises.push(requestJson(url, "kbo"));
  }
  const results = await Promise.all(promises);

  const games = [];
  const bySeries = [];
  let failCount = 0;
  let firstFail = null;

  for (let i = 0; i < results.length; i++) {
    const srId = srIds[i];
    const res = results[i];

    if (!res.ok) {
      failCount++;
      if (!firstFail) firstFail = res;
      bySeries.push({ srId: srId, ok: false, status: res.status, error: res.error });
      continue;
    }

    const list = res.json && Array.isArray(res.json.game) ? res.json.game : [];
    bySeries.push({ srId: srId, ok: true, count: list.length });

    for (const g of list) {
      // 원본에 우리가 조회한 srId만 덧붙여서 그대로 넘긴다 (문자중계 요청에 필요)
      const copy = Object.assign({}, g);
      copy._srId = srId;
      games.push(copy);
    }
  }

  // 11개 다 실패하면 실패로
  if (failCount === srIds.length) {
    const failBody = upstreamFailBody(firstFail);
    failBody.provider = "kbo";
    return jsonResponse(502, failBody);
  }

  return jsonResponse(200, {
    ok: true,
    provider: "kbo",
    date: date,
    count: games.length,
    bySeries: bySeries,
    games: games, // KBO 원본 필드 그대로 (+ _srId)
  });
}

// ---------------------------------------------------------------------
// 문자중계
// ---------------------------------------------------------------------
async function handleRelay(query) {
  const gameId = query.gameId;
  const srId = query.srId || "0";
  const inning = query.inning || "1";

  if (!gameId || !/^[0-9A-Za-z]{10,20}$/.test(gameId)) {
    return jsonResponse(400, { ok: false, provider: "kbo", error: "gameId(KBO 형식, 예 20261104KTSS0)가 필요함", got: gameId });
  }

  const liveUrl =
    KBO_MOBILE_WS + "/GetLiveText?le_id=1&sr_id=" + encodeURIComponent(srId) +
    "&g_id=" + encodeURIComponent(gameId) +
    "&inning=" + encodeURIComponent(inning) +
    "&order=ASC";
  const resultUrl =
    KBO_MOBILE_WS + "/GetLiveTextResult?le_id=1&sr_id=" + encodeURIComponent(srId) +
    "&g_id=" + encodeURIComponent(gameId);

  const liveRes = await requestJson(liveUrl, "kbo");
  const resultRes = await requestJson(resultUrl, "kbo");

  if (!liveRes.ok) {
    const failBody = upstreamFailBody(liveRes);
    failBody.provider = "kbo";
    return jsonResponse(502, failBody);
  }

  return jsonResponse(200, {
    ok: true,
    provider: "kbo",
    gameId: gameId,
    srId: srId,
    inning: inning,
    live: liveRes.json, // KBO 원본
    postGame: resultRes.ok ? resultRes.json : null,
    postGameError: resultRes.ok ? null : { status: resultRes.status, error: resultRes.error },
    ms: liveRes.ms,
  });
}
