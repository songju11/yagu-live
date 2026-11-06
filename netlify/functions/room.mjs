// =====================================================================
// POST /api/room — 같은 경기를 보는 사람들끼리 위치·채팅 주고받기 (중계 서버)
//
// 왜 이렇게 하나:
//   사람끼리 직접 연결(P2P)하면 서로 IP 주소가 보인다. 이 함수를 거치면
//   다른 사용자는 서로의 IP를 알 수 없다 (IP는 Netlify 서버만 봄).
//   별도 가입·설정 없이 지금 쓰는 Netlify 사이트 안에서 돌아간다 (Netlify Blobs 저장소).
//
// 저장 구조 (Netlify Blobs, 스토어 이름 "yagu-rooms")
//   {방}/u/{uid}            → 그 사람의 최근 상태 { uid, name, color, state, emote, t }
//   {방}/c/{시간}-{uid}     → 채팅 한 줄 { uid, name, text, at }
//
// 요청 본문
//   { room, uid, name, color, state:{x,y,z,yaw,seated,moving}, emote?:{kind,at}, chat?:"텍스트", chatSince, leave? }
// 응답
//   { ok, now, users:[다른 사람 상태...], chat:[chatSince 이후 채팅...] }
// =====================================================================

import { getStore } from "@netlify/blobs";

export const config = { path: "/api/room" };

const USER_TIMEOUT_MS = 15000; // 15초 동안 소식 없으면 나간 것으로 봄
const CHAT_KEEP_MS = 30 * 60 * 1000; // 채팅은 30분만 보관

export default async function handler(req) {
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "POST만 가능" });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(400, { ok: false, error: "JSON 아님" });
  }

  const room = String(body.room || "");
  const uid = String(body.uid || "");
  if (!/^[0-9A-Za-z]{4,40}$/.test(room) || !/^[0-9A-Za-z]{4,40}$/.test(uid)) {
    return json(400, { ok: false, error: "room/uid 형식 오류" });
  }

  const store = getStore({ name: "yagu-rooms", consistency: "strong" });
  const now = Date.now();
  const userKey = room + "/u/" + uid;

  // 나가기
  if (body.leave) {
    await store.delete(userKey);
    return json(200, { ok: true });
  }

  // 1) 내 상태 저장
  const record = {
    uid: uid,
    name: cleanText(body.name, 12) || "관중",
    color: /^#[0-9a-fA-F]{6}$/.test(String(body.color)) ? body.color : "#d8d8d8",
    state: cleanState(body.state),
    emote: cleanEmote(body.emote),
    t: now,
  };
  await store.setJSON(userKey, record);

  // 2) 채팅 저장
  const chatText = cleanText(body.chat, 80);
  if (chatText) {
    const chatKey = room + "/c/" + String(now).padStart(15, "0") + "-" + uid;
    await store.setJSON(chatKey, { uid: uid, name: record.name, text: chatText, at: now });
  }

  // 3) 같은 방 사람들 읽기
  const userList = await store.list({ prefix: room + "/u/" });
  const userRecords = await Promise.all(
    userList.blobs.map(function (b) {
      return store.get(b.key, { type: "json" }).catch(function () { return null; });
    })
  );
  const users = [];
  const staleKeys = [];
  for (let i = 0; i < userRecords.length; i++) {
    const u = userRecords[i];
    if (!u) continue;
    if (now - u.t > USER_TIMEOUT_MS) {
      staleKeys.push(userList.blobs[i].key);
      continue;
    }
    if (u.uid === uid) continue;
    users.push(u);
  }
  // 오래된 사람 정리 (한 번에 최대 5명)
  await Promise.all(staleKeys.slice(0, 5).map(function (k) { return store.delete(k).catch(function () {}); }));

  // 4) chatSince 이후 채팅 (최근 20개까지)
  const since = Number(body.chatSince) || 0;
  const chatList = await store.list({ prefix: room + "/c/" });
  const chatKeys = chatList.blobs
    .map(function (b) { return b.key; })
    .sort();
  const newKeys = chatKeys
    .filter(function (k) { return chatTime(k) > since; })
    .slice(-20);
  const chat = (await Promise.all(
    newKeys.map(function (k) { return store.get(k, { type: "json" }).catch(function () { return null; }); })
  )).filter(function (c) { return c; });

  // 오래된 채팅 정리 (가끔만)
  if (Math.random() < 0.05) {
    const old = chatKeys.filter(function (k) { return now - chatTime(k) > CHAT_KEEP_MS; }).slice(0, 20);
    await Promise.all(old.map(function (k) { return store.delete(k).catch(function () {}); }));
  }

  return json(200, { ok: true, now: now, users: users, chat: chat });
}

// "방/c/000001762412345678-uid" → 1762412345678
function chatTime(key) {
  const part = key.split("/c/")[1] || "";
  return Number(part.split("-")[0]) || 0;
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function cleanState(s) {
  const st = s || {};
  function num(v) {
    const n = Number(v);
    return isFinite(n) ? Math.max(-500, Math.min(500, Math.round(n * 100) / 100)) : 0;
  }
  return { x: num(st.x), y: num(st.y), z: num(st.z), yaw: num(st.yaw), seated: !!st.seated, moving: !!st.moving };
}

function cleanEmote(e) {
  if (!e || (e.kind !== "cheer" && e.kind !== "wave")) return null;
  const at = Number(e.at);
  return isFinite(at) ? { kind: e.kind, at: at } : null;
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
