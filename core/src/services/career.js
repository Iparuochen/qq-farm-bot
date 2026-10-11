const { getItemById, getItemImageById, getPlantByFruitId } = require('../config/gameConfig');
const { types } = require('../utils/proto');
const { sendMsgAsync } = require('../utils/network');
const { toNum } = require('../utils/utils');

async function getCareerInfo(gid) {
  const numericGid = toNum(gid);
  if (!numericGid) throw new Error('缺少有效的角色 GID');

  const payload = types.CareerInfoGetRequest.encode(
    types.CareerInfoGetRequest.create({ gid: numericGid }),
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.careerpb.CareerService',
    'CareerInfoGet',
    payload,
  );
  const reply = types.CareerInfoGetReply.decode(body);

  const items = (reply.harvest_items || []).map((item) => {
    const fruitId = toNum(item.fruit_id);
    const config = getItemById(fruitId);
    const plant = getPlantByFruitId(fruitId);
    return {
      seedId: fruitId,
      fruitId,
      name: config?.name || plant?.name || `果实${fruitId}`,
      image: getItemImageById(fruitId),
      harvestCount: toNum(item.harvest_count),
    };
  });

  const totalHarvestCount = toNum(reply.total_harvest_count);
  const totalStealCount = toNum(reply.total_steal_count);

  return {
    items,
    totalHarvestCount,
    totalStealCount,
    // 前端 CareerHarvestSteal.vue 按 harvest / steal 取值（生涯收获、生涯偷菜、收偷比），
    // 这里与协议字段名并存，避免各处自行换算。
    harvest: totalHarvestCount,
    steal: totalStealCount,
    name: String(reply.name || ''),
    avatar: String(reply.avatar_url || ''),
    level: toNum(reply.level),
    exp: toNum(reply.exp),
    gid: toNum(reply.gid) || numericGid,
    platform: toNum(reply.platform),
    openId: String(reply.open_id || ''),
  };
}

/**
 * 查询生涯信息，失败时返回 null 而不是抛错。
 * 好友详情弹窗用它在每张土地卡片上方展示「生涯收获 / 生涯偷菜 / 收偷比」，
 * 查询失败不应影响土地数据的正常展示。
 */
async function getCareerInfoOrNull(gid, propagateErrors = false) {
  try {
    return await getCareerInfo(gid);
  } catch (error) {
    if (propagateErrors) throw error;
    console.warn('[生涯] 查询失败:', error && error.message ? error.message : error);
    return null;
  }
}

module.exports = { getCareerInfo, getCareerInfoOrNull };
