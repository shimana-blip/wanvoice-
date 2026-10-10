// Vercel の環境変数から Supabase の接続先をブラウザに渡す。
// anon key はブラウザに渡る前提の公開用キー。実際の守りは RLS。
// service_role キーは絶対にここに置かないこと。
module.exports = (req, res) => {
  const config = {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('window.WANVOICE_CONFIG = ' + JSON.stringify(config) + ';\n');
};
