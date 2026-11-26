import test from "node:test";
import assert from "node:assert/strict";
import handler, { aliceResponse, errorForUser, fitAliceText, fitHistory, isSearchIntent, isTimeoutError, safeHistory } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Какая последняя версия Ubuntu Server LTS?"), true);
  assert.equal(isSearchIntent("Какие процессоры AMD Ryzen вышли в 2026 году?"), true);
  assert.equal(isSearchIntent("Кто сейчас генеральный директор NVIDIA?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 4", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 4);
  assert.equal(result[0].text, "8");
  assert.equal(result[3].text, "11");
});

test("session history stays within the 1 KB Yandex state limit", () => {
  const input = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: `Сообщение ${i}: ${"длинный текст ".repeat(100)}`
  }));
  const result = fitHistory(input);
  assert.ok(new TextEncoder().encode(JSON.stringify({ history: result })).length <= 900);
  assert.equal(result.at(-1).role, "model");
  assert.ok(result.at(-1).text.length < input.at(-1).text.length);
  assert.ok(result.length < input.length);
});

test("GET health check returns an ok response", async () => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

test("Gemini 503 is retried once and the answer is returned", async t => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "test-key";

  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "temporary unavailable" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Проверочный ответ" }] } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  try {
    let payload;
    const res = {
      status() { return this; },
      json(value) { payload = value; return value; },
      setHeader() {}
    };
    await handler({ method: "POST", body: { request: { command: "Расскажи что-нибудь" } } }, res);
    assert.equal(calls, 2);
    assert.equal(payload.response.text, "Проверочный ответ");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
  }
});

test("Node.js fetch abort messages are classified as timeouts", () => {
  const error = new Error("This operation was aborted");
  assert.equal(isTimeoutError(error), true);
  assert.match(errorForUser(error), /слишком медленно/);
  assert.equal(isTimeoutError(new Error("GEMINI_KEY_REJECTED")), false);
});


test("freshness questions use Serper results before Gemini", async t => {
  const previousSerperKey = process.env.SERPER_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  process.env.SERPER_API_KEY = "serper-test-key";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  let calls = 0;
  let geminiBody;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls += 1;
    if (String(url).includes("google.serper.dev")) {
      assert.equal(options.headers["X-API-KEY"], "serper-test-key");
      return new Response(JSON.stringify({
        organic: [{ title: "Погода в Хельсинки", snippet: "Обновлённые данные", link: "https://example.test/weather" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    geminiBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Ответ по результатам поиска" }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    let payload;
    const res = { status() { return this; }, json(value) { payload = value; return value; }, setHeader() {} };
    await handler({ method: "POST", body: { request: { command: "Какая погода сегодня в Хельсинки?" } } }, res);
    assert.equal(calls, 2);
    assert.match(geminiBody.contents.at(-1).parts[0].text, /Обновлённые данные/);
    assert.equal(payload.response.text, "Ответ по результатам поиска");
  } finally {
    if (previousSerperKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = previousSerperKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
  }
});

test("when Serper fails, Gemini is explicitly told not to guess current facts", async t => {
  const previousSerperKey = process.env.SERPER_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  process.env.SERPER_API_KEY = "serper-test-key";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  let geminiBody;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("google.serper.dev")) {
      return new Response(JSON.stringify({ error: "temporary failure" }), { status: 503 });
    }
    geminiBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Сейчас не удалось проверить актуальную информацию." }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    let payload;
    const res = { status() { return this; }, json(value) { payload = value; return value; }, setHeader() {} };
    await handler({ method: "POST", body: { request: { command: "Какая погода сегодня?" } } }, res);
    assert.equal(payload.response.text, "Сейчас не удалось проверить актуальную информацию.");
    assert.match(geminiBody.contents.at(-1).parts[0].text, /актуальные данные не удалось получить через поиск/);
  } finally {
    if (previousSerperKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = previousSerperKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
  }
});
