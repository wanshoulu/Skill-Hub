import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { APP_SHELL_PAGE_CLASS_NAME } from '@/app/page-shell-style'
import { DashboardPageHeader } from '@/shared/components/dashboard-page-header'
import { getStatsSkills, getStatsSkillTrend } from '@/api/gateClient'
import { formatCompactCount } from '@/shared/lib/number-format'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

type SortKey = 'name' | 'downloadCount' | 'downloads7d' | 'downloads30d' | 'starCount' | 'ratingAvg' | 'publishedCount' | 'lastPublishedAt'

const COLUMNS: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
  { key: 'name', label: 'dashboard.analytics.columns.skill' },
  { key: 'downloadCount', label: 'dashboard.analytics.columns.downloads', numeric: true },
  { key: 'downloads7d', label: 'dashboard.analytics.columns.downloads7d', numeric: true },
  { key: 'downloads30d', label: 'dashboard.analytics.columns.downloads30d', numeric: true },
  { key: 'starCount', label: 'dashboard.analytics.columns.stars', numeric: true },
  { key: 'ratingAvg', label: 'dashboard.analytics.columns.rating', numeric: true },
  { key: 'publishedCount', label: 'dashboard.analytics.columns.versions', numeric: true },
  { key: 'lastPublishedAt', label: 'dashboard.analytics.columns.lastPublished', numeric: true },
]

function SkillDrilldown({ skillId, name }: { skillId: number; name: string }) {
  const { t } = useTranslation()
  const drill = useQuery({
    queryKey: ['gate-stats-skill-trend', skillId, 30],
    queryFn: () => getStatsSkillTrend(skillId, 30),
    retry: 1,
  })
  return (
    <tr>
      <td colSpan={COLUMNS.length} className="border-t-0 p-0">
        <div className="border-b border-border/60 bg-secondary/40 px-4 py-3">
          <div className="mb-2 text-xs font-semibold">
            {t('dashboard.analytics.drillTitle', { skill: name })}
          </div>
          <div className="h-40">
            {drill.data ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={drill.data.series} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                  <defs>
                    <linearGradient id="skillDlFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v: string) => v.slice(5)} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} width={48} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: 'hsl(var(--foreground))' }} />
                  <Area type="monotone" dataKey="downloads" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#skillDlFill)" connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {drill.isError ? t('dashboard.analytics.error') : '...'}
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
  )
}

export function DashboardAnalyticsPage() {
  const { t } = useTranslation()
  const [sortKey, setSortKey] = useState<SortKey>('downloadCount')
  const [sortDesc, setSortDesc] = useState(true)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  const stats = useQuery({ queryKey: ['gate-stats-skills'], queryFn: getStatsSkills, retry: 1 })

  const rows = useMemo(() => {
    const list = stats.data?.skills ?? []
    const f = filter.trim().toLowerCase()
    const filtered = f
      ? list.filter((s) => `${s.name} ${s.slug} ${s.ns}`.toLowerCase().includes(f))
      : list
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'name') return `${a.ns}/${a.slug}`.localeCompare(`${b.ns}/${b.slug}`)
      if (sortKey === 'lastPublishedAt') {
        const av = a.lastPublishedAt ? Date.parse(a.lastPublishedAt) : 0
        const bv = b.lastPublishedAt ? Date.parse(b.lastPublishedAt) : 0
        return av - bv
      }
      const av = Number(a[sortKey] ?? 0)
      const bv = Number(b[sortKey] ?? 0)
      return av - bv
    })
    return sortDesc ? sorted.reverse() : sorted
  }, [stats.data, filter, sortKey, sortDesc])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc((d) => !d)
    else {
      setSortKey(key)
      setSortDesc(key !== 'name')
    }
  }

  return (
    <div className={APP_SHELL_PAGE_CLASS_NAME}>
      <DashboardPageHeader title={t('dashboard.analytics.title')} subtitle={t('dashboard.analytics.subtitle')} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('dashboard.analytics.searchPlaceholder')}
            className="h-9 w-64 rounded-md border border-border/60 bg-background pl-8 pr-3 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {stats.data ? t('dashboard.stats.asOf', { time: new Date(stats.data.asOf).toLocaleString() }) : ''}
        </span>
      </div>

      {stats.isError ? (
        <div className="rounded-xl border border-border/60 bg-background p-5 text-sm">{t('dashboard.analytics.error')}</div>
      ) : stats.isLoading ? (
        <div className="rounded-xl border border-border/60 bg-background p-5 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>...</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-background p-5 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.analytics.empty')}</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/60 bg-background">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/60">
                <th className="w-8" />
                {COLUMNS.map((col) => (
                  <th key={col.key} className={`px-3 py-2.5 font-medium ${col.numeric ? 'text-right' : 'text-left'}`}>
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={`inline-flex items-center gap-1 hover:text-foreground ${sortKey === col.key ? 'text-foreground' : 'text-muted-foreground'}`}
                    >
                      {t(col.label)}
                      {sortKey === col.key
                        ? (sortDesc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)
                        : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Fragment key={s.id}>
                  <tr className="border-b border-border/40 transition-colors hover:bg-accent/50">
                    <td className="px-2 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-accent"
                        aria-label="toggle drilldown"
                      >
                        {expanded === s.id
                          ? <ChevronDown className="h-3.5 w-3.5" />
                          : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <Link to="/space/$namespace/$slug" params={{ namespace: s.ns, slug: s.slug }} className="font-medium hover:underline">{s.name}</Link>
                      <span className="ml-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>@{s.ns}/{s.slug}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCompactCount(s.downloadCount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s.downloads7d == null ? '—' : formatCompactCount(s.downloads7d)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s.downloads30d == null ? '—' : formatCompactCount(s.downloads30d)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCompactCount(s.starCount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s.ratingCount > 0 ? s.ratingAvg.toFixed(1) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s.publishedCount}/{s.versionCount}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {s.lastPublishedAt ? new Date(s.lastPublishedAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                  {expanded === s.id ? <SkillDrilldown key={`d-${s.id}`} skillId={s.id} name={`${s.ns}/${s.slug}`} /> : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.analytics.sortHint')}</p>
    </div>
  )
}
