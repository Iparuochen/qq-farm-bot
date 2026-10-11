/**
 * 雨落成诗活动：协议查询、天气瓶操作与稳定 DTO。
 *
 * 移植自上游 core/src/services/weather-activity.ts（TypeScript → CommonJS）。
 *
 * 与上游的差异（均因本仓库后端结构不同，已逐处标注）：
 *  1. 上游 `farm/land-analysis` → 本仓库 `farm-land-analyzer`
 *  2. 上游 `isFriendCheckRunning()` → 本仓库 `friend-orchestrator` 导出的
 *     `isCheckingFriendsRunning`
 *  3. 上游用 `GatewayError` 类判定业务错误码，本仓库没有该类，
 *     改用 `friend-api.parseRpcErrorCode(err)`（与互动道具移植时的处理一致）
 *  4. 上游 `enterFriendFarm(gid, 'low')` 双参，本仓库 `enterFriendFarm(gid)` 单参
 *  5. 天气配置字段号避让：本地 ActivityNode 的 105/117/118/108 已被
 *     draw_info / 旧 WeatherTaskInfo / WeatherResearchInfo / draw_result 占用，
 *     天气版分别改挂在 121/122/123，Operate 返回挂在 141/142/143/144
 *     （详见 activitypb.proto 末尾说明）
 */
const LongModule = require('long');
const { PlantPhase } = require('../config/config');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync, getUserState, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, toNum, sleep } = require('../utils/utils');
const { enterFriendFarm, leaveFriendFarm, parseRpcErrorCode } = require('./friend-api');
const { getFriendsList, getFriendsListCache } = require('./friend');
const { isCheckingFriendsRunning } = require('./friend-orchestrator');
const { buildLandMap, getCurrentPhase, getDisplayLandContext } = require('./farm-land-analyzer');
const { getBag, getBagItems } = require('./warehouse');

const WEATHER_GROUP_ID = '2026070300';
const WEATHER_SHOP_ACTIVITY_ID = '2026070301';
const WEATHER_MUTATION_ACTIVITY_ID = '2026070302';
const WEATHER_BOTTLE_ACTIVITY_ID = '2026070303';
const WEATHER_RESEARCH_ACTIVITY_ID = '2026070304';
const WEATHER_TASK_ACTIVITY_ID = '2026070305';
const EXCHANGE_SHOP_OPERATE_TYPE = 1;
const COLLECT_WEATHER_OPERATE_TYPE = 9;
const ADVANCE_RESEARCH_OPERATE_TYPE = 40;
const COLLECTOR_BOTTLE_ID = 5001;
const SUMMON_BOTTLE_ID = 5002;
const FROG_MISCHIEF_BOTTLE_ID = 5005;
const CLOUD_MISCHIEF_BOTTLE_ID = 5006;
const LIGHTNING_BADGE_ID = 1027;
const LIGHTNING_MUTANT_CONFIG_ID = 12;
const WEATHER_ITEM_IDS = [4002, 4003, 5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008];
const THUNDERSTORM_TYPE = 1;
// EnterReply.field 13.field 9 is scoped to the current thunderstorm instance.
// It is not a per-friend daily collection record and resets for a later storm.
const COLLECTED_THIS_CYCLE_MARKER = 4;
// A scan never refreshes a friend whose cache is still valid, so reopening the panel
// within this window costs no Enter/Leave pair at all.
const FRIEND_WEATHER_CACHE_TTL_SEC = 600;
// Friend list loading and friend weather scanning are separate endpoints, and the
// panel scans in batches so a single request never enters more farms than this.
const FRIEND_WEATHER_SCAN_BATCH_LIMIT = 5;
// Pause between two farm visits inside one batch. Enter/Leave pairs own a single low
// priority gateway slot, so pacing them keeps the shared connection responsive.
const FRIEND_WEATHER_SCAN_GAP_MS = 300;
// The automated friend routine enters friend farms too, so a scan yields to it and
// hands the friends it could not reach back to the panel for a later retry.
const FRIEND_TASK_WAIT_MAX_MS = 10000;
const FRIEND_TASK_POLL_MS = 250;
const COLLECT_DAILY_LIMIT = 10;
const MISCHIEF_DAILY_LIMIT = 100;
const MAX_SIGNED_INT64 = 9223372036854775807n;

class WeatherActivityBusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WeatherActivityBusinessError';
    this.code = code;
  }
}

function businessError(code, message) {
  return new WeatherActivityBusinessError(code, message);
}

function int64String(value) {
  if (value == null) return '0';
  if (LongModule.isLong(value)) return value.toString();
  const normalized = String(value).trim();
  return /^-?\d+$/.test(normalized) ? normalized : '0';
}

function positiveDecimal(value, code, fieldName) {
  let normalized = '';
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) normalized = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) normalized = String(value);
  if (!normalized || normalized.length > 19 || BigInt(normalized) > MAX_SIGNED_INT64) {
    throw businessError(code, `${fieldName} 必须是 int64 范围内的正十进制整数`);
  }
  return normalized;
}

function itemDto(item) {
  const rawId = (item && (item.item_id ?? item.itemId ?? item.id)) ?? null;
  const id = int64String(rawId);
  const numericId = Number(id) || 0;
  const metadata = numericId > 0 ? getItemById(numericId) : null;
  const fallbackName = numericId === LIGHTNING_BADGE_ID ? '雷电徽章' : `物品 ${id}`;
  return {
    id,
    count: int64String(item && item.count),
    name: String((metadata && metadata.name) || fallbackName),
    image: numericId > 0 ? getItemImageById(numericId) || '' : '',
    rarity: Number(metadata && metadata.rarity) || 0,
  };
}

function bytesToText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return Buffer.from(value).toString('utf8');
}

function plainText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
}

function activityRules(value) {
  const source = bytesToText(value).trim();
  if (!source) return { title: '活动说明', paragraphs: [] };
  try {
    const parsed = JSON.parse(source);
    const tips = parsed && typeof parsed === 'object' ? parsed.tips : null;
    const paragraphs = (tips && Array.isArray(tips.txt) ? tips.txt : [])
      .filter((entry) => typeof entry === 'string')
      .map(plainText)
      .filter(Boolean);
    return {
      title: plainText(tips && tips.title) || '活动说明',
      paragraphs,
    };
  } catch {
    return { title: '活动说明', paragraphs: [plainText(source)].filter(Boolean) };
  }
}

function activityDto(activity) {
  // 本仓库 ActivityInfo 的字段名为 id / title / start_time / end_time，
  // 上游为 activity_id / name / begin_time / end_time，这里两种都读。
  return {
    id: int64String(activity && (activity.activity_id ?? activity.id)),
    groupId: int64String(activity && (activity.group_id ?? activity.parent_id)),
    typeCode: int64String(activity && activity.type),
    name: String((activity && (activity.name ?? activity.title)) || ''),
    startTime: int64String(activity && (activity.begin_time ?? activity.start_time)),
    endTime: int64String(activity && activity.end_time),
  };
}

/** 取活动节点的 ID，兼容本仓库 ActivityInfo.id 与上游 activity_id */
function activityNodeId(node) {
  const activity = node && node.activity;
  if (!activity) return '0';
  return int64String(activity.activity_id ?? activity.id);
}

function activityIsActive(activity, serverTime = getServerTimeSec()) {
  const startTime = toNum(activity && (activity.begin_time ?? activity.start_time));
  const endTime = toNum(activity && activity.end_time);
  return (!startTime || serverTime >= startTime) && (!endTime || serverTime <= endTime);
}

function weatherStatusDto(weather, hostGid = 0) {
  const type = toNum(weather && weather.weather_type);
  const status = toNum(weather && weather.status);
  const beginTime = toNum(weather && weather.begin_time);
  const endTime = toNum(weather && weather.end_time);
  const now = getServerTimeSec();
  const active = type > 0 && status > 0 && (!endTime || endTime > now);
  return {
    hostGid: int64String(hostGid),
    type,
    status,
    beginTime,
    endTime,
    source: toNum(weather && weather.source),
    field8: toNum(weather && weather.field_8),
    friendMarker: toNum(weather && weather.field_9),
    active,
    isThunderstorm: active && type === THUNDERSTORM_TYPE,
    collectedThisCycle: toNum(weather && weather.field_9) === COLLECTED_THIS_CYCLE_MARKER,
    remainingSec: active && endTime > 0 ? Math.max(0, endTime - now) : 0,
  };
}

/** 在活动树中递归查找指定活动 ID 的子节点（与 services/activity.js 的查找方式一致） */
function findChild(groupReply, activityId) {
  const children = Array.isArray(groupReply && groupReply.group && groupReply.group.children)
    ? groupReply.group.children
    : [];
  const stack = [...children];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) continue;
    if (activityNodeId(node) === activityId) return node;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return null;
}

function bagBalances(bagReply) {
  const balances = new Map();
  for (const item of getBagItems(bagReply)) {
    const id = int64String(item && (item.id ?? item.item_id));
    if (!/^\d+$/.test(id) || id === '0') continue;
    const countText = int64String(item && item.count);
    if (!/^-?\d+$/.test(countText)) continue;
    balances.set(id, (balances.get(id) || 0n) + BigInt(countText));
  }
  return new Map(Array.from(balances, ([id, count]) => [id, count.toString()]));
}

function inventoryDto(balances) {
  return [...WEATHER_ITEM_IDS, LIGHTNING_BADGE_ID]
    .map((id) => itemDto({ id, count: balances.get(String(id)) || '0' }));
}

/** 把归一化层的 item 结构（itemId/itemCount/itemName/image）转成上游的 item DTO */
function itemDtoFromNormalized(source) {
  if (!source) return itemDto(null);
  const id = toNum(source.itemId) || 0;
  return {
    id: id > 0 ? String(id) : '0',
    count: String(toNum(source.count ?? source.itemCount) || 0),
    name: String(source.itemName || (id > 0 ? getItemById(id)?.name : '') || `物品 ${id}`),
    image: String(source.image || (id > 0 ? getItemImageById(id) : '') || ''),
    rarity: id > 0 ? Number(getItemById(id)?.rarity) || 0 : 0,
  };
}

function shopDto(child, normalized, balances, active) {
  // 上游从 child.catalog.goods 取商品，本仓库从 child.exchange_shop.items 取，
  // 且 type=3 天气商店的数据可能直接挂在 ActivityNode.activity.exchange_shop 上。
  // 三种位置都兼容；仍取不到时回退到 normalizeRainPoemActivity 的归一化结果。
  const goods = [
    ...(Array.isArray(child && child.catalog && child.catalog.goods) ? child.catalog.goods : []),
    ...(Array.isArray(child && child.exchange_shop && child.exchange_shop.items) ? child.exchange_shop.items : []),
    ...(Array.isArray(child && child.activity && child.activity.exchange_shop && child.activity.exchange_shop.items)
      ? child.activity.exchange_shop.items
      : []),
  ];
  // 本仓库字段名为 id（上游为 goods_id），同为字段 1。
  const entry = goods.find((goodsEntry) => int64String(goodsEntry && (goodsEntry.goods_id ?? goodsEntry.id)) === '200')
    || goods[0]
    || null;

  if (!entry) {
    // 回退：使用本仓库归一化结果（/api/activity/rain-poem 已实测可取到该商店）。
    const fallbackShop = normalized && normalized.shop;
    if (!fallbackShop || !fallbackShop.item) return null;
    const item = itemDtoFromNormalized(fallbackShop.item);
    const cost = itemDtoFromNormalized(fallbackShop.cost);
    const balance = balances.get(cost.id) || '0';
    const owned = !!fallbackShop.owned;
    return {
      activityId: WEATHER_SHOP_ACTIVITY_ID,
      goodsId: String(toNum(fallbackShop.slotId) || 200),
      item,
      cost,
      balance,
      owned,
      statusCode: String(toNum(fallbackShop.status) || 0),
      dailyLimit: 1,
      available: active && !owned && BigInt(balance) >= BigInt(cost.count || '0'),
      reason: !active
        ? '活动尚未开放或已经结束'
        : owned
          ? '今日已经兑换过天气采集瓶'
          : BigInt(balance) < BigInt(cost.count || '0')
            ? '金豆豆不足'
            : '',
    };
  }

  const item = itemDto(entry.item);
  const cost = itemDto(entry.cost);
  const balance = balances.get(cost.id) || '0';
  const owned = !!entry.owned;
  const available = active && !owned && int64String(entry.status) !== '0' && BigInt(balance) >= BigInt(cost.count || '0');
  return {
    activityId: WEATHER_SHOP_ACTIVITY_ID,
    goodsId: int64String(entry.goods_id ?? entry.id),
    item,
    cost,
    balance,
    owned,
    statusCode: int64String(entry.status),
    dailyLimit: 1,
    available,
    reason: !active
      ? '活动尚未开放或已经结束'
      : owned
        ? '今日已经兑换过天气采集瓶'
        : BigInt(balance) < BigInt(cost.count || '0')
          ? '金豆豆不足'
          : '',
  };
}

/** 读取活动节点上的配置体，兼容直接挂在节点或挂在 node.activity 上的两种位置 */
function nodeConfig(node, key) {
  if (!node) return null;
  return node[key] || (node.activity && node.activity[key]) || null;
}

function collectorConfigDto(child, normalized) {
  const config = nodeConfig(child, 'weather_bottle');
  if (!config) {
    // 回退：活动已结束时服务端不再下发原始配置，用归一化层的采集瓶信息兜底。
    const collection = normalized && normalized.collection;
    if (!collection || !collection.item) return null;
    return {
      activityId: WEATHER_BOTTLE_ACTIVITY_ID,
      collectorItemId: String(toNum(collection.item.itemId) || COLLECTOR_BOTTLE_ID),
      collectorItemCount: String(toNum(collection.item.itemCount ?? collection.item.count) || 0),
      field3: '0',
      field4: '0',
      field9: '0',
      rewards: [],
    };
  }
  return {
    activityId: WEATHER_BOTTLE_ACTIVITY_ID,
    collectorItemId: int64String(config.collector_item_id),
    collectorItemCount: int64String(config.collector_item_count),
    field3: int64String(config.field_3),
    field4: int64String(config.field_4),
    field9: int64String(config.field_9),
    rewards: (Array.isArray(config.rewards) ? config.rewards : []).map((reward) => ({
      id: int64String(reward.reward_id),
      reward: itemDto(reward.reward),
      statusCode: int64String(reward.status),
      probability: String(reward.probability || ''),
    })),
  };
}

function tasksDto(child, normalized) {
  const tasks = nodeConfig(child, 'weather_tasks_v2') || nodeConfig(child, 'weather_tasks');
  const raw = Array.isArray(tasks && tasks.tasks) ? tasks.tasks : null;
  if (!raw) {
    // 回退：使用归一化层的任务列表（本仓库已把 id/item_id、desc/target 统一过）。
    const fallback = (normalized && normalized.tasks) || [];
    return fallback.map((task) => ({
      id: int64String(task.id),
      triggerItemId: int64String(task.itemId),
      title: String(task.desc || ''),
      reward: itemDto(task.reward),
      dailyLimit: int64String(task.target),
      current: int64String(task.progress),
      progressKnown: true,
    }));
  }
  return raw.map((task) => ({
    id: int64String(task.task_id ?? task.id),
    triggerItemId: int64String(task.trigger_item_id ?? task.item_id),
    title: String(task.title || task.desc || ''),
    reward: itemDto(task.reward),
    dailyLimit: int64String(task.daily_limit ?? task.target),
    current: int64String(task.current ?? task.progress),
    progressKnown: true,
  }));
}

function researchDto(child, normalized, balances) {
  // 上游为 weather_research.track.nodes；本仓库既有结构为 weather_research.progress.stages。
  // 两种都读，优先上游结构。
  const container = nodeConfig(child, 'weather_research_v2') || nodeConfig(child, 'weather_research');
  const track = container && (container.track || container.progress || null);
  const badgeBalance = balances.get(String(LIGHTNING_BADGE_ID)) || '0';

  let rawNodes = track ? (Array.isArray(track.nodes) ? track.nodes : (Array.isArray(track.stages) ? track.stages : [])) : null;
  let currentStage = track ? int64String(track.current_stage) : '';

  if (!rawNodes) {
    // 回退：使用归一化层的研究进度（本仓库为 research.stages）。
    const fallback = (normalized && normalized.research) || {};
    const stages = Array.isArray(fallback.stages) ? fallback.stages : [];
    if (stages.length === 0 && !normalized) return null;
    currentStage = int64String(fallback.currentStage);
    rawNodes = stages;
  }
  if (!rawNodes) return null;

  const nodes = rawNodes.map((node) => {
    const cost = itemDto(node.cost);
    const statusCode = int64String(node.status);
    const availableByStatus = statusCode === '2';
    const completed = statusCode === '4' || !!node.claimed;
    return {
      id: int64String(node.node_id ?? node.id),
      prerequisiteNodeIds: (Array.isArray(node.prerequisite_node_ids) ? node.prerequisite_node_ids : []).map(int64String),
      statusCode,
      cost,
      reward: itemDto(node.reward),
      field5: int64String(node.field_5),
      field8: int64String(node.field_8),
      field9: int64String(node.field_9),
      availableByStatus,
      completed,
      locked: !completed && !availableByStatus,
      affordable: cost.id === String(LIGHTNING_BADGE_ID) && BigInt(badgeBalance) >= BigInt(cost.count || '0'),
    };
  });
  return {
    activityId: WEATHER_RESEARCH_ACTIVITY_ID,
    currentStage,
    badgeBalance,
    nodes,
    nextNode: nodes.find((node) => node.availableByStatus) || null,
    operateSupported: true,
    operateReason: '',
  };
}

// 本仓库 GetGroup 需要同时带 id 与 uid（上游只传 group_id）。
// uid 由本仓库 services/activity.js 先行验证可用（'WeatherBottleUI'），
// 保留第二个候选以防服务端改名。
const WEATHER_GROUP_UID = 'WeatherBottleUI';
const WEATHER_GROUP_UID_FALLBACK = 'WeatherBottle';

// 已确认可用的 uid，进程内缓存，避免每次快照都重试一遍错误候选。
let resolvedGroupUid = null;

/**
 * 读取雨落成诗活动组。
 *
 * 复用本仓库 services/activity.js 的 getActivityGroup —— 它已经处理好
 * 「id + uid 才能取到活动」以及本仓库 ActivityInfo 的实际字段命名
 * （id/title/start_time），实测可稳定返回 2026070300 活动组。
 * 相比在本文件里重写一遍 GetGroup 编码，这样改动面更小、行为与既有
 * /api/activity/rain-poem 接口完全一致，不会出现两套逻辑读出不同数据。
 */
async function queryWeatherGroup() {
  // 延迟引用：services/activity.js 依赖面较广，放在模块顶层可能引入不必要的耦合。
  const { getActivityGroup } = require('./activity');

  const candidates = resolvedGroupUid
    ? [resolvedGroupUid, WEATHER_GROUP_UID, WEATHER_GROUP_UID_FALLBACK]
      .filter((uid, index, list) => list.indexOf(uid) === index)
    : [WEATHER_GROUP_UID, WEATHER_GROUP_UID_FALLBACK];

  let lastReply = null;
  for (const uid of candidates) {
    let reply = null;
    try {
      reply = await getActivityGroup(WEATHER_GROUP_ID, uid);
    } catch (error) {
      continue;
    }
    if (!reply || !reply.group) continue;
    lastReply = reply;
    // 活动已下线时服务端可能不再下发 children，因此只要能解出活动根节点即视为命中。
    if (findChild(reply, WEATHER_SHOP_ACTIVITY_ID) || activityNodeId(reply.group) === WEATHER_GROUP_ID) {
      resolvedGroupUid = uid;
      return reply;
    }
  }
  // 没有子活动但根节点在（活动已结束时的正常形态），也直接返回，让上层按空数据渲染。
  if (lastReply) return lastReply;
  throw businessError('WEATHER_ACTIVITY_UNAVAILABLE', '服务端未发现雨落成诗活动');
}

async function getWeatherStatus() {
  const body = Buffer.from(types.GetWeatherStatusRequest.encode(types.GetWeatherStatusRequest.create({})).finish());
  const { body: replyBody } = await sendMsgAsync('gamepb.weatherpb.WeatherService', 'GetWeatherStatus', body);
  return types.GetWeatherStatusReply.decode(replyBody);
}

const friendWeatherCache = new Map();
const friendWeatherInspections = new Map();

function friendGid(friend) {
  return int64String(friend && (friend.gid ?? (friend.basic && friend.basic.gid)));
}

function cloudEligibleLandIds(lands) {
  const source = Array.isArray(lands) ? lands : [];
  const landMap = buildLandMap(source);
  const result = [];
  const seen = new Set();
  for (const land of source) {
    if (!(land && land.unlocked)) continue;
    const context = getDisplayLandContext(land, landMap);
    if (context.occupiedByMaster) continue;
    const targetLand = context.sourceLand || land;
    const landId = int64String(targetLand && targetLand.id);
    if (landId === '0' || seen.has(landId)) continue;
    const plant = targetLand && targetLand.plant;
    if (!plant || toNum(plant.id) <= 0 || !Array.isArray(plant.phases) || plant.phases.length === 0) continue;
    const phase = toNum((getCurrentPhase(plant.phases, false, '', toNum(plant.id)) || {}).phase);
    if (phase <= PlantPhase.SEED || phase >= PlantPhase.MATURE) continue;
    const interactions = [
      ...(Array.isArray(plant.interaction_uses) ? plant.interaction_uses : []),
      ...(Array.isArray(plant.interaction_targets) ? plant.interaction_targets : []),
    ];
    if (interactions.some((entry) => toNum(entry && entry.item_id) === CLOUD_MISCHIEF_BOTTLE_ID)) continue;
    seen.add(landId);
    result.push(landId);
  }
  return result;
}

async function waitForFriendTaskIdle(maxWaitMs = FRIEND_TASK_WAIT_MAX_MS) {
  if (!isCheckingFriendsRunning()) return true;
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  while (isCheckingFriendsRunning()) {
    if (Date.now() >= deadline) return false;
    await sleep(FRIEND_TASK_POLL_MS);
  }
  return true;
}

// Every friend farm visit decodes the same Enter reply, so one builder keeps the cached
// shape identical no matter which flow entered the farm.
function friendInspectionFromEnterReply(gid, reply) {
  return {
    gid,
    basic: (reply && reply.basic) || null,
    rawWeather: (reply && reply.weather) || null,
    lands: Array.isArray(reply && reply.lands) ? reply.lands : [],
    inspectedAt: getServerTimeSec(),
    error: '',
  };
}

function freshFriendWeather(gid) {
  const cached = friendWeatherCache.get(gid);
  return cached && getServerTimeSec() - cached.inspectedAt <= FRIEND_WEATHER_CACHE_TTL_SEC ? cached : null;
}

async function performFriendFarmWeatherInspection(gid, cached) {
  let entered = false;
  try {
    // 本仓库 enterFriendFarm 只接受 gid 单参。
    const reply = await enterFriendFarm(Number(gid));
    entered = true;
    const inspection = friendInspectionFromEnterReply(gid, reply);
    friendWeatherCache.set(gid, inspection);
    return inspection;
  } catch (error) {
    const message = String((error && error.message) || error || '现场天气检查失败');
    if (cached) return { ...cached, error: message };
    const inspection = {
      gid,
      basic: null,
      rawWeather: null,
      lands: [],
      inspectedAt: getServerTimeSec(),
      error: message,
    };
    friendWeatherCache.set(gid, inspection);
    return inspection;
  } finally {
    if (entered) await leaveFriendFarm(Number(gid));
  }
}

async function inspectFriendFarmWeather(friend, force = false) {
  const gid = friendGid(friend);
  if (gid === '0') return null;
  if (!force) {
    const fresh = freshFriendWeather(gid);
    if (fresh) return fresh;
    // Collapse concurrent inspections of the same friend into one Enter/Leave pair.
    const inflight = friendWeatherInspections.get(gid);
    if (inflight) return inflight;
  }
  const request = performFriendFarmWeatherInspection(gid, friendWeatherCache.get(gid) || null);
  friendWeatherInspections.set(gid, request);
  try {
    return await request;
  } finally {
    if (friendWeatherInspections.get(gid) === request) friendWeatherInspections.delete(gid);
  }
}

function weatherAvailability(weather, inspected) {
  if (!inspected) return { state: 'unknown', reason: '尚未进入好友农场检查现场天气' };
  if (weather.isThunderstorm && weather.collectedThisCycle) {
    return { state: 'collected', reason: '当前这轮雷雨已经采过，下轮雷雨可再次采集' };
  }
  if (weather.isThunderstorm) return { state: 'available', reason: '' };
  if (weather.type === THUNDERSTORM_TYPE && !weather.active) return { state: 'expired', reason: '这场雷雨已经结束' };
  return { state: 'unavailable', reason: '好友农场当前不是雷雨天气' };
}

function friendWeatherDto(friend, inspection) {
  const gid = friendGid(friend);
  const scanError = String((inspection && inspection.error) || '');
  const inspected = !!(inspection && inspection.rawWeather) && !scanError;
  const weather = weatherStatusDto(inspection && inspection.rawWeather, gid);
  const availability = weatherAvailability(weather, inspected);
  const basic = (inspection && inspection.basic) || {};
  return {
    gid,
    name: String((friend && (friend.remark || friend.name)) || basic.name || ''),
    avatarUrl: String((friend && (friend.avatarUrl || friend.avatar_url)) || basic.avatar_url || ''),
    level: toNum((friend && friend.level) ?? basic.level),
    inspected,
    inspectedAt: toNum(inspection && inspection.inspectedAt),
    scanError,
    availability: availability.state,
    availabilityReason: availability.reason,
    canCollect: !scanError && availability.state === 'available',
    eligibleCloudLandIds: scanError ? [] : cloudEligibleLandIds(inspection && inspection.lands),
    weather,
  };
}

function weatherFriendMetaMap() {
  const map = new Map();
  // 本仓库等价于上游 getFriendsListCacheOnly()：只读内存缓存，不触发协议请求。
  for (const friend of getFriendsListCache() || []) {
    const gid = friendGid(friend);
    if (gid !== '0') map.set(gid, friend);
  }
  return map;
}

function friendDtoForGid(gid, inspection) {
  return friendWeatherDto(weatherFriendMetaMap().get(gid) || { gid }, inspection);
}

let pendingSnapshot = null;

async function buildWeatherActivitySnapshot() {
  // QQ 网关对活动读取的并发很敏感，按官方客户端顺序串行请求。
  const groupReply = await queryWeatherGroup();
  const bagReply = await getBag();
  const ownWeatherReply = await getWeatherStatus();
  const group = groupReply && groupReply.group;
  // queryWeatherGroup 已确保能取到活动；这里只兜底 group 缺失的情况。
  if (!group) {
    throw businessError('WEATHER_ACTIVITY_UNAVAILABLE', '服务端未发现雨落成诗活动');
  }

  // 复用本仓库已验证的归一化逻辑：services/activity.js 的 normalizeRainPoemActivity
  // 已经处理好了本仓库 ActivityInfo 的字段命名与各子体的实际挂载位置
  // （exchange_shop.items / weather_research.progress.stages 等），
  // 直接复用可避免两套解析逻辑读出不一致的数据。
  const { normalizeRainPoemActivity } = require('./activity');
  const normalized = normalizeRainPoemActivity(groupReply);

  const balances = bagBalances(bagReply);
  const active = !!normalized.active;
  const shopChild = findChild(groupReply, WEATHER_SHOP_ACTIVITY_ID);
  const mutationChild = findChild(groupReply, WEATHER_MUTATION_ACTIVITY_ID);
  const bottleChild = findChild(groupReply, WEATHER_BOTTLE_ACTIVITY_ID);
  const researchChild = findChild(groupReply, WEATHER_RESEARCH_ACTIVITY_ID);
  const taskChild = findChild(groupReply, WEATHER_TASK_ACTIVITY_ID);
  const ownWeather = weatherStatusDto(ownWeatherReply && ownWeatherReply.weather, getUserState() && getUserState().gid);
  const shop = shopDto(shopChild, normalized, balances, active);
  const collector = collectorConfigDto(bottleChild, normalized);
  const tasks = tasksDto(taskChild, normalized);
  const research = researchDto(researchChild, normalized, balances);
  const nextResearchNode = (research && research.nextNode) || null;
  return {
    groupId: WEATHER_GROUP_ID,
    activity: activityDto(group.activity),
    // 本仓库 ActivityInfo 的活动说明放在 payload（上游为 extra）。
    rules: activityRules(
      shopChild && shopChild.activity && (shopChild.activity.extra ?? shopChild.activity.payload),
    ),
    active,
    serverTime: getServerTimeSec(),
    mutation: {
      activityId: WEATHER_MUTATION_ACTIVITY_ID,
      active: !!mutationChild && activityIsActive(mutationChild.activity),
      mutantConfigId: LIGHTNING_MUTANT_CONFIG_ID,
      baseRatePercent: toNum(shopChild && shopChild.activity && shopChild.activity.field_21),
      sellMultiplier: 4,
      excludedCropQualities: [1, 2],
    },
    ownWeather,
    shop,
    collector,
    tasks,
    research,
    inventory: inventoryDto(balances),
    actions: {
      exchangeCollector: {
        enabled: !!shopChild && !!(shop && shop.available),
      },
      collectWeather: {
        enabled: active && BigInt(balances.get(String(COLLECTOR_BOTTLE_ID)) || '0') > 0n,
        dailyLimit: COLLECT_DAILY_LIMIT,
      },
      scanFriendWeather: {
        enabled: active,
        batchSize: FRIEND_WEATHER_SCAN_BATCH_LIMIT,
        reason: active ? '' : '活动尚未开放或已经结束',
      },
      frogMischief: {
        enabled: active && BigInt(balances.get(String(FROG_MISCHIEF_BOTTLE_ID)) || '0') > 0n,
        dailyLimit: MISCHIEF_DAILY_LIMIT,
      },
      cloudMischief: {
        enabled: active && BigInt(balances.get(String(CLOUD_MISCHIEF_BOTTLE_ID)) || '0') > 0n,
        dailyLimit: MISCHIEF_DAILY_LIMIT,
      },
      summonThunderstorm: {
        enabled: active
          && BigInt(balances.get(String(SUMMON_BOTTLE_ID)) || '0') > 0n
          && !ownWeather.active,
        reason: !active
          ? '活动尚未开放或已经结束'
          : ownWeather.active
            ? ownWeather.isThunderstorm ? '雷雨正在进行中' : '当前已有其他特殊天气'
            : BigInt(balances.get(String(SUMMON_BOTTLE_ID)) || '0') <= 0n
              ? '背包中没有可用的雷雨召唤瓶'
              : '',
      },
      advanceResearch: {
        enabled: active && !!(nextResearchNode && nextResearchNode.availableByStatus) && !!(nextResearchNode && nextResearchNode.affordable),
        nodeId: (nextResearchNode && nextResearchNode.id) || '',
        reason: !active
          ? '活动尚未开放或已经结束'
          : !nextResearchNode
            ? '气象研究已经全部完成'
            : !nextResearchNode.affordable
              ? '雷电徽章不足'
              : '',
      },
    },
  };
}

function getCurrentWeatherActivity() {
  if (pendingSnapshot) return pendingSnapshot;
  const request = buildWeatherActivitySnapshot();
  pendingSnapshot = request;
  request.finally(() => {
    if (pendingSnapshot === request) pendingSnapshot = null;
  }).catch(() => {});
  return request;
}

function friendBasicDto(friend) {
  return {
    gid: friendGid(friend),
    name: String((friend && (friend.remark || friend.name)) || ''),
    avatarUrl: String((friend && (friend.avatarUrl || friend.avatar_url)) || ''),
    level: toNum(friend && friend.level),
  };
}

async function getWeatherFriends() {
  // 只返回好友基础信息，不进任何农场：现场天气与可采状态由面板点击好友时按需扫描。
  const friends = await getFriendsList(false);
  const selfGid = int64String(getUserState() && getUserState().gid);
  const result = [];
  for (const friend of Array.isArray(friends) ? friends : []) {
    const gid = friendGid(friend);
    if (gid === '0' || gid === selfGid) continue;
    result.push(friendBasicDto(friend));
  }
  return result;
}

function scanFriendGids(input) {
  const list = Array.isArray(input) ? input : (input == null || input === '' ? [] : [input]);
  const selfGid = int64String(getUserState() && getUserState().gid);
  const gids = [];
  for (const entry of list) {
    const gid = positiveDecimal(entry, 'INVALID_WEATHER_FRIEND_GID', 'friendGid');
    if (gid === selfGid || gids.includes(gid)) continue;
    gids.push(gid);
  }
  if (gids.length === 0) {
    throw businessError('INVALID_WEATHER_FRIEND_GID', '请先选择需要检查现场天气的好友');
  }
  if (gids.length > FRIEND_WEATHER_SCAN_BATCH_LIMIT) {
    throw businessError(
      'WEATHER_SCAN_BATCH_TOO_LARGE',
      `单次最多检查 ${FRIEND_WEATHER_SCAN_BATCH_LIMIT} 位好友，请分批发起`,
    );
  }
  return gids;
}

let mutationTail = Promise.resolve();

function serializeMutation(operation) {
  const run = mutationTail.then(operation, operation);
  mutationTail = run.then(() => undefined, () => undefined);
  return run;
}

function scanWeatherFriends(friendGidsInput) {
  const gids = scanFriendGids(friendGidsInput);
  return serializeMutation(async () => {
    const meta = weatherFriendMetaMap();
    const friends = [];
    const deferredGids = [];
    let visited = 0;
    for (let index = 0; index < gids.length; index += 1) {
      const gid = gids[index];
      const fresh = freshFriendWeather(gid);
      if (fresh) {
        friends.push(friendWeatherDto(meta.get(gid) || { gid }, fresh));
        continue;
      }
      // 好友任务同样要进出好友农场，先给它让路；
      // 等不到空闲就把剩下的好友交回前端稍后重试。
      // eslint-disable-next-line no-await-in-loop
      if (!(await waitForFriendTaskIdle())) {
        deferredGids.push(...gids.slice(index));
        break;
      }
      // Space out the farm visits instead of bursting the whole batch at once.
      // eslint-disable-next-line no-await-in-loop
      if (visited > 0) await sleep(FRIEND_WEATHER_SCAN_GAP_MS);
      visited += 1;
      // eslint-disable-next-line no-await-in-loop
      const inspection = await inspectFriendFarmWeather({ gid });
      friends.push(friendWeatherDto(meta.get(gid) || { gid }, inspection));
    }
    return {
      outcome: 'scanned',
      serverTime: getServerTimeSec(),
      friends,
      deferredGids,
    };
  });
}

function availableStack(bagReply, itemId) {
  return getBagItems(bagReply)
    .filter((item) => toNum(item && (item.id ?? item.item_id)) === itemId && toNum(item && item.count) > 0)
    .sort((left, right) => {
      const leftExpire = toNum(left && left.expire_time) || Number.MAX_SAFE_INTEGER;
      const rightExpire = toNum(right && right.expire_time) || Number.MAX_SAFE_INTEGER;
      return leftExpire - rightExpire;
    })[0] || null;
}

async function sendBottleUse(itemId, stack, target = null) {
  const payload = {
    item: {
      id: itemId,
      count: 1,
      uid: stack.uid,
    },
  };
  if (target) payload.target = target;
  const body = Buffer.from(types.UseRequest.encode(types.UseRequest.create(payload)).finish());
  const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
  return types.UseReply.decode(replyBody);
}

function useReplyDto(reply) {
  const rewardSources = [
    ...(Array.isArray(reply && reply.items) ? reply.items : []),
    ...(Array.isArray(reply && reply.land_reward && reply.land_reward.items) ? reply.land_reward.items : []),
    ...(Array.isArray(reply && reply.social_reward && reply.social_reward.items) ? reply.social_reward.items : []),
  ];
  return {
    usedItems: (Array.isArray(reply && reply.used_items) ? reply.used_items : []).map(itemDto),
    rewards: rewardSources.map(itemDto),
    landId: int64String(reply && ((reply.land && reply.land.id) || (reply.land_reward && reply.land_reward.land_id))),
    socialItemId: int64String(reply && reply.social_reward && reply.social_reward.item_id),
  };
}

/**
 * 本仓库 OperateReply 的字段 1/2 名为 id/cmd（上游为 activity_id/operate_type），
 * 且天气结果挂在 141/142/143/144（上游 101/108/140/104），这里统一做一次映射，
 * 避免业务代码到处判断字段名。
 */
function operateReplyActivityId(reply) {
  return int64String(reply && (reply.activity_id ?? reply.id));
}

function operateReplyOperateType(reply) {
  return int64String(reply && (reply.operate_type ?? reply.cmd));
}

function operateReplyRewards(reply) {
  const sources = [];
  if (reply && Array.isArray(reply.rewards)) sources.push(...reply.rewards);
  const exchange = reply && reply.weather_exchange_result;
  if (exchange && Array.isArray(exchange.rewards)) sources.push(...exchange.rewards);
  const research = reply && reply.weather_research_result;
  if (research && Array.isArray(research.rewards)) sources.push(...research.rewards);
  return sources.map(itemDto);
}

async function exchangeWeatherCollectorBottle() {
  return serializeMutation(async () => {
    const groupReply = await queryWeatherGroup();
    const shopChild = findChild(groupReply, WEATHER_SHOP_ACTIVITY_ID);
    const bagReply = await getBag();
    const balances = bagBalances(bagReply);
    const { normalizeRainPoemActivity } = require('./activity');
    const normalized = normalizeRainPoemActivity(groupReply);
    const shop = shopDto(
      shopChild,
      normalized,
      balances,
      activityIsActive(groupReply && groupReply.group && groupReply.group.activity),
    );
    if (!shop) throw businessError('WEATHER_SHOP_UNAVAILABLE', '天气采集瓶商店暂不可用');
    if (shop.owned) throw businessError('WEATHER_SHOP_ALREADY_EXCHANGED', '今日已经兑换过天气采集瓶');
    if (!shop.available) throw businessError('WEATHER_SHOP_UNAVAILABLE', shop.reason || '天气采集瓶当前不可兑换');
    // 本仓库 ExchangeShopOperateParams 字段 1 名为 id（上游为 goods_id），同为 int64。
    const body = Buffer.from(types.ExchangeShopRequest.encode(types.ExchangeShopRequest.create({
      activity_id: WEATHER_SHOP_ACTIVITY_ID,
      operate_type: EXCHANGE_SHOP_OPERATE_TYPE,
      exchange_shop_operate: {
        id: shop.goodsId,
        count: 1,
      },
    })).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    const reply = types.ActivityOperateReply.decode(replyBody);
    return {
      outcome: 'exchanged',
      rewards: operateReplyRewards(reply),
      activityId: operateReplyActivityId(reply),
      operateType: operateReplyOperateType(reply),
      snapshot: await buildWeatherActivitySnapshot(),
    };
  });
}

async function useWeatherCollectorBottle(friendGidInput) {
  return serializeMutation(async () => {
    const friendGid = positiveDecimal(friendGidInput, 'INVALID_WEATHER_FRIEND_GID', 'friendGid');
    if (friendGid === int64String(getUserState() && getUserState().gid)) {
      throw businessError('INVALID_WEATHER_FRIEND_GID', '天气采集瓶只能在好友农场使用');
    }
    const bagBefore = await getBag();
    const stack = availableStack(bagBefore, COLLECTOR_BOTTLE_ID);
    if (!stack) throw businessError('WEATHER_COLLECTOR_UNAVAILABLE', '背包中没有可用的天气采集瓶');

    let entered = false;
    let reply = null;
    let weatherBefore = null;
    try {
      const enterReply = await enterFriendFarm(Number(friendGid));
      entered = true;
      friendWeatherCache.set(friendGid, friendInspectionFromEnterReply(friendGid, enterReply));
      weatherBefore = weatherStatusDto(enterReply && enterReply.weather, friendGid);
      if (!weatherBefore.isThunderstorm) {
        throw businessError('WEATHER_FRIEND_NOT_THUNDERSTORM', '该好友农场当前不是雷雨天气');
      }
      if (weatherBefore.collectedThisCycle) {
        throw businessError('WEATHER_ALREADY_COLLECTED', '当前这轮雷雨已经采过，下轮雷雨可再次采集');
      }
      const body = Buffer.from(types.CollectWeatherRequest.encode(types.CollectWeatherRequest.create({
        activity_id: WEATHER_BOTTLE_ACTIVITY_ID,
        operate_type: COLLECT_WEATHER_OPERATE_TYPE,
        weather_collect_operate: { host_gid: friendGid },
      })).finish());
      try {
        const { body: replyBody } = await sendMsgAsync(
          'gamepb.activitypb.ActivityService',
          'Operate',
          body,
          { expectedErrorCodes: [1034040] },
        );
        reply = types.ActivityOperateReply.decode(replyBody);
      } catch (error) {
        // 本仓库没有 GatewayError 类，改用 parseRpcErrorCode 判定服务端业务拒绝。
        if (parseRpcErrorCode(error) === 1034040) {
          throw businessError('WEATHER_ALREADY_COLLECTED', '当前这轮雷雨已经采过，下轮雷雨可再次采集');
        }
        throw error;
      }
    } finally {
      if (entered) await leaveFriendFarm(Number(friendGid));
    }

    // 采集成功后按官方客户端方式再次进入，记录服务端更新后的现场标记。
    const weatherAfterInspection = await inspectFriendFarmWeather({ gid: friendGid }, true);
    const weatherAfter = weatherStatusDto(weatherAfterInspection && weatherAfterInspection.rawWeather, friendGid);
    pendingSnapshot = null;
    return {
      outcome: 'collected',
      friendGid,
      activityId: operateReplyActivityId(reply),
      operateType: operateReplyOperateType(reply),
      rewards: operateReplyRewards(reply),
      weatherBefore,
      weatherAfter,
      friend: friendDtoForGid(friendGid, weatherAfterInspection),
      snapshot: await buildWeatherActivitySnapshot(),
    };
  });
}

async function useWeatherSummonBottle() {
  return serializeMutation(async () => {
    const weatherBeforeReply = await getWeatherStatus();
    const weatherBefore = weatherStatusDto(weatherBeforeReply && weatherBeforeReply.weather, getUserState() && getUserState().gid);
    if (weatherBefore.active) {
      throw businessError('WEATHER_ALREADY_ACTIVE', '自己的农场当前已有特殊天气，暂时无法召唤雷雨');
    }
    const bagBefore = await getBag();
    const stack = availableStack(bagBefore, SUMMON_BOTTLE_ID);
    if (!stack) throw businessError('WEATHER_SUMMON_UNAVAILABLE', '背包中没有可用的雷雨召唤瓶');
    const selfGid = positiveDecimal(int64String(getUserState() && getUserState().gid), 'WEATHER_ACCOUNT_UNAVAILABLE', 'hostGid');
    const reply = await sendBottleUse(SUMMON_BOTTLE_ID, stack, {
      host_gid: selfGid,
      land_ids: [],
      use_config_id: 0,
    });
    const weatherAfterReply = await getWeatherStatus();
    return {
      outcome: 'summoned',
      ...useReplyDto(reply),
      weather: weatherStatusDto(weatherAfterReply && weatherAfterReply.weather, getUserState() && getUserState().gid),
      snapshot: await buildWeatherActivitySnapshot(),
    };
  });
}

async function useWeatherFrogBottle(friendGidInput) {
  return serializeMutation(async () => {
    const friendGid = positiveDecimal(friendGidInput, 'INVALID_WEATHER_FRIEND_GID', 'friendGid');
    if (friendGid === int64String(getUserState() && getUserState().gid)) {
      throw businessError('INVALID_WEATHER_FRIEND_GID', '青蛙使坏瓶只能在好友农场使用');
    }
    const stack = availableStack(await getBag(), FROG_MISCHIEF_BOTTLE_ID);
    if (!stack) throw businessError('WEATHER_FROG_UNAVAILABLE', '背包中没有可用的青蛙使坏瓶');

    let entered = false;
    let result = null;
    try {
      const enterReply = await enterFriendFarm(Number(friendGid));
      entered = true;
      friendWeatherCache.set(friendGid, friendInspectionFromEnterReply(friendGid, enterReply));
      const reply = await sendBottleUse(FROG_MISCHIEF_BOTTLE_ID, stack, {
        host_gid: friendGid,
        use_config_id: 0,
      });
      pendingSnapshot = null;
      result = {
        outcome: 'frog-used',
        friendGid,
        ...useReplyDto(reply),
        friend: friendDtoForGid(friendGid, friendWeatherCache.get(friendGid) || null),
      };
    } finally {
      if (entered) await leaveFriendFarm(Number(friendGid));
    }
    return { ...result, snapshot: await buildWeatherActivitySnapshot() };
  });
}

async function useWeatherCloudBottle(friendGidInput, landIdInput = null) {
  return serializeMutation(async () => {
    const friendGid = positiveDecimal(friendGidInput, 'INVALID_WEATHER_FRIEND_GID', 'friendGid');
    if (friendGid === int64String(getUserState() && getUserState().gid)) {
      throw businessError('INVALID_WEATHER_FRIEND_GID', '乌云使坏瓶只能在好友农场使用');
    }
    const stack = availableStack(await getBag(), CLOUD_MISCHIEF_BOTTLE_ID);
    if (!stack) throw businessError('WEATHER_CLOUD_UNAVAILABLE', '背包中没有可用的乌云使坏瓶');

    let entered = false;
    let result = null;
    try {
      const enterReply = await enterFriendFarm(Number(friendGid));
      entered = true;
      const eligibleLandIds = cloudEligibleLandIds(enterReply && enterReply.lands);
      const requestedLandId = landIdInput == null || landIdInput === ''
        ? ''
        : positiveDecimal(landIdInput, 'INVALID_WEATHER_LAND_ID', 'landId');
      const landId = requestedLandId || eligibleLandIds[0] || '';
      if (!landId || !eligibleLandIds.includes(landId)) {
        throw businessError('WEATHER_CLOUD_TARGET_UNAVAILABLE', '好友当前没有可使用乌云使坏瓶的作物');
      }
      const inspection = friendInspectionFromEnterReply(friendGid, enterReply);
      friendWeatherCache.set(friendGid, inspection);
      const reply = await sendBottleUse(CLOUD_MISCHIEF_BOTTLE_ID, stack, {
        host_gid: friendGid,
        land_ids: [landId],
      });
      if (reply && reply.land) {
        inspection.lands = inspection.lands.map((land) => (
          int64String(land && land.id) === landId ? reply.land : land
        ));
        inspection.inspectedAt = getServerTimeSec();
        friendWeatherCache.set(friendGid, inspection);
      }
      pendingSnapshot = null;
      result = {
        outcome: 'cloud-used',
        friendGid,
        landId,
        ...useReplyDto(reply),
        friend: friendDtoForGid(friendGid, inspection),
      };
    } finally {
      if (entered) await leaveFriendFarm(Number(friendGid));
    }
    return { ...result, snapshot: await buildWeatherActivitySnapshot() };
  });
}

async function advanceWeatherResearch(nodeIdInput) {
  return serializeMutation(async () => {
    const nodeId = positiveDecimal(nodeIdInput, 'INVALID_WEATHER_RESEARCH_NODE', 'nodeId');
    const groupReply = await queryWeatherGroup();
    const group = groupReply && groupReply.group;
    if (!group || !activityIsActive(group.activity)) {
      throw businessError('WEATHER_ACTIVITY_UNAVAILABLE', '雨落成诗活动尚未开放或已经结束');
    }
    const researchChild = findChild(groupReply, WEATHER_RESEARCH_ACTIVITY_ID);
    const bagReply = await getBag();
    const { normalizeRainPoemActivity } = require('./activity');
    const research = researchDto(researchChild, normalizeRainPoemActivity(groupReply), bagBalances(bagReply));
    if (!research) throw businessError('WEATHER_RESEARCH_UNAVAILABLE', '服务端未返回气象研究数据');
    const node = research.nodes.find((entry) => entry.id === nodeId);
    if (!node) throw businessError('INVALID_WEATHER_RESEARCH_NODE', '气象研究节点不存在');
    if (node.completed) throw businessError('WEATHER_RESEARCH_ALREADY_COMPLETED', '该气象研究节点已经完成');
    if (!node.availableByStatus) throw businessError('WEATHER_RESEARCH_LOCKED', '请先完成前置气象研究节点');
    if (!node.affordable) throw businessError('INSUFFICIENT_LIGHTNING_BADGES', '雷电徽章不足');

    const body = Buffer.from(types.AdvanceWeatherResearchRequest.encode(types.AdvanceWeatherResearchRequest.create({
      activity_id: WEATHER_RESEARCH_ACTIVITY_ID,
      operate_type: ADVANCE_RESEARCH_OPERATE_TYPE,
      weather_research_operate: { node_id: nodeId },
    })).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    const reply = types.ActivityOperateReply.decode(replyBody);
    pendingSnapshot = null;
    return {
      outcome: 'advanced',
      nodeId,
      activityId: operateReplyActivityId(reply),
      operateType: operateReplyOperateType(reply),
      rewards: node.reward && node.reward.id && node.reward.id !== '0' ? [node.reward] : [],
      snapshot: await buildWeatherActivitySnapshot(),
    };
  });
}

networkEvents.on('weatherChanged', () => {
  pendingSnapshot = null;
  friendWeatherCache.clear();
});
networkEvents.on('activitiesChanged', () => {
  pendingSnapshot = null;
});
// 本仓库断线事件名为 'disconnect'（上游为 'disconnected'）。
networkEvents.on('disconnect', () => {
  pendingSnapshot = null;
  friendWeatherInspections.clear();
  friendWeatherCache.clear();
});

module.exports = {
  WEATHER_GROUP_ID,
  LIGHTNING_MUTANT_CONFIG_ID,
  getWeatherStatus,
  getCurrentWeatherActivity,
  getWeatherFriends,
  scanWeatherFriends,
  FRIEND_WEATHER_SCAN_BATCH_LIMIT,
  exchangeWeatherCollectorBottle,
  useWeatherCollectorBottle,
  useWeatherSummonBottle,
  useWeatherFrogBottle,
  useWeatherCloudBottle,
  advanceWeatherResearch,
  // Exported for protocol-state regression tests.
  weatherStatusDto,
  weatherAvailability,
};
