/* =========================================================
   AI 추천 프록시 — Supabase Edge Function 버전
   ---------------------------------------------------------
   이미 Supabase로 일정 동기화를 쓰고 있다면 이 쪽이 편합니다.
   Supabase 대시보드 → Edge Functions → 새 함수(이름: ai-recommend)에
   이 코드를 붙여넣고 배포하세요.

   키 등록: Edge Functions → Secrets에 OPENAI_API_KEY 추가
   배포 후 주소: https://<프로젝트>.supabase.co/functions/v1/ai-recommend
   ========================================================= */

const ALLOWED_ORIGINS = [
  "https://내계정.github.io"
];

const MODEL = "gpt-4o-mini";
const MAX_STOPS = 30;

const SYSTEM_PROMPT = `너는 현지 여행 코디네이터야. 사용자가 준 하루 일정을 참고해서, 동선상 어울리는 장소(카페, 포토스팟, 소품샵, 작은 명소 등) 3에서 5곳을 추천해.
반드시 JSON 배열만 출력하고 다른 텍스트는 쓰지마.
형식: [{"name":"장소명","category":"관광|식사|휴식|선택 중 하나","reason":"추천 이유, 한국어 1에서 2문장"}]`;

function cors(origin: string) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(obj: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

const ROUTE_SYSTEM = `너는 일본 홋카이도 삿포로 지역의 대중교통에 밝은 안내자야.
출발지에서 목적지까지 지하철·버스·노면전차를 이용하는 경로를 알려줘.
실제로 존재하는 노선명(예: 난보쿠선, 도자이선, 도호선)과 역·정류장 이름만 사용해.
역 이름은 한국어 표기 뒤에 괄호로 일본어를 붙여줘 (예: 오도리역(大通駅)).
반드시 JSON 객체만 출력하고 다른 텍스트는 쓰지마.
형식: {"summary":"한 줄 요약","minutes":숫자,"fare":"예상 요금(예: ¥250)","steps":[{"mode":"도보|지하철|버스|전차","line":"노선명 또는 번호(도보면 빈 문자열)","from":"출발 지점","to":"도착 지점","note":"참고 사항"}],"caution":"주의할 점"}`;

async function handleRoute(body: any, origin: string) {
  const city = String(body.city ?? "삿포로").slice(0, 40);
  const f = body.from ?? {}, t = body.to ?? {};
  const fName = String(f.name ?? "").slice(0, 60);
  const tName = String(t.name ?? "").slice(0, 60);
  if (!fName || !tName) return json({ error: "missing from/to" }, 400, origin);

  const date    = String(body.date ?? "").slice(0, 12);
  const weekday = String(body.weekday ?? "").slice(0, 4);
  const dayType = String(body.dayType ?? "").slice(0, 30);

  const userPrompt =
    `도시: ${city}\n` +
    `출발: ${fName}${f.place ? ` (${String(f.place).slice(0,80)})` : ""}` +
    `${f.lat ? ` [${Number(f.lat).toFixed(5)}, ${Number(f.lng).toFixed(5)}]` : ""}\n` +
    `도착: ${tName}${t.place ? ` (${String(t.place).slice(0,80)})` : ""}` +
    `${t.lat ? ` [${Number(t.lat).toFixed(5)}, ${Number(t.lng).toFixed(5)}]` : ""}\n` +
    (date ? `날짜: ${date} ${weekday}요일 (${dayType})\n` : "") +
    `출발 예정 시각: ${String(body.time ?? "낮").slice(0, 10)}\n\n` +
    `해당 요일과 공휴일 여부에 맞는 운행 시간표를 감안해서 소요시간을 잡아줘.\n` +
    `주말·공휴일은 배차 간격이 길어지고 일부 노선은 감축 운행하는 점도 반영해줘.\n` +
    `이 구간의 대중교통 경로를 알려줘.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + Deno.env.get("OPENAI_API_KEY"),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 800,
      messages: [
        { role: "system", content: ROUTE_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) return json({ error: "upstream error", status: res.status }, 502, origin);

  const data = await res.json();
  const content = (data.choices?.[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();
  try {
    return json({ route: JSON.parse(content) }, 200, origin);
  } catch {
    return json({ error: "parse failed" }, 502, origin);
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: "forbidden origin" }, 403, origin);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "bad json" }, 400, origin); }

  // ---- 경로 추정 요청 ----
  if (body.type === "route") return await handleRoute(body, origin);

  const city  = String(body.city  ?? "").slice(0, 40);
  const date  = String(body.date  ?? "").slice(0, 40);
  const theme = String(body.theme ?? "").slice(0, 60);
  const stops = Array.isArray(body.stops) ? body.stops.slice(0, MAX_STOPS) : [];

  const itinerary = stops.map((s: any) =>
    `${String(s.time ?? "").slice(0, 10)} ${String(s.name ?? "").slice(0, 60)} (${String(s.cat ?? "").slice(0, 10)})`
    + (s.note ? ` - ${String(s.note).slice(0, 120)}` : "")
  ).join("\n");

  const f = body.focus ?? null;
  let ask = "이 동선에 자연스럽게 어울리는 현지 장소를 추천해줘.";
  if (f && f.after) {
    const after  = String(f.after).slice(0, 60);
    const before = f.before ? String(f.before).slice(0, 60) : null;
    ask = before
      ? `"${after}"(${String(f.afterTime ?? "").slice(0,10)})을 마치고 "${before}"(${String(f.beforeTime ?? "").slice(0,10)})로 가기 전에 들를 만한 곳을 추천해줘. 두 장소 사이 동선에서 크게 벗어나지 않고, 남는 시간에 맞는 곳으로.`
      : `"${after}"(${String(f.afterTime ?? "").slice(0,10)}) 다음에 이어서 갈 만한 곳을 추천해줘. 도보나 짧은 대중교통으로 갈 수 있는 거리로.`;
  }

  const userPrompt =
    `도시: ${city}\n날짜: ${date}\n테마: ${theme}\n\n오늘 일정:\n${itinerary}\n\n` + ask;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + Deno.env.get("OPENAI_API_KEY"),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) return json({ error: "upstream error", status: res.status }, 502, origin);

  const data = await res.json();
  const content = (data.choices?.[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();

  try {
    return json({ items: JSON.parse(content) }, 200, origin);
  } catch {
    return json({ error: "parse failed" }, 502, origin);
  }
});
