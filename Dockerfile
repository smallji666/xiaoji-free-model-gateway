# 小鸡免费模型 —— 容器镜像
#
# 零依赖：**没有 npm install**，把源码拷进去就能跑（唯一的运行要求是 Node ≥ 18）。
#
# 构建：  docker build -t xiaoji-free-model .
# 运行：  docker run -d --name xiaoji -p 127.0.0.1:8787:8787 -v xiaoji-data:/app xiaoji-free-model
#
# ⚠ 持久化：所有状态文件（config.json / logs / free_catalog.json …）都是按 server.mjs 所在
#   目录（即 /app）解析的。上面用**具名卷挂到 /app** —— Docker 首次会拿镜像里的 /app 内容
#   初始化这个空卷，之后 config.json 就落在卷里，容器重建不丢冷却状态与各家 Key。
#   不要改成挂宿主机空目录，那样会把镜像里的源码整个盖掉。
#
# ⚠ 端口：容器里必须绑 0.0.0.0（127.0.0.1 只对容器自身可见），这超出了本项目
#   "只给本机用"的默认安全边界。所以上面**只把端口映射到宿主机的 127.0.0.1**。
#   若要暴露到局域网/公网，请先把 config.json 的 auth 改成 token 模式（见 README 第七节）。

FROM node:22-alpine

WORKDIR /app
# WORKDIR 建出来的 /app 归 root，而下面要以 node 身份运行（写 config.json / logs 需要权限）
RUN chown node:node /app

# 只拷运行必需的文件。⚠ 配置与状态文件是**运行时产物，刻意不打进镜像** ——
#   config.json 里是明文 Key，烤进镜像层等于永久留痕（即使后来删掉，层里还在）。
COPY --chown=node:node package.json server.mjs dashboard.html LICENSE ./
COPY --chown=node:node assets ./assets
COPY --chown=node:node free_whitelist.json ./

USER node

# 容器内必须绑 0.0.0.0 才能被宿主机的端口映射访问到（见上方端口说明）。
ENV HOST=0.0.0.0

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
