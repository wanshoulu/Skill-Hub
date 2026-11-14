// gateClient.ts — gate-service（技能构建网关）同源客户端
// REST: /gate-api/v1/...；统一对话 SSE: /gate-api/v1/agent/chat；技能库: /build-api/...
// 鉴权：GATE_TOKEN 由用户在「技能构建」页配置，存 localStorage（网关不注入）

const GATE_BASE = '/gate-api/v1'
const BUILD_BASE = '/build-api'
const TOKEN_KEY = 'gateToken'

export interface GateDraftFile {
  path: string
  content: string
}

export interface GateDraftView {
  id: string
  name: string
  created_at: number
  updated_at: number
  has_dataset: boolean
  dataset: boolean
  files: Array<{ path: string; size: number }>
  mcp_bindings?: DraftMcpBinding[]
}

export interface GateDraftDetail extends GateDraftView {
  markdown: string
}

export interface GateStageCase {
  id: string
  kind?: string
  input?: string
  expect?: boolean
  actual?: boolean
  pass?: boolean
  error?: string
  judge?: { semantic?: number; tools?: number; quality?: number; total?: number; reason?: string } | null
  rules?: Record<string, unknown>
}

export interface GateStage {
  stage_id: string
  title: string
  kind: string
  status: 'pass' | 'fail' | 'degraded' | string
  threshold?: number
  metrics?: { total?: number; passed?: number; accuracy?: number }
  cases?: GateStageCase[]
  error?: string | null
}

export interface GateRun {
  id: string
  kind: 'gate' | 'eval'
  status: 'running' | 'passed' | 'failed' | string
  level: string
  name: string
  draft_id?: string
  ns?: string | null
  content_digest?: string
  dataset_scope?: string
  error?: string | null
  evidence?: { digest: string; signed_at: string } | null
  stages?: GateStage[]
  started_at?: string
  finished_at?: string
}

export interface EvolveCompare {
  fixed?: string[]
  regressed?: string[]
  still_failing?: string[]
}

export interface EvolveJob {
  id: string
  kind: 'evolve'
  status: 'running' | 'done' | 'failed' | string
  draft_id?: string
  conclusion?: 'adoptable' | 'rejected' | string
  message?: string
  error?: string
  progress?: { phase?: string; detail?: string }
  rounds?: Array<{
    diagnosis?: string[]
    summary?: string
    name_preserved?: boolean
    failures?: Array<{ id: string; reason?: string }>
    compare?: EvolveCompare
    candidate_md?: string
    base?: GateStage[]
    candidate?: GateStage[]
  }>
  created_at?: number
  adopted_at?: string | null
}

export interface LibrarySkill {
  name: string
  description?: string
  path?: string
  origin?: string
  version?: string
}

export function getGateToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setGateToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // localStorage 不可用时静默（隐私模式）
  }
}

function authHeaders(extra?: Record<string, string>): HeadersInit {
  const token = getGateToken()
  return {
    ...(extra || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function unwrap(res: Response): Promise<unknown> {
  if (res.status === 401) throw new Error('网关鉴权失败（401）：请在页面右上角检查 GATE_TOKEN')
  if (res.status === 413) throw new Error('上传内容超过 50MB 上限')
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    if (!res.ok) throw new Error(`网关 HTTP ${res.status}: ${text.slice(0, 300)}`)
    return body
  }
  if (body && typeof body === 'object' && 'code' in body) {
    const envelope = body as { code: number; msg?: string; data: unknown }
    if (envelope.code !== 0) throw new Error(envelope.msg || `网关错误 ${envelope.code}`)
    return envelope.data
  }
  if (!res.ok) throw new Error(`网关 HTTP ${res.status}`)
  return body
}

async function gateGet<T>(path: string): Promise<T> {
  return unwrap(await fetch(`${GATE_BASE}${path}`, { headers: authHeaders() })) as T
}

async function gateJson<T>(path: string, method: string, payload: unknown): Promise<T> {
  return unwrap(
    await fetch(`${GATE_BASE}${path}`, {
      method,
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload ?? {}),
    }),
  ) as T
}

// ── 草稿 ─────────────────────────────────────────────────────────

export async function listDrafts(): Promise<GateDraftView[]> {
  return gateGet<GateDraftView[]>('/drafts')
}

export async function getDraft(id: string): Promise<GateDraftDetail> {
  return gateGet<GateDraftDetail>(`/drafts/${encodeURIComponent(id)}`)
}

export async function saveDraft(payload: {
  name: string
  markdown: string
  files?: GateDraftFile[]
  dataset?: string | null
  mcp_bindings?: DraftMcpBinding[]
}): Promise<GateDraftView> {
  return gateJson<GateDraftView>('/drafts', 'POST', payload)
}

export async function updateDraft(id: string, payload: {
  name: string
  markdown: string
  files?: GateDraftFile[]
  dataset?: string | null
  mcp_bindings?: DraftMcpBinding[]
}): Promise<GateDraftView> {
  return gateJson<GateDraftView>(`/drafts/${encodeURIComponent(id)}`, 'PUT', payload)
}

export async function getDraftZip(id: string): Promise<Blob> {
  const res = await fetch(`${GATE_BASE}/drafts/${encodeURIComponent(id)}/zip`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`zip 下载失败（HTTP ${res.status}）`)
  return res.blob()
}

// ── 检查 / 测评 ──────────────────────────────────────────────────

export async function startGateRun(draftId: string, level: 'check' | 'release'): Promise<{ run_id: string }> {
  return gateJson<{ run_id: string }>('/gate/run', 'POST', { draft_id: draftId, level })
}

export async function startEvalRun(draftId: string): Promise<{ run_id: string }> {
  return gateJson<{ run_id: string }>('/eval/run', 'POST', { draft_id: draftId })
}

export async function getRun(kind: 'gate' | 'eval', id: string): Promise<GateRun> {
  return gateGet<GateRun>(`/${kind}/runs/${encodeURIComponent(id)}`)
}

export async function listRuns(kind: 'gate' | 'eval'): Promise<GateRun[]> {
  return gateGet<GateRun[]>(`/${kind}/runs`)
}

// ── 进化 ─────────────────────────────────────────────────────────

export async function startEvolve(draftId: string, maxRounds = 3): Promise<{ job_id: string }> {
  return gateJson<{ job_id: string }>('/evolve/run', 'POST', { draft_id: draftId, max_rounds: maxRounds })
}

export async function getEvolveJob(id: string): Promise<EvolveJob> {
  return gateGet<EvolveJob>(`/evolve/jobs/${encodeURIComponent(id)}`)
}

export async function listEvolveJobs(): Promise<EvolveJob[]> {
  return gateGet<EvolveJob[]>('/evolve/jobs')
}

export async function adoptEvolveJob(id: string): Promise<{ job_id: string; backup: string; gate_run_id: string; gate_status: string }> {
  return gateJson(`/evolve/jobs/${encodeURIComponent(id)}/adopt`, 'POST', {})
}

// ── 证据 ─────────────────────────────────────────────────────────

export interface EvidenceView {
  name: string
  ns: string
  digest: string
  released: boolean
  run_id?: string
  signed_at?: string
  levels?: Record<string, unknown>
}

export async function getEvidence(ns: string, name: string, digest: string): Promise<EvidenceView> {
  return gateGet<EvidenceView>(`/evidence/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/${encodeURIComponent(digest)}`)
}

// ── MCP 服务器与工具 ─────────────────────────────────────────────

export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  created_at: number
  updated_at: number
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpServerStatus {
  serverId: string
  status: 'online' | 'offline' | 'error'
  tools: McpToolInfo[]
  error?: string
  probed_at: number
}

export interface DraftMcpBinding {
  server_id: string
  server_name: string
  tool_names: string[] // 空数组 = 该服务器全部工具
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  return gateGet<McpServerConfig[]>('/mcp/servers')
}

export async function addMcpServer(payload: Omit<McpServerConfig, 'id' | 'created_at' | 'updated_at'>): Promise<McpServerConfig> {
  return gateJson<McpServerConfig>('/mcp/servers', 'POST', payload)
}

export async function updateMcpServer(id: string, payload: Partial<McpServerConfig>): Promise<McpServerConfig> {
  return gateJson<McpServerConfig>(`/mcp/servers/${encodeURIComponent(id)}`, 'PUT', payload)
}

export async function removeMcpServer(id: string): Promise<{ deleted: string }> {
  const res = await fetch(`${GATE_BASE}/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return unwrap(res) as Promise<{ deleted: string }>
}

export async function probeAllMcpTools(): Promise<McpServerStatus[]> {
  return gateGet<McpServerStatus[]>('/mcp/tools')
}

export async function probeMcpServer(id: string): Promise<McpServerStatus> {
  return gateGet<McpServerStatus>(`/mcp/servers/${encodeURIComponent(id)}/tools`)
}

// ── 技能库（skill-build-agent，G2 链路）──────────────────────────

export async function listLibrarySkills(): Promise<LibrarySkill[]> {
  const res = await fetch(`${BUILD_BASE}/api/skill-build-agent/skills`, { headers: authHeaders() })
  const data = await unwrap(res)
  if (!Array.isArray(data)) return []
  return data as LibrarySkill[]
}

// ── 统一对话 SSE ─────────────────────────────────────────────────

export type AgentCardType =
  | 'draft_extracted'
  | 'hint'
  | 'gate_stages'
  | 'eval_report'
  | 'evolve_report'
  | 'adopt_done'

export interface AgentCard {
  type: AgentCardType
  payload: Record<string, unknown>
}

export interface AgentPhaseEvent {
  name: string
  status: 'running' | 'done' | string
  detail?: string
}

export interface AgentToolEvent {
  tool: string
  skill?: string
  script?: string
  status?: string
}

export interface AgentChatHandlers {
  onPhase?: (phase: AgentPhaseEvent) => void
  onToken?: (text: string) => void
  onSkillLoad?: (skill: string) => void
  onTool?: (e: AgentToolEvent) => void
  onCard?: (card: AgentCard) => void
  onResult?: (answer: string) => void
  onError?: (message: string) => void
}

export interface AgentChatRequest {
  message: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  draftId?: string | null
  mode?: string | null
  signal?: AbortSignal
  handlers: AgentChatHandlers
}

const CHUNK_STALL_MS = 120_000

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = 'message'
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim()
  }
  if (!data) return null
  try {
    return { event, data: JSON.parse(data) }
  } catch {
    return null
  }
}

/**
 * 统一对话流。事件：phase（任务进度）/ token（创建打字机）/ card（结构化卡片）/
 * result（结论）/ error / hb（心跳，重置断流计时）/ done（服务端收尾）。
 * 断流保护：两 chunk 间隔超过 120s 视为连接中断，抛错但保留已收内容。
 */
export async function streamAgentChat(req: AgentChatRequest): Promise<void> {
  const res = await fetch(`${GATE_BASE}/agent/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: req.message,
      history: req.history.slice(-20),
      draft_id: req.draftId || null,
      ...(req.mode ? { mode: req.mode } : {}),
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
                  if (ev.data && typeof ev.data === 'object') h.onPhase?.(ev.data as AgentPhaseEvent)
                  break
                case 'token':
                  h.onToken?.(String((ev.data as { text?: string })?.text ?? ''))
                  break
                case 'skill_load':
                  h.onSkillLoad?.(String((ev.data as { skill?: string })?.skill ?? ''))
                  break
                case 'tool':
                  if (ev.data && typeof ev.data === 'object') h.onTool?.(ev.data as AgentToolEvent)
                  break
                case 'card':
                  h.onCard?.(ev.data as AgentCard)
                  break
                case 'result':
                  h.onResult?.(String((ev.data as { answer?: string })?.answer ?? ''))
                  break
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
