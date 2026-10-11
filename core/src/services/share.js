/**
 * 分享服务 - 每日自动完成分享并领取奖励
 *
 * 功能：
 * - 检查是否可以分享
 * - 上报分享状态
 * - 领取分享奖励
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');

const DAILY_KEY = 'daily_share';

// 两次检查最小间隔：10分钟
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

// 每日状态追踪
let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function markDoneToday() {
  doneDateKey = getDateKey();
}

function isDoneToday() {
  return doneDateKey === getDateKey();
}

// ---- 奖励摘要 ----
// 1001→金币, 1002→经验, 500→点券

function getRewardSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (const item of list) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (count <= 0) continue;
    if (id === 1001 || id === 500001) {
      parts.push(`金币${count}`);
    } else if (id === 1002 || id === 500002) {
      parts.push(`经验${count}`);
    } else if (id === 500) {
      parts.push(`点券${count}`);
    } else {
      const info = getItemById(id);
      const name = info && info.name ? String(info.name) : `物品#${id}`;
      parts.push(`${name}x${count}`);
    }
  }
  return parts.join('/');
}

/**
 * 判断是否"已领取"错误
 */
function isAlreadyClaimedError(err) {
  const msg = String(err && err.message || '');
  return msg.includes('code=1009001') || msg.includes('已经领取');
}

// ---- RPC 调用 ----

async function checkCanShare() {
  const request = types.CheckCanShareRequest.encode(
    types.CheckCanShareRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', request);
  return types.CheckCanShareReply.decode(body);
}

// 每日分享固定使用 来源=1 / 场景=42（对照上游 services/share.ts reportShare）
const DAILY_SHARE_SOURCE = 1;
const DAILY_SHARE_SCENE = 42;

async function reportShare() {
  const request = types.ReportShareRequest.encode(
    types.ReportShareRequest.create({
      field_1: DAILY_SHARE_SOURCE,
      field_4: DAILY_SHARE_SCENE,
    })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', request);
  // 回复的字段 1 是 bytes result，没有 success 语义。
  // 只要请求没有抛异常就认为上报成功——这是上游的做法，
  // 早期版本误判 result.success 导致每天都刷「上报分享状态失败」。
  types.ReportShareReply.decode(body);
  return true;
}

async function claimShareReward() {
  const request = types.ClaimShareRewardRequest.encode(
    types.ClaimShareRewardRequest.create({ claimed: true })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ClaimShareReward', request);
  return types.ClaimShareRewardReply.decode(body);
}

// ---- 主逻辑 ----

/**
 * 执行每日分享任务
 * @param {boolean} force - 强制检查
 */
async function performDailyShare(force = false) {
  const now = Date.now();

  if (!force && isDoneToday()) return false;
  if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;

  lastCheckAt = now;

  try {
    // 检查是否可以分享
    const canShareResult = await checkCanShare();
    if (!canShareResult || !canShareResult.can_share) {
      log('分享', '今日暂无可领取分享礼包', { module: 'task', event: DAILY_KEY, result: 'none' });
      return false;
    }

    // 上报分享（请求不抛异常即成功，reply 无 success 字段可判断）
    await reportShare();

    // 领取奖励
    let claimResult = null;
    try {
      claimResult = await claimShareReward();
    } catch (err) {
      if (isAlreadyClaimedError(err)) {
        markDoneToday();
        log('分享', '今日分享奖励已领取', { module: 'task', event: DAILY_KEY, result: 'none' });
        return false;
      }
      throw err;
    }

    if (!claimResult || !claimResult.success) {
      log('分享', '领取分享礼包失败', { module: 'task', event: DAILY_KEY, result: 'error' });
      return false;
    }

    const items = Array.isArray(claimResult.items) ? claimResult.items : [];
    const summary = getRewardSummary(items);

    log('分享',
      summary ? `领取成功 → ${summary}` : '领取成功',
      { module: 'task', event: DAILY_KEY, result: 'ok', count: items.length }
    );

    lastClaimAt = Date.now();
    markDoneToday();
    return true;
  } catch (err) {
    log('分享', `领取失败: ${err.message}`, { module: 'task', event: DAILY_KEY, result: 'error' });
    return false;
  }
}

module.exports = {
  performDailyShare,
  getShareDailyState: () => ({
    key: DAILY_KEY,
    doneToday: isDoneToday(),
    lastCheckAt,
    lastClaimAt,
  }),
};
