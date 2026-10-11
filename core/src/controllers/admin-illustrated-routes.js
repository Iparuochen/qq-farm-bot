const {
  buildIllustratedItem,
  getSeedShopGoodsMap,
  getUserLevel,
  sortIllustratedItems,
  summarizeIllustratedItems,
} = require("./admin-illustrated-helpers");
const {
  registerAdminIllustratedPurchaseRoutes,
} = require("./admin-illustrated-purchase-routes");
const { getNongmePlantData } = require("../services/nongme-plant-data");
const {
  getIllustratedBuffs,
  getIllustratedBuffsByLevel,
} = require("../config/gameConfig");

function getAuthorizedAccountId(req, res, { getAccountIdFromRequest, canAccessAccount }) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({
      ok: false,
      error: "Missing x-account-id",
    });
    return null;
  }

  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({
      ok: false,
      error: "无权访问此账号",
    });
    return null;
  }

  return accountId;
}

function registerAdminIllustratedRoutes({
  app,
  provider,
  adminLogger,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const routeContext = {
    provider,
    adminLogger,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  };

  registerAdminIllustratedPurchaseRoutes({
    app,
    ...routeContext,
  });

  app.get("/api/illustrated", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      const refresh = req.query.refresh === "true";
      const illustratedType = Number(req.query.illustrated_type) || 1;
      const userLevel = getUserLevel(provider, accountId);

      adminLogger.info("获取图鉴列表请求", {
        accountId,
        refresh,
        illustratedType,
      });

      // 面板按「作物图鉴 / 变异图鉴」两个分组读取，这里一次性取回两组数据。
      // 等级奖励列表为可选增强项，请求失败时不影响主流程。
      const [seedGoodsMap, cropReply, mutantReply, nongmeData] = await Promise.all([
        getSeedShopGoodsMap({
          provider,
          accountId,
          adminLogger,
          tolerateFailure: true,
        }),
        provider.getIllustratedList(accountId, refresh, illustratedType),
        provider.getIllustratedList(accountId, refresh, illustratedType === 2 ? 1 : 2)
          .catch(() => null),
        getNongmePlantData(refresh),
      ]);

      const [cropLevels, mutantLevels] = await Promise.all([
        provider.getIllustratedLevels(accountId, 1).catch(() => null),
        provider.getIllustratedLevels(accountId, 2).catch(() => null),
      ]);

      adminLogger.info("图鉴列表数据", {
        itemsCount: cropReply?.items?.length || 0,
        hasRaw: !!cropReply?.__raw,
        rawCount: cropReply?.__raw?.rawItemCount || 0,
      });

      const buildBook = (reply, type, levelsReply) => {
        const list = sortIllustratedItems(
          (reply?.items || []).map(item =>
            buildIllustratedItem(item, {
              seedGoodsMap,
              userLevel,
              adminLogger,
              nongmeFruitMap: nongmeData.byFruitId,
            }),
          ),
        )
        const level = Number(reply?.level) || 0
        return {
          items: list,
          summary: summarizeIllustratedItems(list),
          userLevel,
          type,
          level,
          // 面板进度条读的是 progress / nextLevelProgress（本仓库字段名为 current_score / next_score）
          progress: Number(reply?.current_score) || 0,
          nextLevelProgress: Number(reply?.next_score) || 0,
          currentScore: Number(reply?.current_score) || 0,
          nextScore: Number(reply?.next_score) || 0,
          // 超变图鉴(type=2)展示等级加成；作物图鉴不展示
          buffs: type === 2 ? getIllustratedBuffs() : [],
          currentBuffs: type === 2 ? getIllustratedBuffsByLevel(level) : [],
          // 图鉴等级奖励列表（详情弹窗用），未取到时传空数组，面板有兜底。
          levels: Array.isArray(levelsReply?.levels) ? levelsReply.levels : [],
          // 面板对这些字段做了 Array.isArray 兜底，本仓库暂未提供时传空即可。
          currentBonus: null,
          attributeBonuses: [],
        }
      }

      // cropReply 为请求类型对应的返回，mutantReply 为另一种类型的返回；
      // 无论请求哪种类型，作物图鉴恒为 type=1、超变图鉴恒为 type=2。
      const crop = buildBook(illustratedType === 2 ? mutantReply : cropReply, 1, cropLevels)
      const mutant = buildBook(illustratedType === 2 ? cropReply : mutantReply, 2, mutantLevels)
      const items = crop.items
      const summary = crop.summary

      adminLogger.info("图鉴列表返回", {
        total: summary.total,
        unlocked: summary.unlocked,
        canBuy: summary.canBuy,
        userLevel,
        cropItems: crop.items.length,
        mutantItems: mutant.items.length,
        mutantGroups: ["gold", "decoration", "activity"].map(group => ({
          group,
          count: mutant.items.filter(item => item.group === group).length,
        })),
      });

      res.json({
        ok: true,
        data: {
          // 面板按分组读取（crop / mutant）
          crop,
          mutant,
          // 同时保留原有扁平字段，便于其它调用方继续读取
          items,
          summary,
          userLevel,
          level: crop.level,
          currentScore: crop.currentScore,
          nextScore: crop.nextScore,
        },
      });
    } catch (err) {
      adminLogger.error("获取图鉴列表失败", {
        error: err.message,
        stack: err.stack,
      });
      sendProviderError(res, err);
    }
  });
}

module.exports = { registerAdminIllustratedRoutes };
