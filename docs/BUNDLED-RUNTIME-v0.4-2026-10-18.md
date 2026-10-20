# 内置运行环境（v0.4.0，2026-10-18）

> 用户要求「傻瓜版，把环境一起配置好」。

## 1. 做了什么

安装包现在自带：

```
Node.js v24.19.0（node.exe，MIT）
@neteasecloudmusicapienhanced/api 4.41.1（MIT）
@yakult-green-tea/qq-music-api 3.3.2（MIT，Folia 同款后端）
以上两个包的全部生产依赖（369 个包）
```

对方**不需要安装 Node.js / npm / VC++ 运行库**，也不需要跑 npx。

## 2. 打包方式（踩过的坑）

electron-builder 的 `extraResources` 会**丢掉任何名为 node_modules 的目录**（加 filter 也不行），
而 Node 的模块解析必须有这个名字。于是：

- 运行环境在构建时压成 `resources/runtime.zip`（约 61 MB，解开 151 MB）；
- 安装后在 `resources/runtime.zip`；
- **首次使用在线功能时**主进程用 Windows 自带 `tar.exe` 解压到
  `%APPDATA%\twilight-echo-app\runtime`（实测约 5 秒），随后把 `streaming.json`
  写成 `"<userData>/runtime/node.exe" "<...>/app.js"` 的命令；
- 用 `.ready` 标记记录版本，第二次启动 1 ms 跳过解压；版本升级会自动重解。

纪律：**已有 streaming.json 的机器不碰配置、也不解压**（用户自备服务端的命令不被抢走）。

## 3. 代码

```
app/src/main/streaming/bundled-runtime.ts   发现/解压/写首启配置（纯函数 + tar 调用）
app/src/main/index.ts                       app ready 时 prepare → seed，然后 configure
app/electron-builder.yml                    extraResources: resources/runtime.zip
app/resources/runtime.zip                   构建产物（含 node.exe、node_modules、许可声明）
app/tools/bundled-runtime.test.mjs          3 条单测（dev 目录/首启写入/zip 解压+版本标记）
```

## 4. 验证

| 项 | 结果 |
|---|---|
| 单测 | **474 / 474**（含解压与首启配置） |
| e2e | **201 / 201，0 fail** |
| 打包后运行环境 | `runtime.zip` 61 MB，含 node.exe / 两个 app.js / 许可声明 |
| 模拟全新机器 | 从打包 zip 解压 4.9–6.5 秒 → 内置 node 启动 QQ 服务端 → `/login/status` 200；第二次 1 ms |
| 安装包 | 170.4 MB（原 134 MB + 运行时） |

## 5. 边界

- 只支持 Windows 10 1803+（需要系统自带 `tar.exe`；Win11 全部满足）；
- 首次使用在线功能多 5 秒解压；数据目录多约 151 MB；
- 安装包仍未签名（SmartScreen 提示），如需对外正式发布要做代码签名；
- 内置的是**运行环境**，不是音乐内容：网易云/QQ 的接口仍然是非官方的，账号与版权风险由使用者承担；
- QQ 登录设备上限问题不受此改动影响（需用户自行在手机端删旧设备）。