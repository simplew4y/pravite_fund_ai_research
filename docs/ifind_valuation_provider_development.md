# iFinD 估值五指标数据源开发文档

## 1. 开发结论

当前信息已经足够进入代码开发阶段。

首期目标是在现有 `valuation-five-metrics-v2` 中新增直接连接 iFinD 官方 HTTP API 的 `IFindHttpMarketDataProvider`，并让它成为 A 股五指标的最高优先级数据源。现有 `HttpMarketDataProvider` 继续服务于内部统一格式接口，不复用为 iFinD 官方接口适配器。

首期只验收 A 股。港股代码结构与降级路径继续保留，但不作为本期发布阻塞项。

## 2. 首期范围

### 2.1 包含

- 支持任意合法 A 股代码，如 `300274.SZ`、`600000.SH`、`430047.BJ`。
- 通过 iFinD 官方 `/api/v1/date_sequence` 获取五指标所需原始数据。
- 将 iFinD 原始字段转换为现有 `MarketDataProvider.fetch_metrics()` 返回结构。
- iFinD 按字段优先，缺失字段继续使用 AKShare、东方财富等现有数据源补齐。
- 保留每个指标的数据源、原始字段代码、取值日期和请求状态。
- iFinD 失败、无权限或无数据时，不阻断整个估值页面。

### 2.2 不包含

- 港股数据正确性验收。
- 公告全文、公告标题和 PDF 链接接入。
- 严格的历史时点回测与防未来数据验证。
- 前端单位换算或单位标签改造。
- 新增估值指标或修改五指标预警阈值。

## 3. 五指标冻结口径

| 页面指标 | 内部键 | iFinD 原始字段 | 请求频率 | 计算方式 |
| --- | --- | --- | --- | --- |
| 单季净利润增速 | `quarter_net_profit_yoy` | `ths_sq_np_atsopc_yoy_stock` | 季 | iFinD 值除以 100 |
| 单季毛利率环比变化 | `quarter_gross_margin_qoq_delta` | `ths_sales_gross_interest_sq_stock` | 季 | `(本季毛利率 - 上季毛利率) / 100` |
| Forward PE | `forward_pe` | `ths_fore_pe_in_12m_stock` | 日 | 直接使用，不用 TTM PE 替代 |
| 近20日日均成交额 | `avg_turnover_amount_20d` | `ths_amt_stock` | 日 | 最近20个有效交易日算术平均 |
| 单季营收增速环比 | `quarter_revenue_growth_qoq` | `ths_revenue_yoy_sq_stock` | 季 | `(本季营收同比 - 上季营收同比) / 100` |

`ths_amt_stock` 首期暂按人民币元处理，不在前端增加单位映射。此口径应记录在 provider 元数据中，后续若官方字段元数据给出不同缩放比例，只修改 provider 的归一化逻辑。

## 4. 时间口径

五指标分为两组：

- 财务指标：净利润同比、毛利率变化、营收增速变化，对应目标报告期，例如 `2024Q2`。
- 市场指标：Forward PE、20日平均成交额，对应估值日期。

首期不调用 `/report_query`。财务指标的 `period` 使用模型时间线当前选择的 `target_period`，iFinD 返回的 `time` 保存为 `value_date`。

毛利率变化和营收增速变化都需要目标季度和上一季度两个原始值，因此季度请求必须覆盖两个季度。例如目标为 `2024Q2`，请求范围至少覆盖 `2024Q1` 和 `2024Q2`，不能只请求第二季度。

开发时必须用 `300274.SZ` 做一次已知季度对照，确认 iFinD `date_sequence` 返回的季度值与目标报告期一致。若 iFinD 返回的是“查询日当时最新已披露值”而不是指定报告期值，则该项必须标记为 `period_mismatch`，不得触发预警；严格报告期定位随后再接披露日期或公告数据。

## 5. 官方接口请求

### 5.1 基础地址

```text
https://quantapi.51ifind.com/api/v1
```

首期使用：

```text
POST /date_sequence
```

### 5.2 季度原始值请求

示例目标：`300274.SZ`，目标报告期 `2024Q2`。

```json
{
  "codes": "300274.SZ",
  "functionpara": {
    "Interval": "Q"
  },
  "startdate": "2024-01-01",
  "enddate": "2024-06-30",
  "indipara": [
    {
      "indicator": "ths_sq_np_atsopc_yoy_stock",
      "indiparams": ["", ""]
    },
    {
      "indicator": "ths_sales_gross_interest_sq_stock",
      "indiparams": ["", ""]
    },
    {
      "indicator": "ths_revenue_yoy_sq_stock",
      "indiparams": ["", ""]
    }
  ]
}
```

### 5.3 日频原始值请求

请求区间应覆盖估值日前至少 30 个自然日，以确保得到 20 个完整交易日。

```json
{
  "codes": "300274.SZ",
  "startdate": "2024-05-15",
  "enddate": "2024-06-30",
  "indipara": [
    {
      "indicator": "ths_fore_pe_in_12m_stock",
      "indiparams": [""]
    },
    {
      "indicator": "ths_amt_stock",
      "indiparams": [""]
    }
  ]
}
```

处理规则：

- Forward PE 取不晚于估值日的最后一个非空值。
- 成交额去掉空值，按交易日期倒序取最近 20 条，再求平均。
- 少于 20 条时不计算成交额指标，返回缺失状态，交给下一数据源补齐。
- 不使用非交易日向前填充值重复凑足 20 天。

## 6. Provider 设计

### 6.1 新增类

在 `omnigent/omnigent/server/private_fund_valuation_metrics.py` 中新增：

```python
class IFindHttpMarketDataProvider:
    name = "ifind"

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        ...
```

该类负责：

1. 校验并规范化 A 股代码。
2. 取得可用的 iFinD `access_token`。
3. 分别发起季度和日频请求。
4. 检查 HTTP 状态、iFinD `errorcode` 和响应结构。
5. 归一化五指标并返回现有 provider 合约。

不要让它继承或包装 `HttpMarketDataProvider`。两者的认证头、请求体、返回结构和错误语义不同，只共同满足 `MarketDataProvider` 协议。

### 6.2 归一化结果

每个成功指标至少返回：

```json
{
  "value": -0.401157,
  "period": "2024Q2",
  "as_of": "2024-08-30",
  "source": "ifind",
  "metadata": {
    "indicator": "ths_sq_np_atsopc_yoy_stock",
    "raw_value": -40.1157,
    "raw_unit": "percent"
  }
}
```

成交额元数据使用：

```json
{
  "raw_unit": "CNY",
  "unit_assumption": true,
  "sample_count": 20
}
```

## 7. 认证与配置

禁止在代码、日志、测试快照和 Git 历史中保存真实 token。

本地环境变量：

```ini
PRIVATE_FUND_IFIND_BASE_URL=https://quantapi.51ifind.com/api/v1
PRIVATE_FUND_IFIND_ACCESS_TOKEN=
```

当前由本地部署者维护 `PRIVATE_FUND_IFIND_ACCESS_TOKEN`，provider 不自动换取或刷新 token。

以下旧变量：

```ini
PRIVATE_FUND_IFIND_API_URL=
PRIVATE_FUND_IFIND_API_TOKEN=
```

它们代表旧的统一格式适配接口，不用于官方 `IFindHttpMarketDataProvider`。

## 8. 数据源优先级

A 股字段级优先级：

```text
IFindHttpMarketDataProvider
  -> AkshareMarketDataProvider
  -> EastmoneyFinancialMarketDataProvider
  -> configured consensus provider（仅缺失 Forward PE 时）
```

`FreeComboMarketDataProvider` 保留当前逐字段补齐行为。iFinD 返回其中四项时，只补第五项，不丢弃已经成功的四项。

仅当 iFinD 官方配置存在时才将其加入优先列表。未配置时，系统行为与当前免费组合一致。

## 9. 错误与安全规则

下列情况只影响对应字段，不应导致页面 500：

- HTTP 超时或连接失败。
- token 失效或无权限。
- iFinD `errorcode` 非成功状态。
- 某个指标列不存在、为空或不是有效数字。
- 季度数据不足，无法计算环比变化。
- 成交额有效交易日不足 20 条。

错误信息不得包含 token、完整请求头或账户信息。保留脱敏后的 provider、接口路径、指标代码、错误码和错误消息即可。

任何 `stale`、`period_mismatch`、`entitlement_missing` 状态都可以展示，但不得触发偏差预警。

## 10. 代码修改清单

| 文件 | 修改内容 |
| --- | --- |
| `omnigent/omnigent/server/private_fund_valuation_metrics.py` | 新增官方 provider、两类请求、响应解析、指标计算和配置装配 |
| `omnigent/tests/server/test_private_fund_valuation_metrics.py` | 新增认证、请求体、转换、20日平均、错误与字段级降级测试 |
| `.env.example` | 增加官方 base URL 与人工维护的 access token 示例 |
| `docs/adr/0001-ifind-first-valuation-market-data.md` | 将首期验收范围补充为 A 股，港股后续验证 |

前端首期不需要修改。现有页面继续消费统一的五指标响应。

## 11. 最小测试集

必须覆盖：

1. A 股代码原样转换为 iFinD 代码。
2. 请求头使用 `access_token`，而不是 `Authorization: Bearer`。
3. 季度请求包含三个冻结字段和 `Interval: Q`。
4. 日频请求包含 Forward PE 与成交额字段。
5. `-40.1157` 被转换为 `-0.401157`。
6. 毛利率和营收同比使用相邻两个季度计算变化。
7. Forward PE 取估值日前最后一个有效值。
8. 成交额恰好使用 20 个有效交易日，单位按元处理。
9. 成交额少于 20 日时不计算并触发字段级降级。
10. iFinD 单字段缺失时保留其余字段，并调用后续 provider 补齐。
11. token、响应错误和超时信息不会泄漏到结果或日志。
12. 未配置 iFinD 时，现有免费数据源测试保持通过。

测试必须使用脱敏固定响应，不调用真实 iFinD 网络。

## 12. 验收标准

以 `300274.SZ` 为首个验收样本：

- 点击刷新后，provider 尝试列表第一项为 `ifind`。
- 五指标均能显示；iFinD 缺失项明确显示实际补充来源。
- 三个财务指标与目标季度及上一季度的人工核对结果一致。
- Forward PE 使用 `ths_fore_pe_in_12m_stock`，没有用 PE/TTM 代替。
- 20日平均成交额由 20 个有效交易日组成，原始值暂按元。
- 单一字段失败不会清空其他四项。
- iFinD 全部失败时，页面仍显示现有免费源可取得的数据。
- 所有新增和现有估值测试通过。

## 13. 开发顺序

1. 新增 `IFindHttpMarketDataProvider` 和静态 access-token 配置。
2. 完成 `/date_sequence` 两类请求及响应解析。
3. 接入 `FreeComboMarketDataProvider` 的首位字段级降级链。
4. 增加脱敏单元测试并运行估值模块测试。
5. 使用 `300274.SZ` 在开发环境做一次真实接口联调。
6. 核对目标季度数据后再开启偏差预警。
7. 后续单独增加 refresh-token 自动刷新、港股验证和严格历史时点回测。

## 14. 官方参考

- [iFinD HTTP 接口环境与认证说明](https://quantapi.10jqka.com.cn/gwstatic/static/ds_web/quantapi-web/help-center/deploy.html)
- [iFinD 数据接口手册](https://quantapi.10jqka.com.cn/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)
- [iFinD 超级命令](https://quantapi.10jqka.com.cn/gwstatic/static/ds_web/quantapi-web/index.html)
