
import { Agent, getAgentByName } from "agents";

interface Env {
  AI: Ai;
  AI_AGENT: DurableObjectNamespace<MyAiAgent>;
}

interface MessageRow {
  sender: string;
  text: string;
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class MyAiAgent extends Agent<Env> {
  async onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/chat" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const body = await request.json() as { message?: unknown };
      const message = body.message;

      if (
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 2000
      ) {
        return Response.json(
          { error: "Enter a message of 1-2000 characters." },
          { status: 400 }
        );
      }

      // Retrieve conversation history in chronological order.
      const recent = this.sql<MessageRow>`
        SELECT sender, text FROM messages
        ORDER BY id DESC LIMIT 20
      `.reverse();

      const messages = [
        {
          role: "system",
          content:
            "You are SI Agent, a helpful technical deployment " +
            "and project coordination assistant. Help users " +
            "identify risks, coordinate contractors, organize " +
            "work, and plan technical deployments. Do not " +
            "invent project facts. Be concise and practical."
        },
        ...recent.map(row => ({
          role: row.sender,
          content: row.text
        })),
        { role: "user", content: message.trim() }
      ];

      // Use Cloudflare Workers AI.
      const result = await this.env.AI.run(MODEL, {
        messages,
        max_tokens: 500
      });

      const reply = result.response;

      if (typeof reply !== "string" || !reply.trim()) {
        throw new Error("AI returned no text.");
      }

      // Persist the conversation after a successful response.
      this.sql`
        INSERT INTO messages (sender, text)
        VALUES (${"user"}, ${message.trim()})
      `;
      this.sql`
        INSERT INTO messages (sender, text)
        VALUES (${"assistant"}, ${reply})
      `;

      return Response.json({ response: reply });
    } catch (error) {
      console.error("Chat error:", error);
      return Response.json(
        { error: "The AI request failed. Check Worker logs." },
        { status: 500 }
      );
    }
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SI Agent - Technical Deployment Assistant</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, Arial, sans-serif;
    background: #f3f6fa;
    margin: 0;
    color: #172033;
  }
  main {
    max-width: 760px;
    margin: 35px auto;
    padding: 20px;
  }
  h1 { margin-bottom: 4px; }
  .subtitle { color: #64748b; margin-bottom: 25px; }
  #chat {
    height: 55vh;
    min-height: 340px;
    overflow-y: auto;
    background: white;
    border: 1px solid #dbe3ed;
    border-radius: 12px;
    padding: 18px;
  }
  .message {
    margin: 12px 0;
    padding: 12px 15px;
    border-radius: 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .user { background: #dbeafe; margin-left: 15%; }
  .assistant { background: #f1f5f9; margin-right: 15%; }
  form { display: flex; gap: 8px; margin-top: 12px; }
  input {
    flex: 1;
    min-width: 0;
    padding: 13px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    font-size: 16px;
  }
  button {
    background: #2563eb;
    color: white;
    border: 0;
    border-radius: 8px;
    padding: 12px 18px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: wait; }
  #status { color: #64748b; min-height: 24px; }
</style>
</head>
<body>
<main>
  <h1>SI Agent</h1>
  <p class="subtitle">AI-powered Technical Deployment Assistant</p>
  <div id="chat" aria-live="polite"></div>
  <form id="form">
    <input id="message" maxlength="2000"
      placeholder="Ask about deployment risks or project plans..."
      required autocomplete="off">
    <button id="send" type="submit">Send</button>
  </form>
  <p id="status"></p>
</main>
<script>
  const chat = document.getElementById("chat");
  const form = document.getElementById("form");
  const input = document.getElementById("message");
  const send = document.getElementById("send");
  const status = document.getElementById("status");

  // A unique anonymous session for each browser.
  let session = localStorage.getItem("si-agent-session");
  if (!session) {
    session = crypto.randomUUID();
    localStorage.setItem("si-agent-session", session);
  }

  function addMessage(sender, text) {
    const div = document.createElement("div");
    div.className = "message " + sender;
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  addMessage("assistant",
    "Hello! I'm SI Agent. How can I help with your project?");

  form.addEventListener("submit", async function(event) {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    addMessage("user", message);
    input.value = "";
    send.disabled = true;
    status.textContent = "AI is thinking...";

    try {
      const response = await fetch(
        "/chat?session=" + encodeURIComponent(session),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Request failed");
      }

      addMessage("assistant", data.response);
      status.textContent = "";
    } catch (error) {
      status.textContent = "Error: " + error.message;
    } finally {
      send.disabled = false;
      input.focus();
    }
  });
</script>
</body>
</html>`;


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    const allowedOrigins = [
      "https://ermiao.duckdns.org"
    ];

    const corsHeaders = {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if (origin && allowedOrigins.includes(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    }

    if (url.pathname === "/chat" &&
        request.method === "OPTIONS") {
      if (!origin || !allowedOrigins.includes(origin)) {
        return new Response("Forbidden", { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (url.pathname === "/chat") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: corsHeaders
        });
      }

      const session = url.searchParams.get("session");

      if (!session ||
          !/^[0-9a-f-]{36}$/.test(session)) {
        return Response.json(
          { error: "Invalid session" },
          { status: 400, headers: corsHeaders }
        );
      }

      const id = env.AI_AGENT.idFromName(session);
      const stub = env.AI_AGENT.get(id);
      const response = await stub.fetch(request);

      const result = new Response(response.body, response);

      for (const [key, value] of
           Object.entries(corsHeaders)) {
        result.headers.set(key, value);
      }

      return result;
    }

    return new Response(
      "Cloudflare AI Agent is running!",
      { status: 200 }
    );
  }
};

} satisfies ExportedHandler<Env>;
