# Output Quality Metrics（正式硬指标）

## 指标表

| 组 | 编号 | 指标 | 定义/公式 | 合格线 |
| --- | --- | --- | --- | ---: |
| IS | IS1 | 营业收入 | Revenue | >98% |
| IS | IS2 | 营业成本 | Cost of Revenue | >98% |
| IS | IS3 | 毛利润 | IS1-IS2 | >98% |
| IS | IS4 | 毛利率 | IS3/IS1 | >98% |
| IS | IS5 | 营业利润EBIT | Operating Income | >98% |
| IS | IS6 | 归母净利润 | Net Income attributable to parent | >98% |
| IS | IS7 | 基本每股收益 | 归母净利/加权平均股本 | >98% |
| BS | BS1 | 总资产 | 流动资产+非流动资产 | >98% |
| BS | BS2 | 总负债 | 流动负债+非流动负债 | >98% |
| BS | BS3 | 股东权益 | BS1-BS2 | >98% |
| BS | BS4 | 现金及等价物 | Cash & Cash Equivalents | >98% |
| BS | BS5 | 应收账款 | Accounts Receivable净额 | >98% |
| BS | BS6 | 存货 | Inventory净额 | >98% |
| BS | BS7 | 有息负债 | Short-term Debt+Long-term Debt | >98% |
| CF | CF1 | 经营活动现金流 | Operating Cash Flow | >98% |
| CF | CF2 | 资本开支 | Capital Expenditure绝对值 | >98% |
| CF | CF3 | 自由现金流 | CF1-CF2 | >95% |
| D | D1 | 单季营收同比 | 本季与上年同期单季营收计算 | >95% |
| D | D2 | 单季净利润同比 | 本季与上年同期单季归母净利计算 | >95% |
| D | D3 | 单季营收环比 | 本季与上季单季营收计算 | >95% |
| D | D4 | 单季毛利率 | 单季毛利/单季营收 | >98% |
| D | D5 | 单季毛利率环比变化 | 连续两季毛利率百分点差 | >95% |
| D | D6 | ROE年化 | 归母净利/平均股东权益 | >95% |
| D | D7 | 资产负债率 | BS2/BS1 | >98% |
| V | V1 | Forward PE | 当前股价/预期EPS，标明NTM/FY1/FY2 | >90% |
| V | V2 | Trailing PE | 当前股价/过去12个月EPS | >95% |
| V | V3 | PB | 当前股价/每股净资产 | >95% |
| V | V4 | 近20日日均成交额 | 20日成交额之和/20 | >98% |
| V | V5 | 近20日日均成交量 | 20日成交量之和/20 | >98% |
| V | V6 | 总股本 | 期末普通股总数 | >98% |
| V | V7 | 流通市值 | 股价×对应流通股本 | >95% |
| R | R1 | 年度营收同比 | 连续两年IS1计算 | >95% |
| R | R2 | 年度净利润同比 | 连续两年IS6计算 | >95% |
| R | R3 | EBIT利润率 | IS5/IS1 | >95% |
| R | R4 | 净利润率 | IS6/IS1 | >95% |
| R | R5 | 经营现金流/营收 | CF1/IS1 | >95% |

## 字段映射

- `SALES_IND`→IS1，`COGS_IND`→IS2，`GP_IND`→IS3，`GROSS_MARGIN_IND`→IS4。
- `EBIT_IND`→IS5，`NP_XORD_IND`→IS6，`EPS_RP_IND`→IS7。
- `TOT_ASSETS_IND`→BS1，`TOT_LIABS_IND`→BS2，`SHR_EQTY`→BS3。
- `CASH_IND`→BS4，`ACCTS_REC_IND`→BS5，`INVENTORIES_IND`→BS6。
- `ST_DEBT_IND+LT_DEBT_IND`→BS7。
- `CF_OP_IND`→CF1，`CAPEX_IND`→CF2，`FCF_IND`→CF3。

## 容差与口径

- 原文直引：允许±1最小显示单位。
- 计算值：相对误差不超过0.5%。
- 单位转换：元、万元、百万元、亿元数值等价即可；币种必须正确。
- 负值基数：标注负转正/正转负，不得机械输出误导性百分比。
- 公司、期间、累计/单季、实际/预测和修饰词均属于答案主键；任一错误则该原子事实失败。
- V1等需要外部预期数据的指标，不允许模型自行生成；数据缺失时应明确拒答。
