const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function stripHuge(text, max = 12000) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "\n\n[truncated]" : text;
}

function buildSystemPrompt() {
  return {
    role: "system",
    content:
      "You are Neon Voice Agent, a helpful AI call assistant. Be concise, practical, and friendly. " +
      "If the user provides document text, summarize and answer questions using that text. " +
      "If user attaches an image, ask what they want to do with it unless they described it. " +
      "Avoid sensitive data, credentials, or private work content.",
  };
}

// Normalize messages + add attachments as context text (safe + reliable)
function normalizeMessages(messages, attachments) {
  const sys = buildSystemPrompt();

  const clean = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"))
    .map((m) => ({ role: m.role, content: stripHuge(String(m.content ?? "")) }));

  // Attachments are injected as a single user message "context block"
  if (attachments && attachments.length) {
    const attachmentBlock = attachments
      .map((a, i) => {
        const name = a.name || `attachment_${i + 1}`;
        const type = a.type || "unknown";
        const summary = a.text ? stripHuge(a.text, 6000) : "(no extracted text)";
        return `--- Attachment ${i + 1} ---\nName: ${name}\nType: ${type}\nExtracted text:\n${summary}\n`;
      })
      .join("\n");

    clean.push({
      role: "user",
      content:
        "The user attached files. Use this extracted text as reference:\n\n" + attachmentBlock,
    });
  }

  // Keep only last ~12 messages for performance
  return [sys, ...clean].slice(-12);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // Non-stream chat
    if (url.pathname === "/api/chat" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const messages = normalizeMessages(body.messages, body.attachments);

      try {
        const model = body.model || "@cf/meta/llama-3.1-8b-instruct";
        const result = await env.AI.run(model, { messages });
        const reply = result?.response ?? result?.result?.response ?? "";
        return json({ reply });
      } catch (e) {
        return json({ error: "AI failed", details: String(e?.message || e) }, 500);
      }
    }

    // Streaming chat (SSE)
    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const messages = normalizeMessages(body.messages, body.attachments);

      try {
        const model = body.model || "@cf/meta/llama-3.1-8b-instruct";

        // Cloudflare Workers AI supports stream:true and returns SSE stream
        const stream = await env.AI.run(model, { messages, stream: true }); 【3-41f5bc】

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...cors,
          },
        });
      } catch (e) {
        return json({ error: "AI streaming failed", details: String(e?.message || e) }, 500);
      }
    }

    // Static assets
    return env.ASSETS.fetch(request); 【1-3ed571】【2-fef3dc】
  },
};