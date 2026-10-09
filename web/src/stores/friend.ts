import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface BlacklistItem {
  gid: number
  name: string
  avatarUrl: string
}

export interface KnownFriendSettings {
  knownFriendGids: number[]
  knownFriendGidSyncCooldownSec: number
  friendsListCacheTtlSec: number
}

/** 背包中可用于好友农场/土地的特殊互动道具。 */
export interface FriendInteractionItemDto {
  id: string
  itemId: string
  name: string
  image: string
  count: number
  saleConditionSatisfiedCount: number
  interactionType: string
  protocol: string
  selfUsable: boolean
  targetKind: 'land' | 'farm'
  description: string
  activityId: string
  sellCondition: string
  nearestExpireTime: number
  serverValidationRequired: boolean
}

/** 单块地使用道具的结果。 */
export interface FriendInteractionResultDto {
  landId: string
  ok: boolean
  code: string
  message: string
  target?: any
  updatedLand?: any
  interactionEffects?: any[]
  consumed?: any[]
  rewards?: any[]
}

/** 一次批量使用的汇总结果。 */
export interface FriendInteractionBatchDto {
  hostGid: string
  ownerName: string
  itemId: string
  itemName: string
  protocol: string
  requestedLandIds: string[]
  usedLandIds: string[]
  failedLandIds: string[]
  successCount: number
  failureCount: number
  results: FriendInteractionResultDto[]
  updatedLands: any[]
  interactionEffects: any[]
  items: FriendInteractionItemDto[]
  message: string
  targetKind?: string
  isSelf?: boolean
}

export const useFriendStore = defineStore('friend', () => {
  const friends = ref<any[]>([])
  const loading = ref(false)
  const dogInfoLoading = ref(false)
  const friendLands = ref<Record<string, any[]>>({})
  const friendLandsLoading = ref<Record<string, boolean>>({})
  const blacklist = ref<BlacklistItem[]>([])
  const interactRecords = ref<any[]>([])
  const interactLoading = ref(false)
  const interactError = ref('')

  const knownFriendGids = ref<number[]>([])
  const knownFriendGidSyncCooldownSec = ref(600)
  const friendsListCacheTtlSec = ref(60)
  const knownFriendSettingsLoading = ref(false)
  const knownFriendSettingsSaving = ref(false)

  const interactionItems = ref<FriendInteractionItemDto[]>([])
  const interactionItemsLoading = ref(false)
  const interactionItemsError = ref('')
  const interactionUsePending = ref(false)
  const interactionUseError = ref('')

  function clearFriendData() {
    friends.value = []
    friendLands.value = {}
    friendLandsLoading.value = {}
    blacklist.value = []
    interactRecords.value = []
    interactError.value = ''
    knownFriendGids.value = []
    knownFriendGidSyncCooldownSec.value = 600
    friendsListCacheTtlSec.value = 60
    interactionItems.value = []
    interactionItemsError.value = ''
    interactionUseError.value = ''
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  function buildPlantSummaryFromDetail(lands: any[], summary: any) {
    let stealNum = 0
    let dryNum = 0
    let weedNum = 0
    let insectNum = 0

    const detailLands = Array.isArray(lands) ? lands : []
    if (detailLands.length > 0) {
      for (const land of detailLands) {
        if (!land || !land.unlocked)
          continue
        if (land.status === 'stealable')
          stealNum++
        if (land.needWater)
          dryNum++
        if (land.needWeed)
          weedNum++
        if (land.needBug)
          insectNum++
      }
    }
    else {
      stealNum = Array.isArray(summary?.stealable) ? summary.stealable.length : 0
      dryNum = Array.isArray(summary?.needWater) ? summary.needWater.length : 0
      weedNum = Array.isArray(summary?.needWeed) ? summary.needWeed.length : 0
      insectNum = Array.isArray(summary?.needBug) ? summary.needBug.length : 0
    }

    return {
      stealNum: Number(stealNum) || 0,
      dryNum: Number(dryNum) || 0,
      weedNum: Number(weedNum) || 0,
      insectNum: Number(insectNum) || 0,
    }
  }

  function syncFriendPlantSummary(friendId: string, lands: any[], summary: any) {
    const key = String(friendId)
    const idx = friends.value.findIndex(f => String(f?.gid || '') === key)
    if (idx < 0)
      return

    const nextPlant = buildPlantSummaryFromDetail(lands, summary)
    friends.value[idx] = {
      ...friends.value[idx],
      plant: nextPlant,
    }
  }

  async function fetchFriends(accountId: string, forceSync = false) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    loading.value = true
    try {
      const res = await api.get('/api/friends', {
        headers: { 'x-account-id': accountId },
        params: forceSync ? { forceSync: 'true' } : {},
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        friends.value = res.data.data || []
      }
    }
    finally {
      loading.value = false
    }
  }

  async function fetchFriendsDogInfo(accountId: string) {
    if (!accountId)
      return { ok: false, error: '账号ID无效' }
    const requestedId = String(accountId)
    dogInfoLoading.value = true
    try {
      const res = await api.post('/api/friends/fetch-dog-info', {}, {
        headers: { 'x-account-id': accountId },
        timeout: 600000,
      })
      if (res.data.ok && Array.isArray(res.data.friends) && isCurrentAccount(requestedId)) {
        friends.value = res.data.friends
      }
      return {
        ok: !!res.data.ok,
        failCount: res.data.failCount || 0,
        blacklistCount: res.data.blacklistCount || 0,
        guardDogCount: res.data.guardDogCount || 0,
        error: res.data.error || '',
      }
    }
    catch (e: any) {
      return {
        ok: false,
        error: e?.response?.data?.error || e?.message || '获取狗信息失败',
      }
    }
    finally {
      dogInfoLoading.value = false
    }
  }

  async function fetchFriendDogInfo(accountId: string, gid: string | number) {
    if (!accountId || !gid)
      return null
    try {
      const res = await api.get(`/api/friend/${gid}/dog`, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok)
        return res.data.data
    }
    catch {
      // ignore
    }
    return null
  }
  async function fetchInteractRecords(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    interactLoading.value = true
    interactError.value = ''

    try {
      const res = await api.get('/api/interact-records', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        interactRecords.value = Array.isArray(res.data.data) ? res.data.data : []
      }
      else {
        interactError.value = res.data.error || '加载访客记录失败'
      }
    }
    catch (error: any) {
      interactError.value = error?.response?.data?.error || error?.message || '加载访客记录失败'
    }
    finally {
      interactLoading.value = false
    }
  }

  async function fetchBlacklist(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    try {
      const res = await api.get('/api/friend-blacklist', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        blacklist.value = res.data.data || []
      }
    }
    catch { /* ignore */ }
  }

  async function toggleBlacklist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    const res = await api.post('/api/friend-blacklist/toggle', { gid }, {
      headers: { 'x-account-id': accountId },
    })
    if (res.data.ok) {
      blacklist.value = res.data.data || []
    }
  }

  async function fetchFriendLands(accountId: string, friendId: string) {
    if (!accountId || !friendId)
      return
    const requestedId = String(accountId)
    friendLandsLoading.value[friendId] = true
    try {
      const res = await api.get(`/api/friend/${friendId}/lands`, {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        const lands = res.data.data.lands || []
        const summary = res.data.data.summary || null
        friendLands.value[friendId] = lands
        syncFriendPlantSummary(friendId, lands, summary)
      }
    }
    finally {
      friendLandsLoading.value[friendId] = false
    }
  }

  async function operate(accountId: string, friendId: string, opType: string) {
    if (!accountId || !friendId)
      return { ok: false, message: '参数无效' }
    try {
      const res = await api.post(`/api/friend/${friendId}/op`, { opType }, {
        headers: { 'x-account-id': accountId },
      })
      const result = res.data?.data || res.data || {}
      await fetchFriends(accountId)
      if (friendLands.value[friendId]) {
        await fetchFriendLands(accountId, friendId)
      }
      return result
    }
    catch (e: any) {
      return { ok: false, message: e?.response?.data?.error || e?.message || '操作失败' }
    }
  }

  function applyKnownFriendSettings(data: KnownFriendSettings | null | undefined) {
    if (!data)
      return
    knownFriendGids.value = Array.isArray(data.knownFriendGids) ? data.knownFriendGids : []
    knownFriendGidSyncCooldownSec.value = Number.isFinite(data.knownFriendGidSyncCooldownSec)
      ? Math.max(30, Math.min(86400, data.knownFriendGidSyncCooldownSec))
      : 600
    friendsListCacheTtlSec.value = Number.isFinite(data.friendsListCacheTtlSec)
      ? Math.max(10, Math.min(86400, data.friendsListCacheTtlSec))
      : 60
  }

  async function fetchKnownFriendSettings(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    knownFriendSettingsLoading.value = true
    try {
      const res = await api.get('/api/friend-known-gids', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsLoading.value = false
    }
  }

  async function saveKnownFriendSettings(accountId: string, payload: Partial<KnownFriendSettings>) {
    if (!accountId)
      return
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids', payload, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function removeKnownFriendGid(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/remove', { gid }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function batchAddKnownFriendGids(accountId: string, gids: number[]) {
    if (!accountId || !gids || gids.length === 0)
      return { ok: false, addedCount: 0 }
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/batch-add', { gids }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
      return { ok: res.data.ok, addedCount: res.data.addedCount || 0 }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function fetchFriendInteractionItems(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    interactionItemsLoading.value = true
    interactionItemsError.value = ''
    try {
      const res = await api.get('/api/friend-interaction-items', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        const payload = res.data.data || {}
        interactionItems.value = Array.isArray(payload.items) ? payload.items : []
      }
      else {
        interactionItemsError.value = res.data.error || '加载互动道具失败'
      }
    }
    catch (error: any) {
      if (isCurrentAccount(requestedId)) {
        interactionItemsError.value = error?.response?.data?.error || error?.message || '加载互动道具失败'
      }
    }
    finally {
      interactionItemsLoading.value = false
    }
  }

  async function useFriendInteractionItemBatch(
    accountId: string,
    gid: string | number,
    itemId: string | number,
    landIds: Array<string | number>,
  ) {
    if (!accountId || !gid || !itemId)
      return { ok: false, message: '参数无效' } as FriendInteractionBatchDto & { ok: boolean, message: string }
    interactionUsePending.value = true
    interactionUseError.value = ''
    try {
      const res = await api.post(`/api/friend/${gid}/interaction-items/use-batch`, { itemId, landIds }, {
        headers: { 'x-account-id': accountId },
        timeout: 300000,
      })
      const data = res.data?.data || {}
      if (Array.isArray(data.items)) {
        interactionItems.value = data.items
      }
      await fetchFriendLands(accountId, String(gid))
      return { ...data, ok: true } as FriendInteractionBatchDto & { ok: boolean }
    }
    catch (error: any) {
      const message = error?.response?.data?.error || error?.message || '使用互动道具失败'
      interactionUseError.value = message
      return { ok: false, message } as FriendInteractionBatchDto & { ok: boolean, message: string }
    }
    finally {
      interactionUsePending.value = false
    }
  }

  async function useFriendFarmInteractionItem(accountId: string, gid: string | number, itemId: string | number) {
    if (!accountId || !gid || !itemId)
      return { ok: false, message: '参数无效' } as FriendInteractionBatchDto & { ok: boolean, message: string }
    interactionUsePending.value = true
    interactionUseError.value = ''
    try {
      const res = await api.post(`/api/friend/${gid}/interaction-items/use-farm`, { itemId }, {
        headers: { 'x-account-id': accountId },
        timeout: 300000,
      })
      const data = res.data?.data || {}
      if (Array.isArray(data.items)) {
        interactionItems.value = data.items
      }
      return { ...data, ok: true } as FriendInteractionBatchDto & { ok: boolean }
    }
    catch (error: any) {
      const message = error?.response?.data?.error || error?.message || '使用互动道具失败'
      interactionUseError.value = message
      return { ok: false, message } as FriendInteractionBatchDto & { ok: boolean, message: string }
    }
    finally {
      interactionUsePending.value = false
    }
  }

  async function removeUnsyncedKnownFriendGids(accountId: string, gids: number[]) {
    if (!accountId || !gids || gids.length === 0)
      return { ok: false, removedCount: 0 }
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/batch-remove', { gids }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
      return { ok: res.data.ok, removedCount: res.data.removedCount || 0 }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  return {
    friends,
    loading,
    dogInfoLoading,
    friendLands,
    friendLandsLoading,
    blacklist,
    interactRecords,
    interactLoading,
    interactError,
    knownFriendGids,
    knownFriendGidSyncCooldownSec,
    friendsListCacheTtlSec,
    knownFriendSettingsLoading,
    knownFriendSettingsSaving,
    interactionItems,
    interactionItemsLoading,
    interactionItemsError,
    interactionUsePending,
    interactionUseError,
    clearFriendData,
    fetchFriends,
    fetchFriendsDogInfo,
    fetchFriendDogInfo,
    fetchBlacklist,
    toggleBlacklist,
    fetchInteractRecords,
    fetchFriendLands,
    operate,
    fetchKnownFriendSettings,
    saveKnownFriendSettings,
    removeKnownFriendGid,
    batchAddKnownFriendGids,
    removeUnsyncedKnownFriendGids,
    fetchFriendInteractionItems,
    useFriendInteractionItemBatch,
    useFriendFarmInteractionItem,
  }
})
