/**
 * 雨落成诗（天气活动）管理端路由。
 *
 * 移植自上游 core/src/controllers/admin/activity-center/weather-routes.ts。
 * 路径与上游保持一致，前端可直接复用。
 *
 * 未移植的上游悬空接口：上游路由里还有 research/light、bottle/buy、
 * bottle/collect、rain/summon 四个路径，它们在 provider/worker 里指向
 * services/activity-center 的 buyWeatherBottle / collectWeatherBottle /
 * lightWeatherResearch / summonWeatherRain，而该模块并不存在（上游自身遗留），
 * 因此不在此处注册，避免注册出必然 500 的死路由。
 */
const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');

function registerAdminWeatherActivityRoutes({ app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError }) {
  const context = { getAccountIdFromRequest, canAccessAccount };

  const run = (handler, notConnectedMessage) => async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, context);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, notConnectedMessage)) return;
      const result = await handler(req, accountId);
      res.json({ ok: true, data: result });
    } catch (error) {
      sendProviderError(res, error);
    }
  };

  app.get('/api/activity-center/weather', run(
    (req, accountId) => provider.getCurrentWeatherActivity(accountId),
    '获取天气活动失败: 账号未运行',
  ));

  app.get('/api/activity-center/weather/friends', run(
    (req, accountId) => provider.getWeatherFriends(accountId),
    '获取好友天气列表失败: 账号未运行',
  ));

  app.post('/api/activity-center/weather/shop/exchange', run(
    (req, accountId) => provider.exchangeWeatherCollectorBottle(accountId),
    '兑换天气采集瓶失败: 账号未运行',
  ));

  app.post('/api/activity-center/weather/friends/scan', run(
    (req, accountId) => provider.scanWeatherFriends(
      accountId,
      req.body?.friendGids ?? req.body?.friend_gids ?? req.body?.gids,
    ),
    '扫描好友天气失败: 账号未运行',
  ));

  app.post('/api/activity-center/weather/collect', run(
    (req, accountId) => provider.useWeatherCollectorBottle(accountId, req.body?.friendGid),
    '使用天气采集瓶失败: 账号未运行',
  ));

  app.post('/api/activity-center/weather/summon', run(
    (req, accountId) => provider.useWeatherSummonBottle(accountId),
    '使用雷雨召唤瓶失败: 账号未运行',
  ));

  app.post('/api/activity-center/weather/mischief/frog', run(
    (req, accountId) => provider.useWeatherFrogBottle(accountId, req.body?.friendGid),
    '使用青蛙使坏瓶失败: 账号未运行',
  ));

  app.post('/api/activity-center/weather/mischief/cloud', run(
    (req, accountId) => provider.useWeatherCloudBottle(accountId, req.body?.friendGid, req.body?.landId),
    '使用乌云使坏瓶失败: 账号未运行',
  ));

  app.post('/api/activity-center/weather/research/:nodeId/advance', run(
    (req, accountId) => {
      const nodeId = String(req.params.nodeId || '');
      if (!/^[1-9]\d*$/.test(nodeId)) {
        const err = new Error('nodeId 必须是正十进制整数');
        err.statusCode = 400;
        throw err;
      }
      return provider.advanceWeatherResearch(accountId, nodeId);
    },
    '推进气象研究失败: 账号未运行',
  ));
}

module.exports = { registerAdminWeatherActivityRoutes };
