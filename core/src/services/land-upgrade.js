/**
 * 土地升级详情
 *
 * 移植自 muyuewang/qq-farm-bot-li 的 core/src/services/farm/land-upgrade.ts，
 * 按本仓库 CommonJS 风格改写。
 *
 * 依据服务端下发的土地信息（unlock_condition / upgrade_condition / could_unlock /
 * could_upgrade）计算当前等级、下一等级、升级条件与消耗；本地LandLevel.json 与
 * LandLevelNeed.json 仅在服务端未下发条件时作为兜底。
 */
const levels = require('../gameConfig/LandLevel.json');
const upgradeCosts = require('../gameConfig/LandLevelNeed.json');
const { getItemById, getSeedImageBySeedId } = require('../config/gameConfig');

const number = (value) => Number(value?.toString?.() ?? value) || 0;
// 数量保持字符串，避免大数被float 精度截断
const amount = (value) => (/^\d+$/.test(String(value)) ? String(value) : '0');

function levelInfo(level, buff) {
    const config = levels.find((entry) => entry.id === level);
    if (!config) return null;
    return {
        level,
        name: config.level_name,
        image: `/land-assets/${level}.png`,
        yieldBonus: number(buff?.plant_yield_bonus ?? config.plant_yield_bonus) / 100,
        growthReduction: number(buff?.planting_time_reduction ?? config.planting_time_reduction) / 100,
        expBonus: number(buff?.plant_exp_bonus ?? config.plant_exp_bonus) / 100,
        mutantMultiplier: number(config.plant_mutant_bonus) / 10000,
        resonanceBonus: number(config.plant_mutant_exp_bonus) / 100
    };
}

function buildCosts(items) {
    return (Array.isArray(items) ? items : [])
        .filter((item) => number(item.id) > 0 && number(item.count) > 0)
        .map((item) => ({
            id: String(item.id),
            count: amount(item.count),
            name: getItemById(number(item.id))?.name || `物品 ${item.id}`,
            image: getSeedImageBySeedId(number(item.id)) || ''
        }));
}

/**
 * 构建单块土地的升级详情
 * @param {any} land 服务端下发的土地信息
 * @param {Map<number, any>} landsMap 全部土地，用于判断前置地块是否已解锁
 * @returns {object} mode: unlock未解锁 / upgrade可升级 / max已满级
 */
function buildLandUpgradeDetail(land, landsMap = new Map()) {
    const id = number(land?.id);
    const level = number(land?.level);
    const maxLevel = number(land?.max_level);
    const current = land?.unlocked ? levelInfo(level, land.buff) : null;

    // 未解锁：说明前置地块与所需等级，金币为解锁费用
    if (!land?.unlocked) {
        const condition = land?.unlock_condition;
        const precedingId = number(condition?.preceding_land_id);
        return {
            mode: 'unlock',
            current,
            next: levelInfo(1),
            serverAllowed: !!land?.could_unlock,
            needLevel: condition ? number(condition.need_level) : null,
            prerequisite: precedingId
                ? { landId: precedingId, met: !!landsMap.get(precedingId)?.unlocked }
                : null,
            costs: buildCosts([{ id: 1001, count: condition?.need_gold }]),
            unknown: !condition
        };
    }

    // 已满级：current 取实际等级信息（LandLevel.json 缺失时才为 null）
    if (maxLevel > 0 && level >= maxLevel) {
        return {
            mode: 'max',
            current: current || levelInfo(maxLevel || level),
            next: null,
            serverAllowed: false,
            costs: [],
            unknown: !current && !levelInfo(maxLevel || level)
        };
    }

    // 可升级：优先用服务端条件，缺失时回退本地配置
    const next = levelInfo(level + 1);
    const condition = land?.upgrade_condition;
    const config = upgradeCosts.find((entry) => entry.land_id === id && entry.level === level + 1);
    const configItems = String(config?.items_need || '')
        .split(';')
        .filter(Boolean)
        .map((part) => {
            const [itemId, count] = part.split(':');
            return { id: itemId, count };
        });
    const conditionType = number(condition?.condition_type);

    return {
        mode: 'upgrade',
        current,
        next,
        serverAllowed: !!land?.could_upgrade,
        needLevel: condition
            ? (conditionType === 1 ? number(condition.condition_value) : null)
            : (config?.level_need ?? null),
        prerequisite: null,
        costs: buildCosts(condition ? (condition.required_items || []) : configItems),
        unknown: !next || (condition ? conditionType !== 1 : !config)
    };
}

module.exports = { buildLandUpgradeDetail };