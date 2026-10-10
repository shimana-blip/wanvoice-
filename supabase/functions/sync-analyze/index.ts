// Supabase Edge Function: sync-analyze
// 運営の声と受講者の声を意味で突き合わせ、整合性4分類と SYNC SCORE を返す。
// Voice の classify-feedback と同じ流儀（同一の ANTHROPIC_API_KEY を共有）。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";

const VERDICTS = ["一致", "ギャップ", "潜在課題", "運営先行"] as const;

const SYSTEM_PROMPT = `あなたはリスキリングキャンプの運営データ分析アシスタントです。
同じ開催・同じコマについて集まった「運営の声」と「受講者アンケートの自由記述」を読み、
運営側の認識と受講者側の認識がどう重なっているかを判定します。

分類は次の4つのいずれかです。
- 一致: 運営と受講者が同じ課題・同じ評価を挙げている
- ギャップ: 運営の認識と受講者の評価が食い違っている
- 潜在課題: 受講者だけが感じている問題で、運営の声には出ていない
- 運営先行: 運営だけが問題視していて、受講者の声にはまだ大きく出ていない

判断根拠は必ず両方の入力に書かれている内容だけを使い、書かれていないことを推測で補わないでください。
受講者の自由記述が事実上ないか、判断材料が薄い場合は正直にそう述べてください。

返答は必ず JSON 形式のみで、前置きや説明文を含めないでください:
{
  "verdict": "一致" | "ギャップ" | "潜在課題" | "運営先行",
  "sync_score": 0から100の整数（両者の認識がどれだけ重なっているか）,
  "summary": "2文以内の日本語要約",
  "basis": "判断の根拠にした具体的な発言（両方から）"
}`;

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

type ReqBody = {
  contentLabel?: string;
  staffVoices: string[];
  learnerVoices: string[];
};

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
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: ReqBody = await req.json();
    const { contentLabel, staffVoices, learnerVoices } = body;

    if (!Array.isArray(staffVoices) || !Array.isArray(learnerVoices)) {
      return new Response(
        JSON.stringify({ error: "staffVoices and learnerVoices must be arrays" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (staffVoices.length === 0 && learnerVoices.length === 0) {
      return new Response(
        JSON.stringify({ error: "no voices to compare" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userText = [
      contentLabel ? `対象コマ: ${contentLabel}` : "対象: 開催全体",
      "",
      "【運営の声】",
      staffVoices.length ? staffVoices.map((v, i) => `${i + 1}. ${v}`).join("\n") : "(なし)",
      "",
      "【受講者の自由記述】",
      learnerVoices.length ? learnerVoices.map((v, i) => `${i + 1}. ${v}`).join("\n") : "(なし)",
    ].join("\n");

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userText }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("Anthropic API error:", errText);
      return new Response(
        JSON.stringify({ error: "API call failed" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiData = await apiRes.json();
    const text = apiData?.content?.[0]?.text ?? "";

    let parsed: {
      verdict: string; sync_score: number; summary: string; basis: string;
    } | null = null;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch (_) {
      // parsed は null のまま下で処理
    }

    if (!parsed || !VERDICTS.includes(parsed.verdict as typeof VERDICTS[number])) {
      return new Response(
        JSON.stringify({ error: "unparseable model output", raw: text }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.sync_score) || 0)));

    return new Response(
      JSON.stringify({
        verdict: parsed.verdict,
        sync_score: score,
        summary: parsed.summary ?? "",
        basis: parsed.basis ?? "",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
