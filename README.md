# MediaHub

MediaHub 是本地运行的多平台内容管理和分发工作台，提供内容库、账号管理、视频材料导入、审核与任务记录。

本项目处于实验阶段。各平台支持程度以及草稿、私密、公开状态因平台及外部适配器而异；任务创建或本地状态不代表平台投稿成功。请在对应平台核查账号、可见范围和结果，结果不明时不要重复提交。

## 本地启动

需要 Node.js 20 或更高版本。安装依赖后运行 `npm start`，或使用 `npm run desktop` 启动桌面界面。具体端口以启动日志为准。

部分发布与账号登录功能依赖独立安装的外部工具，未包含在本仓库。使用环境变量配置：`MEDIAHUB_SKILL_NODE`、`MEDIAHUB_ARTICLE_SCRIPT`、`MEDIAHUB_ARTICLE_CONFIG`、`MEDIAHUB_VIDEO_SCRIPT`、`MEDIAHUB_VIDEO_CONFIG`、`HERMES_CONFIG_DIR`、`HERMES_NODE`、`SOCIAL_AUTO_UPLOAD_ROOT` 和 `TOUTIAO_OPS`。请仅填写自己信任的工具和配置路径。

`data/`、`uploads/`、账号登录会话和凭据属于私人数据，不应提交到版本库。请勿把服务暴露到公网。浏览器自动化不等于各平台可无人值守发布。

运行 `npm test` 执行本地测试。测试通过不等于真实平台验证通过。
