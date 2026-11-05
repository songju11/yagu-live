// =====================================================================
// GET /api/relay?gameId=20260920HHLG02026[&inning=N]
//
// 네이버 스포츠(비공식) 문자중계 API 프록시.
//
//  - inning 있음 → 그 이닝 원본 하나만 (실시간 폴링용. 요청 1번)
//  - inning 없음 → 경기 정보 + 1~15이닝 원본 전부 (다시보기 / 구조 확인용. 요청 최대 16번)
//
// [외부 실측(2026-09)으로 확인된 사실 — 그래도 디버그 화면으로 다시 확인할 것]
//  - 문자중계는 이닝 단위로만 준다: /schedule/games/{gameId}/relay?inning=N
//  - 응답: result.textRelayData = { textRelays: [...], homeLineup, awayLineup, homeEntry, awayEntry, ... }
//  - 아직 안 한 이닝(또는 경기 끝난 뒤의 이닝)을 요청하면 마지막 이닝 데이터를 그대로 돌려준다.
//    → 그래서 textRelays 안에 inn === N 인 타석이 있는지로 "진짜 그 이닝"인지 판단한다.
//  - 경기 정보: /schedule/games/{gameId} → result.game
//  - 요청 헤더에 Referer: https://m.sports.naver.com/ 를 붙여야 안정적으로 응답한다.
// =====================================================================

const { requestJson, jsonResponse, upstreamFailBody } = require("../lib/request-json.js");

const NAVER_API = "https://api-gw.sports.naver.com";
const MAX_INNINGS = 15; // 연장 포함 상한 (포스트시즌 15회)

exports.handler = async function (event) {
  const query = event.queryStringParameters || {};
  const gameId = query.gameId;

  if (!gameId || !/^[0-9A-Za-z]{10,24}$/.test(gameId)) {
    return jsonResponse(400, { ok: false, error: "gameId가 없거나 형식이 이상함", got: gameId });
  }

  // ---------------------------------------------------------------
  // 모드 1: 이닝 하나만
  // ---------------------------------------------------------------
  if (query.inning !== undefined) {
    const inning = parseInt(query.inning, 10);
    if (!(inning >= 1 && inning <= MAX_INNINGS)) {
      return jsonResponse(400, { ok: false, error: "inning은 1~" + MAX_INNINGS, got: query.inning });
    }

    const url = NAVER_API + "/schedule/games/" + gameId + "/relay?inning=" + inning;
    const upstream = await requestJson(url, "naver");
    if (!upstream.ok) {
      const failBody = upstreamFailBody(upstream);
      failBody.provider = "naver";
      return jsonResponse(502, failBody);
    }

    const result = upstream.json.result || {};
    return jsonResponse(200, {
      ok: true,
      provider: "naver",
      mode: "inning",
      gameId: gameId,
      inning: inning,
      // 요청한 이닝의 타석이 실제로 들어 있는지 (false면 아직 그 이닝이 시작 안 한 것)
      inningExists: hasInning(result.textRelayData, inning),
      source: url,
      fetchedAt: new Date().toISOString(),
      result: result, // 네이버 result 원본 그대로
    });
  }

  // ---------------------------------------------------------------
  // 모드 2: 경기 정보 + 전체 이닝
  // ---------------------------------------------------------------
  const gameUrl = NAVER_API + "/schedule/games/" + gameId;

  const inningUrls = [];
  for (let n = 1; n <= MAX_INNINGS; n++) {
    inningUrls.push(NAVER_API + "/schedule/games/" + gameId + "/relay?inning=" + n);
  }

  // 전부 동시에 요청 (순서대로 하면 Netlify 10초 제한에 걸릴 수 있음)
  const gamePromise = requestJson(gameUrl, "naver");
  const inningPromises = [];
  for (const url of inningUrls) {
    inningPromises.push(requestJson(url, "naver"));
  }
  const gameRes = await gamePromise;
  const inningResList = await Promise.all(inningPromises);

  const innings = [];
  const errors = [];

  for (let i = 0; i < inningResList.length; i++) {
    const n = i + 1;
    const res = inningResList[i];

    if (!res.ok) {
      errors.push({ inning: n, status: res.status, error: res.error, bodyHead: res.bodyHead });
      continue;
    }

    const result = res.json.result || {};

    // 아직 안 한 이닝이면 네이버가 마지막 이닝 데이터를 다시 주므로 걸러낸다
    if (!hasInning(result.textRelayData, n)) {
      continue;
    }

    innings.push({ inning: n, result: result });
  }

  // 1회조차 못 받았으면 실패로 처리
  if (innings.length === 0 && errors.length > 0) {
    return jsonResponse(502, {
      ok: false,
      provider: "naver",
      error: "문자중계를 하나도 못 받음",
      errors: errors,
      gameError: gameRes.ok ? null : { status: gameRes.status, error: gameRes.error, bodyHead: gameRes.bodyHead },
    });
  }

  let game = null;
  if (gameRes.ok && gameRes.json.result) {
    game = gameRes.json.result.game || gameRes.json.result;
  }

  return jsonResponse(200, {
    ok: true,
    provider: "naver",
    mode: "all",
    gameId: gameId,
    game: game, // 네이버 경기 정보 원본
    gameError: gameRes.ok ? null : { status: gameRes.status, error: gameRes.error, bodyHead: gameRes.bodyHead },
    lastInning: innings.length > 0 ? innings[innings.length - 1].inning : 0,
    innings: innings, // [{ inning, result(네이버 원본) }]
    errors: errors, // 실패한 이닝 요청 (보통 비어 있어야 함)
    fetchedAt: new Date().toISOString(),
  });
};

// textRelayData 안에 inn === n 인 타석이 하나라도 있는지
function hasInning(textRelayData, n) {
  if (!textRelayData || !Array.isArray(textRelayData.textRelays)) {
    return false;
  }
  for (const relay of textRelayData.textRelays) {
    if (Number(relay.inn) === n) {
      return true;
    }
  }
  return false;
}

