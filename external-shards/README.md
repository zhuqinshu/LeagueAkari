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
        └── 分页扫描对局列表，收集本地没上报过的 gameId
              └── 逐个拉对局详情，归一化成后端约定结构
                    └── 每 50 局一批 POST 到服务端
```

几个刻意的取舍：

- **不用结算事件推送，改用定时拉取。** 国服结算推送不稳定，而本场景只要求「事后能查到」，
  晚几分钟入库完全可以接受。
- **不在客户端判断是否纳入。** 谁是车队成员只有服务端知道，五排门槛
  （同队车队成员数）比较也放在服务端，客户端不重复这套配置，避免两边不一致。
  客户端只保证「新对局不漏报」。
- **分页扫描以「整页没有新对局」作为收敛条件。** 国服的分页参数不一定生效，
  生效时逐页回溯、不生效时第二页与第一页重复，两种情况都会在这一步停下。
- **只有上报成功才把 gameId 记为已上报。** 上报失败时下一轮会重试，不会丢数据。

## 数据位置

`%APPDATA%\league-akari\match-sync\`

- `state.json` —— 已上报的 gameId、最近一次轮询/上报时间与结果，排查时先看它
- `sync-<日期>.log` —— 上报结果与异常，打包后的应用看不到 stdout，日志只能落文件

配置模板写在 `shards/match-sync.config.json`（与 shard 同级）。

## 排障

| 现象                   | 先看什么                                                       |
| ---------------------- | -------------------------------------------------------------- |
| 没有任何日志           | 配置文件是否填写，`endpoint`/`token` 是否为空                  |
| `lastError` 是上报失败 | 服务器是否可达、`token` 是否与服务端一致                       |
| 有上报但小程序查不到   | 该局同队车队成员是否够门槛，见服务端 `INGEST_MIN_TEAM_MEMBERS` |

## 离线自测

不依赖 Windows 与真实游戏客户端，用一个假的 `leagueClient` 即可跑通全链路：

```bash
MATCH_SYNC_DATA_DIR=/tmp/akari-selftest/data \
MATCH_SYNC_CONFIG=/tmp/akari-selftest/config.json \
node your-harness.js
```

两个环境变量只用于这种自测场景，线上配置仍来自 `shards/` 下的文件。
