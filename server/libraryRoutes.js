const express = require('express');
const {createContentLifecycle} = require('./contentLifecycle');
const service = createContentLifecycle();
const router = express.Router();
const handle = fn => (req,res,next) => {try {res.json(fn(req));} catch(e) {e.status ||= 409;next(e);} };
router.use((req,res,next)=>{
  if (req.method !== 'GET' && ((req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) || !req.is('application/json'))) return res.status(403).json({error:'内容整理需要同源 JSON 请求'});
  next();
});
router.get('/',handle(r=>service.list(r.query)));
router.get('/cleanup-preview',handle(()=>service.cleanupPreview()));
router.post('/close-old',handle(r=>service.closeOld(r.body)));
router.get('/:kind/:id/impact',handle(r=>service.impact(r.params.kind,r.params.id)));
router.post('/:kind/:id/:action',handle(r=>r.params.action==='purge'?service.purge(r.params.kind,r.params.id,r.body):service.change(r.params.kind,r.params.id,r.params.action,r.body)));
router.post('/batch',handle(r=>{
  if (!Array.isArray(r.body.items)||!r.body.items.length||r.body.items.length>100||!['archive','trash','restore','purge'].includes(r.body.action)) throw Error('批量操作需选择1至100条内容及有效动作');
  return {results:r.body.items.map(item=>{try {return {...item,...(r.body.action==='purge'?service.purge(item.kind,item.id,{confirmed:r.body.confirmed,cancelPending:r.body.cancelPending===true}):service.change(item.kind,item.id,r.body.action,{cancelPending:r.body.cancelPending===true}))};}catch(e){return {...item,ok:false,error:e.message};}})};
}));
module.exports = router;
