import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  ExternalLink,
  Package,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Search as SearchIcon,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react'
import {
  addMcpServer,
  getMcpCatalog,
  listMcpServers,
  probeAllMcpTools,
  probeMcpServer,
  removeMcpServer,
  updateMcpServer,
  type McpCatalogItem,
  type McpServerConfig,
  type McpServerStatus,
} from '@/api/gateClient'
import { SkeletonList } from '@/shared/components/skeleton-loader'
import { EmptyState } from '@/shared/components/empty-state'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Textarea } from '@/shared/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { cn } from '@/shared/lib/utils'
import { APP_SHELL_PAGE_CLASS_NAME } from '@/app/page-shell-style'

/**
 * MCP 市场：展示 gate-service 预置 MCP 工具目录，并管理已安装的 MCP 服务器。
 * 「全部工具」支持搜索、分类筛选、详情查看、安装前填写环境变量与一键启用；
 * 「已安装」支持健康探测、启用/停用、测试连接、编辑配置与删除。
 */
export function McpMarketPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState('catalog')
  const [filter, setFilter] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selected, setSelected] = useState<McpCatalogItem | null>(null)

  const { data: catalog, isLoading, isError } = useQuery({
    queryKey: ['mcp-catalog'],
    queryFn: getMcpCatalog,
    staleTime: 5 * 60 * 1000,
  })

  // 已注册进网关的服务器（卡片角标 / 已安装页签）
  const { data: installedServers, isLoading: installedLoading } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: listMcpServers,
    retry: false,
  })

  const installedNames = useMemo(
    () => new Set((installedServers ?? []).map((s) => s.name)),
    [installedServers],
  )

  const installMutation = useMutation({
    mutationFn: ({ item, envValues }: { item: McpCatalogItem; envValues: Record<string, string> }) =>
      addMcpServer({
        name: item.name,
        transport: item.transport,
        command: item.command,
        args: item.args,
        env: { ...(item.env ?? {}), ...envValues },
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

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="catalog">{t('mcpMarket.tabCatalog')}</TabsTrigger>
          <TabsTrigger value="installed">
            {t('mcpMarket.tabInstalled', { count: installedServers?.length ?? 0 })}
          </TabsTrigger>
        </TabsList>

        {/* 全部工具 */}
        <TabsContent value="catalog" className="space-y-4">
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
        </TabsContent>

        {/* 已安装管理 */}
        <TabsContent value="installed">
          <InstalledMcpSection servers={installedServers} isLoading={installedLoading} />
        </TabsContent>
      </Tabs>

      {/* 详情弹窗 */}
      <McpToolDetailDialog
        item={selected}
        installed={selected ? installedNames.has(selected.name) : false}
        installPending={installMutation.isPending}
        installError={installMutation.error instanceof Error ? installMutation.error.message : null}
        onInstall={(item, envValues) => installMutation.mutate({ item, envValues })}
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

/** 详情弹窗外壳：按 item.id 重挂载内容，保证每次打开都是全新表单状态 */
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
  onInstall: (item: McpCatalogItem, envValues: Record<string, string>) => void
  onClose: () => void
}) {
  return (
    <Dialog open={!!item} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        {item ? (
          <McpToolDetailBody
            key={item.id}
            item={item}
            installed={installed}
            installPending={installPending}
            installError={installError}
            onInstall={onInstall}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** 详情弹窗内容：完整信息 + 安装前环境变量填写 + 启用到网关 + 测试连接 */
function McpToolDetailBody({
  item,
  installed,
  installPending,
  installError,
  onInstall,
  onClose,
}: {
  item: McpCatalogItem
  installed: boolean
  installPending: boolean
  installError: string | null
  onInstall: (item: McpCatalogItem, envValues: Record<string, string>) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  // 已启用服务器的 id（匹配 name；安装成功后 mcp-servers 查询失效自动刷新）
  const { data: servers } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: listMcpServers,
    retry: false,
  })
  const matchedId = servers?.find((s) => s.name === item.name)?.id ?? null

  // 安装前环境变量：requires_env 与预置 env 键的并集，预置值作为初始值
  const envKeys = useMemo(
    () => [...new Set([...(item.requires_env ?? []), ...Object.keys(item.env ?? {})])],
    [item],
  )
  const [envValues, setEnvValues] = useState<Record<string, string>>(() => ({ ...(item.env ?? {}) }))
  const allEnvFilled = envKeys.every((k) => (envValues[k] ?? '').trim().length > 0)

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

  return (
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
        {/* 预置环境变量键名（未安装时由下方表单填写，这里仅在已安装后展示） */}
        {installed && item.env && Object.keys(item.env).length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <span className="text-[11px] text-muted-foreground">{t('mcpMarket.envPreset')}:</span>
            {Object.keys(item.env).map((k) => (
              <span key={k} className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px]">{k}</span>
            ))}
          </div>
        ) : null}
      </div>

      {/* 未安装：环境变量填写表单（对齐 Cline 引导式安装：必填值在启用前完成填写） */}
      {!installed && envKeys.length > 0 ? (
        <div className="space-y-2.5 rounded-lg border border-amber-500/30 bg-amber-50/50 p-3 dark:bg-amber-950/20">
          <div className="space-y-0.5">
            <p className="text-xs font-semibold">{t('mcpMarket.envFormTitle')}</p>
            <p className="text-[11px] text-muted-foreground">{t('mcpMarket.envFormHint')}</p>
          </div>
          <div className="space-y-2.5">
            {envKeys.map((key) => (
              <EnvFieldRow
                key={key}
                envKey={key}
                value={envValues[key] ?? ''}
                onChange={(value) => setEnvValues((prev) => ({ ...prev, [key]: value }))}
              />
            ))}
          </div>
          {item.requires_arg ? (
            <p className="text-[11px] text-muted-foreground">
              {t('mcpMarket.requiresArg', { arg: item.requires_arg })}
            </p>
          ) : null}
        </div>
      ) : (
        /* 已安装或无需环境变量：仅展示要求清单 */
        (item.requires_env?.length || item.requires_arg) ? (
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
        ) : null
      )}

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
          <Button variant="outline" size="sm" onClick={() => void handleProbe()} disabled={probing}>
            <PlugZap className={cn('mr-1 h-3.5 w-3.5', probing && 'animate-pulse')} />
            {probing ? t('mcpMarket.probing') : t('mcpMarket.probe')}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => onInstall(item, envValues)}
            disabled={installPending || !allEnvFilled}
            title={allEnvFilled ? undefined : t('mcpMarket.envBlockedHint')}
          >
            {installPending ? t('mcpMarket.installing') : t('mcpMarket.install')}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

/** 单个环境变量输入行：疑似密钥的键掩码显示，可切换明文 */
function EnvFieldRow({
  envKey,
  value,
  onChange,
}: {
  envKey: string
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const isSecret = /key|token|secret|password|credential/i.test(envKey)
  return (
    <div className="space-y-1">
      <Label htmlFor={`mcp-env-${envKey}`} className="font-mono text-[11px] text-foreground/80">{envKey}</Label>
      <div className="relative">
        <Input
          id={`mcp-env-${envKey}`}
          type={isSecret && !visible ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          className="pr-14 font-mono text-xs"
          placeholder={t('mcpMarket.envValuePlaceholder')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {isSecret ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? t('mcpMarket.envHide') : t('mcpMarket.envShow')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** 已安装管理：健康探测、启用/停用、测试连接、编辑、删除 */
function InstalledMcpSection({
  servers,
  isLoading,
}: {
  servers: McpServerConfig[] | undefined
  isLoading: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<McpServerConfig | null>(null)
  const [deleting, setDeleting] = useState<McpServerConfig | null>(null)

  // 本组件仅在「已安装」页签挂载，进入即探测全部服务器状态
  const statusQuery = useQuery({
    queryKey: ['mcp-server-status'],
    queryFn: probeAllMcpTools,
    staleTime: 30 * 1000,
  })
  const statusMap = useMemo(
    () => new Map((statusQuery.data ?? []).map((s) => [s.serverId, s])),
    [statusQuery.data],
  )

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateMcpServer(id, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })
      void queryClient.invalidateQueries({ queryKey: ['mcp-server-status'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => removeMcpServer(id),
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })
      void queryClient.invalidateQueries({ queryKey: ['mcp-server-status'] })
    },
  })

  if (isLoading) return <SkeletonList count={3} />
  if (!servers || servers.length === 0) {
    return (
      <EmptyState
        title={t('mcpMarket.installedEmpty')}
        description={t('mcpMarket.installedEmptyHint')}
      />
    )
  }

  return (
    <div className="space-y-3">
      {/* 工具栏 */}
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground">
          {t('mcpMarket.installedCount', { count: servers.length })}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void statusQuery.refetch()}
          disabled={statusQuery.isFetching}
        >
          <RefreshCw className={cn('mr-1 h-3.5 w-3.5', statusQuery.isFetching && 'animate-spin')} />
          {statusQuery.isFetching ? t('mcpMarket.probing') : t('mcpMarket.probeAll')}
        </Button>
      </div>

      <div className="space-y-3">
        {servers.map((server) => (
          <InstalledMcpRow
            key={server.id}
            server={server}
            status={statusMap.get(server.id)}
            statusLoading={statusQuery.isFetching}
            togglePending={toggleMutation.isPending && toggleMutation.variables?.id === server.id}
            onToggle={(enabled) => toggleMutation.mutate({ id: server.id, enabled })}
            onEdit={() => setEditing(server)}
            onDelete={() => setDeleting(server)}
          />
        ))}
      </div>

      {/* 编辑弹窗 */}
      {editing ? (
        <McpServerEditDialog server={editing} onClose={() => setEditing(null)} />
      ) : null}

      {/* 删除确认 */}
      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('mcpMarket.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('mcpMarket.deleteConfirm', { name: deleting?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.error instanceof Error ? (
            <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{deleteMutation.error.message}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleting(null)}>
              {t('mcpMarket.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
            >
              {deleteMutation.isPending ? t('mcpMarket.deleting') : t('mcpMarket.deleteAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 已安装服务器行：状态 chip + 启停开关 + 测试连接 / 编辑 / 删除 */
function InstalledMcpRow({
  server,
  status,
  statusLoading,
  togglePending,
  onToggle,
  onEdit,
  onDelete,
}: {
  server: McpServerConfig
  status?: McpServerStatus
  statusLoading: boolean
  togglePending: boolean
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [probeResult, setProbeResult] = useState<McpServerStatus | null>(null)
  const probeMutation = useMutation({
    mutationFn: () => probeMcpServer(server.id),
    onSuccess: (result) => setProbeResult(result),
  })

  const shownStatus = probeMutation.isPending ? undefined : (probeResult ?? status)
  const errorText = probeMutation.isError && probeMutation.error instanceof Error
    ? probeMutation.error.message
    : (probeResult ?? status)?.status !== 'online'
      ? (probeResult ?? status)?.error
      : undefined

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <McpStatusChip
          status={shownStatus}
          loading={probeMutation.isPending || (!shownStatus && statusLoading)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">{server.name}</p>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{server.transport}</span>
          </div>
          {errorText ? (
            <p className="mt-1 line-clamp-2 break-all text-[11px] text-destructive">{errorText}</p>
          ) : null}
          {shownStatus?.status === 'online' && (shownStatus.tools ?? []).length > 0 ? (
            <p className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
              {(shownStatus.tools ?? []).map((tool) => tool.name).join('、')}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {/* 启用 / 停用开关 */}
        <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            role="switch"
            aria-checked={server.enabled}
            aria-label={t('mcpMarket.toggleEnabled')}
            disabled={togglePending}
            onClick={() => onToggle(!server.enabled)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
              server.enabled ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
          >
            <span
              className={cn(
                'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
                server.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
              )}
            />
          </button>
          {server.enabled ? t('mcpMarket.enabledBadge') : t('mcpMarket.disabledBadge')}
        </label>

        <Button
          variant="outline"
          size="sm"
          onClick={() => probeMutation.mutate()}
          disabled={probeMutation.isPending}
        >
          <PlugZap className={cn('mr-1 h-3.5 w-3.5', probeMutation.isPending && 'animate-pulse')} />
          {probeMutation.isPending ? t('mcpMarket.probing') : t('mcpMarket.probe')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="mr-1 h-3.5 w-3.5" />
          {t('mcpMarket.editAction')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          {t('mcpMarket.deleteAction')}
        </Button>
      </div>
    </div>
  )
}

/** 探测状态徽标：在线（含工具数）/ 离线 / 未检测 / 检测中 */
function McpStatusChip({ status, loading }: { status?: McpServerStatus; loading: boolean }) {
  const { t } = useTranslation()
  if (loading && !status) {
    return (
      <span className="flex shrink-0 animate-pulse items-center rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
        {t('mcpMarket.statusChecking')}
      </span>
    )
  }
  if (!status) {
    return (
      <span className="flex shrink-0 items-center rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
        {t('mcpMarket.statusUnknown')}
      </span>
    )
  }
  if (status.status === 'online') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        {t('mcpMarket.statusOnline', { count: (status.tools ?? []).length })}
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive">
      <XCircle className="h-3 w-3" />
      {t('mcpMarket.statusOffline')}
    </span>
  )
}

/** 编辑弹窗：传输类型 / 命令 / 参数 / URL / 环境变量与请求头键值对 */
function McpServerEditDialog({ server, onClose }: { server: McpServerConfig; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [transport, setTransport] = useState<McpServerConfig['transport']>(server.transport)
  const [command, setCommand] = useState(server.command ?? '')
  const [argsText, setArgsText] = useState((server.args ?? []).join('\n'))
  const [url, setUrl] = useState(server.url ?? '')
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>(
    () => Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value })),
  )
  const [headerPairs, setHeaderPairs] = useState<Array<{ key: string; value: string }>>(
    () => Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value })),
  )

  const saveMutation = useMutation({
    mutationFn: () =>
      updateMcpServer(server.id, {
        transport,
        command,
        args: argsText.split('\n').map((s) => s.trim()).filter(Boolean),
        url,
        env: Object.fromEntries(envPairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value])),
        headers: Object.fromEntries(headerPairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value])),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })
      void queryClient.invalidateQueries({ queryKey: ['mcp-server-status'] })
      onClose()
    },
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('mcpMarket.editTitle')}</DialogTitle>
          <DialogDescription className="font-mono text-[11px]">{server.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 传输类型 */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-edit-transport" className="text-xs">{t('mcpMarket.editTransport')}</Label>
            <select
              id="mcp-edit-transport"
              className="h-[var(--control-height)] w-full rounded-md border border-border/60 bg-background/40 px-3 text-sm outline-none transition-colors hover:border-border focus-visible:border-ring"
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpServerConfig['transport'])}
            >
              <option value="stdio">stdio</option>
              <option value="sse">SSE</option>
              <option value="streamable-http">Streamable HTTP</option>
            </select>
          </div>

          {transport === 'stdio' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-edit-command" className="text-xs">{t('mcpMarket.command')}</Label>
                <Input
                  id="mcp-edit-command"
                  className="font-mono text-xs"
                  spellCheck={false}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-edit-args" className="text-xs">{t('mcpMarket.editArgs')}</Label>
                <Textarea
                  id="mcp-edit-args"
                  rows={3}
                  className="font-mono text-xs"
                  spellCheck={false}
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="mcp-edit-url" className="text-xs">{t('mcpMarket.url')}</Label>
              <Input
                id="mcp-edit-url"
                className="font-mono text-xs"
                spellCheck={false}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          )}

          {/* 环境变量 / 请求头键值对 */}
          <KeyValuePairsEditor
            title={t('mcpMarket.editEnv')}
            addLabel={t('mcpMarket.addPair')}
            pairs={envPairs}
            onChange={setEnvPairs}
          />
          {transport !== 'stdio' ? (
            <KeyValuePairsEditor
              title={t('mcpMarket.editHeaders')}
              addLabel={t('mcpMarket.addPair')}
              pairs={headerPairs}
              onChange={setHeaderPairs}
            />
          ) : null}
        </div>

        {saveMutation.error instanceof Error ? (
          <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{saveMutation.error.message}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('mcpMarket.cancel')}
          </Button>
          <Button size="sm" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? t('mcpMarket.saving') : t('mcpMarket.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 键值对编辑器：用于环境变量与请求头 */
function KeyValuePairsEditor({
  title,
  addLabel,
  pairs,
  onChange,
}: {
  title: string
  addLabel: string
  pairs: Array<{ key: string; value: string }>
  onChange: (pairs: Array<{ key: string; value: string }>) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{title}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => onChange([...pairs, { key: '', value: '' }])}
        >
          <Plus className="mr-1 h-3 w-3" />
          {addLabel}
        </Button>
      </div>
      {pairs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('mcpMarket.noPairs')}</p>
      ) : (
        <div className="space-y-2">
          {pairs.map((pair, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                aria-label={t('mcpMarket.pairKey')}
                className="w-2/5 font-mono text-xs"
                placeholder="KEY"
                spellCheck={false}
                value={pair.key}
                onChange={(e) => onChange(pairs.map((p, i) => (i === idx ? { ...p, key: e.target.value } : p)))}
              />
              <Input
                aria-label={t('mcpMarket.pairValue')}
                className="flex-1 font-mono text-xs"
                placeholder="VALUE"
                spellCheck={false}
                value={pair.value}
                onChange={(e) => onChange(pairs.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)))}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t('mcpMarket.removePair')}
                onClick={() => onChange(pairs.filter((_, i) => i !== idx))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
