# 输入输出样例

## 输入样例

```json
{
  "customer": {
    "name": "某科技有限公司",
    "taxId": "91110000XXXXXXXX",
    "contact": "张经理 138-xxxx-xxxx"
  },
  "materials": ["营业执照", "近三年财务报表", "征信报告"],
  "options": {
    "riskModel": "enterprise-v2",
    "dimensions": ["credit", "operation", "legal", "affiliation"]
  }
}
```

## 输出样例

```json
{
  "status": "completed",
  "riskLevel": "中风险",
  "totalScore": 52,
  "dimensions": {
    "credit": { "score": 18, "weight": 0.35, "findings": ["近3个月有1次逾期"] },
    "operation": { "score": 14, "weight": 0.25, "findings": [] },
    "legal": { "score": 12, "weight": 0.20, "findings": ["1起合同纠纷诉讼"] },
    "affiliation": { "score": 8, "weight": 0.20, "findings": [] }
  },
  "recommendation": "补充审查后决定",
  "warnings": ["关联方风险传导需关注"]
}
```