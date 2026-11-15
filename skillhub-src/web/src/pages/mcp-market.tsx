import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Package, Search as SearchIcon, Wrench } from 'lucide-react'
import { getMcpCatalog, type McpCatalogItem } from '@/api/gateClient'
import { SkeletonList } from '@/shared/components/skeleton-loader'
import { EmptyState } from '@/shared/components/empty-state'
import { cn } from '@/shared/lib/utils'
import { APP_SHELL_PAGE_CLASS_NAME } from '@/app/page-shell-style'

/**
 * MCP 市场独立页：展示 gate-service 预置 MCP 工具目录。
 * 数据来自 /gate-api/v1/mcp/catalog，支持关键词搜索与分类筛选。
 */
export function McpMarketPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)

  const { data: catalog, isLoading, isError } = useQuery({
    queryKey: ['mcp-catalog'],
    queryFn: getMcpCatalog,
    staleTime: 5 * 60 * 1000,
  })

  const categories = useMemo(
    () => [...new Set((catalog ?? []).map((c) => c.category))],
    [catalog],
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (catalog ?? []).filter((item) => {
      const matchesFilter = !q ||
        item.name.toLowerCase().includes(q) ||
        (item.display_name ?? '').toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.keywords.some((k) => k.toLowerCase().includes(q))
      const matchesCategory = !selectedCategory || item.category === selectedCategory
      return matchesFilter && matchesCategory
    })
  }, [catalog, filter, selectedCategory])

  return (
    <div className={APP_SHELL_PAGE_CLASS_NAME}>
      {/* 页头 */}
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
          <Wrench className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t('mcpMarket.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('mcpMarket.subtitle')}</p>
        </div>
      </div>

      {/* 搜索 + 分类 */}
      <div className="space-y-4">
        <div className="relative max-w-2xl">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="w-full rounded-lg border bg-background py-2.5 pl-9 pr-4 text-sm outline-none transition-colors focus:border-primary"
            placeholder={t('mcpMarket.searchPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              !selectedCategory ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:opacity-90',
            )}
            onClick={() => setSelectedCategory(null)}
          >
            {t('mcpMarket.allCategories')}
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                selectedCategory === cat ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:opacity-90',
              )}
              onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
            >
              {cat}
            </button>
          ))}
          {filtered.length > 0 && (
            <span className="ml-auto text-xs text-muted-foreground">
              {t('mcpMarket.toolCount', { count: filtered.length })}
            </span>
          )}
        </div>
      </div>

      {/* 工具卡片网格 */}
      {isLoading ? (
        <SkeletonList count={6} />
      ) : isError ? (
        <EmptyState
          title={t('mcpMarket.loadFailed')}
          description={t('mcpMarket.hint')}
        />
      ) : filtered.length === 0 ? (
        <EmptyState title={t('mcpMarket.empty')} description={t('mcpMarket.hint')} />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((item, idx) => (
            <McpToolCard key={item.id} item={item} delay={Math.min(idx % 6 + 1, 6)} />
          ))}
        </div>
      )}

      {/* 底部提示 */}
      <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        <Package className="h-4 w-4 shrink-0" />
        <span>{t('mcpMarket.hint')}</span>
      </div>
    </div>
  )
}

function McpToolCard({ item, delay }: { item: McpCatalogItem; delay: number }) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex h-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md', `animate-fade-up delay-${delay}`)}>
      {/* 标题行 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{item.display_name || item.name}</h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.name}</p>
        </div>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.transport}</span>
      </div>

      {/* 描述 */}
      <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{item.description}</p>

      {/* 分类 + 关键词 */}
      <div className="flex flex-wrap gap-1">
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{item.category}</span>
        {item.keywords.slice(0, 4).map((kw) => (
          <span key={kw} className="text-[10px] text-muted-foreground/70">#{kw}</span>
        ))}
      </div>

      {/* 环境变量 / 参数要求 */}
      {(item.requires_env?.length || item.requires_arg) ? (
        <div className="flex flex-wrap gap-1">
          {item.requires_env?.map((env) => (
            <span key={env} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              {t('mcpMarket.requiresEnv', { env })}
            </span>
          ))}
          {item.requires_arg ? (
            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900 dark:text-sky-300">
              {t('mcpMarket.requiresArg', { arg: item.requires_arg })}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 底部链接 */}
      <div className="mt-auto flex items-center gap-3 border-t pt-2 text-[11px]">
        {item.registry ? (
          <span className="truncate text-muted-foreground" title={item.registry}>{item.registry}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {item.homepage ? (
            <a
              className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
              href={item.homepage}
              target="_blank"
              rel="noreferrer"
            >
              {t('mcpMarket.homepage')}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </span>
      </div>
    </div>
  )
}
