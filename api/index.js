const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 600;
const MAX_SESSION_STATE_BYTES = 900;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4000;
const SERPER_TIMEOUT_MS = 1000;
const GEMINI_TIMEOUT_MS = 3200;
const GEMINI_RETRY_DELAY_MS = 120;

const SYSTEM_PROMPT = [
  "Ты — голосовой помощник Яндекс Алисы.",
  "Отвечай по-русски, естественно и кратко: обычно 1–3 предложения.",
  "Не используй Markdown, таблицы, списки и длинные вступления.",
  "Если переданы результаты поиска, используй их для актуальных фактов и не выдумывай данные.",
  "Если вопрос требует актуальных сведений, но результаты поиска не переданы, прямо скажи, что сейчас не удалось проверить информацию. Не угадывай текущие версии, должности, цены, новости, погоду и другие изменяющиеся факты.",
  "Если не знаешь ответа, скажи об этом прямо."
].join(" ");

function truncateUtf8(value, maxBytes) {
  const encoder = new TextEncoder();
  let output = "";
  let used = 0;
  for (const character of String(value)) {
    const size = encoder.encode(character).length;
    if (used + size > maxBytes) break;
    output += character;
    used += size;
  }
  return output;
}

function fitHistory(history) {
  const result = safeHistory(history);
  const encoder = new TextEncoder();
  const serializedSize = () => encoder.encode(JSON.stringify({ history: result })).length;

  while (result.length > 2 && serializedSize() > MAX_SESSION_STATE_BYTES) {
    result.shift();
  }

  if (serializedSize() > MAX_SESSION_STATE_BYTES && result.length === 2) {
    for (const item of result) item.text = truncateUtf8(item.text, 300);
  }

  if (serializedSize() > MAX_SESSION_STATE_BYTES && result.length === 1) {
    result[0].text = truncateUtf8(result[0].text, 700);
  }

  while (result.length && serializedSize() > MAX_SESSION_STATE_BYTES) {
    result.shift();
  }
  return result;
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history: fitHistory(history) }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("REQUEST_TIMEOUT");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { context: "", status: "not_configured", http_status: null, result_count: 0 };
  if (timeoutMs < 150) return { context: "", status: "budget_exhausted", http_status: null, result_count: 0 };

  const startedAt = Date.now();
  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      const result = {
        context: "",
        status: "http_error",
        http_status: response.status,
        result_count: 0
      };
      console.warn("Serper request completed:", { ...result, duration_ms: Date.now() - startedAt });
      return result;
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    const context = items.length ? items.join("\\n") : "";
    const result = {
      context,
      status: context ? "success" : "no_results",
      http_status: response.status,
      result_count: items.length
    };
    console.info("Serper request completed:", { ...result, context: undefined, duration_ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    const timedOut = isTimeoutError(error);
    const result = {
      context: "",
      status: timedOut ? "timeout" : "network_error",
      http_status: null,
      result_count: 0,
      error_name: error?.name || "Error",
      error_code: error?.cause?.code || error?.code || null
    };
    console.warn("Serper request failed:", { ...result, duration_ms: Date.now() - startedAt });
    return result;
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const requestOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        thinkingConfig: { thinkingLevel: "MINIMAL" },
        // Voice responses are short; a smaller cap limits unnecessary generation.
        maxOutputTokens: 256
      }
    })
  };

  const deadline = Date.now() + Math.min(GEMINI_TIMEOUT_MS, timeoutMs);
  let result;

  for (let attempt = 0; attempt < 2; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

    const attemptStartedAt = Date.now();
    try {
      result = await fetchJson(requestUrl, requestOptions, remainingMs);
    } catch (error) {
      console.warn("Gemini request did not complete:", {
        attempt: attempt + 1,
        duration_ms: Date.now() - attemptStartedAt,
        error: error?.name || "Error"
      });
      throw error;
    }
    console.info("Gemini request completed:", {
      attempt: attempt + 1,
      duration_ms: Date.now() - attemptStartedAt,
      http_status: result.response.status
    });
    if (result.response.ok) break;

    const status = Number(result.response.status);
    console.error("Gemini request failed with HTTP", status);

    if ([502, 503, 504].includes(status) && attempt === 0 && deadline - Date.now() > 400) {
      console.warn("Gemini returned a transient HTTP error; retrying once.");
      await new Promise(resolve => setTimeout(resolve, GEMINI_RETRY_DELAY_MS));
      continue;
    }

    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  if (!result?.response?.ok) throw new Error("GEMINI_REQUEST_FAILED");

  const candidate = result.data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (result.data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function isTimeoutError(error) {
  return error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    ["TIME_BUDGET_EXHAUSTED", "REQUEST_TIMEOUT", "AbortError"].includes(error?.message) ||
    /operation was aborted/i.test(String(error?.message || ""));
}

function errorForUser(error) {
  if (isTimeoutError(error)) {
    return "Ответ получается слишком медленно. Попробуйте задать вопрос короче или повторить немного позже.";
  }

  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = fitHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    const needsFreshData = isSearchIntent(text);
    if (needsFreshData) {
      const searchResult = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
      searchContext = searchResult.context;
      console.info("Serper stage completed:", {
        status: searchResult.status,
        duration_budget_ms: Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)),
        http_status: searchResult.http_status,
        result_count: searchResult.result_count,
        results_available: Boolean(searchContext)
      });
    }

    const geminiInput = needsFreshData && !searchContext
      ? `${text}\\n\\nВАЖНО: актуальные данные не удалось получить через поиск. Не сообщай текущие сведения как факт и не делай предположений. Кратко объясни, что проверить актуальную информацию сейчас не удалось.`
      : text;

    const answer = await askGemini(
      geminiInput,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = fitHistory([
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ]);

    console.info("Alice webhook completed:", {
      duration_ms: Date.now() - startedAt,
      outcome: "success"
    });
    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = isTimeoutError(error) ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Alice webhook returned a fallback response:", {
      duration_ms: Date.now() - startedAt,
      error: safeError?.message || "unknown error",
      name: error?.name || "Error"
    });
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, errorForUser, fitAliceText, fitHistory, isSearchIntent, isTimeoutError, safeHistory };
