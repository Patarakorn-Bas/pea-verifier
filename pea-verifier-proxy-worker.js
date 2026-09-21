/**
 * PEA Material Verifier - Shared Proxy Worker (Cloudflare Workers + D1)
 * ============================================================================
 * ทำ 2 หน้าที่:
 * 1. เป็นตัวกลางเรียก Gemini API แทนผู้ใช้ (ไม่ต้องกรอก Key เอง) — เหมือนเดิม
 * 2. เก็บ "ประวัติผลการตรวจสอบ" ลงฐานข้อมูล Cloudflare D1 (ฟรี) เพื่อให้ค้นหา
 *    ย้อนหลังได้ว่าผลิตภัณฑ์ไหนเคยอนุมัติ/ไม่อนุมัติไปแล้วบ้าง
 *
 * ============================================================================
 * วิธีอัปเกรดจาก Worker เดิมที่มีอยู่แล้ว ให้รองรับฐานข้อมูล (ทำผ่าน Terminal
 * ในโฟลเดอร์ pea-worker เดิมที่ใช้ deploy Worker ไปแล้ว):
 *
 * 1. สร้างฐานข้อมูล D1 (ครั้งเดียว):
 *      npx wrangler d1 create pea-verifier-db
 *    คำสั่งนี้จะพิมพ์ข้อความคล้าย ๆ นี้ออกมา คัดลอก "database_id" เก็บไว้:
 *      [[d1_databases]]
 *      binding = "DB"
 *      database_name = "pea-verifier-db"
 *      database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *
 * 2. เปิดไฟล์ wrangler.toml (ไฟล์ล่าสุดที่แนบมาให้) แล้ววาง database_id
 *    ที่ได้จากขั้นตอนที่ 1 ลงไปแทนคำว่า "ใส่-database-id-ที่นี่"
 *
 * 3. แทนที่โค้ด Worker เดิมทั้งหมดด้วยไฟล์นี้ (pea-verifier-proxy-worker.js)
 *
 * 4. Deploy ใหม่:
 *      npx wrangler deploy
 *
 * ไม่ต้องรันคำสั่งสร้างตารางเอง เพราะ Worker จะสร้างตารางในฐานข้อมูลให้
 * อัตโนมัติในการเรียกครั้งแรก (CREATE TABLE IF NOT EXISTS)
 * ============================================================================
 */

function corsHeaders(env) {
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

async function handleGemini(request, env, model) {
  if (!env.GOOGLE_API_KEY) {
    return new Response(JSON.stringify({ error: { message: 'ยังไม่ได้ตั้งค่า GOOGLE_API_KEY ใน Worker Secrets' } }), { status: 500 });
  }
  const body = await request.text();

  // เรียกผ่าน Cloudflare AI Gateway แทนการยิงตรงไปที่ Google
  // เหตุผล: การยิง fetch() ตรงจาก Worker ไปหา Google Gemini API บางครั้งถูกปฏิเสธ
  // ด้วย error "User location is not supported for the API use" เพราะ IP ของ
  // Cloudflare edge node ที่รันคำขอนั้นอาจตกไปอยู่ในประเทศที่ Google จำกัดสิทธิ์
  // สำหรับ Free Tier (ไม่ผูกบัตรเครดิต) การผ่าน AI Gateway (สินค้าทางการของ
  // Cloudflare ที่เป็นพาร์ทเนอร์กับผู้ให้บริการ AI โดยตรง) จะไม่เจอปัญหานี้
  // ต้องตั้งค่า CF_ACCOUNT_ID และ CF_AI_GATEWAY_ID ใน wrangler.toml ก่อน (ดูคำแนะนำ)
  const useGateway = !!(env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY_ID);
  const targetUrl = useGateway
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/google-ai-studio/v1beta/models/${model}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const upstream = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GOOGLE_API_KEY },
    body
  });
  return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
}

async function ensureTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      category_key TEXT,
      category_name TEXT,
      verdict TEXT,
      reason TEXT,
      brand TEXT,
      pea_region TEXT,
      pea_branch TEXT,
      project TEXT,
      contractor TEXT,
      doc_no TEXT,
      checks_json TEXT
    )
  `).run();
}

async function handleSaveRecord(request, env) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: { message: 'ยังไม่ได้ผูกฐานข้อมูล D1 กับ Worker นี้ (ดูคำแนะนำที่ต้นไฟล์)' } }), { status: 500 });
  }
  await ensureTable(env);
  const data = await request.json();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO records (created_at, category_key, category_name, verdict, reason, brand, pea_region, pea_branch, project, contractor, doc_no, checks_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    now,
    data.categoryKey || '',
    data.categoryName || '',
    data.verdict || '',
    data.reason || '',
    data.brand || '',
    data.peaRegion || '',
    data.peaBranch || '',
    data.project || '',
    data.contractor || '',
    data.docNo || '',
    JSON.stringify(data.checks || [])
  ).run();
  return new Response(JSON.stringify({ ok: true, created_at: now }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function handleListRecords(request, env) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: { message: 'ยังไม่ได้ผูกฐานข้อมูล D1 กับ Worker นี้ (ดูคำแนะนำที่ต้นไฟล์)' } }), { status: 500 });
  }
  await ensureTable(env);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const verdict = (url.searchParams.get('verdict') || '').trim();
  const project = (url.searchParams.get('project') || '').trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);

  let sql = 'SELECT id, created_at, category_key, category_name, verdict, reason, brand, pea_region, pea_branch, project, contractor, doc_no, checks_json FROM records WHERE 1=1';
  const binds = [];

  if (q) {
    sql += ' AND (brand LIKE ? OR category_name LIKE ? OR project LIKE ? OR contractor LIKE ? OR doc_no LIKE ?)';
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }
  if (verdict) {
    sql += ' AND verdict = ?';
    binds.push(verdict);
  }
  if (project) {
    sql += ' AND project LIKE ?';
    binds.push(`%${project}%`);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  binds.push(limit);

  const stmt = env.DB.prepare(sql).bind(...binds);
  const result = await stmt.all();
  return new Response(JSON.stringify({ ok: true, records: result.results || [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function handleDeleteRecord(env, id) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: { message: 'ยังไม่ได้ผูกฐานข้อมูล D1 กับ Worker นี้' } }), { status: 500 });
  }
  if (!id || isNaN(Number(id))) {
    return new Response(JSON.stringify({ error: { message: 'ไม่พบรหัสรายการที่ต้องการลบ (id ไม่ถูกต้อง)' } }), { status: 400 });
  }
  await ensureTable(env);
  await env.DB.prepare('DELETE FROM records WHERE id = ?').bind(Number(id)).run();
  return new Response(JSON.stringify({ ok: true, deleted_id: Number(id) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      let res;

      if (request.method === 'POST' && parts[0] === 'gemini' && parts[1]) {
        res = await handleGemini(request, env, parts[1]);
      } else if (request.method === 'POST' && parts[0] === 'records') {
        res = await handleSaveRecord(request, env);
      } else if (request.method === 'GET' && parts[0] === 'records') {
        res = await handleListRecords(request, env);
      } else if (request.method === 'DELETE' && parts[0] === 'records' && parts[1]) {
        res = await handleDeleteRecord(env, parts[1]);
      } else {
        res = new Response(JSON.stringify({ error: { message: 'ไม่พบ endpoint นี้ ใช้ POST /gemini/<model>, POST /records, GET /records หรือ DELETE /records/<id>' } }), { status: 404 });
      }

      const finalHeaders = new Headers(res.headers);
      Object.entries(headers).forEach(([k, v]) => finalHeaders.set(k, v));
      return new Response(res.body, { status: res.status, headers: finalHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: 'Worker error: ' + err.message } }), { status: 500, headers });
    }
  }
};
