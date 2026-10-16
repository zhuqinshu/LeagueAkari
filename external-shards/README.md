# 外部 shard：对局同步

League Akari 内置了外部 shard 装载机制：启动时会扫描 **exe 同级的 `shards/` 目录**，
把其中的每个 `.js` 通过 `require` 加载并交给 `AkariManager` 托管
（见 `src/main/bootstrap/index.ts`，v1.5.0 起可用）。

所以新增功能不必改源码、不必重新打包，运行进程仍是 `LeagueAkari.exe`。

## 安装

1. 确认 League Akari 版本 ≥ `1.5.0`
2. 找到 `LeagueAkari.exe` 所在目录（Windows 发行包是 7z 解压出来的文件夹）
3. 新建子目录 `shards`，把 `match-sync.js` 放进去：

```
league-akari/
├── LeagueAkari.exe
└── shards/
    └── match-sync.js
```

目录扫描**不递归**，文件必须直接位于 `shards/` 下。

## 配置

首次启动会在 `shards/` 下生成 `match-sync.config.json` 模板，填好后重启 League Akari：

```json
{
  "endpoint": "https://<你的后端域名>/api/v1/sync/matches",
  "token": "<与服务端 SYNC_TOKEN 一致>",
  "intervalSeconds": 120,
  "initialDelaySeconds": 15
}
```

`endpoint` 建议直接用 HTTPS 域名，避免明文令牌走公网。

- `endpoint` / `token` 任一为空时同步停用，只在日志里提示一次，不会反复请求
- `intervalSeconds` 最小 30 秒，避免手误写 0 变成死循环

## 工作流程

```
每 intervalSeconds 一次
  └── 取当前召唤师 puuid（LCU 未连接则静默跳过，等下一轮）
        └── 分页问 SGP 要对局列表，筛出本地没上报过的对局（首轮为历史回溯，见下）
              └── 归一化成后端约定结构
                    └── 每 50 局一批 POST 到服务端
        └── 问服务端「哪几局还没有对局详情」
              └── 逐个从 SGP 拉 SUMMARY + DETAILS 原文，一局一个请求 POST 到服务端
```

摘要与详情是两段独立的上报：摘要负责「这局发生了什么」，详情负责「详情页能看什么」。
两段都走 SGP —— 对局列表也用 SGP 而不是 LCU，因为国服 LCU 的 `match-history` 接口
会成段时间返回 500（`Missing configuration data`），而同一时刻 SGP 是好的；
走 LCU 会让整个采集阶段跟着一起空转，表现是「打了一晚上一局都没入库」。
SGP 列表每局已带完整 10 人数据，也就不必再逐局调 LCU 拿对局详情。

详情一局要两份 SGP 原文：`SUMMARY` 提供参与者面板与队伍数据
（符文、装备、挑战、大小龙），`DETAILS` 提供每帧属性与事件流水。
`DETAILS` 里的 `participants` 只有 `participantId` 与 `puuid`，单靠它渲染不出总览与符文页；
而 LCU 的时间线只有金币、等级、补刀与坐标，压根没有生命值、攻击力、护甲这类属性。

几个刻意的取舍：

- **不用结算事件推送，改用定时拉取。** 国服结算推送不稳定，而本场景只要求「事后能查到」，
  晚几分钟入库完全可以接受。
- **不在客户端判断是否纳入。** 谁是车队成员只有服务端知道，「模式白名单 + 同队人数门槛」
  这套比较也放在服务端，客户端不重复配置，避免两边不一致。客户端只保证「新对局不漏报」
  —— 服务端判定不纳入的对局同样返回 200，客户端照常记为已上报，不会反复重发。
- **首轮做历史回溯，之后只看增量。** 首次运行 `backfillDone` 为 false，会一直往外翻页
  把历史补齐（上限 `MAX_PAGES` 页 = 1200 局），每轮最多 100 局，所以历史是逐轮补完的；
  拿到空页或翻满页数上限后把 `backfillDone` 落盘，此后只扫最新一页。
- **分页扫描的收敛条件分两种模式。** 回溯阶段不能因为「整页都上报过」就停
  —— 那正是回溯到一半的样子，一停就永远只看得见最新一页；只有在拿到空页
  或翻满页数上限时才收敛。增量阶段整页没有新对局即停止。页码按上游实际返回的条数推进，
  上游对 `count` 有更小上限时也不会跳局；上游完全不认分页参数时每页都是同一批对局，
  最多白跑一轮，之后靠 `backfillDone` 收敛。
- **位置用 SGP 的 `teamPosition`。** LCU 只给 `lane`（TOP/JUNGLE/MIDDLE/BOTTOM），
  辅助位分不出来，全被记成 BOTTOM；SGP 多一个 UTILITY，所以小数标注的辅助位是准的。
- **只有上报成功才把 gameId 记为已上报。** 上报失败时下一轮会重试，不会丢数据。
- **详情补拉由服务端排队，客户端不记状态。** 每轮先问服务端要「已入库但还没有详情的对局」
  （新的在前，每轮最多 `MAX_DETAILS_PER_SYNC` 局），拉到就上报。
  客户端因此不需要维护「哪几局还没上报详情」—— 重启、换机器、中途崩掉都不会漏局，
  历史对局也会被自动补齐。
- **上游确认没有的对局会被记档。** SGP 返回 404 或响应里没有 `json` 主体，说明这局详情
  已经拿不到了，客户端照实上报一个「无详情」给服务端，服务端记下来不再重复询问 ——
  否则补拉队列会永远卡在这一局上，每轮都去问一次上游。
- **详情上报一局一个请求，失败只影响这一局。** 一局详情报文约 1MB，家宽上行不稳时
  单次上报会超过 60s（服务端其实已经收完入库，只是响应回不来）。超时与异常都被单局兜住、
  下一轮重试，不会连带丢掉本轮剩下的对局 —— 异常一旦抛出去，每轮就只补得动一局。

## 重复保护

历史补齐会反复扫同一批对局，靠三层保证不会重复入库：

1. **本地已上报集合 `sentGameIds`。** 扫到已在集合里的 gameId 就不再拉详情、不再上报。
   回溯阶段新增的 ID 追加到列表尾部（拿到的是更老的对局），增量阶段插到头部，
   列表整体保持「新在前」，超过 `SENT_GAME_ID_LIMIT`（4000）时从尾部丢最老的。
2. **回溯只做一次。** `backfillDone` 落盘后不会再回扫历史页，避免每轮都重走一遍老数据。
3. **服务端 gameId 幂等兜底。** 即使本地 `state.json` 被删（换机器、清 userData）导致
   从头重扫，服务端也会按 `lol_match.uk_game_id` / `lol_match_participant.uk_game_puuid`
   判重，重放的对局计入 `duplicated` 而不是 `accepted`，不会产生第二行数据。
   这一层是必需的：客户端不标记「已上报」只依赖以上两道防线时，本地状态一丢就会重复上报。

## 数据位置

`%APPDATA%\league-akari\match-sync\`

- `state.json` —— 已上报的 gameId、历史是否已回溯到底（`backfillDone`）、
  最近一次轮询/上报时间与结果、最近一次详情补拉结果（`lastDetails`），排查时先看它
- `sync-<日期>.log` —— 上报结果与异常，打包后的应用看不到 stdout，日志只能落文件

配置模板写在 `shards/match-sync.config.json`（与 shard 同级）。

## 排障

| 现象                   | 先看什么                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 没有任何日志           | 配置文件是否填写，`endpoint`/`token` 是否为空                                                                                                                         |
| `lastError` 是上报失败 | 服务器是否可达、`token` 是否与服务端一致                                                                                                                              |
| 有上报但小程序查不到   | 该局是否不满足服务端的两道纳入条件：模式在 `INGEST_QUEUE_IDS` 白名单里、同队车队成员够 `INGEST_MIN_TEAM_MEMBERS`（默认 5）                                            |
| 战绩有、详情页空       | `endpoint` 是否指向 `.../api/v1/sync/matches`（详情补拉按这个地址推导，前缀不对会直接停用并在日志里说明）；`sgp-main` 是否就绪（国服要登录着客户端才拿得到 SGP 令牌） |
| 详情一直不动           | `state.json` 的 `lastDetails.failed` 是否长期大于 0，以及日志里 SGP 报的错                                                                                            |
| 一晚上一局都没入库     | LCU 的 `match-history` 是否在返回 500（`lol-game-queues/v1/queues` 同时报 500 就是国服客户端 LCU 整体异常，此时只有 SGP 还能用）                                      |
| 详情补拉每轮只动一局   | 上行带宽不够导致详情上报超时：nginx 访问日志里 `POST /api/v1/sync/details` 是 499，服务端却记到了 `stored=1`                                                          |

## 离线自测

不依赖 Windows 与真实游戏客户端，用一个假的 `leagueClient` 即可跑通全链路：

```bash
MATCH_SYNC_DATA_DIR=/tmp/akari-selftest/data \
MATCH_SYNC_CONFIG=/tmp/akari-selftest/config.json \
node your-harness.js
```

两个环境变量只用于这种自测场景，线上配置仍来自 `shards/` 下的文件。
