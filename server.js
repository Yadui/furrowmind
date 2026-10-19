// FurrowMind — capture retiring farmers' tacit judgement as verified AI training data.
import express from "express";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { store } from "./store.js";
import { SEED } from "./seed.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
    });

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Retry transient Gemini errors (429/503 high demand) with backoff so demos/judging survive load spikes.
// ---- Cost caps (app level) ----
// Global daily Gemini call budget, counted atomically in Firestore so it holds across instances and restarts.
const DAILY_GEMINI_CAP = Number(process.env.DAILY_GEMINI_CAP || 300);
const MAX_FARMER_TURNS = Number(process.env.MAX_FARMER_TURNS || 6);
const MAX_RECORDS = Number(process.env.MAX_RECORDS || 4);
function capError(msg, code = 429) { const e = new Error(msg); e.code = code; return e; }
async function spendGemini() {
  const day = new Date().toISOString().slice(0, 10);
  await store.txUpdate("usage", day, (cur) => {
    const used = cur?.geminiCalls || 0;
    if (used >= DAILY_GEMINI_CAP) throw capError("Daily AI budget reached for this demo. Please try again tomorrow, or use 'Load simulated sample records' in the Verify tab.");
    return { geminiCalls: used + 1, createdAt: cur?.createdAt || Date.now() };
  });
}
const hits = new Map();
const PER_IP_PER_MIN = Number(process.env.PER_IP_PER_MIN || 30);
function rateLimit(req, res, next) {
  if (req.method !== "POST") return next();
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const now = Date.now(), w = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (w.length >= PER_IP_PER_MIN) return res.status(429).json({ error: "Too many requests. Please wait a minute." });
  w.push(now); hits.set(ip, w);
  if (hits.size > 5000) hits.clear();
  next();
}
app.use("/api", rateLimit);

async function gemini(opts, attempt = 0) {
  if (attempt === 0) await spendGemini();
  try { return await geminiOnce(opts); } catch (e) {
    const msg = String(e?.status || e?.message || e);
    if (attempt < 3 && /429|500|503|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      return gemini(opts, attempt + 1);
    }
    throw e;
  }
}

async function geminiOnce({ system, parts, schema, temperature = 0.4 }) {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: system,
      temperature,
      ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
    },
  });
  return schema ? JSON.parse(res.text) : res.text;
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status([400, 409, 429].includes(e.code) ? e.code : 500).json({ error: e.message || String(e) });
  });

// ---------- Interview (elicitation agent) ----------
const INTERVIEWER = `You are FurrowMind, a patient, respectful field interviewer who elicits TACIT expert judgement from veteran farmers before they retire.
Goal: surface decision rules that are not in textbooks: the sensory cues they notice (smell of soil, leaf colour, insect behaviour, weather signs), the decision they make, WHY, the exceptions, and what a novice gets wrong.
Rules:
- Ask exactly ONE short, concrete follow-up question at a time. Anchor it in something the farmer just said.
- Prefer "tell me about a specific time when..." and "how would you know..." questions. Probe for thresholds, timing, and counter-examples.
- Write nextQuestion in the session language given below (English or Japanese). If Japanese, use simple polite phrasing.
- nextQuestion must never be empty. When done=true, ask a short wrap-up question such as whether there is any exception or warning for a young farmer.
- Track coverage of: cues, decision, rationale, exceptions, novice_mistakes (0-1 each).
- Set done=true once at least 2 distinct decision rules are well covered or after ~8 farmer turns.`;

const turnSchema = {
  type: Type.OBJECT,
  properties: {
    farmerUtterance: { type: Type.STRING, description: "Verbatim transcript of the farmer's latest input (transcribe audio if given)." },
    nextQuestion: { type: Type.STRING },
    coverage: {
      type: Type.OBJECT,
      properties: {
        cues: { type: Type.NUMBER, description: "0.0 to 1.0" }, decision: { type: Type.NUMBER, description: "0.0 to 1.0" }, rationale: { type: Type.NUMBER, description: "0.0 to 1.0" },
        exceptions: { type: Type.NUMBER, description: "0.0 to 1.0" }, novice_mistakes: { type: Type.NUMBER, description: "0.0 to 1.0" },
      },
      required: ["cues", "decision", "rationale", "exceptions", "novice_mistakes"],
    },
    done: { type: Type.BOOLEAN },
  },
  required: ["farmerUtterance", "nextQuestion", "coverage", "done"],
};

function transcriptText(s) {
  return s.transcript.map((t) => `${t.role === "farmer" ? "FARMER" : "INTERVIEWER"}: ${t.text}`).join("\n");
}

// ---- Usage alerts: push to the owner's phone (ntfy.sh) on milestone interviews ----
// NTFY_TOPIC is a private random topic name kept only in the Cloud Run config (never in the repo).
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const MILESTONES = new Set(String(process.env.NOTIFY_MILESTONES || "1,5,10").split(",").map(Number).filter(Boolean));
async function notifyInterview(s) {
  if (!NTFY_TOPIC) return;
  try {
    const { count } = await store.txUpdate("usage", "interviewAlerts", (cur) => ({ count: (cur?.count || 0) + 1, createdAt: cur?.createdAt || Date.now() }));
    if (!MILESTONES.has(count)) return;
    const today = await store.get("usage", new Date().toISOString().slice(0, 10));
    const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    const body = `Interview #${count} just used Gemini.\nFarmer name entered: ${String(s.farmerName).slice(0, 40)} (${s.language === "ja" ? "Japanese" : "English"})\nAI calls today: ${today?.geminiCalls || 0} of ${DAILY_GEMINI_CAP}\n${when} IST`;
    await fetch(`${process.env.NTFY_URL || "https://ntfy.sh"}/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST", body, signal: AbortSignal.timeout(5000),
      headers: { Title: `FurrowMind: interview #${count}`, Tags: "seedling", Priority: count === 1 ? "high" : "default" },
    });
  } catch (e) { console.error("notify failed:", e.message); } // alerts must never break the app
}

app.post("/api/sessions", wrap(async (req, res) => {
  const { farmerName = "Anonymous", region = "", crop = "", years = "", language = "en" } = req.body;
  const opener = language === "ja"
    ? `${farmerName}さん、今日はありがとうございます。${crop || "作物"}を育てる中で、教科書には載っていない「勘」で判断していることを一つ教えていただけますか？`
    : `Thank you for sharing your time, ${farmerName}. In growing ${crop || "your crops"}, what is one decision you make by instinct, something a textbook would never tell a new farmer?`;
  const session = await store.create("sessions", {
    farmerName: String(farmerName).slice(0, 80), region: String(region).slice(0, 80), crop: String(crop).slice(0, 80), years: String(years).slice(0, 10),
    language: language === "ja" ? "ja" : "en", status: "interviewing", farmerTurns: 0, maxTurns: MAX_FARMER_TURNS,
    transcript: [{ role: "interviewer", text: opener }],
    coverage: { cues: 0, decision: 0, rationale: 0, exceptions: 0, novice_mistakes: 0 },
    createdAt: Date.now(),
  });
  res.json(session);
}));

app.get("/api/sessions/:id", wrap(async (req, res) => res.json(await store.get("sessions", req.params.id))));

app.post("/api/sessions/:id/turn", upload.single("audio"), wrap(async (req, res) => {
  if (!(await store.get("sessions", req.params.id))) return res.status(404).json({ error: "session not found" });
  // Atomically reserve a turn so parallel requests can't exceed the limit.
  const s = await store.txUpdate("sessions", req.params.id, (cur) => {
    if (cur.status !== "interviewing") throw capError("This interview is finished. Start a new one to continue.", 409);
    const n = cur.farmerTurns || 0;
    if (n >= MAX_FARMER_TURNS) throw capError(`Turn limit reached (${MAX_FARMER_TURNS} answers). Please extract the judgement records now.`, 400);
    return { farmerTurns: n + 1 };
  });
  const parts = [{ text: `Session language: ${s.language === "ja" ? "Japanese" : "English"}.\nFarmer profile: ${s.farmerName}, ${s.years} years, ${s.crop}, ${s.region}.\nConversation so far:\n${transcriptText(s)}\n\nThe farmer's new input follows.` }];
  if (req.file) parts.push({ inlineData: { mimeType: req.file.mimetype || "audio/webm", data: req.file.buffer.toString("base64") } });
  else parts.push({ text: `FARMER: ${String(req.body.text || "").slice(0, 2000)}` });
  let out;
  try { out = await gemini({ system: INTERVIEWER, parts, schema: turnSchema }); }
  catch (e) { // refund the reserved turn so a failed AI call doesn't consume it
    await store.txUpdate("sessions", s.id, (cur) => ({ farmerTurns: Math.max(0, (cur?.farmerTurns || 1) - 1) })).catch(() => {});
    throw e;
  }
  const farmerMsg = { role: "farmer", text: out.farmerUtterance, audio: !!req.file };
  const nextMsg = { role: "interviewer", text: out.nextQuestion?.trim() || (s.language === "ja" ? "ありがとうございます。若い農家への注意点や例外はありますか？" : "Thank you. Is there any exception or warning you would give a young farmer about this?") };
  // Clamp: models occasionally return 0-100 or >1 values despite the schema.
  const norm = (v) => (v > 10 ? v / 100 : v > 1 ? 1 : v);
  // Append atomically to the latest transcript so concurrent turns can't overwrite each other.
  const saved = await store.txUpdate("sessions", s.id, (cur) => {
    const coverage = Object.fromEntries(Object.entries(out.coverage || {}).map(([k, v]) =>
      [k, Math.max(cur.coverage?.[k] || 0, Math.max(0, Math.min(1, norm(Number(v) || 0))))])); // monotonic: coverage never drops
    return {
      transcript: [...(cur.transcript || []), farmerMsg, nextMsg], coverage,
      readyToExtract: !!(cur.readyToExtract || out.done || (cur.farmerTurns || 0) >= MAX_FARMER_TURNS),
    };
  });
  res.json(saved);
  if (s.farmerTurns === 1) notifyInterview(saved); // first answer got a Gemini reply: count this interview (non-blocking)
}));

// ---------- Extraction + baseline gap (what does a generic model miss?) ----------
const EXTRACTOR = `You convert an interview with a veteran farmer into structured, atomic "judgement records" suitable as AI training data.
Each record captures ONE decision rule. Be faithful: only include what the farmer said; never invent numbers. Write fields in English; keep a short verbatim supporting quote in the original language.
Also write an evaluation prompt: a realistic scenario question a novice farmer might ask an AI assistant, whose ideal answer requires this judgement (do not leak the answer in the question).`;

const recordsSchema = {
  type: Type.OBJECT,
  properties: {
    records: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          task: { type: Type.STRING, description: "Farm task / domain, e.g. irrigation, pest control, harvest timing" },
          context: { type: Type.STRING, description: "Crop, season, region, conditions under which the rule applies" },
          cues: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Observable signals the expert uses" },
          decision: { type: Type.STRING },
          rationale: { type: Type.STRING },
          exceptions: { type: Type.ARRAY, items: { type: Type.STRING } },
          noviceMistake: { type: Type.STRING },
          quote: { type: Type.STRING },
          evalPrompt: { type: Type.STRING },
          expertAnswer: { type: Type.STRING, description: "Ideal answer to evalPrompt written from the expert's judgement" },
        },
        required: ["title", "task", "context", "cues", "decision", "rationale", "exceptions", "noviceMistake", "quote", "evalPrompt", "expertAnswer"],
      },
    },
  },
  required: ["records"],
};

const JUDGE = `You are an agronomy evaluator. Compare a generic AI answer against a veteran farmer's expert answer to the same question.
Score how much expert knowledge the generic answer is MISSING (gap 0-100; 100 = generic answer misses everything important), list the specific insights it missed,
and flag any part of the expert answer that conflicts with mainstream agronomic guidance or could be unsafe (these need human verification, not automatic rejection - local knowledge often differs legitimately).`;

const judgeSchema = {
  type: Type.OBJECT,
  properties: {
    gap: { type: Type.NUMBER },
    missedInsights: { type: Type.ARRAY, items: { type: Type.STRING } },
    flags: { type: Type.ARRAY, items: { type: Type.STRING } },
    novelty: { type: Type.STRING, description: "One sentence: why this judgement is valuable training data" },
  },
  required: ["gap", "missedInsights", "flags", "novelty"],
};

app.post("/api/sessions/:id/extract", wrap(async (req, res) => {
  const existing = await store.get("sessions", req.params.id);
  if (!existing) return res.status(404).json({ error: "session not found" });
  if (existing.status === "extracted") // idempotent: never pay twice for the same interview
    return res.json({ records: (await Promise.all((existing.recordIds || []).map((id) => store.get("records", id)))).filter(Boolean) });
  // Atomically claim extraction so double-clicks / parallel calls can't run it twice.
  const s = await store.txUpdate("sessions", req.params.id, (cur) => {
    if (cur.status === "extracting") throw capError("Extraction is already running for this interview. Please wait.", 409);
    if (cur.status === "extracted") throw capError("Already extracted. Open the Verify tab.", 409);
    if (!(cur.farmerTurns > 0)) throw capError("Answer at least one interview question before extracting.", 400);
    return { status: "extracting" };
  });
  try {
  const { records } = await gemini({
    system: EXTRACTOR, schema: recordsSchema, temperature: 0.2,
    parts: [{ text: `Farmer: ${s.farmerName}, ${s.years} years farming ${s.crop} in ${s.region}.\n\n${transcriptText(s)}` }],
  });
  const saved = await Promise.all(records.slice(0, MAX_RECORDS).map(async (r) => {
    const baseline = await gemini({
      system: "You are a helpful general-purpose farming assistant. Answer concisely (max 120 words).",
      parts: [{ text: r.evalPrompt }], temperature: 0.7,
    });
    const judge = await gemini({
      system: JUDGE, schema: judgeSchema, temperature: 0.1,
      parts: [{ text: `QUESTION: ${r.evalPrompt}\n\nGENERIC AI ANSWER:\n${baseline}\n\nEXPERT ANSWER:\n${r.expertAnswer}` }],
    });
    return store.create("records", {
      ...r, baselineAnswer: baseline, judge, sessionId: s.id,
      expert: { name: s.farmerName, years: s.years, region: s.region, crop: s.crop },
      status: "pending", reviews: [], createdAt: Date.now(),
    });
  }));
  await store.update("sessions", s.id, { status: "extracted", recordIds: saved.map((r) => r.id) });
  res.json({ records: saved });
  } catch (e) {
    await store.update("sessions", s.id, { status: "interviewing" }).catch(() => {}); // release claim so the user can retry
    throw e;
  }
}));

// ---------- Verification ----------
app.get("/api/records", wrap(async (req, res) => {
  let rs = await store.list("records");
  if (req.query.status) rs = rs.filter((r) => r.status === req.query.status);
  res.json(rs.sort((a, b) => b.createdAt - a.createdAt));
}));

app.post("/api/records/:id/review", wrap(async (req, res) => {
  const r = await store.get("records", req.params.id);
  if (!r) return res.status(404).json({ error: "record not found" });
  const { verdict, reviewer = "reviewer", notes = "", edits = {} } = req.body;
  if (!["approve", "reject"].includes(verdict)) return res.status(400).json({ error: "verdict must be approve|reject" });
  const allowed = ["decision", "rationale", "expertAnswer", "context"];
  const patch = {};
  for (const k of allowed) if (typeof edits[k] === "string" && edits[k].trim()) patch[k] = edits[k].trim();
  const reviews = [...(r.reviews || []), { verdict, reviewer, notes, at: Date.now(), edited: Object.keys(patch) }];
  const status = verdict === "approve" ? "verified" : "rejected";
  res.json(await store.update("records", r.id, { ...patch, reviews, status }));
}));

// ---------- Dataset export ----------
app.get("/api/export", wrap(async (req, res) => {
  const fmt = req.query.format || "sft";
  const rs = (await store.list("records")).filter((r) => r.status === "verified");
  const lines = rs.map((r) => {
    const meta = { id: r.id, task: r.task, region: r.expert?.region, crop: r.expert?.crop, expertYears: r.expert?.years, gap: r.judge?.gap, reviews: r.reviews?.length };
    if (fmt === "dpo") return { prompt: r.evalPrompt, chosen: r.expertAnswer, rejected: r.baselineAnswer, metadata: meta };
    if (fmt === "eval") return { input: r.evalPrompt, ideal: r.expertAnswer, rubric: r.judge?.missedInsights, metadata: meta };
    return { messages: [
      { role: "system", content: "You are an agricultural advisor drawing on veteran farmers' field judgement." },
      { role: "user", content: r.evalPrompt },
      { role: "assistant", content: r.expertAnswer },
    ], metadata: meta };
  });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Content-Disposition", `attachment; filename=furrowmind-${fmt}.jsonl`);
  res.send(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}));

app.get("/api/stats", wrap(async (req, res) => {
  const rs = await store.list("records");
  const ss = await store.list("sessions");
  const v = rs.filter((r) => r.status === "verified");
  const avgGap = v.length ? Math.round(v.reduce((a, r) => a + (r.judge?.gap || 0), 0) / v.length) : 0;
  const usage = await store.get("usage", new Date().toISOString().slice(0, 10));
  res.json({ aiCallsToday: usage?.geminiCalls || 0, aiCallCap: DAILY_GEMINI_CAP, maxTurns: MAX_FARMER_TURNS, sessions: ss.length, records: rs.length, verified: v.length, pending: rs.filter((r) => r.status === "pending").length, avgGap, backend: store.kind, model: MODEL });
}));

app.post("/api/seed", wrap(async (req, res) => {
  const existing = await store.list("records");
  if (existing.some((r) => r.simulated && r.status === "pending")) return res.json({ added: 0 });
  const added = await Promise.all(SEED.map((r, i) => store.create("records", { ...r, createdAt: Date.now() - i })));
  res.json({ added: added.length });
}));

app.get("/healthz", (req, res) => res.send("ok"));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`FurrowMind on :${port} (store=${store.kind}, model=${MODEL})`));
