// Supabase Edge Function: sync-chat
// Wan!Sync のデータについて質問に答える。
// クライアントが集計済みのスナップショットを送る。ここではDBを見ない。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `あなたは Wan!Sync の分析アシスタントです。
A.I.KEN リスキリングキャンプの運営データについて、運営メンバーの質問に答えます。

守ること:
- 答えは、渡されたデータに書かれていることだけから作ってください。推測で補わない。
- データにないことを聞かれたら、ないと正直に答えてください。
- 母数が少ない数字を根拠に断定しないでください。件数を添えて述べてください。
- 運営の声は「問題を記録する」性質のデータです。改善点が多いことを
  そのまま「評判が悪い」と解釈しないでください。
- 回答は日本語で、簡潔に。箇条書きは必要なときだけ。`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 有効な利用者（profiles.active）だけが呼べるようにする。anon key だけでは Claude API を使わせない。
async function isActiveUser(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth) return false;
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/is_active`, {
      method: "POST",
      headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", Authorization: auth, "Content-Type": "application/json" },
      body: "{}",
    });
    return res.ok && (await res.json()) === true;
  } catch (_) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!(await isActiveUser(req))) {
    return new Response(JSON.stringify({ error: "ログインが必要です" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { snapshot, messages } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const withContext = [
      {
        role: "user",
        content: `以下が現在の Wan!Sync のデータです。この範囲で答えてください。\n\n${JSON.stringify(snapshot)}`,
      },
      { role: "assistant", content: "データを確認しました。質問をどうぞ。" },
      ...messages,
    ];

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: withContext,
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("Anthropic API error:", errText);
      return new Response(JSON.stringify({ error: "API call failed" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiData = await apiRes.json();
    const reply = apiData?.content?.[0]?.text ?? "";

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
