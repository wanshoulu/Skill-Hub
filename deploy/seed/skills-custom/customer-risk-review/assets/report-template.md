# 客户风险审查报告

## 基本信息

| 项目 | 内容 |
|------|------|
| 客户名称 | {{customer_name}} |
| 证件号码 | {{tax_id}} |
| 审查日期 | {{review_date}} |
| 审查人员 | {{reviewer}} |

## 风险评分

| 维度 | 原始分 | 权重 | 加权分 |
|------|--------|------|--------|
| 信用 | {{credit_raw}} | 35% | {{credit_weighted}} |
| 经营 | {{operation_raw}} | 25% | {{operation_weighted}} |
| 法律 | {{legal_raw}} | 20% | {{legal_weighted}} |
| 关联 | {{affiliation_raw}} | 20% | {{affiliation_weighted}} |
| **综合** | | | **{{total_score}}** |

## 风险等级：{{risk_level}}

## 风险点详情

{{risk_findings}}

## 处置建议

{{recommendation}}

## 备注

{{warnings}}