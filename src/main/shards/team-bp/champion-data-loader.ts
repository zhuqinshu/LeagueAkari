import type { ChampionOverviewItem } from '@shared/data-adapter/champion-data'
import {
  TEAM_BP_DATA_REGION,
  TEAM_BP_DATA_SOURCE,
  TEAM_BP_DATA_TIER,
  TEAM_BP_POSITIONS,
  type TeamBpPosition
} from '@shared/shards/team-bp'
import { formatError } from '@shared/utils/errors'

import type { TeamBpMainContext } from './context'

export class TeamBpChampionDataLoader {
  overviews: Record<TeamBpPosition, ChampionOverviewItem[]> = {
    top: [],
    jungle: [],
    middle: [],
    bottom: [],
    utility: []
  }

  private _abortController: AbortController | null = null
  private _generation = 0

  constructor(private readonly _context: TeamBpMainContext) {}

  async refresh() {
    const generation = ++this._generation
    this._abortController?.abort()
    this._abortController = new AbortController()
    const { signal } = this._abortController
    const { championData, logger, state } = this._context
    state.setDataLoading()

    try {
      const patchResult = await championData.loadPatches(
        {
          source: TEAM_BP_DATA_SOURCE,
          mode: 'ranked',
          region: TEAM_BP_DATA_REGION,
          tier: TEAM_BP_DATA_TIER
        },
        { signal }
      )
      if (patchResult.status === 'unavailable') {
        throw new Error(patchResult.attempts[0]?.message ?? patchResult.fallbackReason)
      }

      const patch = patchResult.data[0]
      const results = await Promise.all(
        TEAM_BP_POSITIONS.map(async (position) => {
          const result = await championData.loadOverview(
            {
              source: TEAM_BP_DATA_SOURCE,
              mode: 'ranked',
              region: TEAM_BP_DATA_REGION,
              tier: TEAM_BP_DATA_TIER,
              position,
              ...(patch ? { patch } : {})
            },
            { signal }
          )
          if (result.status === 'unavailable') {
            throw new Error(result.attempts[0]?.message ?? result.fallbackReason)
          }
          return [position, result.data] as const
        })
      )
      if (signal.aborted || generation !== this._generation) return

      this.overviews = Object.fromEntries(
        results.map(([position, overview]) => [position, overview.sections.champions])
      ) as Record<TeamBpPosition, ChampionOverviewItem[]>
      const metadata = results[0][1].metadata
      state.setDataReady({
        source: metadata.source,
        patch: metadata.patch,
        updatedAt: metadata.updatedAt,
        region: TEAM_BP_DATA_REGION,
        tier: TEAM_BP_DATA_TIER
      })
      logger.info(
        `Team BP champion data loaded (${metadata.source}, ${metadata.patch ?? 'latest'})`
      )
    } catch (error) {
      if (signal.aborted || generation !== this._generation) return
      const message = formatError(error)
      state.setDataFailed(message)
      logger.warn('Failed to load Team BP champion data', message)
    }
  }

  dispose() {
    this._abortController?.abort()
    this._abortController = null
  }
}
