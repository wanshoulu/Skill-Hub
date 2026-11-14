#!/usr/bin/env node
import { Command, Option } from 'commander';
import { init } from '../src/init.js';
import { validateCmd } from '../src/skill.js';
import { packCmd } from '../src/pack.js';
import { publishCmd, whoamiCmd } from '../src/publish.js';
import { evalCmd } from '../src/eval.js';

const program = new Command();
program
  .name('skw')
  .description('个人 skill 工作台：init / validate / eval / pack / publish')
  .version('0.1.0');

program
  .command('init <name>')
  .description('创建 skill 脚手架目录')
  .option('-d, --dir <path>', '在哪个目录下创建', '.')
  .option('-s, --desc <text>', 'skill 描述（SKILL.md frontmatter 的 description）')
  .action((name, opts) => {
    try {
      const target = init(name, opts);
      console.log(`✓ 已创建 ${target}`);
      console.log(`  下一步：skw validate "${target}"`);
      console.log(`         skw eval "${target}"（离线 mock 可跑）`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('validate [dir]')
  .description('校验 SKILL.md（agentskills 规范）')
  .action((dir) => {
    try {
      validateCmd(dir || '.');
    } catch (e) {
      fail(e);
    }
  });

program
  .command('eval [dir]')
  .description('跑 evals/cases.yaml 评测用例')
  .option('-p, --provider <name>', '评测后端：mock | openai', 'mock')
  .action((dir, opts) => evalCmd(dir || '.', opts).catch(fail));

program
  .command('pack [dir]')
  .description('校验并打包为 dist/<name>.zip')
  .action((dir) => {
    try {
      packCmd(dir || '.');
    } catch (e) {
      fail(e);
    }
  });

program
  .command('publish [dir]')
  .description('打包并上传到注册中心 POST /api/cli/v1/skills/{namespace}/publish')
  .option('--registry <url>', '注册中心地址')
  .option('--token <token>', 'API token')
  .option('--namespace <ns>', '目标命名空间')
  .addOption(
    new Option('--visibility <v>', '可见性：private | public').choices(['private', 'public'])
  )
  .action((dir, opts) => publishCmd(dir || '.', opts).catch(fail));

program
  .command('whoami')
  .description('验证注册中心 token 配置')
  .option('--registry <url>', '注册中心地址')
  .option('--token <token>', 'API token')
  .action((opts) => whoamiCmd(opts).catch(fail));

function fail(e) {
  console.error(`✗ ${e.message}`);
  // Node fetch 的网络错误只给 "fetch failed"，真实原因（DNS/拒绝连接等）在 cause 里
  if (e.cause) console.error(`  原因：${e.cause}`);
  process.exitCode = 1;
}

program.parseAsync();
