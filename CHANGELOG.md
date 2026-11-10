# Heybash

## 1.0.1 — 模型回退与推理档位修复

- CodeArts benefit 模型遇到 APIG.0101 时去掉 benefit 头、重新签名并仅重试一次。
- 推理路由链提供 Low / High / Max，按每次实际命中的模型转换档位；不支持 Max 时降为 High。只有开关的模型将 Low 映射为关闭，High / Max 映射为开启。
- 长会话压缩的 CodeArts 请求遇到网络或网关超时，可使用已有同模型路由链回退一次。
- 侧边栏显示 Heybash-Xdpool，账号池深色按钮改用白色文字。

## 1.0.0 — Heybash-xdpool 首个独立版本

- 独立版本从 1.0.0 开始；npm 包名 `heybash-xdpool`，通过 DSH 插件安装入口直接安装。

- 界面、模型分组与命令行展示统一为 Heybash。
- 项目入口指向 Heybash 维护仓库，移除上游 Star 引导。
- 头像与插件图标使用 Heybash Logo。
- 移除交流群按钮、弹层、二维码与推广截图。
- 前端注册名跟随 package.json，保留已有 provider、配置及数据标识兼容。
