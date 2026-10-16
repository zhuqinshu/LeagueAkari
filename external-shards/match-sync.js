/**
 * League Akari 外部 shard：对局同步
 *
 * 职责边界：
 * - 客户端只负责「把新对局如实送上去」：定时从 SGP 拉当前召唤师的对局列表，
 *   对没上报过的对局归一化、批量上报。
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

/**
 * 对局列表单页条数。SGP 列表每局都带完整参与者数据（约 200KB/局），
 * 一次要太多既拖慢这一轮，也会让响应体大到没必要
 */
const PAGE_SIZE = 20
/**
 * 最多回溯页数，即首次运行最多补多少历史（60 页 × 20 局 = 1200 局）。
 * 到底时上游会返回空页，所以这个值只是兜底上限；上游对 count 有更小上限时
 * 每页都是同一批对局，最多白跑一轮，之后靠 backfillDone 收敛。
 */
const MAX_PAGES = 60
/** 单次同步最多拉取多少局，避免长时间未开机后一次性压满上游 */
const MAX_MATCHES_PER_SYNC = 100
/**
 * 本地已上报 gameId 的保留数量，裁剪时丢最老的。
 * 必须大于 PAGE_SIZE * MAX_PAGES，否则回溯出来的历史会滚出窗口、
 * 被当成新对局反复重报。
 */
const SENT_GAME_ID_LIMIT = 4000
/** 服务端单次上报上限 50 局，这里与之对齐 */
const UPLOAD_BATCH_SIZE = 50
const UPLOAD_TIMEOUT_MS = 20000
/** 对局列表请求超时，比上报宽松：一页要拖回整批对局的完整数据 */
const LIST_TIMEOUT_MS = 30000
/**
 * 每轮最多补多少局详情。详情一局上百 KB，单轮限住用量，
 * 历史对局靠每轮补几局慢慢补齐，不必一次压满上游
 */
const MAX_DETAILS_PER_SYNC = 5
/**
 * 详情请求超时。一局详情报文约 1MB（两份 SGP 原文），家宽上行不稳时
 * 单次上报实测会超过 60s（服务端其实已经收完并入库，只是响应回不来），
 * 所以放宽到 180s；真超时也只影响这一局，由上层逐局兜底继续后面的对局
 */
const DETAIL_TIMEOUT_MS = 180000

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
    // Windows 记事本等编辑器存 UTF-8 会带 BOM，直接 JSON.parse 会抛错；
    // 而配置读失败会被兜成默认值（endpoint 为空 = 同步停用），表现是「什么都没发生」，很难查
    return JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return fallback
  }
}

class MatchSyncShard {
  static id = 'match-sync'

  static priority = 0

  // 对局列表来自 SGP；LCU 只用来取当前召唤师 puuid
  static dependencies = ['league-client-main', 'sgp-main']

  constructor(leagueClient, sgp) {
    this._leagueClient = leagueClient
    this._sgp = sgp
    this._dataDir = resolveDataDir()
    this._stateFile = path.join(this._dataDir, 'state.json')
    this._config = null
    this._state = null
    // 同级接口（待补详情、详情上报）的地址前缀，空串表示详情补拉停用
    this._syncBase = ''
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

    // 配置里只填一个上报地址，待补详情与详情上报按同一前缀推导出来 ——
    // 在 Windows 上多填几个地址只会多几个填错的机会
    if (/\/matches$/.test(this._config.endpoint)) {
      this._syncBase = this._config.endpoint.slice(0, -'/matches'.length)
    } else {
      this._syncBase = ''
      this._writeLog(
        `endpoint 需指向 .../api/v1/sync/matches，当前为 ${this._config.endpoint}，详情补拉已停用`
      )
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

    // 摘要与详情分两段跑，各自兜异常：详情补拉失败不该把已经成功的战绩入库标成异常，
    // 反过来详情也不该因为没有新对局就跳过（历史详情是逐轮补完的）
    try {
      await this._syncNewMatches(puuid, backfilling)
    } catch (error) {
      this._recordError(error)
    }

    try {
      await this._syncDetails()
    } catch (error) {
      this._recordError(error)
    }
  }

  async _syncNewMatches(puuid, backfilling) {
    // 列表直接取 SGP 的完整对局数据，不必再逐局调 LCU 拿详情：
    // 国服 LCU 的 match-history 接口会成段时间返回 500，走它会让采集阶段一起空转
    const games = await this._collectNewMatches(puuid)

    if (games.length === 0) {
      this._state.lastError = null
      this._saveState()
      return
    }

    const matches = []

    for (const game of games) {
      const match = normalizeSgpMatch(game)

      if (match) {
        matches.push(match)
      }
    }

    if (matches.length === 0) {
      // 归一化失败的对局不标记已上报，下一轮还会重试
      this._state.lastError = '新对局没有可用参与者，本轮没有可上报数据'
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

  /**
   * 补拉对局详情。
   *
   * 拉哪几局由服务端决定（已入库但还没有详情的对局，新的在前），客户端不自己记
   * 「哪几局还没上报详情」—— 重启、换机器、中途崩掉都不会漏局，历史也能自动补齐。
   */
  async _syncDetails() {
    if (!this._syncBase) {
      return
    }

    const gameIds = await this._fetchPendingDetailGameIds()

    if (gameIds.length === 0) {
      return
    }

    let stored = 0
    let unavailable = 0
    let failed = 0

    for (const gameId of gameIds) {
      let outcome

      try {
        outcome = await this._syncOneDetail(gameId)
      } catch (error) {
        // 单局异常只能影响这一局：异常抛出去会连带丢掉本轮剩下的对局，
        // 下一轮又从头开始，永远补不完。上报超时是最常见的一种（报文约 1MB）
        outcome = 'failed'
        this._writeLog(`对局 ${gameId} 详情处理异常，下一轮重试: ${error && error.message}`)
      }

      if (outcome === 'stored') {
        stored += 1
      } else if (outcome === 'unavailable') {
        unavailable += 1
      } else {
        failed += 1
      }
    }

    this._state.lastDetails = { stored, unavailable, failed }

    // 成功时不清 lastError：本轮摘要阶段的异常要留着，它由摘要阶段每轮自己重置
    if (failed > 0) {
      this._state.lastError = `有 ${failed} 局详情拉取失败，下一轮重试`
    }

    this._saveState()
    this._writeLog(`补详情 ${stored} 局，确认无详情 ${unavailable} 局，失败待重试 ${failed} 局`)
  }

  /** 单局详情，返回 stored（已上报）| unavailable（上游确认没有）| failed（下一轮重试） */
  async _syncOneDetail(gameId) {
    let summary
    let detail

    try {
      // SUMMARY 提供参与者面板（符文、装备、挑战）与队伍数据，DETAILS 提供每帧属性与事件，
      // 详情页六个 tab 要靠两份一起才渲染得出来
      const [summaryResponse, detailResponse] = await Promise.all([
        this._sgp.api.matchHistoryQuery.getGameSummaryByGameId(Number(gameId), {
          signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS)
        }),
        this._sgp.api.matchHistoryQuery.getGameDetailsByGameId(Number(gameId), {
          signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS)
        })
      ])

      summary = summaryResponse.data
      detail = detailResponse.data
    } catch (error) {
      // 404 表示上游已经没有这局详情（超出保留期），报给服务端记档后不再重试；
      // 其余错误（网络、令牌还没就绪）留给下一轮
      if (error && error.response && error.response.status === 404) {
        await this._uploadDetails([{ gameId }])

        return 'unavailable'
      }

      this._writeLog(`拉取对局 ${gameId} 详情失败，下一轮重试: ${error && error.message}`)

      return 'failed'
    }

    // 有响应但缺 json 主体等于拿不到，同样记档不再重试
    if (!summary || !summary.json || !detail || !detail.json) {
      await this._uploadDetails([{ gameId }])

      return 'unavailable'
    }

    // 详情一局一个请求：两份原文加起来上百 KB，攒批只会让一份坏数据带崩一整批
    await this._uploadDetails([{ gameId, summary, details: detail }])

    return 'stored'
  }

  async _fetchPendingDetailGameIds() {
    const response = await fetch(`${this._syncBase}/pending-details?limit=${MAX_DETAILS_PER_SYNC}`, {
      headers: { Authorization: `Bearer ${this._config.token}` },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })

    if (!response.ok) {
      throw new Error(`查询待补详情失败 HTTP ${response.status} ${await response.text()}`)
    }

    const body = await response.json()

    return Array.isArray(body.gameIds) ? body.gameIds.map((id) => String(id)) : []
  }

  async _uploadDetails(details) {
    const response = await fetch(`${this._syncBase}/details`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._config.token}`
      },
      body: JSON.stringify({
        clientId: `akari-${os.hostname()}`,
        clientVersion: '1.0.0',
        details
      }),
      signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS)
    })

    if (!response.ok) {
      throw new Error(`详情上报失败 HTTP ${response.status} ${await response.text()}`)
    }

    return response.json()
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
   * 按页扫描对局列表，收集本地还没上报过的对局（新在前）。
   *
   * 列表走 SGP 而不是 LCU：国服 LCU 的 match-history 接口会成段时间返回 500
   * （Missing configuration data），而同一时刻 SGP 是好的，走 LCU 会让整个采集
   * 阶段跟着一起空转；SGP 列表每局已带完整参与者数据，也不必再逐局拉详情。
   *
   * 两种模式：
   * - 回溯（backfillDone 为 false）：一直往外翻页直到「到底」或翻满 MAX_PAGES，
   *   每轮最多取 MAX_MATCHES_PER_SYNC 局，所以历史是逐轮补齐的。
   *   这一阶段不能因为「整页都上报过」就停 —— 那正是回溯进行到一半的样子，
   *   一停就永远只看得见最新一页。
   * - 增量（backfillDone 为 true）：平日只需看最新一页，整页没有新对局就收敛。
   */
  async _collectNewMatches(puuid) {
    const sent = new Set(this._state.sentGameIds)
    const found = []
    const visited = new Set()
    const backfilling = !this._state.backfillDone
    let startIndex = 0

    for (let page = 0; page < MAX_PAGES && found.length < MAX_MATCHES_PER_SYNC; page++) {
      const response = await this._sgp.api.matchHistoryQuery.getMatchHistorySummaryByPlayerPuuid(
        puuid,
        { startIndex, count: PAGE_SIZE, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }
      )
      const games = response.data && Array.isArray(response.data.games) ? response.data.games : []

      if (games.length === 0) {
        // 历史到底了，之后只需增量
        this._state.backfillDone = true

        break
      }

      // 上游对 count 可能有比 PAGE_SIZE 更小的上限，按实际收到的条数推进页码，
      // 否则被截断的那一段对局会被整段跳过
      startIndex += games.length

      let fresh = 0

      for (const game of games) {
        const json = game && game.json

        // 列表里偶尔会有只有 metadata、没有 json 主体的条目，拿不到数据就不当它是对局
        if (!json || json.gameId === undefined || json.gameId === null) {
          continue
        }

        const gameId = String(json.gameId)

        if (visited.has(gameId)) {
          continue
        }

        visited.add(gameId)

        if (!sent.has(gameId)) {
          found.push(json)
          fresh += 1
        }
      }

      if (fresh === 0 && !backfilling) {
        break
      }

      // 翻到最后一页说明已经走到底，后续按增量处理
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
 * 把 SGP 对局摘要映射成后端约定的结构。
 *
 * SGP 的参与者是扁平结构：十个人各自带全套统计，没有 LCU 那种
 * participants 与 participantIdentities 之间靠 participantId 关联的间接层。
 */
function normalizeSgpMatch(game) {
  if (!game || !Array.isArray(game.participants)) {
    return null
  }

  const participants = []

  for (const participant of game.participants) {
    const puuid = participant.puuid

    // puuid 是对局参与者的唯一标识，也是和车队成员关联的依据，缺失则丢弃该玩家
    if (!puuid) {
      continue
    }

    participants.push({
      puuid,
      gameName: participant.riotIdGameName || '',
      tagLine: participant.riotIdTagline || '',
      teamId: toInt(participant.teamId),
      // SGP 的 teamPosition 能区分出辅助（UTILITY），比 LCU 的 lane 更准；
      // 特殊模式两个字段都可能为空，留空由前端兜底
      position: participant.teamPosition || participant.individualPosition || '',
      championId: toInt(participant.championId),
      win: participant.win === true,
      kills: toInt(participant.kills),
      deaths: toInt(participant.deaths),
      assists: toInt(participant.assists),
      totalDamageDealtToChampions: toInt(participant.totalDamageDealtToChampions),
      totalMinionsKilled: toInt(participant.totalMinionsKilled),
      goldEarned: toInt(participant.goldEarned),
      visionScore: toInt(participant.visionScore),
      items: [
        toInt(participant.item0),
        toInt(participant.item1),
        toInt(participant.item2),
        toInt(participant.item3),
        toInt(participant.item4),
        toInt(participant.item5),
        toInt(participant.item6)
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
