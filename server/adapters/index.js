const simulation = require('./simulation');
const wechat = require('./wechat');
const youtube = require('./youtube');
const xiaohongshuRpa = require('./xiaohongshu-rpa');
const skillPublisher = require('./skill-publisher');
const unsupported = require('./unsupported');

const REGISTRY = { simulation, wechat, youtube, 'xiaohongshu-rpa': xiaohongshuRpa, 'skill-publisher': skillPublisher };

function getAdapter(platform, contentType, operation = 'save_draft') {
  const name = platform?.adapters?.[operation]?.[contentType];
  return name && REGISTRY[name] ? REGISTRY[name] : unsupported;
}

module.exports = { getAdapter, simulation, wechat, youtube, xiaohongshuRpa, skillPublisher, unsupported };
