# 规则集（Rules）与棋盘设置

> 权威规则文档：https://lightvector.github.io/KataGo/rules.html

## 规则参数结构

KataGo 的规则由 **7 个正交字段** 组成，可以任意组合（少数组合神经网络不支持）：

```json
{
  "ko": "SIMPLE" | "POSITIONAL" | "SITUATIONAL",
  "scoring": "AREA" | "TERRITORY",
  "tax": "NONE" | "SEKI" | "ALL",
  "suicide": true | false,
  "hasButton": true | false,
  "whiteHandicapBonus": "0" | "N-1" | "N",
  "friendlyPassOk": true | false
}
```

### 字段含义

| 字段 | 值 | 含义 |
|---|---|---|
| `ko` | SIMPLE | 只禁"马上提回同一子"。允许三劫等（可能出现循环） |
| | POSITIONAL | 禁止任何重复的整盘位置（与当时手方无关） |
| | SITUATIONAL | 禁止"完全相同盘面且轮到同一方"重复 |
| `scoring` | AREA | 数子法（地+活子） |
| | TERRITORY | 数目法（只数空地 + 提子） |
| `tax` | NONE | 不扣 |
| | SEKI | seki 内的空地不算分（日规特征） |
| | ALL | 每活块扣 2 目（做两眼的成本），stone-scoring 用 |
| `suicide` | true | 允许多子自杀（Tromp-Taylor、NZ） |
| | false | 禁止自杀（Chinese、Japanese 等绝大多数） |
| `hasButton` | true | 启用 button go（结束前可按一次"按钮"多得 0.5 目） |
| `whiteHandicapBonus` | "0" | 不补偿 |
| | "N-1" | 补 N-1 目（AGA） |
| | "N" | 补 N 目（Chinese） |
| `friendlyPassOk` | true | 允许友善 pass（stone-scoring 以外） |
| | false | 要求结束前必须清除所有死子（Tromp-Taylor 严格） |

## 常用预设字符串（shorthand）

可以直接在 query 里传字符串：

| shorthand | 对应配置 |
|---|---|
| `tromp-taylor` | ko=POSITIONAL, scoring=AREA, suicide=**true**, tax=NONE, bonus=0, friendlyPassOk=**false** |
| `chinese` | ko=**SIMPLE**, scoring=AREA, suicide=false, tax=NONE, bonus=N, friendlyPassOk=true |
| `chinese-ogs` / `chinese-kgs` | ko=**POSITIONAL**, 其他同 chinese |
| `japanese` | ko=SIMPLE, **scoring=TERRITORY**, suicide=false, **tax=SEKI**, bonus=0 |
| `korean` | 同 japanese |
| `aga` | ko=SITUATIONAL, scoring=AREA, suicide=false, tax=NONE, bonus=**N-1** |
| `new-zealand` | ko=SITUATIONAL, scoring=AREA, suicide=**true**, tax=NONE, bonus=0 |
| `stone-scoring` | ko=SIMPLE, scoring=AREA, **tax=ALL**, bonus=0 |
| `aga-button` | ko=SITUATIONAL, scoring=AREA, suicide=false, bonus=N-1, **hasButton=true** |

### ⚠️ 一个经常被忽略的区别

**中国规则在实践中 vs 书面：**
- `chinese`：**SIMPLE ko**（实战中常见，大多数线下中国比赛），因此三劫真的会被裁判判无胜负。
- `chinese-ogs` / `chinese-kgs`：**POSITIONAL ko**（按书面规则实现，服务器常用），理论上不会出现三劫无胜负。

→ 如果你做中国大陆用户为主的网站，传 `chinese` 可能更贴合用户直觉；但做国际化/ OGS 对标则用 `chinese-ogs`。

## 规则对分数的影响（"同局面不同分"的常见原因）

同一终局位置：
- AREA 与 TERRITORY 算出的得分差通常是 0 ~ 2 目（取决于是否每方都下了同等手数）
- SEKI 下的 tax 只影响 Japanese/Korean
- `hasButton` 能让 AREA 的贴目半目差异消失

→ **测试不同规则时，要用同一个棋谱但改 `rules` 字段**，看 `scoreLead` 怎么变。详见测试脚本 `scripts/test_rules_diff.py`。

## 棋盘尺寸

### 官方支持
- **9×9 ~ 19×19**：所有官方网络训练过的尺寸
- **7×7、8×8**：g170 之后训练过
- **20×20 ~ 25×25**：没训练，但能跑（泛化能力）
- **>25×25**：需要自行编译 `cpp/game/board.h` 里的 `MAX_LEN`

### 非方形棋盘
- `boardXSize != boardYSize`（例如 13×9）：**较新的网络**支持但训练数据很少；**老网络**完全没训练过。
- 建议：谨慎使用非方形棋盘，并在前端明确告知"AI 在非方形棋盘上可能表现不佳"。

### 强度差异
- 同一网络，在越"远离训练分布"的尺寸上表现越差：
  - 19×19、13×13、9×9：超人类水平
  - 11×11、15×15、17×17：略弱但仍强
  - >21×21：明显弱于 19×19 下的水平
  - 5×5、4×4：虽然能跑，但无训练数据，建议用专门的小棋盘解算器
- 如果你支持多尺寸，**网络越新越好**。`kata1-b18c384nbt` 系列比 `g170` 在非 19×19 上强很多。

### 棋盘位置坐标
KataGo 支持两种：
- **GTP 字母坐标**：`A1` ~ `T19`（跳过 I）；大棋盘用 `AA`, `AB`, `AC` 扩展
- **整数坐标**：`"(0,13)"` 格式，(x, y) 从左下角开始计数
- **pass**：字符串 `"pass"`

⚠️ **GTP 协议不存在 `I` 列**（避免手写时和 `1` 混淆），但 `boardXSize=10` 时第 10 列是 `J` 不是 `I`。自己实现坐标转换时记得跳过。

### 让子棋（handicap）

Analysis Engine 里表示让子：
1. 用 `initialStones` 放置让子石（省事，但丢 ko 历史）
2. 传 `whiteHandicapBonus = "N"`（中国规则）或 `"N-1"`（AGA）设置贴目补偿

GTP 里：
- 用 `fixed_handicap N`、`place_free_handicap N`、`set_free_handicap vertices...` 三个标准命令
- 避免用连续的 `play B vertex` 来摆让子（除非 config 里开 `assumeMultipleStartingBlackMovesAreHandicap = true`）

**坑**：某些前端用连续 play B 命令来"伪造"让子。开启 `assumeMultipleStartingBlackMovesAreHandicap` 之后，KataGo 才会意识到这是让子，并用正确的 `whiteHandicapBonus` 补偿逻辑。否则贴目计算会错。

