#!/bin/bash
set -e

# Based on the Dify 0.15.3 Squid entrypoint. Generate the runtime config from
# environment variables, forward logs to container stdout, and keep Squid in
# the foreground so Compose can supervise it.
if [ ! -f /etc/ssl/private/ssl-cert-snakeoil.key ]; then
    /usr/sbin/make-ssl-cert generate-default-snakeoil --force-overwrite >/dev/null 2>&1
fi

tail -F /var/log/squid/access.log 2>/dev/null &
tail -F /var/log/squid/error.log 2>/dev/null &
tail -F /var/log/squid/store.log 2>/dev/null &
tail -F /var/log/squid/cache.log 2>/dev/null &

awk '{
    while (match($0, /\${[A-Za-z_][A-Za-z_0-9]*}/)) {
        var = substr($0, RSTART + 2, RLENGTH - 3)
        val = ENVIRON[var]
        $0 = substr($0, 1, RSTART - 1) val substr($0, RSTART + RLENGTH)
    }
    print
}' /etc/squid/squid.conf.template >/etc/squid/squid.conf

# 容器重启（restart: unless-stopped，或宿主机重启 / docker restart）会复用容器
# 可写层，上一轮的 /run/squid.pid 会残留下来。Squid 读到「fresh instance PID
# file」后直接 FATAL 退出，容器陷入无限重启；而 dify-api 依赖
# `ssrf_proxy: service_healthy`，整栈因此永远起不来（表现为 pnpm start 一直卡在
# 「等待 SSRF Proxy 健康」）。启动前清掉陈旧 PID 文件即可解除死锁。
rm -f /run/squid.pid

/usr/sbin/squid -Nz
exec /usr/sbin/squid -f /etc/squid/squid.conf -NYC 1
