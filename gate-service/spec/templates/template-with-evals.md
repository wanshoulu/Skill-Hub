<!--
模板：带评测版（技能附带测评数据集，release 级门禁必需）
用法：SKILL.md 与 evals/dataset.yaml 一并放入包内；将 <> 占位符替换为实际内容，删除所有本类注释。
用例 kind：TRIGGER_POSITIVE / TRIGGER_NEGATIVE / BOUNDARY / TASK；scope：SMOKE / REGRESSION / RELEASE。
阈值默认：SMOKE 0.6 / REGRESSION 0.8 / RELEASE 0.9（dataset 顶层可覆盖）。
-->
---
name: <kebab-skill-name>
description: <一句话说明技能做什么，第三人称>。Use when <何时应触发本技能>。
metadata:
  version: 0.1.0
  owner: <团队或个人>
  data_classification: internal
---

# <技能标题>

## 适用场景与触发条件

- 适用：<明确列出应使用本技能的场景——与 dataset.yaml 的 TRIGGER_POSITIVE 用例对应>
- 不适用：<明确列出排除场景——与 TRIGGER_NEGATIVE 用例对应>

## 输入与前置条件

- 输入：<输入内容、格式、来源>
- 前置：<需要的权限、环境、凭据形态（占位符）>

## 执行流程

1. <步骤一>
2. <步骤二>

条件处理：若 <异常条件>，则 <处理方式>；否则按上述流程继续。

## 完成标准

- <可判定验收条件——与 TASK 用例的 expected_keywords/llm_judge_rubric 对应>

## 异常处理与安全边界

- 异常路径：<失败行为与提示>
- 每次执行输出处理摘要，便于审计日志留存；高风险输出必须经人工审查确认
