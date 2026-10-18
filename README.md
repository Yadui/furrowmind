# FurrowMind

**AfterQuery for farming.** Over 70% of Japan's farms have no successor, and every retirement erases decades of expert judgement that no AI model has ever seen. FurrowMind captures that judgement as **verified AI training data** before it's gone.

Theme: **Sustainability & Social Impact**

## What it does
1. **Capture.** A Gemini interviewer elicits *tacit* knowledge from a veteran farmer by text or voice, in Japanese or English. It asks one grounded follow-up at a time, probing for sensory cues, thresholds, rationale, exceptions and novice mistakes, and it shows a live coverage meter.
2. **Extract and measure.** Gemini turns the transcript into atomic **judgement records**. Each record holds the context, cues, decision, rationale, exceptions, a verbatim quote, an eval prompt and the expert's answer. For every record, FurrowMind asks a *generic* model the same question, and a Gemini judge scores the **knowledge gap**: what the generic AI missed, plus any claims that conflict with mainstream guidance.
3. **Verify.** A human reviewer, such as an extension officer or a peer farmer, approves, edits or rejects each record, with the generic and expert answers side by side. Only verified records are exported.
4. **Dataset.** Records export as JSONL in three formats: **SFT** chat examples, **DPO** preference pairs (expert answer chosen, generic answer rejected) and an **eval set** with rubrics built from the missed insights.

## Google Cloud usage
| Service | How it's used |
|---|---|
| **Gemini (Vertex AI / Agent Platform)** via `@google/genai` | Interviewer agent with structured output, multimodal audio transcription, record extraction, the generic baseline, and the LLM-as-judge gap scoring |
| **Firestore** (Firebase Admin SDK) | Sessions, transcripts, records, review audit trail |
| **Cloud Run** | Hosts the Node.js API and the web UI; scales to zero |

Grounding and guardrails: the extraction prompt is constrained to facts stated in the transcript ("never invent numbers"), and every record keeps a verbatim quote for traceability. The judge flags conflicts for human review rather than auto-rejecting them, and nothing reaches the dataset without human verification. All Gemini calls use JSON response schemas.

Latency: the baseline and judge calls for all records run in parallel, and transient 429/503 errors are retried with exponential backoff.

## Cost and abuse protection
| Layer | Limit |
|---|---|
| Interview | Max 6 farmer answers per interview, enforced atomically in a Firestore transaction |
| Extraction | Runs once per interview (repeat calls return the saved records); max 4 records per run |
| Gemini budget | Global cap of 300 AI calls per day, counted in Firestore so it holds across instances and restarts |
| Requests | 30 POST requests per minute per IP; inputs capped (2,000 characters, 5 MB audio) |
| Cloud Run | Scale-to-zero, max 1 instance |
| Billing brake | A Cloud Billing budget publishes to Pub/Sub; the Cloud Function in `ops/billing-kill-switch` disables billing for the project if spend reaches the budget |

## Try it (judges)
- **Quick path:** Capture → *Start interview* → press *Use sample answer* then *Send* 3–4 times (max 6 answers per interview) → *Extract* → **Verify** tab → approve a record → **Dataset** tab → download JSONL.
- **Instant path:** in the Verify tab, click *Load simulated sample records*.
- The sample farmer, Tanaka Hiroshi from Uonuma, Niigata, is **simulated**, and those records are labelled.
- Interview turns take about 3–6 s (median 4.4 s), and *Extract* takes about 20–60 s (median 29 s). Please keep inputs to a few sentences.

## Run locally
```bash
npm install
# Option A: Gemini API key
GEMINI_API_KEY=... npm start
# Option B: Vertex AI + Firestore via Application Default Credentials
GOOGLE_CLOUD_PROJECT=<project> USE_FIRESTORE=1 npm start
```
Without `USE_FIRESTORE=1`, the app uses an in-memory store.

## Deploy
```bash
gcloud run deploy furrowmind --source . --region asia-northeast1 --allow-unauthenticated \
  --set-env-vars USE_FIRESTORE=1,GOOGLE_CLOUD_PROJECT=<project>,GOOGLE_CLOUD_LOCATION=us-central1
```

## API
`POST /api/sessions` · `POST /api/sessions/:id/turn` (JSON `text` or multipart `audio`) · `POST /api/sessions/:id/extract` · `GET /api/records?status=` · `POST /api/records/:id/review` · `GET /api/export?format=sft|dpo|eval` · `GET /api/stats`
