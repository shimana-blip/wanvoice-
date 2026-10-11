// 管理者がメンバーを招待する／ログイン用リンクを発行する。
// メールは送らず、Wan!Voice を直接開く「招待リンク」を返す。管理者がそれを LINE やメールで本人に渡す。
// （Supabase Auth のリダイレクト設定に左右されず、メールの送信数制限にもかからない）
//
// - 呼び出し元のログイン（JWT）を確認し、profiles で「有効な管理者」の場合だけ実行する
// - service_role キーはこの関数の中（Supabase のサーバー側）だけで使う。フロントエンドには絶対に置かない
// - action = 'invite'（既定）：新しいユーザーを作り、招待リンクを返す。profiles はトリガーが staff で作るので、表示名と役割をここで確定する
// - action = 'link'：既存ユーザー（user_id 指定）に、パスワードを設定し直すためのリンクを返す（招待リンクの再発行にも使う）
// - リンクは Wan!Voice の ?token_hash=...&type=invite|recovery。開くと「パスワードを設定」画面になる。有効期限は Auth の設定（既定 1 時間）
import { createClient } from 'npm:@supabase/supabase-js@2'

const APP_URL = Deno.env.get('APP_URL') ?? 'https://shimana-blip.github.io/wanvoice-/'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

function appLink(hashedToken: string, type: 'invite' | 'recovery') {
  const u = new URL(APP_URL)
  u.searchParams.set('token_hash', hashedToken)
  u.searchParams.set('type', type)
  return u.toString()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST だけ受け付けます' }, 405)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false }
  })

  // 呼び出し元の確認
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: caller, error: callerErr } = await admin.auth.getUser(jwt)
  if (callerErr || !caller?.user) return json({ error: 'ログインが必要です' }, 401)

  const { data: me } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', caller.user.id)
    .maybeSingle()
  if (!me || !me.active || me.role !== 'admin') return json({ error: '管理者だけが使えます' }, 403)

  let body: { action?: string; email?: string; display_name?: string; role?: string; user_id?: string }
  try { body = await req.json() } catch { return json({ error: '入力を読めませんでした' }, 400) }

  // 既存ユーザーにリンクを発行し直す
  if (body.action === 'link') {
    if (!body.user_id) return json({ error: 'user_id がありません' }, 400)
    const { data: target, error: tErr } = await admin.auth.admin.getUserById(body.user_id)
    if (tErr || !target?.user?.email) return json({ error: 'ユーザーが見つかりません' }, 404)
    const { data: link, error: lErr } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: target.user.email,
      options: { redirectTo: APP_URL }
    })
    if (lErr || !link?.properties?.hashed_token) return json({ error: lErr?.message ?? 'リンクを作れませんでした' }, 400)
    return json({ ok: true, email: target.user.email, link: appLink(link.properties.hashed_token, 'recovery') })
  }

  // 新しく招待する
  const email = (body.email ?? '').trim().toLowerCase()
  const displayName = (body.display_name ?? '').trim()
  const role = body.role === 'admin' ? 'admin' : 'staff'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'メールアドレスの形が正しくありません' }, 400)
  if (!displayName) return json({ error: '表示名を入れてください' }, 400)

  const { data: link, error: inviteErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { data: { display_name: displayName }, redirectTo: APP_URL }
  })
  if (inviteErr || !link?.user || !link?.properties?.hashed_token) {
    const msg = inviteErr?.message ?? '招待できませんでした'
    const already = /already|registered|exists/i.test(msg)
    return json({ error: already ? 'このメールアドレスは既に登録されています（一覧の「リンク」から発行し直せます）' : msg }, already ? 409 : 400)
  }

  // 表示名と役割を確定する（トリガーは staff・メールの前半で作るため）
  const { error: profErr } = await admin
    .from('profiles')
    .update({ display_name: displayName, role })
    .eq('id', link.user.id)
  if (profErr) return json({ error: 'ユーザーは作りましたが、表示名／役割の設定に失敗しました：' + profErr.message }, 500)

  return json({
    ok: true, user_id: link.user.id, email, display_name: displayName, role,
    link: appLink(link.properties.hashed_token, 'invite')
  })
})
