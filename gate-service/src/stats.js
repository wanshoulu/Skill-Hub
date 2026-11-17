// stats.js — 平台统计看板数据源（一期：只读直查 postgres + 小时快照 + 差分趋势）
// 设计：docs/dashboard-lifecycle-design.md §5.1.2
// - 每小时只读查询 postgres 累计值，快照落 gate_data 卷（stats/snap-*.json，保留 90 天）
// - 日下载量 = 相邻日末快照 download_count 差分（下载计数由 server 原子递增，只增不减；
//   技能被删除会导致总量下降，差分按 0 截断）
// - 日发布量直接按 skill_version.published_at 聚合（历史事实，可精确回溯，无需差分）
// - API 鉴权独立于 GATE_TOKEN：校验 nginx 注入的 X-Stats-Token（STATS_TOKEN）
// - 未配置 STATS_PG_URL / STATS_TOKEN 时模块禁用，API 返回 503（不静默开放）
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, saveJson, readJson } from './store.js';

const SNAP_DIR = 'stats';
const RETENTION_DAYS = Number(process.env.STATS_RETENTION_DAYS || 90);
const INTERVAL_MS = Number(process.env.STATS_INTERVAL_MS || 60 * 60 * 1000); // 每小时
const TIME_ZONE = process.env.STATS_TIME_ZONE || 'Asia/Shanghai';

export const statsEnabled = () => Boolean(process.env.STATS_PG_URL && process.env.STATS_TOKEN);

// ── 时间工具：按配置时区切日 ─────────────────────────────────────

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayOf = (ts) => dayFmt.format(new Date(ts)); // 'YYYY-MM-DD'

// ── 快照文件 ─────────────────────────────────────────────────────

function snapFile(ts) {
  return path.join(SNAP_DIR, `snap-${new Date(ts).toISOString().replace(/[:.]/g, '')}.json`);
}

// 列出全部快照（内存索引），按 ts 升序
function listSnaps() {
  const dir = path.join(DATA_DIR, SNAP_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = n.match(/^snap-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.json$/);
    if (!m) continue;
    const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
    if (Number.isFinite(ts)) out.push({ ts, rel: path.join(SNAP_DIR, n) });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// 每日末快照：同一天取最后一个（加载时才读内容）
function dailyEndSnaps() {
  const snaps = listSnaps();
  const byDay = new Map();
  for (const s of snaps) {
    byDay.set(dayOf(s.ts), s); // 已按 ts 升序，后写覆盖
  }
  return [...byDay.entries()].map(([day, s]) => ({ day, ...s }));
}

function loadSnap(rel) {
  return readJson(rel);
}

function cleanOldSnaps() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  for (const s of listSnaps()) {
    if (s.ts < cutoff) {
      try {
        fs.unlinkSync(path.join(DATA_DIR, s.rel));
      } catch { /* 忽略并发删除 */ }
    }
  }
}

// ── postgres 只读采集 ────────────────────────────────────────────

const pool = new pg.Pool({
  connectionString: process.env.STATS_PG_URL,
  max: 1, // 只读低频，单连接足够，避免给生产 pg 加压
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  idleTimeoutMillis: 60_000,
});

async function q(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

function groupCount(rows, key) {
  const m = {};
  for (const r of rows) m[r[key]] = Number(r.c);
  return m;
}

async function collect() {
  const [
    skillStatus, skillVisibility, hiddenCount, versionStatus, skillTotals,
    reviewPending, promotionPending, nsCount, skillsDetail, publishedByDay,
    reviewList, promotionList, yankedList,
  ] = await Promise.all([
    q('SELECT status, count(*)::int AS c FROM skill GROUP BY status'),
    q('SELECT visibility, count(*)::int AS c FROM skill GROUP BY visibility'),
    q('SELECT count(*)::int AS c FROM skill WHERE hidden_at IS NOT NULL'),
    q('SELECT status, count(*)::int AS c FROM skill_version GROUP BY status'),
    q('SELECT count(*)::int AS c, coalesce(sum(download_count),0)::bigint AS downloads, coalesce(sum(star_count),0)::bigint AS stars FROM skill'),
    q("SELECT count(*)::int AS c FROM review_task WHERE status='PENDING'"),
    q("SELECT count(*)::int AS c FROM promotion_request WHERE status='PENDING'"),
    q('SELECT count(*)::int AS c FROM namespace'),
    q(`SELECT s.id, s.slug, n.slug AS ns, s.display_name, s.status, s.visibility,
              s.download_count::bigint AS download_count, s.star_count::int AS star_count,
              s.rating_avg::float8 AS rating_avg, s.rating_count::int AS rating_count,
              (s.hidden_at IS NOT NULL) AS hidden,
              (SELECT count(*)::int FROM skill_version v WHERE v.skill_id = s.id) AS version_count,
              (SELECT count(*)::int FROM skill_version v WHERE v.skill_id = s.id AND v.status='PUBLISHED') AS published_count,
              (SELECT max(v.published_at) FROM skill_version v WHERE v.skill_id = s.id AND v.status='PUBLISHED') AS last_published_at
       FROM skill s JOIN namespace n ON n.id = s.namespace_id`),
    q(`SELECT to_char(published_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day, count(*)::int AS c
       FROM skill_version WHERE status='PUBLISHED' AND published_at >= now() - ($2 || ' days')::interval
       GROUP BY 1`, [TIME_ZONE, RETENTION_DAYS + 5]),
    q(`SELECT rt.id, n.slug AS ns, s.slug, v.version, rt.submitted_at, rt.submitted_by
       FROM review_task rt
       JOIN skill_version v ON v.id = rt.skill_version_id
       JOIN skill s ON s.id = v.skill_id
       JOIN namespace n ON n.id = rt.namespace_id
       WHERE rt.status='PENDING' ORDER BY rt.submitted_at ASC LIMIT 100`),
    q(`SELECT pr.id, sn.slug AS ns, s.slug, v.version, tn.slug AS target_ns, pr.submitted_at, pr.submitted_by
       FROM promotion_request pr
       JOIN skill s ON s.id = pr.source_skill_id
       JOIN skill_version v ON v.id = pr.source_version_id
       JOIN namespace sn ON sn.id = s.namespace_id
       JOIN namespace tn ON tn.id = pr.target_namespace_id
       WHERE pr.status='PENDING' ORDER BY pr.submitted_at ASC LIMIT 100`),
    q(`SELECT s.id AS skill_id, n.slug AS ns, s.slug, v.id AS version_id, v.version, v.published_at
       FROM skill_version v
       JOIN skill s ON s.id = v.skill_id
       JOIN namespace n ON n.id = s.namespace_id
       WHERE v.status='YANKED' ORDER BY v.published_at DESC NULLS LAST LIMIT 100`),
  ]);

  return {
    ts: new Date().toISOString(),
    overview: {
      skills: {
        total: skillTotals[0].c,
        byStatus: groupCount(skillStatus, 'status'),
        byVisibility: groupCount(skillVisibility, 'visibility'),
        hidden: hiddenCount[0].c,
      },
      versions: { byStatus: groupCount(versionStatus, 'status') },
      downloads: { total: Number(skillTotals[0].downloads) },
      stars: { total: Number(skillTotals[0].stars) },
      reviews: { pending: reviewPending[0].c },
      promotions: { pending: promotionPending[0].c },
      namespaces: { total: nsCount[0].c },
    },
    skills: skillsDetail.map((r) => ({
      id: Number(r.id),
      slug: r.slug,
      ns: r.ns,
      name: r.display_name || r.slug,
      status: r.status,
      visibility: r.visibility,
      hidden: Boolean(r.hidden),
      downloadCount: Number(r.download_count),
      starCount: r.star_count,
      ratingAvg: r.rating_avg,
      ratingCount: r.rating_count,
      versionCount: r.version_count,
      publishedCount: r.published_count,
      lastPublishedAt: r.last_published_at,
    })),
    publishedByDay: Object.fromEntries(publishedByDay.map((r) => [r.day, r.c])),
    pendingReviews: reviewList,
    pendingPromotions: promotionList,
    yankedVersions: yankedList,
  };
}

// ── 快照调度 ─────────────────────────────────────────────────────

let timer = null;
let lastError = null;

export async function snapshot() {
  const snap = await collect();
  saveJson(snapFile(Date.parse(snap.ts)), snap);
  cleanOldSnaps();
  return snap;
}

export function startScheduler(logger = console) {
  if (!statsEnabled() || timer) return;
  const run = async () => {
    try {
      await snapshot();
      lastError = null;
    } catch (e) {
      lastError = `${new Date().toISOString()} ${e.message}`;
      logger.error(`[stats] 快照失败：${e.message}`);
    }
  };
  run();
  timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
}

// ── API 视图 ─────────────────────────────────────────────────────

// 最新快照（磁盘最新文件，进程内不缓存以便多实例/重启一致性）
function latestSnap() {
  const snaps = listSnaps();
  for (let i = snaps.length - 1; i >= 0; i--) {
    const s = loadSnap(snaps[i].rel);
    if (s) return s;
  }
  return null;
}

// 差分下载量：from 快照 → to 快照（总量口径），缺失/负值按 0
function diffTotal(fromSnap, toSnap) {
  if (!fromSnap || !toSnap) return null;
  const d = Number(toSnap.overview?.downloads?.total ?? 0) - Number(fromSnap.overview?.downloads?.total ?? 0);
  return Math.max(0, d);
}

function buildTrend(snap, days) {
  const daily = dailyEndSnaps();
  const today = dayOf(snap.ts);
  // 日末序列（含今天：今天以最新快照代替日末）
  const byDay = new Map();
  for (const d of daily) byDay.set(d.day, d);
  const cur = { day: today, snap };
  const daysList = [];
  const cursor = new Date(snap.ts);
  for (let i = 0; i < days; i++) {
    daysList.unshift(dayOf(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  const endOfDay = new Map(); // day -> snapshot 对象
  for (const day of daysList) {
    if (day === today) endOfDay.set(day, snap);
    else {
      const rec = byDay.get(day);
      if (rec) endOfDay.set(day, loadSnap(rec.rel));
    }
  }
  const series = [];
  for (let i = 0; i < daysList.length; i++) {
    const day = daysList[i];
    const prevDay = i > 0 ? daysList[i - 1] : null;
    const end = endOfDay.get(day) || null;
    const prev = prevDay ? (endOfDay.get(prevDay) || null) : null;
    series.push({
      date: day,
      downloads: end ? diffTotal(prev, end) : null, // 无数据的日期为 null（前端断线渲染）
      published: snap.publishedByDay?.[day] ?? 0,
    });
  }
  return series;
}

// 区间下载增量（总量口径）：days 天前日末 → 最新
function windowDownloads(snap, days) {
  const daily = dailyEndSnaps();
  const today = dayOf(snap.ts);
  const cursor = new Date(snap.ts);
  cursor.setDate(cursor.getDate() - days);
  const targetDay = dayOf(cursor);
  let base = null;
  for (const d of daily) {
    if (d.day < targetDay) base = d; // targetDay 之前（不含）最后一个日末快照
  }
  const baseSnap = base ? loadSnap(base.rel) : null;
  if (!baseSnap) return null; // 快照历史不足
  return diffTotal(baseSnap, snap);
}

// 单技能日下载序列（快照差分）
function skillTrend(snap, skillId, days) {
  const daily = dailyEndSnaps();
  const today = dayOf(snap.ts);
  const getDl = (s, id) => Number(s?.skills?.find((x) => x.id === id)?.downloadCount ?? null);
  const endOfDay = [{ day: today, snap }];
  for (const d of daily) {
    if (d.day === today) continue;
    const s = loadSnap(d.rel);
    if (s) endOfDay.push({ day: d.day, snap: s });
  }
  endOfDay.sort((a, b) => (a.day < b.day ? -1 : 1));
  const start = new Date(snap.ts);
  start.setDate(start.getDate() - (days - 1));
  const fromDay = dayOf(start);
  const series = [];
  for (let i = 0; i < endOfDay.length; i++) {
    const cur = endOfDay[i];
    if (cur.day < fromDay || cur.day > today) continue;
    const prev = endOfDay[i - 1];
    const curDl = getDl(cur.snap, skillId);
    const prevDl = prev ? getDl(prev.snap, skillId) : null;
    series.push({
      date: cur.day,
      downloads: curDl === null ? null : (prevDl === null ? null : Math.max(0, curDl - prevDl)),
    });
  }
  return series;
}

// API 响应组装（latestSnap 为空时返回 null 由调用方转 503）
export function viewOverview() {
  const snap = latestSnap();
  if (!snap) return null;
  const today = dayOf(snap.ts);
  const days7 = new Date(snap.ts); days7.setDate(days7.getDate() - 7);
  const daily = dailyEndSnaps();
  let todayBase = null;
  for (const d of daily) {
    if (d.day < today) todayBase = d;
  }
  const todayBaseSnap = todayBase ? loadSnap(todayBase.rel) : null;
  return {
    asOf: snap.ts,
    collecting: !lastError,
    lastError,
    kpi: {
      skills: snap.overview.skills,
      versions: snap.overview.versions,
      namespaces: snap.overview.namespaces,
      downloads: {
        total: snap.overview.downloads.total,
        today: todayBaseSnap ? diffTotal(todayBaseSnap, snap) : null,
        last7d: windowDownloads(snap, 7),
      },
      stars: snap.overview.stars,
      reviews: snap.overview.reviews,
      promotions: snap.overview.promotions,
    },
  };
}

export function viewTrend(days) {
  const snap = latestSnap();
  if (!snap) return null;
  return { asOf: snap.ts, days, series: buildTrend(snap, days) };
}

export function viewSkills() {
  const snap = latestSnap();
  if (!snap) return null;
  const daily = dailyEndSnaps();
  const loadEnd = (offsetDays, ref) => {
    const c = new Date(ref); c.setDate(c.getDate() - offsetDays);
    const day = dayOf(c);
    let hit = null;
    for (const d of daily) if (d.day < day) hit = d;
    return hit ? loadSnap(hit.rel) : null;
  };
  const d7 = loadEnd(7, snap.ts);
  const d30 = loadEnd(30, snap.ts);
  const skills = snap.skills.map((s) => {
    const old7 = d7?.skills?.find((x) => x.id === s.id);
    const old30 = d30?.skills?.find((x) => x.id === s.id);
    return {
      ...s,
      downloads7d: old7 === undefined ? null : Math.max(0, s.downloadCount - old7.downloadCount),
      downloads30d: old30 === undefined ? null : Math.max(0, s.downloadCount - old30.downloadCount),
    };
  });
  return { asOf: snap.ts, skills };
}

export function viewTop() {
  const snap = latestSnap();
  if (!snap) return null;
  const pick = (key) => [...snap.skills].sort((a, b) => b[key] - a[key]).slice(0, 10)
    .map((s) => ({ id: s.id, ns: s.ns, slug: s.slug, name: s.name, value: s[key] }));
  return {
    asOf: snap.ts,
    downloads: pick('downloadCount'),
    stars: pick('starCount'),
  };
}

export function viewLifecycle() {
  const snap = latestSnap();
  if (!snap) return null;
  return {
    asOf: snap.ts,
    skills: snap.overview.skills,
    versions: snap.overview.versions,
    pendingReviews: snap.pendingReviews,
    pendingPromotions: snap.pendingPromotions,
    yankedVersions: snap.yankedVersions,
  };
}

// 单技能下钻：日下载序列（快照差分）+ 技能当前指标
export function viewSkillTrend(skillId, days) {
  const snap = latestSnap();
  if (!snap) return null;
  const s = snap.skills.find((x) => x.id === skillId);
  if (!s) return { notFound: true };
  return { asOf: snap.ts, skill: s, series: skillTrend(snap, skillId, days) };
}

// X-Stats-Token 校验（constant-time）
export function checkStatsToken(headerVal) {
  const expect = process.env.STATS_TOKEN || '';
  if (!expect) return false;
  const got = String(headerVal || '');
  const a = Buffer.from(got);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
