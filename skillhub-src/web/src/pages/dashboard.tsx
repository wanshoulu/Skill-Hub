import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/use-auth'
import { APP_SHELL_PAGE_CLASS_NAME } from '@/app/page-shell-style'
import { DashboardPageHeader } from '@/shared/components/dashboard-page-header'
import {
  getStatsOverview, getStatsTrend, getStatsTop,
} from '@/api/gateClient'
import { formatCompactCount, formatHours, formatPercent } from '@/shared/lib/number-format'
import {
  Star, Heart, Package, Boxes, Key, Shield, Flag, Globe,
  UserCog, Lock, Bell, Clock, ChevronDown, ChevronRight, Github,
  LineChart, GitBranch, Download, ArrowUpRight, CircleDot, Gauge, Users,
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

/**
 * Sidebar navigation groups for the Dashboard.
 *
 * Groups are rendered with a label divider; items within each group share visual spacing.
 * Admin-only items are filtered based on the user's platform roles.
 */

interface SidebarItem {
  key: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  to: string
  analyticsId?: string
  review?: boolean
  admin?: boolean
  superAdmin?: boolean
  passwordCapability?: boolean
  badge?: string
}

interface SidebarGroup {
  label?: string
  items: SidebarItem[]
}

export const SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    label: 'sidebar.account',
    items: [
      { key: 'profile', icon: UserCog, label: 'sidebar.profile', to: '/settings/profile', analyticsId: 'account.profile.open' },
      { key: 'security', icon: Lock, label: 'sidebar.security', to: '/settings/security', analyticsId: 'account.security.open', passwordCapability: true },
      { key: 'notifications', icon: Bell, label: 'sidebar.notifications', to: '/settings/notifications', analyticsId: 'notification.settings.open' },
    ],
  },
  {
    label: 'sidebar.skillsAndData',
    items: [
      { key: 'analytics', icon: LineChart, label: 'sidebar.analytics', to: '/dashboard/analytics', analyticsId: 'stats.analytics.open' },
      { key: 'lifecycle', icon: GitBranch, label: 'sidebar.lifecycle', to: '/dashboard/lifecycle', analyticsId: 'stats.lifecycle.open' },
      { key: 'quality', icon: Gauge, label: 'sidebar.quality', to: '/dashboard/quality', analyticsId: 'stats.quality.open' },
      { key: 'value', icon: Users, label: 'sidebar.value', to: '/dashboard/value', analyticsId: 'stats.value.open' },
      { key: 'skills', icon: Package, label: 'sidebar.mySkills', to: '/dashboard/skills', analyticsId: 'navigation.owned.skills' },
      { key: 'suites', icon: Boxes, label: 'sidebar.mySuites', to: '/dashboard/suites', analyticsId: 'navigation.owned.suites' },
      { key: 'namespaces', icon: Globe, label: 'sidebar.namespaces', to: '/dashboard/namespaces', analyticsId: 'namespace.list.open' },
      { key: 'stars', icon: Star, label: 'sidebar.stars', to: '/dashboard/stars', analyticsId: 'navigation.starred.open' },
      { key: 'subscriptions', icon: Heart, label: 'sidebar.subscriptions', to: '/dashboard/subscriptions', analyticsId: 'navigation.subscriptions.open' },
      { key: 'tokens', icon: Key, label: 'sidebar.tokens', to: '/dashboard/tokens', analyticsId: 'account.tokens.open' },
      { key: 'reviewProgress', icon: Clock, label: 'sidebar.reviewProgress', to: '/dashboard/review-progress', analyticsId: 'review.progress.open' },
    ],
  },
  {
    label: 'sidebar.admin',
    items: [
      { key: 'reviewCenter', icon: Shield, label: 'reviewCenter.title', to: '/dashboard/reviews', analyticsId: 'review.queue.open', review: true },
      { key: 'governance', icon: Flag, label: 'sidebar.governance', to: '/dashboard/governance', analyticsId: 'governance.center.open', admin: true },
      { key: 'githubSync', icon: Github, label: 'sidebar.githubSync', to: '/dashboard/github-sync', analyticsId: 'github.sync.open', superAdmin: true },
    ],
  },
]

// Flatten for backward compatibility with layout.tsx
const SIDEBAR_NAV_ITEMS = SIDEBAR_GROUPS.flatMap((g) => g.items)

export const SIDEBAR_NAV = SIDEBAR_NAV_ITEMS.map(({ key, icon, label, to, review, admin, superAdmin, passwordCapability }) => ({
  key,
  icon,
  label,
  to,
  review,
  admin,
  superAdmin,
  passwordCapability,
  exact: false,
}))

/**
 * Overview cards for the Dashboard home.
 * Shown as a grid of quick-access cards linking to main sections.
 */
const OVERVIEW_CARDS = [
  { key: 'analytics', icon: LineChart, label: 'overview.analytics', to: '/dashboard/analytics', analyticsId: 'stats.analytics.open', desc: 'overview.analyticsDesc' },
  { key: 'lifecycle', icon: GitBranch, label: 'overview.lifecycle', to: '/dashboard/lifecycle', analyticsId: 'stats.lifecycle.open', desc: 'overview.lifecycleDesc' },
  { key: 'skills', icon: Package, label: 'overview.mySkills', to: '/dashboard/skills', analyticsId: 'navigation.owned.skills', desc: 'overview.mySkillsDesc' },
  { key: 'suites', icon: Boxes, label: 'overview.mySuites', to: '/dashboard/suites', analyticsId: 'navigation.owned.suites', desc: 'overview.mySuitesDesc' },
  { key: 'tokens', icon: Key, label: 'overview.tokens', to: '/dashboard/tokens', analyticsId: 'account.tokens.open', desc: 'overview.tokensDesc' },
  { key: 'stars', icon: Star, label: 'overview.stars', to: '/dashboard/stars', analyticsId: 'navigation.starred.open', desc: 'overview.starsDesc' },
  { key: 'profile', icon: UserCog, label: 'overview.profile', to: '/settings/profile', analyticsId: 'account.profile.open', desc: 'overview.profileDesc' },
  { key: 'security', icon: Lock, label: 'overview.security', to: '/settings/security', analyticsId: 'account.security.open', desc: 'overview.securityDesc' },
] as const

// ── 统计看板（gate stats，每小时只读快照）────────────────────────

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'hsl(var(--success))',
  ARCHIVED: 'hsl(var(--muted-foreground))',
  HIDDEN: 'hsl(var(--warning))',
}
const VISIBILITY_COLORS: Record<string, string> = {
  PUBLIC: 'hsl(var(--primary))',
  NAMESPACE: 'hsl(var(--warning))',
  PRIVATE: 'hsl(var(--muted-foreground))',
}

function ChartTooltipDate({ value }: { value: string }) {
  return <span className="text-xs">{value}</span>
}

function KpiCard({ label, value, hint, icon: Icon, to }: {
  label: string
  value: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  to?: string
}) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
        <Icon className="h-4 w-4 opacity-60" />
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums" style={{ color: 'hsl(var(--foreground))' }}>{value}</div>
      {hint ? <div className="mt-1 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{hint}</div> : null}
    </>
  )
  if (to) {
    return (
      <Link to={to} className="block rounded-xl border border-border/60 bg-background p-4 transition-all hover:border-border hover:shadow-sm">
        {body}
      </Link>
    )
  }
  return <div className="rounded-xl border border-border/60 bg-background p-4">{body}</div>
}

function DashboardStatsSection() {
  const { t, i18n } = useTranslation()
  const overview = useQuery({ queryKey: ['gate-stats-overview'], queryFn: getStatsOverview, retry: 1 })
  const trend = useQuery({ queryKey: ['gate-stats-trend', 30], queryFn: () => getStatsTrend(30), retry: 1 })
  const top = useQuery({ queryKey: ['gate-stats-top'], queryFn: getStatsTop, retry: 1 })

  if (overview.isError) {
    return (
      <div className="mb-6 rounded-xl border border-border/60 bg-background p-5">
        <div className="text-sm font-semibold">{t('dashboard.stats.unavailable')}</div>
        <p className="mt-1 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.stats.unavailableHint')}</p>
      </div>
    )
  }
  if (overview.isLoading || !overview.data) return null
  const { kpi, core, asOf } = overview.data
  const asOfText = new Date(asOf).toLocaleString(i18n.language)

  const statusData = Object.entries(kpi.skills.byStatus).map(([name, value]) => ({
    name: t(`dashboard.stats.status.${name}`, { defaultValue: name }),
    key: name,
    value,
  }))
  if (kpi.skills.hidden > 0 && !statusData.some((s) => s.key === 'HIDDEN')) {
    statusData.push({ name: t('dashboard.stats.status.HIDDEN'), key: 'HIDDEN', value: kpi.skills.hidden })
  }
  const visibilityData = Object.entries(kpi.skills.byVisibility).map(([name, value]) => ({
    name: t(`dashboard.stats.visibility.${name}`, { defaultValue: name }),
    value,
  }))

  return (
    <section className="mb-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <CircleDot className="h-3.5 w-3.5" />
          <span>{t('dashboard.stats.asOf', { time: asOfText })}</span>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/analytics" className="inline-flex items-center gap-1 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
            <LineChart className="h-3.5 w-3.5" />{t('dashboard.stats.viewAnalytics')}<ArrowUpRight className="h-3 w-3 opacity-60" />
          </Link>
          <Link to="/dashboard/lifecycle" className="inline-flex items-center gap-1 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
            <GitBranch className="h-3.5 w-3.5" />{t('dashboard.stats.viewLifecycle')}<ArrowUpRight className="h-3 w-3 opacity-60" />
          </Link>
        </div>
      </div>

      {/* KPI 行：基础 4 张 + 核心高价值 4 张 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <KpiCard label={t('dashboard.stats.totalSkills')} value={formatCompactCount(kpi.skills.total)} hint={t('dashboard.stats.namespaces', { count: kpi.namespaces.total })} icon={Package} to="/dashboard/analytics" />
        <KpiCard label={t('dashboard.stats.totalDownloads')} value={formatCompactCount(kpi.downloads.total)} icon={Download} />
        <KpiCard label={t('dashboard.stats.todayDownloads')} value={kpi.downloads.today == null ? '—' : formatCompactCount(kpi.downloads.today)} icon={Download} />
        <KpiCard label={t('dashboard.stats.activeSkillRatio')} value={core?.active ? formatPercent(core.active.ratio) : '—'} hint={core?.active?.active30d != null ? `${core.active.active30d} / ${core.active.published}` : undefined} icon={Package} to="/dashboard/value" />
        <KpiCard label={t('dashboard.stats.avgRating')} value={core?.rating?.avg == null ? '—' : core.rating.avg.toFixed(1)} hint={core?.rating?.ratedCount30d != null ? t('dashboard.stats.avgRatingHint', { count: core.rating.ratedCount30d }) : undefined} icon={Star} to="/dashboard/quality" />
        <KpiCard label={t('dashboard.stats.triggerRate')} value={core?.triggered ? formatPercent(core.triggered.ratio) : '—'} hint={core?.triggered ? t('dashboard.stats.triggerRateHint', { count: core.triggered.count, total: core.triggered.total }) : undefined} icon={CircleDot} to="/dashboard/value" />
        <KpiCard label={t('dashboard.stats.manhours')} value={core?.manhours?.hoursPerMonth != null ? formatHours(core.manhours.hoursPerMonth) : '—'} hint={core?.manhours?.enabled ? t('dashboard.stats.manhoursHint', { hours: core.manhours.perActiveSkillHours }) : t('dashboard.stats.manhoursDisabled')} icon={Gauge} to="/dashboard/value" />
        <KpiCard label={t('dashboard.stats.mau')} value={core?.mau == null ? '—' : formatCompactCount(core.mau)} icon={Users} to="/dashboard/value" />
      </div>

      {/* 趋势图 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('dashboard.stats.downloadTrend')}</h3>
          {trend.data ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend.data.series} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dlFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v: string) => v.slice(5)} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} width={48} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: 'hsl(var(--foreground))' }} labelFormatter={(v) => <ChartTooltipDate value={String(v)} />} />
                  <Area type="monotone" dataKey="downloads" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#dlFill)" connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="flex h-56 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.stats.noData')}</div>}
        </div>
        <div className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('dashboard.stats.publishTrend')}</h3>
          {trend.data ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend.data.series} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v: string) => v.slice(5)} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} width={48} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: 'hsl(var(--foreground))' }} />
                  <Bar dataKey="published" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="flex h-56 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.stats.noData')}</div>}
        </div>
      </div>

      {/* 分布 + Top10 双榜（下载 / 调用） */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('dashboard.stats.statusDist')}</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" innerRadius={38} outerRadius={64} paddingAngle={2} strokeWidth={0}>
                  {statusData.map((entry) => (
                    <Cell key={entry.key} fill={STATUS_COLORS[entry.key] || 'hsl(var(--primary))'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-1">
            {statusData.map((entry) => (
              <li key={entry.key} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[entry.key] || 'hsl(var(--primary))' }} />
                  {entry.name}
                </span>
                <span className="tabular-nums">{entry.value}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('dashboard.stats.visibilityDist')}</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={visibilityData} dataKey="value" nameKey="name" innerRadius={38} outerRadius={64} paddingAngle={2} strokeWidth={0}>
                  {visibilityData.map((entry) => (
                    <Cell key={entry.name} fill={VISIBILITY_COLORS[entry.name] || 'hsl(var(--primary))'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-1">
            {visibilityData.map((entry) => (
              <li key={entry.name} className="flex items-center justify-between text-xs">
                <span>{entry.name}</span>
                <span className="tabular-nums">{entry.value}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('dashboard.stats.topDownloads')}</h3>
          {top.data && top.data.downloads.length > 0 ? (
            <ol className="space-y-1.5">
              {top.data.downloads.map((item, index) => (
                <li key={item.id} className="flex items-center gap-2 text-xs">
                  <span className="w-5 shrink-0 text-center font-semibold tabular-nums" style={{ color: index < 3 ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>{index + 1}</span>
                  <Link to="/space/$namespace/$slug" params={{ namespace: item.ns, slug: item.slug }} className="min-w-0 flex-1 truncate hover:underline">
                    <span className="font-medium">{item.name}</span>
                    <span className="ml-1" style={{ color: 'hsl(var(--muted-foreground))' }}>@{item.ns}/{item.slug}</span>
                  </Link>
                  <span className="shrink-0 tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatCompactCount(item.value)}</span>
                </li>
              ))}
            </ol>
          ) : <div className="flex h-48 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.stats.noData')}</div>}
        </div>
        <div className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-1 text-sm font-semibold">{t('dashboard.stats.topCalls')}</h3>
          <p className="mb-3 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.stats.topCallsHint')}</p>
          {top.data && top.data.calls && top.data.calls.length > 0 ? (
            <ol className="space-y-1.5">
              {top.data.calls.map((item, index) => (
                <li key={item.id} className="flex items-center gap-2 text-xs">
                  <span className="w-5 shrink-0 text-center font-semibold tabular-nums" style={{ color: index < 3 ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>{index + 1}</span>
                  <Link to="/space/$namespace/$slug" params={{ namespace: item.ns, slug: item.slug }} className="min-w-0 flex-1 truncate hover:underline">
                    <span className="font-medium">{item.name}</span>
                    <span className="ml-1" style={{ color: 'hsl(var(--muted-foreground))' }}>@{item.ns}/{item.slug}</span>
                  </Link>
                  <span className="shrink-0 tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatCompactCount(item.value)}</span>
                </li>
              ))}
            </ol>
          ) : <div className="flex h-48 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.stats.noData')}</div>}
        </div>
      </div>
    </section>
  )
}

/**
 * Dashboard overview content; the shared Layout owns its sidebar.
 */
export function DashboardPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  return (
    <div className={APP_SHELL_PAGE_CLASS_NAME}>
      <DashboardPageHeader title={t('dashboard.title')} subtitle={t('dashboard.subtitle')} />
      <DashboardStatsSection />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {OVERVIEW_CARDS.filter((card) => card.key !== 'security' || user?.canChangePassword === true).map((card) => {
        const Icon = card.icon
        return (
          <Link data-analytics-id={card.analyticsId}
            key={card.key}
            to={card.to}
            className="group flex items-start gap-4 rounded-xl border border-border/60 p-5 transition-all duration-150 hover:bg-accent hover:border-border hover:shadow-sm"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-secondary">
              <Icon className="w-5 h-5" style={{ color: 'hsl(var(--foreground))' }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                  {t(card.label)}
                </span>
                <ChevronRight className="w-3.5 h-3.5 opacity-0 -translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0" style={{ color: 'hsl(var(--muted-foreground))' }} />
              </div>
              <p className="mt-1 text-xs leading-relaxed" style={{ color: 'hsl(var(--text-secondary))' }}>
                {t(card.desc)}
              </p>
            </div>
          </Link>
        )
      })}
      </div>
    </div>
  )
}

/** Reusable sidebar for dashboard and its sub-pages. */
export function DashboardSidebar({
  groups,
  user,
  t,
  pathname,
}: {
  groups: SidebarGroup[]
  user: ReturnType<typeof useAuth>['user']
  t: ReturnType<typeof useTranslation>['t']
  pathname: string
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const activeItem = groups.flatMap(group => group.items)
    .find(item => pathname === item.to || pathname.startsWith(item.to))

  return (
    <aside className="w-full lg:w-56 flex-shrink-0">
      <div className="rounded-lg border bg-background lg:hidden">
        <button data-analytics-id="navigation.dashboard.toggle"
          type="button"
          className="flex h-10 w-full items-center justify-between gap-3 px-3 text-sm font-medium"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(open => !open)}
        >
          <span>{t('dashboard.navigation')}</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {activeItem ? t(activeItem.label) : null}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${mobileOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </span>
        </button>
        {mobileOpen ? (
          <div className="grid grid-cols-2 gap-1 border-t p-2">
            {groups.flatMap(group => group.items).map(item => {
              const Icon = item.icon
              const isActive = pathname === item.to || pathname.startsWith(item.to)
              return (
                <Link data-analytics-id={item.analyticsId}
                  key={item.key}
                  to={item.to}
                  className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium ${isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent'}`}
                  onClick={() => setMobileOpen(false)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t(item.label)}</span>
                </Link>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="hidden lg:sticky lg:top-[68px] lg:block">
      {/* User summary */}
      <div className="flex items-center gap-3 px-3 py-2 mb-4">
        {user?.avatarUrl ? (
          <img src={user.avatarUrl} alt={user.displayName} className="h-8 w-8 rounded-full border border-border/60" />
        ) : (
          <div className="h-8 w-8 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
            {user?.displayName?.charAt(0) ?? '?'}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>
            {user?.displayName}
          </div>
          <div className="text-xs truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {user?.email}
          </div>
          <div className="text-xs truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {t('dashboard.userId')}: {user?.userId}
          </div>
        </div>
      </div>

      {/* Nav groups */}
      {groups.map((group) => (
        <div key={group.label ?? 'top'} className="mb-4">
          {group.label && (
            <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {t(group.label)}
            </div>
          )}
          <nav className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.to || pathname.startsWith(item.to)
              return (
                <Link data-analytics-id={item.analyticsId}
                  key={item.key}
                  to={item.to}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150 ${
                    isActive ? 'bg-accent' : 'hover:bg-accent'
                  }`}
                  style={{ color: isActive ? 'hsl(var(--foreground))' : 'hsl(var(--text-secondary))' }}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span>{t(item.label)}</span>
                </Link>
              )
            })}
          </nav>
        </div>
      ))}
      </div>
    </aside>
  )
}
