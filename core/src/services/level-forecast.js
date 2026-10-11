/**
 * 按已种植作物预测升级时间。
 *
 * 移植自上游 core/src/services/level-forecast.ts（TypeScript → CommonJS）。
 * 模块本身无状态，除「最近一次土地快照」外不持有全局可变数据。
 *
 * 预测口径（与上游一致，注释一并保留以便对照）：
 *  - 只统计当前这一季有服务端成熟时间的作物（planted）；
 *  - 缺失服务端经验加成时视为「未知」而非按土色猜 0，避免虚高；
 *  - 历史均值只在本轮已种作物排期用完之后才作为补充估算，
 *    不会把过去已经发生过的收获速率与未来排期重复计算；
 *  - 自动收获关闭时不给「历史均值」兜底时间，因为那时收获时间由人工决定。
 *
 *  与上游的一处差异：本项目没有「农场静默时段」开关（只有好友侧的
 *  inFriendQuietHours），因此 getLevelForecast 的 quiet 由调用方传 false。
 */
const { getPlantById } = require('../config/gameConfig');
const { getServerTimeSec } = require('../utils/utils');

// 土地快照的最长有效期：超过这个时间就宁可退回「等待预测数据」，
// 也不拿一份可能已经过期的地块状态去推算升级时间。
const SNAPSHOT_MAX_AGE_SEC = 180;
// 会话时长不足这个秒数时，不用历史均值外推（样本太少，噪声大）。
const HISTORY_MIN_SECONDS = 60;

const num = (value) => Number(value && value.toString ? value.toString() : value) || 0;
// 协议时间戳可能是毫秒也可能是秒，统一成秒。
const seconds = (value) => (num(value) > 1e12 ? Math.floor(num(value) / 1000) : num(value));

/**
 * 收集本轮所有「收获时会带来经验」的地块及其成熟时刻。
 * 每块地只计一次；子地（slave）与其主地（master）不能重复计数。
 */
function buildHarvestEvents(lands, nowSec, getPlant = getPlantById) {
  const events = [];
  const seen = new Set();
  const slaves = new Set();
  for (const land of lands) for (const id of land.slave_land_ids || []) slaves.add(num(id));
  for (const land of lands) {
    const id = num(land.id);
    const master = num(land.master_land_id);
    // 未解锁、是子地、或挂在别的主地上（子地本身）都跳过
    if (!id || seen.has(id) || !land.unlocked || slaves.has(id) || (master && master !== id)) continue;
    seen.add(id);
    const plant = land.plant;
    if (!plant || !Array.isArray(plant.phases)) continue;
    const phases = plant.phases.filter((phase) => seconds(phase.begin_time) > 0);
    // 协议返回的 phases 从「当前所处阶段」开始，并非完整生长序列，时钟不会推进这个状态。
    // phase=7 是枯死、0 是未知，都不参与升级收益估算。
    const current = plant.phases[0];
    if (current && (num(current.phase) === 7 || num(current.phase) === 0)) continue;
    const config = getPlant(num(plant.id));
    const configuredPhases = String((config && config.grow_phases) || '').split(';').filter(Boolean);
    const finalName = configuredPhases.length ? configuredPhases[configuredPhases.length - 1].split(':')[0] : '';
    // 显式成熟标记：phase 6/19 或 phase_id 19
    const explicitMature = phases.find((phase) => [6, 19].includes(num(phase.phase)) || num(phase.phase_id) === 19);
    const finalPhase = phases[phases.length - 1];
    const mature = explicitMature || (['成熟', '盛开'].includes(finalName)
      && plant.phases.length <= configuredPhases.length && num(finalPhase && finalPhase.phase) === 2 ? finalPhase : null);
    if (!mature) continue;
    // 服务端没下发经验加成时是「未知」，不能按土地颜色猜成 0，那会让预测结果虚高。
    if (!config || !land.buff || !Number.isFinite(Number(land.buff.plant_exp_bonus))) continue;
    const exp = Math.floor(num(config.exp) * (1 + Math.max(0, num(land.buff.plant_exp_bonus)) / 10000));
    if (exp <= 0) continue;
    events.push({ landId: id, at: Math.max(nowSec, seconds(mature.begin_time)), exp });
  }
  return events.sort((a, b) => a.at - b.at || a.landId - b.landId);
}

/**
 * 核心计算：给定土地快照与剩余经验，算出预计什么时候能升级。
 *
 * 返回的 source 决定前端文案：
 *   ready     已够经验，收获后立刻可升
 *   planted   靠当前已种作物的收获排期凑够
 *   mixed     排期不够，剩下的用历史均值补
 *   history   完全靠历史均值外推
 *   unavailable 不可用（未连接 / 已满级 / 无数据）
 */
function calculateLevelForecast(options) {
  const { nowSec } = options;
  const remainingExp = Math.max(0, num(options.remainingExp));
  const base = {
    generatedAt: nowSec * 1000,
    remainingExp,
    scheduledExp: 0,
    plotCount: 0,
    readyExp: 0,
    estimatedAt: null,
    source: 'unavailable',
    automatic: !!options.autoHarvest && !options.quiet,
  };
  if (!options.connected || remainingExp <= 0) return base;

  const events = buildHarvestEvents(options.lands || [], nowSec, options.getPlant);
  base.scheduledExp = events.reduce((sum, event) => sum + event.exp, 0);
  base.plotCount = events.length;
  base.readyExp = events.filter((event) => event.at <= nowSec).reduce((sum, event) => sum + event.exp, 0);

  // 逐个累加收获事件，第一次凑够剩余经验时即得到预计时刻
  let total = 0;
  for (const event of events) {
    total += event.exp;
    if (total >= remainingExp) {
      return { ...base, source: event.at <= nowSec ? 'ready' : 'planted', estimatedAt: event.at * 1000 };
    }
  }

  // 走到这里说明「本轮已种作物全部收获」仍不够升级。
  // 此时才用历史均值补剩余缺口，且从最后一次已知收获时刻往后推，
  // 避免把已发生过的收获速率和未来排期重复计算一遍。
  const rate = Math.max(0, num(options.historyRate));
  if (rate <= 0 || !base.automatic) return base;
  const startAt = events.length ? events[events.length - 1].at : nowSec;
  const estimatedAt = (startAt + Math.ceil((remainingExp - total) / rate * 3600)) * 1000;
  return { ...base, source: events.length ? 'mixed' : 'history', estimatedAt };
}

// ===== 土地快照记忆 =====
// status_sync 是定时触发的，本身不携带地块数据；最近一次进农场拿到的 lands
// 缓存在这里，供预测使用。revision 用于在游戏推送「地块已变化」时作废旧快照。

let revision = 0;
let snapshot = null;

function invalidateLandForecast() {
  snapshot = null;
  revision++;
}

function getLandForecastRevision() {
  return revision;
}

/**
 * 记住一次进农场拿到的地块数据。
 * 若期间收到过失效通知（revision 变化），说明这份快照可能已经过期，直接丢弃。
 */
function rememberLandForecast(lands, user, expectedRevision) {
  if (revision !== expectedRevision || !Array.isArray(lands)) return;
  snapshot = { lands, gid: num(user.gid), exp: num(user.exp), at: getServerTimeSec() };
}

/**
 * 对外入口：结合用户等级进度、农场统计和自动化开关，产出面板用的预测数据。
 */
function getLevelForecast(user, progress, stats, automation, quiet) {
  const nowSec = getServerTimeSec();
  // 快照必须与当前账号、当前经验对得上，且拍摄时间在服务器时钟之后且未过期
  const valid = snapshot && snapshot.gid === num(user.gid) && snapshot.exp === num(user.exp)
    && nowSec >= snapshot.at && nowSec - snapshot.at <= SNAPSHOT_MAX_AGE_SEC;
  const sessionSeconds = Math.max(0, num(stats.sessionElapsedSeconds));
  return calculateLevelForecast({
    lands: valid ? snapshot.lands : [],
    nowSec,
    remainingExp: progress ? num(progress.needed) - num(progress.current) : 0,
    // 历史均值折算成「每小时经验」，会话太短则不启用
    historyRate: sessionSeconds >= HISTORY_MIN_SECONDS
      ? Math.max(0, num(stats.sessionExpGained)) / sessionSeconds * 3600
      : 0,
    connected: !!(stats.connection && stats.connection.connected),
    autoHarvest: !!(automation && automation.farm),
    quiet,
  });
}

module.exports = {
  buildHarvestEvents,
  calculateLevelForecast,
  invalidateLandForecast,
  getLandForecastRevision,
  rememberLandForecast,
  getLevelForecast,
};