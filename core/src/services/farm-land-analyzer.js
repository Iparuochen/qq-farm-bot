const { PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantName, getPlantExp, getPlantById, getPlantGrowTime, getPlantGrowPhases, getSeedImageBySeedId, getMutantDisplayPlantId, getMutantPlantImageByPhase, getMutantEffectsByIds, getItemById } = require('../config/gameConfig');
const { toNum, toTimeSec, getServerTimeSec, logWarn } = require('../utils/utils');
const { getAllLands } = require('./farm-api');
const { buildLandUpgradeDetail } = require('./land-upgrade');

const GOLDEN_BUG_ITEM_ID = 301101;
const GOLDEN_BUG_SOCIAL_TYPE = 2;
const MATURE_PHASE_RECORD_ID = 19;

// 抓包确认：黄金虫、足球和乌云由农场主通过自家 Farming 清理，好友帮助务农不能代为清理。
// 乌云必须以 interaction_uses / interaction_targets 的实时记录为准；field_40={8,1} 只是清理后仍保留的历史。
const OWNER_CLEANABLE_INTERACTION_ITEM_IDS = new Set(['301101', '301102', '5006']);

// 5005 青蛙是农场级事件，不绑定某一块土地；清理时通过 FarmingRequest.field 5 发送。
const OWNER_CLEANABLE_FARM_SOCIAL_EVENT_ITEM_IDS = new Set(['5005']);

const QIXI_DEW_ITEM_ID = '301103';
const QIXI_MUTANT_CONFIG_ID = '13';
const QIXI_DEW_HISTORY_CODES = new Set([9, 10]);

/** int64 字段统一按十进制字符串处理，避免 JS 大数精度丢失。 */
function int64String(value) {
  if (value == null) return '0';
  const text = String(value && value.toString ? value.toString() : value).trim();
  return /^-?\d+$/.test(text) ? text : '0';
}

/** 归一化成正十进制 ID 字符串，非法或 0 返回空串。 */
function normalizePositiveId(value) {
  const text = int64String(value);
  return /^\d+$/.test(text) && text !== '0' ? text : '';
}

function getPlantExtendedStatuses(plant) {
  if (Array.isArray(plant && plant.field_40)) return plant.field_40.filter(Boolean);
  return plant && plant.field_40 ? [plant.field_40] : [];
}

function getInteractionItemMetadata(itemId) {
  const item = getItemById(Number(itemId));
  return {
    name: String((item && item.name) || `道具${itemId}`),
    activityId: toNum(item && item.activity_id)
  };
}

function getQixiDewExtendedStatus(plant) {
  if (!getPlantMutantConfigIds(plant).map(String).includes(QIXI_MUTANT_CONFIG_ID)) return null;
  return getPlantExtendedStatuses(plant).find(status => (
    QIXI_DEW_HISTORY_CODES.has(toNum(status && status.value_1))
    && toNum(status && status.value_2) === 1
  )) || null;
}

function getExtendedStatusInteractionItemId(plant) {
  return getQixiDewExtendedStatus(plant) ? QIXI_DEW_ITEM_ID : '';
}

/**
 * 从 interaction_uses / interaction_targets 还原作物上已生效的互动道具。
 * 协议侧 uses 记录「谁用了什么」，targets 记录「作用在哪块地」，两者按 item/host/时间配对。
 */
function getPlantInteractionEffects(plant) {
  const uses = Array.isArray(plant && plant.interaction_uses) ? plant.interaction_uses : [];
  const targets = Array.isArray(plant && plant.interaction_targets) ? plant.interaction_targets : [];
  const effects = [];
  const usedTargetKeys = new Set();

  const findTargets = (use) => {
    const itemId = normalizePositiveId(use && use.item_id);
    const hostGid = normalizePositiveId(use && use.host_gid);
    const timestamp = int64String(use && use.timestamp);
    const exact = targets.filter(target => (
      normalizePositiveId(target && target.item_id) === itemId
      && (!hostGid || normalizePositiveId(target && target.host_gid) === hostGid)
      && (!timestamp || int64String(target && target.timestamp) === timestamp)
    ));
    if (exact.length > 0) return exact;
    return targets.filter(target => normalizePositiveId(target && target.item_id) === itemId);
  };

  for (const use of uses) {
    const itemId = normalizePositiveId(use && use.item_id);
    if (!itemId) continue;
    const metadata = getInteractionItemMetadata(itemId);
    const matchingTargets = findTargets(use);
    const targetList = matchingTargets.length > 0 ? matchingTargets : [null];
    for (const target of targetList) {
      const landId = normalizePositiveId(target && target.land_id);
      const hostGid = normalizePositiveId(
        (target && target.host_gid) != null ? target.host_gid : (use && use.host_gid)
      );
      const usedAt = int64String(
        (target && target.timestamp) != null ? target.timestamp : (use && use.timestamp)
      );
      const targetKey = target
        ? `${itemId}:${hostGid}:${usedAt}:${landId}`
        : `${itemId}:${hostGid}:${usedAt}:`;
      if (usedTargetKeys.has(targetKey)) continue;
      usedTargetKeys.add(targetKey);
      effects.push({
        itemId,
        itemName: metadata.name,
        activityId: metadata.activityId,
        effectType: toNum(use && use.effect_type),
        landId,
        hostGid,
        usedAt,
        confirmed: true,
        source: 'protocol-land'
      });
    }
  }

  const extendedItemId = getExtendedStatusInteractionItemId(plant);
  if (extendedItemId && !effects.some(effect => effect.itemId === extendedItemId)) {
    const metadata = getInteractionItemMetadata(extendedItemId);
    effects.push({
      itemId: extendedItemId,
      itemName: metadata.name,
      activityId: metadata.activityId,
      effectType: 0,
      landId: '',
      hostGid: '',
      usedAt: '',
      confirmed: true,
      source: 'protocol-land'
    });
  }

  return effects;
}

function hasOwnerCleanableInteraction(plant) {
  const uses = Array.isArray(plant && plant.interaction_uses) ? plant.interaction_uses : [];
  const targets = Array.isArray(plant && plant.interaction_targets) ? plant.interaction_targets : [];
  return [...uses, ...targets].some(entry => (
    OWNER_CLEANABLE_INTERACTION_ITEM_IDS.has(normalizePositiveId(entry && entry.item_id))
  ));
}

function getCleanableFarmSocialEventItemIds(eventsOrReply) {
  const events = Array.isArray(eventsOrReply)
    ? eventsOrReply
    : (Array.isArray(eventsOrReply && eventsOrReply.social_events) ? eventsOrReply.social_events : []);
  return [...new Set(events
    .map(event => normalizePositiveId(event && event.item_id))
    .filter(itemId => OWNER_CLEANABLE_FARM_SOCIAL_EVENT_ITEM_IDS.has(itemId))
    .map(Number))];
}

function buildFarmSocialEventDetails(eventsOrReply) {
  const events = Array.isArray(eventsOrReply)
    ? eventsOrReply
    : (Array.isArray(eventsOrReply && eventsOrReply.social_events) ? eventsOrReply.social_events : []);
  return events.map((event) => {
    const itemId = normalizePositiveId(event && event.item_id);
    if (!itemId) return null;
    const metadata = getInteractionItemMetadata(itemId);
    return {
      itemId,
      itemName: metadata.name,
      activityId: metadata.activityId,
      visitorGid: normalizePositiveId(event && event.visitor_gid),
      occurredAt: int64String(event && event.timestamp),
      cleanable: OWNER_CLEANABLE_FARM_SOCIAL_EVENT_ITEM_IDS.has(itemId)
    };
  }).filter(Boolean);
}

/**
 * 生成单块土地的展示详情，好友农场与自己农场共用。
 * friendMode 影响成熟态的语义：好友视角可偷为 stealable，否则为 harvested。
 */
function buildLandDetail(land, options = {}) {
  const nowSec = Number(options.nowSec) || getServerTimeSec();
  const friendMode = !!options.friendMode;
  const landsMap = options.landsMap instanceof Map ? options.landsMap : buildLandMap([land]);
  const id = toNum(land && land.id);
  const level = toNum(land && land.level);
  const maxLevel = toNum(land && land.max_level);
  const landsLevel = toNum(land && land.lands_level);
  const landSize = toNum(land && land.land_size);
  const landBuff = {
    plantYieldBonus: toNum(land && land.buff && land.buff.plant_yield_bonus),
    plantingTimeReduction: toNum(land && land.buff && land.buff.planting_time_reduction),
    plantExpBonus: toNum(land && land.buff && land.buff.plant_exp_bonus)
  };
  const context = getDisplayLandContext(land, landsMap);
  const base = {
    id,
    unlocked: !!(land && land.unlocked),
    level,
    maxLevel,
    landsLevel,
    landSize,
    landBuff,
    couldUnlock: !!(land && land.could_unlock),
    couldUpgrade: !!(land && land.could_upgrade),
    occupiedByMaster: !!context.occupiedByMaster,
    masterLandId: toNum(context.masterLandId),
    occupiedLandIds: Array.isArray(context.occupiedLandIds) ? context.occupiedLandIds : [],
    // 土地升级条件与消耗明细（移植自上游 land-upgrade）
    landUpgrade: buildLandUpgradeDetail(land, landsMap),
    plantSize: 1,
    rarity: 0,
    mutantConfigIds: [],
    mutantEffects: [],
    isMutated: false,
    purpleCrystalResonanceExpBonus: 0,
    interactionEffects: [],
    needInteractionCleanup: false,
    protocolField40: null,
    leftInorcFertTimes: null
  };

  if (!base.unlocked) {
    return {
      ...base,
      status: 'locked',
      plantName: '',
      phaseName: friendMode ? '未解锁' : '',
      currentSeason: 0,
      totalSeason: 0,
      occupiedByMaster: false,
      masterLandId: 0,
      occupiedLandIds: []
    };
  }

  const sourceLand = context.sourceLand || land;
  const plant = sourceLand && sourceLand.plant;
  if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) {
    return {
      ...base,
      status: 'empty',
      plantName: '',
      phaseName: '空地',
      currentSeason: 0,
      totalSeason: 0
    };
  }

  const currentPhase = getCurrentPhase(plant.phases, false, '', toNum(plant.id));
  if (!currentPhase) {
    return { ...base, status: 'empty', plantName: '', phaseName: '', currentSeason: 0, totalSeason: 0 };
  }

  const phaseVal = toNum(currentPhase.phase);
  const plantId = toNum(plant.id);
  const mutantConfigIds = [...new Set([
    ...getPlantMutantConfigIds(plant, currentPhase).map(String),
    ...getPlantInteractionEffects(plant)
      .filter(effect => normalizePositiveId(effect.itemId) === QIXI_DEW_ITEM_ID)
      .map(() => QIXI_MUTANT_CONFIG_ID)
  ])];
  const mutantEffects = getMutantEffectsByIds(mutantConfigIds);
  // 协议没有独立的“紫晶共鸣”布尔值：紫金土地由 level 标识，
  // 是否存在加成及具体比例必须以服务端 LandInfo.buff.plant_exp_bonus 为准。
  const purpleCrystalResonanceExpBonus = level === 5 && mutantConfigIds.length > 0
    ? Math.max(0, landBuff.plantExpBonus)
    : 0;
  const displayPlantId = getMutantDisplayPlantId(plantId, mutantConfigIds);
  const plantName = getPlantName(displayPlantId) || getPlantName(plantId) || plant.name || '未知';
  const plantCfg = getPlantById(plantId);
  const seedId = toNum(plantCfg && plantCfg.seed_id);
  const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || toNum(sourceLand.land_size) || landSize || 1);
  const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
  const currentSeasonRaw = toNum(plant.season);
  const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
  const maturePhase = Array.isArray(plant.phases)
    ? plant.phases
      .filter(phase => phase && toTimeSec(phase.begin_time) > 0)
      .sort((left, right) => toTimeSec(right.begin_time) - toTimeSec(left.begin_time))[0]
    : null;
  const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
  const matureInSec = matureBegin > nowSec ? matureBegin - nowSec : 0;
  const statusFlags = {
    needWater: toNum(plant.dry_num) > 0 || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec),
    needWeed: (Array.isArray(plant.weed_owners) && plant.weed_owners.length > 0)
      || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec),
    needBug: (Array.isArray(plant.insect_owners) && plant.insect_owners.length > 0)
      || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec)
  };

  let status = 'growing';
  if (phaseVal === PlantPhase.MATURE) status = friendMode ? (plant.stealable ? 'stealable' : 'harvested') : 'harvestable';
  else if (phaseVal === PlantPhase.DEAD) status = 'dead';
  else if (phaseVal === PlantPhase.UNKNOWN) status = 'empty';

  const protocolField40 = getPlantExtendedStatuses(plant).map(entry => ({
    value1: int64String(entry && entry.value_1),
    value2: int64String(entry && entry.value_2)
  }));

  return {
    ...base,
    status,
    plantId,
    displayPlantId,
    plantName,
    seedId,
    seedImage: seedId > 0 ? getSeedImageBySeedId(seedId) : '',
    phaseName: currentPhase.phaseName || PHASE_NAMES[phaseVal] || '',
    currentSeason,
    totalSeason,
    matureInSec,
    totalGrowTime: getPlantGrowTime(plantId),
    needWater: statusFlags.needWater,
    needWeed: statusFlags.needWeed,
    needBug: statusFlags.needBug,
    stealable: !!plant.stealable,
    plantSize,
    rarity: toNum(plant.rarity != null ? plant.rarity : (plant.rare_level != null ? plant.rare_level : plant.rarity_level)),
    mutantConfigIds,
    mutantEffects,
    isMutated: mutantConfigIds.length > 0,
    purpleCrystalResonanceExpBonus,
    interactionEffects: getPlantInteractionEffects(plant),
    needInteractionCleanup: hasOwnerCleanableInteraction(plant),
    protocolField40: protocolField40.length > 0 ? protocolField40 : null,
    leftInorcFertTimes: Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times')
      ? toNum(plant.left_inorc_fert_times)
      : null
  };
}

function hasGoldenBug(plant) {
  return !!(plant && Array.isArray(plant.social_items) && plant.social_items.some(item => (
    toNum(item && item.item_id) === GOLDEN_BUG_ITEM_ID &&
    toNum(item && item.type) === GOLDEN_BUG_SOCIAL_TYPE
  )));
}

// ─── 辅助函数 ───

function isTransientNetworkError(err) {
  const msg = String(err && err.message || '');
  if (!msg) return false;
  return [
    '连接未打开', '请求超时', '请求已中断',
    '连接关闭', '发送失败', '请求队列已满'
  ].some(pattern => msg.includes(pattern));
}

/**
 * 获取作物当前所处阶段。
 * 官方响应 phases 是“当前阶段 + 后续阶段”的剩余时间表，第一条就是当前阶段。
 * @param {Array} phases - 阶段列表
 * @param {boolean} debug - 是否输出调试信息
 * @param {string} label - 调试标签
 */
function getCurrentPhase(phases, debug, label, plantId = 0) {
  if (!phases || phases.length === 0) return null;
  const serverTime = getServerTimeSec();

  if (debug) {
    console.warn(`    ${label} 服务器时间=${serverTime} (${new Date(serverTime * 1000).toLocaleTimeString()})`);
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      const beginTime = toTimeSec(p.begin_time);
      const phaseName = getPlantGrowPhases(plantId)[toNum(p.phase) - 1]?.name
        || PHASE_NAMES[toNum(p.phase)]
        || `阶段${  p.phase}`;
      const diff = beginTime > 0 ? beginTime - serverTime : 0;
      const diffLabel = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
      console.warn(`    ${label}   [${i}] ${phaseName}(${p.phase}) begin=${beginTime} ${diffLabel} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
    }
  }

  const converted = convertServerPhaseToClient(phases, phases[0], plantId);
  if (debug) {
    console.warn(`    ${label}   → 当前阶段: ${converted.phaseName || PHASE_NAMES[converted.phase] || converted.phase}`);
  }
  return converted;
}

/**
 * phases 是从当前阶段开始的配置后缀，因此当前配置下标等于：
 * grow_phases 总数 - 服务端剩余 phases 数。响应 phase 只表示生长中/成熟/枯死
 * 等粗状态，phase_id 是详细阶段类型，二者都不能直接作为配置数组下标。
 */
function convertServerPhaseToClient(phases, serverPhaseInfo, plantId) {
  if (!serverPhaseInfo) return null;
  const serverPhase = toNum(serverPhaseInfo.phase);
  const phaseRecordId = toNum(serverPhaseInfo.phase_id);
  const growPhases = getPlantGrowPhases(plantId);
  const remainingCount = Array.isArray(phases) ? phases.length : 0;
  const phaseIndex = growPhases.length > 0 && remainingCount > 0
    ? Math.max(0, growPhases.length - remainingCount)
    : -1;
  const configuredPhase = phaseIndex >= 0 ? growPhases[phaseIndex] : null;
  const isFinalConfiguredPhase = growPhases.length > 0 && phaseIndex === growPhases.length - 1;
  // 大多数作物成熟时 phase=6，但部分作物（例如最后阶段名为“盛开”的牵牛花）
  // 仍可能返回粗状态 2，或把详细阶段 ID 19 放进 phase。成熟阶段同时可由
  // phase_id=19 和 grow_phases 的最后一个剩余阶段确定，不能只依赖粗状态。
  const isMature = serverPhase !== PlantPhase.DEAD && (
    serverPhase === PlantPhase.MATURE ||
    serverPhase === MATURE_PHASE_RECORD_ID ||
    phaseRecordId === MATURE_PHASE_RECORD_ID ||
    (isFinalConfiguredPhase && (
      serverPhase === PlantPhase.GERMINATION ||
      serverPhase > PlantPhase.DEAD
    ))
  );
  const clientPhase = isMature ? PlantPhase.MATURE : serverPhase;
  const imagePhase = serverPhase === PlantPhase.DEAD ? PlantPhase.DEAD : phaseIndex + 1;
  const isKnownClientPhase = clientPhase >= PlantPhase.SEED && clientPhase <= PlantPhase.MATURE;
  if (!configuredPhase && serverPhase !== PlantPhase.DEAD && !isKnownClientPhase) return {
    ...serverPhaseInfo,
    phase_index: phaseIndex,
    image_phase: 0,
    server_phase: serverPhase,
    phase_record_id: phaseRecordId,
    phase: PlantPhase.UNKNOWN,
    phaseName: '未知阶段'
  };
  return {
    ...serverPhaseInfo,
    phase_index: phaseIndex,
    image_phase: configuredPhase ? imagePhase : clientPhase,
    server_phase: serverPhase,
    phase_record_id: phaseRecordId,
    phase: clientPhase,
    phaseName: serverPhase === PlantPhase.DEAD
      ? PHASE_NAMES[PlantPhase.DEAD]
      : configuredPhase && configuredPhase.name || PHASE_NAMES[clientPhase]
  };
}

// ─── 土地映射 ───

/** 构建 id → land 的地图 */
function buildLandMap(lands) {
  const map = new Map();
  const list = Array.isArray(lands) ? lands : [];
  for (const land of list) {
    const landId = toNum(land && land.id);
    if (landId > 0) map.set(landId, land);
  }
  return map;
}

/**
 * 收集植物当前生效的变异配置 ID。
 *
 * 全量土地响应通常在 PlantInfo.mutant_config_ids 返回结果，但部分新变异会先随
 * 当前 PlantPhaseInfo.mutants 下发。两处都读取，避免个人土地漏掉阶段级变异。
 */
function getPlantMutantConfigIds(plant, currentPhase) {
  const plantIds = Array.isArray(plant && plant.mutant_config_ids)
    ? plant.mutant_config_ids
    : [];
  const phaseMutants = Array.isArray(currentPhase && currentPhase.mutants)
    ? currentPhase.mutants
    : [];
  return [...new Set([
    ...plantIds.map(toNum),
    ...phaseMutants.map(item => toNum(item && item.mutant_config_id))
  ].filter(Boolean))];
}

/** 获取从属土地 ID 列表 */
function getSlaveLandIds(land) {
  const slaveIds = Array.isArray(land && land.slave_land_ids) ? land.slave_land_ids : [];
  return [...new Set(slaveIds.map(id => toNum(id)).filter(Boolean))];
}

/** 检查地块是否有植物数据 */
function hasPlantData(land) {
  const plant = land && land.plant;
  return !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
}

/**
 * 获取关联的主土地
 * 如果当前土地有 master_land_id 且该主人确实拥有当前土地作为从属
 */
function getLinkedMasterLand(land, landMap) {
  const landId = toNum(land && land.id);
  const masterId = toNum(land && land.master_land_id);
  if (masterId && masterId !== landId) {
    const masterLand = landMap.get(masterId);
    if (masterLand) {
      const slaveIds = getSlaveLandIds(masterLand);
      if (slaveIds.length === 0 || slaveIds.includes(landId)) return masterLand;
    }
  }

  // 部分服务端响应只在主土地上返回 slave_land_ids，从属土地的
  // master_land_id 可能为空；此时通过主土地声明的从属列表反查。
  for (const candidate of landMap.values()) {
    const candidateId = toNum(candidate && candidate.id);
    if (!candidateId || candidateId === landId || !hasPlantData(candidate)) continue;
    if (getSlaveLandIds(candidate).includes(landId)) return candidate;
  }

  return null;
}

/**
 * 获取地块的显示上下文（处理合并种植）
 * @returns {{ sourceLand, occupiedByMaster, masterLandId, occupiedLandIds }} 显示用土地上下文
 */
function getDisplayLandContext(land, landMap) {
  const master = getLinkedMasterLand(land, landMap);
  if (master && hasPlantData(master)) {
    const allIds = [toNum(master.id), ...getSlaveLandIds(master)].filter(Boolean);
    return {
      sourceLand: master,
      occupiedByMaster: true,
      masterLandId: toNum(master.id),
      occupiedLandIds: allIds.length > 1 ? allIds : [toNum(master.id)].filter(Boolean)
    };
  }
  const landId = toNum(land && land.id);
  const slaveIds = hasPlantData(land) ? getSlaveLandIds(land) : [];
  const occupiedLandIds = [landId, ...slaveIds].filter(Boolean);
  return {
    sourceLand: land,
    occupiedByMaster: false,
    masterLandId: landId,
    occupiedLandIds
  };
}

/** 检查是否为被主土地占用的从属土地 */
function isOccupiedSlaveLand(land, landMap) {
  return !!getDisplayLandContext(land, landMap).occupiedByMaster;
}

// ─── 土地状态汇总 ───

function summarizeLandDetails(lands) {
  const summary = {
    harvestable: 0, growing: 0, empty: 0, dead: 0,
    needWater: 0, needWeed: 0, needBug: 0
  };
  for (const land of (Array.isArray(lands) ? lands : [])) {
    if (!land || !land.unlocked) continue;
    const status = String(land.status || '');
    if (status === 'harvestable') summary.harvestable++;
    else if (status === 'dead') summary.dead++;
    else if (status === 'empty') summary.empty++;
    else if (status === 'growing' || status === 'stealable' || status === 'harvested') summary.growing++;

    if (land.needWater) summary.needWater++;
    if (land.needWeed) summary.needWeed++;
    if (land.needBug) summary.needBug++;
  }
  return summary;
}

// ─── 土地分析 ───

/**
 * 分析所有土地状态
 * @param {Array} lands - 地块列表
 * @param {boolean} debug - 是否输出调试信息
 */
function analyzeLands(lands, debug = false) {
  const result = {
    harvestable: [], needWater: [], needWeed: [], needBug: [], needGoldenBug: [],
    growing: [], empty: [], dead: [], unlockable: [], upgradable: [],
    harvestableInfo: []
  };

  const serverTime = getServerTimeSec();
  const landMap = buildLandMap(lands);

  for (const land of lands) {
    const landId = toNum(land.id);

    // 未解锁
    if (!land.unlocked) {
      if (land.could_unlock) result.unlockable.push(landId);
      continue;
    }

    if (land.could_upgrade) result.upgradable.push(landId);

    // 跳过被主土地占用的从属土地
    if (isOccupiedSlaveLand(land, landMap)) continue;

    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) {
      result.empty.push(landId);
      continue;
    }

    if (hasGoldenBug(plant)) result.needGoldenBug.push(landId);

    const plantName = plant.name || '未知作物';
    const debugLabel = `土地#${landId}(${plantName})`;
    const currentPhase = getCurrentPhase(plant.phases, debug, debugLabel, plant.id);

    if (!currentPhase) {
      result.empty.push(landId);
      continue;
    }

    const phase = currentPhase.phase;

    // 枯死
    if (phase === PlantPhase.DEAD) {
      result.dead.push(landId);
      continue;
    }

    // 成熟可收获
    if (phase === PlantPhase.MATURE) {
      result.harvestable.push(landId);
      const plantId = toNum(plant.id);
      const displayName = getPlantName(plantId);
      const plantExp = getPlantExp(plantId);
      result.harvestableInfo.push({
        landId, plantId,
        name: displayName || plantName,
        exp: plantExp
      });
      continue;
    }

    // 需要浇水（有干旱计数或干燥时间已到）
    const dryNum = toNum(plant.dry_num);
    const dryTime = toTimeSec(currentPhase.dry_time);
    if (dryNum > 0 || (dryTime > 0 && dryTime <= serverTime)) {
      result.needWater.push(landId);
    }

    // 需要除草
    const weedsTime = toTimeSec(currentPhase.weeds_time);
    const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) ||
                     (weedsTime > 0 && weedsTime <= serverTime);
    if (hasWeeds) result.needWeed.push(landId);

    // 需要除虫
    const insectTime = toTimeSec(currentPhase.insect_time);
    const hasInsects = (plant.insect_owners && plant.insect_owners.length > 0) ||
                       (insectTime > 0 && insectTime <= serverTime);
    if (hasInsects) result.needBug.push(landId);

    result.growing.push(landId);
  }

  return result;
}

// ─── 收获后地块分类 ───

function getLandLifecycleState(land) {
  if (!land) return 'unknown';
  const plant = land.plant;
  if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) return 'empty';

  const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
  if (!currentPhase) return 'empty';

  const phase = toNum(currentPhase.phase);
  if (phase === PlantPhase.DEAD) return 'dead';
  if (phase === PlantPhase.UNKNOWN) return 'empty';
  if (phase >= PlantPhase.SEED && phase <= PlantPhase.MATURE) return 'growing';
  return 'unknown';
}

/** 根据最新土地数据分类收获过的地块 */
function classifyHarvestedLandsByMap(landIds, landMap) {
  const removable = [];
  const growing = [];
  const unknown = [];

  for (const landId of landIds) {
    const land = landMap.get(landId);
    if (!land) { unknown.push(landId); continue; }

    const state = getLandLifecycleState(land);
    if (state === 'dead' || state === 'empty') {
      removable.push(landId);
    } else if (state === 'growing') {
      growing.push(landId);
    } else {
      unknown.push(landId);
    }
  }
  return { removable, growing, unknown };
}

/**
 * 收获后解析可铲除的地块（多季作物进入下一季的情况）
 * @param {number[]} harvestedLandIds - 已收获的地块 ID
 * @param {object} harvestResult - harvest 接口的返回结果
 */
async function resolveRemovableHarvestedLands(harvestedLandIds, harvestResult) {
  const landIds = Array.isArray(harvestedLandIds) ? harvestedLandIds.filter(Boolean) : [];
  if (landIds.length === 0) {
    return { removable: [], growing: [], fallbackRemoved: 0 };
  }

  // 先用收获结果中的数据构建土地映射
  const resultLandMap = buildLandMap(harvestResult && harvestResult.land);
  const classified = classifyHarvestedLandsByMap(landIds, resultLandMap);

  const removable = [...classified.removable];
  const growing = [...classified.growing];
  let unknown = [...classified.unknown];
  const fallbackRemoved = 0;

  // 对于未知状态的地块，重新拉取全农场数据
  if (unknown.length > 0) {
    try {
      const landsReply = await getAllLands();
      const freshLandMap = buildLandMap(landsReply && landsReply.lands);
      const reclassified = classifyHarvestedLandsByMap(unknown, freshLandMap);
      removable.push(...reclassified.removable);
      growing.push(...reclassified.growing);
      unknown = reclassified.unknown;
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        logWarn('农场', `收后状态补拉失败: ${err.message}`, {
          module: 'farm', event: '收获后状态补拉', result: 'error'
        });
      }
    }
  }

  // 补拉后依然未知时必须保守跳过。收获响应可能省略 2x2 主地块，
  // 或全量土地响应暂时不完整；把未知状态当成枯死会误铲仍在生长/
  // 进入下一季的合种作物。确认 empty/dead 的地块才允许铲除。
  if (unknown.length > 0) {
    logWarn('农场', `收后仍有 ${unknown.length} 块土地状态未知，已跳过铲除 (${unknown.join(',')})`, {
      module: 'farm',
      event: '收获后状态补拉',
      result: 'skip_unknown',
      landIds: unknown,
    });
  }

  return {
    removable: [...new Set(removable)],
    growing: [...new Set(growing)],
    fallbackRemoved
  };
}

// ─── 地块详情（供前端展示）──

function getLandTypeByLevel(level) {
  const lv = toNum(level);
  if (lv === 5) return 'purple';
  if (lv === 4) return 'gold';
  if (lv === 3) return 'black';
  if (lv === 2) return 'red';
  return 'normal';
}

function getLandTypeNameByLevel(level) {
  const typeMap = {
    purple: '紫土地',
    gold: '金土地',
    black: '黑土地',
    red: '红土地',
    normal: '普通地'
  };
  return typeMap[getLandTypeByLevel(level)] || '';
}

function getQixiDewStatus(plant) {
  const status = plant && plant.field_40;
  const rewardValue = toNum(status && status.value_1);
  const appliedMarker = toNum(status && status.value_2);
  return {
    applied: rewardValue > 0 && appliedMarker > 0,
    rewardValue,
    appliedMarker
  };
}

/**
 * 读取当前账号的职业（收获/偷取）快照，失败时返回 null。
 * 职业信息属于附加展示，不应因为一次失败让整个土地接口不可用。
 */
async function resolveOwnCareerInfo() {
  try {
    // 懒加载：network 依赖较深，避免在模块顶层引入可能的循环依赖。
    const { getUserState } = require('../utils/network');
    const state = getUserState() || {};
    const gid = toNum(state.gid);
    if (gid <= 0) {
      logWarn('土地', `职业信息跳过：userState.gid 无效 (${state.gid})`);
      return null;
    }
    const { getCareerInfo } = require('./career');
    return await getCareerInfo(gid);
  } catch (error) {
    logWarn('土地', `职业信息读取失败，本轮忽略: ${(error && error.message) || error}`);
    return null;
  }
}

async function getLandsDetail(propagateErrors = false) {
  try {
    const landsReply = await getAllLands();
    const socialEvents = buildFarmSocialEventDetails(landsReply);
    const career = await resolveOwnCareerInfo();
    const result = { lands: [], summary: {}, socialEvents, career };
    if (!landsReply.lands) return result;

    const serverTime = getServerTimeSec();
    const details = [];
    const landMap = buildLandMap(landsReply.lands);

    for (const land of landsReply.lands) {
      const landId = toNum(land.id);
      const level = toNum(land.level);
      const maxLevel = toNum(land.max_level);
      const landsLevel = toNum(land.lands_level);
      const landSize = toNum(land.land_size);
      const landType = getLandTypeByLevel(level);
      const landTypeName = getLandTypeNameByLevel(level);
      const couldUnlock = !!land.could_unlock;
      const couldUpgrade = !!land.could_upgrade;

      const { sourceLand, occupiedByMaster, masterLandId, occupiedLandIds } =
        getDisplayLandContext(land, landMap);

      // 合种作物只展示主土地；从属土地的信息已经合并到主土地卡片。
      if (occupiedByMaster) continue;

      // 未解锁
      if (!land.unlocked) {
        details.push({
          id: landId, unlocked: false, status: 'locked',
          plantName: '', phaseName: '',
          level, maxLevel, landsLevel, landSize, landType, landTypeName,
          couldUnlock, couldUpgrade,
          currentSeason: 0, totalSeason: 0,
          occupiedByMaster: false, masterLandId: 0,
          occupiedLandIds: [], plantSize: 1,
          landUpgrade: buildLandUpgradeDetail(land, landMap),
        });
        continue;
      }

      const plant = sourceLand && sourceLand.plant;

      // 空地
      if (!plant || !plant.phases || plant.phases.length === 0) {
        details.push({
          id: landId, unlocked: true, status: 'empty',
          plantName: '', phaseName: '空地',
          level, maxLevel, landsLevel, landSize, landType, landTypeName,
          couldUnlock, couldUpgrade,
          currentSeason: 0, totalSeason: 0,
          occupiedByMaster, masterLandId, occupiedLandIds, plantSize: 1,
          landUpgrade: buildLandUpgradeDetail(land, landMap),
        });
        continue;
      }

      const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
      if (!currentPhase) {
        details.push({
          id: landId, unlocked: true, status: 'empty',
          plantName: '', phaseName: '',
          level, maxLevel, landsLevel, landSize, landType, landTypeName,
          couldUnlock, couldUpgrade,
          currentSeason: 0, totalSeason: 0,
          occupiedByMaster, masterLandId, occupiedLandIds, plantSize: 1,
          landUpgrade: buildLandUpgradeDetail(land, landMap),
        });
        continue;
      }

      const phase = toNum(currentPhase.phase);
      const plantId = toNum(plant.id);
      const mutantConfigIds = getPlantMutantConfigIds(plant, currentPhase);
      const displayPlantId = getMutantDisplayPlantId(plantId, mutantConfigIds);
      const displayName = getPlantName(displayPlantId) || getPlantName(plantId) || plant.name || '未知';
      const plantInfo = getPlantById(plantId);
      const seedId = toNum(plantInfo && plantInfo.seed_id);
      const seedImage = seedId > 0 ? getSeedImageBySeedId(seedId) : '';
      const occupiedPlantSize = occupiedLandIds.length > 1
        ? Math.round(Math.sqrt(occupiedLandIds.length))
        : 1;
      const plantSize = Math.max(
        1,
        toNum(plantInfo && plantInfo.size) || 1,
        occupiedPlantSize
      );
      const plantImage = getMutantPlantImageByPhase(plantId, mutantConfigIds, toNum(currentPhase.image_phase));
      const totalSeason = Math.max(1, toNum(plantInfo && plantInfo.seasons) || 1);
      const rawSeason = toNum(plant.season);
      const currentSeason = rawSeason > 0 ? Math.min(rawSeason, totalSeason) : 1;
      const phaseName = currentPhase.phaseName || PHASE_NAMES[phase] || '';

      // 计算剩余成熟时间
      const maturePhaseData = Array.isArray(plant.phases)
        ? plant.phases
          .filter(p => p && toTimeSec(p.begin_time) > 0)
          .sort((left, right) => toTimeSec(right.begin_time) - toTimeSec(left.begin_time))[0]
        : null;
      const matureTime = maturePhaseData ? toTimeSec(maturePhaseData.begin_time) : 0;
      const matureInSec = matureTime > serverTime ? matureTime - serverTime : 0;
      const totalGrowTime = getPlantGrowTime(plantId);
      const phaseStartTime = toTimeSec(currentPhase.begin_time);
      const nextPhaseData = Array.isArray(plant.phases)
        ? plant.phases
          .filter(item => item && toTimeSec(item.begin_time) > phaseStartTime)
          .sort((left, right) => toTimeSec(left.begin_time) - toTimeSec(right.begin_time))[0]
        : null;
      const phaseEndTime = nextPhaseData ? toTimeSec(nextPhaseData.begin_time) : 0;

      // 确定状态
      let status = 'growing';
      if (phase === PlantPhase.MATURE) status = 'harvestable';
      else if (phase === PlantPhase.DEAD) status = 'dead';
      else if (phase === PlantPhase.UNKNOWN || !plant.phases.length) status = 'empty';

      // 是否需要浇水/除草/除虫
      const needWater = toNum(plant.dry_num) > 0 ||
        (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= serverTime);
      const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) ||
        (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= serverTime);
      const needBug = (plant.insect_owners && plant.insect_owners.length > 0) ||
        (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= serverTime);

      // 变异效果
      const mutantEffects = getMutantEffectsByIds(mutantConfigIds);
      const qixiDew = getQixiDewStatus(plant);

      details.push({
        id: landId, unlocked: true, status,
        plantName: displayName, plantId, displayPlantId, seedId, seedImage, plantImage,
        phase, imagePhase: toNum(currentPhase.image_phase), phaseName, currentSeason, totalSeason,
        matureInSec, totalGrowTime, phaseStartTime, phaseEndTime,
        needWater, needWeed, needBug,
        stealable: !!plant.stealable,
        level, maxLevel, landsLevel, landSize, landType, landTypeName,
        couldUnlock, couldUpgrade,
        occupiedByMaster, masterLandId, occupiedLandIds,
        landUpgrade: buildLandUpgradeDetail(land, landMap),
        plantSize, mutantEffects, qixiDew
      });
    }

    return { lands: details, summary: summarizeLandDetails(details), socialEvents, career };
  } catch (error) {
    if (propagateErrors) throw error;
    return { lands: [], summary: {}, socialEvents: [], career: null };
  }
}

module.exports = {
  getCurrentPhase,
  convertServerPhaseToClient,
  buildLandMap,
  getPlantMutantConfigIds,
  getDisplayLandContext,
  isOccupiedSlaveLand,
  analyzeLands,
  resolveRemovableHarvestedLands,
  getQixiDewStatus,
  getLandsDetail,
  int64String,
  normalizePositiveId,
  getPlantExtendedStatuses,
  getInteractionItemMetadata,
  getPlantInteractionEffects,
  hasOwnerCleanableInteraction,
  getCleanableFarmSocialEventItemIds,
  buildFarmSocialEventDetails,
  buildLandDetail
};
