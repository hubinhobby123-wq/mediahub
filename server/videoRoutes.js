const express = require('express');
const { createVideoService } = require('./videoService');
const service = createVideoService();
const router = express.Router();
router.use((req, res, next) => {
  if (req.method !== 'GET') {
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return res.status(403).json({ error: '视频操作拒绝跨来源请求' });
    if (!req.is('application/json')) return res.status(415).json({ error: '视频操作需要JSON请求' });
  }
  next();
});
const endpoint = fn => async (req,res,next) => { try { res.json(await fn(req)); } catch (e) { e.status ||= 400; next(e); } };
router.get('/', endpoint(() => service.snapshot()));
router.post('/import', endpoint(r => service.importPackage(r.body.manifestPath)));
router.post('/bind', endpoint(r => service.bind(r.body)));
router.post('/batch/plan', endpoint(r => service.planBatch(r.body)));
router.post('/batch/prepare', endpoint(r => service.prepareBatch(r.body)));
router.post('/batch/deliver', endpoint(r => service.deliverBatch(r.body)));
router.post('/jobs/:id/reconcile', endpoint(r => service.reconcile(r.params.id, r.body)));
router.post('/jobs/:id/remote', endpoint(r => service.setRemote(r.params.id, r.body)));
router.post('/jobs/:id/approve', endpoint(r => service.approve(r.params.id, r.body)));
router.post('/jobs/:id/cancel', endpoint(r => service.cancel(r.params.id)));
router.post('/jobs/:id/public', endpoint(r => service.markPublic(r.params.id, r.body)));
router.post('/jobs/:id/inspect', endpoint(r => service.inspect(r.params.id)));
router.post('/jobs/:id/draft', endpoint(r => service.uploadDraft(r.params.id)));
router.post('/jobs/:id/deliver', endpoint(r => service.deliverNonPublic(r.params.id, r.body)));
router.post('/jobs/:id/browser-begin', endpoint(r => service.beginBrowserDelivery(r.params.id, r.body)));
router.post('/jobs/:id/browser-finish', endpoint(r => service.finishBrowserDelivery(r.params.id, r.body)));
router.post('/jobs/:id/browser-block', endpoint(r => service.blockBrowserDelivery(r.params.id, r.body)));
router.post('/jobs/:id/release-authorize', endpoint(r=>service.authorizeAgentRelease(r.params.id,r.body)));
router.post('/jobs/:id/release-begin', endpoint(r=>service.beginBrowserRelease(r.params.id,r.body)));
router.post('/jobs/:id/release-submitting', endpoint(r=>service.submittingBrowserRelease(r.params.id,r.body)));
router.post('/jobs/:id/release-finish', endpoint(r=>service.finishBrowserRelease(r.params.id,r.body)));
router.post('/jobs/:id/release-observe', endpoint(r=>service.observeBrowserPublic(r.params.id,r.body)));
router.post('/jobs/:id/release-block', endpoint(r=>service.blockBrowserRelease(r.params.id,r.body)));
router.post('/jobs/:id/adopt-public-attempt', endpoint(r=>service.adoptPublicAttempt(r.params.id,r.body)));
router.get('/packages/:id/units/:unit/artifacts/:kind', async (req,res,next) => {
  try {
    const p = service.pkg(req.params.id); const unit = p.units.find(x => x.unit_id === req.params.unit);
    const a = unit?.artifacts[req.params.kind];
    if (!a) return res.status(404).json({ error: '素材不存在' });
    res.sendFile(a.absolutePath);
  } catch (e) { next(e); }
});
function startScheduler() {
  service.recover();
  setInterval(() => service.tick().catch(e => console.error('[视频排期]', e.message)), 30000).unref();
}
module.exports = { router, service, startScheduler };
