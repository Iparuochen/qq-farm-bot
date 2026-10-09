function requireAccountAccess({
  req,
  res,
  getAccountIdFromRequest,
  canAccessAccount,
  includeMissingMessage = true,
}) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    const payload = { ok: false };
    if (includeMissingMessage) payload.error = "Missing x-account-id";
    res.status(400).json(payload);
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

function requireLandId(req, res) {
  const { landId } = req.body || {};
  if (!landId) {
    res.status(400).json({ ok: false, error: "缺少土地ID" });
    return null;
  }
  return Number(landId);
}

function registerAdminFarmOperationRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.post("/api/farm/operate", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      const { opType } = req.body;
      await provider.doFarmOp(accountId, opType);
      res.json({ ok: true });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/land/fertilize", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const landId = requireLandId(req, res);
      if (!landId) return;

      const data = await provider.fertilizeLand(accountId, landId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/land/remove", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const landId = requireLandId(req, res);
      if (!landId) return;

      const data = await provider.removePlant(accountId, landId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/land/remove-all", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const data = await provider.removeAllPlants(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  // 背包中当前可对自己农场使用的特殊互动道具。
  app.get("/api/farm/interaction-items", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const data = await provider.getSelfInteractionItems(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  // 在自己农场按地块编号顺序使用特殊互动道具。
  app.post("/api/farm/interaction-items/use-batch", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const data = await provider.useSelfInteractionItemBatch(
        accountId,
        (req.body || {}).itemId,
        (req.body || {}).landIds,
      );
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminFarmOperationRoutes };
