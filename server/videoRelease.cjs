// Public-release evidence contract. A toast or owner playback is not public proof.
const crypto = require('node:crypto');
const PLATFORMS = new Set(['douyin', 'kuaishou', 'xiaohongshu']);
const POLICY = Object.freeze({topics:'related_visible_heat', originality:'eligible_and_terms_authorized', declarations:'factual', otherFields:'applicable_only'});
function settings(value = {}) {
  const result = {...POLICY};
  for (const key of Object.keys(POLICY)) if (value[key] && value[key] !== POLICY[key]) throw Error('不支持不相关热点、虚假原创或盲选所有设置');
  return result;
}
function validateObservation(j, value, { expectedOwner = null, requirePublic = false } = {}) {
  if (!value || value.remoteId !== j.remote?.id || value.ownerConfirmed !== true || !String(value.observedAccountId || '').trim() || !String(value.evidence || '').trim()) throw Error('缺少准确作品、真实账号及可见性证据');
  if (expectedOwner && value.observedAccountId !== expectedOwner) throw Error('实际账号与公开授权身份不符');
  if (!['private','public','pending_review'].includes(value.state)) throw Error('无法核实可见性，禁止提交或判定成功');
  if (requirePublic && value.state !== 'public') throw Error('作品尚未核实为公开');
  if (value.state === 'public' && (value.visibility !== 'public' || value.reviewStatus !== 'passed' || value.reopened !== true)) throw Error('公开确认须重新打开准确作品，且可见性公开、审核通过');
  if (value.nativeScheduled !== false) throw Error('需要明确排除平台原生定时，禁止未知双调度');
  return {
    remoteId:value.remoteId, observedAccountId:String(value.observedAccountId), state:value.state,
    visibility:value.visibility || null, reviewStatus:value.reviewStatus || null,
    reopened:value.reopened === true, evidence:String(value.evidence),
    contentFingerprint:value.contentFingerprint || null, settings:value.settings || null,
  };
}
function lease() { return crypto.randomUUID(); }
module.exports = {PLATFORMS, POLICY, settings, validateObservation, lease};
