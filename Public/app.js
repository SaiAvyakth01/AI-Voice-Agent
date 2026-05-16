const $ = (id) => document.getElementById(id);

const log = $("log");
const err = $("err");
const statusEl = $("status");
const dot = $("dot");
const timerEl = $("timer");

const startBtn = $("startCall");
const talkBtn = $("talk");
const endBtn = $("endCall");
const sendBtn = $("send");
const typed = $("typed");

const attachBtn = $("attach");
const fileInput = $("file");
const attachmentsBar = $("attachments");
const clearChatBtn = $("clearChat");

const streamToggle = $("streamToggle");
const myVoiceToggle = $("myVoiceToggle");
const ttsUrl = $("ttsUrl");
const modelSel = $("model");
const modeLabel = $("modeLabel");

const dropZone = $("dropZone");

let seconds = 0;
let timer = null;
let status = "IDLE";
let wavePhase = 0;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canSTT = !!SpeechRecognition;
const canBrowserTTS = "speechSynthesis" in window;

let pendingAttachments = []; // {name,type,text?,dataUrl?}

function setStatus(s) {
  status = s;
  statusEl.textContent = s;

  if (s === "LISTENING") {
    dot.style.background = "rgba(61,255,184,0.95)";
    dot.style.boxShadow = "0 0 14px rgba(61,255,184,0.55)";
  } else if (s === "THINKING") {
    dot.style.background = "rgba(124,108,255,0.95)";
    dot.style.boxShadow = "0 0 14px rgba(124,108,255,0.55)";
  } else if (s === "SPEAKING") {
    dot.style.background = "rgba(255,79,216,0.95)";
    dot.style.boxShadow = "0 0 14px rgba(255,79,216,0.55)";
  } else {
    dot.style.background = "rgba(255,255,255,0.35)";
    dot.style.boxShadow = "0 0 10px rgba(255,255,255,0.15)";
  }
}

function pad(n) { return String(n).padStart(2, "0"); }
function updateTimer() {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  timerEl.textContent = `${pad(m)}:${pad(s)}`;
}
function startTimer() {
  stopTimer();
  seconds = 0;
  updateTimer();
  timer = setInterval(() => { seconds++; updateTimer(); }, 1000);
}
function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function addBubble(role, text, isYou = false) {
  const box = document.createElement("div");
  box.className = `bubble ${isYou ? "you" : ""}`;
  box.innerHTML = `<div class="role">${role}</div><div class="msg"></div>`;
  box.querySelector(".msg").textContent = text;
  log.appendChild(box);
  log.scrollTop = log.scrollHeight;
  return box.querySelector(".msg");
}

function clearAttachments() {
  pendingAttachments = [];
  attachmentsBar.innerHTML = "";
}

function renderAttachments() {
  attachmentsBar.innerHTML = "";
  pendingAttachments.forEach((a, idx) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `
      <span>${a.type.startsWith("image/") ? "🖼️" : "📄"}</span>
      <span>${a.name}</span>
      <button title="remove">✖</button>
    `;
    chip.querySelector("button").onclick = () => {
      pendingAttachments.splice(idx, 1);
      renderAttachments();
    };
    attachmentsBar.appendChild(chip);
  });
}

async function extractTextFromPdf(file) {
  // optional: requires pdfjsLib present
  if (!window.pdfjsLib) return "";
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((it) => it.str).join(" ");
  return text.slice(0, 8000);
}

async function fileToAttachment(file) {
  const a = { name: file.name, type: file.type || "application/octet-stream" };

  // Images: keep dataUrl for preview; do NOT send full base64 to AI by default
  if (a.type.startsWith("image/")) {
    a.dataUrl = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(file);
    });
    a.text = `Image attached: ${a.name} (${a.type}). If you want analysis, describe what you want from the image.`;
    return a;
  }

  // Text-like docs
  const textTypes = ["text/plain", "text/markdown", "text/csv", "application/json"];
  if (textTypes.includes(a.type) || a.name.match(/\.(txt|md|csv|json)$/i)) {
    a.text = await file.text();
    a.text = a.text.slice(0, 12000);
    return a;
  }

  // PDF (optional extraction)
  if (a.type === "application/pdf" || a.name.match(/\.pdf$/i)) {
    const extracted = await extractTextFromPdf(file);
    a.text = extracted
      ? `PDF text (page 1 approx):\n${extracted}`
      : "PDF attached (no text extracted).";
    return a;
  }

  a.text = `File attached: ${a.name} (${a.type}). This file type is not parsed in-browser.`;
  return a;
}

async function handleFiles(fileList) {
  err.textContent = "";
  const files = [...fileList];
  for (const f of files) {
    const att = await fileToAttachment(f);
    pendingAttachments.push(att);
  }
  renderAttachments();
}

attachBtn.onclick = () => fileInput.click();
fileInput.onchange = () => handleFiles(fileInput.files);

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dropActive");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dropActive"));
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropZone.classList.remove("dropActive");
  if (e.dataTransfer?.files?.length) await handleFiles(e.dataTransfer.files);
});

function getHistoryMessages() {
  const bubbles = [...log.querySelectorAll(".bubble")].slice(-10);
  return bubbles.map((b) => {
    const isYou = b.classList.contains("you");
    const msg = b.querySelector(".msg").textContent;
    return { role: isYou ? "user" : "assistant", content: msg };
  });
}

// ---------- VOICE OUTPUT ----------
async function speak(text) {
  const useMyVoice = myVoiceToggle.checked;
  modeLabel.textContent = useMyVoice ? "My Voice (XTTS)" : "Browser Voice";

  // 1) My voice: call local XTTS API server (fastest to integrate)
  // xtts-api-server runs at localhost:8020 by default and is meant to provide an HTTP API. 【4-082e9c】
  if (useMyVoice) {
    try {
      setStatus("SPEAKING");
      const base = ttsUrl.value.trim().replace(/\/$/, "");
      // xtts-api-server has its own endpoints; implementations vary.
      // We use a simple, common pattern: POST /tts with JSON {text}
      const res = await fetch(`${base}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("XTTS server not reachable");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => setStatus("IDLE");
      await audio.play();
      return;
    } catch (e) {
      // fallback to browser TTS
      err.textContent = "My Voice failed; falling back to browser voice.";
    }
  }

  // 2) Browser voice fallback
  if (canBrowserTTS) {
    setStatus("SPEAKING");
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find(v => /Google|Natural|Microsoft/i.test(v.name)) || voices[0];
    u.rate = 1.0;
    u.pitch = 1.0;
    u.onend = () => setStatus("IDLE");
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
}

// ---------- AI CALL ----------
async function callAI(userText) {
  err.textContent = "";
  setStatus("THINKING");

  const history = getHistoryMessages();
  const payload = {
    model: modelSel.value,
    messages: [...history, { role: "user", content: userText }],
    attachments: pendingAttachments.map(a => ({ name: a.name, type: a.type, text: a.text })),
  };

  const useStream = streamToggle.checked;

  if (!useStream) {
    // non-stream
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "API error");

    const reply = String(data?.reply || "");
    addBubble("AI", reply, false);
    clearAttachments();
    await speak(reply);
    setStatus("IDLE");
    return;
  }

  // streaming (SSE)
  const assistantMsgEl = addBubble("AI", "", false);
  let full = "";

  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || "Stream error");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Parse SSE: data: {"response":"..."} or similar chunks
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Split on SSE events
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const p of parts) {
      const line = p.split("\n").find(l => l.startsWith("data:"));
      if (!line) continue;
      const raw = line.replace(/^data:\s*/, "").trim();
      if (raw === "[DONE]") continue;

      try {
        const obj = JSON.parse(raw);
        const chunk = obj?.response || obj?.delta || obj?.text || "";
        if (chunk) {
          full += chunk;
          assistantMsgEl.textContent = full;
          log.scrollTop = log.scrollHeight;
        }
      } catch {
        // Some streams may send plain text chunks
        if (raw) {
          full += raw;
          assistantMsgEl.textContent = full;
        }
      }
    }
  }

  clearAttachments();
  setStatus("IDLE");
  if (full.trim()) await speak(full.trim());
}

// ---------- MIC ----------
function startListening() {
  if (!canSTT) {
    err.textContent = "Mic not supported in this browser. Use typed input.";
    return;
  }

  err.textContent = "";
  setStatus("LISTENING");

  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;

  let finalText = "";

  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalText += t;
      else interim += t;
    }
    typed.value = (finalText + interim).trim();
  };

  rec.onerror = (e) => {
    err.textContent = e?.error ? `Mic error: ${e.error}` : "Mic error";
    setStatus("IDLE");
  };

  rec.onend = async () => {
    setStatus("IDLE");
    const spoken = finalText.trim();
    typed.value = "";
    if (spoken) {
      addBubble("YOU", spoken, true);
      await callAI(spoken);
    }
  };

  rec.start();
}

// ---------- WAVE ----------
const wave = $("wave");
const ctx = wave.getContext("2d");

function drawWave() {
  const w = wave.width, h = wave.height;
  ctx.clearRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "rgba(124,108,255,0.9)");
  grad.addColorStop(0.5, "rgba(255,79,216,0.85)");
  grad.addColorStop(1, "rgba(61,255,184,0.85)");

  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.85;

  const amp =
    status === "LISTENING" ? 26 :
    status === "THINKING"  ? 12 :
    status === "SPEAKING"  ? 22 : 6;

  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const t = (x / w) * Math.PI * 2;
    const y = h/2
      + Math.sin(t * 3 + wavePhase) * amp
      + Math.sin(t * 8 + wavePhase * 1.3) * (amp * 0.35);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 10;
  ctx.stroke();

  wavePhase += 0.05;
  requestAnimationFrame(drawWave);
}

// ---------- UI actions ----------
startBtn.onclick = () => {
  log.innerHTML = "";
  clearAttachments();
  addBubble("AI", "Hi! I’m Neon Voice Agent. Attach files or talk to me.", false);
  startTimer();
  setStatus("IDLE");
};

endBtn.onclick = () => {
  stopTimer();
  setStatus("IDLE");
  if (canBrowserTTS) speechSynthesis.cancel();
};

talkBtn.onclick = () => startListening();

sendBtn.onclick = async () => {
  const text = typed.value.trim();
  if (!text) return;
  typed.value = "";
  addBubble("YOU", text, true);
  try {
    await callAI(text);
  } catch (e) {
    err.textContent = e.message || String(e);
    setStatus("IDLE");
  }
};

typed.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

clearChatBtn.onclick = () => {
  log.innerHTML = "";
  clearAttachments();
  err.textContent = "";
  addBubble("AI", "Chat cleared. Ready when you are.", false);
};

drawWave();
setStatus("IDLE");
updateTimer();
addBubble("AI", "Ready. Start Call to begin.", false);