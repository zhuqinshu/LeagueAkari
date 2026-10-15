# 外部 shard：对局同步

League Akari 内置了外部 shard 装载机制：启动时会扫描 **exe 同级的 `shards/` 目录**，
把其中的每个 `.js` 通过 `require` 加载并交给 `AkariManager` 托管
（见 `src/main/bootstrap/index.ts`，commit `eb6d5dc5`，v1.5.0 起可用）。

所以新增功能不必改源码、不必重新打包。

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

## 当前阶段：只落盘，不联网

第一阶段只做一件事——验证国服客户端到底推不推结算事件，并把真实 payload 存下来。
打包后的应用看不到 stdout，且事件名与字段结构必须先拿到真实数据才能定，
所以先落盘、暂不上报服务器。

订阅的是全量事件再按 `end-of-game` 关键字过滤，这样一次对局可以把
`eog-stats-block` 与 `gameclient-eog-stats-block` 两个候选事件一起抓到，
不用反复打游戏试错。验证完成后会收敛到确定的那一个事件名。

## 数据位置

`%APPDATA%\league-akari\match-sync\`

- `eog-<日期>.jsonl` —— 追加流水，每行一条事件
- `last-eog.json` —— 最后一次事件，格式化后便于阅读

找不到该目录时，在 `%APPDATA%` 下搜索 `match-sync` 即可。

## 验证步骤

1. 放好文件，重启 League Akari
2. 打一局五排（对局要正常结算）
3. 看 `match-sync` 目录是否有新文件
   - 有 → 国服会推送结算事件，方案确定
   - 没有 → 国服不推该事件，改用对局列表轮询兜底

## 后续

- 把 payload 映射成自己的数据结构
- 增加上报到自建服务器的能力（游戏 ID 去重）
- 扩展到 `participants` 落库，供小程序查询

## 说明

该 shard 运行在 League Akari 主进程内，进程名仍是 `LeagueAkari.exe`，
不引入新的进程或第三方可执行文件。
