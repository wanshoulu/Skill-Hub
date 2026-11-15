import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  ExternalLink,
  Package,
  PlugZap,
  Search as SearchIcon,
  Wrench,
  XCircle,
} from 'lucide-react'
import {
  addMcpServer,
  getMcpCatalog,
  listMcpServers,
  probeMcpServer,
  type McpCatalogItem,
  type McpServerStatus,
} from '@/api/gateClient'
import { SkeletonList } from '@/shared/components/skeleton-loader'
import { EmptyState } from '@/shared/components/empty-state'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { cn } from '@/shared/lib/utils'
import { APP_SHELL_PAGE_CLASS_NAME } from '@/app/page-shell-style'

/**
 * MCP 市场：展示 gate-service 预置 MCP 工具目录。
 * 支持关键词搜索、分类筛选、点击查看详情，并可一键启用到网关（注册进 MCP 注册表）
 * 与测试连接（触发 stdio/HTTP 探测，列出可用工具）。
 */
export function McpMarketPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selected, setSelected] = useState<McpCatalogItem | null>(null)

  const { data: catalog, isLoading, isError } = useQuery({
    queryKey: ['mcp-catalog'],
    queryFn: getMcpCatalog,
    staleTime: 5 * 60 * 1000,
  })

  // 已启用（注册进网关）的服务器，用于卡片角标与详情页状态判断
  const { data: installedServers } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: listMcpServers,
    retry: false,
  })

  const installedNames = useMemo(
    () => new Set((installedServers ?? []).map((s) => s.name)),
    [installedServers],
  )

  const installMutation = useMutation({
    mutationFn: (item: McpCatalogItem) =>
      addMcpServer({
        name: item.name,
        transport: item.transport,
        command: item.command,
        args: item.args,
        env: item.env ?? {},
        url: item.url,
        headers: item.headers ?? {},
        enabled: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })
    },
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
            <McpToolCard
              key={item.id}
              item={item}
              delay={Math.min(idx % 6 + 1, 6)}
              installed={installedNames.has(item.name)}
              onOpen={() => setSelected(item)}
            />
          ))}
        </div>
      )}

      {/* 底部提示 */}
      <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        <Package className="h-4 w-4 shrink-0" />
        <span>{t('mcpMarket.hint')}</span>
      </div>

      {/* 详情弹窗 */}
      <McpToolDetailDialog
        item={selected}
        installed={selected ? installedNames.has(selected.name) : false}
        installPending={installMutation.isPending}
        installError={installMutation.error instanceof Error ? installMutation.error.message : null}
        onInstall={(item) => installMutation.mutate(item)}
        onClose={() => {
          setSelected(null)
          installMutation.reset()
        }}
      />
    </div>
  )
}

function McpToolCard({
  item,
  delay,
  installed,
  onOpen,
}: {
  item: McpCatalogItem
  delay: number
  installed: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex h-full cursor-pointer flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:shadow-md hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        `animate-fade-up delay-${delay}`,
      )}
    >
      {/* 标题行 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{item.display_name || item.name}</h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {installed ? (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
              {t('mcpMarket.installed')}
            </span>
          ) : null}
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.transport}</span>
        </div>
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

      {/* 底部：registry + 查看详情提示 */}
      <div className="mt-auto flex items-center gap-3 border-t pt-2 text-[11px]">
        <span className="truncate text-muted-foreground" title={item.registry || ''}>{item.registry || item.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground transition-colors group-hover:text-foreground">
          {t('mcpMarket.viewDetail')}
        </span>
      </div>
    </button>
  )
}

/** 详情弹窗：完整信息 + 启用到网关 + 测试连接 */
function McpToolDetailDialog({
  item,
  installed,
  installPending,
  installError,
  onInstall,
  onClose,
}: {
  item: McpCatalogItem | null
  installed: boolean
  installPending: boolean
  installError: string | null
  onInstall: (item: McpCatalogItem) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  // 已启用服务器的 id（匹配 name；安装成功后 mcp-servers 查询失效自动刷新）
  const { data: servers } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: listMcpServers,
    retry: false,
    enabled: !!item,
  })
  const matchedId = servers?.find((s) => s.name === item?.name)?.id ?? null

  // 测试连接：探测该服务器并展示结果
  const [probeResult, setProbeResult] = useState<McpServerStatus | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)

  const handleProbe = async () => {
    if (!matchedId) return
    setProbing(true)
    setProbeError(null)
    try {
      const status = await probeMcpServer(matchedId)
      setProbeResult(status)
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : String(e))
    } finally {
      setProbing(false)
    }
  }

  const handleClosed = (open: boolean) => {
    if (!open) {
      setProbeResult(null)
      setProbeError(null)
      onClose()
    }
  }

  return (
    <Dialog open={!!item} onOpenChange={handleClosed}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="truncate">{item.display_name || item.name}</span>
                {installed ? (
                  <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                    {t('mcpMarket.installed')}
                  </span>
                ) : null}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{item.transport}</span>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{item.category}</span>
                <span className="text-[11px]">{item.name}</span>
              </DialogDescription>
            </DialogHeader>

            {/* 描述 */}
            <p className="text-sm leading-relaxed text-muted-foreground">{item.description}</p>

            {/* 连接配置 */}
            <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-semibold">{t('mcpMarket.connection')}</p>
              {item.transport === 'stdio' ? (
                <div className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">{t('mcpMarket.command')}</p>
                  <code className="block break-all rounded bg-background p-2 font-mono text-[11px]">
                    {item.command} {(item.args ?? []).join(' ')}
                  </code>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">{t('mcpMarket.url')}</p>
                  <code className="block break-all rounded bg-background p-2 font-mono text-[11px]">{item.url}</code>
                </div>
              )}
              {/* 预置环境变量（仅展示键名，值在网关注册表） */}
              {item.env && Object.keys(item.env).length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 pt-1">
                  <span className="text-[11px] text-muted-foreground">{t('mcpMarket.envPreset')}:</span>
                  {Object.keys(item.env).map((k) => (
                    <span key={k} className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px]">{k}</span>
                  ))}
                </div>
              ) : null}
            </div>

            {/* 环境变量 / 参数要求 */}
            {(item.requires_env?.length || item.requires_arg) ? (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold">{t('mcpMarket.envRequiredTitle')}</p>
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
                <p className="text-[11px] text-muted-foreground">{t('mcpMarket.envRequiredHint')}</p>
              </div>
            ) : null}

            {/* 关键词 */}
            <div className="space-y-1">
              <p className="text-xs font-semibold">{t('mcpMarket.keywordsLabel')}</p>
              <div className="flex flex-wrap gap-1">
                {item.keywords.map((kw) => (
                  <span key={kw} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">#{kw}</span>
                ))}
              </div>
            </div>

            {/* registry / homepage */}
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              {item.registry ? (
                <span className="text-muted-foreground" title={item.registry}>
                  {t('mcpMarket.registry')}: {item.registry}
                </span>
              ) : null}
              {item.homepage ? (
                <a
                  className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                  href={item.homepage}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('mcpMarket.viewHomepage')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>

            {/* 启用错误 / 探测结果 */}
            {installError ? (
              <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{installError}</p>
            ) : null}
            {probeError ? (
              <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{probeError}</p>
            ) : null}
            {probeResult ? (
              <div className="flex items-start gap-2 rounded-md border p-2.5 text-xs">
                {probeResult.status === 'online' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0">
                  <p className="font-medium">
                    {probeResult.status === 'online'
                      ? t('mcpMarket.probeOnline', { count: (probeResult.tools ?? []).length })
                      : t('mcpMarket.probeOffline')}
                  </p>
                  {probeResult.error ? (
                    <p className="mt-0.5 break-all text-[11px] text-muted-foreground">{probeResult.error}</p>
                  ) : null}
                  {probeResult.status === 'online' && (probeResult.tools ?? []).length > 0 ? (
                    <p className="mt-1 line-clamp-3 text-[11px] text-muted-foreground">
                      {probeResult.tools.map((tool) => tool.name).join('、')}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <DialogFooter className="items-center gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                {t('mcpMarket.close')}
              </Button>
              {matchedId ? (
                <Button variant="outline" size="sm" onClick={handleProbe} disabled={probing}>
                  <PlugZap className={cn('mr-1 h-3.5 w-3.5', probing && 'animate-pulse')} />
                  {probing ? t('mcpMarket.probing') : t('mcpMarket.probe')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => item && onInstall(item)} disabled={installPending}>
                  {installPending ? t('mcpMarket.installing') : t('mcpMarket.install')}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
