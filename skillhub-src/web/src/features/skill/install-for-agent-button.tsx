import { Bot, Check, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchAgentProfile, installSkill } from '@/api/appClient'
import { getGateToken } from '@/api/gateClient'
import { toast } from '@/shared/lib/toast'
import { isPortableSkillVersion } from './install-command'

interface InstallForAgentButtonProps {
  analyticsId?: string
  namespace: string
  slug: string
  version: string
  disabled?: boolean
}

// 一键把技能真实安装到平台内置的技能应用 Agent（skill-app-agent），
// 与「技能应用」页的注册中心安装共用同一服务端 API。
export function InstallForAgentButton({ namespace, slug, version, disabled = false, analyticsId }: InstallForAgentButtonProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'installing' | 'done'>('idle')

  // 已配置令牌时预查 Agent 已安装技能，命中则直接呈现已安装态（失败静默回落 idle）
  useEffect(() => {
    if (!getGateToken() || !isPortableSkillVersion(version)) return
    let alive = true
    fetchAgentProfile()
      .then((p) => {
        if (alive && p.skills.some((s) => s.name === slug)) setState('done')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [namespace, slug, version])

  const handleInstall = async () => {
    if (state !== 'idle') return
    setState('installing')
    try {
      const { installed } = await installSkill(namespace, slug, version)
      setState('done')
      toast.success(t('skillDetail.installForAgent.success', { version: installed?.version || version }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('409')) {
        setState('done')
        toast.success(t('skillDetail.installForAgent.conflict'))
      } else {
        setState('idle')
        toast.error(`${t('skillDetail.installForAgent.failed')}${message ? `：${message}` : ''}`)
      }
    }
  }

  const label = state === 'installing'
    ? t('skillDetail.installForAgent.installing')
    : state === 'done'
      ? t('skillDetail.installForAgent.done')
      : t('skillDetail.installForAgent.button')
  const busy = state === 'installing'

  return (
    <button
      data-analytics-id={analyticsId}
      type="button"
      data-testid="install-for-agent-button"
      onClick={handleInstall}
      disabled={disabled || busy || state === 'done' || !isPortableSkillVersion(version)}
      aria-label={label}
      className="relative w-full overflow-hidden rounded-xl border border-border/60 bg-muted/50 px-4 py-3 transition-colors hover:bg-muted/70 active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="flex items-center justify-center gap-2">
        {state === 'done' ? <Check className="h-4 w-4" /> : busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
        <span className="text-[13px] leading-relaxed text-foreground sm:text-sm">{label}</span>
      </div>
    </button>
  )
}
