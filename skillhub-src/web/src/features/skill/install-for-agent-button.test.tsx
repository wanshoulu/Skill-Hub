// @vitest-environment jsdom

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstallForAgentButton } from './install-for-agent-button'

const mocks = vi.hoisted(() => ({ installSkill: vi.fn(), success: vi.fn(), error: vi.fn() }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (
      values ? `${key}:${values.version ?? ''}` : key
    ),
  }),
}))
vi.mock('@/api/appClient', () => ({ installSkill: mocks.installSkill }))
vi.mock('@/shared/lib/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }))

describe('install-for-agent-button', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    mocks.installSkill.mockReset()
    mocks.success.mockClear()
    mocks.error.mockClear()
  })

  it('renders an accessible install button', () => {
    const html = renderToStaticMarkup(createElement(InstallForAgentButton, {
      namespace: 'global',
      slug: 'my-skill',
      version: '1.2.3',
    }))

    expect(html).toContain('data-testid="install-for-agent-button"')
    expect(html).toContain('aria-label="skillDetail.installForAgent.button"')
    expect(html).toContain('skillDetail.installForAgent.button')
  })

  it('can be disabled when the selected skill version is not installable', () => {
    const html = renderToStaticMarkup(createElement(InstallForAgentButton, {
      namespace: 'global',
      slug: 'my-skill',
      version: '1.2.3',
      disabled: true,
    }))

    expect(html).toContain('disabled=""')
  })

  it('is disabled for a version that cannot be installed safely', () => {
    const html = renderToStaticMarkup(createElement(InstallForAgentButton, {
      namespace: 'global',
      slug: 'my-skill',
      version: '1.0.0&echo INJECTED',
    }))

    expect(html).toContain('disabled=""')
  })

  it('installs the skill into the platform agent and shows the done state', async () => {
    mocks.installSkill.mockResolvedValue({ installed: { name: 'my-skill', version: '1.2.3' }, skills: [] })

    const { getByTestId, getByLabelText } = render(createElement(InstallForAgentButton, {
      namespace: 'team-alpha',
      slug: 'my-skill',
      version: '2.0.0',
    }))

    await act(async () => fireEvent.click(getByTestId('install-for-agent-button')))

    await waitFor(() => expect(mocks.installSkill).toHaveBeenCalledWith('team-alpha', 'my-skill', '2.0.0'))
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('skillDetail.installForAgent.success:1.2.3'))
    expect(getByLabelText('skillDetail.installForAgent.done').hasAttribute('disabled')).toBe(true)
  })

  it('treats an already-installed response (409) as done', async () => {
    mocks.installSkill.mockRejectedValue(new Error('请求失败（HTTP 409）：技能已安装'))

    const { getByTestId } = render(createElement(InstallForAgentButton, {
      namespace: 'global',
      slug: 'my-skill',
      version: '1.2.3',
    }))

    await act(async () => fireEvent.click(getByTestId('install-for-agent-button')))

    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('skillDetail.installForAgent.conflict'))
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('surfaces install failures and restores the button', async () => {
    mocks.installSkill.mockRejectedValue(new Error('请求失败（HTTP 503）：服务不可用'))

    const { getByTestId } = render(createElement(InstallForAgentButton, {
      namespace: 'global',
      slug: 'my-skill',
      version: '1.2.3',
    }))

    await act(async () => fireEvent.click(getByTestId('install-for-agent-button')))

    await waitFor(() => expect(mocks.error).toHaveBeenCalled())
    expect(getByTestId('install-for-agent-button').hasAttribute('disabled')).toBe(false)
  })
})
