// appClient.ts — skill-app-agent（技能应用试运行）同源客户端
// REST: /app-api/v1/...；对话 SSE: /app-api/v1/chat
// 鉴权：复用「技能构建」页的 GATE_TOKEN（localStorage gateToken）

import { getGateToken } from './gateClient'

const APP_BASE = '/app-api/v1'

export interface InstalledSkill {
  name: string
  description: string | null
  hasScripts: boolean
  installedAt: number
}

export interface AppAgentProfile {
  agent: {
    id: string
    name: string
    description: string
    model: string
    capabilities: string[]
  }
  skills: InstalledSkill[]
  sessions: number
}

export interface RegistrySkill {
  namespace: string
  slug: string
  latestVersion: string
  summary: string | null
}

function authHeaders(extra?: Record<string, string>): HeadersInit {
  const token = getGateToken()
  return {
    ...(extra || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 401) throw Object.assign(new Error('鉴权失败（401）：请在「技能构建」页右上角检查访问令牌'), { status: 401 })
  if (res.status === 503) throw Object.assign(new Error('技能应用服务不可用（503）：服务端未配置令牌或未启动'), { status: 503 })
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { detail?: string }
      detail = body.detail ? `：${body.detail}` : ''
    } catch {
      // 忽略响应体解析失败
    }
    throw Object.assign(new Error(`请求失败（HTTP ${res.status}）${detail}`), { status: res.status })
  }
  return (await res.json()) as T
}

export async function fetchAgentProfile(): Promise<AppAgentProfile> {
  const res = await fetch(`${APP_BASE}/agent`, { headers: authHeaders() })
  return unwrap<AppAgentProfile>(res)
}

export async function searchRegistrySkills(q: string, limit = 20): Promise<{ items: RegistrySkill[]; total: number }> {
  const res = await fetch(`${APP_BASE}/skills/registry?q=${encodeURIComponent(q)}&limit=${limit}`, {
    headers: authHeaders(),
  })
  return unwrap<{ items: RegistrySkill[]; total: number }>(res)
}

export async function installSkill(
  namespace: string,
  slug: string,
  version?: string,
): Promise<{ installed: { name: string; version: string }; skills: InstalledSkill[] }> {
  const res = await fetch(`${APP_BASE}/skills/install`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ namespace, slug, version: version || undefined }),
  })
  return unwrap(res)
}

export async function uninstallSkill(name: string): Promise<{ uninstalled: string; skills: InstalledSkill[] }> {
  const res = await fetch(`${APP_BASE}/skills/uninstall`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name }),
  })
  return unwrap(res)
}

export async function resetAppSession(sessionId: string): Promise<void> {
  const res = await fetch(`${APP_BASE}/session/reset`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ session_id: sessionId }),
  })
  await unwrap(res)
}

// ── 对话 SSE ──

export interface AppPhaseEvent {
  name: string
  status: string
  detail?: string
}

export interface AppToolEvent {
  tool: string
  skill?: string
  script?: string
  status?: string
}

export interface AppChatHandlers {
  onPhase?: (e: AppPhaseEvent) => void
  onToken?: (text: string) => void
  onSkillLoad?: (skill: string) => void
  onTool?: (e: AppToolEvent) => void
  onResult?: (e: { answer: string; sessionId: string }) => void
  onError?: (msg: string) => void
}

export interface AppChatRequest {
  sessionId?: string
  message: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  signal?: AbortSignal
  handlers: AppChatHandlers
}

const CHUNK_STALL_MS = 120_000

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = 'message'
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return null
  try {
    return { event, data: JSON.parse(data) }
  } catch {
    return null
  }
}

/**
 * 技能应用对话流。事件：phase / token / skill_load（技能内容加载）/
 * tool（技能脚本执行）/ result / error / hb（心跳）/ done。
 * 断流保护：两 chunk 间隔超过 120s 视为连接中断，抛错但保留已收内容。
 */
export async function streamAppChat(req: AppChatRequest): Promise<void> {
  const res = await fetch(`${APP_BASE}/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      session_id: req.sessionId || null,
      message: req.message,
      history: req.history.slice(-20),
    }),
    signal: req.signal,
  })
  if (!res.ok || !res.body) throw new Error(`对话连接失败（HTTP ${res.status}）`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = (reject: (e: Error) => void) => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      reject(new Error('连接中断：120 秒未收到服务端数据（已收内容已保留）'))
    }, CHUNK_STALL_MS)
  }

  try {
    await new Promise<void>((resolve, reject) => {
      armStall(reject)
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            armStall(reject)
            buf += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const ev = parseSseBlock(block)
              if (!ev) continue
              const h = req.handlers
              switch (ev.event) {
                case 'phase':
                  h.onPhase?.(ev.data as AppPhaseEvent)
                  break
                case 'token':
                  h.onToken?.(String((ev.data as { content?: string })?.content ?? ''))
                  break
                case 'skill_load':
                  h.onSkillLoad?.(String((ev.data as { skill?: string })?.skill ?? ''))
                  break
                case 'tool':
                  h.onTool?.(ev.data as AppToolEvent)
                  break
                case 'result': {
                  const d = ev.data as { answer?: string; sessionId?: string }
                  h.onResult?.({ answer: String(d?.answer ?? ''), sessionId: String(d?.sessionId ?? '') })
                  break
                }
                case 'error':
                  h.onError?.(String((ev.data as { error?: string })?.error ?? '未知错误'))
                  break
                case 'hb':
                case 'done':
                  break
                default:
                  break
              }
            }
          }
          resolve()
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
      void pump()
    })
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    try {
      await reader.cancel()
    } catch {
      // 流已关闭
    }
  }
}
