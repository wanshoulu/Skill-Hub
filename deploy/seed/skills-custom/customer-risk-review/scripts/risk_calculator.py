"""风险评分计算脚本

根据各维度数据计算综合风险等级。
输入：各维度原始评分（0-100）
输出：综合评分、风险等级、处置建议
"""

DIMENSIONS = {
    "credit": {"weight": 0.35, "max": 100},
    "operation": {"weight": 0.25, "max": 100},
    "legal": {"weight": 0.20, "max": 100},
    "affiliation": {"weight": 0.20, "max": 100},
}

LEVELS = [
    (0, 30, "低风险", "建议通过，正常准入"),
    (31, 60, "中风险", "建议补充审查后决定"),
    (61, 80, "高风险", "建议拒绝或上报审批"),
    (81, 100, "极高风险", "建议拒绝并列入关注名单"),
]


def calculate_score(dimension_scores: dict) -> dict:
    """计算综合风险评分和等级"""
    total = 0
    details = {}
    for dim, config in DIMENSIONS.items():
        raw = min(max(dimension_scores.get(dim, 0), 0), config["max"])
        weighted = round(raw * config["weight"], 2)
        total += weighted
        details[dim] = {"raw": raw, "weight": config["weight"], "weighted": weighted}

    total = round(total)
    for low, high, level, action in LEVELS:
        if low <= total <= high:
            return {
                "totalScore": total,
                "riskLevel": level,
                "recommendation": action,
                "details": details,
            }

    return {
        "totalScore": total,
        "riskLevel": "未知",
        "recommendation": "需人工复核",
        "details": details,
    }