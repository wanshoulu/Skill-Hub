import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { BadgeCheck, CircleDot, CircleSlash, EyeOff, ShieldCheck, Timer } from 'lucide-react'
import { APP_SHELL_PAGE_CLASS_NAME } from '@/app/page-shell-style'
import { DashboardPageHeader } from '@/shared/components/dashboard-page-header'
import {
  getStatsEfficiency,
  getStatsGovernance,
  getStatsQuality,
  type StatsEfficiencyView,
  type StatsGovernanceView,
  type StatsQualityView,
} from '@/api/gateClient'
import { formatCompactCount, formatHours, formatPercent } from '@/shared/lib/number-format'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

/**
 * Quality & Efficiency dashboard: gate quality, review efficiency and governance health
 * backed by the /stats/quality, /stats/efficiency and /stats/governance snapshots.
 * Every metric degrades to "—" when the backend marks the segment unavailable (null).
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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {children}
    </div>
  )
}

function EntriesList({ entries }: { entries: Array<{ label: string; value: string }> }) {
  return (
    <ul className="space-y-1.5">
      {entries.map((e) => (
        <li key={e.label} className="flex items-center justify-between text-xs">
          <span style={{ color: 'hsl(var(--text-secondary))' }}>{e.label}</span>
          <span className="font-medium tabular-nums">{e.value}</span>
        </li>
      ))}
    </ul>
  )
}

function BarList({ entries, emptyText }: { entries: Array<{ label: string; value: number }>; emptyText: string }) {
  if (entries.length === 0) {
    return <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{emptyText}</div>
  }
  const max = Math.max(...entries.map((e) => e.value), 1)
  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.label} className="text-xs">
          <div className="flex items-center justify-between">
            <span style={{ color: 'hsl(var(--text-secondary))' }}>{e.label}</span>
            <span className="font-medium tabular-nums">{formatCompactCount(e.value)}</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full" style={{ width: `${Math.round((e.value / max) * 100)}%`, background: 'hsl(var(--primary))' }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function SectionHeading({ icon: Icon, title, desc }: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 opacity-70" />
      <h2 className="text-sm font-semibold">{title}</h2>
      {desc ? <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{desc}</span> : null}
    </div>
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

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{text}</div>
  )
}

// ── 质量区 ─────────────────────────────────────────────────────

function QualitySection({ data }: { data: StatsQualityView }) {
  const { t } = useTranslation()
  const { gate, ratings } = data

  const stageData = Object.entries(gate.stageFailures)
    .map(([name, value]) => ({ name: t(`dashboard.quality.stage.${name}`, { defaultValue: name }), value }))
    .sort((a, b) => b.value - a.value)

  const ruleEntries = Object.entries(gate.topViolationRules)
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const distributionData = [1, 2, 3, 4, 5].map((star) => ({
    star: `${star}★`,
    value: ratings?.distribution?.[String(star)] ?? 0,
  }))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label={t('dashboard.quality.gatePassRate')}
          value={formatPercent(gate.gate.passRate)}
          hint={t('dashboard.quality.gatePassRateHint', {
            passed: formatCompactCount(gate.gate.passed),
            total: formatCompactCount(gate.gate.total),
            days: gate.windowDays,
          })}
        />
        <MetricCard
          label={t('dashboard.quality.evalAccuracy')}
          value={formatPercent(gate.eval.avgAccuracy)}
          hint={t('dashboard.quality.evalAccuracyHint', { runs: formatCompactCount(gate.eval.total) })}
        />
        <MetricCard
          label={t('dashboard.quality.avgScore')}
          value={ratings?.avgScore == null ? '—' : ratings.avgScore.toFixed(1)}
        />
        <MetricCard
          label={t('dashboard.quality.ratedCount30d')}
          value={ratings ? formatCompactCount(ratings.ratedCount30d) : '—'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title={t('dashboard.quality.stageFailures')}>
          {stageData.length > 0 ? (
            <div style={{ height: Math.max(stageData.length * 32 + 16, 96) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stageData} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={110} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'hsl(var(--accent))' }} />
                  <Bar dataKey="value" fill="hsl(var(--warning))" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyChart text={t('dashboard.stats.noData')} />}
        </Card>
        <Card title={t('dashboard.quality.ratingDistribution')}>
          {ratings ? (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={distributionData} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="star" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} width={48} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'hsl(var(--accent))' }} />
                  <Bar dataKey="value" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyChart text={t('dashboard.quality.ratingsUnavailable')} />}
        </Card>
        <Card title={t('dashboard.quality.topViolationRules')}>
          {ruleEntries.length > 0 ? (
            <ol className="space-y-1.5">
              {ruleEntries.map((entry, index) => (
                <li key={entry.rule} className="flex items-center gap-2 text-xs">
                  <span className="w-5 shrink-0 text-center font-semibold tabular-nums" style={{ color: index < 3 ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{entry.rule}</span>
                  <span className="shrink-0 tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatCompactCount(entry.count)}</span>
                </li>
              ))}
            </ol>
          ) : <EmptyChart text={t('dashboard.stats.noData')} />}
        </Card>
      </div>
    </div>
  )
}

// ── 效率区 ─────────────────────────────────────────────────────

function flowEntries(t: ReturnType<typeof useTranslation>['t'], flow: { completed: number; rejected: number; p50h: number | null; p90h: number | null } | null, p50Label: string, p90Label: string) {
  if (!flow) {
    return [
      { label: t('dashboard.quality.reviewCompleted'), value: '—' },
      { label: t('dashboard.quality.reviewRejected'), value: '—' },
      { label: t('dashboard.quality.rejectionRate'), value: '—' },
      { label: p50Label, value: '—' },
      { label: p90Label, value: '—' },
    ]
  }
  const total = flow.completed + flow.rejected
  return [
    { label: t('dashboard.quality.reviewCompleted'), value: formatCompactCount(flow.completed) },
    { label: t('dashboard.quality.reviewRejected'), value: formatCompactCount(flow.rejected) },
    { label: t('dashboard.quality.rejectionRate'), value: total > 0 ? formatPercent((flow.rejected / total) * 100) : '—' },
    { label: p50Label, value: formatHours(flow.p50h) },
    { label: p90Label, value: formatHours(flow.p90h) },
  ]
}

function EfficiencySection({ data }: { data: StatsEfficiencyView }) {
  const { t } = useTranslation()
  const { review, promotion, publishLeadTime, contributors, publishFrequency } = data

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Card title={t('dashboard.quality.reviewTitle')}>
        <EntriesList entries={flowEntries(t, review, t('dashboard.quality.reviewP50h'), t('dashboard.quality.reviewP90h'))} />
      </Card>
      <Card title={t('dashboard.quality.promotionTitle')}>
        <EntriesList entries={flowEntries(t, promotion, t('dashboard.quality.reviewP50h'), t('dashboard.quality.reviewP90h'))} />
      </Card>
      <Card title={t('dashboard.quality.leadTimeTitle')}>
        <EntriesList entries={[
          { label: t('dashboard.quality.leadTimeP50h'), value: formatHours(publishLeadTime?.p50h) },
          { label: t('dashboard.quality.leadTimeP90h'), value: formatHours(publishLeadTime?.p90h) },
          { label: t('dashboard.quality.leadTimeSamples'), value: publishLeadTime ? formatCompactCount(publishLeadTime.samples) : '—' },
        ]} />
      </Card>
      <Card title={t('dashboard.quality.frequencyTitle')}>
        <EntriesList entries={[
          { label: t('dashboard.quality.publish30d'), value: formatCompactCount(publishFrequency.last30d) },
          { label: t('dashboard.quality.publish90d'), value: formatCompactCount(publishFrequency.last90d) },
        ]} />
      </Card>
      <Card title={t('dashboard.quality.contributorsTitle')}>
        <EntriesList entries={[
          { label: t('dashboard.quality.contributorsActive'), value: contributors ? formatCompactCount(contributors.active30d) : '—' },
          { label: t('dashboard.quality.contributorsNew'), value: contributors ? formatCompactCount(contributors.new30d) : '—' },
        ]} />
      </Card>
    </div>
  )
}

// ── 治理区 ─────────────────────────────────────────────────────

function GovernanceSection({ data }: { data: StatsGovernanceView }) {
  const { t } = useTranslation()
  const { security, pendingBacklog } = data

  const severityEntries = security
    ? Object.entries(security.severity)
        .map(([name, value]) => ({ label: t(`dashboard.quality.severity.${name}`, { defaultValue: name }), value }))
        .sort((a, b) => b.value - a.value)
    : []

  const backlogEntries = pendingBacklog
    ? [
        { label: t('dashboard.quality.backlogBuckets.lt1d'), value: pendingBacklog.lt1d },
        { label: t('dashboard.quality.backlogBuckets.d1to3'), value: pendingBacklog.d1to3 },
        { label: t('dashboard.quality.backlogBuckets.d3to7'), value: pendingBacklog.d3to7 },
        { label: t('dashboard.quality.backlogBuckets.gt7d'), value: pendingBacklog.gt7d },
      ]
    : []

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card title={t('dashboard.quality.securityTitle')}>
        {security ? (
          <div className="space-y-3">
            <EntriesList entries={[
              { label: t('dashboard.quality.securityScans'), value: formatCompactCount(security.scans) },
              { label: t('dashboard.quality.securityUnsafe'), value: formatCompactCount(security.unsafe) },
              { label: t('dashboard.quality.securityFindings'), value: formatCompactCount(security.findings) },
            ]} />
            <div>
              <div className="mb-1.5 text-[11px] font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.quality.severityDist')}</div>
              <BarList entries={severityEntries} emptyText={t('dashboard.stats.noData')} />
            </div>
          </div>
        ) : <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.stats.noData')}</div>}
      </Card>
      <Card title={t('dashboard.quality.backlogTitle')}>
        {pendingBacklog ? (
          <div className="space-y-3">
            <BarList entries={backlogEntries} emptyText={t('dashboard.stats.noData')} />
            <EntriesList entries={[
              { label: t('dashboard.quality.backlogPendingReviews'), value: formatCompactCount(data.pendingReviews) },
              { label: t('dashboard.quality.backlogPendingPromotions'), value: formatCompactCount(data.pendingPromotions) },
            ]} />
          </div>
        ) : <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('dashboard.stats.noData')}</div>}
      </Card>
      <MetricCard
        label={t('dashboard.quality.yankedCount')}
        value={formatCompactCount(data.yankedCount)}
        icon={CircleSlash}
      />
      <MetricCard
        label={t('dashboard.quality.hiddenSkills')}
        value={formatCompactCount(data.hiddenSkills)}
        icon={EyeOff}
      />
    </div>
  )
}

// ── 页面 ───────────────────────────────────────────────────────

export function DashboardQualityPage() {
  const { t, i18n } = useTranslation()
  const quality = useQuery({ queryKey: ['gate-stats-quality'], queryFn: getStatsQuality, retry: 1 })
  const efficiency = useQuery({ queryKey: ['gate-stats-efficiency'], queryFn: getStatsEfficiency, retry: 1 })
  const governance = useQuery({ queryKey: ['gate-stats-governance'], queryFn: getStatsGovernance, retry: 1 })

  const asOf = quality.data?.asOf ?? efficiency.data?.asOf ?? governance.data?.asOf

  return (
    <div className={APP_SHELL_PAGE_CLASS_NAME}>
      <DashboardPageHeader title={t('dashboard.quality.title')} subtitle={t('dashboard.quality.subtitle')} />

      {asOf ? (
        <div className="mb-4 flex items-center gap-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <CircleDot className="h-3.5 w-3.5" />
          <span>{t('dashboard.stats.asOf', { time: new Date(asOf).toLocaleString(i18n.language) })}</span>
        </div>
      ) : null}

      <section className="space-y-3">
        <SectionHeading icon={BadgeCheck} title={t('dashboard.quality.qualitySection')} desc={t('dashboard.quality.qualityDesc')} />
        <SectionResult isError={quality.isError} isLoading={quality.isLoading} errorText={t('dashboard.quality.error')}>
          {quality.data ? <QualitySection data={quality.data} /> : null}
        </SectionResult>
      </section>

      <section className="mt-6 space-y-3">
        <SectionHeading icon={Timer} title={t('dashboard.quality.efficiencySection')} desc={t('dashboard.quality.efficiencyDesc')} />
        <SectionResult isError={efficiency.isError} isLoading={efficiency.isLoading} errorText={t('dashboard.quality.error')}>
          {efficiency.data ? <EfficiencySection data={efficiency.data} /> : null}
        </SectionResult>
      </section>

      <section className="mt-6 space-y-3">
        <SectionHeading icon={ShieldCheck} title={t('dashboard.quality.governanceSection')} desc={t('dashboard.quality.governanceDesc')} />
        <SectionResult isError={governance.isError} isLoading={governance.isLoading} errorText={t('dashboard.quality.error')}>
          {governance.data ? <GovernanceSection data={governance.data} /> : null}
        </SectionResult>
      </section>
    </div>
  )
}
