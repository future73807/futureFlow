# Vendored Python 依赖

「Python 执行」节点在本机 Python 3 中运行用户代码。为了让常见任务开箱可用
（尤其是连接数据库，见 README「关键节点能力」），这里随仓库携带了一组
**纯 Python、无平台二进制**的第三方包；网关在执行用户代码时会把本目录注入
`PYTHONPATH`，因此不需要用户 `pip install`，也不会污染用户的 Python 环境。

## 为什么是这种方案

- 本地试运行执行的是**宿主机**的 Python，不是 Docker 里的 Dify Sandbox。
  把依赖装进 Sandbox 镜像对本链路没有任何作用。
- 纯 Python 包可以跨平台携带（无 `.so` / `.pyd` / `.dll`），Linux 与 Windows 通用。
- 用户代码仍可通过 `PYTHON_EXTRA_MODULES_PATH` 环境变量追加自己的依赖目录。

## 当前内容

| 包 | 版本 | 用途 | 许可证 |
| ---- | ---- | ---- | ------ |
| `pg8000` | 1.31.5 | PostgreSQL 纯 Python 驱动 | BSD-3-Clause |
| `scramp` | 1.4.17 | `pg8000` 的 SCRAM 认证依赖 | BSD-3-Clause |
| `asn1crypto` | 1.5.1 | `scramp` 的 ASN.1 依赖 | MIT |
| `python-dateutil` | 2.9.0.post0 | `pg8000` 的日期类型依赖 | Apache-2.0 / BSD-3-Clause |
| `six` | 1.17.0 | `python-dateutil` 的依赖 | MIT |

各包的许可证文本随 `*.dist-info/` 一并保留。

## 如何更新

```bash
rm -rf gateway/vendor/python
python -m pip install --target gateway/vendor/python "pg8000==<版本>"
find gateway/vendor/python -name __pycache__ -type d -exec rm -rf {} +
```

更新后请确认：

- 没有平台相关二进制：`find gateway/vendor/python -name "*.pyd" -o -name "*.so" -o -name "*.dll"`（应为空）
- 体积仍在 1MB 量级（去掉 `__pycache__` 后）

版本升级会被 `scripts/test-python-runtime.cjs` 之外的
`gateway/test/python-runner-smoke.ts` 间接覆盖（验证运行器本身），
而连库能力由 `scripts/test-local-tools.cjs` 端到端覆盖。
