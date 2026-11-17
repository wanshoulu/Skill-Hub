import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { APP_SHELL_PAGE_CLASS_NAME } from '@/app/page-shell-style'
import { DashboardPageHeader } from '@/shared/components/dashboard-page-header'
import { getStatsLifecycle } from '@/api/gateClient'
import { Shield, ArrowUpRight, CircleSlash, Inbox, Clock } from 'lucide-react'

function StatusCard({ title, entries }: {
  title: string
  entries: Array<{ label: string; value: number }>
}) {
  const total = entries.reduce((sum, e) => sum + e.value, 0)
  return (
    <div className="rounded-xl border border-border/60 bg-background p-4">
      <h3 className="mb-3 text-sm font-semibold">{title} <span className="ml-1 text-xs font-normal tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>{total}</span></h3>
      <ul className="space-y-1.5">
        {entries.map((e) => (
          <li key={e.label} className="flex items-center justify-between text-xs">
            <span style={{ color: 'hsl(var(--text-secondary))' }}>{e.label}</span>
            <span className="tabular-nums font-medium">{e.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function QueueList({ title, icon: Icon, actionLabel, actionTo, emptyText, children, count }: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  actionLabel?: string
  actionTo?: string
  emptyText: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="h-4 w-4 opacity-70" />
          {title}
          <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">{count}</span>
        </h3>
        {actionLabel && actionTo ? (
          <Link to={actionTo} className="text-xs font-medium text-primary hover:underline">{actionLabel}</Link>
        ) : null}
      </div>
      {count === 0 ? (
        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <Inbox className="h-3.5 w-3.5" />{emptyText}
        </div>
      ) : (
        <ul className="divide-y divide-border/40">{children}</ul>
      )}
    </div>
  )
}

export function DashboardLifecyclePage() {
  const { t } = useTranslation()
  const stats = useQuery({ queryKey: ['gate-stats-lifecycle'], queryFn: getStatsLifecycle, retry: 1 })

  if (stats.isError) {
    return (
      <div className={APP_SHELL_PAGE_CLASS_NAME}>
        <DashboardPageHeader title={t('dashboard.lifecycle.title')} subtitle={t('dashboard.lifecycle.subtitle')} />
        <div className="rounded-xl border border-border/60 bg-background p-5 text-sm">{t('dashboard.lifecycle.error')}</div>
      </div>
    )
  }
  if (stats.isLoading || !stats.data) {
    return (
      <div className={APP_SHELL_PAGE_CLASS_NAME}>
        <DashboardPageHeader title={t('dashboard.lifecycle.title')} subtitle={t('dashboard.lifecycle.subtitle')} />
        <div className="rounded-xl border border-border/60 bg-background p-5 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>...</div>
      </div>
    )
  }

  const { skills, versions, pendingReviews, pendingPromotions, yankedVersions } = stats.data
  const statusEntries = Object.entries(skills.byStatus).map(([k, v]) => ({
    label: t(`dashboard.stats.status.${k}`, { defaultValue: k }),
    value: v,
  }))
  if (skills.hidden > 0) {
    statusEntries.push({ label: t('dashboard.lifecycle.hiddenCount'), value: skills.hidden })
  }
  const versionEntries = Object.entries(versions.byStatus).map(([k, v]) => ({
    label: t(`dashboard.lifecycle.versionStatusLabel.${k}`, { defaultValue: k }),
    value: v,
  }))
  const visibilityEntries = Object.entries(skills.byVisibility).map(([k, v]) => ({
    label: t(`dashboard.stats.visibility.${k}`, { defaultValue: k }),
    value: v,
  }))

  return (
    <div className={APP_SHELL_PAGE_CLASS_NAME}>
      <DashboardPageHeader title={t('dashboard.lifecycle.title')} subtitle={t('dashboard.lifecycle.subtitle')} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatusCard title={t('dashboard.lifecycle.containerStatus')} entries={statusEntries} />
        <StatusCard title={t('dashboard.lifecycle.versionStatus')} entries={versionEntries} />
        <StatusCard title={t('dashboard.lifecycle.visibility')} entries={visibilityEntries} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <QueueList
          title={t('dashboard.lifecycle.queue.reviews')}
          icon={Shield}
          actionLabel={t('dashboard.lifecycle.goReviews')}
          actionTo="/dashboard/reviews"
          emptyText={t('dashboard.lifecycle.empty')}
          count={pendingReviews.length}
        >
          {pendingReviews.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-xs">
              <div className="min-w-0">
                <Link to="/space/$namespace/$slug" params={{ namespace: r.ns, slug: r.slug }} className="font-medium hover:underline">{r.slug}</Link>
                <span className="ml-1 rounded bg-secondary px-1 py-0.5 font-mono text-[10px]">{r.version}</span>
                <div className="mt-0.5 flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Clock className="h-3 w-3" />{new Date(r.submitted_at).toLocaleString()} · {r.submitted_by}
                </div>
              </div>
              <Link to="/dashboard/reviews/$id" params={{ id: String(r.id) }} className="shrink-0" aria-label={t('dashboard.lifecycle.queue.reviews')}>
                <ArrowUpRight className="h-3.5 w-3.5 opacity-60" />
              </Link>
            </li>
          ))}
        </QueueList>

        <QueueList
          title={t('dashboard.lifecycle.queue.promotions')}
          icon={ArrowUpRight}
          actionLabel={t('dashboard.lifecycle.goPromotions')}
          actionTo="/dashboard/promotions"
          emptyText={t('dashboard.lifecycle.empty')}
          count={pendingPromotions.length}
        >
          {pendingPromotions.map((p) => (
            <li key={p.id} className="py-2 text-xs">
              <Link to="/space/$namespace/$slug" params={{ namespace: p.ns, slug: p.slug }} className="font-medium hover:underline">{p.slug}</Link>
              <span className="ml-1 rounded bg-secondary px-1 py-0.5 font-mono text-[10px]">{p.version}</span>
              <span className="ml-1" style={{ color: 'hsl(var(--muted-foreground))' }}>→ @{p.target_ns}</span>
              <div className="mt-0.5 flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <Clock className="h-3 w-3" />{new Date(p.submitted_at).toLocaleString()} · {p.submitted_by}
              </div>
            </li>
          ))}
        </QueueList>

        <QueueList
          title={t('dashboard.lifecycle.queue.yanked')}
          icon={CircleSlash}
          emptyText={t('dashboard.lifecycle.empty')}
          count={yankedVersions.length}
        >
          {yankedVersions.map((v) => (
            <li key={v.version_id} className="py-2 text-xs">
              <Link to="/space/$namespace/$slug" params={{ namespace: v.ns, slug: v.slug }} className="font-medium hover:underline">{v.slug}</Link>
              <span className="ml-1 rounded bg-secondary px-1 py-0.5 font-mono text-[10px]">{v.version}</span>
              {v.published_at ? (
                <div className="mt-0.5 flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Clock className="h-3 w-3" />{new Date(v.published_at).toLocaleString()}
                </div>
              ) : null}
            </li>
          ))}
        </QueueList>
      </div>

      <p className="mt-3 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
        {t('dashboard.stats.asOf', { time: new Date(stats.data.asOf).toLocaleString() })}
      </p>
    </div>
  )
}
