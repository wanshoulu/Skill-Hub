import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleDot, Clock, Info, MessageSquare, Package, Terminal, TrendingUp, UserPlus, Users, Wrench } from 'lucide-react'
import { APP_SHELL_PAGE_CLASS_NAME } from '@/app/page-shell-style'
import { DashboardPageHeader } from '@/shared/components/dashboard-page-header'
import {
  getStatsAdoption,
  getStatsTriggers,
  getStatsValue,
  type StatsAdoptionView,
  type StatsTriggerKind,
  type StatsTriggerKindStats,
  type StatsTriggersView,
  type StatsValueView,
} from '@/api/gateClient'
import { formatCompactCount, formatPercent } from '@/shared/lib/number-format'
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

/**
 * Business Value dashboard: skill asset activity, contributor reuse and business-event
 * adoption backed by /stats/value and /stats/adoption snapshots. Optional segments
 * (adoption disabled, man-hours not configured) degrade to explanatory placeholders.
 */

const TOOLTIP_STYLE = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
} as const

function MetricCard({ label, value, hint, icon: Icon }: {
  label: string
  value: string
  hint?: string
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
        {Icon ? <Icon className="h-4 w-4 opacity-60" /> : null}
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums" style={{ color: 'hsl(var(--foreground))' }}>{value}</div>
      {hint ? <div className="mt-1 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{hint}</div> : null}
    </div>
  )
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex h-56 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{text}</div>
  )
}

function SectionResult({ isError, isLoading, errorText, children }: {
  isError: boolean
  isLoading: boolean
  errorText: string
  children: React.ReactNode
}) {
  if (isError) {
    return <div className="rounded-xl border border-border/60 bg-background p-5 text-sm">{errorText}</div>
  }
  if (isLoading) {
    return (
      <div className="rounded-xl border border-border/60 bg-background p-5 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>...</div>
    )
  }
  return <>{children}</>
}

// ── 价值卡 ─────────────────────────────────────────────────────

function ValueSection({ data }: { data: StatsValueView }) {
  const { t } = useTranslation()
  const { activeSkills, suites, manhours, contributors } = data

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard
        label={t('dashboard.value.activeSkills')}
        value={formatPercent(activeSkills.ratio)}
        hint={t('dashboard.value.activeSkillsHint', {
          active: activeSkills.active30d == null ? '—' : formatCompactCount(activeSkills.active30d),
          published: formatCompactCount(activeSkills.published),
        })}
        icon={TrendingUp}
      />
      <MetricCard
        label={t('dashboard.value.suites')}
        value={suites ? formatCompactCount(suites.total) : '—'}
        icon={Package}
      />
      <MetricCard
        label={t('dashboard.value.manhours')}
        value={manhours.enabled && manhours.hoursPerMonth != null ? `${formatCompactCount(manhours.hoursPerMonth)}h` : '—'}
        hint={manhours.enabled && manhours.hoursPerMonth != null ? manhours.note : t('dashboard.value.manhoursDisabled')}
        icon={Clock}
      />
      <MetricCard
        label={t('dashboard.value.contributors')}
        value={contributors ? formatCompactCount(contributors.active30d) : '—'}
        hint={contributors ? t('dashboard.value.contributorsHint', { added: formatCompactCount(contributors.new30d) }) : undefined}
        icon={UserPlus}
      />
    </div>
  )
}

// ── 采纳区 ─────────────────────────────────────────────────────

function AdoptionDisabledNotice() {
  const { t } = useTranslation()
  return (
    <div className="rounded-xl border border-border/60 bg-background p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Info className="h-4 w-4 opacity-70" />
        {t('dashboard.value.adoptionDisabledTitle')}
      </div>
      <p className="mt-1 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.value.adoptionDisabledHint')}</p>
    </div>
  )
}

function AdoptionSection({ data }: { data: StatsAdoptionView }) {
  const { t } = useTranslation()
  const { users, channels, autoPublish, adoptionCurve, reuse, topSkillsByUsers } = data

  if (!data.enabled) return <AdoptionDisabledNotice />

  const autoRatio = autoPublish && autoPublish.total > 0
    ? formatPercent((autoPublish.auto / autoPublish.total) * 100)
    : '—'
  const dauSeries = users?.dauSeries ?? []
  const curveData = (adoptionCurve ?? []).map((p) => ({
    day: `D+${p.offset_day}`,
    downloads: p.downloads,
    skills: p.skills,
  }))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label={t('dashboard.value.dau')} value={users ? formatCompactCount(users.dau) : '—'} icon={Users} />
        <MetricCard label={t('dashboard.value.wau')} value={users ? formatCompactCount(users.wau) : '—'} icon={Users} />
        <MetricCard label={t('dashboard.value.mau')} value={users ? formatCompactCount(users.mau) : '—'} icon={Users} />
        <MetricCard
          label={t('dashboard.value.autoPublish')}
          value={autoRatio}
          hint={autoPublish ? t('dashboard.value.autoPublishHint', {
            auto: formatCompactCount(autoPublish.auto),
            total: formatCompactCount(autoPublish.total),
          }) : undefined}
          icon={TrendingUp}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('dashboard.value.dauTrend')}</h3>
          {dauSeries.length > 0 ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dauSeries} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dauFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v: string) => v.slice(5)} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} width={48} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'hsl(var(--foreground))' }} />
                  <Area type="monotone" dataKey="users" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#dauFill)" connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyChart text={t('dashboard.stats.noData')} />}
        </div>
        <div className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('dashboard.value.adoptionCurve')}</h3>
          {curveData.length > 0 ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={curveData} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                  <defs>
                    <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} width={48} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'hsl(var(--foreground))' }} />
                  <Area type="monotone" dataKey="downloads" name={t('dashboard.value.adoptionCurveDownloads')} stroke="hsl(var(--success))" strokeWidth={2} fill="url(#curveFill)" connectNulls />
                  <Line type="monotone" dataKey="skills" name={t('dashboard.value.adoptionCurveSkills')} stroke="hsl(var(--primary))" strokeWidth={2} dot={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyChart text={t('dashboard.stats.noData')} />}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <MetricCard
          label={t('dashboard.value.reuseRate')}
          value={reuse ? formatPercent(reuse.reuseRate) : '—'}
          hint={reuse ? t('dashboard.value.reuseHint', {
            multi: formatCompactCount(reuse.multiUserSkills),
            with: formatCompactCount(reuse.skillsWithUsers),
          }) : undefined}
          icon={Users}
        />
        <div className="rounded-xl border border-border/60 bg-background p-4 xl:col-span-2">
          <h3 className="mb-3 text-sm font-semibold">{t('dashboard.value.channels')}</h3>
          {channels && channels.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60">
                    <th className="px-3 py-2 text-left font-medium">{t('dashboard.value.channelSource')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('dashboard.value.channelEvents')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('dashboard.value.channelUsers')}</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.source} className="border-b border-border/40 transition-colors hover:bg-accent/50">
                      <td className="px-3 py-2">{t(`dashboard.value.channel.${c.source}`, { defaultValue: c.source })}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCompactCount(c.events)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCompactCount(c.users)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="flex h-24 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.value.channelsEmpty')}</div>}
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('dashboard.value.topSkillsByUsers')}</h3>
        {topSkillsByUsers && topSkillsByUsers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60">
                  <th className="w-8 px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">{t('dashboard.value.topSkillName')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('dashboard.value.topSkillUsers')}</th>
                </tr>
              </thead>
              <tbody>
                {topSkillsByUsers.map((s, index) => (
                  <tr key={s.id} className="border-b border-border/40 transition-colors hover:bg-accent/50">
                    <td className="px-3 py-2 tabular-nums" style={{ color: index < 3 ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>{index + 1}</td>
                    <td className="px-3 py-2">
                      <Link to="/space/$namespace/$slug" params={{ namespace: s.ns, slug: s.slug }} className="font-medium hover:underline">{s.name}</Link>
                      <span className="ml-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>@{s.ns}/{s.slug}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCompactCount(s.users)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="flex h-24 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.value.topSkillsEmpty')}</div>}
      </div>
    </div>
  )
}

// ── 触发调用区 ─────────────────────────────────────────────────

const TRIGGER_KINDS: StatsTriggerKind[] = ['agent_chat', 'mcp_tool', 'skill']

const TRIGGER_KIND_ICONS: Record<StatsTriggerKind, React.ComponentType<{ className?: string }>> = {
  agent_chat: MessageSquare,
  mcp_tool: Wrench,
  skill: Terminal,
}

function TriggerStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</div>
      <div className="mt-0.5 text-lg font-bold tabular-nums" style={{ color: 'hsl(var(--foreground))' }}>{value}</div>
    </div>
  )
}

function TriggerKindCard({ kind, stats }: { kind: StatsTriggerKind; stats?: StatsTriggerKindStats }) {
  const { t } = useTranslation()
  const Icon = TRIGGER_KIND_ICONS[kind]

  return (
    <div className="rounded-xl border border-border/60 bg-background p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t(`dashboard.value.triggers.kind.${kind}`)}</h3>
        <Icon className="h-4 w-4 opacity-60" />
      </div>
      {!stats || stats.total === 0 ? (
        <div className="flex h-44 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {t('dashboard.value.triggers.empty')}
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <TriggerStat label={t('dashboard.value.triggers.total')} value={formatCompactCount(stats.total)} />
            <TriggerStat label={t('dashboard.value.triggers.failRate')} value={formatPercent(stats.failRate)} />
            <TriggerStat label={t('dashboard.value.triggers.uniqueUsers')} value={formatCompactCount(stats.uniqueUsers)} />
          </div>
          <div className="mt-4">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {t('dashboard.value.triggers.top')}
            </div>
            {stats.top.length > 0 ? (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60">
                    <th className="py-1.5 pr-2 text-left font-medium">{t('dashboard.value.triggers.name')}</th>
                    <th className="px-2 py-1.5 text-right font-medium">{t('dashboard.value.triggers.count')}</th>
                    <th className="py-1.5 pl-2 text-right font-medium">{t('dashboard.value.triggers.users')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.top.slice(0, 5).map((item) => (
                    <tr key={item.name} className="border-b border-border/40 last:border-b-0 transition-colors hover:bg-accent/50">
                      <td className="max-w-0 truncate py-1.5 pr-2" title={item.name}>{item.name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatCompactCount(item.count)}</td>
                      <td className="py-1.5 pl-2 text-right tabular-nums">{formatCompactCount(item.users)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex h-16 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {t('dashboard.value.triggers.empty')}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function TriggersSection({ data }: { data: StatsTriggersView }) {
  const { t, i18n } = useTranslation()

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
        <CircleDot className="h-3.5 w-3.5" />
        <span>{t('dashboard.value.triggers.asOf', { time: new Date(data.asOf).toLocaleString(i18n.language), days: data.windowDays })}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {TRIGGER_KINDS.map((kind) => (
          <TriggerKindCard key={kind} kind={kind} stats={data.usage[kind]} />
        ))}
      </div>
      <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.value.triggers.cliHint')}</p>
    </div>
  )
}

// ── 页面 ───────────────────────────────────────────────────────

export function DashboardValuePage() {
  const { t, i18n } = useTranslation()
  const value = useQuery({ queryKey: ['gate-stats-value'], queryFn: getStatsValue, retry: 1 })
  const adoption = useQuery({ queryKey: ['gate-stats-adoption'], queryFn: getStatsAdoption, retry: 1 })
  const triggers = useQuery({ queryKey: ['gate-stats-triggers'], queryFn: getStatsTriggers, retry: 1 })

  const asOf = value.data?.asOf ?? adoption.data?.asOf

  return (
    <div className={APP_SHELL_PAGE_CLASS_NAME}>
      <DashboardPageHeader title={t('dashboard.value.title')} subtitle={t('dashboard.value.subtitle')} />

      {asOf ? (
        <div className="mb-4 flex items-center gap-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <CircleDot className="h-3.5 w-3.5" />
          <span>{t('dashboard.stats.asOf', { time: new Date(asOf).toLocaleString(i18n.language) })}</span>
        </div>
      ) : null}

      <SectionResult isError={value.isError} isLoading={value.isLoading} errorText={t('dashboard.value.error')}>
        {value.data ? <ValueSection data={value.data} /> : null}
      </SectionResult>

      <div className="mt-6 mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t('dashboard.value.adoptionSection')}</h2>
        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.value.adoptionDesc')}</span>
      </div>
      <SectionResult isError={adoption.isError} isLoading={adoption.isLoading} errorText={t('dashboard.value.error')}>
        {adoption.data ? <AdoptionSection data={adoption.data} /> : null}
      </SectionResult>

      <div className="mt-6 mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t('dashboard.value.triggers.title')}</h2>
      </div>
      <SectionResult isError={triggers.isError} isLoading={triggers.isLoading} errorText={t('dashboard.value.error')}>
        {triggers.data ? <TriggersSection data={triggers.data} /> : null}
      </SectionResult>
    </div>
  )
}
