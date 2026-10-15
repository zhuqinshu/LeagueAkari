/**
 * League Akari 外部 shard：对局同步（第一阶段，只落盘不联网）
 *
 * 目的：验证国服客户端到底会不会推送结算事件，并把真实 payload 存成文件。
 * 之所以先落盘而不是直接上报服务器：打包后的应用看不到 stdout，
 * 而事件名和字段结构必须先拿到真实数据才能确定，否则每验证一次都要打一局游戏。
 *
 * 装载方式：把本文件放到 LeagueAkari 安装目录的 shards/ 下（启动时会被自动 require）。
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 只关心结算相关事件，用于过滤全量事件流 */
const EOG_URI_KEYWORD = 'end-of-game'

/**
 * 数据目录取 LeagueAkari 的 userData，升级或重装应用都不会丢数据。
 * 离线自测时没有 electron 运行时，退回系统临时目录。
 */
function resolveDataDir() {
  try {
    return path.join(require('electron').app.getPath('userData'), 'match-sync')
  } catch (error) {
    return path.join(os.tmpdir(), 'akari-match-sync')
  }
}

class MatchSyncShard {
  static id = 'match-sync'

  static priority = 0

  static dependencies = ['league-client-main']

  constructor(leagueClient) {
    this._leagueClient = leagueClient
    this._disposers = []
    this._dataDir = resolveDataDir()
  }

  async onInit() {
    fs.mkdirSync(this._dataDir, { recursive: true })

    // 整体订阅再按关键字过滤：国服具体推哪个结算事件尚未验证，
    // 一次对局把所有候选事件都抓下来，避免反复试错
    this._disposers.push(this._leagueClient.events.on('/**', (event) => this._onLcuEvent(event)))
  }

  _onLcuEvent(event) {
    const uri = event && event.uri

    if (typeof uri !== 'string' || !uri.includes(EOG_URI_KEYWORD)) {
      return
    }

    this._persist(uri, event)
  }

  _persist(uri, event) {
    const record = {
      receivedAt: new Date().toISOString(),
      uri,
      eventType: event.eventType,
      data: event.data
    }

    try {
      const day = record.receivedAt.slice(0, 10)
      // 追加流水用于累积归档，覆盖写的 last-eog.json 用于人工快速查看
      fs.appendFileSync(
        path.join(this._dataDir, `eog-${day}.jsonl`),
        `${JSON.stringify(record)}\n`,
        'utf-8'
      )
      fs.writeFileSync(
        path.join(this._dataDir, 'last-eog.json'),
        JSON.stringify(record, null, 2),
        'utf-8'
      )
    } catch (error) {
      // 落盘失败不能影响游戏客户端连接，仅记录
      console.error('[match-sync] 写入失败', error)
    }
  }

  async onDispose() {
    for (const dispose of this._disposers) {
      dispose()
    }

    this._disposers = []
  }
}

module.exports = MatchSyncShard
