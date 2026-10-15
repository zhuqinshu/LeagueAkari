/**
 * League Akari 外部 shard：对局同步
 *
 * 职责边界：
 * - 客户端只负责「把新对局如实送上去」：定时拉取当前召唤师的对局列表，
 *   对没上报过的 gameId 拉详情、归一化、批量上报。
 * - 是否纳入由服务端判断：谁是车队成员只有服务端知道，
 *   五排门槛（同队车队成员数）比较也放在服务端，客户端不重复这套配置。
 *
 * 之所以用定时拉取而不用结算事件推送：国服结算推送不稳定，
 * 而本场景只要求「事后能查到」，晚几分钟入库完全可以接受。
 *
 * 装载方式：把本文件放到 LeagueAkari 安装目录（exe 同级）的 shards/ 下。
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** LCU 对局列表单页条数，与分页参数一起使用 */
const PAGE_SIZE = 100
/**
 * 最多回溯页数，即首次运行最多补多少历史（30 页 = 3000 局）。
 * 到底时 LCU 会返回空页，所以这个值只是兜底上限；国服分页参数不生效时
 * 每页都是同一批对局，最多白跑一轮，之后靠 backfillDone 收敛。
 */
const MAX_PAGES = 30
/** 单次同步最多拉取多少局详情，避免长时间未开机后一次性压满 LCU */
const MAX_MATCHES_PER_SYNC = 100
/**
 * 本地已上报 gameId 的保留数量，裁剪时丢最老的。
 * 必须大于 PAGE_SIZE * MAX_PAGES，否则回溯出来的历史会滚出窗口、
 * 被当成新对局反复重拉详情。
 */
const SENT_GAME_ID_LIMIT = 4000
/** 服务端单次上报上限 50 局，这里与之对齐 */
const UPLOAD_BATCH_SIZE = 50
const UPLOAD_TIMEOUT_MS = 20000

const DEFAULT_CONFIG = {
  /** 自建服务端上报地址，例如 http://1.2.3.4:3000/api/v1/sync/matches */
  endpoint: '',
  /** 与服务端 SYNC_TOKEN 一致 */
  token: '',
  /** 轮询间隔，秒 */
  intervalSeconds: 120,
  /** 启动后首次轮询延迟，秒。留出时间等 LCU 连接完成 */
  initialDelaySeconds: 15
}

/**
 * 数据目录取 LeagueAkari 的 userData，升级或重装应用都不会丢数据。
 * 离线自测时没有 electron 运行时，可用 MATCH_SYNC_DATA_DIR 指定。
 */
function resolveDataDir() {
  if (process.env.MATCH_SYNC_DATA_DIR) {
    return process.env.MATCH_SYNC_DATA_DIR
  }

  try {
    return path.join(require('electron').app.getPath('userData'), 'match-sync')
  } catch (error) {
    return path.join(os.tmpdir(), 'akari-match-sync')
  }
}

function toInt(value, fallback = 0) {
  const num = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(num) ? Math.trunc(num) : fallback
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (error) {
    return fallback
  }
}

class MatchSyncShard {
  static id = 'match-sync'

  static priority = 0

  static dependencies = ['league-client-main']

  constructor(leagueClient) {
    this._leagueClient = leagueClient
    this._dataDir = resolveDataDir()
    this._stateFile = path.join(this._dataDir, 'state.json')
    this._config = null
    this._state = null
    this._timer = null
    this._disposed = false
  }

  async onInit() {
    fs.mkdirSync(this._dataDir, { recursive: true })

    this._config = this._loadConfig()
    this._state = readJson(this._stateFile, {}) || {}
    this._state.sentGameIds = Array.isArray(this._state.sentGameIds) ? this._state.sentGameIds : []
    // 历史回溯是否已走到底；未走到底之前不能因为「整页都上报过」就收敛
    this._state.backfillDone = this._state.backfillDone === true

    if (!this._config.endpoint || !this._config.token) {
      // 没配置地址或令牌时不轮询，避免无意义地反复拉 LCU
      this._writeLog('未配置 endpoint / token，同步已停用，请填写配置文件后重启 League Akari')
      return
    }

    this._schedule(this._config.initialDelaySeconds * 1000)
  }

  _loadConfig() {
    // 配置文件放在 shard 同级，方便直接手改；离线自测可用 MATCH_SYNC_CONFIG 指定
    const file = process.env.MATCH_SYNC_CONFIG || path.join(__dirname, 'match-sync.config.json')

    if (!fs.existsSync(file)) {
      // 首次运行落一份模板，用户不需要去翻文档就知道要填哪些项
      try {
        fs.writeFileSync(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf-8')
      } catch (error) {
        this._writeLog(`写入配置模板失败: ${error.message}`)
      }
    }

    const config = { ...DEFAULT_CONFIG, ...(readJson(file, {}) || {}) }

    return {
      endpoint: String(config.endpoint || ''),
      token: String(config.token || ''),
      // 间隔下限 30 秒，防止手误写 0 变成死循环请求
      intervalSeconds: Math.max(30, toInt(config.intervalSeconds, DEFAULT_CONFIG.intervalSeconds)),
      initialDelaySeconds: Math.max(
        0,
        toInt(config.initialDelaySeconds, DEFAULT_CONFIG.initialDelaySeconds)
      )
    }
  }

  _schedule(delayMs) {
    this._timer = setTimeout(() => {
      void this._tick()
    }, delayMs)
  }

  /** 上一轮结束后再排下一轮，天然避免轮询重叠 */
  async _tick() {
    try {
      await this._syncOnce()
    } catch (error) {
      this._recordError(error)
    }

    if (!this._disposed) {
      this._schedule(this._config.intervalSeconds * 1000)
    }
  }

  async _syncOnce() {
    const puuid = await this._resolvePuuid()

    this._state.lastPollAt = new Date().toISOString()

    // 拿不到 puuid 说明 LCU 还没连上（常见于只开着 League Akari 没开游戏客户端），静默跳过
    if (!puuid) {
      this._saveState()
      return
    }

    // 采集阶段会把 backfillDone 翻成 true，所以先记下本轮属于哪种模式，
    // 供 _markSent 决定新增 gameId 插在列表头部还是尾部
    const backfilling = !this._state.backfillDone
    const gameIds = await this._collectNewGameIds(puuid)

    if (gameIds.length === 0) {
      this._state.lastError = null
      this._saveState()
      return
    }

    const matches = []

    for (const gameId of gameIds) {
      const response = await this._leagueClient.api.matchHistory.getGame(Number(gameId))
      const match = normalizeMatch(response.data)

      if (match) {
        matches.push(match)
      }
    }

    if (matches.length === 0) {
      // 详情拉不到的对局不标记已上报，下一轮还会重试
      this._state.lastError = '新对局详情拉取失败，本轮没有可上报数据'
      this._saveState()
      return
    }

    let accepted = 0
    let ignored = 0

    for (let index = 0; index < matches.length; index += UPLOAD_BATCH_SIZE) {
      const batch = matches.slice(index, index + UPLOAD_BATCH_SIZE)
      const result = await this._upload(batch)

      accepted += toInt(result.accepted)
      ignored += toInt(result.ignored)
      this._markSent(
        batch.map((match) => match.gameId),
        backfilling
      )
    }

    this._state.lastUploadAt = new Date().toISOString()
    this._state.lastResult = { uploaded: matches.length, accepted, ignored }
    this._state.lastError = null
    this._saveState()
    this._writeLog(`上报 ${matches.length} 局，服务端新入库 ${accepted} 局，未达门槛 ${ignored} 局`)
  }

  async _resolvePuuid() {
    const me =
      this._leagueClient.data && this._leagueClient.data.summoner
        ? this._leagueClient.data.summoner.me
        : null

    if (me && me.puuid) {
      return me.puuid
    }

    try {
      const response = await this._leagueClient.api.summoner.getCurrentSummoner()

      return response.data && response.data.puuid ? response.data.puuid : null
    } catch (error) {
      return null
    }
  }

  /**
   * 按页扫描对局列表，收集本地还没上报过的 gameId（新在前）。
   *
   * 两种模式：
   * - 回溯（backfillDone 为 false）：一直往外翻页直到「到底」或翻满 MAX_PAGES，
   *   每轮最多取 MAX_MATCHES_PER_SYNC 局，所以历史是逐轮补齐的（每轮 100 局）。
   *   这一阶段不能因为「整页都上报过」就停 —— 那正是回溯进行到一半的样子，
   *   一停就永远只看得见最新一页。
   * - 增量（backfillDone 为 true）：平日只需看最新一页，整页没有新对局就收敛。
   */
  async _collectNewGameIds(puuid) {
    const sent = new Set(this._state.sentGameIds)
    const found = []
    const visited = new Set()
    const backfilling = !this._state.backfillDone

    for (let page = 0; page < MAX_PAGES && found.length < MAX_MATCHES_PER_SYNC; page++) {
      const begin = page * PAGE_SIZE
      const response = await this._leagueClient.api.matchHistory.getMatchHistory(
        puuid,
        begin,
        begin + PAGE_SIZE - 1
      )
      const games =
        response.data && response.data.games && Array.isArray(response.data.games.games)
          ? response.data.games.games
          : []

      if (games.length === 0) {
        // 历史到底了，之后只需增量
        this._state.backfillDone = true

        break
      }

      let fresh = 0

      for (const game of games) {
        const gameId = String(game.gameId)

        if (visited.has(gameId)) {
          continue
        }

        visited.add(gameId)

        if (!sent.has(gameId)) {
          found.push(gameId)
          fresh += 1
        }
      }

      if (fresh === 0 && !backfilling) {
        break
      }

      // 翻到最后一页说明已经走到底（LRU 里就是这么多），后续按增量处理
      if (page + 1 === MAX_PAGES) {
        this._state.backfillDone = true
      }
    }

    return found.slice(0, MAX_MATCHES_PER_SYNC)
  }

  async _upload(matches) {
    const response = await fetch(this._config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._config.token}`
      },
      body: JSON.stringify({
        clientId: `akari-${os.hostname()}`,
        clientVersion: '1.0.0',
        matches
      }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })

    if (!response.ok) {
      throw new Error(`上报失败 HTTP ${response.status} ${await response.text()}`)
    }

    return response.json()
  }

  _markSent(gameIds, backfilling) {
    // 列表按「新在前」维护，裁剪时丢最老的：
    // 回溯阶段拿到的是更老的对局，追加到尾部；增量阶段拿到的是最新对局，放头部。
    const merged = backfilling
      ? [...this._state.sentGameIds, ...gameIds]
      : [...gameIds, ...this._state.sentGameIds]

    this._state.sentGameIds = [...new Set(merged)].slice(0, SENT_GAME_ID_LIMIT)
  }

  _recordError(error) {
    this._state = this._state || {}
    this._state.lastError = error && error.message ? error.message : String(error)
    this._saveState()
    this._writeLog(`同步异常: ${this._state.lastError}`)
  }

  _saveState() {
    try {
      fs.writeFileSync(this._stateFile, `${JSON.stringify(this._state, null, 2)}\n`, 'utf-8')
    } catch (error) {
      // 状态写失败不能影响游戏客户端连接，只记录
      console.error('[match-sync] 写入 state 失败', error)
    }
  }

  /** 打包后的应用看不到 stdout，日志必须落文件才能排查问题 */
  _writeLog(message) {
    const now = new Date()

    try {
      fs.appendFileSync(
        path.join(this._dataDir, `sync-${now.toISOString().slice(0, 10)}.log`),
        `[${now.toISOString()}] ${message}\n`,
        'utf-8'
      )
    } catch (error) {
      console.error('[match-sync] 写入日志失败', error)
    }

    console.log(`[match-sync] ${message}`)
  }

  async onDispose() {
    this._disposed = true

    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }
}

/**
 * 把 LCU 对局详情映射成后端约定的结构。
 * 兼容两种返回格式：老格式玩家信息在 participantIdentities 里，
 * 新格式直接内嵌在 participants 上。
 */
function normalizeMatch(game) {
  if (!game || !Array.isArray(game.participants)) {
    return null
  }

  const playerByParticipantId = new Map()

  for (const identity of Array.isArray(game.participantIdentities)
    ? game.participantIdentities
    : []) {
    playerByParticipantId.set(identity.participantId, identity.player || {})
  }

  const participants = []

  for (const participant of game.participants) {
    const player = playerByParticipantId.get(participant.participantId) || participant
    const puuid = player.puuid

    // puuid 是对局参与者的唯一标识，也是和车队成员关联的依据，缺失则丢弃该玩家
    if (!puuid) {
      continue
    }

    const stats = participant.stats || {}

    participants.push({
      puuid,
      gameName: player.gameName || '',
      tagLine: player.tagLine || '',
      teamId: toInt(participant.teamId),
      // LCU 只给 lane（TOP/JUNGLE/MIDDLE/BOTTOM），没有细分到辅助位
      position: (participant.timeline && participant.timeline.lane) || '',
      championId: toInt(participant.championId),
      win: stats.win === true,
      kills: toInt(stats.kills),
      deaths: toInt(stats.deaths),
      assists: toInt(stats.assists),
      totalDamageDealtToChampions: toInt(stats.totalDamageDealtToChampions),
      totalMinionsKilled: toInt(stats.totalMinionsKilled),
      goldEarned: toInt(stats.goldEarned),
      visionScore: toInt(stats.visionScore),
      items: [
        toInt(stats.item0),
        toInt(stats.item1),
        toInt(stats.item2),
        toInt(stats.item3),
        toInt(stats.item4),
        toInt(stats.item5),
        toInt(stats.item6)
      ],
      summonerSpell1: toInt(participant.spell1Id),
      summonerSpell2: toInt(participant.spell2Id)
    })
  }

  if (participants.length === 0) {
    return null
  }

  return {
    gameId: String(game.gameId),
    queueId: toInt(game.queueId),
    gameMode: game.gameMode || '',
    gameCreation: toInt(game.gameCreation),
    gameDuration: toInt(game.gameDuration),
    gameVersion: game.gameVersion || '',
    participants
  }
}

module.exports = MatchSyncShard
