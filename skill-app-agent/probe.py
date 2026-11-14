"""容器内探针：诊断 skill 加载路径与连续对话文件锁问题（诊断用，不入镜像）"""
import asyncio
import glob
import os
import time

os.chdir('/app')

from app.agent_factory import manager  # noqa: E402
from app.rails import current_emitter  # noqa: E402
from app.skill_installer import install, uninstall  # noqa: E402
from openjiuwen.harness.deep_agent import Session  # noqa: E402


def lock_snapshot():
    return {os.path.basename(p): time.strftime('%H:%M:%S', time.localtime(os.path.getmtime(p)))
            for p in glob.glob('/tmp/openjiuwen-fs-rwlocks/*.db')}


async def inspect_rails(agent):
    rails = getattr(agent, 'rails', None) or []
    print('== rails ==')
    for r in rails:
        name = type(r).__name__
        print(' ', name, 'skills_dir=', getattr(r, 'skills_dir', '<n/a>'))
    ws = getattr(agent, 'workspace', None) or getattr(agent, '_workspace', None)
    print('== workspace ==', ws)
    for attr in ('get_node_path',):
        if ws is not None and hasattr(ws, attr):
            try:
                print('  workspace.skills =', ws.get_node_path('skills'))
            except Exception as e:  # noqa: BLE001
                print('  get_node_path err:', e)


async def one_chat(idx, query, timeout_s=100):
    print(f'-- chat#{idx} start {time.strftime("%H:%M:%S")} query={query!r}')
    session = Session(f'probe-{idx}', card=manager.card)
    t0 = time.monotonic()
    answer = ''

    def emit(ev):
        s = str(ev)[:160]
        print(f'   [{idx}] ev {s}')

    token = current_emitter.set(emit)
    stream = None
    try:
        agent = manager.get_agent()
        stream = agent.stream({'query': query}, session=session)
        async def drain():
            nonlocal answer
            async for chunk in stream:
                t = getattr(chunk, 'type', '')
                if t == 'llm_output':
                    if len(answer) < 600:
                        answer += str(getattr(chunk, 'data', ''))[:600 - len(answer)]
                elif t == 'answer':
                    answer = str(getattr(chunk, 'data', ''))
        await asyncio.wait_for(drain(), timeout_s)
        print(f'-- chat#{idx} done {time.strftime("%H:%M:%S")} dur={time.monotonic()-t0:.1f}s')
        print(f'   answer: {answer[:300]}')
    except asyncio.TimeoutError:
        print(f'-- chat#{idx} TIMEOUT after {timeout_s}s (lock hang reproduced)')
    except Exception as e:  # noqa: BLE001
        print(f'-- chat#{idx} ERROR {type(e).__name__}: {e}')
    finally:
        current_emitter.reset(token)
        if stream is not None:
            aclose = getattr(stream, 'aclose', None)
            if aclose:
                try:
                    await asyncio.wait_for(aclose(), 5)
                except Exception:  # noqa: BLE001
                    pass


async def main():
    print('== locks before ==', len(lock_snapshot()))
    agent = manager.get_agent()
    await inspect_rails(agent)
    print('== locks after agent init ==', len(lock_snapshot()))

    await one_chat(1, '用一句话回答：1+1等于几？')
    print('== locks after chat1 ==', len(lock_snapshot()))

    await one_chat(2, '用一句话回答：2+2等于几？')
    print('== locks after chat2 ==', len(lock_snapshot()))

    # 模拟卸载→重建（e2e 中第二轮报错的触发路径）
    try:
        uninstall('stock-lookup')
        print('== uninstalled stock-lookup ==')
    except Exception as e:  # noqa: BLE001
        print('== uninstall err:', e)
    await one_chat(3, '用一句话回答：3+3等于几？')
    print('== locks after chat3(rebuilt agent) ==', len(lock_snapshot()))
    # 恢复安装，保持环境干净
    try:
        r = await install('personal', 'stock-lookup')
        print('== reinstalled ==', r.get('installed', {}).get('name') if isinstance(r, dict) else r)
    except Exception as e:  # noqa: BLE001
        print('== reinstall err:', e)


asyncio.run(main())
print('PROBE DONE')
