const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let session = null;
let sampleIdx = 0;

const SAMPLES = [
  "I decide when to drain the paddy for mid-season drying (nakaboshi) by the tillers, not the calendar. When a hill reaches about 20 to 22 stems, I walk the field in the morning. If the water smells a little sour and bubbles come up when I step, the roots are suffocating, so I drain that week even if the book says wait.",
  "Last year was a good example. It was a cool July and the agriculture office said drain on the 5th. But the plants in the lower terraces were still pale and only had 15 stems, so I held the water 6 more days there. The upper terraces I drained on time. Lower fields get cold mountain water, so they always lag.",
  "Young farmers drain until the soil cracks wide, like a finger can go in. That is too much for our clay, because the fine roots tear and then the rice lodges at harvest. I drain until there are small cracks, like a turtle's back, and you can walk without sinking past the ankle. Then I let water back in.",
  "Another thing: if the swallows fly very low over the paddy in the evening and the frogs are loud, rain is coming within a day. Then I don't bother to drain, because the rain refills it and the work is wasted. I wait until after the rain.",
  "Exceptions? In a year with a lot of blast disease nearby, I drain a bit earlier and harder, because a wet canopy invites blast. And on the sandy field by the river I barely drain at all, because it drains itself.",
];

document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button, .tab").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    $("#" + b.dataset.tab).classList.add("on");
    if (b.dataset.tab === "verify") loadQueue();
    if (b.dataset.tab === "dataset") loadDataset();
  })
);

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function busy(btn, fn) {
  btn.disabled = true; btn.classList.add("spin");
  try { return await fn(); } catch (e) { alert("Error: " + e.message); } finally { btn.disabled = false; btn.classList.remove("spin"); }
}

function renderSession() {
  $("#chatLog").innerHTML = session.transcript.map((t) =>
    `<div class="msg ${t.role}"><span class="who">${t.role === "farmer" ? esc(session.farmerName) + (t.audio ? " 🎙" : "") : "FurrowMind (Gemini)"}</span>${esc(t.text)}</div>`).join("");
  $("#chatLog").scrollTop = 1e9;
  const labels = { cues: "Sensory cues", decision: "Decision", rationale: "Rationale", exceptions: "Exceptions", novice_mistakes: "Novice mistakes" };
  $("#coverage").innerHTML = Object.entries(labels).map(([k, l]) => {
    const v = Math.round((session.coverage?.[k] || 0) * 100);
    return `<div class="small">${l} · ${v}%</div><div class="bar"><i style="width:${v}%"></i></div>`;
  }).join("") + (session.readyToExtract ? `<p class="small" style="color:var(--green)">✓ Enough material to extract records</p>` : "");
}

$("#start").onclick = (e) => busy(e.target, async () => {
  session = await post("/api/sessions", {
    farmerName: $("#fName").value, years: $("#fYears").value, crop: $("#fCrop").value, region: $("#fRegion").value, language: $("#fLang").value,
  });
  sampleIdx = 0;
  $("#setup").classList.add("hidden"); $("#interview").classList.remove("hidden");
  renderSession();
});

$("#sample").onclick = () => { $("#answer").value = SAMPLES[sampleIdx++ % SAMPLES.length]; };

async function sendTurn(form) {
  session = await api(`/api/sessions/${session.id}/turn`, form);
  renderSession();
}
$("#send").onclick = (e) => busy(e.target, async () => {
  const text = $("#answer").value.trim(); if (!text) return;
  await sendTurn({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  $("#answer").value = "";
});

let recorder = null, chunks = [];
$("#mic").onclick = async (e) => {
  const btn = e.currentTarget;
  if (recorder) { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream); chunks = [];
    recorder.ondataavailable = (ev) => chunks.push(ev.data);
    recorder.onstop = () => busy(btn, async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove("rec"); btn.textContent = "🎙 Speak";
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" }); recorder = null;
      const fd = new FormData(); fd.append("audio", blob, "answer.webm");
      await sendTurn({ method: "POST", body: fd });
    });
    recorder.start(); btn.classList.add("rec"); btn.textContent = "■ Stop & send";
  } catch (err) { alert("Microphone unavailable: " + err.message); }
};

$("#extract").onclick = (e) => busy(e.target, async () => {
  $("#extractOut").innerHTML = `<p class="small muted">Gemini is structuring the records, asking a generic model the same questions, and judging the knowledge gap…</p>`;
  const { records } = await post(`/api/sessions/${session.id}/extract`, {});
  $("#extractOut").innerHTML = `<p><b>${records.length} judgement records</b> extracted:</p><ul class="small">${records.map((r) => `<li>${esc(r.title)} (gap ${r.judge.gap})</li>`).join("")}</ul><button class="wide" onclick="document.querySelector('[data-tab=verify]').click()">Go to verification →</button>`;
  refreshBadge();
});

function recordCard(r, withActions) {
  const j = r.judge || {};
  return `<div class="card rec-card" id="r-${r.id}">
    <h3><span>${esc(r.title)}</span><span class="pill ${r.status}">${r.status}</span></h3>
    <div class="small muted">${esc(r.task)} · ${esc(r.expert?.name)} (${esc(r.expert?.years)} yrs, ${esc(r.expert?.region)})</div>
    <dl><dt>Context</dt><dd>${esc(r.context)}</dd><dt>Cues</dt><dd>${(r.cues || []).map(esc).join(" · ")}</dd>
    <dt>Decision</dt><dd>${esc(r.decision)}</dd><dt>Why</dt><dd>${esc(r.rationale)}</dd>
    <dt>Exceptions</dt><dd>${(r.exceptions || []).map(esc).join(" · ") || "-"}</dd><dt>Novice mistake</dt><dd>${esc(r.noviceMistake)}</dd></dl>
    <p class="quote">"${esc(r.quote)}"</p>
    <p><b>Eval prompt:</b> ${esc(r.evalPrompt)}</p>
    <div class="cmp"><div><b>Generic AI answer</b><br>${esc(r.baselineAnswer)}</div><div class="exp"><b>Expert answer</b><br>${esc(r.expertAnswer)}</div></div>
    <div class="row" style="align-items:flex-start;gap:24px">
      <div><div class="small muted">Knowledge gap</div><div class="gap">${j.gap ?? "-"}</div></div>
      <div style="flex:1"><div class="small muted">Generic AI missed</div><ul class="small">${(j.missedInsights || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${j.flags?.length ? `<div class="small muted">⚠ Needs human check</div><ul class="small flags">${j.flags.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="small muted">${esc(j.novelty)}</div></div>
    </div>
    ${withActions ? `<label>Edit the expert answer if needed<textarea rows="3" id="ed-${r.id}">${esc(r.expertAnswer)}</textarea></label>
    <label>Reviewer notes<input id="nt-${r.id}" placeholder="e.g. consistent with local Uonuma practice" /></label>
    <div class="row" style="margin-top:10px"><button class="primary" onclick="review('${r.id}','approve',this)">✓ Verify</button><button onclick="review('${r.id}','reject',this)">✗ Reject</button></div>`
    : (r.reviews || []).map((v) => `<div class="small muted">✓ ${esc(v.verdict)} by ${esc(v.reviewer)}${v.notes ? ": " + esc(v.notes) : ""}</div>`).join("")}
  </div>`;
}

window.review = (id, verdict, btn) => busy(btn, async () => {
  const original = $(`#ed-${id}`).defaultValue, edited = $(`#ed-${id}`).value;
  await post(`/api/records/${id}/review`, {
    verdict, reviewer: $("#reviewer").value, notes: $(`#nt-${id}`).value,
    edits: edited !== original ? { expertAnswer: edited } : {},
  });
  $(`#r-${id}`).remove(); refreshBadge();
});

async function loadQueue() {
  const rs = await api("/api/records?status=pending");
  $("#queue").innerHTML = rs.length ? rs.map((r) => recordCard(r, true)).join("") : `<div class="card muted">Nothing waiting for review. Capture an interview first.</div>`;
}
async function loadDataset() {
  const [s, rs] = await Promise.all([api("/api/stats"), api("/api/records?status=verified")]);
  $("#stats").innerHTML = [["Interviews", s.sessions], ["Records", s.records], ["Verified", s.verified], ["Pending", s.pending], ["Avg knowledge gap", s.avgGap]]
    .map(([l, v]) => `<div><b>${v}</b><span class="small muted">${l}</span></div>`).join("");
  $("#verifiedList").innerHTML = rs.map((r) => recordCard(r, false)).join("");
}
async function refreshBadge() {
  try { const s = await api("/api/stats"); $("#pendingN").textContent = s.pending || ""; } catch {}
}
refreshBadge();
$("#seedBtn").onclick = (e) => busy(e.target, async () => { await post("/api/seed", {}); await loadQueue(); refreshBadge(); });
