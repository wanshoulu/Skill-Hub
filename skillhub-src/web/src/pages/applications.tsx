// applications.tsx — 「技能应用」试运行界面
// 区块：Agent 档案卡（含已安装技能 chips）+ 注册中心搜索安装 + SSE 对话试运行
// 请求全部同源 /app-api（见 appClient.ts）；令牌复用「技能构建」页的 GATE_TOKEN
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import {
  BookOpen, Bot, Cpu, KeyRound, PackageCheck, RefreshCw, Search, Send,
  Sparkles, Trash2, Wrench,
} from 'lucide-react'
import { toast } from '@/shared/lib/toast'
import { MarkdownRenderer } from '@/features/skill/markdown-renderer'
import { getGateToken, setGateToken } from '@/api/gateClient'
import {
  fetchAgentProfile, installSkill, resetAppSession, searchRegistrySkills,
  streamAppChat, uninstallSkill,
  type AppAgentProfile, type AppPhaseEvent, type RegistrySkill,
} from '@/api/appClient'

// ── 会话消息模型 ─────────────────────────────────────────────────

type TimelineItem =
  | { kind: 'skill'; skill: string }
  | { kind: 'tool'; tool: string; skill?: string; script?: string }
  | { kind: 'error'; text: string }

type AppMsg =
  | { id: string; role: 'user'; content: string }
  | {
      id: string
      role: 'assistant'
      content: string
      phases: AppPhaseEvent[]
      events: TimelineItem[]
      streaming?: boolean
    }

function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// 示例指令（已安装技能后可直接体验）
const PROMPT_CHIPS = [
  '查一下贵州茅台今天的股价',
  '你安装了哪些技能？能做什么？',
  '查询股票 600519 今天的行情',
]

export function ApplicationsPage() {
  const { t } = useTranslation()

  // token 配置（复用 gateToken）
  const [token, setToken] = useState(getGateToken)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenOpen, setTokenOpen] = useState(false)

  // agent 档案 + 已安装技能
  const [profile, setProfile] = useState<AppAgentProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileErr, setProfileErr] = useState('')

  // 注册中心
  const [query, setQuery] = useState('')
  const [registry, setRegistry] = useState<RegistrySkill[] | null>(null)
  const [registryErr, setRegistryErr] = useState('')
  const [registryLoading, setRegistryLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<string | null>(null)

  // 对话
  const [messages, setMessages] = useState<AppMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const sessionRef = useRef<string>(newId())
  const messagesRef = useRef<AppMsg[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // 组件卸载时中止进行中的 SSE 流，防止悬空状态更新
  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const loadProfile = useCallback(async () => {
    setProfileLoading(true)
    setProfileErr('')
    try {
      setProfile(await fetchAgentProfile())
    } catch (e) {
      setProfileErr(e instanceof Error ? e.message : String(e))
    } finally {
      setProfileLoading(false)
    }
  }, [])

  // 首次加载；GATE_TOKEN 仅作可选请求头（服务端未配置鉴权时无需令牌）
  useEffect(() => {
    void loadProfile()
  }, [loadProfile])

  const searchRegistry = useCallback(async (q: string) => {
    setRegistryLoading(true)
    setRegistryErr('')
    try {
      const data = await searchRegistrySkills(q, 20)
      setRegistry(data.items)
      if (!data.items.length && !q) setRegistryErr('注册中心暂无公开技能')
    } catch (e) {
      setRegistryErr(e instanceof Error ? e.message : String(e))
      setRegistry(null)
    } finally {
      setRegistryLoading(false)
    }
  }, [])

  // 打开页面即拉取注册中心热门列表
  useEffect(() => {
    void searchRegistry('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleInstall = async (s: RegistrySkill) => {
    setInstalling(`${s.namespace}/${s.slug}`)
    try {
      await installSkill(s.namespace, s.slug)
      toast.success(`已安装技能 ${s.slug}（v${s.latestVersion}）`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setInstalling(null)
      return
    }
    // 刷新失败不掩盖安装成功
    try { await loadProfile() } catch { /* ignore */ }
    try { await searchRegistry(query) } catch { /* ignore */ }
    setInstalling(null)
  }

  const handleUninstall = async (name: string) => {
    if (!window.confirm(`确定卸载技能「${name}」？Agent 将立即失去该技能。`)) return
    setUninstalling(name)
    try {
      await uninstallSkill(name)
      toast.success(`已卸载技能 ${name}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setUninstalling(null)
      return
    }
    try { await loadProfile() } catch { /* ignore */ }
    try { await searchRegistry(query) } catch { /* ignore */ }
    setUninstalling(null)
  }

  const patchAssistant = (id: string, patch: (m: Extract<AppMsg, { role: 'assistant' }>) => void) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id || m.role !== 'assistant') return m
        const next = { ...m, content: m.content, phases: [...m.phases], events: [...m.events] }
        patch(next as Extract<AppMsg, { role: 'assistant' }>)
        return next
      }),
    )
  }

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || sending) return
    const assistantId = newId()
    const history = messagesRef.current
      .filter((m) => m.role === 'user' || m.content)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', content: message },
      { id: assistantId, role: 'assistant', content: '', phases: [], events: [], streaming: true },
    ])
    setInput('')
    setSending(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let errored = false
    try {
      await streamAppChat({
        sessionId: sessionRef.current,
        message,
        history,
        signal: ctrl.signal,
        handlers: {
          onPhase: (ph) =>
            patchAssistant(assistantId, (m) => {
              const idx = m.phases.findIndex((x) => x.name === ph.name)
              if (idx >= 0) m.phases[idx] = ph
              else m.phases.push(ph)
            }),
          onToken: (tok) => patchAssistant(assistantId, (m) => { m.content += tok }),
          onSkillLoad: (skill) =>
            patchAssistant(assistantId, (m) => {
              if (!m.events.some((e) => e.kind === 'skill' && e.skill === skill)) {
                m.events.push({ kind: 'skill', skill })
              }
            }),
          onTool: (ev) =>
            patchAssistant(assistantId, (m) => {
              m.events.push({ kind: 'tool', tool: ev.tool, skill: ev.skill, script: ev.script })
            }),
          onResult: (r) => {
            if (r.sessionId) sessionRef.current = r.sessionId
            patchAssistant(assistantId, (m) => {
              if (r.answer && !m.content) m.content = r.answer
            })
          },
          onError: (msg) => {
            errored = true
            patchAssistant(assistantId, (m) => { m.events.push({ kind: 'error', text: msg }) })
          },
        },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/abort/i.test(msg)) patchAssistant(assistantId, (m) => { m.events.push({ kind: 'error', text: msg }) })
    } finally {
      abortRef.current = null
      setSending(false)
      // 流结束但未收到 result 的兜底：保留已收内容并停止流式指示
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)))
      if (errored) void loadProfile().catch(() => undefined)
    }
  }

  const newSession = async () => {
    if (sending) abortRef.current?.abort()
    try {
      await resetAppSession(sessionRef.current)
    } catch {
      // 会话记录可能不存在，忽略
    }
    sessionRef.current = newId()
    setMessages([])
    toast.success('已开启新会话')
  }

  const installedNames = new Set((profile?.skills ?? []).map((s) => s.name))
  const canChat = !sending

  return (
    <div className="flex h-full min-h-[70vh] flex-col gap-4">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t('nav.applications')}</span>
        {profile && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {profile.agent.model} · 技能 {profile.skills.length} 个
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void newSession()} disabled={sending}>
            <RefreshCw className="mr-1 size-4" /> 新会话
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTokenOpen(true)}>
            <KeyRound className="mr-1 size-4" />
            {token ? (
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                令牌已配置
              </span>
            ) : (
              '配置令牌'
            )}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* 左列：Agent 档案 + 注册中心 */}
        <div className="flex w-full flex-col gap-4 lg:w-[340px] lg:shrink-0">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Bot className="size-4" /> Agent 档案
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {profileLoading && !profile && <p className="text-xs text-muted-foreground">加载中…</p>}
              {profileErr && !profile && (
                <div className="space-y-2">
                  <p className="text-xs text-red-600 dark:text-red-400">{profileErr}</p>
                  <Button variant="outline" size="sm" onClick={() => void loadProfile()}>
                    <RefreshCw className="mr-1 size-3.5" /> 重试
                  </Button>
                </div>
              )}
              {profile && (
                <>
                  <div>
                    <p className="font-medium">{profile.agent.name}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{profile.agent.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {profile.agent.capabilities.map((c) => (
                      <span key={c} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {c}
                      </span>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">已安装技能（注册给 Agent）</p>
                    {profile.skills.length === 0 && (
                      <p className="text-xs text-muted-foreground">暂无安装，从下方注册中心选择技能安装。</p>
                    )}
                    {profile.skills.map((s) => (
                      <div
                        key={s.name}
                        className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                      >
                        <PackageCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{s.name}</p>
                          {s.description && (
                            <p className="truncate text-xs text-muted-foreground">{s.description}</p>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-7 shrink-0 p-0 text-muted-foreground hover:text-red-600"
                          disabled={uninstalling === s.name}
                          onClick={() => void handleUninstall(s.name)}
                          title="卸载技能"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Search className="size-4" /> 注册中心
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-1.5">
                <Input
                  value={query}
                  placeholder="搜索技能（回车确认）"
                  className="h-8 text-xs"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void searchRegistry(query)
                  }}
                />
                <Button variant="outline" size="sm" className="h-8 shrink-0 px-2" disabled={registryLoading} onClick={() => void searchRegistry(query)}>
                  <Search className="size-3.5" />
                </Button>
              </div>
              {registryErr && <p className="text-xs text-red-600 dark:text-red-400">{registryErr}</p>}
              <div className="max-h-64 space-y-1.5 overflow-y-auto">
                {registryLoading && !registry && <p className="text-xs text-muted-foreground">搜索中…</p>}
                {registry?.map((s) => {
                  const installed = installedNames.has(s.slug)
                  return (
                    <div key={`${s.namespace}/${s.slug}`} className="rounded-md border px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">
                            {s.slug}
                            <span className="ml-1 font-normal text-muted-foreground">
                              {s.namespace} · v{s.latestVersion}
                            </span>
                          </p>
                          {s.summary && (
                            <p className="truncate text-xs text-muted-foreground">{s.summary}</p>
                          )}
                        </div>
                        {installed ? (
                          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            已安装
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0 px-2 text-xs"
                            disabled={installing === `${s.namespace}/${s.slug}`}
                            onClick={() => void handleInstall(s)}
                          >
                            {installing === `${s.namespace}/${s.slug}` ? '安装中…' : '安装'}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右列：对话试运行 */}
        <div className="flex min-h-[55vh] min-w-0 flex-1 flex-col rounded-lg border">
          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center text-sm text-muted-foreground">
                <Sparkles className="size-8 opacity-70" />
                <p>向 Agent 发消息，真实试运行已安装的技能。</p>
                <div className="mt-1 flex flex-wrap justify-center gap-1.5">
                  {PROMPT_CHIPS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                      onClick={() => void send(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <p className="text-xs">技能按需加载、脚本真实执行，时间线展示加载与执行全过程。</p>
              </div>
            )}
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="space-y-2">
                  <div className="flex items-start gap-2">
                    <Bot className="mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-2">
                      {m.phases.length > 0 && (
                        <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                          {m.phases.map((ph) => (
                            <span key={ph.name} className="rounded bg-muted px-1.5 py-0.5">
                              {ph.name}
                              {ph.status === 'running' ? '…' : '✓'}
                              {ph.detail ? ` ${ph.detail}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {/* 过程时间线：技能加载 / 脚本执行 / 错误 */}
                      {m.events.map((ev, i) =>
                        ev.kind === 'skill' ? (
                          <div key={i} className="flex items-center gap-1.5 text-xs text-sky-700 dark:text-sky-300">
                            <BookOpen className="size-3.5" /> 加载技能：{ev.skill}
                          </div>
                        ) : ev.kind === 'tool' ? (
                          <div key={i} className="flex items-center gap-1.5 text-xs text-violet-700 dark:text-violet-300">
                            <Wrench className="size-3.5" />
                            执行脚本：{ev.skill}/{ev.script}
                          </div>
                        ) : (
                          <div key={i} className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                            {ev.text}
                          </div>
                        ),
                      )}
                      {m.content && (
                        <div className="text-sm">
                          <MarkdownRenderer content={m.content} />
                        </div>
                      )}
                      {m.streaming && <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />}
                    </div>
                  </div>
                </div>
              ),
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="border-t p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {PROMPT_CHIPS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!canChat}
                  onClick={() => setInput(p)}
                  className="rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                rows={2}
                placeholder={sending ? 'Agent 运行中…' : '向 Agent 发送消息（Enter 发送，Shift+Enter 换行）'}
                className="min-h-0 resize-none"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send(input)
                  }
                }}
              />
              <Button size="icon" disabled={!canChat || !input.trim()} onClick={() => void send(input)}>
                <Send className="size-4" />
              </Button>
            </div>
            <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Cpu className="size-3" /> 试运行为真实执行：技能脚本将联网运行，输出直接来自脚本结果。
            </p>
          </div>
        </div>
      </div>

      {/* 令牌配置（复用 gateToken） */}
      <Dialog open={tokenOpen} onOpenChange={setTokenOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>配置网关令牌（GATE_TOKEN）</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              技能应用与技能构建共用同一网关令牌（GATE_TOKEN）。服务端未启用鉴权时可留空。
            </p>
            <Input
              type="password"
              value={tokenDraft}
              placeholder="粘贴 GATE_TOKEN"
              onChange={(e) => setTokenDraft(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setTokenOpen(false)}>取消</Button>
              <Button
                size="sm"
                onClick={() => {
                  const v = tokenDraft.trim()
                  setGateToken(v)
                  setToken(v)
                  setTokenDraft('')
                  setTokenOpen(false)
                  toast.success(v ? '令牌已保存' : '令牌已清除')
                }}
              >
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
