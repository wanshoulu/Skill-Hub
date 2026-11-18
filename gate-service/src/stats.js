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
import { DATA_DIR, saveJson, readJson, listRuns } from './store.js';
import { aggUsage, cleanOldUsage } from './usage.js';

const SNAP_DIR = 'stats';
const RETENTION_DAYS = Number(process.env.STATS_RETENTION_DAYS || 90);
const EVENT_RETENTION_DAYS = Number(process.env.STATS_EVENT_RETENTION_DAYS || 180);
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

async function collectBase() {
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

// 快照组装入口：主段（原 13 项）+ 扩展段（P1/P2）。
// 扩展段整体 try/catch：任何新指标查询失败仅记录 extError，不影响既有看板数据。
async function collect() {
  const base = await collectBase();
  let extended = null;
  let events = null;
  let extError = null;
  try { extended = await collectExtended(); } catch (e) { extError = e.message; }
  try { events = await collectEvents(); } catch (e) { extError = extError || `events: ${e.message}`; }
  if (events) {
    try {
      await q(`DELETE FROM business_event_log WHERE occurred_at < now() - ($1 || ' days')::interval`, [String(EVENT_RETENTION_DAYS)]);
    } catch { /* 清理失败不影响快照 */ }
  }
  try { cleanOldUsage(); } catch { /* usage 月度文件清理失败不影响快照 */ }
  return {
    ...base,
    quality: extended?.quality ?? null,
    efficiency: extended?.efficiency ?? null,
    governance: extended?.governance ?? null,
    value: extended?.value ?? null,
    adoption: events,
    extError,
  };
}

// ── 扩展采集（P1 质量/效率/治理/价值 + P2 业务事件）：独立失败不影响主快照 ──

// P1：评分/审核效率/发布前置/贡献者/套件/安全审计/审核积压
async function collectExtended() {
  const [
    ratingTrend, ratingDist, reviewEff, promotionEff, publishLead,
    contributors, newContributors, suites, secAudit, secSeverity, backlog,
  ] = await Promise.all([
    q(`SELECT to_char(created_at AT TIME ZONE $1,'YYYY-MM-DD') AS day, count(*)::int AS c,
              round(avg(score)::numeric,2)::float8 AS avg_score
       FROM skill_rating WHERE created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [TIME_ZONE]),
    q(`SELECT score, count(*)::int AS c FROM skill_rating GROUP BY score`),
    q(`SELECT count(*)::int AS completed,
              count(*) FILTER (WHERE status='REJECTED')::int AS rejected,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (reviewed_at - submitted_at))/3600.0)::float8 AS p50h,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (reviewed_at - submitted_at))/3600.0)::float8 AS p90h
       FROM review_task WHERE status <> 'PENDING' AND reviewed_at IS NOT NULL AND reviewed_at >= now() - interval '30 days'`),
    q(`SELECT count(*)::int AS completed,
              count(*) FILTER (WHERE status='REJECTED')::int AS rejected,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (reviewed_at - submitted_at))/3600.0)::float8 AS p50h,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (reviewed_at - submitted_at))/3600.0)::float8 AS p90h
       FROM promotion_request WHERE status <> 'PENDING' AND reviewed_at IS NOT NULL AND reviewed_at >= now() - interval '30 days'`),
    q(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (published_at - created_at))/3600.0)::float8 AS p50h,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (published_at - created_at))/3600.0)::float8 AS p90h,
              count(*)::int AS samples
       FROM skill_version WHERE status='PUBLISHED' AND published_at IS NOT NULL AND published_at >= now() - interval '30 days'`),
    q(`SELECT count(distinct created_by)::int AS c FROM skill_version
       WHERE created_at >= now() - interval '30 days' AND created_by IS NOT NULL`),
    q(`SELECT count(*)::int AS c FROM (
         SELECT created_by FROM skill_version WHERE created_by IS NOT NULL
         GROUP BY created_by HAVING min(created_at) >= now() - interval '30 days') t`),
    q(`SELECT count(*)::int AS c FROM skill_suite`),
    q(`SELECT count(*)::int AS scans,
              count(*) FILTER (WHERE NOT is_safe)::int AS unsafe,
              coalesce(sum(findings_count),0)::int AS findings
       FROM security_audit WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days'`),
    q(`SELECT coalesce(max_severity,'none') AS severity, count(*)::int AS c
       FROM security_audit WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days' GROUP BY 1`),
    q(`SELECT count(*) FILTER (WHERE now() - submitted_at < interval '1 day')::int AS lt1d,
              count(*) FILTER (WHERE now() - submitted_at >= interval '1 day' AND now() - submitted_at < interval '3 days')::int AS d1to3,
              count(*) FILTER (WHERE now() - submitted_at >= interval '3 days' AND now() - submitted_at < interval '7 days')::int AS d3to7,
              count(*) FILTER (WHERE now() - submitted_at >= interval '7 days')::int AS gt7d
       FROM review_task WHERE status='PENDING'`),
  ]);
  const scoreWeighted = ratingDist.reduce((acc, r) => acc + Number(r.score) * r.c, 0);
  const scoreTotal = ratingDist.reduce((acc, r) => acc + r.c, 0);
  return {
    quality: {
      ratings: {
        avgScore: scoreTotal ? scoreWeighted / scoreTotal : null,
        ratedCount30d: ratingTrend.reduce((a, r) => a + r.c, 0),
        trend30d: ratingTrend,
        distribution: Object.fromEntries(ratingDist.map((r) => [String(r.score), r.c])),
      },
    },
    efficiency: {
      review: reviewEff[0],
      promotion: promotionEff[0],
      publishLeadTime: publishLead[0],
      contributors: { active30d: contributors[0].c, new30d: newContributors[0].c },
    },
    governance: {
      security: { ...secAudit[0], severity: Object.fromEntries(secSeverity.map((r) => [r.severity, r.c])) },
      pendingBacklog: backlog[0],
    },
    value: { suites: { total: suites[0].c } },
  };
}

// P2：business_event_log 明细表采集（表未建/功能未开启时返回 null）
async function collectEvents() {
  const probe = await q(`SELECT to_regclass('public.business_event_log') IS NOT NULL AS ok`);
  if (!probe[0]?.ok) return null;
  const [dau, users, skillUsers, channels, autoPub, adoption] = await Promise.all([
    q(`SELECT to_char(occurred_at AT TIME ZONE $1,'YYYY-MM-DD') AS day, count(distinct user_id)::int AS users
       FROM business_event_log WHERE user_id IS NOT NULL AND occurred_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [TIME_ZONE]),
    q(`SELECT count(distinct user_id) FILTER (WHERE occurred_at >= now() - interval '1 day')::int AS dau,
              count(distinct user_id) FILTER (WHERE occurred_at >= now() - interval '7 days')::int AS wau,
              count(distinct user_id) FILTER (WHERE occurred_at >= now() - interval '30 days')::int AS mau
       FROM business_event_log WHERE user_id IS NOT NULL`),
    q(`SELECT skill_id, count(distinct user_id)::int AS users
       FROM business_event_log WHERE user_id IS NOT NULL AND event_name='skill.download.prepared'
         AND occurred_at >= now() - interval '30 days' GROUP BY 1`),
    q(`SELECT source, count(*)::int AS events, count(distinct user_id)::int AS users
       FROM business_event_log WHERE occurred_at >= now() - interval '30 days' GROUP BY 1`),
    q(`SELECT count(*) FILTER (WHERE source='auto_publish')::int AS auto, count(*)::int AS total
       FROM business_event_log WHERE event_name='skill.publication.effective' AND occurred_at >= now() - interval '30 days'`),
    q(`SELECT LEAST(EXTRACT(DAY FROM (e.occurred_at - v.published_at))::int, 30) AS offset_day,
              count(*)::int AS downloads, count(distinct e.skill_id)::int AS skills
       FROM business_event_log e
       JOIN skill_version v ON v.id = e.version_id
       WHERE e.event_name='skill.download.prepared' AND e.user_id IS NOT NULL
         AND v.status='PUBLISHED' AND v.published_at IS NOT NULL
         AND v.published_at >= now() - interval '90 days'
         AND e.occurred_at >= v.published_at
         AND e.occurred_at <= v.published_at + interval '30 days'
       GROUP BY 1 ORDER BY 1`),
  ]);
  return {
    users: { ...users[0], dauSeries: dau },
    skillUsers,
    channels,
    autoPublish: autoPub[0],
    adoptionCurve: adoption,
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

// ── P1/P2 扩展视图：质量 / 效率 / 治理 / 采纳 / 业务价值 ─────────

// 门禁与评测运行聚合（gate-service 本地 runs JSON，近 N 天）
function gateRunsAgg(days = 30) {
  const since = Date.now() - days * 86400000;
  const pick = (kind) => {
    try {
      return listRuns(kind).filter((r) => (r.created_at || 0) >= since && r.status !== 'running');
    } catch { return []; }
  };
  const gate = pick('gate');
  const evals = pick('eval');
  const passed = gate.filter((r) => r.status === 'passed').length;
  const stageFail = {};
  const ruleCount = {};
  const evalAcc = [];
  for (const r of gate) {
    for (const s of r.stages || []) {
      if (s.status === 'fail') stageFail[s.stage_id] = (stageFail[s.stage_id] || 0) + 1;
      for (const f of s.findings || []) {
        const key = f.rule || f.title || 'unknown';
        ruleCount[key] = (ruleCount[key] || 0) + 1;
      }
    }
  }
  for (const r of evals) {
    const acc = (r.stages || []).map((s) => s.metrics?.accuracy).find((v) => typeof v === 'number');
    if (acc !== undefined) evalAcc.push(acc);
  }
  const sorted = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
  return {
    windowDays: days,
    gate: { total: gate.length, passed, passRate: gate.length ? passed / gate.length : null },
    stageFailures: sorted(stageFail),
    topViolationRules: Object.fromEntries(Object.entries(sorted(ruleCount)).slice(0, 10)),
    eval: { total: evals.length, avgAccuracy: evalAcc.length ? evalAcc.reduce((a, b) => a + b, 0) / evalAcc.length : null },
  };
}

// 质量：门禁通过率 + 七项失败分布 + 违规规则 Top10 + 评测准确率 + 评分
export function viewQuality() {
  const snap = latestSnap();
  if (!snap) return null;
  return { asOf: snap.ts, gate: gateRunsAgg(30), ratings: snap.quality?.ratings ?? null };
}

// 效率：审核/晋级时长 p50/p90、拒绝率、发布前置时间、发布频率、贡献者
export function viewEfficiency() {
  const snap = latestSnap();
  if (!snap) return null;
  const day = dayOf(snap.ts);
  const sumRange = (n) => {
    let s = 0;
    const c = new Date(snap.ts); c.setDate(c.getDate() - (n - 1));
    for (let i = 0; i < n; i++) { s += snap.publishedByDay?.[dayOf(c)] || 0; c.setDate(c.getDate() + 1); }
    return s;
  };
  return {
    asOf: snap.ts,
    review: snap.efficiency?.review ?? null,
    promotion: snap.efficiency?.promotion ?? null,
    publishLeadTime: snap.efficiency?.publishLeadTime ?? null,
    contributors: snap.efficiency?.contributors ?? null,
    publishFrequency: { last30d: sumRange(30), last90d: sumRange(90) },
  };
}

// 治理：安全审计 + 审核积压分桶 + 下架/隐藏
export function viewGovernance() {
  const snap = latestSnap();
  if (!snap) return null;
  return {
    asOf: snap.ts,
    security: snap.governance?.security ?? null,
    pendingBacklog: snap.governance?.pendingBacklog ?? null,
    pendingReviews: snap.overview.reviews.pending,
    pendingPromotions: snap.overview.promotions.pending,
    yankedCount: snap.yankedVersions.length,
    hiddenSkills: snap.overview.skills.hidden,
  };
}

// 采纳：WAU/MAU、每技能去重用户、渠道分布、采纳曲线、复用率（需事件表开启）
export function viewAdoption() {
  const snap = latestSnap();
  if (!snap) return null;
  if (!snap.adoption) return { asOf: snap.ts, enabled: false };
  const su = new Map(snap.adoption.skillUsers.map((r) => [Number(r.skill_id), r.users]));
  const multi = [...su.values()].filter((u) => u >= 2).length;
  const top = snap.skills
    .map((s) => ({ id: s.id, ns: s.ns, slug: s.slug, name: s.name, users: su.get(s.id) || 0 }))
    .filter((x) => x.users > 0)
    .sort((a, b) => b.users - a.users)
    .slice(0, 50);
  return {
    asOf: snap.ts,
    enabled: true,
    users: snap.adoption.users,
    channels: snap.adoption.channels,
    autoPublish: snap.adoption.autoPublish,
    adoptionCurve: snap.adoption.adoptionCurve,
    reuse: { skillsWithUsers: su.size, multiUserSkills: multi, reuseRate: su.size ? multi / su.size : null },
    topSkillsByUsers: top,
  };
}

// 业务价值：活跃技能占比（货架周转）、贡献者、套件、节省工时估算（配置化系数）
export function viewValue() {
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
  const d30 = loadEnd(30, snap.ts);
  const published = snap.skills.filter((s) => s.publishedCount > 0);
  let active30d = null;
  if (d30) {
    active30d = published.filter((s) => {
      const old = d30.skills.find((x) => x.id === s.id);
      return old !== undefined && Math.max(0, s.downloadCount - old.downloadCount) > 0;
    }).length;
  }
  const perActiveSkill = Number(process.env.STATS_VALUE_MANHOURS_PER_ACTIVE_SKILL || 0);
  return {
    asOf: snap.ts,
    activeSkills: {
      published: published.length,
      active30d,
      ratio: d30 && published.length ? active30d / published.length : null,
    },
    contributors: snap.efficiency?.contributors ?? null,
    suites: snap.value?.suites ?? null,
    manhours: {
      enabled: perActiveSkill > 0,
      perActiveSkillHours: perActiveSkill,
      hoursPerMonth: active30d && perActiveSkill > 0 ? active30d * perActiveSkill : null,
      note: '估算值：每活跃技能每月节省工时系数来自 STATS_VALUE_MANHOURS_PER_ACTIVE_SKILL 配置',
    },
  };
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

// ── 触发调用视图：实时聚合（不走小时快照——数据在本地 JSONL，不在 PG）──
// 三层来源：agent_chat（对话会话）/ mcp_tool（MCP 调用）/ skill（CLI 上报），30 天窗口
export function viewTriggers() {
  return { asOf: new Date().toISOString(), windowDays: 30, usage: aggUsage(30) };
}
